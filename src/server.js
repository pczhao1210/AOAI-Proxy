import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, reloadConfig, saveConfig, getConfigPath, getConfigRuntimeInfo } from "./config.js";
import { initAuth, verifyUpstreamAuth } from "./auth.js";
import { proxyRequest } from "./proxy.js";
import { getStats } from "./stats.js";
import { writeCaddyfile, reloadCaddy, scheduleCaddyStartupProbe, getCaddyStatus, setCaddyStatus } from "./caddy.js";
import { configureUpstreamHttp } from "./http.js";
import { redactConfigSecrets, restoreConfigSecrets } from "./admin-config.js";

// Fastify server entry
const defaultBodyLimit = 50 * 1024 * 1024;
const bodyLimitEnv = Number(process.env.BODY_LIMIT || process.env.SERVER_BODY_LIMIT);
const bodyLimit = Number.isFinite(bodyLimitEnv) && bodyLimitEnv > 0 ? bodyLimitEnv : defaultBodyLimit;

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "warn"
  },
  bodyLimit
});

let activeAdminPath = "/admin";

function normalizeAdminPath(adminPath) {
  const normalized = `/${String(adminPath || "/admin").replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/admin" : normalized;
}

// Check if a request targets the admin area
function isAdminRoute(url, adminPath) {
  if (!url) return false;
  const normalized = (adminPath || "/admin").replace(/\/+$/, "");
  const pathOnly = url.split("?")[0];
  const normalizedUrl = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  return normalizedUrl === normalized || normalizedUrl.startsWith(`${normalized}/`);
}

// Extract API key from Authorization or x-api-key
function extractApiKey(headers) {
  const auth = headers.authorization || headers.Authorization;
  if (auth && typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = headers["x-api-key"] || headers["X-API-Key"]; 
  if (xApiKey && typeof xApiKey === "string") {
    return xApiKey.trim();
  }
  return null;
}

// Validate API key against active keys
function verifyApiKey(config, key) {
  if (!key) return false;
  const activeKeys = config.apiKeys.filter((k) => k.status !== "disabled");
  return activeKeys.some((k) => k.key === key);
}

function secureEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBasicAuthHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  if (!headerValue.toLowerCase().startsWith("basic ")) return null;
  const b64 = headerValue.slice(6).trim();
  if (!b64) return null;
  let decoded;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1)
  };
}

// Validate admin Basic Auth when enabled
function verifyAdminBasicAuth(config, headers) {
  const authCfg = config?.server?.adminAuth;
  if (!authCfg?.enabled) return true;
  const username = authCfg.username;
  const password = authCfg.password;
  if (!username || !password) return false;

  const header = headers.authorization || headers.Authorization;
  const parsed = parseBasicAuthHeader(header);
  if (!parsed) return false;
  return secureEqual(parsed.username, username) && secureEqual(parsed.password, password);
}

function buildModelList(config) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: config.models.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "proxy"
    }))
  };
}

function attachAuth(config) {
  initAuth(config);
}

async function primeAuth(config) {
  try {
    const result = await verifyUpstreamAuth(config.auth.scope);
    emitStartupLog("auth_warm", { mode: result.mode, scope: config.auth.scope });
  } catch (error) {
    emitStartupError("auth_warm_failed", error, { scope: config.auth.scope });
  }
}

function emitStartupLog(stage, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event: `startup.${stage}`,
    ...fields
  };
  try {
    console.log(JSON.stringify(payload));
  } catch {
    console.log(`[${payload.ts}] startup.${stage}`);
  }
}

function emitStartupError(stage, error, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event: `startup.${stage}`,
    message: error?.message || String(error),
    ...fields
  };
  try {
    console.error(JSON.stringify(payload));
  } catch {
    console.error(`[${payload.ts}] startup.${stage}: ${payload.message}`);
  }
}

app.addHook("preHandler", async (req, reply) => {
  const config = getConfig();
  const rawUrl = req.raw?.url || req.url;
  const pathOnly = (rawUrl || "").split("?")[0];
  if (pathOnly === "/healthz") {
    return;
  }
  if (pathOnly === "/favicon.ico") {
    return reply.code(204).send();
  }
  if (isAdminRoute(rawUrl, activeAdminPath)) {
    if (!verifyAdminBasicAuth(config, req.headers)) {
      reply.header("WWW-Authenticate", 'Basic realm="AOAI Proxy Admin"');
      return reply.code(401).send({ error: "AdminUnauthorized" });
    }
    return;
  }
  const key = extractApiKey(req.headers);
  if (!verifyApiKey(config, key)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/v1/models", async () => {
  const config = getConfig();
  return buildModelList(config);
});

app.post("/v1/chat/completions", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "chat/completions", req, reply });
});

app.post("/v1/responses", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "responses", req, reply });
});

app.post("/v1/images/generations", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "images/generations", req, reply });
});

function registerAdminRoutes(adminPath) {
  activeAdminPath = normalizeAdminPath(adminPath);
  const adminRoute = (suffix = "") => `${activeAdminPath}${suffix}`;

app.get(adminRoute("/api/config"), async () => {
  const config = getConfig();
  return redactConfigSecrets(config);
});

app.put(adminRoute("/api/config"), async (req, reply) => {
  const nextConfig = restoreConfigSecrets(req.body, getConfig());
  try {
    const saved = await saveConfig(nextConfig);
    const upstreamHttp = configureUpstreamHttp(saved);
    attachAuth(saved);
    void primeAuth(saved);
    writeCaddyfile(saved);
    await reloadCaddy(saved);
    reply.send({
      ok: true,
      config: redactConfigSecrets(saved),
      upstreamHttp,
      restartRequired: normalizeAdminPath(saved.server.adminPath) !== activeAdminPath
    });
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.post(adminRoute("/api/reload"), async (req, reply) => {
  try {
    const config = await reloadConfig();
    const upstreamHttp = configureUpstreamHttp(config);
    attachAuth(config);
    void primeAuth(config);
    writeCaddyfile(config);
    await reloadCaddy(config);
    reply.send({
      ok: true,
      config: redactConfigSecrets(config),
      upstreamHttp,
      restartRequired: normalizeAdminPath(config.server.adminPath) !== activeAdminPath
    });
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.post(adminRoute("/api/verify-aad"), async (req, reply) => {
  const config = getConfig();
  try {
    const result = await verifyUpstreamAuth(config.auth.scope);
    reply.send({ ok: true, mode: result.mode, preview: result.preview, tokenPreview: result.preview });
  } catch (error) {
    reply.code(400).send({ ok: false, error: error.message });
  }
});

app.get(adminRoute("/api/runtime"), async () => {
  return { ok: true, runtime: getConfigRuntimeInfo() };
});

app.get(adminRoute("/api/stats"), async () => {
  return getStats();
});

app.get(adminRoute("/api/caddy/status"), async () => {
  return { ok: true, status: getCaddyStatus() };
});

app.post(adminRoute("/api/restart"), async (req, reply) => {
  setCaddyStatus({ state: "restart-requested", message: "restart requested", lastError: null });
  reply.send({ ok: true });
  setTimeout(() => {
    try {
      process.kill(1, "SIGTERM");
    } catch {
      process.exit(0);
    }
  }, 500);
});

const publicRoot = path.resolve(process.cwd(), "public");
app.register(fastifyStatic, {
  root: publicRoot,
  prefix: `${activeAdminPath}/`,
  index: "index.html"
});

app.get(activeAdminPath, async (req, reply) => {
  reply.redirect(`${activeAdminPath}/`);
});
}

async function start() {
  emitStartupLog("init", {
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    configPath: getConfigPath(),
    bodyLimit,
    logLevel: process.env.LOG_LEVEL || "warn"
  });
  const config = await reloadConfig();
  registerAdminRoutes(config.server.adminPath);
  const upstreamHttp = configureUpstreamHttp(config);
  attachAuth(config);
  await primeAuth(config);
  const caddyfileWrite = writeCaddyfile(config);
  const caddyReload = config.server?.caddy?.enabled
    ? scheduleCaddyStartupProbe(config)
    : await reloadCaddy(config);
  const { host, port } = config.server;
  emitStartupLog("config_loaded", {
    host,
    port,
    adminPath: config.server?.adminPath,
    adminAuthEnabled: !!config.server?.adminAuth?.enabled,
    caddyEnabled: !!config.server?.caddy?.enabled,
    trustProxy: config.server?.trustProxy === true,
    models: Array.isArray(config.models) ? config.models.length : 0,
    upstreams: Array.isArray(config.upstreams) ? config.upstreams.length : 0,
    upstreamHttp,
    caddyfileWrite,
    caddyReload
  });
  await app.listen({ host, port });
  emitStartupLog("ready", {
    host,
    port
  });
  app.log.info({ configPath: getConfigPath() }, "config loaded");
}

start().catch((error) => {
  emitStartupError("fatal", error, { configPath: getConfigPath() });
  app.log.error(error);
  process.exit(1);
});
