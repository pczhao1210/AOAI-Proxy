import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, reloadConfig, saveConfig, getConfigPath, getConfigRuntimeInfo } from "./config.js";
import { initAuth, verifyUpstreamAuth } from "./auth.js";
import { proxyRequest } from "./proxy.js";
import { getStats } from "./stats.js";
import { flushRuntimeEvents, getRuntimeStatsSnapshot } from "./runtime-store.js";
import { getDatabaseConnectionDefaults, testDatabaseConnection } from "./persistence.js";
import { writeCaddyfile, reloadCaddy, scheduleCaddyStartupProbe, getCaddyStatus, setCaddyStatus } from "./caddy.js";
import { configureUpstreamHttp } from "./http.js";
import { appendStructuredLog, createPinoCaptureStream, queryLogs, setLogConfig } from "./logs.js";
import { resolveApiConsumer, filterModelsForConsumer, getGovernanceSnapshot } from "./governance.js";
import { getPricingLibraryStatus, listPricingDefinitions, syncPricingDefinitionsFromGitHub } from "./pricing-library.js";
import { getRequestNetworkContext } from "./request-network.js";

// Fastify server entry
const defaultBodyLimit = 50 * 1024 * 1024;
const bodyLimitEnv = Number(process.env.BODY_LIMIT || process.env.SERVER_BODY_LIMIT);
const bodyLimit = Number.isFinite(bodyLimitEnv) && bodyLimitEnv > 0 ? bodyLimitEnv : defaultBodyLimit;

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "warn",
    stream: createPinoCaptureStream()
  },
  disableRequestLogging: true,
  bodyLimit
});

// Check if a request targets the admin area
function isAdminRoute(url, adminPath) {
  if (!url) return false;
  const normalized = (adminPath || "/admin").replace(/\/+$/, "");
  const pathOnly = url.split("?")[0];
  const normalizedUrl = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  return normalizedUrl === normalized || normalizedUrl.startsWith(`${normalized}/`);
}

// Extract API key from Authorization or x-api-key
function extractApiKey(config, headers) {
  const auth = headers.authorization || headers.Authorization;
  if (auth && typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }

  const configuredHeaderNames = Array.isArray(config?.access?.defaults?.keyHeaderNames)
    ? config.access.defaults.keyHeaderNames.filter((item) => typeof item === "string" && item.trim())
    : ["x-api-key"];
  for (const headerName of configuredHeaderNames) {
    const normalizedHeaderName = headerName.toLowerCase();
    if (normalizedHeaderName === "authorization") continue;
    const candidate = headers[normalizedHeaderName] || headers[headerName] || headers[headerName.toUpperCase()];
    if (candidate && typeof candidate === "string") {
      return candidate.trim();
    }
  }
  return null;
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

function buildModelList(config, consumer) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: filterModelsForConsumer(config.models, consumer).map((m) => ({
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
    source: "proxy",
    event: `startup.${stage}`,
    ...fields
  };
  appendStructuredLog("info", payload);
  try {
    console.log(JSON.stringify(payload));
  } catch {
    console.log(`[${payload.ts}] startup.${stage}`);
  }
}

function emitStartupError(stage, error, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    source: "proxy",
    event: `startup.${stage}`,
    message: error?.message || String(error),
    failureReason: error?.message || String(error),
    ...fields
  };
  appendStructuredLog("error", payload);
  try {
    console.error(JSON.stringify(payload));
  } catch {
    console.error(`[${payload.ts}] startup.${stage}: ${payload.message}`);
  }
}

function logAdminApiError(event, error, fields = {}) {
  const { status = 400, ...rest } = fields;
  const failureReason = error?.message || String(error);
  app.log.error({
    source: "admin",
    event,
    status,
    failureReason,
    err: error,
    ...rest
  }, failureReason);
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
  if (isAdminRoute(rawUrl, config.server.adminPath)) {
    if (!verifyAdminBasicAuth(config, req.headers)) {
      reply.header("WWW-Authenticate", 'Basic realm="AOAI Proxy Admin"');
      return reply.code(401).send({ error: "AdminUnauthorized" });
    }
    return;
  }
  const key = extractApiKey(config, req.headers);
  const consumerResult = resolveApiConsumer(config, key);
  if (!consumerResult.ok) {
    return reply.code(consumerResult.status || 401).send({ error: consumerResult.error || "Unauthorized", message: consumerResult.message || "Unauthorized" });
  }
  req.proxyAccess = { key, consumer: consumerResult.consumer };
});

