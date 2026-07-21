import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { resolveApiConsumer, filterModelsForConsumer, checkConsumerModelAccess, getGovernanceSnapshot } from "../src/governance.js";
import { extractProxyRequestControls } from "../src/proxy/body.js";
import { parseJsonWithTimeout } from "../src/proxy/reliability.js";
import { inferBackendRouteKey } from "../src/proxy/routing.js";
import { streamPassthrough, streamShim } from "../src/proxy/stream.js";
import { chatToResponsesRequest, mapChatCompletionJsonToResponses, mapResponsesJsonToChatCompletion } from "../src/proxy/shim.js";
import { REDACTED_SECRET_VALUE, redactConfigSecrets, restoreConfigSecrets } from "../src/admin-config.js";
import { getRequestNetworkContext } from "../src/request-network.js";
import { buildCorrelationHeaders, resolveRequestContext } from "../src/request-context.js";

const STREAM_POLICY = {
  firstByteTimeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxStreamDurationMs: 0
};

class FakeReplyRaw extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super();
    this.backpressure = backpressure;
    this.destroyed = false;
    this.output = "";
    this.writableEnded = false;
  }

  write(value) {
    this.output += String(value);
    if (!this.backpressure) return true;
    this.backpressure = false;
    queueMicrotask(() => this.emit("drain"));
    return false;
  }
}

function createReader(chunks, onCancel = () => {}) {
  let index = 0;
  return {
    async read() {
      return index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true };
    },
    async cancel(reason) {
      onCancel(reason);
    }
  };
}

async function runResponsesToChatShim(chunks, raw = new FakeReplyRaw(), onContent = null) {
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader(chunks) } },
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {},
    onContent
  });
  return { result, raw };
}

