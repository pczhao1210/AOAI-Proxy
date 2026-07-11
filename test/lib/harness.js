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

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function createMockUpstreamServer() {
  const requests = [];
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

    if (req.headers["api-key"] !== UPSTREAM_API_KEY) {
      jsonResponse(res, 401, { error: { message: "missing upstream api-key" } });
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}`);
    const pathname = url.pathname;

    if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
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

    if (req.method === "POST" && pathname.endsWith("/responses")) {
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
        usage: {
          input_tokens: 10,
          output_tokens: 6,
          total_tokens: 16
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
    }
  };
}

function buildTestConfig({ proxyPort, upstreamPort, configPath }) {
  return {
    version: 2,
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
          "images/generations": "/openai/v1/images/generations"
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

export function ensure(condition, message) {
  assert.ok(condition, message);
}

export async function createTestContext() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-proxy-route-test-"));
  const proxyPort = await getFreePort();
  const upstreamPort = await getFreePort();
  const configPath = path.join(tempDir, "config.json");
  const proxyBaseUrl = `http://${HOST}:${proxyPort}`;

  const upstream = createMockUpstreamServer();
  upstream.server.listen(upstreamPort, HOST);
  await once(upstream.server, "listening");

  const config = buildTestConfig({ proxyPort, upstreamPort, configPath });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const output = { stdout: [], stderr: [] };
  const childProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."),
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      LOG_LEVEL: "error"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  childProcess.stdout.on("data", (chunk) => {
    output.stdout.push(String(chunk));
  });
  childProcess.stderr.on("data", (chunk) => {
    output.stderr.push(String(chunk));
  });

  await waitForServerReady(proxyBaseUrl, DEFAULT_TIMEOUT_MS, childProcess, output);

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
      redirect = "follow"
    } = options;
    const response = await fetch(`${proxyBaseUrl}${routePath}`, {
      method,
      headers: {
        ...headers,
        ...(json !== undefined ? { "content-type": "application/json" } : {})
      },
      body: json !== undefined ? JSON.stringify(json) : body,
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
      await stopChildProcess(childProcess);
      upstream.closeConnections();
      await new Promise((resolve, reject) => {
        upstream.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };

  return ctx;
}

export async function withTestContext(run) {
  const ctx = await createTestContext();
  try {
    await run(ctx);
  } finally {
    await ctx.cleanup();
  }
}