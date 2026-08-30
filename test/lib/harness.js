import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const CLIENT_API_KEY = "test-client-key";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin";
const UPSTREAM_API_KEY = "test-upstream-key";
const DEFAULT_TIMEOUT_MS = 15000;

async function getFreePort() {
  const server = http.createServer();
  server.listen(0, HOST);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function jsonResponse(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function createMockUpstreamServer() {
  const requests = [];
  const acceptedApiKeys = new Set([UPSTREAM_API_KEY]);
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }

    requests.push({
      method: req.method,
      url: req.url || "",
      headers: req.headers,
      body
    });

    const url = new URL(req.url || "/", `http://${HOST}`);
    const pathname = url.pathname;
    const receivedApiKey = pathname.endsWith("/messages") || pathname.endsWith("/messages/count_tokens")
      ? req.headers["x-api-key"]
      : req.headers["api-key"];
    if (!acceptedApiKeys.has(receivedApiKey)) {
      jsonResponse(res, 401, { error: { message: "missing upstream api-key" } });
      return;
    }

    if (JSON.stringify(body).includes("trigger native HTTP error")) {
      jsonResponse(res, 429, {
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "native_rate_limit",
          message: "native upstream rate limit"
        },
        native_marker: "preserved"
      }, { "retry-after": "2" });
      return;
    }
    if (JSON.stringify(body).includes("trigger interrupted native HTTP error")) {
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "retry-after": "2"
      });
      res.write('{"error":', () => res.destroy(new Error("mock error body interrupted")));
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
      if (body?.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        });
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-stream-test",
          object: "chat.completion.chunk",
          model: body?.model || "gpt-5-mini",
          choices: [{ index: 0, delta: { content: "ok from mock chat stream" }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-stream-test",
          object: "chat.completion.chunk",
          model: body?.model || "gpt-5-mini",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      jsonResponse(res, 200, {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body?.model || "gpt-5-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "ok from mock chat"
            }
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18
        }
      });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/responses/compact")) {
      if (body?.instructions === "trigger invalid compaction") {
        jsonResponse(res, 200, { object: "response", output: [] });
        return;
      }
      jsonResponse(res, 200, {
        id: "cmp-test",
        object: "response.compaction",
        created_at: Math.floor(Date.now() / 1000),
        output: [
          {
            id: "msg-compact-test",
            type: "message",
            status: "completed",
            role: "user",
            content: [{ type: "input_text", text: "compact this conversation" }]
          },
          {
            id: "cmp-item-test",
            type: "compaction",
            encrypted_content: "encrypted-compaction-state"
          }
        ],
        usage: {
          input_tokens: 21,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 29
        }
      });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/responses")) {
      const omitUsage = typeof body?.input === "string" && body.input.startsWith("local usage fallback");
      const disconnectBeforeUsage = body?.input === "disconnect usage fallback";
      const upstreamDisconnectBeforeUsage = body?.input === "upstream disconnect usage fallback";
      const providerErrorAfterDelta = JSON.stringify(body).includes("trigger provider error");
      const failedJsonResponse = JSON.stringify(body).includes("trigger failed json");
      const nonTerminalJsonResponse = JSON.stringify(body).includes("trigger nonterminal response");
      const modernItemResponse = JSON.stringify(body).includes("trigger modern Responses item");
      const modernItemStream = JSON.stringify(body).includes("trigger modern Responses stream item");
      const toolSearchItemResponse = JSON.stringify(body).includes("trigger Tool Search Responses item");
      const toolSearchItemStream = JSON.stringify(body).includes("trigger Tool Search Responses stream item");
      const nativeProviderStreamError = JSON.stringify(body).includes("trigger native stream error");
      if (body?.stream === true) {
        const outputText = "ok from mock responses stream";
        const outputItem = {
          id: "msg-stream-test",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: outputText, annotations: [], logprobs: [] }]
        };
        const response = {
          id: "resp-stream-test",
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: body?.model || "gpt-5.6-luna",
          status: "completed",
          output: [outputItem],
          ...(omitUsage || disconnectBeforeUsage || upstreamDisconnectBeforeUsage ? {} : { usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 } })
        };
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        });
        if (nativeProviderStreamError) {
          res.end(`data: ${JSON.stringify({
            type: "error",
            error: {
              type: "server_error",
              code: "native_stream_failure",
              message: "native upstream stream failed"
            },
            native_marker: "preserved"
          })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress" } })}\n\n`);
        if (modernItemStream) {
          const modernItem = {
            id: "computer-stream-test",
            type: "computer_call",
            call_id: "computer-call-stream-test",
            status: "completed",
            pending_safety_checks: [],
            action: { type: "screenshot" }
          };
          const modernResponse = { ...response, output: [modernItem] };
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...modernItem, status: "in_progress" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: modernItem })}\n\n`);
          res.end(`data: ${JSON.stringify({ type: "response.completed", response: modernResponse })}\n\n`);
          return;
        }
        if (toolSearchItemStream) {
          const toolSearchItem = {
            id: "tool-search-stream-test",
            type: "tool_search_call",
            call_id: "tool-search-call-stream-test",
            status: "completed",
            execution: "client",
            arguments: "{\"goal\":\"find a tool\"}"
          };
          const toolSearchResponse = { ...response, output: [toolSearchItem] };
          res.write(`data: ${JSON.stringify({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...toolSearchItem, status: "in_progress" }
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: toolSearchItem
          })}\n\n`);
          res.end(`data: ${JSON.stringify({ type: "response.completed", response: toolSearchResponse })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...outputItem, status: "in_progress", content: [] }
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "response.content_part.added",
          item_id: outputItem.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [], logprobs: [] }
        })}\n\n`);
        const deltaFrame = `data: ${JSON.stringify({
          type: "response.output_text.delta",
          item_id: outputItem.id,
          output_index: 0,
          content_index: 0,
          delta: outputText,
          logprobs: []
        })}\n\n`;
        if (upstreamDisconnectBeforeUsage) {
          res.write(deltaFrame, () => res.destroy(new Error("mock upstream disconnected")));
          return;
        }
        res.write(deltaFrame);
        if (providerErrorAfterDelta) {
          res.end(`data: ${JSON.stringify({
            type: "error",
            error: { type: "provider_error", code: "provider_failed", message: "mock provider failed" }
          })}\n\n`);
          return;
        }
        if (disconnectBeforeUsage) {
          const timer = setTimeout(() => res.end(), 5000);
          res.once("close", () => clearTimeout(timer));
          return;
        }
        res.write(`data: ${JSON.stringify({
          type: "response.output_text.done",
          item_id: outputItem.id,
          output_index: 0,
          content_index: 0,
          text: outputText,
          logprobs: []
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          type: "response.content_part.done",
          item_id: outputItem.id,
          output_index: 0,
          content_index: 0,
          part: outputItem.content[0]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: outputItem })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
        return;
      }
      if (nonTerminalJsonResponse) {
        jsonResponse(res, 200, {
          id: "resp-nonterminal-test",
          object: "response",
          model: body?.model || "gpt-5.6-luna",
          status: "in_progress",
          output: [{
            id: "msg-nonterminal-test",
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [{ type: "output_text", text: "partial output" }]
          }]
        });
        return;
      }
      if (failedJsonResponse) {
        const failedBody = `{
  "id": "resp-failed-test",
  "object": "response",
  "model": ${JSON.stringify(body?.model || "gpt-5.6-luna")},
  "status": "failed",
  "error": {"type":"model_error","code":"model_failed","message":"mock JSON response failed"},
  "output": []
}`;
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(failedBody),
          "retry-after": "3"
        });
        res.end(failedBody);
        return;
      }
      if (modernItemResponse) {
        jsonResponse(res, 200, {
          id: "resp-modern-test",
          object: "response",
          model: body?.model || "gpt-5.6-luna",
          status: "completed",
          output: [
            {
              id: "ws-modern-test",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "latest protocol" }
            },
            {
              id: "msg-modern-test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "modern response", annotations: [], logprobs: [] }]
            }
          ],
          usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 }
        });
        return;
      }
      if (toolSearchItemResponse) {
        jsonResponse(res, 200, {
          id: "resp-tool-search-test",
          object: "response",
          model: body?.model || "gpt-5.6-luna",
          status: "completed",
          output: [{
            id: "tool-search-test",
            type: "tool_search_call",
            call_id: "tool-search-call-test",
            status: "completed",
            execution: "client",
            arguments: "{\"goal\":\"find a tool\"}"
          }],
          usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 }
        });
        return;
      }
      jsonResponse(res, 200, {
        id: "resp-test",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: body?.model || "gpt-5-mini",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "ok from mock responses"
              }
            ]
          }
        ],
        ...(omitUsage ? {} : {
          usage: {
            input_tokens: 10,
            output_tokens: 6,
            total_tokens: 16
          }
        })
      });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/messages/count_tokens")) {
      jsonResponse(res, 200, body?.system === "trigger invalid token count"
        ? { input_tokens: "42" }
        : { input_tokens: 42 });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/messages")) {
      const modernContentResponse = JSON.stringify(body).includes("trigger modern Messages block");
      const modernContentStream = JSON.stringify(body).includes("trigger modern Messages stream block");
      const reasoningContentStream = JSON.stringify(body).includes("trigger encrypted reasoning stream");
      if (body?.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        });
        res.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg-stream-test",
            type: "message",
            role: "assistant",
            model: body?.model || "claude-sonnet-4-20250514",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 3 }
          }
        })}\n\n`);
        if (modernContentStream) {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "server_tool_use", id: "srvtool-stream-test", name: "web_search", input: {} }
          })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 }
          })}\n\n`);
          res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          return;
        }
        if (reasoningContentStream) {
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" }
          })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "checked sources" }
          })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque-stream-signature" }
          })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" }
          })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "reasoning preserved" }
          })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 }
          })}\n\n`);
          res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          return;
        }
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok from mock messages stream" }
        })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 }
        })}\n\n`);
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        return;
      }
      if (modernContentResponse) {
        jsonResponse(res, 200, {
          id: "msg-modern-test",
          type: "message",
          role: "assistant",
          model: body?.model || "claude-native-deployment",
          content: [{ type: "redacted_thinking", data: "opaque-thinking-state" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 5 }
        });
        return;
      }
      jsonResponse(res, 200, {
        id: "msg-test",
        type: "message",
        role: "assistant",
        model: body?.model || "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "ok from mock messages" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 5
        }
      });
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/images/generations")) {
      jsonResponse(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            url: "https://example.com/generated-image.png"
          }
        ]
      });
      return;
    }

    if (req.method === "POST" && pathname.includes("/providers/blackforestlabs/v1/")) {
      jsonResponse(res, 200, {
        created: Math.floor(Date.now() / 1000),
        data: [
          {
            url: "https://example.com/blackforest-image.png"
          }
        ]
      });
      return;
    }

    jsonResponse(res, 404, { error: { message: `Unhandled mock upstream route: ${req.method} ${pathname}` } });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  return {
    server,
    requests,
    closeConnections() {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
    clearRequests() {
      requests.length = 0;
    },
    allowApiKey(apiKey) {
      acceptedApiKeys.add(apiKey);
    }
  };
}

