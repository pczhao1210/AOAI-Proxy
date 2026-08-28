import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isBlobFallbackError, writePersistedConfigText } from "../src/persistence.js";
import { hardenBootstrapConfig, hardenBootstrapConfigFile } from "../src/bootstrap-config.js";
import { applyConfigEnvironmentOverrides, validateConfig } from "../src/config.js";
import { getProviderPayloadError, parseJsonWithTimeout } from "../src/proxy/reliability.js";
import { inferBackendRouteKey, reconcileBackendRouteKey, resolveModelCompatibilityRoute } from "../src/proxy/routing.js";
import { chatToResponsesRequest, normalizeResponsesToolDescriptions, sanitizeChatToolTranscript } from "../src/proxy/shim.js";
import { streamPassthrough, streamShim, writeSseError } from "../src/proxy/stream.js";

const policy = {
  firstByteTimeoutMs: 1000,
  idleTimeoutMs: 1000
};

function createReplyRaw({ backpressure = false } = {}) {
  const raw = new EventEmitter();
  raw.chunks = [];
  raw.destroyed = false;
  raw.writableEnded = false;
  raw.write = (chunk) => {
    raw.chunks.push(Buffer.from(chunk));
    if (backpressure && raw.chunks.length === 1) {
      queueMicrotask(() => raw.emit("drain"));
      return false;
    }
    return true;
  };
  raw.output = () => Buffer.concat(raw.chunks).toString("utf8");
  return raw;
}

function createChunkedResponse(chunks, { onCancel, keepOpen = false } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!keepOpen) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    }
  }), {
    headers: { "content-type": "text/event-stream" }
  });
}

function createPendingResponse({ onCancel }) {
  return new Response(new ReadableStream({
    pull() {},
    cancel(reason) {
      onCancel?.(reason);
    }
  }));
}

async function testShimPreservesUtf8AndWritesOneTerminalFrame() {
  const encoder = new TextEncoder();
  const eventText = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "你" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_text.done", text: "你" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: null } })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");
  const encoded = encoder.encode(eventText);
  const splitAt = encoded.indexOf(0xe4) + 1;
  const response = createChunkedResponse([
    encoded.slice(0, splitAt),
    encoded.slice(splitAt)
  ]);
  const raw = createReplyRaw();

  const result = await streamShim({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, true);
  assert.match(raw.output(), /你/);
  assert.doesNotMatch(raw.output(), /�/);
  assert.equal(raw.output().match(/data: \[DONE\]/g)?.length, 1);
}

