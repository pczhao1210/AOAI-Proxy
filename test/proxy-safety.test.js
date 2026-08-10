import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { resolveApiConsumer, filterModelsForConsumer, checkConsumerModelAccess, getGovernanceSnapshot } from "../src/governance.js";
import { extractProxyRequestControls, sanitizeIncomingHeaders } from "../src/proxy/body.js";
import { fetchOnceWithConnectTimeout, fetchWithRetry, parseJsonWithTimeout } from "../src/proxy/reliability.js";
import { buildUpstreamUrl, inferBackendRouteKey } from "../src/proxy/routing.js";
import { streamPassthrough, streamShim } from "../src/proxy/stream.js";
import {
  chatToMessagesRequest,
  chatToResponsesRequest,
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

async function runProtocolShim(routeKey, backendRouteKey, chunks) {
  const raw = new FakeReplyRaw();
  const observed = { usages: [], models: [], content: [] };
  const result = await streamShim({
    upstreamResponse: { body: { getReader: () => createReader(chunks) } },
    reply: { raw },
    modelId: "test-model",
    routeKey,
    backendRouteKey,
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

test("Anthropic Messages routes use the Foundry services host", () => {
  assert.equal(
    buildUpstreamUrl({
      baseUrl: "https://example.openai.azure.com/",
      routes: { messages: "/anthropic/v1/messages" }
    }, "messages", "claude-sonnet-4-6"),
    "https://example.services.ai.azure.com/anthropic/v1/messages"
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

  const chatPayload = {
    id: "chatcmpl_1",
    model: "chat-model",
    choices: [{
      finish_reason: "length",
      message: {
        role: "assistant",
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
  assert.equal(mappedMessages.content[1].type, "tool_use");
  assert.deepEqual(mappedMessages.usage, { input_tokens: 7, output_tokens: 3 });

  const responsesPayload = mapChatCompletionJsonToResponses(chatPayload, "fallback");
  const responsesAsMessages = mapResponsesJsonToMessages(responsesPayload, "fallback");
  assert.equal(responsesAsMessages.stop_reason, "max_tokens");
  assert.equal(responsesAsMessages.content[1].name, "lookup");
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
  assert.equal((responses.raw.output.match(/data: \[DONE\]/g) || []).length, 1);
});

test("Chat and Responses streams convert to Anthropic Messages lifecycle", async () => {
  const chatSource = encodeEvents([
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
  assert.match(chat.raw.output, /"type":"text_delta","text":"hello"/);
  assert.match(chat.raw.output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(chat.raw.output, /"type":"input_json_delta","partial_json":"\{\\"id\\":1\}"/);
  assert.match(chat.raw.output, /"stop_reason":"tool_use"/);
  assert.match(chat.raw.output, /event: message_stop/);
  assert.doesNotMatch(chat.raw.output, /data: \[DONE\]/);

  const responsesSource = encodeEvents([
    { type: "response.created", response: { id: "resp_1", model: "responses-model" } },
    { type: "response.output_text.delta", delta: "hello" },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "" }
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"id\":1}" },
    {
      type: "response.completed",
      response: { model: "responses-model", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    }
  ]);
  const responses = await runProtocolShim("messages", "responses", responsesSource);
  assert.equal(responses.result.ok, true);
  assert.match(responses.raw.output, /event: message_start/);
  assert.match(responses.raw.output, /"type":"text_delta","text":"hello"/);
  assert.match(responses.raw.output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(responses.raw.output, /"stop_reason":"tool_use"/);
  assert.match(responses.raw.output, /event: message_stop/);
  assert.doesNotMatch(responses.raw.output, /data: \[DONE\]/);
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
