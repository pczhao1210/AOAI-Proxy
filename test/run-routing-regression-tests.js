import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initAuth } from "../src/auth.js";
import { proxyRequest } from "../src/proxy.js";
import { streamPassthrough, streamShim } from "../src/proxy/stream.js";

const upstreamBaseUrl = "https://mock.openai.azure.com/";
const config = {
  server: {
    trustProxy: false,
    imageCompression: { enabled: false },
    upstream: {
      connectTimeoutMs: 1000,
      firstByteTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024 * 1024,
      maxRetries: 0
    }
  },
  auth: {
    mode: "apiKey",
    apiKey: "upstream-test-key",
    scope: "https://cognitiveservices.azure.com/.default"
  },
  upstreams: [{
    name: "mock",
    baseUrl: upstreamBaseUrl,
    routes: {
      "chat/completions": "/openai/v1/chat/completions",
      responses: "/openai/v1/responses"
    }
  }],
  models: [{
    id: "gpt-5.6-luna",
    upstream: "mock",
    targetModel: "gpt-5.6-luna",
    routes: {}
  }, {
    id: "gpt-5.6-luna-native",
    upstream: "mock",
    targetModel: "gpt-5.6-luna",
    routes: { "chat/completions": "chat/completions" }
  }, {
    id: "query-route",
    upstream: "mock",
    targetModel: "query-route",
    routes: { "chat/completions": "/openai/v1/responses?api-version=preview" }
  }, {
    id: "chat-model",
    upstream: "mock",
    targetModel: "chat-model",
    routes: {}
  }]
};

const log = {
  info() {},
  warn() {},
  error() {}
};

function createReply() {
  return {
    statusCode: 200,
    payload: undefined,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
  };
}

async function invokeProxy(body, responder) {
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const request = {
      url: String(url),
      headers: options?.headers || {},
      body: JSON.parse(options?.body || "{}")
    };
    captured.push(request);
    const payload = responder(request);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const reply = createReply();
  try {
    await proxyRequest({
      config,
      routeKey: "chat/completions",
      req: {
        id: `req-${body.model}`,
        headers: {},
        body,
        log,
        socket: { remoteAddress: "127.0.0.1" }
      },
      reply
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.length, 1);
  return { request: captured[0], reply };
}

function responsesSuccess(request) {
  return {
    id: "resp-test",
    object: "response",
    status: "completed",
    model: request.body.model,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }]
    }]
  };
}

function chatSuccess(request) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: request.body.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop"
    }]
  };
}

function createStreamReplyRaw() {
  const raw = new EventEmitter();
  raw.chunks = [];
  raw.destroyed = false;
  raw.writableEnded = false;
  raw.write = (chunk) => {
    raw.chunks.push(Buffer.from(chunk));
    return true;
  };
  raw.output = () => Buffer.concat(raw.chunks).toString("utf8");
  return raw;
}

function createStreamResponse(text) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

initAuth(config);

const promoted = await invokeProxy({
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "hello" }],
  reasoning_effort: "max",
  tools: [{
    type: "function",
    function: { name: "lookup", description: "", parameters: { type: "object" } }
  }]
}, responsesSuccess);
assert.equal(promoted.request.url, `${upstreamBaseUrl}openai/v1/responses`);
assert.deepEqual(promoted.request.body.reasoning, { effort: "max" });
assert.equal(promoted.request.body.tools[0].description, "lookup");
assert.equal(promoted.reply.statusCode, 200);
assert.equal(promoted.reply.payload.choices[0].message.content, "ok");

const explicitNative = await invokeProxy({
  model: "gpt-5.6-luna-native",
  messages: [{ role: "user", content: "hello" }]
}, chatSuccess);
assert.equal(explicitNative.request.url, `${upstreamBaseUrl}openai/v1/chat/completions`);

const queryRoute = await invokeProxy({
  model: "query-route",
  messages: [{ role: "user", content: "hello" }]
}, responsesSuccess);
assert.equal(queryRoute.request.url, `${upstreamBaseUrl}openai/v1/responses?api-version=preview`);
assert.equal(queryRoute.request.body.input[0].content, "hello");
assert.equal(queryRoute.reply.payload.choices[0].message.content, "ok");

const sanitized = await invokeProxy({
  model: "chat-model",
  messages: [
    { role: "tool", tool_call_id: "orphan", content: "orphan" },
    { role: "user", content: "hello" }
  ]
}, chatSuccess);
assert.deepEqual(sanitized.request.body.messages, [{ role: "user", content: "hello" }]);

const providerFailure = await invokeProxy({
  model: "gpt-5.6-luna",
  messages: [{ role: "user", content: "trigger failure" }]
}, () => ({
  id: "resp-failed-test",
  object: "response",
  status: "failed",
  error: {
    message: "model failed",
    code: "model_failed",
    type: "invalid_request_error",
    param: "input"
  }
}));
assert.equal(providerFailure.reply.statusCode, 502);
assert.equal(providerFailure.reply.payload.code, "UPSTREAM_PROVIDER_RESPONSE_ERROR");
assert.equal(providerFailure.reply.payload.upstreamCode, "model_failed");
assert.equal(providerFailure.reply.payload.message, "model failed");

const streamPolicy = { firstByteTimeoutMs: 1000, idleTimeoutMs: 1000 };
const incompletePassthrough = await streamPassthrough({
  upstreamResponse: createStreamResponse(
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`
  ),
  reply: { raw: createStreamReplyRaw() },
  modelId: "gpt-5.6-luna",
  backendRouteKey: "responses",
  policy: streamPolicy,
  onFirstChunk() {}
});
assert.equal(incompletePassthrough.ok, false);
assert.equal(incompletePassthrough.error?.code, "UPSTREAM_INCOMPLETE_STREAM");

const completedStreamRaw = createStreamReplyRaw();
const completedShim = await streamShim({
  upstreamResponse: createStreamResponse([
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "complete" })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: { type: "message", status: "completed" }
    })}`
  ].join("")),
  reply: { raw: completedStreamRaw },
  modelId: "gpt-5.6-luna",
  routeKey: "chat/completions",
  backendRouteKey: "responses",
  model: { id: "gpt-5.6-luna" },
  policy: streamPolicy,
  onFirstChunk() {}
});
assert.equal(completedShim.ok, true);
assert.match(completedStreamRaw.output(), /data: \[DONE\]/);

console.log("Routing regression tests passed");