function encodeEvents(events) {
  return events.map((event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
}

test("request context normalizes correlation IDs and falls back to request ID", () => {
  const complete = resolveRequestContext({
    id: "generated-id",
    headers: {
      "x-request-id": " request\u0000-id ",
      "x-conversation-id": "conversation-id",
      "x-session-id": "session-id",
      "x-correlation-id": "legacy-id"
    }
  });
  assert.deepEqual(complete, {
    requestId: "request-id",
    conversationId: "conversation-id",
    sessionId: "session-id"
  });
  assert.deepEqual(buildCorrelationHeaders(complete), {
    "x-request-id": "request-id",
    "x-conversation-id": "conversation-id",
    "x-session-id": "session-id"
  });

  assert.deepEqual(resolveRequestContext({
    id: "generated-id",
    headers: { "x-session-id": "session-only" }
  }), {
    requestId: "generated-id",
    conversationId: "session-only",
    sessionId: "session-only"
  });

  assert.deepEqual(resolveRequestContext({
    id: "generated-id",
    headers: { "x-request-id": "   ", "x-correlation-id": "legacy-id" }
  }), {
    requestId: "generated-id",
    conversationId: "legacy-id",
    sessionId: "legacy-id"
  });

  assert.deepEqual(resolveRequestContext({ id: "generated-id", headers: {} }), {
    requestId: "generated-id",
    conversationId: "generated-id",
    sessionId: "generated-id"
  });
});

test("disabled models cannot be called directly", () => {
  const disabledModel = { id: "disabled-model", status: "disabled" };
  const config = {
    access: { defaults: { requireApiKey: true } },
    apiKeys: [{ id: "consumer", key: "secret", status: "active" }],
    models: [disabledModel]
  };
  const consumer = resolveApiConsumer(config, "secret").consumer;

  assert.deepEqual(filterModelsForConsumer(config.models, consumer), []);
  assert.deepEqual(checkConsumerModelAccess(consumer, disabledModel), {
    ok: false,
    status: 404,
    error: "ModelNotFound",
    code: "MODEL_NOT_FOUND",
    message: "model disabled-model not found"
  });
});

test("zero-valued key limits inherit global rate-limit defaults", async () => {
  const config = {
    access: {
      rateLimits: {
        windowSeconds: 60,
        defaultRpm: 60,
        defaultTpm: 0,
        defaultConcurrency: 8
      },
      budgets: {}
    },
    apiKeys: [{
      id: "inherited-limits",
      status: "active",
      rateLimit: { windowSeconds: 0, rpm: 0, tpm: 0, concurrency: 0 }
    }]
  };

  const inherited = (await getGovernanceSnapshot(config)).keys[0].rateLimit;
  assert.deepEqual(inherited, { windowSeconds: 60, rpm: 60, tpm: 0, concurrency: 8 });

  config.apiKeys[0].rateLimit = { windowSeconds: 30, rpm: 10, tpm: 1000, concurrency: 2 };
  const overridden = (await getGovernanceSnapshot(config)).keys[0].rateLimit;
  assert.deepEqual(overridden, { windowSeconds: 30, rpm: 10, tpm: 1000, concurrency: 2 });
});

test("admin config payloads redact and preserve stored secrets", () => {
  const current = {
    auth: { clientSecret: "client-secret", apiKey: "upstream-key" },
    admin: { auth: { password: "admin-secret" } },
    server: { adminAuth: { password: "admin-secret" } },
    apiKeys: [{ id: "first", key: "first-key" }, { id: "second", key: "second-key" }],
    upstreams: [{
      name: "upstream",
      headersTemplate: { Authorization: "Bearer secret", "x-label": "visible" }
    }]
  };

  const redacted = redactConfigSecrets(current);
  assert.equal(JSON.stringify(redacted).includes("client-secret"), false);
  assert.equal(JSON.stringify(redacted).includes("first-key"), false);
  assert.equal(JSON.stringify(redacted).includes("Bearer secret"), false);
  assert.equal(redacted.auth.clientSecret, REDACTED_SECRET_VALUE);

  redacted.apiKeys.reverse();
  const restored = restoreConfigSecrets(redacted, current);
  assert.equal(restored.auth.clientSecret, "client-secret");
  assert.equal(restored.apiKeys[0].id, "second");
  assert.equal(restored.apiKeys[0].key, "second-key");
  assert.equal(restored.upstreams[0].headersTemplate.Authorization, "Bearer secret");
});

test("forwarded client addresses require explicit trust and use the nearest proxy value", () => {
  const request = {
    headers: {
      "x-forwarded-for": "198.51.100.10, 203.0.113.20",
      "x-real-ip": "203.0.113.20"
    },
    ip: "127.0.0.1"
  };

  assert.equal(
    getRequestNetworkContext({ server: { caddy: { enabled: true }, trustProxy: false } }, request).clientIp,
    "127.0.0.1"
  );
  assert.equal(
    getRequestNetworkContext({ server: { trustProxy: true } }, request).clientIp,
    "203.0.113.20"
  );
});

test("per-request proxy controls cannot exceed configured limits", () => {
  const config = {
    proxy: {
      timeouts: {
        allowPerRequestOverride: true,
        requestOverrideFields: [],
        requestOverrideLimits: {
          requestMs: 5000,
          firstByteMs: 3000,
          idleMs: 5000,
          maxStreamDurationMs: 10000,
          maxRetries: 1
        }
      },
      guards: { rejectUnknownProxyParams: true }
    }
  };

  const accepted = extractProxyRequestControls({ model: "m", timeoutMs: 5000, maxRetries: 1 }, config);
  assert.deepEqual(accepted.overrides, { requestMs: 5000, maxRetries: 1 });
  assert.throws(
    () => extractProxyRequestControls({ model: "m", maxRetries: 1000000 }, config),
    (error) => error?.code === "PROXY_CONTROL_FIELD_LIMIT_EXCEEDED"
  );
});

test("path overrides infer protocols when Azure API-version queries are present", () => {
  assert.equal(
    inferBackendRouteKey("chat/completions", {
      type: "path",
      value: "/openai/v1/responses?api-version=2025-04-01-preview"
    }),
    "responses"
  );
  assert.equal(
    inferBackendRouteKey("responses", {
      type: "path",
      value: "/openai/deployments/model/chat/completions?api-version=2025-04-01-preview"
    }),
    "chat/completions"
  );
});

test("Chat and Responses conversion preserves multimodal and structured semantics", () => {
  const converted = chatToResponsesRequest({
    model: "model",
    messages: [
      { role: "system", content: "system instruction" },
      { role: "developer", content: "developer instruction" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }
        ]
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema: { type: "object" },
        strict: true
      }
    }
  }, "deployment");

  assert.equal(converted.instructions, "system instruction\n\ndeveloper instruction");
  assert.deepEqual(converted.input[0].content, [
    { type: "input_text", text: "inspect" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" }
  ]);
  assert.deepEqual(converted.text.format, {
    type: "json_schema",
    name: "answer",
    schema: { type: "object" },
    strict: true
  });

  const gpt56Request = chatToResponsesRequest({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "max"
  }, "gpt-5.6-luna");
  assert.deepEqual(gpt56Request.reasoning, { effort: "max" });
  assert.equal("reasoning_effort" in gpt56Request, false);

  const responsesPayload = mapChatCompletionJsonToResponses({
    id: "chatcmpl-test",
    created: 123,
    model: "model",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "done",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" }
        }]
      }
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }, "model");
  assert.equal(responsesPayload.status, "completed");
  assert.equal(responsesPayload.output[0].content[0].text, "done");
  assert.equal(responsesPayload.output[1].type, "function_call");
  assert.deepEqual(responsesPayload.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });

  const chatPayload = mapResponsesJsonToChatCompletion(responsesPayload, "model");
  assert.equal(chatPayload.choices[0].message.content, "done");
  assert.equal(chatPayload.choices[0].message.tool_calls[0].function.name, "lookup");
  assert.deepEqual(chatPayload.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test("chunked JSON responses are bounded and timed-out bodies are cancelled", async () => {
  const encoder = new TextEncoder();
  const chunked = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("{\"payload\":\""));
      controller.enqueue(encoder.encode("0123456789\"}"));
      controller.close();
    }
  }));

  await assert.rejects(
    parseJsonWithTimeout(chunked, 1000, 12),
    (error) => error?.code === "UPSTREAM_RESPONSE_TOO_LARGE"
  );

  let cancelled = false;
  const stalled = new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel(reason) {
      cancelled = reason === "request-timeout";
    }
  }));
  await assert.rejects(
    parseJsonWithTimeout(stalled, 20, 1024),
    (error) => error?.code === "UPSTREAM_REQUEST_TIMEOUT"
  );
  assert.equal(cancelled, true);
});

