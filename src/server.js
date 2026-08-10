import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, getPersistedConfig, reloadConfig, saveConfig, getConfigPath, getConfigRuntimeInfo } from "./config.js";
import { initAuth, verifyUpstreamAuth } from "./auth.js";
import { proxyRequest } from "./proxy.js";
import { getStats } from "./stats.js";
import { flushRuntimeEvents, getRuntimeStatsSnapshot } from "./runtime-store.js";
import { getDatabaseConnectionDefaults, syncPersistenceState, testDatabaseConnection } from "./persistence.js";
import { writeCaddyfile, reloadCaddy, scheduleCaddyStartupProbe, getCaddyStatus, setCaddyStatus } from "./caddy.js";
import { configureUpstreamHttp } from "./http.js";
import { appendStructuredLog, createPinoCaptureStream, flushLogAnalyticsSink, queryLogs, setLogConfig } from "./logs.js";
import { validateConfiguredModels } from "./model-validation.js";
import { resolveApiConsumer, filterModelsForConsumer, getGovernanceSnapshot } from "./governance.js";
import { getPricingLibraryStatus, listPricingDefinitions, syncPricingDefinitionsFromGitHub } from "./pricing-library.js";
import { getRequestNetworkContext } from "./request-network.js";
import { attachRequestContext, getRequestContext } from "./request-context.js";
import { closeSharedPostgresPools } from "./postgres.js";
import { redactConfigSecrets, restoreConfigSecrets } from "./admin-config.js";
import { initializeLogAnalytics } from "./log-analytics-admin.js";
import { getBuildInfo } from "./build-info.js";
import {
  buildDirectUpstreamUrl,
  buildUpstreamUrl,
  findUpstream,
  inferBackendRouteKey,
  isPublicRouteEnabled,
  normalizeBackendRouteKey,
  reconcileBackendRouteKey,
  resolveEffectiveRouteKey,
  resolveModelRoute
} from "./proxy/routing.js";

const { LogController } = fastify;

// Fastify server entry
const defaultBodyLimit = 50 * 1024 * 1024;
const bodyLimitEnv = Number(process.env.BODY_LIMIT || process.env.SERVER_BODY_LIMIT);
const bodyLimit = Number.isFinite(bodyLimitEnv) && bodyLimitEnv > 0 ? bodyLimitEnv : defaultBodyLimit;
const STATIC_ADMIN_PATH = "/admin";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;

let shutdownPromise = null;
let logAnalyticsInitializationPromise = null;

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    stream: createPinoCaptureStream()
  },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit,
  rewriteUrl: (req) => rewriteAdminUrl(req.url)
});

function normalizeAdminPath(adminPath) {
  const text = typeof adminPath === "string" ? adminPath.trim() : "";
  const withLeadingSlash = text.startsWith("/") ? text : `/${text}`;
  const normalized = withLeadingSlash.replace(/\/+$/, "");
  return normalized && normalized !== "/" ? normalized : STATIC_ADMIN_PATH;
}

function getConfiguredAdminPath() {
  try {
    return normalizeAdminPath(getConfig()?.server?.adminPath);
  } catch {
    return STATIC_ADMIN_PATH;
  }
}

function rewriteAdminUrl(url) {
  if (!url || typeof url !== "string") return url;
  const configuredAdminPath = getConfiguredAdminPath();
  if (configuredAdminPath === STATIC_ADMIN_PATH) return url;

  const queryStart = url.indexOf("?");
  const pathOnly = queryStart >= 0 ? url.slice(0, queryStart) : url;
  const query = queryStart >= 0 ? url.slice(queryStart) : "";
  const normalizedUrl = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  if (normalizedUrl !== configuredAdminPath && !normalizedUrl.startsWith(`${configuredAdminPath}/`)) {
    return url;
  }
  return `${STATIC_ADMIN_PATH}${normalizedUrl.slice(configuredAdminPath.length)}${query}`;
}

// Check if a request targets the admin area
function isAdminRoute(url, adminPath) {
  if (!url) return false;
  const adminPaths = new Set([STATIC_ADMIN_PATH, normalizeAdminPath(adminPath)]);
  const pathOnly = url.split("?")[0];
  const normalizedUrl = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  for (const normalized of adminPaths) {
    if (normalizedUrl === normalized || normalizedUrl.startsWith(`${normalized}/`)) {
      return true;
    }
  }
  return false;
}