function buildTestConfig({ proxyPort, upstreamPort, configPath }) {
  return {
    version: 3,
    server: {
      host: HOST,
      port: proxyPort,
      adminPath: "/admin",
      adminAuth: {
        enabled: true,
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD
      },
      caddy: {
        enabled: false,
        domain: "",
        email: "",
        httpsPort: 443,
        upstreamHost: HOST,
        upstreamPort: proxyPort
      },
      upstream: {
        connectTimeoutMs: 5000,
        requestTimeoutMs: 30000,
        firstByteTimeoutMs: 15000,
        idleTimeoutMs: 30000,
        maxRetries: 0,
        retryBaseMs: 100,
        retryMaxMs: 500,
        pool: {
          connections: 8,
          keepAliveTimeoutMs: 5000,
          keepAliveMaxTimeoutMs: 10000,
          headersTimeoutMs: 30000,
          bodyTimeoutMs: 0,
          pipelining: 1
        }
      }
    },
    auth: {
      mode: "apiKey",
      apiKey: UPSTREAM_API_KEY,
      scope: "https://cognitiveservices.azure.com/.default"
    },
    proxy: {
      guards: {
        rejectUnknownProxyParams: false,
        dropUnsupportedOpenAiParams: false,
        sanitizeMeaninglessValues: true
      }
    },
    observability: {
      logs: {
        level: "info",
        sinks: ["memory"],
        bufferSize: 100
      },
      runtimeStore: {
        enabled: false
      }
    },
    persistence: {
      configStore: {
        mode: "file",
        filePath: configPath,
        database: {
          enabled: false,
          provider: "postgresql",
          connectionRef: "",
          schema: "public",
          tableName: "proxy_configs",
          configKey: "active",
          pool: {}
        }
      },
      compatibilityExport: {
        enabled: true,
        exportLegacyConfigOnChange: true,
        legacyConfigPath: configPath
      }
    },
    access: {
      defaults: {
        requireApiKey: true,
        keyHeaderNames: ["Authorization", "x-api-key"]
      },
      rateLimits: {
        windowSeconds: 60,
        defaultRpm: 0,
        defaultTpm: 0,
        defaultConcurrency: 0
      },
      budgets: {
        enabled: false,
        defaultCurrency: "USD",
        defaultWindowType: "monthly",
        softLimitRatio: 0.8,
        hardLimitAction: "block"
      }
    },
    apiKeys: [
      {
        id: "test-client",
        displayName: "Test Client",
        key: CLIENT_API_KEY,
        status: "active"
      }
    ],
    upstreams: [
      {
        name: "mock-foundry",
        provider: "azure-openai",
        baseUrl: `http://${HOST}:${upstreamPort}/`,
        status: "active",
        routes: {
          "chat/completions": "/openai/v1/chat/completions",
          responses: "/openai/v1/responses",
          messages: "/openai/v1/messages",
          "images/generations": "/openai/v1/images/generations"
        }
      },
      {
        name: "mock-anthropic",
        provider: "anthropic",
        baseUrl: `http://${HOST}:${upstreamPort}/`,
        status: "active",
        routes: {
          messages: "/anthropic/v1/messages"
        }
      }
    ],
    models: [
      {
        id: "gpt-5-mini",
        displayName: "GPT-5 Mini",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "gpt-5-mini",
        pricingRef: "gpt-5-mini",
        routes: {}
      },
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "gpt-5.6-luna",
        pricingRef: "gpt-5.6-luna",
        clientCompatibility: { codex: true },
        routes: {}
      },
      {
        id: "model-router",
        displayName: "Model Router",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "model-router",
        pricingRef: "model-router",
        clientCompatibility: { codex: true },
        routes: {
          messages: "chat/completions"
        }
      },
      {
        id: "claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "claude-sonnet-4-20250514",
        pricingRef: "claude-sonnet-4-6",
        routes: {
          "*": "messages"
        }
      },
      {
        id: "claude-opus-4-8",
        displayName: "Claude Opus 4.8",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "claude-opus-4-8",
        pricingRef: "claude-opus-4-8",
        hostingMode: "azure",
        routes: {}
      },
      {
        id: "claude-native",
        displayName: "Claude Native",
        status: "active",
        upstream: "mock-anthropic",
        targetModel: "claude-native-deployment",
        pricingRef: "claude-sonnet-4-6",
        clientCompatibility: { claudeCode: true },
        routes: {
          "*": "messages"
        }
      },
      {
        id: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "claude-sonnet-5",
        pricingRef: "claude-sonnet-5",
        routes: {
          "*": "messages"
        }
      },
      {
        id: "claude-sonnet-5-alias",
        displayName: "Claude Sonnet 5 Custom Deployment",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "team-sonnet-deployment",
        pricingRef: "claude-sonnet-5",
        routes: {
          "*": "messages"
        }
      },
      {
        id: "chat-only",
        displayName: "Chat Only",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "chat-only-deployment",
        pricingRef: "gpt-4o-mini",
        routes: {
          "*": "chat/completions"
        }
      },
      {
        id: "gpt-image-1.5",
        displayName: "GPT Image 1.5",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "gpt-image-1.5",
        pricingRef: "gpt-image-1.5",
        routes: {}
      },
      {
        id: "flux-2-pro",
        displayName: "FLUX.2 Pro",
        status: "active",
        upstream: "mock-foundry",
        targetModel: "flux-2-pro",
        pricingRef: "flux-2-pro",
        routes: {
          "*": "blackforest-image"
        }
      }
    ]
  };
}