test("Responses-to-Chat shim preserves UTF-8 and emits one terminal frame", async () => {
  const bytes = Buffer.from(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "你" })}\n\n`
      + `data: ${JSON.stringify({ type: "response.output_text.done" })}\n\n`
      + `data: ${JSON.stringify({ type: "response.completed" })}\n\n`
  );
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  const raw = new FakeReplyRaw({ backpressure: true });
  const outputParts = [];
  const { result } = await runResponsesToChatShim([
    bytes.subarray(0, split),
    bytes.subarray(split)
  ], raw, (value, kind) => outputParts.push({ value, kind }));

  assert.equal(result.ok, true);
  assert.match(raw.output, /你/);
  assert.doesNotMatch(raw.output, /�/);
  assert.deepEqual(outputParts, [{ value: "你", kind: "text" }]);
  assert.equal((raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("Chat-to-Responses shim emits a complete text and tool lifecycle", async () => {
  const events = [
    { id: "chatcmpl_test", model: "model", choices: [{ delta: { content: "你" }, finish_reason: null }] },
    {
      id: "chatcmpl_test",
      model: "model",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":" }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl_test",
      model: "model",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
        finish_reason: "tool_calls"
      }]
    },
    {
      id: "chatcmpl_test",
      model: "model",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ];
  const chunks = [...encodeEvents(events), Buffer.from("data: [DONE]\n\n")];
  const raw = new FakeReplyRaw({ backpressure: true });
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader(chunks) } },
    reply: { raw },
    modelId: "model",
    routeKey: "responses",
    backendRouteKey: "chat/completions",
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  const frames = raw.output
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => frame.slice(6))
    .filter((data) => data !== "[DONE]")
    .map(JSON.parse);
  const eventTypes = frames.map((frame) => frame.type);
  const completed = frames.at(-1).response;

  assert.equal(result.ok, true);
  assert.equal(eventTypes[0], "response.created");
  assert.equal(eventTypes.at(-1), "response.completed");
  assert.equal(eventTypes.filter((type) => type === "response.completed").length, 1);
  assert.equal(completed.output_text, "你");
  assert.equal(completed.output[1].arguments, "{\"id\":1}");
  assert.deepEqual(completed.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.equal((raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("protocol-shim provider errors are surfaced", async () => {
  const { result, raw } = await runResponsesToChatShim(encodeEvents([
    { type: "error", error: { code: "provider_failed", message: "upstream failed" } }
  ]));

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_PROVIDER_STREAM_ERROR");
  assert.equal(result.providerError?.code, "provider_failed");
  assert.equal(raw.output, "");
});

test("Responses incomplete events finish Chat streams without becoming provider errors", async () => {
  const { result, raw } = await runResponsesToChatShim(encodeEvents([
    {
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
      }
    }
  ]));

  assert.equal(result.ok, true);
  assert.match(raw.output, /"finish_reason":"length"/);
  assert.equal((raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("empty reverse shim streams do not write a synthetic success response", async () => {
  const raw = new FakeReplyRaw();
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader([]) } },
    reply: { raw },
    modelId: "model",
    routeKey: "responses",
    backendRouteKey: "chat/completions",
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.firstChunkSeen, false);
  assert.equal(raw.output, "");
});

test("Responses passthrough preserves successful SSE framing", async () => {
  const source = Buffer.from(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "你" })}\n\n`
      + `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`
  );
  const split = source.indexOf(Buffer.from("你")) + 1;
  const raw = new FakeReplyRaw();
  const writtenChunks = [];
  raw.write = (value) => {
    writtenChunks.push(Buffer.from(value));
    return true;
  };
  const result = await streamPassthrough({
    upstreamResponse: {
      body: { getReader: () => createReader([source.subarray(0, split), source.subarray(split)]) }
    },
    reply: { raw },
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.concat(writtenChunks), source);
});

