import { Writable } from "node:stream";
import { DefaultAzureCredential } from "@azure/identity";
import { LogsIngestionClient, isAggregateLogsUploadError } from "@azure/monitor-ingestion";

const DEFAULT_MAX_LOG_ENTRIES = 100;
const HARD_MAX_IN_MEMORY_LOG_ENTRIES = 100;
const DEFAULT_LOG_ANALYTICS_FLUSH_INTERVAL_MS = 10000;
const DEFAULT_LOG_ANALYTICS_BATCH_SIZE = 100;
const DEFAULT_LOG_ANALYTICS_MAX_CONCURRENCY = 1;
const DEFAULT_LOG_ANALYTICS_MAX_QUEUE_SIZE = 5000;
const DEFAULT_MAX_PAYLOAD_LOG_BYTES = 102400;
let maxLogEntries = (() => {
  const raw = Number(process.env.ADMIN_LOG_BUFFER_SIZE);
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_LOG_ENTRIES;
  return Math.min(HARD_MAX_IN_MEMORY_LOG_ENTRIES, requested);
})();

const PINO_LEVELS = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "client_secret"
]);

const logBuffer = [];
let nextLogId = 1;
let runtimeLogConfig = null;
let logAnalyticsClient = null;
let logAnalyticsClientKey = "";
let logAnalyticsFlushTimer = null;
let logAnalyticsFlushRunning = false;
const logAnalyticsQueue = [];

const logAnalyticsState = {
  enabled: false,
  configured: false,
  queueLength: 0,
  droppedEntries: 0,
  flushFailures: 0,
  lastSuccessTs: "",
  lastError: null,
  lastUploadCount: 0,
  flushing: false
};

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim().toLowerCase())
    : [];
}