function shouldSkipSuccessfulAccessLog(url, method, status, adminPath) {
  if (status >= 400) return false;
  const pathOnly = String(url || "").split("?")[0];
  if (pathOnly === "/healthz" || pathOnly === "/version" || pathOnly === "/favicon.ico") return true;
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "").toUpperCase())
    && isAdminRoute(url, adminPath);
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

function normalizeIp(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.startsWith("::ffff:")) return text.slice(7);
  return text;
}

function verifyAdminIpAccess(config, req) {
  const allowedIps = Array.isArray(config?.admin?.security?.allowedIps)
    ? config.admin.security.allowedIps.map(normalizeIp).filter(Boolean)
    : [];
  if (!allowedIps.length) return true;
  const networkContext = getRequestNetworkContext(config, req);
  const clientIp = normalizeIp(networkContext.clientIp);
  return allowedIps.includes(clientIp);
}

function verifyAdminCsrf(config, req) {
  if (config?.admin?.security?.csrfProtection !== true) return true;
  if (!UNSAFE_METHODS.has(String(req.method || "").toUpperCase())) return true;
  const header = req.headers["x-aoai-admin-csrf"];
  return typeof header === "string" && header.trim() === "1";
}

function getPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
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

function modelUsesNativeProtocol(config, model, routeKey) {
  if (!isPublicRouteEnabled(config, routeKey)) return false;
  const upstream = findUpstream(config, model?.upstream);
  if (!upstream || String(model?.targetModel || model?.id || "").trim().toLowerCase() === "model-router") {
    return false;
  }
  const override = resolveModelRoute(model, routeKey);
  const effectiveRouteKey = resolveEffectiveRouteKey(routeKey, model, upstream, override);
  const backendRouteKey = override
    ? inferBackendRouteKey(routeKey, override)
    : normalizeBackendRouteKey(effectiveRouteKey);
  if (backendRouteKey !== routeKey) return false;
  const deployment = String(model?.targetModel || model?.id || "").trim();
  try {
    const targetUrl = override?.type === "path"
      ? buildDirectUpstreamUrl(upstream, override.value, deployment, model)
      : buildUpstreamUrl(upstream, effectiveRouteKey, deployment, model);
    return reconcileBackendRouteKey(backendRouteKey, targetUrl) === routeKey;
  } catch {
    return false;
  }
}

function buildAnthropicModelList(config, consumer, { claudeCodeOnly = false } = {}) {
  const createdAt = new Date().toISOString();
  const data = filterModelsForConsumer(config.models, consumer)
    .filter((model) => (
      !claudeCodeOnly
      || (model?.clientCompatibility?.claudeCode === true && modelUsesNativeProtocol(config, model, "messages"))
    ))
    .map((model) => ({
      type: "model",
      id: model.id,
      display_name: model.displayName || model.id,
      created_at: createdAt
    }));
  return {
    data,
    has_more: false,
    ...(data.length ? { first_id: data[0].id, last_id: data.at(-1).id } : {})
  };
}

const CODEX_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CODEX_REASONING_DESCRIPTIONS = {
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems"
};

function normalizeCapabilitySet(model) {
  return new Set(
    (Array.isArray(model?.capabilities) ? model.capabilities : [])
      .filter((value) => typeof value === "string")
      .map((value) => value.trim().toLowerCase().replaceAll("_", "-"))
      .filter(Boolean)
  );
}

function modelUsesNativeResponses(config, model) {
  if (model?.clientCompatibility?.codex !== true) {
    return false;
  }
  const capabilities = normalizeCapabilitySet(model);
  const modelId = String(model?.id || "").trim().toLowerCase();
  if (
    capabilities.has("image-generation")
    || capabilities.has("image-editing")
    || modelId.startsWith("gpt-image-")
    || modelId.startsWith("flux-")
  ) {
    return false;
  }
  return modelUsesNativeProtocol(config, model, "responses");
}

