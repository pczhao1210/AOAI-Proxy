import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { resolveApiConsumer, filterModelsForConsumer, checkConsumerModelAccess, getGovernanceSnapshot } from "../src/governance.js";
import { extractProxyRequestControls, sanitizeIncomingHeaders } from "../src/proxy/body.js";
import { classifyFetchError, fetchOnceWithConnectTimeout, fetchWithRetry, parseJsonWithTimeout } from "../src/proxy/reliability.js";
import { buildMessagesCountTokensUrl, buildResponsesCompactUrl, buildUpstreamUrl, inferBackendRouteKey, resolveEffectiveRouteKey } from "../src/proxy/routing.js";
import { streamPassthrough, streamShim } from "../src/proxy/stream.js";
import {
  chatToMessagesRequest,
  chatToResponsesRequest,
  getProtocolShimCompatibilityIssue,
  getProtocolShimStreamCompatibilityIssue,
  mapChatCompletionJsonToMessages,
  mapChatCompletionJsonToResponses,
  mapMessagesJsonToChatCompletion,
  mapMessagesJsonToResponses,
  mapResponsesJsonToChatCompletion,
  mapResponsesJsonToMessages,
  messagesToChatRequest,
  messagesToResponsesRequest,
  responsesToChatRequest,
  responsesToMessagesRequest
} from "../src/proxy/shim.js";
import { REDACTED_SECRET_VALUE, redactConfigSecrets, restoreConfigSecrets } from "../src/admin-config.js";
import { getRequestNetworkContext } from "../src/request-network.js";
import { buildCorrelationHeaders, resolveRequestContext } from "../src/request-context.js";
import { getStats, recordUsage } from "../src/stats.js";
import { findPricingDefinitionForModel } from "../src/pricing-library.js";
import { buildModelFromPricingTemplate, getSuggestedModelRouteValues } from "../admin-ui/src/utils.js";

function getPricingDefinition(definitionId) {
  return findPricingDefinitionForModel({ pricingRef: definitionId });
}

const STREAM_POLICY = {
  firstByteTimeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxStreamDurationMs: 0
};

test("Claude compatibility prefixes cannot forward credential-like headers", () => {
  const headers = sanitizeIncomingHeaders({
    "anthropic-api-key": "secret-1",
    "x-anthropic-api-key": "secret-2",
    "x-claude-authorization": "Bearer secret-3",
    "x-stainless-access-token": "secret-4",
    "x-stainless-client-secret": "secret-5",
    "x-anthropic-key": "secret-6",
    "x-claude-oauth-token": "secret-7",
    "x-stainless-password": "secret-8",
    "x-claude-code-session-id": "session_123",
    "x-stainless-package-version": "1.2.3"
  }, {
    proxy: {
      forwardHeaders: {
        mode: "allowlist",
        allow: []
      }
    }
  }, {
    allowPrefixes: ["anthropic-", "x-anthropic-", "x-claude-", "x-stainless-"]
  });

  assert.deepEqual(headers, {
    "x-claude-code-session-id": "session_123",
    "x-stainless-package-version": "1.2.3"
  });
});

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

async function runProtocolShim(routeKey, backendRouteKey, chunks, options = {}) {
  const raw = new FakeReplyRaw();
  const observed = { usages: [], models: [], content: [] };
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader(chunks) } },
    reply: { raw },
    modelId: "test-model",
    routeKey,
    backendRouteKey,
    ...options,
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage(usage) { observed.usages.push(usage); },
    onModel(model) { observed.models.push(model); },
    onContent(value, kind) { observed.content.push([value, kind]); }
  });
  return { result, raw, observed };
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
  const differentlyCasedModel = { id: "disabled-model-uppercase", status: "DISABLED" };
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
  assert.deepEqual(filterModelsForConsumer([differentlyCasedModel], consumer), []);
  assert.equal(checkConsumerModelAccess(consumer, differentlyCasedModel).code, "MODEL_NOT_FOUND");
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
      auth: { mode: "apiKey", apiKey: "per-upstream-key" },
      headersTemplate: { Authorization: "Bearer secret", "x-label": "visible" }
    }]
  };

  const redacted = redactConfigSecrets(current);
  assert.equal(JSON.stringify(redacted).includes("client-secret"), false);
  assert.equal(JSON.stringify(redacted).includes("first-key"), false);
  assert.equal(JSON.stringify(redacted).includes("per-upstream-key"), false);
  assert.equal(JSON.stringify(redacted).includes("Bearer secret"), false);
  assert.equal(redacted.auth.clientSecret, REDACTED_SECRET_VALUE);
  assert.equal(redacted.upstreams[0].auth.apiKey, REDACTED_SECRET_VALUE);

  redacted.apiKeys.reverse();
  const restored = restoreConfigSecrets(redacted, current);
  assert.equal(restored.auth.clientSecret, "client-secret");
  assert.equal(restored.apiKeys[0].id, "second");
  assert.equal(restored.apiKeys[0].key, "second-key");
  assert.equal(restored.upstreams[0].auth.apiKey, "per-upstream-key");
  assert.equal(restored.upstreams[0].headersTemplate.Authorization, "Bearer secret");
});

test("admin config secret restoration never reuses a matched upstream secret", () => {
  const current = {
    upstreams: [
      { name: "first", auth: { mode: "apiKey", apiKey: "first-secret" } },
      { name: "second", auth: { mode: "apiKey", apiKey: "second-secret" } }
    ]
  };
  const candidate = redactConfigSecrets(current);
  candidate.upstreams.reverse();
  candidate.upstreams[1].name = "renamed-first";

  const restored = restoreConfigSecrets(candidate, current);
  assert.equal(restored.upstreams[0].auth.apiKey, "second-secret");
  assert.equal(restored.upstreams[1].auth.apiKey, "");
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

test("fetch failures classify undici cause codes", () => {
  assert.deepEqual(
    classifyFetchError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" })
    })),
    {
      code: "UPSTREAM_CONNECT_TIMEOUT",
      retryable: true,
      status: 504,
      detail: "fetch failed: connect timed out"
    }
  );
  assert.deepEqual(
    classifyFetchError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })
    })),
    {
      code: "UPSTREAM_NETWORK_ERROR",
      retryable: true,
      status: 502,
      detail: "fetch failed: connection refused"
    }
  );
  assert.deepEqual(
    classifyFetchError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("certificate rejected"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })
    })),
    {
      code: "UPSTREAM_TLS_ERROR",
      retryable: false,
      status: 502,
      detail: "fetch failed: certificate rejected"
    }
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

test("Anthropic Messages routes use the Foundry services host", () => {
  assert.equal(
    buildUpstreamUrl({
      baseUrl: "https://example.openai.azure.com/",
      routes: { messages: "/anthropic/v1/messages" }
    }, "messages", "claude-sonnet-4-6"),
    "https://example.services.ai.azure.com/anthropic/v1/messages"
  );
});

test("Claude models select model-specific native protocols without overriding explicit routes", () => {
  const upstream = { baseUrl: "https://example.openai.azure.com/", routes: {} };
  const sonnet46 = { id: "claude-sonnet-4-6", targetModel: "claude-sonnet-4-6", pricingRef: "claude-sonnet-4-6" };
  const opus48 = { id: "claude-opus-4-8", targetModel: "claude-opus-4-8", pricingRef: "claude-opus-4-8", hostingMode: "azure" };

  assert.equal(resolveEffectiveRouteKey("responses", sonnet46, upstream), "messages");
  assert.equal(resolveEffectiveRouteKey("responses", opus48, upstream), "messages");
  assert.equal(resolveEffectiveRouteKey("responses", { ...opus48, hostingMode: "anthropic" }, upstream), "messages");
  assert.equal(resolveEffectiveRouteKey("responses", sonnet46, upstream, { type: "routeKey", value: "responses" }), "responses");
  assert.equal(
    buildUpstreamUrl(upstream, "messages", "claude-sonnet-4-6", sonnet46),
    "https://example.services.ai.azure.com/anthropic/v1/messages"
  );
});

test("dual-protocol GPT models preserve the requested native protocol", () => {
  const upstream = { baseUrl: "https://example.openai.azure.com/", routes: {} };
  const model = { id: "gpt-5.6-luna", targetModel: "gpt-5.6-luna", pricingRef: "gpt-5.6-luna" };

  assert.equal(resolveEffectiveRouteKey("chat/completions", model, upstream), "chat/completions");
  assert.equal(resolveEffectiveRouteKey("responses", model, upstream), "responses");
});