test("Responses passthrough recognizes top-level provider error events", async () => {
  const raw = new FakeReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: {
      body: {
        getReader: () => createReader(encodeEvents([
          { type: "error", code: "provider_failed", message: "upstream failed", param: null }
        ]))
      }
    },
    reply: { raw },
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_PROVIDER_STREAM_ERROR");
  assert.equal(result.providerErrorForwarded, true);
  assert.equal(result.providerError?.code, "provider_failed");
  assert.match(raw.output, /"type":"error"/);
});

test("client disconnect cancels the upstream stream", async () => {
  let releaseRead;
  let cancelReason = "";
  const reader = {
    read() {
      return new Promise((resolve) => {
        releaseRead = resolve;
      });
    },
    async cancel(reason) {
      cancelReason = reason;
      releaseRead?.({ done: true });
    }
  };
  const raw = new FakeReplyRaw();
  const streamPromise = streamPassthrough({
    upstreamResponse: { body: { getReader: () => reader } },
    reply: { raw },
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  queueMicrotask(() => raw.emit("close"));
  const result = await streamPromise;

  assert.equal(result.clientDisconnected, true);
  assert.equal(result.error?.code, "CLIENT_DISCONNECTED");
  assert.equal(cancelReason, "client-disconnected");
});

test("client disconnect stops parsing a chunk released by reader cancellation", async () => {
  let releaseRead;
  let readCount = 0;
  let contentCallbacks = 0;
  const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "must not be parsed" })}\n\n`);
  const reader = {
    read() {
      readCount += 1;
      if (readCount > 1) return Promise.resolve({ done: true });
      return new Promise((resolve) => { releaseRead = resolve; });
    },
    async cancel() {
      releaseRead?.({ done: false, value: chunk });
    }
  };
  const raw = new FakeReplyRaw();
  const streamPromise = streamPassthrough({
    upstreamResponse: { body: { getReader: () => reader } },
    reply: { raw },
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {},
    onContent() { contentCallbacks += 1; }
  });

  queueMicrotask(() => raw.emit("close"));
  const result = await streamPromise;

  assert.equal(result.clientDisconnected, true);
  assert.equal(contentCallbacks, 0);
  assert.equal(raw.output, "");
});