async function testShimSurfacesProviderError() {
  const response = createChunkedResponse([
    new TextEncoder().encode(`data: ${JSON.stringify({
      type: "error",
      error: { code: "content_filter", message: "blocked by provider" }
    })}\n\n`)
  ]);
  const raw = createReplyRaw();

  const result = await streamShim({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_PROVIDER_STREAM_ERROR");
  assert.match(result.error?.message || "", /blocked by provider/);
}

async function testShimMapsIncompleteToLengthOnce() {
  const response = createChunkedResponse([
    new TextEncoder().encode([
      `data: ${JSON.stringify({ type: "response.incomplete", response: { usage: null } })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""))
  ]);
  const raw = createReplyRaw();
  const result = await streamShim({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, true);
  assert.match(raw.output(), /"finish_reason":"length"/);
  assert.equal(raw.output().match(/data: \[DONE\]/g)?.length, 1);
}

async function testPassthroughDetectsProviderError() {
  const response = createChunkedResponse([
    new TextEncoder().encode(`data: ${JSON.stringify({
      type: "response.failed",
      response: { error: { code: "provider_failure", message: "provider failed" } }
    })}\n\n`)
  ]);
  const raw = createReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_PROVIDER_STREAM_ERROR");
  assert.equal(result.providerErrorForwarded, true);
  assert.match(raw.output(), /provider failed/);
}

async function testShimPropagatesDownstreamWriteError() {
  const response = createChunkedResponse([
    new TextEncoder().encode(`data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "hello"
    })}\n\n`)
  ]);
  const raw = createReplyRaw();
  raw.write = () => {
    queueMicrotask(() => raw.emit("error", new Error("downstream write failed")));
    return false;
  };
  const result = await streamShim({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message || "", /downstream write failed/);
}

async function testSseErrorWriteToleratesDestroyedClient() {
  const raw = createReplyRaw();
  raw.destroyed = true;
  const written = await writeSseError(raw, { code: "test-error" });
  assert.equal(written, false);
  assert.equal(raw.chunks.length, 0);
}

async function testDisconnectCancelsUpstreamReader() {
  let cancelReason = "";
  const response = createPendingResponse({
    onCancel(reason) {
      cancelReason = reason;
    }
  });
  const raw = createReplyRaw();
  const resultPromise = streamPassthrough({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    policy,
    onFirstChunk() {}
  });

  raw.emit("close");
  const result = await resultPromise;

  assert.equal(cancelReason, "client-disconnected");
  assert.equal(result.error?.code, "CLIENT_DISCONNECTED");
}

async function testPassthroughHonorsBackpressure() {
  const response = createChunkedResponse([
    new TextEncoder().encode("data: first\n\n"),
    new TextEncoder().encode("data: second\n\n")
  ]);
  const raw = createReplyRaw({ backpressure: true });

  const result = await streamPassthrough({
    upstreamResponse: response,
    reply: { raw },
    modelId: "test-model",
    policy,
    onFirstChunk() {}
  });

  assert.equal(result.ok, true);
  assert.equal(raw.output(), "data: first\n\ndata: second\n\n");
}

async function testPassthroughRejectsPrematureEof() {
  const response = createChunkedResponse([
    new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`)
  ]);
  const result = await streamPassthrough({
    upstreamResponse: response,
    reply: { raw: createReplyRaw() },
    modelId: "test-model",
    backendRouteKey: "responses",
    policy,
    onFirstChunk() {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
}

async function testPassthroughAcceptsChatFinishReasonAtEof() {
  const response = createChunkedResponse([
    new TextEncoder().encode(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }]
    })}`)
  ]);
  const result = await streamPassthrough({
    upstreamResponse: response,
    reply: { raw: createReplyRaw() },
    modelId: "test-model",
    backendRouteKey: "chat/completions",
    policy,
    onFirstChunk() {}
  });
  assert.equal(result.ok, true);
}

async function testShimRejectsPrematureEofAndAcceptsCompletedResponse() {
  const partialResult = await streamShim({
    upstreamResponse: createChunkedResponse([
      new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`)
    ]),
    reply: { raw: createReplyRaw() },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });
  assert.equal(partialResult.ok, false);
  assert.equal(partialResult.error?.code, "UPSTREAM_INCOMPLETE_STREAM");

  const raw = createReplyRaw();
  const completedResult = await streamShim({
    upstreamResponse: createChunkedResponse([
      new TextEncoder().encode([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "complete" })}\n\n`,
        `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", status: "completed" } })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: { usage: null } })}`
      ].join(""))
    ]),
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });
  assert.equal(completedResult.ok, true);
  assert.match(raw.output(), /data: \[DONE\]/);

  const reasoningRaw = createReplyRaw();
  const reasoningResult = await streamShim({
    upstreamResponse: createChunkedResponse([
      new TextEncoder().encode(`data: ${JSON.stringify({
        type: "response.output_item.done",
        item: { id: "rs-test", type: "reasoning", summary: [] }
      })}`)
    ]),
    reply: { raw: reasoningRaw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: { id: "test-model" },
    policy,
    onFirstChunk() {}
  });
  assert.equal(reasoningResult.ok, false);
  assert.equal(reasoningResult.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  assert.doesNotMatch(reasoningRaw.output(), /data: \[DONE\]/);
}

async function testJsonTimeoutCancelsBody() {
  let cancelReason = "";
  const response = createPendingResponse({
    onCancel(reason) {
      cancelReason = reason;
    }
  });

  await assert.rejects(
    parseJsonWithTimeout(response, 10),
    (error) => error?.code === "UPSTREAM_REQUEST_TIMEOUT"
  );
  assert.equal(cancelReason, "request-timeout");
  assert.equal(response.body.locked, false);
}

async function testJsonResponseLimitCancelsBody() {
  let cancelReason = "";
  const response = createChunkedResponse([
    new TextEncoder().encode(JSON.stringify({ value: "too large" }))
  ], {
    onCancel(reason) {
      cancelReason = reason;
    },
    keepOpen: true
  });

  await assert.rejects(
    parseJsonWithTimeout(response, 1000, 8),
    (error) => error?.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );
  assert.equal(cancelReason, "response-too-large");
}

function testBackendRouteInferenceHandlesQueriesAndFinalUrls() {
  assert.equal(inferBackendRouteKey("chat/completions", {
    type: "path",
    value: "/openai/v1/responses?api-version=preview"
  }), "responses");
  assert.equal(
    reconcileBackendRouteKey("responses", "https://example.openai.azure.com/openai/v1/chat/completions?api-version=preview"),
    "chat/completions"
  );
  assert.equal(
    reconcileBackendRouteKey("responses", "https://gateway.example.test/custom/inference"),
    "responses"
  );
}

function testGpt56CompatibilityRoutingIsScopedAndOverridable() {
  const upstream = { routes: { "chat/completions": "/chat/completions", responses: "/responses" } };
  for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    assert.deepEqual(
      resolveModelCompatibilityRoute({ id: modelId }, upstream, "chat/completions"),
      { type: "routeKey", value: "responses" }
    );
  }
  assert.equal(resolveModelCompatibilityRoute({ id: "gpt-5.4-mini" }, upstream, "chat/completions"), null);
  assert.equal(resolveModelCompatibilityRoute({ id: "gpt-5.6-luna" }, { routes: {} }, "chat/completions"), null);
  assert.equal(resolveModelCompatibilityRoute({ id: "gpt-5.6-luna" }, upstream, "responses"), null);
}