test("pricing protocol metadata distinguishes GPT, Claude, DeepSeek, and Grok interfaces", () => {
  for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    const definition = getPricingDefinition(modelId);
    assert.deepEqual(definition?.interfaces, ["chat/completions", "responses"]);
    assert.deepEqual(definition?.proxyTemplate?.routes, { "chat/completions": "responses" });
    assert.deepEqual(
      buildModelFromPricingTemplate(definition, "foundry", { models: [] }).routes,
      { "chat/completions": "responses" }
    );
  }

  const modelRouter = getPricingDefinition("model-router");
  assert.deepEqual(modelRouter?.interfaces, ["chat/completions", "responses"]);
  assert.equal(modelRouter?.protocolProfiles?.responses?.reasoning?.parameter, "reasoning.effort");
  assert.deepEqual(modelRouter?.proxyTemplate?.routes, { messages: "chat/completions" });
  assert.deepEqual(
    buildModelFromPricingTemplate(modelRouter, "foundry", { models: [] }).routes,
    { messages: "chat/completions" }
  );

  for (const modelId of ["claude-opus-4-8", "claude-opus-5"]) {
    const definition = getPricingDefinition(modelId);
    assert.deepEqual(definition?.interfaces, ["messages"]);
    assert.deepEqual(definition?.interfacesByHostingMode?.azure, ["messages"]);
    assert.deepEqual(definition?.interfacesByHostingMode?.anthropic, ["messages"]);
  }

  for (const modelId of ["DeepSeek-V4-Pro", "DeepSeek-V4-Flash"]) {
    const definition = getPricingDefinition(modelId);
    assert.deepEqual(definition?.interfaces, ["chat/completions"]);
  }

  const grok43 = getPricingDefinition("grok-4.3");
  assert.deepEqual(grok43?.interfaces, ["chat/completions", "responses"]);
  assert.equal(grok43?.pricingCatalogEntry, null);
  assert.equal(grok43?.pricing?.tiers?.[1]?.promptTokensAtLeast, 200000);
  assert.equal(grok43?.pricing?.tiers?.[1]?.inputPer1mTokens, 2.5);

  const grok46 = getPricingDefinition("grok-4.6");
  assert.deepEqual(grok46?.interfaces, ["chat/completions", "responses"]);
  assert.deepEqual(grok46?.inputModalities, ["text", "image"]);
  assert.equal(grok46?.pricingCatalogEntry, null);
  assert.equal(grok46?.pricing?.tiers?.[1]?.promptTokensAtLeast, 200000);
  assert.equal(grok46?.pricing?.tiers?.[1]?.inputPer1mTokens, 4);
});

test("admin model route options come from the hosting-resolved Catalog definition", () => {
  const definition = {
    interfaces: ["realtime"],
    defaultHostingMode: "azure",
    interfacesByHostingMode: {
      azure: ["audio/transcriptions"],
      provider: ["realtime"]
    },
    proxyTemplate: {
      routes: { "*": "azure-audio" }
    }
  };

  assert.deepEqual(
    getSuggestedModelRouteValues(definition, "azure"),
    ["audio/transcriptions", "azure-audio"]
  );
  assert.deepEqual(
    getSuggestedModelRouteValues(definition, "provider"),
    ["realtime", "azure-audio"]
  );
});

test("Anthropic token count routes are explicit or safely derived from Messages", () => {
  assert.equal(
    buildMessagesCountTokensUrl(
      { baseUrl: "https://example.services.ai.azure.com/", routes: {} },
      "https://example.services.ai.azure.com/anthropic/v1/messages?api-version=preview",
      "claude-sonnet"
    ),
    "https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens?api-version=preview"
  );
  assert.equal(
    buildMessagesCountTokensUrl({
      baseUrl: "https://api.anthropic.com/",
      routes: {
        "messages/count_tokens": "/v1/messages/count_tokens?deployment={deployment}"
      }
    }, "https://api.anthropic.com/v1/messages", "team model"),
    "https://api.anthropic.com/v1/messages/count_tokens?deployment=team%20model"
  );
  assert.throws(
    () => buildMessagesCountTokensUrl({
      baseUrl: "https://api.anthropic.com/",
      routes: { "messages/count_tokens": "/v1/tokenize" }
    }, "https://api.anthropic.com/v1/messages", "claude-sonnet"),
    /must end with \/messages\/count_tokens/
  );
  assert.throws(
    () => buildMessagesCountTokensUrl(
      { baseUrl: "https://example.test/", routes: {} },
      "https://example.test/v1/responses",
      "claude-sonnet"
    ),
    /must end with \/messages/
  );
});

test("Responses compact routes are explicit or safely derived from Responses", () => {
  assert.equal(
    buildResponsesCompactUrl(
      { baseUrl: "https://example.openai.azure.com/", routes: {} },
      "https://example.openai.azure.com/openai/v1/responses?api-version=preview",
      "gpt-codex"
    ),
    "https://example.openai.azure.com/openai/v1/responses/compact?api-version=preview"
  );
  assert.equal(
    buildResponsesCompactUrl({
      baseUrl: "https://api.openai.com/",
      routes: {
        "responses/compact": "/v1/responses/compact?deployment={deployment}"
      }
    }, "https://api.openai.com/v1/responses", "team model"),
    "https://api.openai.com/v1/responses/compact?deployment=team%20model"
  );
  assert.throws(
    () => buildResponsesCompactUrl({
      baseUrl: "https://api.openai.com/",
      routes: { "responses/compact": "/v1/compact" }
    }, "https://api.openai.com/v1/responses", "gpt-codex"),
    /must end with \/responses\/compact/
  );
  assert.throws(
    () => buildResponsesCompactUrl(
      { baseUrl: "https://example.test/", routes: {} },
      "https://example.test/v1/chat/completions",
      "gpt-codex"
    ),
    /must end with \/responses/
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
  assert.deepEqual(gpt56Request.reasoning, { effort: "max", summary: "auto" });
  assert.equal("reasoning_effort" in gpt56Request, false);

  const claudeRequest = responsesToMessagesRequest({
    model: "claude-sonnet-4-6",
    input: "hello",
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium" }
  }, "claude-sonnet-4-6");
  assert.deepEqual(claudeRequest.output_config, { effort: "medium" });
  assert.deepEqual(claudeRequest.thinking, { type: "adaptive" });
  assert.equal("reasoning" in claudeRequest, false);
  assert.equal("include" in claudeRequest, false);

  const continuedClaudeRequest = responsesToMessagesRequest({
    model: "claude-sonnet-4-6",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "checked the inputs" }],
        encrypted_content: "opaque-signature"
      },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" }
    ],
    reasoning: { effort: "high" }
  }, "claude-sonnet-4-6");
  assert.deepEqual(continuedClaudeRequest.messages[0].content[0], {
    type: "thinking",
    thinking: "checked the inputs",
    signature: "opaque-signature"
  });
  assert.equal(continuedClaudeRequest.messages[0].content[1].type, "tool_use");

  const legacyFunctionChoice = chatToResponsesRequest({
    model: "model",
    messages: [{ role: "user", content: "do not call tools" }],
    functions: [{ name: "lookup", parameters: { type: "object" } }],
    function_call: "none"
  }, "deployment");
  assert.equal(legacyFunctionChoice.tool_choice, "none");
  assert.equal("function_call" in legacyFunctionChoice, false);

  const canonicalServiceTier = chatToResponsesRequest({
    model: "model",
    messages: [{ role: "user", content: "use priority" }],
    serviceTier: "priority",
    verbosity: "high"
  }, "deployment");
  assert.equal(canonicalServiceTier.service_tier, "priority");
  assert.equal(canonicalServiceTier.verbosity, "high");
  assert.equal("serviceTier" in canonicalServiceTier, false);

  const reverseCanonicalServiceTier = responsesToChatRequest({
    model: "model",
    input: "use priority",
    serviceTier: "priority",
    verbosity: "high"
  }, "deployment");
  assert.equal(reverseCanonicalServiceTier.service_tier, "priority");
  assert.equal(reverseCanonicalServiceTier.verbosity, "high");
  assert.equal("serviceTier" in reverseCanonicalServiceTier, false);

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

  const missingTotalChat = mapResponsesJsonToChatCompletion({
    output: [],
    usage: { input_tokens: 8, output_tokens: 3 }
  }, "model");
  assert.equal(missingTotalChat.usage.total_tokens, 11);
  const malformedOutputChat = mapResponsesJsonToChatCompletion({ output: {} }, "model");
  assert.equal(malformedOutputChat.choices[0].message.content, "");

  const missingTotalResponses = mapChatCompletionJsonToResponses({
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 2 }
  }, "model");
  assert.equal(missingTotalResponses.usage.total_tokens, 9);

  const parallelChat = responsesToChatRequest({
    input: [
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"a\"}" },
      { type: "function_call", call_id: "call_2", name: "write", arguments: "{\"path\":\"b\"}" },
      { type: "function_call_output", call_id: "call_1", output: "A" },
      { type: "function_call_output", call_id: "call_2", output: "B" }
    ]
  }, "chat-model");
  assert.equal(parallelChat.messages.length, 3);
  assert.equal(parallelChat.messages[0].role, "assistant");
  assert.deepEqual(parallelChat.messages[0].tool_calls.map((call) => call.id), ["call_1", "call_2"]);
  assert.deepEqual(parallelChat.messages.slice(1).map((message) => message.tool_call_id), ["call_1", "call_2"]);
});