function getCodexReasoningEfforts(model, capabilities) {
  const configured = Array.isArray(model?.codex?.supportedReasoningEfforts)
    ? model.codex.supportedReasoningEfforts
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => CODEX_REASONING_EFFORTS.has(value))
    : [];
  if (configured.length) return [...new Set(configured)];
  const modelId = String(model?.id || "").trim().toLowerCase();
  const supportsReasoning = capabilities.has("reasoning") || /^gpt-(?:[5-9]|\d{2,})(?:$|[.-])/.test(modelId) || /^o\d(?:$|[.-])/.test(modelId);
  if (!supportsReasoning) return [];
  return /^gpt-5\.6(?:$|[.-])/.test(modelId)
    ? ["low", "medium", "high", "xhigh", "max"]
    : ["low", "medium", "high"];
}

function buildCodexModelInfo(model, index) {
  const capabilities = normalizeCapabilitySet(model);
  const reasoningEfforts = getCodexReasoningEfforts(model, capabilities);
  const configuredDefaultEffort = String(model?.codex?.defaultReasoningEffort || "").trim().toLowerCase();
  const defaultReasoningEffort = reasoningEfforts.includes(configuredDefaultEffort)
    ? configuredDefaultEffort
    : (reasoningEfforts.includes("medium") ? "medium" : reasoningEfforts[0] || "medium");
  const configuredContextWindow = Number(model?.codex?.contextWindow ?? model?.contextWindow);
  const contextWindow = Number.isInteger(configuredContextWindow) && configuredContextWindow > 0
    ? configuredContextWindow
    : 128000;
  const supportsVision = capabilities.has("vision");
  const supportsWebSearch = capabilities.has("web-search");
  const codeOptimized = capabilities.has("code-optimized");

  return {
    slug: model.id,
    display_name: model.displayName || model.id,
    description: model?.codex?.description || `${model.displayName || model.id} via AOAI Proxy`,
    default_reasoning_level: defaultReasoningEffort,
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({
      effort,
      description: CODEX_REASONING_DESCRIPTIONS[effort]
    })),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: Number.isInteger(model?.codex?.priority) ? model.codex.priority : index,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: codeOptimized ? "freeform" : null,
    web_search_tool_type: supportsVision && supportsWebSearch ? "text_and_image" : "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: capabilities.has("parallel-tool-calling"),
    supports_image_detail_original: supportsVision,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: supportsVision ? ["text", "image"] : ["text"],
    supports_search_tool: supportsWebSearch,
    use_responses_lite: false
  };
}

function buildCodexModelList(config, consumer) {
  return {
    models: filterModelsForConsumer(config.models, consumer)
      .filter((model) => modelUsesNativeResponses(config, model))
      .map(buildCodexModelInfo)
  };
}

function wantsCodexModelList(req, config) {
  if (config?.compatibility?.codex?.enabled === false) return false;
  const format = String(req.query?.format || "").trim().toLowerCase();
  if (["codex", "codex_cli", "codex-cli"].includes(format)) return true;
  return String(req.headers["user-agent"] || "").toLowerCase().includes("codex");
}

function wantsClaudeCodeModelList(req, config) {
  if (config?.compatibility?.claudeCode?.enabled === false) return false;
  const format = String(req.query?.format || "").trim().toLowerCase();
  if (["claude-code", "claude_code", "claude-cli"].includes(format)) return true;
  const userAgent = String(req.headers["user-agent"] || "").toLowerCase();
  return userAgent.includes("claude-code")
    || userAgent.includes("claude_cli")
    || userAgent.includes("claude-cli");
}

function wantsAnthropicModelList(req) {
  const format = String(req.query?.format || "").trim().toLowerCase();
  if (["anthropic", "messages", "anthropic_messages"].includes(format)) return true;
  if (String(req.headers["anthropic-version"] || "").trim()) return true;
  const userAgent = String(req.headers["user-agent"] || "").toLowerCase();
  return userAgent.includes("claude") || userAgent.includes("anthropic");
}

function attachAuth(config) {
  initAuth(config);
}