app.addHook("onResponse", async (req, reply) => {
  const status = reply.statusCode;
  const level = status >= 400 ? "error" : "info";
  const config = getConfig();
  const networkContext = getRequestNetworkContext(config, req);
  const payload = {
    source: "http",
    event: "http.request_completed",
    requestId: req.id,
    method: req.method,
    url: req.raw?.url || req.url,
    status,
    latencyMs: Math.round(reply.elapsedTime || 0),
    ...networkContext
  };
  if (level === "info") {
    appendStructuredLog("info", payload);
    return;
  }
  req.log[level](payload, status >= 400 ? "request completed with error" : "request completed");
});

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/v1/models", async (req) => {
  const config = getConfig();
  return buildModelList(config, req.proxyAccess?.consumer);
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

app.get("/admin/api/config", async () => {
  const config = getConfig();
  return config;
});

app.put("/admin/api/config", async (req, reply) => {
  const nextConfig = req.body;
  try {
    const saved = await saveConfig(nextConfig);
    setLogConfig(saved);
    attachAuth(saved);
    void primeAuth(saved);
    writeCaddyfile(saved);
    await reloadCaddy(saved);
    app.log.info({ source: "admin", event: "admin.config_saved" }, "admin config saved");
    reply.send({ ok: true, config: saved });
  } catch (error) {
    logAdminApiError("admin.config_save_failed", error, { route: "/admin/api/config" });
    reply.code(400).send({ error: error.message });
  }
});

app.post("/admin/api/reload", async (req, reply) => {
  try {
    const config = await reloadConfig();
    setLogConfig(config);
    attachAuth(config);
    void primeAuth(config);
    writeCaddyfile(config);
    await reloadCaddy(config);
    app.log.info({ source: "admin", event: "admin.config_reloaded" }, "admin config reloaded");
    reply.send({ ok: true, config });
  } catch (error) {
    logAdminApiError("admin.config_reload_failed", error, { route: "/admin/api/reload" });
    reply.code(400).send({ error: error.message });
  }
});

app.post("/admin/api/verify-aad", async (req, reply) => {
  const config = getConfig();
  try {
    const result = await verifyUpstreamAuth(config.auth.scope);
    reply.send({ ok: true, mode: result.mode, preview: result.preview });
  } catch (error) {
    logAdminApiError("admin.verify_aad_failed", error, {
      route: "/admin/api/verify-aad",
      scope: config.auth.scope
    });
    reply.code(400).send({ ok: false, error: error.message });
  }
});

app.get("/admin/api/runtime", async () => {
  return { ok: true, runtime: getConfigRuntimeInfo() };
});

app.get("/admin/api/database/config", async () => {
  const config = getConfig();
  return { ok: true, config: getDatabaseConnectionDefaults(config) };
});

app.post("/admin/api/database/test", async (req, reply) => {
  const config = getConfig();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await testDatabaseConnection(body, config);
    reply.send({ ok: true, result });
  } catch (error) {
    logAdminApiError("admin.database_test_failed", error, {
      route: "/admin/api/database/test",
      provider: typeof body.provider === "string" ? body.provider : undefined,
      status: 400
    });
    reply.code(400).send({ ok: false, error: error.message || "Database connection test failed" });
  }
});