function testResponsesRequestNormalizationPreservesModernControls() {
  const request = chatToResponsesRequest({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "max",
    tools: [{ type: "function", function: { name: "lookup", description: "", parameters: { type: "object" } } }]
  }, "gpt-5.6-luna");
  normalizeResponsesToolDescriptions(request);
  assert.deepEqual(request.reasoning, { effort: "max" });
  assert.equal(request.tools[0].description, "lookup");

  const nativeRequest = {
    tools: [{ type: "namespace", tools: [{ type: "custom", name: "shell" }] }],
    input: [{ type: "additional_tools", tools: [{ type: "function", name: "search", description: " " }] }]
  };
  normalizeResponsesToolDescriptions(nativeRequest);
  assert.equal(nativeRequest.tools[0].tools[0].description, "shell");
  assert.equal(nativeRequest.input[0].tools[0].description, "search");
}

function testMalformedToolTranscriptIsSanitizedByCompleteTurn() {
  const completeTurn = [
    { role: "user", content: "lookup" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "done" },
    { role: "assistant", content: "finished" }
  ];
  const unchanged = sanitizeChatToolTranscript(completeTurn);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.messages, completeTurn);

  const malformed = sanitizeChatToolTranscript([
    { role: "tool", tool_call_id: "orphan", content: "orphan" },
    { role: "user", content: "lookup" },
    { role: "assistant", content: null, tool_calls: [
      { id: "call_1", type: "function", function: { name: "one", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "two", arguments: "{}" } }
    ] },
    { role: "tool", tool_call_id: "call_1", content: "partial" },
    { role: "user", content: "continue" }
  ]);
  assert.equal(malformed.changed, true);
  assert.deepEqual(malformed.messages, [
    { role: "user", content: "lookup" },
    { role: "user", content: "continue" }
  ]);
  assert.equal(malformed.droppedToolMessages, 2);
  assert.equal(malformed.droppedAssistantTurns, 1);
}

function testProviderFailurePayloadIsNotTreatedAsSuccess() {
  assert.deepEqual(getProviderPayloadError({
    status: "failed",
    error: {
      message: "model failed",
      code: "model_failed",
      type: "invalid_request_error",
      param: "input"
    }
  }), {
    message: "model failed",
    code: "model_failed",
    type: "invalid_request_error",
    param: "input"
  });
  assert.equal(getProviderPayloadError({ status: "completed", error: null, output: [] }), null);
  assert.equal(getProviderPayloadError({ choices: [{ message: { content: "ok" } }] }), null);
}

async function testBlobFallbackClassification() {
  for (const error of [
    { statusCode: 403 },
    { statusCode: 429 },
    { statusCode: 503 },
    { code: "ENOTFOUND" },
    { name: "CredentialUnavailableError" }
  ]) {
    assert.equal(isBlobFallbackError(error), true, JSON.stringify(error));
  }
  assert.equal(isBlobFallbackError(new Error("CONFIG_BLOB_CONTAINER is required")), false);
}