test("protocol shim compatibility rejects structured semantics it cannot preserve", () => {
  const cases = [
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { input: [{ type: "custom_tool_call", call_id: "call_1", name: "shell", input: "pwd" }] },
      path: "input[0]",
      type: "custom_tool_call"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "messages",
      payload: { input: [{ type: "mcp_call", server_label: "repo", name: "read" }] },
      path: "input[0]",
      type: "mcp_call"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "done" }] },
      path: "input[0]",
      type: "custom_tool_call_output"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { input: [{ type: "computer_call_output", call_id: "computer_1", output: { type: "computer_screenshot", file_id: "file_1" } }] },
      path: "input[0]",
      type: "computer_call_output"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "messages",
      payload: { input: [{ type: "local_shell_call", call_id: "shell_1", action: { type: "exec", command: ["pwd"] } }] },
      path: "input[0]",
      type: "local_shell_call"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { input: [{ type: "shell_call_output", call_id: "shell_1", output: [{ stdout: "/tmp", stderr: "", outcome: { type: "exit", exit_code: 0 } }] }] },
      path: "input[0]",
      type: "shell_call_output"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { previous_response_id: "resp_1", input: "continue" },
      path: "previous_response_id",
      type: "previous_response_id"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { max_tool_calls: 0, input: "do not call tools" },
      path: "max_tool_calls",
      type: "max_tool_calls"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "messages",
      payload: { verbosity: "high", input: "hello" },
      path: "verbosity",
      type: "verbosity"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "messages",
      payload: { service_tier: "priority", input: "hello" },
      path: "service_tier",
      type: "service_tier"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] },
      path: "input[0].content[0]",
      type: "input_file"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "responses",
      payload: { messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }] }] },
      path: "messages[0].content[0]",
      type: "document"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      payload: { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "sig" }] }] },
      path: "messages[0].content[0]",
      type: "thinking"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "responses",
      payload: { messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file_1" } }] }] },
      path: "messages[0].content[0].source",
      type: "file"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      payload: { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "failed", is_error: true }] }] },
      path: "messages[0].content[0].is_error",
      type: "is_error"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      payload: { metadata: { user_id: "user_1" }, messages: [{ role: "user", content: "hello" }] },
      path: "metadata",
      type: "metadata"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { messages: [{ role: "assistant", content: "", tool_calls: [{ type: "custom", id: "call_1", name: "shell", input: "pwd" }] }] },
      path: "messages[0].tool_calls[0]",
      type: "custom"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { n: 2, messages: [{ role: "user", content: "two answers" }] },
      path: "n",
      type: "n"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { modalities: ["text", "audio"], messages: [{ role: "user", content: "speak" }] },
      path: "modalities",
      type: "modalities"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { prediction: { type: "content", content: "expected" }, messages: [{ role: "user", content: "continue" }] },
      path: "prediction",
      type: "prediction"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { frequency_penalty: 0.5, messages: [{ role: "user", content: "hello" }] },
      path: "frequency_penalty",
      type: "frequency_penalty"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { stop: ["END"], messages: [{ role: "user", content: "hello" }] },
      path: "stop",
      type: "stop"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { top_p: 0.5, messages: [{ role: "user", content: "hello" }] },
      path: "top_p",
      type: "top_p"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { stream_options: { include_usage: true, unknown: true }, messages: [{ role: "user", content: "hello" }] },
      path: "stream_options.unknown",
      type: "unknown"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "messages",
      payload: { parallel_tool_calls: false, messages: [{ role: "user", content: "hello" }] },
      path: "parallel_tool_calls",
      type: "parallel_tool_calls"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "messages",
      payload: { service_tier: "priority", messages: [{ role: "user", content: "hello" }] },
      path: "service_tier",
      type: "service_tier"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { messages: [{ role: "assistant", content: null, function_call: { name: "lookup", arguments: "{}" } }] },
      path: "messages[0].function_call",
      type: "function_call"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "messages",
      payload: { messages: [{ role: "function", name: "lookup", content: "done" }] },
      path: "messages[0].role",
      type: "function"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { messages: [{ role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "done" }] }] },
      path: "messages[0].content",
      type: "content_array"
    },
    {
      phase: "response",
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { output: [{ type: "web_search_call", id: "ws_1", status: "completed" }] },
      path: "output[0]",
      type: "web_search_call"
    },
    {
      phase: "response",
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }] },
      path: "output[0]",
      type: "compaction"
    },
    {
      phase: "response",
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: {
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "cited",
            annotations: [{ type: "url_citation", url: "https://example.test", start_index: 0, end_index: 5 }]
          }]
        }]
      },
      path: "output[0].content[0]",
      type: "output_text"
    },
    {
      phase: "response",
      sourceProtocol: "messages",
      targetProtocol: "responses",
      payload: { stop_reason: "end_turn", content: [{ type: "redacted_thinking" }] },
      path: "content[0]",
      type: "redacted_thinking"
    },
    {
      phase: "response",
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      payload: { stop_reason: "end_turn", content: [{ type: "text", text: "cited", citations: [{ type: "char_location", start_char_index: 0, end_char_index: 5 }] }] },
      path: "content[0]",
      type: "text"
    },
    {
      phase: "response",
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      payload: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] },
      path: "incomplete_details.reason",
      type: "content_filter"
    },
    {
      phase: "response",
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      payload: { stop_reason: "pause_turn", content: [] },
      path: "stop_reason",
      type: "pause_turn"
    },
    {
      phase: "response",
      sourceProtocol: "chat/completions",
      targetProtocol: "messages",
      payload: { choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "blocked" } }] },
      path: "choices[0].finish_reason",
      type: "content_filter"
    },
    {
      phase: "response",
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: {
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "one" } },
          { index: 1, finish_reason: "stop", message: { role: "assistant", content: "two" } }
        ]
      },
      path: "choices",
      type: "multiple_choices"
    },
    {
      phase: "response",
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      payload: { choices: [{ message: { role: "assistant", content: "missing terminal reason" } }] },
      path: "choices[0].finish_reason",
      type: "unknown"
    },
    {
      phase: "response",
      sourceProtocol: "messages",
      targetProtocol: "responses",
      payload: { content: [{ type: "text", text: "missing terminal reason" }] },
      path: "stop_reason",
      type: "unknown"
    }
  ];

  for (const item of cases) {
    const issue = getProtocolShimCompatibilityIssue(item.payload, {
      phase: item.phase || "request",
      sourceProtocol: item.sourceProtocol,
      targetProtocol: item.targetProtocol
    });
    assert.equal(issue?.path, item.path);
    assert.equal(issue?.type, item.type);
    assert.match(issue?.message || "", /Cannot losslessly convert/);
  }

  assert.equal(getProtocolShimCompatibilityIssue({
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" }
    ],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }]
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  }), null);
  assert.equal(getProtocolShimCompatibilityIssue({
    include: [],
    context_management: {},
    reasoning: { effort: "medium", summary: null },
    input: "hello"
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  }), null);
  assert.equal(getProtocolShimCompatibilityIssue({
    n: 1,
    frequency_penalty: 0,
    modalities: ["text"],
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hello" }]
  }, {
    sourceProtocol: "chat/completions",
    targetProtocol: "responses"
  }), null);
  assert.equal(getProtocolShimCompatibilityIssue({
    serviceTier: "priority",
    messages: [{ role: "user", content: "hello" }]
  }, {
    sourceProtocol: "chat/completions",
    targetProtocol: "responses"
  }), null);
  const compatibleMessagesControls = {
    stop: ["END"],
    top_k: 20,
    top_p: 0.5,
    messages: [{ role: "user", content: "hello" }]
  };
  assert.equal(getProtocolShimCompatibilityIssue(compatibleMessagesControls, {
    sourceProtocol: "chat/completions",
    targetProtocol: "messages"
  }), null);
  const convertedMessagesControls = chatToMessagesRequest(compatibleMessagesControls, "claude-deployment");
  assert.deepEqual(convertedMessagesControls.stop_sequences, ["END"]);
  assert.equal(convertedMessagesControls.top_k, 20);
  assert.equal(convertedMessagesControls.top_p, 0.5);
  assert.equal(getProtocolShimCompatibilityIssue({
    stop_reason: "end_turn",
    content: [{ type: "redacted_thinking", data: "opaque" }]
  }, {
    phase: "response",
    sourceProtocol: "messages",
    targetProtocol: "responses"
  }), null);
});