function applyLogConfig(config) {
  setLogConfig(config);
  if (process.env.LOG_LEVEL) return;
  const configuredLevel = String(config?.observability?.logs?.level || "info").trim().toLowerCase();
  if (["trace", "debug", "info", "warn", "error", "fatal", "silent"].includes(configuredLevel)) {
    app.log.level = configuredLevel;
  }
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
  const shutdownAudit = stage.startsWith("shutdown_");
  appendStructuredLog("info", payload, {
    bypassLevel: shutdownAudit,
    forceConsole: shutdownAudit
  });
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
  const shutdownAudit = stage.startsWith("shutdown_");
  appendStructuredLog("error", payload, { forceConsole: shutdownAudit });
}

function resolveShutdownTimeoutMs() {
  const environmentValue = Number(process.env.SHUTDOWN_TIMEOUT_MS);
  if (Number.isInteger(environmentValue) && environmentValue > 0) {
    return environmentValue;
  }
  try {
    const configuredValue = Number(getConfig()?.server?.gracefulShutdownMs);
    if (Number.isInteger(configuredValue) && configuredValue > 0) {
      return configuredValue;
    }
  } catch {
  }
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

async function drainRuntimeState() {
  try {
    await flushRuntimeEvents();
  } finally {
    await closeSharedPostgresPools();
  }
}

function shutdown(reason, exitCode) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  const timeoutMs = resolveShutdownTimeoutMs();
  shutdownPromise = (async () => {
    emitStartupLog("shutdown_started", { reason, exitCode, timeoutMs });
    const forceExitTimer = setTimeout(() => {
      emitStartupError("shutdown_timeout", new Error(`Shutdown exceeded ${timeoutMs} ms`), {
        reason,
        exitCode: 1,
        timeoutMs
      });
      process.exit(1);
    }, timeoutMs);

    const httpResults = await Promise.allSettled([app.close()]);
    const resourceResults = await Promise.allSettled([
      drainRuntimeState(),
      flushLogAnalyticsSink({ force: true })
    ]);
    const results = [...httpResults, ...resourceResults];
    clearTimeout(forceExitTimer);

    const failures = results
      .map((result, index) => ({ result, component: ["http", "runtime", "logs"][index] }))
      .filter(({ result }) => result.status === "rejected");
    for (const { result, component } of failures) {
      emitStartupError("shutdown_component_failed", result.reason, { reason, component });
    }

    emitStartupLog("shutdown_complete", {
      reason,
      exitCode,
      failedComponents: failures.map(({ component }) => component)
    });
    process.exit(exitCode);
  })();

  return shutdownPromise;
}

function requestShutdown(reason, exitCode) {
  void shutdown(reason, exitCode);
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

app.addHook("onRequest", async (req) => {
  attachRequestContext(req);
});

app.addHook("preHandler", async (req, reply) => {
  const config = getConfig();
  const rawUrl = req.raw?.url || req.url;
  const pathOnly = (rawUrl || "").split("?")[0];
  if (pathOnly === "/healthz" || pathOnly === "/version") {
    return;
  }
  if (pathOnly === "/favicon.ico") {
    return reply.code(204).send();
  }
  if (isAdminRoute(rawUrl, config.server.adminPath)) {
    if (!verifyAdminIpAccess(config, req)) {
      return reply.code(403).send({ error: "AdminForbidden", message: "Admin access is not allowed from this IP address" });
    }
    if (!verifyAdminBasicAuth(config, req.headers)) {
      reply.header("WWW-Authenticate", 'Basic realm="AOAI Proxy Admin"');
      return reply.code(401).send({ error: "AdminUnauthorized" });
    }
    if (!verifyAdminCsrf(config, req)) {
      return reply.code(403).send({ error: "AdminCsrfRejected", message: "Missing admin CSRF header" });
    }
    return;
  }
  const maxRequestBodyBytes = getPositiveInteger(config?.proxy?.guards?.maxRequestBodyBytes);
  const contentLength = Number(req.headers["content-length"]);
  if (maxRequestBodyBytes > 0 && Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
    return reply.code(413).send({ error: "PayloadTooLarge", message: `Request body exceeds ${maxRequestBodyBytes} bytes` });
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
  const config = getConfig();
  const rawUrl = req.raw?.url || req.url;
  if (shouldSkipSuccessfulAccessLog(rawUrl, req.method, status, config.server.adminPath)) {
    return;
  }

  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const networkContext = getRequestNetworkContext(config, req);
  const payload = {
    source: isAdminRoute(rawUrl, config.server.adminPath) ? "http.admin" : "http",
    event: "http.request_completed",
    message: status >= 400 ? "request completed with error" : "request completed",
    ...getRequestContext(req),
    method: req.method,
    url: rawUrl,
    status,
    latencyMs: Math.round(reply.elapsedTime || 0),
    ...networkContext
  };
  if (level === "info") {
    appendStructuredLog("info", payload);
    return;
  }
  req.log[level](payload, payload.message);
});

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/version", async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  return getBuildInfo();
});