async function testLocalConfigWriteIsAtomic() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-proxy-persistence-"));
  const configPath = path.join(tempDir, "config.json");
  const previousConfigPath = process.env.CONFIG_PATH;
  const previousMode = process.env.PERSISTENCE_MODE;
  process.env.CONFIG_PATH = configPath;
  process.env.PERSISTENCE_MODE = "file";
  try {
    await writePersistedConfigText('{"ok":true}');
    assert.equal(await fs.readFile(configPath, "utf8"), '{"ok":true}');
    const files = await fs.readdir(tempDir);
    assert.deepEqual(files, ["config.json"]);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
  } finally {
    if (previousConfigPath == null) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
    if (previousMode == null) delete process.env.PERSISTENCE_MODE;
    else process.env.PERSISTENCE_MODE = previousMode;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createSecurityConfig() {
  return {
    server: {
      host: "0.0.0.0",
      port: 3000,
      adminPath: "/admin",
      adminAuth: { enabled: false, username: "admin", password: "admin" },
      caddy: { enabled: false }
    },
    auth: { mode: "apiKey", apiKey: "valid-upstream-key" },
    apiKeys: [{ id: "default", key: "CHANGEME", status: "active" }],
    upstreams: [{ name: "test", baseUrl: "https://example.com" }],
    models: [{ id: "test", upstream: "test" }]
  };
}

async function testBootstrapRotatesSharedCredentials() {
  const { config, credentials } = hardenBootstrapConfig(createSecurityConfig(), {});
  assert.equal(config.server.adminAuth.enabled, true);
  assert.notEqual(config.server.adminAuth.password, "admin");
  assert.equal(config.server.adminAuth.password, credentials.adminPassword);
  const activeKeys = config.apiKeys.filter((item) => item.status !== "disabled");
  assert.equal(activeKeys.length, 1);
  assert.notEqual(activeKeys[0].key, "CHANGEME");
  assert.equal(activeKeys[0].key, credentials.proxyApiKey);
  validateConfig(config);
}

async function testBootstrapHonorsCredentialEnvironment() {
  const { config, credentials } = hardenBootstrapConfig(createSecurityConfig(), {
    AOAI_PROXY_ADMIN_USERNAME: "operator",
    AOAI_PROXY_ADMIN_PASSWORD: "environment-admin-secret",
    AOAI_PROXY_API_KEY: "environment-proxy-key"
  });
  assert.equal(config.server.adminAuth.enabled, true);
  assert.equal(config.server.adminAuth.username, "operator");
  assert.equal(config.server.adminAuth.password, "environment-admin-secret");
  assert.equal(config.apiKeys.find((item) => item.id === "default")?.key, "environment-proxy-key");
  assert.deepEqual(credentials, {});
  validateConfig(config);
}

async function testBootstrapFilesArePrivate() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-proxy-bootstrap-"));
  const configPath = path.join(tempDir, "config.json");
  const credentialsPath = path.join(tempDir, "bootstrap-credentials.json");
  await fs.writeFile(configPath, JSON.stringify(createSecurityConfig()), "utf8");
  try {
    await hardenBootstrapConfigFile(configPath, credentialsPath, {});
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
    assert.equal(config.server.adminAuth.password, credentials.adminPassword);
    assert.equal(config.apiKeys.find((item) => item.id === "default")?.key, credentials.proxyApiKey);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(credentialsPath)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function testPublicAdminRequiresAuthentication() {
  assert.throws(
    () => validateConfig(createSecurityConfig()),
    /adminAuth must be enabled/
  );

  const config = createSecurityConfig();
  const previousAdminPassword = process.env.AOAI_PROXY_ADMIN_PASSWORD;
  const previousProxyApiKey = process.env.AOAI_PROXY_API_KEY;
  process.env.AOAI_PROXY_ADMIN_PASSWORD = "environment-admin-secret";
  process.env.AOAI_PROXY_API_KEY = "environment-proxy-key";
  try {
    applyConfigEnvironmentOverrides(config);
    validateConfig(config);
  } finally {
    if (previousAdminPassword == null) delete process.env.AOAI_PROXY_ADMIN_PASSWORD;
    else process.env.AOAI_PROXY_ADMIN_PASSWORD = previousAdminPassword;
    if (previousProxyApiKey == null) delete process.env.AOAI_PROXY_API_KEY;
    else process.env.AOAI_PROXY_API_KEY = previousProxyApiKey;
  }
}

const tests = [
  testShimPreservesUtf8AndWritesOneTerminalFrame,
  testShimSurfacesProviderError,
  testShimMapsIncompleteToLengthOnce,
  testPassthroughDetectsProviderError,
  testShimPropagatesDownstreamWriteError,
  testSseErrorWriteToleratesDestroyedClient,
  testDisconnectCancelsUpstreamReader,
  testPassthroughHonorsBackpressure,
  testPassthroughRejectsPrematureEof,
  testPassthroughAcceptsChatFinishReasonAtEof,
  testShimRejectsPrematureEofAndAcceptsCompletedResponse,
  testJsonTimeoutCancelsBody,
  testJsonResponseLimitCancelsBody,
  testBackendRouteInferenceHandlesQueriesAndFinalUrls,
  testGpt56CompatibilityRoutingIsScopedAndOverridable,
  testResponsesRequestNormalizationPreservesModernControls,
  testMalformedToolTranscriptIsSanitizedByCompleteTurn,
  testProviderFailurePayloadIsNotTreatedAsSuccess,
  testBlobFallbackClassification,
  testLocalConfigWriteIsAtomic,
  testBootstrapRotatesSharedCredentials,
  testBootstrapHonorsCredentialEnvironment,
  testBootstrapFilesArePrivate,
  testPublicAdminRequiresAuthentication
];

for (const test of tests) {
  await test();
  console.log(`ok - ${test.name}`);
}