test("Responses-to-Chat requires rejection for unrepresentable tool state and malformed function history", () => {
  const cases = [
    {
      payload: {
        input: "find a deferred tool",
        tools: [{ type: "tool_search", execution: "client" }]
      },
      path: "tools[0]",
      type: "tool_search"
    },
    {
      payload: {
        input: "find a deferred tool",
        tool_choice: { type: "tool_search" }
      },
      path: "tool_choice",
      type: "tool_search"
    },
    {
      payload: {
        input: [{ type: "tool_search_call", call_id: "search-1", arguments: "{}" }]
      },
      path: "input[0]",
      type: "tool_search_call"
    },
    {
      payload: {
        input: [{ type: "tool_search_output", call_id: "search-1", tools: [] }]
      },
      path: "input[0]",
      type: "tool_search_output"
    },
    {
      payload: {
        previous_response_id: "resp-previous",
        input: [{ type: "tool_search_output", call_id: "search-1", tools: [] }]
      },
      path: "input[0]",
      type: "tool_search_output"
    },
    {
      payload: {
        input: [{
          type: "additional_tools",
          role: "developer",
          tools: [{
            type: "function",
            name: "deferred_lookup",
            parameters: { type: "object", properties: {} }
          }]
        }]
      },
      path: "input[0]",
      type: "additional_tools"
    },
    {
      payload: {
        previous_response_id: "resp-previous",
        input: [
          { type: "message", role: "user", content: "continue" },
          {
            type: "additional_tools",
            role: "developer",
            tools: [{
              type: "function",
              name: "deferred_lookup",
              parameters: { type: "object", properties: {} }
            }]
          }
        ]
      },
      path: "input[1]",
      type: "additional_tools"
    },
    {
      payload: {
        input: [{ type: "function_call_output", call_id: "orphan", output: "done" }]
      },
      path: "input[0].call_id",
      type: "function_call_output"
    },
    {
      payload: {
        include: ["web_search_call.action.sources"],
        input: [{ type: "function_call_output", call_id: "orphan", output: "done" }]
      },
      path: "input[0].call_id",
      type: "function_call_output"
    },
    {
      payload: {
        input: [
          { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call-2", output: "done" }
        ]
      },
      path: "input[1].call_id",
      type: "function_call_output"
    },
    {
      payload: {
        input: [
          { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
          { type: "function_call_output", call_id: "call-1", output: "first" },
          { type: "function_call_output", call_id: "call-1", output: "duplicate" }
        ]
      },
      path: "input[2].call_id",
      type: "function_call_output"
    },
    {
      payload: {
        input: [{ type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" }]
      },
      path: "input[0].call_id",
      type: "function_call"
    },
    {
      payload: {
        input: [
          { type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}" },
          { type: "message", role: "user", content: "interleaved" },
          { type: "function_call_output", call_id: "call-1", output: "late" }
        ]
      },
      path: "input[0].call_id",
      type: "function_call"
    }
  ];

  for (const item of cases) {
    const issue = getProtocolShimCompatibilityIssue(item.payload, {
      phase: "request",
      sourceProtocol: "responses",
      targetProtocol: "chat/completions"
    });
    assert.equal(issue?.path, item.path);
    assert.equal(issue?.type, item.type);
    assert.equal(issue?.requiredRejection, true);
  }

  assert.equal(getProtocolShimCompatibilityIssue({
    input: [
      { type: "message", role: "user", content: "run both" },
      { type: "function_call", call_id: "call-1", name: "tool_search", arguments: "{}" },
      { type: "function_call", call_id: "call-2", name: "write", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "found" },
      { type: "function_call_output", call_id: "call-2", output: "written" },
      { type: "message", role: "user", content: "continue" }
    ],
    tools: [{
      type: "function",
      name: "tool_search",
      description: "An ordinary function",
      parameters: { type: "object", properties: {} }
    }]
  }, {
    phase: "request",
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  }), null);

  const responseIssue = getProtocolShimCompatibilityIssue({
    status: "incomplete",
    incomplete_details: { reason: "content_filter" },
    output: [{ type: "tool_search_call", call_id: "search-1", arguments: "{}" }]
  }, {
    phase: "response",
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  });
  assert.equal(responseIssue?.type, "tool_search_call");
  assert.equal(responseIssue?.requiredRejection, true);

  const additionalToolsResponseIssue = getProtocolShimCompatibilityIssue({
    output: [{ type: "additional_tools", role: "developer", tools: [] }]
  }, {
    phase: "response",
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  });
  assert.equal(additionalToolsResponseIssue?.path, "output[0]");
  assert.equal(additionalToolsResponseIssue?.type, "additional_tools");
  assert.equal(additionalToolsResponseIssue?.requiredRejection, true);

  const streamIssue = getProtocolShimStreamCompatibilityIssue({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "tool_search_call", call_id: "search-1", arguments: "{}" }
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  });
  assert.equal(streamIssue?.type, "tool_search_call");
  assert.equal(streamIssue?.requiredRejection, true);

  const additionalToolsStreamIssue = getProtocolShimStreamCompatibilityIssue({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "additional_tools", role: "developer", tools: [] }
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  });
  assert.equal(additionalToolsStreamIssue?.path, "output[0]");
  assert.equal(additionalToolsStreamIssue?.type, "additional_tools");
  assert.equal(additionalToolsStreamIssue?.requiredRejection, true);
});

test("protocol shim stream compatibility rejects unsupported event semantics", () => {
  const cases = [
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      event: {
        type: "response.output_item.added",
        item: { type: "computer_call", id: "computer_1", status: "in_progress" }
      },
      type: "computer_call"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "responses",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} }
      },
      type: "server_tool_use"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "chat/completions",
      event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      type: "signature_delta"
    },
    {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions",
      event: {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }
      },
      type: "content_filter"
    },
    {
      sourceProtocol: "messages",
      targetProtocol: "responses",
      event: { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } },
      type: "model_context_window_exceeded"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "messages",
      event: { choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] },
      type: "content_filter"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      event: { choices: [{ index: 0, delta: { function_call: { name: "lookup", arguments: "{}" } }, finish_reason: null }] },
      type: "function_call"
    },
    {
      sourceProtocol: "chat/completions",
      targetProtocol: "responses",
      event: {
        choices: [
          { index: 0, delta: { content: "one" }, finish_reason: null },
          { index: 1, delta: { content: "two" }, finish_reason: null }
        ]
      },
      type: "multiple_choices"
    }
  ];

  for (const item of cases) {
    const issue = getProtocolShimStreamCompatibilityIssue(item.event, item);
    assert.equal(issue?.type, item.type);
    assert.match(issue?.message || "", /Cannot losslessly convert/);
  }

  assert.equal(getProtocolShimStreamCompatibilityIssue({
    type: "response.reasoning_summary_text.delta",
    delta: "summary"
  }, {
    sourceProtocol: "responses",
    targetProtocol: "messages"
  }), null);
  assert.equal(getProtocolShimStreamCompatibilityIssue({
    choices: [{ index: 0, delta: { reasoning_content: "visible reasoning" }, finish_reason: null }]
  }, {
    sourceProtocol: "chat/completions",
    targetProtocol: "responses"
  }), null);

  const malformedReasoningIssue = getProtocolShimStreamCompatibilityIssue({
    choices: [{ index: 0, delta: { reasoning_content: { text: "invalid" } }, finish_reason: null }]
  }, {
    sourceProtocol: "chat/completions",
    targetProtocol: "responses"
  });
  assert.equal(malformedReasoningIssue?.path, "choices[0].delta.reasoning_content");

  const reasoningHistoryIssue = getProtocolShimCompatibilityIssue({
    messages: [{ role: "assistant", content: "answer", reasoning_content: "visible reasoning" }]
  }, {
    phase: "request",
    sourceProtocol: "chat/completions",
    targetProtocol: "responses"
  });
  assert.equal(reasoningHistoryIssue?.path, "messages[0].reasoning_content");

  for (const eventType of ["response.created", "response.in_progress"]) {
    assert.equal(getProtocolShimStreamCompatibilityIssue({
      type: eventType,
      response: { status: "in_progress", output: [] }
    }, {
      sourceProtocol: "responses",
      targetProtocol: "chat/completions"
    }), null);
  }
  assert.equal(getProtocolShimStreamCompatibilityIssue({
    type: "response.completed",
    response: { status: "in_progress", output: [] }
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  })?.type, "in_progress");

  assert.equal(getProtocolShimStreamCompatibilityIssue({
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "" }
  }, {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  }), null);
});