async function waitForServerReady(baseUrl, timeoutMs, childProcess, output) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasChildProcessExited(childProcess)) {
      throw new Error(`Proxy process exited early with code ${childProcess.exitCode}\nSTDOUT:\n${output.stdout.join("")}\nSTDERR:\n${output.stderr.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
    }
    await delay(200);
  }

  throw new Error(`Timed out waiting for proxy server on ${baseUrl}\nSTDOUT:\n${output.stdout.join("")}\nSTDERR:\n${output.stderr.join("")}`);
}

function hasChildProcessExited(childProcess) {
  return childProcess.exitCode != null || childProcess.signalCode != null;
}

async function stopChildProcess(childProcess) {
  if (!childProcess || hasChildProcessExited(childProcess)) {
    return;
  }

  childProcess.kill("SIGTERM");
  const exitPromise = once(childProcess, "exit").catch(() => null);
  await Promise.race([exitPromise, delay(3000)]);
  if (!hasChildProcessExited(childProcess)) {
    childProcess.kill("SIGKILL");
    if (!hasChildProcessExited(childProcess)) {
      await once(childProcess, "exit").catch(() => null);
    }
  }
}

async function closeMockUpstream(upstream) {
  if (!upstream) return;
  upstream.closeConnections();
  if (!upstream.server.listening) return;
  await new Promise((resolve, reject) => {
    upstream.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function ensure(condition, message) {
  assert.ok(condition, message);
}

export async function createTestContext({
  logLevel = "error",
  proxyArgs = ["src/server.js"],
  startupTimeoutMs = DEFAULT_TIMEOUT_MS,
  tempPrefix = "aoai-proxy-route-test-"
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  let upstream;
  let childProcess;
  let setup;
  try {
    const proxyPort = await getFreePort();
    const upstreamPort = await getFreePort();
    const configPath = path.join(tempDir, "config.json");
    const proxyBaseUrl = `http://${HOST}:${proxyPort}`;

    upstream = createMockUpstreamServer();
    upstream.server.listen(upstreamPort, HOST);
    await once(upstream.server, "listening");

    const config = buildTestConfig({ proxyPort, upstreamPort, configPath });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const output = { stdout: [], stderr: [] };
    childProcess = spawn(process.execPath, proxyArgs, {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
      env: {
        ...process.env,
        CONFIG_PATH: configPath,
        LOG_LEVEL: logLevel,
        AOAI_PROXY_VERSION: "nextgen-202608100000",
        AOAI_PROXY_BUILD_TIME: "2026-08-10T00:00:00Z"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    childProcess.stdout.on("data", (chunk) => {
      output.stdout.push(String(chunk));
    });
    childProcess.stderr.on("data", (chunk) => {
      output.stderr.push(String(chunk));
    });

    await waitForServerReady(proxyBaseUrl, startupTimeoutMs, childProcess, output);
    setup = { configPath, proxyBaseUrl, output };
  } catch (error) {
    await stopChildProcess(childProcess).catch(() => {});
    await closeMockUpstream(upstream).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const { configPath, proxyBaseUrl, output } = setup;

  const clientAuthHeaders = {
    authorization: `Bearer ${CLIENT_API_KEY}`
  };
  const adminAuthHeaders = {
    authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}`
  };

  async function request(routePath, options = {}) {
    const {
      method = "GET",
      headers = {},
      json,
      body,
      duplex,
      redirect = "follow"
    } = options;
    const response = await fetch(`${proxyBaseUrl}${routePath}`, {
      method,
      headers: {
        ...headers,
        ...(json !== undefined ? { "content-type": "application/json" } : {})
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      ...(duplex ? { duplex } : {}),
      redirect
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return {
      response,
      status: response.status,
      headers: response.headers,
      text,
      json: parsed
    };
  }

  const ctx = {
    baseUrl: proxyBaseUrl,
    output,
    configPath,
    tempDir,
    upstreamRequests: upstream.requests,
    clearUpstreamRequests: () => upstream.clearRequests(),
    allowUpstreamApiKey: (apiKey) => upstream.allowApiKey(apiKey),
    request,
    async publicRequest(routePath, options = {}) {
      return request(routePath, {
        ...options,
        headers: {
          ...clientAuthHeaders,
          ...(options.headers || {})
        }
      });
    },
    async adminRequest(routePath, options = {}) {
      return request(routePath, {
        ...options,
        headers: {
          ...adminAuthHeaders,
          ...(options.headers || {})
        }
      });
    },
    async readConfigFile() {
      const text = await fs.readFile(configPath, "utf8");
      return JSON.parse(text);
    },
    async primeTraffic() {
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          messages: [
            {
              role: "user",
              content: "hello"
            }
          ]
        }
      });
      assert.equal(result.status, 200, `Failed to prime chat traffic: ${result.text}`);
      return result;
    },
    async waitForExit(timeoutMs = 3000) {
      if (hasChildProcessExited(childProcess)) {
        return childProcess.exitCode;
      }
      const exitPromise = once(childProcess, "exit").then(([code]) => code);
      const timed = await Promise.race([exitPromise, delay(timeoutMs, Symbol.for("timeout"))]);
      if (timed === Symbol.for("timeout")) {
        throw new Error(`Timed out waiting for proxy exit\nSTDOUT:\n${output.stdout.join("")}\nSTDERR:\n${output.stderr.join("")}`);
      }
      return timed;
    },
    async stopProxy() {
      await stopChildProcess(childProcess);
    },
    getUpstreamRequest(predicate = null) {
      if (!predicate) {
        return upstream.requests[upstream.requests.length - 1] || null;
      }
      return upstream.requests.find(predicate) || null;
    },
    async cleanup() {
      try {
        await stopChildProcess(childProcess);
      } finally {
        try {
          await closeMockUpstream(upstream);
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      }
    }
  };

  return ctx;
}

export async function withTestContext(run, options) {
  const ctx = await createTestContext(options);
  try {
    await run(ctx);
  } finally {
    await ctx.cleanup();
  }
}