app.get("/v1/models", async (req) => {
  const config = getConfig();
  if (wantsCodexModelList(req, config)) {
    return buildCodexModelList(config, req.proxyAccess?.consumer);
  }
  if (wantsClaudeCodeModelList(req, config)) {
    return buildAnthropicModelList(config, req.proxyAccess?.consumer, { claudeCodeOnly: true });
  }
  return wantsAnthropicModelList(req)
    ? buildAnthropicModelList(config, req.proxyAccess?.consumer)
    : buildModelList(config, req.proxyAccess?.consumer);
});

app.post("/v1/chat/completions", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "chat/completions", req, reply });
});

app.post("/v1/responses", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "responses", req, reply });
});

app.post("/v1/messages", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "messages", req, reply });
});

app.post("/v1/images/generations", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "images/generations", req, reply });
});

app.get("/admin/api/config", async () => {
  const config = getConfig();
  return redactConfigSecrets(config);
});

app.post("/admin/api/keys/reveal", async (req, reply) => {
  reply.header("Cache-Control", "no-store, private");
  reply.header("Pragma", "no-cache");

  const config = getConfig();
  const keyId = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  if (!keyId || keyId.length > 256) {
    return reply.code(400).send({ error: "ApiKeyIdRequired", message: "A valid API key ID is required" });
  }

  const apiKey = (Array.isArray(config.apiKeys) ? config.apiKeys : [])
    .find((candidate) => candidate?.id === keyId);
  if (!apiKey || typeof apiKey.key !== "string" || !apiKey.key) {
    return reply.code(404).send({ error: "ApiKeyNotFound", message: "API key was not found" });
  }

  appendStructuredLog("info", {
    source: "admin",
    event: "admin.api_key_secret_accessed",
    message: "API key copied by administrator",
    requestId: req.id,
    keyRecordId: apiKey.id,
    ...getRequestNetworkContext(config, req)
  });
  return reply.send({ ok: true, id: apiKey.id, key: apiKey.key });
});

app.put("/admin/api/config", async (req, reply) => {
  const nextConfig = restoreConfigSecrets(req.body, getPersistedConfig());
  try {
    const saved = await saveConfig(nextConfig);
    applyLogConfig(saved);
    configureUpstreamHttp(saved);
    attachAuth(saved);
    void primeAuth(saved);
    writeCaddyfile(saved);
    await reloadCaddy(saved);
    app.log.info({ source: "admin", event: "admin.config_saved" }, "admin config saved");
    reply.send({ ok: true, config: redactConfigSecrets(saved) });
  } catch (error) {
    logAdminApiError("admin.config_save_failed", error, { route: "/admin/api/config" });
    reply.code(400).send({ error: error.message });
  }
});