function getEnvOverride(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function clampInteger(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function clampNumber(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function snapshotError(error) {
  if (!error) return null;
  return {
    code: error?.code || error?.name || "UnknownError",
    statusCode: error?.statusCode || null,
    message: truncateString(error?.message || String(error), 2000)
  };
}

function updateLogAnalyticsState(patch) {
  Object.assign(logAnalyticsState, patch);
  logAnalyticsState.queueLength = logAnalyticsQueue.length;
}

function resolveLogAnalyticsSettings(config = runtimeLogConfig) {
  const observability = asPlainObject(config?.observability);
  const logs = asPlainObject(observability.logs);
  const logAnalytics = asPlainObject(observability.logAnalytics);
  const sinks = new Set(normalizeStringArray(logs.sinks));
  const managedIdentityClientId = logAnalytics.credentialRef
    ? getEnvOverride(logAnalytics.credentialRef)
    : getEnvOverride("AZURE_MONITOR_MANAGED_IDENTITY_CLIENT_ID");
  const maxPayloadLogBytes = clampInteger(logs.maxPayloadLogBytes, DEFAULT_MAX_PAYLOAD_LOG_BYTES, 1024);

  return {
    enabled: logAnalytics.enabled === true,
    sinks,
    endpoint: getEnvOverride("AZURE_MONITOR_LOGS_ENDPOINT", "LOG_ANALYTICS_ENDPOINT") || String(logAnalytics.endpoint || "").trim(),
    ruleId: getEnvOverride("AZURE_MONITOR_DCR_IMMUTABLE_ID", "LOG_ANALYTICS_DCR_IMMUTABLE_ID") || String(logAnalytics.dcrImmutableId || "").trim(),
    streamName: getEnvOverride("AZURE_MONITOR_DCR_STREAM_NAME", "LOG_ANALYTICS_STREAM_NAME") || String(logAnalytics.streamName || "").trim(),
    audience: getEnvOverride("AZURE_MONITOR_LOGS_AUDIENCE", "LOG_ANALYTICS_AUDIENCE") || String(logAnalytics.audience || "").trim(),
    workspaceId: String(logAnalytics.workspaceId || "").trim(),
    tableName: String(logAnalytics.tableName || "").trim(),
    contentMode: logAnalytics.contentMode === "full" ? "full" : "summary",
    flushIntervalMs: clampInteger(logAnalytics.flushIntervalMs, DEFAULT_LOG_ANALYTICS_FLUSH_INTERVAL_MS, 1000),
    batchSize: clampInteger(logAnalytics.batchSize, DEFAULT_LOG_ANALYTICS_BATCH_SIZE, 1, 1000),
    samplingRatio: clampNumber(logAnalytics.samplingRatio, 1, 0, 1),
    maxConcurrency: clampInteger(logAnalytics.maxConcurrency, DEFAULT_LOG_ANALYTICS_MAX_CONCURRENCY, 1, 5),
    maxQueueSize: clampInteger(logAnalytics.maxQueueSize, DEFAULT_LOG_ANALYTICS_MAX_QUEUE_SIZE, 10, 20000),
    managedIdentityClientId,
    maxPayloadLogBytes
  };
}

function shouldUseLogAnalytics(settings) {
  if (!settings.enabled) return false;
  return !!(settings.endpoint && settings.ruleId && settings.streamName);
}

function clearLogAnalyticsFlushTimer() {
  if (logAnalyticsFlushTimer) {
    clearTimeout(logAnalyticsFlushTimer);
    logAnalyticsFlushTimer = null;
  }
}

function recordInternalLog(level, payload = {}) {
  return appendEntry(buildEntry({ ...payload, level }));
}

function buildLogAnalyticsRecord(entry, settings) {
  const fieldsJson = truncateString(JSON.stringify(entry.fields || {}), settings.maxPayloadLogBytes);
  const entryJson = settings.contentMode === "full"
    ? truncateString(JSON.stringify(entry), settings.maxPayloadLogBytes)
    : "";

  return {
    TimeGenerated: entry.ts,
    Timestamp: entry.ts,
    Level: entry.level,
    Event: entry.event,
    Message: entry.message,
    Source: entry.source,
    RequestId: entry.requestId,
    AzureRequestId: entry.azureRequestId,
    ModelId: entry.modelId,
    RouteKey: entry.routeKey,
    BackendRouteKey: entry.backendRouteKey,
    Status: entry.status,
    ErrorCode: entry.errorCode,
    FailureReason: entry.failureReason,
    LatencyMs: entry.latencyMs,
    ClientIp: entry.clientIp,
    UserAgent: entry.userAgent,
    ForwardedFor: entry.forwardedFor,
    WorkspaceId: settings.workspaceId,
    TableName: settings.tableName,
    ContentMode: settings.contentMode,
    FieldsJson: fieldsJson,
    EntryJson: entryJson
  };
}

function getLogAnalyticsClient(settings) {
  const clientKey = JSON.stringify({
    endpoint: settings.endpoint,
    audience: settings.audience,
    managedIdentityClientId: settings.managedIdentityClientId || ""
  });

  if (!logAnalyticsClient || logAnalyticsClientKey !== clientKey) {
    const credential = new DefaultAzureCredential({
      managedIdentityClientId: settings.managedIdentityClientId || undefined
    });
    const options = settings.audience ? { audience: settings.audience } : undefined;
    logAnalyticsClient = new LogsIngestionClient(settings.endpoint, credential, options);
    logAnalyticsClientKey = clientKey;
  }

  return logAnalyticsClient;
}

function scheduleLogAnalyticsFlush() {
  const settings = resolveLogAnalyticsSettings();
  if (!shouldUseLogAnalytics(settings) || logAnalyticsQueue.length === 0) {
    clearLogAnalyticsFlushTimer();
    return;
  }
  if (logAnalyticsFlushRunning || logAnalyticsFlushTimer) {
    return;
  }
  const delay = logAnalyticsQueue.length >= settings.batchSize ? 0 : settings.flushIntervalMs;
  logAnalyticsFlushTimer = setTimeout(() => {
    logAnalyticsFlushTimer = null;
    void flushLogAnalyticsSink();
  }, delay);
}

function enqueueLogAnalyticsEntry(entry) {
  const settings = resolveLogAnalyticsSettings();
  const active = shouldUseLogAnalytics(settings);
  updateLogAnalyticsState({ enabled: settings.enabled, configured: active });
  if (!active) {
    return;
  }
  if (settings.samplingRatio < 1 && Math.random() > settings.samplingRatio) {
    return;
  }

  if (logAnalyticsQueue.length >= settings.maxQueueSize) {
    logAnalyticsQueue.shift();
    updateLogAnalyticsState({ droppedEntries: logAnalyticsState.droppedEntries + 1 });
  }

  logAnalyticsQueue.push({
    record: buildLogAnalyticsRecord(entry, settings),
    attempts: 0
  });
  updateLogAnalyticsState({ enabled: true, configured: true });
  scheduleLogAnalyticsFlush();
}

async function flushLogAnalyticsBatch(settings, batchItems) {
  const client = getLogAnalyticsClient(settings);
  await client.upload(
    settings.ruleId,
    settings.streamName,
    batchItems.map((item) => item.record),
    { maxConcurrency: settings.maxConcurrency }
  );
}

export async function flushLogAnalyticsSink() {
  const settings = resolveLogAnalyticsSettings();
  if (!shouldUseLogAnalytics(settings) || logAnalyticsQueue.length === 0) {
    clearLogAnalyticsFlushTimer();
    updateLogAnalyticsState({ enabled: settings.enabled, configured: shouldUseLogAnalytics(settings), flushing: false });
    return { flushed: 0 };
  }
  if (logAnalyticsFlushRunning) {
    return { flushed: 0, skipped: true };
  }

  logAnalyticsFlushRunning = true;
  updateLogAnalyticsState({ enabled: true, configured: true, flushing: true });
  clearLogAnalyticsFlushTimer();

  const batchItems = logAnalyticsQueue.splice(0, settings.batchSize);
  updateLogAnalyticsState({});
  try {
    await flushLogAnalyticsBatch(settings, batchItems);
    updateLogAnalyticsState({
      lastSuccessTs: new Date().toISOString(),
      lastError: null,
      lastUploadCount: batchItems.length,
      flushing: false
    });
    if (logAnalyticsQueue.length > 0) {
      scheduleLogAnalyticsFlush();
    }
    return { flushed: batchItems.length };
  } catch (error) {
    const aggregateErrors = isAggregateLogsUploadError(error) ? error.errors : [];
    const retryItems = batchItems
      .map((item) => ({ ...item, attempts: item.attempts + 1 }))
      .filter((item) => item.attempts <= 2);
    if (retryItems.length > 0) {
      logAnalyticsQueue.unshift(...retryItems);
    }
    updateLogAnalyticsState({
      flushFailures: logAnalyticsState.flushFailures + 1,
      lastError: {
        ...snapshotError(error),
        aggregateErrorCount: aggregateErrors.length || undefined
      },
      droppedEntries: logAnalyticsState.droppedEntries + (batchItems.length - retryItems.length),
      flushing: false
    });
    recordInternalLog("error", {
      source: "loganalytics",
      event: "loganalytics.flush_failed",
      message: error?.message || "Log Analytics flush failed",
      failureReason: error?.message || "Log Analytics flush failed",
      errorCode: error?.code || "LOG_ANALYTICS_FLUSH_FAILED",
      flushFailures: logAnalyticsState.flushFailures,
      droppedEntries: logAnalyticsState.droppedEntries,
      aggregateErrorCount: aggregateErrors.length || 0
    });
    scheduleLogAnalyticsFlush();
    return { flushed: 0, error };
  } finally {
    logAnalyticsFlushRunning = false;
    updateLogAnalyticsState({ flushing: false });
  }
}

export function setLogConfig(config) {
  runtimeLogConfig = config || null;
  const settings = resolveLogAnalyticsSettings(runtimeLogConfig);
  const requestedBufferSize = Number(config?.observability?.logs?.bufferSize);
  const nextBufferSize = Number.isFinite(requestedBufferSize) && requestedBufferSize > 0
    ? Math.floor(requestedBufferSize)
    : DEFAULT_MAX_LOG_ENTRIES;
  maxLogEntries = Math.min(HARD_MAX_IN_MEMORY_LOG_ENTRIES, nextBufferSize);
  if (logBuffer.length > maxLogEntries) {
    logBuffer.splice(0, logBuffer.length - maxLogEntries);
  }
  const active = shouldUseLogAnalytics(settings);
  updateLogAnalyticsState({
    enabled: settings.enabled,
    configured: active,
    lastError: settings.enabled
      ? (active
          ? null
          : {
              code: "LOG_ANALYTICS_CONFIG_INCOMPLETE",
              statusCode: null,
              message: "Log Analytics sink is enabled but endpoint, dcrImmutableId, or streamName is missing"
            })
      : null
  });
  if (!active) {
    clearLogAnalyticsFlushTimer();
    logAnalyticsQueue.splice(0, logAnalyticsQueue.length);
    updateLogAnalyticsState({ queueLength: 0, flushing: false });
    return;
  }
  if (logAnalyticsQueue.length > 0) {
    scheduleLogAnalyticsFlush();
  }
}

export function getLogRuntimeInfo(config = runtimeLogConfig) {
  const settings = resolveLogAnalyticsSettings(config);
  const active = shouldUseLogAnalytics(settings);
  return {
    enabled: settings.enabled,
    configured: active,
    memoryBufferSize: maxLogEntries,
    endpoint: settings.endpoint,
    workspaceId: settings.workspaceId,
    tableName: settings.tableName,
    dcrImmutableId: settings.ruleId,
    streamName: settings.streamName,
    contentMode: settings.contentMode,
    flushIntervalMs: settings.flushIntervalMs,
    batchSize: settings.batchSize,
    samplingRatio: settings.samplingRatio,
    maxConcurrency: settings.maxConcurrency,
    queueLength: logAnalyticsQueue.length,
    droppedEntries: logAnalyticsState.droppedEntries,
    flushFailures: logAnalyticsState.flushFailures,
    lastSuccessTs: logAnalyticsState.lastSuccessTs,
    lastError: logAnalyticsState.lastError,
    flushing: logAnalyticsState.flushing
  };
}

function truncateString(value, maxLen = 4000) {
  if (typeof value !== "string" || value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...<truncated>`;
}

function sanitizeValue(value, key = "", depth = 0) {
  if (SENSITIVE_KEYS.has(String(key || "").toLowerCase())) {
    return "[REDACTED]";
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value);
  }
  if (depth >= 4) {
    return "[Truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      stack: truncateString(value.stack || "", 2000)
    };
  }
  if (value && typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      out[childKey] = sanitizeValue(childValue, childKey, depth + 1);
    });
    return out;
  }
  return String(value);
}

function normalizeLevel(value) {
  if (typeof value === "number") {
    return PINO_LEVELS[value] || "info";
  }
  const normalized = String(value || "info").trim().toLowerCase();
  if (normalized === "warning") return "warn";
  if (normalized === "err") return "error";
  return normalized || "info";
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function appendEntry(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > maxLogEntries) {
    logBuffer.splice(0, logBuffer.length - maxLogEntries);
  }
  return entry;
}

function recordEntry(entry, options = {}) {
  const appended = appendEntry(entry);
  if (options.enqueue !== false) {
    enqueueLogAnalyticsEntry(appended);
  }
  return appended;
}

function buildEntry(payload) {
  const {
    level,
    time,
    ts,
    timestamp,
    msg,
    message,
    event,
    requestId,
    azureRequestId,
    modelId,
    routeKey,
    backendRouteKey,
    source,
    status,
    errorCode,
    failureReason,
    latencyMs,
    clientIp,
    userAgent,
    forwardedFor,
    ...rest
  } = payload || {};

  return {
    id: nextLogId++,
    ts: normalizeTimestamp(ts ?? time ?? timestamp),
    level: normalizeLevel(level),
    event: typeof event === "string" ? event : "",
    message: truncateString(typeof msg === "string" ? msg : typeof message === "string" ? message : ""),
    requestId: typeof requestId === "string" ? requestId : "",
    azureRequestId: typeof azureRequestId === "string" ? azureRequestId : "",
    modelId: typeof modelId === "string" ? modelId : "",
    routeKey: typeof routeKey === "string" ? routeKey : "",
    backendRouteKey: typeof backendRouteKey === "string" ? backendRouteKey : "",
    source: typeof source === "string" ? source : "",
    status: Number.isFinite(status) ? status : null,
    errorCode: typeof errorCode === "string" ? errorCode : "",
    failureReason: truncateString(typeof failureReason === "string" ? failureReason : failureReason == null ? "" : String(failureReason)),
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    clientIp: typeof clientIp === "string" ? truncateString(clientIp, 512) : "",
    userAgent: typeof userAgent === "string" ? truncateString(userAgent, 1024) : "",
    forwardedFor: typeof forwardedFor === "string" ? truncateString(forwardedFor, 1024) : "",
    fields: sanitizeValue(rest)
  };
}

export function appendStructuredLog(level, payload = {}) {
  return recordEntry(buildEntry({ ...payload, level }));
}

function ingestPinoLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    appendStructuredLog("info", { message: line, event: "stdout.raw" });
    return;
  }
  recordEntry(buildEntry(parsed));
}

export function createPinoCaptureStream() {
  let buffered = "";

  return new Writable({
    write(chunk, encoding, callback) {
      const resolvedEncoding = typeof encoding === "string" && encoding && encoding !== "buffer"
        ? encoding
        : "utf8";
      const text = typeof chunk === "string" ? chunk : chunk.toString(resolvedEncoding);
      process.stdout.write(text);
      buffered += text;

      let nextLineBreak = buffered.indexOf("\n");
      while (nextLineBreak >= 0) {
        const line = buffered.slice(0, nextLineBreak).trim();
        buffered = buffered.slice(nextLineBreak + 1);
        if (line) ingestPinoLine(line);
        nextLineBreak = buffered.indexOf("\n");
      }

      callback();
    },
    final(callback) {
      const line = buffered.trim();
      if (line) ingestPinoLine(line);
      callback();
    }
  });
}

function normalizeListParam(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeListParam(item));
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function queryLogs(filters = {}) {
  const levels = new Set(normalizeListParam(filters.level).map((item) => normalizeLevel(item)));
  const event = typeof filters.event === "string" ? filters.event.trim().toLowerCase() : "";
  const modelId = typeof filters.modelId === "string" ? filters.modelId.trim().toLowerCase() : "";
  const requestId = typeof filters.requestId === "string" ? filters.requestId.trim().toLowerCase() : "";
  const keyword = typeof filters.keyword === "string" ? filters.keyword.trim().toLowerCase() : "";
  const since = typeof filters.since === "string" && !Number.isNaN(Date.parse(filters.since))
    ? new Date(filters.since).toISOString()
    : "";
  const requestedLimit = Number(filters.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 100;

  const filtered = logBuffer.filter((entry) => {
    if (levels.size > 0 && !levels.has(entry.level)) return false;
    if (event && !`${entry.event} ${entry.message}`.toLowerCase().includes(event)) return false;
    if (modelId && entry.modelId.toLowerCase() !== modelId) return false;
    if (requestId && entry.requestId.toLowerCase() !== requestId) return false;
    if (since && entry.ts < since) return false;
    if (keyword) {
      const haystack = JSON.stringify(entry).toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });

  return {
    ok: true,
    total: filtered.length,
    limit,
    items: filtered.slice(-limit).reverse()
  };
}