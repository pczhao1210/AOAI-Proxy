import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PROXY_API_KEY = "test-proxy-key";
const UPSTREAM_API_KEY = "test-upstream-key";
const CLIENT_SECRET = "test-client-secret";
const ADMIN_PASSWORD = "test-admin-password";
const REDACTED_SECRET_VALUE = "__AOAI_PROXY_REDACTED__";

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

      if (req.url === "/openai/v1/responses") {
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
      adminPath: "/admin",
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

    const adminConfig = await requestJson(`${baseUrl}/admin/api/config`);
    assert.equal(adminConfig.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.auth.clientSecret, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.server.adminAuth.password, REDACTED_SECRET_VALUE);
    assert.equal(adminConfig.apiKeys[0].key, REDACTED_SECRET_VALUE);
    const adminConfigText = JSON.stringify(adminConfig);
    for (const secret of [UPSTREAM_API_KEY, CLIENT_SECRET, ADMIN_PASSWORD, PROXY_API_KEY]) {
      assert.equal(adminConfigText.includes(secret), false, `admin config exposed ${secret}`);
    }

    adminConfig.server.trustProxy = true;
    const saveResult = await requestJson(`${baseUrl}/admin/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adminConfig)
    });
    assert.equal(saveResult.ok, true);
    assert.equal(saveResult.config.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(saveResult.config.apiKeys[0].key, REDACTED_SECRET_VALUE);

    const persistedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(persistedConfig.auth.apiKey, UPSTREAM_API_KEY);
    assert.equal(persistedConfig.auth.clientSecret, CLIENT_SECRET);
    assert.equal(persistedConfig.server.adminAuth.password, ADMIN_PASSWORD);
    assert.equal(persistedConfig.apiKeys[0].key, PROXY_API_KEY);
    assert.equal(persistedConfig.server.trustProxy, true);

    const reloadResult = await requestJson(`${baseUrl}/admin/api/reload`, { method: "POST" });
    assert.equal(reloadResult.ok, true);
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

    if (requests.length !== 2 || requests.some((request) => request.apiKey !== UPSTREAM_API_KEY)) {
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
