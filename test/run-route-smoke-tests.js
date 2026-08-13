import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

const PROXY_API_KEY = "test-proxy-key";
const UPSTREAM_API_KEY = "test-upstream-key";
const CLIENT_SECRET = "test-client-secret";
const ADMIN_PASSWORD = "test-admin-password";
const REDACTED_SECRET_VALUE = "__AOAI_PROXY_REDACTED__";
const ADMIN_PATH = "/control";

function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

async function getFreePort() {
  const server = http.createServer();
  const address = await listen(server);
  await closeServer(server);
  return address.port;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createMockUpstream() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readJson(req);
      requests.push({
        method: req.method,
        url: req.url,
        apiKey: req.headers["api-key"],
        body
      });

      if (req.headers["api-key"] !== UPSTREAM_API_KEY) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "missing upstream api key", code: "unauthorized" } }));
        return;
      }

      if (req.url === "/openai/v1/chat/completions") {
        if (body.stream === true) {
          const streamBody = [
            `data: ${JSON.stringify({
              id: "chatcmpl-stream-test",
              object: "chat.completion.chunk",
              model: body.model,
              choices: [{ index: 0, delta: { content: "stream-ok" }, finish_reason: null }]
            })}\n\n`,
            "data: [DONE]\n\n"
          ].join("");
          const compressedBody = gzipSync(streamBody);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": compressedBody.length
          });
          res.end(compressedBody);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
        return;
      }

      if (req.url?.startsWith("/openai/v1/responses")) {
        if (JSON.stringify(body.input || "").includes("trigger-provider-failure")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
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
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "resp-test",
          object: "response",
          model: body.model,
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }]
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unknown route ${req.url}` } }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  return { server, requests };
}

async function waitForProxy(baseUrl, child) {
  const deadline = Date.now() + 10000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`proxy exited before becoming healthy with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`proxy did not become healthy: ${lastError?.message || "timeout"}`);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PROXY_API_KEY}`,
      "x-request-id": `test-${Date.now()}`
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function postStream(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${PROXY_API_KEY}`,
      "x-request-id": `test-stream-${Date.now()}`
    },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  return response.text();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-proxy-routes-"));
  const configPath = path.join(tempDir, "config.json");
  const proxyPort = await getFreePort();
  const { server: upstreamServer, requests } = createMockUpstream();
  const upstreamAddress = await listen(upstreamServer);
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamAddress.port}`;

  const config = {
    server: {
      host: "127.0.0.1",
      port: proxyPort,
      adminPath: ADMIN_PATH,
      adminAuth: { enabled: false, username: "admin", password: ADMIN_PASSWORD },
      caddy: { enabled: false }
    },
    auth: {
      mode: "apiKey",
      scope: "https://cognitiveservices.azure.com/.default",
      apiKey: UPSTREAM_API_KEY,
      clientSecret: CLIENT_SECRET
    },
    apiKeys: [{ id: "test", key: PROXY_API_KEY, status: "active" }],
    upstreams: [{
      name: "mock",
      baseUrl: upstreamBaseUrl,
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        "responses": "/openai/v1/responses"
      }
    }],
    models: [{
      id: "test-chat",
      upstream: "mock",
      targetModel: "test-chat",
      routes: {}
    }, {
      id: "test-response",
      upstream: "mock",
      targetModel: "test-response",
      routes: { "*": "responses" }
    }, {
      id: "test-query-route",
      upstream: "mock",
      targetModel: "test-query-route",
      routes: { "chat/completions": "/openai/v1/responses?api-version=preview" }
    }, {
      id: "gpt-5.6-luna",
      upstream: "mock",
      targetModel: "gpt-5.6-luna",
      routes: {}
    }, {
      id: "gpt-5.6-luna-native",
      upstream: "mock",
      targetModel: "gpt-5.6-luna",
      routes: { "chat/completions": "chat/completions" }
    }]
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      PERSISTENCE_MODE: "file",
      LOG_LEVEL: "error"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    const baseUrl = `http://127.0.0.1:${proxyPort}`;
    await waitForProxy(baseUrl, child);

    const adminPage = await fetch(`${baseUrl}${ADMIN_PATH}/`);
    assert.equal(adminPage.status, 200);
    const adminApiScript = await fetch(`${baseUrl}${ADMIN_PATH}/admin/api.js`);
    assert.equal(adminApiScript.status, 200);
    const adminApiScriptText = await adminApiScript.text();
    assert.doesNotMatch(adminApiScriptText, /\/admin\/api\//);
    assert.match(adminApiScriptText, /\.\/api\//);

    const adminConfig = await requestJson(`${baseUrl}${ADMIN_PATH}/api/config`);
    assert.equal(adminConfig.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.auth.clientSecret, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.server.adminAuth.password, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.apiKeys[0].key, REDACTED_SECRET_VALUE);
    const adminConfigText = JSON.stringify(adminConfig);
    for (const secret of [UPSTREAM_API_KEY, CLIENT_SECRET, ADMIN_PASSWORD, PROXY_API_KEY]) {
      assert.equal(adminConfigText.includes(secret), false, `admin config exposed ${secret}`);
    }

    adminConfig.server.trustProxy = true;
    adminConfig.server.upstream.pool.connections = 7;
    adminConfig.server.adminPath = "/next-control";
    const saveResult = await requestJson(`${baseUrl}${ADMIN_PATH}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adminConfig)
    });
    assert.equal(saveResult.ok, true);
    assert.equal(saveResult.upstreamHttp.connections, 7);
    assert.equal(saveResult.restartRequired, true);
    assert.equal(saveResult.config.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(saveResult.config.apiKeys[0].key, REDACTED_SECRET_VALUE);

    const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(persistedConfig.auth.apiKey, UPSTREAM_API_KEY);
    assert.equal(persistedConfig.auth.clientSecret, CLIENT_SECRET);
    assert.equal(persistedConfig.server.adminAuth.password, ADMIN_PASSWORD);
    assert.equal(persistedConfig.apiKeys[0].key, PROXY_API_KEY);
    assert.equal(persistedConfig.server.trustProxy, true);
    assert.equal(persistedConfig.server.upstream.pool.connections, 7);
    assert.equal(persistedConfig.server.adminPath, "/next-control");

    const reloadResult = await requestJson(`${baseUrl}${ADMIN_PATH}/api/reload`, { method: "POST" });
    assert.equal(reloadResult.ok, true);
    assert.equal(reloadResult.upstreamHttp.connections, 7);
    assert.equal(reloadResult.restartRequired, true);
    assert.equal(reloadResult.config.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(reloadResult.config.apiKeys[0].key, REDACTED_SECRET_VALUE);

    const chat = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "test-chat",
      messages: [{ role: "user", content: "hello" }]
    });
    if (chat?.choices?.[0]?.message?.content !== "ok") {
      throw new Error(`unexpected chat response: ${JSON.stringify(chat)}`);
    }

    const responses = await postJson(`${baseUrl}/v1/responses`, {
      model: "test-response",
      input: "hello"
    });
    if (responses?.output?.[0]?.content?.[0]?.text !== "ok") {
      throw new Error(`unexpected responses response: ${JSON.stringify(responses)}`);
    }

    const queryRouteChat = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "test-query-route",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(queryRouteChat.choices?.[0]?.message?.content, "ok");
    assert.equal(requests.at(-1)?.url, "/openai/v1/responses?api-version=preview");
    assert.equal(requests.at(-1)?.body?.input?.[0]?.content, "hello");

    const gpt56Chat = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "max",
      tools: [{
        type: "function",
        function: { name: "lookup", description: "", parameters: { type: "object" } }
      }]
    });
    assert.equal(gpt56Chat.choices?.[0]?.message?.content, "ok");
    assert.equal(requests.at(-1)?.url, "/openai/v1/responses");
    assert.deepEqual(requests.at(-1)?.body?.reasoning, { effort: "max" });
    assert.equal(requests.at(-1)?.body?.tools?.[0]?.description, "lookup");

    await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "gpt-5.6-luna-native",
      messages: [{ role: "user", content: "hello" }]
    });
    assert.equal(requests.at(-1)?.url, "/openai/v1/chat/completions");

    await postJson(`${baseUrl}/v1/chat/completions`, {
      model: "test-chat",
      messages: [
        { role: "tool", tool_call_id: "orphan", content: "orphan" },
        { role: "user", content: "hello" }
      ]
    });
    assert.deepEqual(requests.at(-1)?.body?.messages, [{ role: "user", content: "hello" }]);

    const providerFailureResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PROXY_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "trigger-provider-failure" }]
      })
    });
    const providerFailure = await providerFailureResponse.json();
    assert.equal(providerFailureResponse.status, 502);
    assert.equal(providerFailure.code, "UPSTREAM_PROVIDER_RESPONSE_ERROR");
    assert.equal(providerFailure.upstreamCode, "model_failed");
    assert.equal(providerFailure.message, "model failed");

    const streamText = await postStream(`${baseUrl}/v1/chat/completions`, {
      model: "test-chat",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    });
    assert.match(streamText, /stream-ok/);
    assert.match(streamText, /data: \[DONE\]/);

    if (requests.length !== 8 || requests.some((request) => request.apiKey !== UPSTREAM_API_KEY)) {
      throw new Error(`unexpected upstream auth forwarding: ${JSON.stringify(requests)}`);
    }

    console.log("Route smoke tests passed");
  } catch (error) {
    console.error(output.join(""));
    throw error;
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    await closeServer(upstreamServer);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