app.get("/admin/api/pricing-library", async () => {
  return {
    ok: true,
    items: listPricingDefinitions(),
    status: getPricingLibraryStatus()
  };
});

app.post("/admin/api/pricing-library/sync", async (req, reply) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const overrides = {
      owner: typeof body.owner === "string" ? body.owner : undefined,
      repo: typeof body.repo === "string" ? body.repo : undefined,
      path: typeof body.path === "string" ? body.path : undefined,
      ref: typeof body.ref === "string" ? body.ref : undefined
    };
    const result = await syncPricingDefinitionsFromGitHub(overrides);
    app.log.info({
      source: "admin",
      event: "admin.pricing_library_synced",
      syncedFiles: result.syncedFiles,
      definitionCount: result.status?.definitionCount || 0,
      activeSource: result.status?.activeSource || "persisted"
    }, "pricing library synced from GitHub");
    reply.send({ ok: true, ...result });
  } catch (error) {
    logAdminApiError("admin.pricing_library_sync_failed", error, {
      route: "/admin/api/pricing-library/sync",
      status: 502
    });
    reply.code(502).send({ ok: false, error: error.message });
  }
});

app.get("/admin/api/stats", async (req) => {
  const config = getConfig();
  const query = req.query || {};
  await flushRuntimeEvents();
  return {
    ...(await getRuntimeStatsSnapshot(config, getStats(), {
      keyId: typeof query.keyId === "string" ? query.keyId : "",
      timeRange: typeof query.timeRange === "string" ? query.timeRange : "all"
    })),
    governance: await getGovernanceSnapshot(config)
  };
});

app.get("/admin/api/logs", async (req) => {
  return queryLogs(req.query || {});
});

app.get("/admin/api/caddy/status", async () => {
  return { ok: true, status: getCaddyStatus() };
});

app.post("/admin/api/restart", async (req, reply) => {
  setCaddyStatus({ state: "restart-requested", message: "restart requested", lastError: null });
  app.log.warn({ source: "admin", event: "admin.restart_requested" }, "admin restart requested");
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
const adminAppRoot = path.resolve(publicRoot, "admin-app");
const adminAppAssetsRoot = path.resolve(adminAppRoot, "assets");
const hasBuiltAdminApp = fs.existsSync(adminAppRoot) && fs.existsSync(adminAppAssetsRoot);

if (hasBuiltAdminApp) {
  app.register(fastifyStatic, {
    root: adminAppAssetsRoot,
    prefix: "/admin/assets/",
    index: false
  });

  app.get("/admin", async (req, reply) => {
    return reply.redirect("/admin/");
  });

  app.get("/admin/", async (req, reply) => {
    return reply.sendFile("index.html", adminAppRoot);
  });

  app.get("/admin/*", async (req, reply) => {
    const requestPath = req.raw?.url?.split("?")[0] || req.url;
    if (requestPath.startsWith("/admin/api/")) {
      return reply.callNotFound();
    }
    if (requestPath.startsWith("/admin/legacy/")) {
      return reply.redirect("/admin/");
    }
    return reply.sendFile("index.html", adminAppRoot);
  });
} else {
  app.get("/admin", async (req, reply) => {
    return reply.redirect("/admin/");
  });

  app.get("/admin/", async (req, reply) => {
    return reply.code(503).type("text/plain; charset=utf-8").send("Admin UI is not built. Run npm run build:admin.");
  });
}

app.get("/admin/legacy", async (req, reply) => {
  return reply.redirect("/admin/");
});

app.get("/admin/legacy/", async (req, reply) => {
  return reply.redirect("/admin/");
});

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
  setLogConfig(config);
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
  app.log.info({ source: "proxy", configPath: getConfigPath() }, "config loaded");
}

start().catch((error) => {
  emitStartupError("fatal", error, { configPath: getConfigPath() });
  app.log.error(error);
  process.exit(1);
});