test("Messages cross-protocol requests preserve text, images, and tool history", () => {
  const messagesRequest = {
    model: "claude",
    system: [{ type: "text", text: "system instruction" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
        ]
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { id: 1 } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }]
      }
    ],
    tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup" },
    max_tokens: 256,
    stop_sequences: ["STOP"]
  };

  const chat = messagesToChatRequest(messagesRequest, "chat-deployment");
  assert.equal(chat.model, "chat-deployment");
  assert.deepEqual(chat.messages[0], { role: "system", content: "system instruction" });
  assert.deepEqual(chat.messages[1].content, [
    { type: "text", text: "inspect" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
  ]);
  assert.equal(chat.messages[2].tool_calls[0].function.arguments, "{\"id\":1}");
  assert.deepEqual(chat.messages[3], { role: "tool", tool_call_id: "toolu_1", content: "found" });
  assert.equal(chat.tools[0].function.name, "lookup");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "lookup" } });
  assert.deepEqual(chat.stop, ["STOP"]);

  const orderedChat = messagesToChatRequest({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_ordered", name: "lookup", input: {} }]
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ordered", content: "result first" },
          { type: "text", text: "then continue" }
        ]
      }
    ]
  }, "chat-deployment");
  assert.deepEqual(orderedChat.messages.map((message) => message.role), ["assistant", "tool", "user"]);
  assert.equal(orderedChat.messages[1].content, "result first");
  assert.equal(orderedChat.messages[2].content, "then continue");

  const responses = messagesToResponsesRequest(messagesRequest, "responses-deployment");
  assert.equal(responses.model, "responses-deployment");
  assert.equal(responses.instructions, "system instruction");
  assert.deepEqual(responses.input.map((item) => item.type), [
    "message",
    "message",
    "function_call",
    "function_call_output"
  ]);
  assert.equal(responses.input.find((item) => item.type === "function_call")?.name, "lookup");
  assert.equal(responses.input.find((item) => item.type === "function_call_output")?.output, "found");
  assert.equal(responses.tools[0].name, "lookup");
  assert.equal(responses.reasoning, undefined);

  const reasoningResponses = messagesToResponsesRequest({
    model: "claude",
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checked", signature: "signed-state" },
        { type: "redacted_thinking", data: "redacted-state" }
      ]
    }],
    output_config: { effort: "high" },
    stop_sequences: ["STOP"],
    top_k: 12,
    metadata: { user_id: "user-1" },
    tool_choice: { type: "auto", disable_parallel_tool_use: true }
  }, "responses-deployment");
  assert.deepEqual(reasoningResponses.input, [
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "checked" }],
      encrypted_content: "signed-state"
    },
    {
      type: "reasoning",
      summary: [],
      encrypted_content: "redacted-state"
    }
  ]);
  assert.deepEqual(reasoningResponses.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(reasoningResponses.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(reasoningResponses.stop, ["STOP"]);
  assert.equal(reasoningResponses.top_k, 12);
  assert.deepEqual(reasoningResponses.metadata, { user_id: "user-1" });
  assert.equal(reasoningResponses.tool_choice, "auto");
  assert.equal(reasoningResponses.parallel_tool_calls, false);
  assert.equal("output_config" in reasoningResponses, false);
  assert.equal("stop_sequences" in reasoningResponses, false);

  const thinkingResponses = messagesToResponsesRequest({
    model: "reasoning-model",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 1024 }
  }, "responses-deployment");
  assert.deepEqual(thinkingResponses.reasoning, { summary: "auto" });

  const thinkingChat = messagesToChatRequest({
    model: "reasoning-model",
    messages: [{ role: "user", content: "hello" }],
    thinking: { type: "enabled", budget_tokens: 1024 }
  }, "chat-deployment", {
    protocolProfiles: {
      "chat/completions": {
        reasoning: { parameter: "reasoning_effort", default: "high" }
      }
    }
  });
  assert.equal(thinkingChat.reasoning_effort, "high");
  assert.equal("thinking" in thinkingChat, false);

  assert.equal(getProtocolShimCompatibilityIssue({
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "checked", signature: "signed-state" }]
    }],
    output_config: { effort: "high" },
    top_k: 12,
    metadata: { user_id: "user-1" },
    tool_choice: { type: "auto", disable_parallel_tool_use: true }
  }, {
    phase: "request",
    sourceProtocol: "messages",
    targetProtocol: "responses"
  }), null);

  const roundTripMessages = responsesToMessagesRequest(responses, "messages-deployment");
  assert.equal(roundTripMessages.model, "messages-deployment");
  assert.equal(roundTripMessages.system, "system instruction");
  assert.equal(roundTripMessages.messages.flatMap((message) => message.content).find((block) => block.type === "tool_use")?.name, "lookup");
  assert.equal(roundTripMessages.messages.flatMap((message) => message.content).find((block) => block.type === "tool_result")?.content, "found");

  const chatToMessages = chatToMessagesRequest(chat, "messages-deployment");
  assert.equal(chatToMessages.system, "system instruction");
  assert.equal(chatToMessages.max_tokens, 256);
  assert.deepEqual(chatToMessages.stop_sequences, ["STOP"]);

  const toolOnly = chatToResponsesRequest({
    messages: [{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" }
      }]
    }]
  }, "responses-deployment");
  assert.deepEqual(toolOnly.input.map((item) => item.type), ["function_call"]);
});

test("Messages cross-protocol JSON responses preserve tools, stop reasons, and usage", () => {
  const messagesPayload = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [
      { type: "text", text: "done" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { id: 1 } }
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }
  };

  const chat = mapMessagesJsonToChatCompletion(messagesPayload, "fallback");
  assert.equal(chat.choices[0].message.content, "done");
  assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, "{\"id\":1}");
  assert.equal(chat.choices[0].finish_reason, "tool_calls");
  assert.equal(chat.usage.prompt_tokens, 12);
  assert.equal(chat.usage.total_tokens, 17);
  assert.equal(chat.usage.prompt_tokens_details.cached_tokens, 2);

  const responses = mapMessagesJsonToResponses(messagesPayload, "fallback");
  assert.equal(responses.output[0].content[0].text, "done");
  assert.equal(responses.output[1].type, "function_call");
  assert.deepEqual(responses.usage, {
    input_tokens: 12,
    output_tokens: 5,
    total_tokens: 17,
    input_tokens_details: { cached_tokens: 2 }
  });

  const reasoningResponse = mapMessagesJsonToResponses({
    ...messagesPayload,
    content: [
      { type: "thinking", thinking: "checked", signature: "opaque-signature" },
      { type: "text", text: "done" }
    ]
  }, "fallback", { includeEncryptedContent: true });
  assert.deepEqual(reasoningResponse.output[0], {
    id: "rs_msg_1_0",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "checked" }],
    encrypted_content: "opaque-signature"
  });

  const chatPayload = {
    id: "chatcmpl_1",
    model: "chat-model",
    choices: [{
      finish_reason: "length",
      message: {
        role: "assistant",
        reasoning_content: "checked the probability",
        content: "partial",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" }
        }]
      }
    }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
  };
  const mappedMessages = mapChatCompletionJsonToMessages(chatPayload, "fallback");
  assert.equal(mappedMessages.stop_reason, "max_tokens");
  assert.deepEqual(mappedMessages.content[0], {
    type: "thinking",
    thinking: "checked the probability"
  });
  assert.equal(mappedMessages.content[2].type, "tool_use");
  assert.deepEqual(mappedMessages.usage, { input_tokens: 7, output_tokens: 3 });

  const responsesPayload = mapChatCompletionJsonToResponses(chatPayload, "fallback");
  assert.deepEqual(responsesPayload.output[0], {
    id: "rs_chatcmpl_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "checked the probability" }]
  });
  const responsesAsMessages = mapResponsesJsonToMessages(responsesPayload, "fallback");
  assert.equal(responsesAsMessages.stop_reason, "max_tokens");
  assert.equal(responsesAsMessages.content[2].name, "lookup");

  const reasoningPayload = {
    id: "resp_reasoning",
    model: "responses-model",
    status: "completed",
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checked" }],
        encrypted_content: "opaque-signature"
      },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done", annotations: [], logprobs: [] }]
      }
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      input_tokens_details: { cached_tokens: 3 }
    }
  };
  const reasoningAsMessages = mapResponsesJsonToMessages(reasoningPayload, "fallback");
  assert.deepEqual(reasoningAsMessages.content, [
    { type: "thinking", thinking: "checked", signature: "opaque-signature" },
    { type: "text", text: "done" }
  ]);
  assert.deepEqual(reasoningAsMessages.usage, {
    input_tokens: 9,
    output_tokens: 4,
    cache_read_input_tokens: 3
  });
  const reasoningAsChat = mapResponsesJsonToChatCompletion(reasoningPayload, "fallback");
  assert.equal(reasoningAsChat.choices[0].message.reasoning_content, "checked");
  assert.equal(mapResponsesJsonToChatCompletion({
    ...reasoningPayload,
    output_text: ""
  }, "fallback").choices[0].message.content, "done");
  assert.deepEqual(mapResponsesJsonToMessages({
    id: "resp_output_text_only",
    model: "responses-model",
    status: "completed",
    output: [],
    output_text: "top-level fallback"
  }, "fallback").content, [
    { type: "text", text: "top-level fallback" }
  ]);
  const summaryOnlyPayload = {
    ...reasoningPayload,
    output: [{
      id: "rs_summary_only",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "visible summary" }]
    }]
  };
  assert.equal(getProtocolShimCompatibilityIssue(summaryOnlyPayload, {
    phase: "response",
    sourceProtocol: "responses",
    targetProtocol: "messages"
  }), null);
  assert.deepEqual(mapResponsesJsonToMessages(summaryOnlyPayload, "fallback").content, [
    { type: "thinking", thinking: "visible summary" }
  ]);
  assert.equal(getProtocolShimCompatibilityIssue({
    status: "completed",
    output: [{
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "checked" }],
      encrypted_content: "opaque-signature"
    }]
  }, {
    phase: "response",
    sourceProtocol: "responses",
    targetProtocol: "messages"
  }), null);
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