app.post("/admin/api/reload", async (req, reply) => {
  try {
    const config = await reloadConfig();
    applyLogConfig(config);
    configureUpstreamHttp(config);
    attachAuth(config);
    void primeAuth(config);
    writeCaddyfile(config);
    await reloadCaddy(config);
    app.log.info({ source: "admin", event: "admin.config_reloaded" }, "admin config reloaded");
    reply.send({ ok: true, config: redactConfigSecrets(config) });
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

app.post("/admin/api/runtime/sync", async (req, reply) => {
  const config = getConfig();
  try {
    const persistence = await syncPersistenceState(config);
    const runtimeStore = await flushRuntimeEvents();
    reply.send({
      ok: true,
      persistence,
      runtimeStore,
      runtime: getConfigRuntimeInfo()
    });
  } catch (error) {
    logAdminApiError("admin.runtime_sync_failed", error, {
      route: "/admin/api/runtime/sync",
      status: 502
    });
    reply.code(502).send({ ok: false, error: error.message || "Runtime sync failed" });
  }
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

app.post("/admin/api/log-analytics/initialize", async (req, reply) => {
  if (logAnalyticsInitializationPromise) {
    return reply.code(409).send({
      ok: false,
      status: "busy",
      error: { code: "LOG_ANALYTICS_INITIALIZATION_BUSY", message: "Log Analytics initialization is already running" }
    });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  logAnalyticsInitializationPromise = initializeLogAnalytics({
    workspaceResourceId: body.workspaceResourceId,
    dataCollectionEndpointResourceId: body.dataCollectionEndpointResourceId,
    dataCollectionRuleName: body.dataCollectionRuleName,
    tableName: body.tableName,
    streamName: body.streamName,
    audience: body.audience,
    credentialRef: body.credentialRef
  });
  try {
    const result = await logAnalyticsInitializationPromise;
    appendStructuredLog(result.ok ? "info" : "warn", {
      source: "admin",
      event: result.ok ? "admin.log_analytics_initialized" : "admin.log_analytics_initialization_failed",
      message: result.ok ? "Log Analytics initialized and tested" : "Log Analytics initialization did not complete",
      ...getRequestContext(req),
      status: result.ok ? 200 : result.error?.statusCode || 400,
      initializationStatus: result.status,
      probeRequestId: result.probe?.requestId || "",
      errorCode: result.error?.code || "",
      failureReason: result.error?.message || ""
    });
    if (result.ok || result.status === "needs_ingestion_permission" || result.status === "probe_failed") {
      return reply.send(result);
    }
    const requestedStatus = Number(result.error?.statusCode) || 500;
    const status = [400, 401, 403, 404, 409, 429].includes(requestedStatus) ? requestedStatus : 502;
    return reply.code(status).send(result);
  } finally {
    logAnalyticsInitializationPromise = null;
  }
});

app.get("/admin/api/pricing-library", async () => {
  return {
    ok: true,
    items: listPricingDefinitions(),
    status: getPricingLibraryStatus()
  };
});

app.post("/admin/api/models/validate", async (req, reply) => {
  const config = getConfig();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await validateConfiguredModels(config, {
      probe: body.probe !== false
    });
    reply.send(result);
  } catch (error) {
    logAdminApiError("admin.model_validation_failed", error, {
      route: "/admin/api/models/validate",
      status: 502
    });
    reply.code(502).send({ ok: false, error: error.message || "Model validation failed" });
  }
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
    return reply.redirect(`${getConfiguredAdminPath()}/`);
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
      return reply.redirect(`${getConfiguredAdminPath()}/`);
    }
    return reply.sendFile("index.html", adminAppRoot);
  });
} else {
  app.get("/admin", async (req, reply) => {
    return reply.redirect(`${getConfiguredAdminPath()}/`);
  });

  app.get("/admin/", async (req, reply) => {
    return reply.code(503).type("text/plain; charset=utf-8").send("Admin UI is not built. Run npm run build:admin.");
  });
}

app.get("/admin/legacy", async (req, reply) => {
  return reply.redirect(`${getConfiguredAdminPath()}/`);
});

app.get("/admin/legacy/", async (req, reply) => {
  return reply.redirect(`${getConfiguredAdminPath()}/`);
});

async function start() {
  emitStartupLog("init", {
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    configPath: getConfigPath(),
    bodyLimit,
    logLevel: process.env.LOG_LEVEL || "info"
  });
  const config = await reloadConfig();
  applyLogConfig(config);
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

process.once("SIGTERM", () => requestShutdown("SIGTERM", 0));
process.once("SIGINT", () => requestShutdown("SIGINT", 0));
process.once("uncaughtException", (error) => {
  emitStartupError("uncaught_exception", error);
  requestShutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  emitStartupError("unhandled_rejection", error);
  requestShutdown("unhandledRejection", 1);
});

start().catch((error) => {
  emitStartupError("fatal", error, { configPath: getConfigPath() });
  app.log.error(error);
  requestShutdown("startupFailure", 1);
});