test("client cancellation aborts upstream header and body waits", async () => {
  let requestSeen;
  const seenPromise = new Promise((resolve) => { requestSeen = resolve; });
  const server = http.createServer((request) => {
    requestSeen();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const headerController = new AbortController();
  const headerPromise = fetchOnceWithConnectTimeout({
    targetUrl: `http://127.0.0.1:${address.port}/hang`,
    headers: { "content-type": "application/json" },
    bodyText: "{}",
    timeoutMs: 10000,
    signal: headerController.signal
  });
  await seenPromise;
  headerController.abort("client-disconnected");
  await assert.rejects(headerPromise, (error) => error?.code === "CLIENT_DISCONNECTED");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  let bodyCancelled = false;
  const stalled = new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
    cancel(reason) {
      bodyCancelled = reason === "client-disconnected";
    }
  }));
  const bodyController = new AbortController();
  const bodyPromise = parseJsonWithTimeout(stalled, 10000, 1024, bodyController.signal);
  bodyController.abort("client-disconnected");
  await assert.rejects(bodyPromise, (error) => error?.code === "CLIENT_DISCONNECTED");
  assert.equal(bodyCancelled, true);
});

test("client cancellation aborts a stalled retryable HTTP error body", async () => {
  let requestSeen;
  const seenPromise = new Promise((resolve) => { requestSeen = resolve; });
  const server = http.createServer((request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.write("partial error");
    requestSeen();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const controller = new AbortController();
  const resultPromise = fetchWithRetry({
    targetUrl: `http://127.0.0.1:${address.port}/error`,
    headers: { "content-type": "application/json" },
    bodyText: "{}",
    policy: {
      connectTimeoutMs: 1000,
      firstByteTimeoutMs: 1000,
      requestTimeoutMs: 10000,
      maxRetries: 1,
      retryBaseMs: 1,
      retryMaxMs: 1,
      retryStatuses: new Set([503]),
      classifyNetworkErrorsAsRetryable: true
    },
    logMeta: {},
    log: { warn() {} },
    signal: controller.signal
  });
  await seenPromise;
  controller.abort("client-disconnected");
  const raced = await Promise.race([
    resultPromise,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 100))
  ]);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  assert.notEqual(raced, "timeout");
  assert.equal(raced.classified?.code, "CLIENT_DISCONNECTED");
  assert.equal(raced.attempt, 1);
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

test("protocol shim ignores events after the source terminal marker", async () => {
  const source = Buffer.from(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`
      + `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`
      + `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "must-not-appear" })}\n\n`
      + `data: ${JSON.stringify({ type: "error", error: { message: "must-not-fail" } })}\n\n`
  );
  const converted = await runProtocolShim("chat/completions", "responses", [source]);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"content":"ok"/);
  assert.doesNotMatch(converted.raw.output, /must-not-appear/);
  assert.doesNotMatch(converted.raw.output, /must-not-fail/);
  assert.equal((converted.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("Responses-to-Chat waits for stable tool identity", async () => {
  const source = encodeEvents([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "", name: "", arguments: "" }
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"id\":1}" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_real",
        name: "lookup",
        arguments: "{\"id\":1}"
      }
    },
    { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } }
  ]);
  const converted = await runProtocolShim("chat/completions", "responses", source);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"id":"call_real"/);
  assert.match(converted.raw.output, /"name":"lookup"/);
  assert.match(converted.raw.output, /"arguments":"\{\\"id\\":1\}"/);
  assert.doesNotMatch(converted.raw.output, /"id":"fc_1"/);
});

test("Responses-to-Chat emits a Chat usage chunk when requested", async () => {
  const source = encodeEvents([
    { type: "response.output_text.delta", delta: "hello" },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens_details: { reasoning_tokens: 2 }
        }
      }
    }
  ]);
  const converted = await runProtocolShim("chat/completions", "responses", source, {
    includeChatStreamUsage: true
  });
  const frames = converted.raw.output
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice(6)));
  const usageFrame = frames.find((frame) => Array.isArray(frame.choices) && frame.choices.length === 0);

  assert.equal(converted.result.ok, true);
  assert.deepEqual(usageFrame?.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 }
  });
  assert.equal((converted.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("protocol shim aggregates multi-line SSE data fields", async () => {
  const source = Buffer.from(
    'event: response.output_text.delta\r\n'
      + 'data: {"type":"response.output_text.delta",\r\n'
      + 'data: "delta":"hello"}\r\n\r\n'
      + 'event: response.completed\r\n'
      + 'data: {"type":"response.completed",\r\n'
      + 'data: "response":{"usage":{"input_tokens":2,"output_tokens":1}}}'
  );
  const converted = await runProtocolShim("chat/completions", "responses", [source]);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"content":"hello"/);
  assert.match(converted.raw.output, /"finish_reason":"stop"/);
  assert.equal((converted.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
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

test("Chat reasoning stream converts to a Responses reasoning item", async () => {
  const source = encodeEvents([
    {
      id: "chatcmpl_reasoning",
      model: "model",
      choices: [{ delta: { reasoning_content: "checked" }, finish_reason: null }]
    },
    {
      id: "chatcmpl_reasoning",
      model: "model",
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }]
    }
  ]).concat(Buffer.from("data: [DONE]\n\n"));
  const converted = await runProtocolShim("responses", "chat/completions", source);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"type":"response.reasoning_summary_text.delta"/);
  assert.match(converted.raw.output, /"delta":"checked"/);
  const completed = converted.raw.output
    .split("\n\n")
    .map((frame) => frame.startsWith("data: ") && frame.slice(6) !== "[DONE]" ? JSON.parse(frame.slice(6)) : null)
    .find((event) => event?.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["reasoning", "message"]);
  assert.equal(completed.response.output[0].summary[0].text, "checked");
  assert.equal(completed.response.output[1].content[0].text, "done");
});

test("Messages stream converts to Chat and Responses lifecycles", async () => {
  const source = encodeEvents([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} }
    },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"id\":1}" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: " after" } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ]);

  const chat = await runProtocolShim("chat/completions", "messages", source);
  assert.equal(chat.result.ok, true);
  assert.match(chat.raw.output, /"content":"hello"/);
  assert.match(chat.raw.output, /"name":"lookup"/);
  assert.match(chat.raw.output, /"arguments":"\{\\"id\\":1\}"/);
  assert.match(chat.raw.output, /"finish_reason":"tool_calls"/);
  assert.equal((chat.raw.output.match(/data: \[DONE\]/g) || []).length, 1);

  const responses = await runProtocolShim("responses", "messages", source);
  assert.equal(responses.result.ok, true);
  assert.match(responses.raw.output, /"type":"response.output_text.delta"/);
  assert.match(responses.raw.output, /"type":"response.function_call_arguments.delta"/);
  assert.match(responses.raw.output, /"type":"response.completed"/);
  const responsesCompleted = responses.raw.output
    .split("\n\n")
    .map((frame) => frame.startsWith("data: ") && frame.slice(6) !== "[DONE]" ? JSON.parse(frame.slice(6)) : null)
    .find((event) => event?.type === "response.completed");
  assert.deepEqual(responsesCompleted.response.output.map((item) => item.type), [
    "message",
    "function_call",
    "message"
  ]);
  assert.equal(responsesCompleted.response.output[0].content[0].text, "hello");
  assert.equal(responsesCompleted.response.output[2].content[0].text, " after");
  assert.equal(responsesCompleted.response.output_text, "hello after");
  assert.equal((responses.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("Messages thinking stream preserves Responses encrypted reasoning", async () => {
  const source = encodeEvents([
    {
      type: "message_start",
      message: { id: "msg_reasoning", model: "claude-sonnet-4-6", usage: { input_tokens: 8, output_tokens: 1 } }
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "checked" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ]);

  const responses = await runProtocolShim("responses", "messages", source, {
    includeReasoningEncryptedContent: true
  });
  assert.equal(responses.result.ok, true);
  assert.match(responses.raw.output, /"type":"response.reasoning_summary_text.delta"/);
  assert.match(responses.raw.output, /"delta":"checked"/);
  assert.match(responses.raw.output, /"encrypted_content":"opaque-signature"/);
  assert.match(responses.raw.output, /"type":"response.completed"/);
  assert.equal((responses.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("Chat and Responses streams convert to Anthropic Messages lifecycle", async () => {
  const chatSource = encodeEvents([
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{ index: 0, delta: { reasoning_content: "checked" }, finish_reason: null }]
    },
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }]
    },
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":1}" }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }
  ]).concat(Buffer.from("data: [DONE]\n\n"));
  const chat = await runProtocolShim("messages", "chat/completions", chatSource);
  assert.equal(chat.result.ok, true);
  assert.match(chat.raw.output, /event: message_start/);
  assert.match(chat.raw.output, /"type":"thinking_delta","thinking":"checked"/);
  assert.match(chat.raw.output, /"type":"text_delta","text":"hello"/);
  assert.match(chat.raw.output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(chat.raw.output, /"type":"input_json_delta","partial_json":"\{\\"id\\":1\}"/);
  assert.match(chat.raw.output, /"stop_reason":"tool_use"/);
  assert.match(chat.raw.output, /event: message_stop/);
  assert.doesNotMatch(chat.raw.output, /data: \[DONE\]/);

  const responsesSource = encodeEvents([
    { type: "response.created", response: { id: "resp_1", model: "responses-model" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] }
    },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "checked"
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "checked" }],
        encrypted_content: "opaque-signature"
      }
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] }
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "hello" },
    {
      type: "response.output_item.added",
      output_index: 2,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" }
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"id\":1}" },
    {
      type: "response.output_item.added",
      output_index: 3,
      item: { id: "msg_2", type: "message", status: "in_progress", role: "assistant", content: [] }
    },
    { type: "response.output_text.delta", item_id: "msg_2", output_index: 3, content_index: 0, delta: " after" },
    {
      type: "response.completed",
      response: { model: "responses-model", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    }
  ]);
  const responses = await runProtocolShim("messages", "responses", responsesSource);
  assert.equal(responses.result.ok, true);
  assert.match(responses.raw.output, /event: message_start/);
  assert.match(responses.raw.output, /"type":"thinking_delta","thinking":"checked"/);
  assert.match(responses.raw.output, /"type":"signature_delta","signature":"opaque-signature"/);
  assert.match(responses.raw.output, /"type":"text_delta","text":"hello"/);
  assert.match(responses.raw.output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(responses.raw.output, /"stop_reason":"tool_use"/);
  assert.match(responses.raw.output, /event: message_stop/);
  assert.doesNotMatch(responses.raw.output, /data: \[DONE\]/);
  const messagesFrames = responses.raw.output
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter(Boolean)
    .map(JSON.parse);
  assert.deepEqual(
    messagesFrames
      .filter((event) => event.type === "content_block_start")
      .map((event) => [event.index, event.content_block.type]),
    [[0, "thinking"], [1, "text"], [2, "tool_use"], [3, "text"]]
  );
  assert.deepEqual(
    messagesFrames
      .filter((event) => event.type === "content_block_delta" && event.delta.type === "text_delta")
      .map((event) => [event.index, event.delta.text]),
    [[1, "hello"], [3, " after"]]
  );
  assert.deepEqual(
    messagesFrames.filter((event) => event.type === "content_block_stop").map((event) => event.index),
    [0, 1, 2, 3]
  );

  const summaryOnlySource = encodeEvents([
    { type: "response.created", response: { id: "resp_summary_only", model: "responses-model" } },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_summary_only",
      output_index: 0,
      summary_index: 0,
      delta: "visible summary"
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "rs_summary_only",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "visible summary" }]
      }
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        model: "responses-model",
        output: [{
          id: "rs_summary_only",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "visible summary" }]
        }]
      }
    }
  ]);
  const summaryOnly = await runProtocolShim("messages", "responses", summaryOnlySource);
  assert.equal(summaryOnly.result.ok, true);
  assert.match(summaryOnly.raw.output, /"type":"thinking_delta","thinking":"visible summary"/);
  assert.doesNotMatch(summaryOnly.raw.output, /"type":"signature_delta"/);
});

test("streaming cache usage is projected without double counting", async () => {
  const chatSource = encodeEvents([
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 2,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 3 }
      }
    },
    "[DONE]"
  ].filter((event) => event !== "[DONE]")).concat(Buffer.from("data: [DONE]\n\n"));
  const asMessages = await runProtocolShim("messages", "chat/completions", chatSource);
  assert.match(asMessages.raw.output, /"usage":\{"input_tokens":9,"output_tokens":2,"cache_read_input_tokens":3\}/);

  const messagesSource = encodeEvents([
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude",
        usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }
      }
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" }
  ]);
  const asResponses = await runProtocolShim("responses", "messages", messagesSource);
  const completedFrame = asResponses.raw.output
    .split("\n\n")
    .map((frame) => frame.startsWith("data: ") && frame.slice(6) !== "[DONE]" ? JSON.parse(frame.slice(6)) : null)
    .find((event) => event?.type === "response.completed");
  assert.deepEqual(completedFrame.response.usage, {
    input_tokens: 12,
    output_tokens: 2,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 7 }
  });

  const asChat = await runProtocolShim("chat/completions", "messages", messagesSource, {
    includeChatStreamUsage: true
  });
  const usageFrame = asChat.raw.output
    .split("\n\n")
    .map((frame) => frame.startsWith("data: ") && frame.slice(6) !== "[DONE]" ? JSON.parse(frame.slice(6)) : null)
    .find((event) => Array.isArray(event?.choices) && event.choices.length === 0);
  assert.deepEqual(usageFrame.usage, {
    prompt_tokens: 12,
    completion_tokens: 2,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 7 }
  });
});

test("Chat tool deltas keep one Anthropic block when identity aliases change", async () => {
  const source = encodeEvents([
    {
      id: "chatcmpl_1",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"id\":" } }] },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl_1",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ id: "call_1", function: { arguments: "1}" } }] },
        finish_reason: "tool_calls"
      }]
    },
    { id: "chatcmpl_1", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }
  ]).concat(Buffer.from("data: [DONE]\n\n"));
  const converted = await runProtocolShim("messages", "chat/completions", source);

  assert.equal(converted.result.ok, true);
  assert.equal((converted.raw.output.match(/"type":"tool_use"/g) || []).length, 1);
  assert.match(converted.raw.output, /"partial_json":"\{\\"id\\":"/);
  assert.match(converted.raw.output, /"partial_json":"1\}"/);
});

test("Anthropic conversion closes mixed tool and text blocks in index order", async () => {
  const source = encodeEvents([
    { type: "response.created", response: { id: "resp_1", model: "responses-model" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" }
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
    { type: "response.output_text.delta", delta: "after tool" },
    { type: "response.completed", response: { usage: { input_tokens: 4, output_tokens: 2 } } }
  ]);
  const converted = await runProtocolShim("messages", "responses", source);
  const stopIndexes = [...converted.raw.output.matchAll(/event: content_block_stop\ndata: \{"type":"content_block_stop","index":(\d+)\}/g)]
    .map((match) => Number(match[1]));

  assert.equal(converted.result.ok, true);
  assert.deepEqual(stopIndexes, [0, 1]);
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

test("Responses reasoning streams as Chat reasoning content before later output", async () => {
  const raw = new FakeReplyRaw();
  const chunks = encodeEvents([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] }
    },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "checked" },
    { type: "response.output_text.delta", delta: "answer" },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "checked" }], encrypted_content: "opaque" }]
      }
    }
  ]);
  let readIndex = 0;
  const compatibilityIssues = [];
  const result = await streamShim({
    upstreamResponse: {
      body: {
        getReader: () => ({
          async read() {
            return readIndex < chunks.length
              ? { done: false, value: chunks[readIndex++] }
              : { done: true };
          },
          async cancel() {}
        })
      }
    },
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    strictResponsesCompletion: true,
    rejectLossyResponses: false,
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {},
    onCompatibilityIssue(issue) { compatibilityIssues.push(issue); }
  });

  assert.equal(result.ok, true);
  assert.equal(compatibilityIssues.length, 1);
  assert.equal(compatibilityIssues[0]?.type, "reasoning");
  assert.match(compatibilityIssues[0]?.reason || "", /encrypted reasoning continuation/);
  assert.match(raw.output, /"reasoning_content":"checked"/);
  assert.match(raw.output, /"content":"answer"/);
  assert.equal((raw.output.match(/data: \[DONE\]/g) || []).length, 1);
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

test("empty reverse shim streams fail without a synthetic success response", async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  assert.equal(result.beforeFirstChunk, true);
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

test("passthrough does not forward events after a terminal marker", async () => {
  const terminal = `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\r\n\r\n`;
  const trailing = `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "must-not-appear" })}\r\n\r\n`;
  const raw = new FakeReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader([Buffer.from(terminal + trailing)]) } },
    reply: { raw },
    backendRouteKey: "responses",
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.equal(raw.output, terminal);
  assert.doesNotMatch(raw.output, /must-not-appear/);
});

test("passthrough records terminal usage instead of an early partial snapshot", async () => {
  const source = encodeEvents([
    {
      type: "response.created",
      response: { model: "model", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
    },
    {
      type: "response.completed",
      response: {
        model: "model",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 3 }
        }
      }
    }
  ]);
  const observed = [];
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader(source) } },
    reply: { raw: new FakeReplyRaw() },
    backendRouteKey: "responses",
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage(usage) { observed.push(usage); },
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [{
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    input_tokens_details: { cached_tokens: 3 }
  }]);
});

test("native Anthropic cache-read tokens are counted", () => {
  const before = { ...getStats().totals };
  recordUsage("anthropic-cache-test", {
    input_tokens: 2,
    output_tokens: 1,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3
  });
  assert.equal(getStats().totals.cachedTokens - before.cachedTokens, 7);
  assert.equal(getStats().totals.promptTokens - before.promptTokens, 12);
  assert.equal(getStats().totals.totalTokens - before.totalTokens, 13);
});

test("passthrough requires a protocol terminal marker", async () => {
  const source = Buffer.from(
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1" } })}\n\n`
      + `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`
  );
  const raw = new FakeReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader([source]) } },
    reply: { raw },
    backendRouteKey: "messages",
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  assert.doesNotMatch(raw.output, /message_stop/);
});

test("passthrough parses a terminal event without trailing EOL", async () => {
  const source = Buffer.from(
    `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\r\n\r\n`
      + `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}`
  );
  const raw = new FakeReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader([source]) } },
    reply: { raw },
    backendRouteKey: "responses",
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.equal(raw.output, source.toString("utf8"));
});

test("Responses passthrough accepts output done evidence at EOF", async () => {
  const source = Buffer.from(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n`
      + `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", text: "ok" })}\n\n`
      + `event: response.output_item.done\ndata: ${JSON.stringify({
        type: "response.output_item.done",
        item: { id: "msg_1", type: "message", status: "completed" }
      })}`
  );
  const raw = new FakeReplyRaw();
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader([source]) } },
    reply: { raw },
    backendRouteKey: "responses",
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, true);
  assert.equal(raw.output, source.toString("utf8"));
});

test("strict Responses passthrough rejects output done evidence at EOF", async () => {
  const source = encodeEvents([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.output_text.done", text: "partial" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_1", type: "message", status: "completed", role: "assistant" }
    }
  ]);
  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader(source) } },
    reply: { raw: new FakeReplyRaw() },
    backendRouteKey: "responses",
    strictResponsesCompletion: true,
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
});

test("passthrough rejects completion markers from another backend protocol", async () => {
  const cases = [
    {
      backendRouteKey: "responses",
      source: encodeEvents([{ type: "message_stop" }])
    },
    {
      backendRouteKey: "messages",
      source: encodeEvents([{
        type: "response.completed",
        response: { status: "completed" }
      }])
    }
  ];

  for (const { backendRouteKey, source } of cases) {
    const result = await streamPassthrough({
      upstreamResponse: { body: { getReader: () => createReader(source) } },
      reply: { raw: new FakeReplyRaw() },
      backendRouteKey,
      strictResponsesCompletion: true,
      policy: STREAM_POLICY,
      onFirstChunk() {},
      onUsage() {},
      onModel() {}
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  }
});

test("shim refuses to synthesize success after premature EOF", async () => {
  const source = encodeEvents([
    { type: "response.output_text.delta", delta: "partial" }
  ]);
  const { result, raw } = await runProtocolShim("messages", "responses", source);

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  assert.doesNotMatch(raw.output, /event: message_stop/);
});

test("shim accepts Chat finish_reason as terminal evidence at EOF", async () => {
  const source = encodeEvents([
    {
      id: "chatcmpl_1",
      model: "chat-model",
      choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1 }
    }
  ]);
  const converted = await runProtocolShim("messages", "chat/completions", source);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"text":"complete"/);
  assert.match(converted.raw.output, /event: message_stop/);
});

test("shim accepts Responses output done as terminal evidence at EOF", async () => {
  const source = encodeEvents([
    { type: "response.output_text.delta", delta: "complete" },
    { type: "response.output_text.done", text: "complete" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_1", type: "message", status: "completed", role: "assistant" }
    }
  ]);
  const converted = await runProtocolShim("chat/completions", "responses", source);

  assert.equal(converted.result.ok, true);
  assert.match(converted.raw.output, /"content":"complete"/);
  assert.equal((converted.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("strict Responses shim rejects output done evidence at EOF", async () => {
  const source = encodeEvents([
    { type: "response.output_text.delta", delta: "partial" },
    { type: "response.output_text.done", text: "partial" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { id: "msg_1", type: "message", status: "completed", role: "assistant" }
    }
  ]);
  const raw = new FakeReplyRaw();
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader(source) } },
    reply: { raw },
    modelId: "test-model",
    routeKey: "chat/completions",
    backendRouteKey: "responses",
    strictResponsesCompletion: true,
    model: {},
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage() {},
    onModel() {}
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UPSTREAM_INCOMPLETE_STREAM");
  assert.doesNotMatch(raw.output, /data: \[DONE\]/);
});

test("Anthropic Messages passthrough observes native SSE without rewriting it", async () => {
  const source = Buffer.from(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3 }
      }
    })}\n\n`
      + `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } })}\n\n`
      + `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"id\":1}" } })}\n\n`
      + `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`
      + `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  );
  const raw = new FakeReplyRaw();
  const writtenChunks = [];
  const observed = { usages: [], models: [], content: [] };
  raw.write = (value) => {
    writtenChunks.push(Buffer.from(value));
    return true;
  };

  const result = await streamPassthrough({
    upstreamResponse: { body: { getReader: () => createReader([source]) } },
    reply: { raw },
    policy: STREAM_POLICY,
    onFirstChunk() {},
    onUsage(usage) { observed.usages.push(usage); },
    onModel(model) { observed.models.push(model); },
    onContent(value, kind) { observed.content.push([value, kind]); }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.concat(writtenChunks), source);
  assert.deepEqual(observed.models, ["claude-sonnet-4-6"]);
  assert.deepEqual(observed.usages, [{
    input_tokens: 12,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    total_tokens: 20,
    cached_tokens: 3
  }]);
  assert.deepEqual(observed.content, [["你", "text"], ["{\"id\":1}", "tool"]]);
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
    forwardProviderErrors: true,
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

test("Responses passthrough hides provider error events by default", async () => {
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
  assert.equal(result.providerErrorForwarded, false);
  assert.equal(result.providerError?.code, "provider_failed");
  assert.equal(raw.output, "");
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
