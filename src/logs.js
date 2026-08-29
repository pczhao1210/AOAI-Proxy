import { Writable } from "node:stream";
import crypto from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { LogsIngestionClient, isAggregateLogsUploadError } from "@azure/monitor-ingestion";

const DEFAULT_MAX_LOG_ENTRIES = 500;
const HARD_MAX_IN_MEMORY_LOG_ENTRIES = 5000;
const DEFAULT_MAX_IN_MEMORY_LOG_BYTES = 16 * 1024 * 1024;
const HARD_MAX_IN_MEMORY_LOG_BYTES = 256 * 1024 * 1024;
const DEFAULT_LOG_LEVEL = "info";
const DEFAULT_LOG_SINKS = ["memory", "console"];
const DEFAULT_LOG_ANALYTICS_FLUSH_INTERVAL_MS = 10000;
const DEFAULT_LOG_ANALYTICS_BATCH_SIZE = 100;
const DEFAULT_LOG_ANALYTICS_MAX_CONCURRENCY = 1;
const DEFAULT_LOG_ANALYTICS_MAX_QUEUE_SIZE = 5000;
const DEFAULT_LOG_ANALYTICS_MAX_QUEUE_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOG_ANALYTICS_UPLOAD_TIMEOUT_MS = 30000;
const DEFAULT_LOG_ANALYTICS_MAX_UPLOAD_RETRIES = 3;
const DEFAULT_LOG_ANALYTICS_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_LOG_ANALYTICS_RETRY_MAX_DELAY_MS = 30000;
const DEFAULT_MAX_PAYLOAD_LOG_BYTES = 102400;
const DEFAULT_PARTIAL_PREVIEW_CHARS = 512;
export const LOG_ANALYTICS_SCHEMA_VERSION = 2;
export const LOG_ANALYTICS_COLUMNS = Object.freeze([
  { name: "TimeGenerated", type: "datetime" },
  { name: "Timestamp", type: "datetime" },
  { name: "SchemaVersion", type: "int" },
  { name: "Level", type: "string" },
  { name: "Event", type: "string" },
  { name: "Message", type: "string" },
  { name: "Source", type: "string" },
  { name: "RequestId", type: "string" },
  { name: "ConversationId", type: "string" },
  { name: "SessionId", type: "string" },
  { name: "AzureRequestId", type: "string" },
  { name: "ConsumerKeyId", type: "string" },
  { name: "ModelId", type: "string" },
  { name: "ActualModelName", type: "string" },
  { name: "RouteKey", type: "string" },
  { name: "BackendRouteKey", type: "string" },
  { name: "Stream", type: "boolean" },
  { name: "Attempt", type: "int" },
  { name: "Status", type: "int" },
  { name: "ErrorCode", type: "string" },
  { name: "FailureReason", type: "string" },
  { name: "LatencyMs", type: "real" },
  { name: "ClientIp", type: "string" },
  { name: "UserAgent", type: "string" },
  { name: "ForwardedFor", type: "string" },
  { name: "UsageAvailable", type: "boolean" },
  { name: "UsageSource", type: "string" },
  { name: "UsageEstimated", type: "boolean" },
  { name: "UsageEstimationReason", type: "string" },
  { name: "PromptTokens", type: "long" },
  { name: "CompletionTokens", type: "long" },
  { name: "TotalTokens", type: "long" },
  { name: "CachedTokens", type: "long" },
  { name: "EstimatedCostAmount", type: "real" },
  { name: "ModelRouterCostAmount", type: "real" },
  { name: "ActualModelCostAmount", type: "real" },
  { name: "Currency", type: "string" },
  { name: "RequestPreview", type: "string" },
  { name: "ResponsePreview", type: "string" },
  { name: "RequestBodyJson", type: "string" },
  { name: "ResponseBodyJson", type: "string" },
  { name: "RequestBytes", type: "long" },
  { name: "ResponseBytes", type: "long" },
  { name: "RequestSha256", type: "string" },
  { name: "ResponseSha256", type: "string" },
  { name: "RequestTruncated", type: "boolean" },
  { name: "ResponseTruncated", type: "boolean" },
  { name: "RequestMessageCount", type: "int" },
  { name: "RequestToolCount", type: "int" },
  { name: "RequestItemCount", type: "int" },
  { name: "ResponseMessageCount", type: "int" },
  { name: "ResponseToolCount", type: "int" },
  { name: "ResponseItemCount", type: "int" },
  { name: "WorkspaceId", type: "string" },
  { name: "TableName", type: "string" },
  { name: "ContentMode", type: "string" },
  { name: "FieldsJson", type: "string" },
  { name: "EntryJson", type: "string" }
]);
let maxLogEntries = (() => {
  const raw = Number(process.env.ADMIN_LOG_BUFFER_SIZE);
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_LOG_ENTRIES;
  return Math.min(HARD_MAX_IN_MEMORY_LOG_ENTRIES, requested);
})();
let maxLogBufferBytes = (() => {
  const raw = Number(process.env.ADMIN_LOG_BUFFER_BYTES);
  const requested = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_IN_MEMORY_LOG_BYTES;
  return Math.min(HARD_MAX_IN_MEMORY_LOG_BYTES, requested);
})();

const PINO_LEVELS = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal"
};

const LOG_LEVEL_PRIORITIES = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY
};

const SENSITIVE_FIELD_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "xapikey",
  "apikey",
  "password",
  "token",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "clientsecret",
  "secret",
  "credential",
  "subscriptionkey",
  "sastoken"
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "secret",
  "password",
  "sig",
  "signature",
  "code",
  "credential",
  "subscriptionkey",
  "sastoken"
]);

const API_KEY_INFO_KEYS = new Set(["keyid", "apikeyid", "consumerkeyid"]);
const USAGE_KEYS = new Set([
  "usage",
  "prompttokens",
  "inputtokens",
  "completiontokens",
  "outputtokens",
  "totaltokens",
  "cachedtokens"
]);
const CONTENT_KEYS = new Set([
  "prompt",
  "messages",
  "input",
  "output",
  "content",
  "requestbody",
  "responsebody"
]);
const BINARY_VALUE_KEYS = new Set([
  "attachment",
  "audio",
  "blob",
  "bytes",
  "data",
  "file",
  "image",
  "payload"
]);

const logBuffer = [];
const logBufferEntryBytes = [];
let logBufferBytes = 0;
let logBufferDroppedEntries = 0;
let logBufferDroppedBytes = 0;
let nextLogId = 1;
let runtimeLogConfig = null;
let logAnalyticsClient = null;
let logAnalyticsClientKey = "";
let logAnalyticsFlushTimer = null;
let logAnalyticsFlushRunning = false;
let logAnalyticsOutstandingUpload = null;
let logAnalyticsUploadPendingAfterTimeout = false;
let logAnalyticsQueueBytes = 0;
let logAnalyticsRetryNotBefore = 0;
let logAnalyticsConsecutiveFailures = 0;
const logAnalyticsQueue = [];

const logAnalyticsState = {
  enabled: false,
  configured: false,
  queueLength: 0,
  queueBytes: 0,
  droppedEntries: 0,
  droppedBytes: 0,
  flushFailures: 0,
  lastSuccessTs: "",
  lastError: null,
  lastUploadCount: 0,
  consecutiveFailures: 0,
  nextRetryAt: "",
  nextFlushAt: "",
  uploadInFlight: false,
  uploadPendingAfterTimeout: false,
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

export function resolveLogContentMode(config = runtimeLogConfig) {
  const observability = asPlainObject(config?.observability);
  const logs = asPlainObject(observability.logs);
  const logAnalytics = asPlainObject(observability.logAnalytics);
  return logs.messageContentMode === "full" || logAnalytics.contentMode === "full" ? "full" : "summary";
}

function resolveLogSettings(config = runtimeLogConfig) {
  const logs = asPlainObject(config?.observability?.logs);
  const configuredSinks = Array.isArray(logs.sinks)
    ? normalizeStringArray(logs.sinks)
    : DEFAULT_LOG_SINKS;
  const outputLevel = normalizeLevel(process.env.LOG_LEVEL || logs.level || DEFAULT_LOG_LEVEL);
  const outputPriority = LOG_LEVEL_PRIORITIES[outputLevel] ?? LOG_LEVEL_PRIORITIES.info;
  const adminLevel = outputPriority < LOG_LEVEL_PRIORITIES.info ? outputLevel : DEFAULT_LOG_LEVEL;
  const sinks = new Set(configuredSinks);
  sinks.add("memory");
  return {
    level: outputLevel,
    adminLevel,
    sinks,
    includeClientIp: logs.includeClientIp !== false,
    includeHeaders: logs.includeHeaders === true,
    includeUsage: logs.includeUsage !== false,
    redactApiKeyInfo: logs.redactApiKeyInfo !== false,
    messageContentMode: resolveLogContentMode(config),
    maxBase64LogChars: clampInteger(logs.maxBase64LogChars, 64, 0, 4096),
    maxBufferBytes: clampInteger(logs.maxBufferBytes, DEFAULT_MAX_IN_MEMORY_LOG_BYTES, 64 * 1024, HARD_MAX_IN_MEMORY_LOG_BYTES)
  };
}

function shouldRecordLevel(level, minimumLevel) {
  const normalizedLevel = normalizeLevel(level);
  const normalizedMinimum = normalizeLevel(minimumLevel);
  const priority = LOG_LEVEL_PRIORITIES[normalizedLevel] ?? LOG_LEVEL_PRIORITIES.info;
  const minimumPriority = LOG_LEVEL_PRIORITIES[normalizedMinimum] ?? LOG_LEVEL_PRIORITIES.warn;
  return priority >= minimumPriority;
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
  logAnalyticsState.queueBytes = logAnalyticsQueueBytes;
  logAnalyticsState.consecutiveFailures = logAnalyticsConsecutiveFailures;
  logAnalyticsState.nextRetryAt = logAnalyticsRetryNotBefore > Date.now()
    ? new Date(logAnalyticsRetryNotBefore).toISOString()
    : "";
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
    contentMode: resolveLogContentMode(config),
    flushIntervalMs: clampInteger(logAnalytics.flushIntervalMs, DEFAULT_LOG_ANALYTICS_FLUSH_INTERVAL_MS, 1000),
    batchSize: clampInteger(logAnalytics.batchSize, DEFAULT_LOG_ANALYTICS_BATCH_SIZE, 1, 1000),
    samplingRatio: clampNumber(logAnalytics.samplingRatio, 1, 0, 1),
    maxConcurrency: clampInteger(logAnalytics.maxConcurrency, DEFAULT_LOG_ANALYTICS_MAX_CONCURRENCY, 1, 5),
    maxQueueSize: clampInteger(logAnalytics.maxQueueSize, DEFAULT_LOG_ANALYTICS_MAX_QUEUE_SIZE, 10, 20000),
    maxQueueBytes: clampInteger(logAnalytics.maxQueueBytes, DEFAULT_LOG_ANALYTICS_MAX_QUEUE_BYTES, 64 * 1024, 512 * 1024 * 1024),
    uploadTimeoutMs: clampInteger(logAnalytics.uploadTimeoutMs, DEFAULT_LOG_ANALYTICS_UPLOAD_TIMEOUT_MS, 100, 300000),
    maxUploadRetries: clampInteger(logAnalytics.maxUploadRetries, DEFAULT_LOG_ANALYTICS_MAX_UPLOAD_RETRIES, 0, 10),
    retryBaseDelayMs: clampInteger(logAnalytics.retryBaseDelayMs, DEFAULT_LOG_ANALYTICS_RETRY_BASE_DELAY_MS, 100, 60000),
    retryMaxDelayMs: clampInteger(logAnalytics.retryMaxDelayMs, DEFAULT_LOG_ANALYTICS_RETRY_MAX_DELAY_MS, 100, 300000),
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
  logAnalyticsState.nextFlushAt = "";
}

function recordInternalLog(level, payload = {}) {
  return recordEntry(buildEntry({ ...payload, level }), { enqueue: false });
}

export function buildLogAnalyticsRecord(entry, settings = resolveLogAnalyticsSettings()) {
  const fieldsJson = truncateString(JSON.stringify(entry.fields || {}), settings.maxPayloadLogBytes);
  const { requestBodyJson, responseBodyJson, ...entryWithoutBodies } = entry;
  const entryJson = settings.contentMode === "full"
    ? truncateString(JSON.stringify(entryWithoutBodies), settings.maxPayloadLogBytes)
    : "";

  return {
    TimeGenerated: entry.ts,
    Timestamp: entry.ts,
    SchemaVersion: LOG_ANALYTICS_SCHEMA_VERSION,
    Level: entry.level,
    Event: entry.event,
    Message: entry.message,
    Source: entry.source,
    RequestId: entry.requestId,
    ConversationId: entry.conversationId,
    SessionId: entry.sessionId,
    AzureRequestId: entry.azureRequestId,
    ConsumerKeyId: entry.consumerKeyId,
    ModelId: entry.modelId,
    ActualModelName: entry.actualModelName,
    RouteKey: entry.routeKey,
    BackendRouteKey: entry.backendRouteKey,
    Stream: entry.stream,
    Attempt: entry.attempt,
    Status: entry.status,
    ErrorCode: entry.errorCode,
    FailureReason: entry.failureReason,
    LatencyMs: entry.latencyMs,
    ClientIp: entry.clientIp,
    UserAgent: entry.userAgent,
    ForwardedFor: entry.forwardedFor,
    UsageAvailable: entry.usageAvailable,
    UsageSource: entry.usageSource,
    UsageEstimated: entry.usageEstimated,
    UsageEstimationReason: entry.usageEstimationReason,
    PromptTokens: entry.promptTokens,
    CompletionTokens: entry.completionTokens,
    TotalTokens: entry.totalTokens,
    CachedTokens: entry.cachedTokens,
    EstimatedCostAmount: entry.estimatedCostAmount,
    ModelRouterCostAmount: entry.modelRouterCostAmount,
    ActualModelCostAmount: entry.actualModelCostAmount,
    Currency: entry.currency,
    RequestPreview: entry.requestPreview,
    ResponsePreview: entry.responsePreview,
    RequestBodyJson: requestBodyJson,
    ResponseBodyJson: responseBodyJson,
    RequestBytes: entry.requestBytes,
    ResponseBytes: entry.responseBytes,
    RequestSha256: entry.requestSha256,
    ResponseSha256: entry.responseSha256,
    RequestTruncated: entry.requestTruncated,
    ResponseTruncated: entry.responseTruncated,
    RequestMessageCount: entry.requestMessageCount,
    RequestToolCount: entry.requestToolCount,
    RequestItemCount: entry.requestItemCount,
    ResponseMessageCount: entry.responseMessageCount,
    ResponseToolCount: entry.responseToolCount,
    ResponseItemCount: entry.responseItemCount,
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
  if (logAnalyticsOutstandingUpload) {
    return;
  }
  const retryDelay = Math.max(0, logAnalyticsRetryNotBefore - Date.now());
  const normalDelay = retryDelay > 0
    ? 0
    : (logAnalyticsQueue.length >= settings.batchSize ? 0 : settings.flushIntervalMs);
  const delay = Math.max(normalDelay, retryDelay);
  logAnalyticsState.nextFlushAt = new Date(Date.now() + delay).toISOString();
  logAnalyticsFlushTimer = setTimeout(() => {
    logAnalyticsFlushTimer = null;
    logAnalyticsState.nextFlushAt = "";
    void flushLogAnalyticsSink();
  }, delay);
}

function estimateLogAnalyticsRecordBytes(record) {
  let bytes = 2;
  for (const [key, value] of Object.entries(record || {})) {
    bytes += Buffer.byteLength(key, "utf8") + 6;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8") + 2;
    } else if (value != null) {
      bytes += Buffer.byteLength(String(value), "utf8");
    }
  }
  return bytes;
}

function trimLogAnalyticsQueue(settings) {
  let droppedEntries = 0;
  let droppedBytes = 0;
  while (logAnalyticsQueue.length > settings.maxQueueSize || logAnalyticsQueueBytes > settings.maxQueueBytes) {
    const item = logAnalyticsQueue.shift();
    if (!item) break;
    logAnalyticsQueueBytes = Math.max(0, logAnalyticsQueueBytes - item.bytes);
    droppedEntries += 1;
    droppedBytes += item.bytes;
  }
  if (droppedEntries > 0) {
    updateLogAnalyticsState({
      droppedEntries: logAnalyticsState.droppedEntries + droppedEntries,
      droppedBytes: logAnalyticsState.droppedBytes + droppedBytes
    });
  }
}

function enqueueLogAnalyticsEntry(entry) {
  const settings = resolveLogAnalyticsSettings();
  const active = shouldUseLogAnalytics(settings);
  updateLogAnalyticsState({ enabled: settings.enabled, configured: active });
  if (!active) {
    return;
  }
  if (settings.samplingRatio < 1
    && (LOG_LEVEL_PRIORITIES[entry.level] ?? LOG_LEVEL_PRIORITIES.info) < LOG_LEVEL_PRIORITIES.warn
    && Math.random() > settings.samplingRatio) {
    return;
  }

  const record = buildLogAnalyticsRecord(entry, settings);
  const bytes = estimateLogAnalyticsRecordBytes(record);
  if (bytes > settings.maxQueueBytes) {
    updateLogAnalyticsState({
      droppedEntries: logAnalyticsState.droppedEntries + 1,
      droppedBytes: logAnalyticsState.droppedBytes + bytes
    });
    return;
  }

  logAnalyticsQueue.push({ record, attempts: 0, bytes });
  logAnalyticsQueueBytes += bytes;
  trimLogAnalyticsQueue(settings);
  updateLogAnalyticsState({ enabled: true, configured: true });
  scheduleLogAnalyticsFlush();
}

async function flushLogAnalyticsBatch(settings, batchItems) {
  const records = batchItems.map((item) => item.record);
  const controller = new AbortController();
  let timeoutHandle;
  let uploadPromise;
  const timeoutError = Object.assign(
    new Error(`Log Analytics upload timed out after ${settings.uploadTimeoutMs}ms`),
    { code: "LOG_ANALYTICS_UPLOAD_TIMEOUT", statusCode: 504 }
  );
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      logAnalyticsUploadPendingAfterTimeout = true;
      updateLogAnalyticsState({ uploadPendingAfterTimeout: true });
      timeoutError.pendingUpload = uploadPromise;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, settings.uploadTimeoutMs);
  });
  const rawUploadPromise = Promise.resolve().then(() => (
    getLogAnalyticsClient(settings).upload(
      settings.ruleId,
      settings.streamName,
      records,
      { maxConcurrency: settings.maxConcurrency, abortSignal: controller.signal }
    )
  ));
  uploadPromise = rawUploadPromise.finally(() => {
    if (logAnalyticsOutstandingUpload !== uploadPromise) return;
    logAnalyticsOutstandingUpload = null;
    logAnalyticsUploadPendingAfterTimeout = false;
    updateLogAnalyticsState({ uploadInFlight: false, uploadPendingAfterTimeout: false });
    if (logAnalyticsQueue.length > 0) scheduleLogAnalyticsFlush();
  });
  logAnalyticsOutstandingUpload = uploadPromise;
  updateLogAnalyticsState({ uploadInFlight: true, uploadPendingAfterTimeout: false });
  try {
    await Promise.race([uploadPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function isRetryableLogAnalyticsError(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  if (!Number.isFinite(statusCode) || statusCode <= 0) return true;
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

export async function flushLogAnalyticsSink(options = {}) {
  const settings = resolveLogAnalyticsSettings();
  if (!shouldUseLogAnalytics(settings) || logAnalyticsQueue.length === 0) {
    clearLogAnalyticsFlushTimer();
    updateLogAnalyticsState({ enabled: settings.enabled, configured: shouldUseLogAnalytics(settings), flushing: false });
    return { flushed: 0 };
  }
  if (logAnalyticsFlushRunning) {
    return { flushed: 0, skipped: true };
  }
  if (logAnalyticsOutstandingUpload) {
    return { flushed: 0, deferred: true, pendingUpload: true };
  }
  if (options.force !== true && logAnalyticsRetryNotBefore > Date.now()) {
    scheduleLogAnalyticsFlush();
    return { flushed: 0, deferred: true, retryAt: new Date(logAnalyticsRetryNotBefore).toISOString() };
  }

  logAnalyticsFlushRunning = true;
  let scheduleAfterFlush = false;
  updateLogAnalyticsState({ enabled: true, configured: true, flushing: true });
  clearLogAnalyticsFlushTimer();

  const batchItems = logAnalyticsQueue.splice(0, settings.batchSize);
  logAnalyticsQueueBytes = Math.max(
    0,
    logAnalyticsQueueBytes - batchItems.reduce((total, item) => total + item.bytes, 0)
  );
  updateLogAnalyticsState({});
  try {
    await flushLogAnalyticsBatch(settings, batchItems);
    logAnalyticsConsecutiveFailures = 0;
    logAnalyticsRetryNotBefore = 0;
    updateLogAnalyticsState({
      lastSuccessTs: new Date().toISOString(),
      lastError: null,
      lastUploadCount: batchItems.length,
      flushing: false
    });
    scheduleAfterFlush = logAnalyticsQueue.length > 0;
    return { flushed: batchItems.length };
  } catch (error) {
    const aggregateErrors = isAggregateLogsUploadError(error) ? error.errors : [];
    const retryable = isRetryableLogAnalyticsError(error);
    const retryItems = batchItems
      .map((item) => ({ ...item, attempts: item.attempts + 1 }))
      .filter((item) => retryable && item.attempts <= settings.maxUploadRetries);
    if (retryItems.length > 0) {
      logAnalyticsQueue.unshift(...retryItems);
      logAnalyticsQueueBytes += retryItems.reduce((total, item) => total + item.bytes, 0);
      trimLogAnalyticsQueue(settings);
      if (error?.pendingUpload) {
        const pendingRecords = new Set(retryItems.map((item) => item.record));
        error.pendingUpload.then(() => {
          let removedBytes = 0;
          for (let index = logAnalyticsQueue.length - 1; index >= 0; index -= 1) {
            if (!pendingRecords.has(logAnalyticsQueue[index].record)) continue;
            removedBytes += logAnalyticsQueue[index].bytes;
            logAnalyticsQueue.splice(index, 1);
          }
          logAnalyticsQueueBytes = Math.max(0, logAnalyticsQueueBytes - removedBytes);
          updateLogAnalyticsState({});
          if (logAnalyticsQueue.length === 0) clearLogAnalyticsFlushTimer();
          else scheduleLogAnalyticsFlush();
        }, () => {});
      }
    }
    logAnalyticsConsecutiveFailures += 1;
    const retryDelayMs = Math.min(
      settings.retryMaxDelayMs,
      settings.retryBaseDelayMs * (2 ** Math.max(0, logAnalyticsConsecutiveFailures - 1))
    );
    logAnalyticsRetryNotBefore = Date.now() + retryDelayMs;
    updateLogAnalyticsState({
      flushFailures: logAnalyticsState.flushFailures + 1,
      lastError: {
        ...snapshotError(error),
        aggregateErrorCount: aggregateErrors.length || undefined,
        retryable,
        retryDelayMs
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
    scheduleAfterFlush = logAnalyticsQueue.length > 0;
    return { flushed: 0, error, retryable, retryDelayMs, requeued: retryItems.length };
  } finally {
    logAnalyticsFlushRunning = false;
    updateLogAnalyticsState({ flushing: false });
    if (scheduleAfterFlush) scheduleLogAnalyticsFlush();
  }
}

export function setLogConfig(config) {
  runtimeLogConfig = config || null;
  const settings = resolveLogAnalyticsSettings(runtimeLogConfig);
  const logSettings = resolveLogSettings(runtimeLogConfig);
  const requestedBufferSize = Number(config?.observability?.logs?.bufferSize);
  const nextBufferSize = Number.isFinite(requestedBufferSize) && requestedBufferSize > 0
    ? Math.floor(requestedBufferSize)
    : DEFAULT_MAX_LOG_ENTRIES;
  maxLogEntries = Math.min(HARD_MAX_IN_MEMORY_LOG_ENTRIES, nextBufferSize);
  maxLogBufferBytes = logSettings.maxBufferBytes;
  trimMemoryLogBuffer();
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
    logAnalyticsQueueBytes = 0;
    logAnalyticsRetryNotBefore = 0;
    logAnalyticsConsecutiveFailures = 0;
    updateLogAnalyticsState({ queueLength: 0, queueBytes: 0, flushing: false });
    return;
  }
  trimLogAnalyticsQueue(settings);
  if (logAnalyticsQueue.length > 0) {
    scheduleLogAnalyticsFlush();
  }
}

export function getLogRuntimeInfo(config = runtimeLogConfig) {
  const settings = resolveLogAnalyticsSettings(config);
  const logSettings = resolveLogSettings(config);
  const active = shouldUseLogAnalytics(settings);
  return {
    level: logSettings.adminLevel,
    outputLevel: logSettings.level,
    sinks: Array.from(logSettings.sinks),
    memoryEnabled: logSettings.sinks.has("memory"),
    consoleEnabled: logSettings.sinks.has("console"),
    logAnalyticsEnabled: settings.enabled,
    logAnalyticsConfigured: active,
    enabled: settings.enabled,
    configured: active,
    memoryBufferSize: maxLogEntries,
    memoryBufferMaxBytes: maxLogBufferBytes,
    memoryBufferBytes: logBufferBytes,
    memoryDroppedEntries: logBufferDroppedEntries,
    memoryDroppedBytes: logBufferDroppedBytes,
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
    maxQueueSize: settings.maxQueueSize,
    maxQueueBytes: settings.maxQueueBytes,
    uploadTimeoutMs: settings.uploadTimeoutMs,
    maxUploadRetries: settings.maxUploadRetries,
    retryBaseDelayMs: settings.retryBaseDelayMs,
    retryMaxDelayMs: settings.retryMaxDelayMs,
    queueLength: logAnalyticsQueue.length,
    queueBytes: logAnalyticsQueueBytes,
    droppedEntries: logAnalyticsState.droppedEntries,
    droppedBytes: logAnalyticsState.droppedBytes,
    flushFailures: logAnalyticsState.flushFailures,
    lastSuccessTs: logAnalyticsState.lastSuccessTs,
    lastError: logAnalyticsState.lastError,
    consecutiveFailures: logAnalyticsConsecutiveFailures,
    nextRetryAt: logAnalyticsState.nextRetryAt,
    nextFlushAt: logAnalyticsState.nextFlushAt,
    uploadInFlight: logAnalyticsState.uploadInFlight,
    uploadPendingAfterTimeout: logAnalyticsUploadPendingAfterTimeout,
    flushing: logAnalyticsState.flushing
  };
}

function truncateString(value, maxLen = 4000) {
  if (typeof value !== "string" || value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...<truncated>`;
}

function sanitizeUrl(value) {
  if (typeof value !== "string") return value;
  const questionIndex = value.indexOf("?");
  if (questionIndex < 0) return truncateString(value);

  const hashIndex = value.indexOf("#", questionIndex);
  const base = value.slice(0, questionIndex);
  const query = value.slice(questionIndex + 1, hashIndex >= 0 ? hashIndex : undefined);
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const params = new URLSearchParams(query);
  let changed = false;

  for (const key of new Set(params.keys())) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!SENSITIVE_QUERY_KEYS.has(normalizedKey)) continue;
    params.set(key, "[REDACTED]");
    changed = true;
  }

  if (!changed) return truncateString(value);
  const sanitizedQuery = params.toString().replace(/%5BREDACTED%5D/gi, "[REDACTED]");
  return truncateString(`${base}?${sanitizedQuery}${hash}`);
}

function sanitizeBase64Value(value) {
  const dataUrlMatch = value.match(/^(data:[^,]*;base64,)(.*)$/is);
  const payload = dataUrlMatch?.[2] || value;
  return `[BINARY_OMITTED chars=${payload.length}]`;
}

function parseBase64Candidate(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (compact.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (normalized.length % 4 === 1) return null;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  if (!decoded.length || decoded.toString("base64").replace(/=+$/, "") !== normalized) return null;
  return { compact, decoded };
}

function isLikelyBase64Value(value, compactKey) {
  const hasBinaryKeyHint = (
    BINARY_VALUE_KEYS.has(compactKey)
    || compactKey.endsWith("payload")
    || compactKey.endsWith("bytes")
    || compactKey.endsWith("blob")
  );
  if (!hasBinaryKeyHint && !/[+/=_-]/.test(value)) return false;
  const candidate = parseBase64Candidate(value);
  if (!candidate) return false;
  if (hasBinaryKeyHint) return true;
  if (/^[a-f0-9]+$/i.test(candidate.compact)) return false;
  return true;
}

function sanitizeValue(value, key = "", depth = 0, settings = resolveLogSettings()) {
  const normalizedKey = String(key || "").toLowerCase();
  const compactKey = normalizedKey.replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_FIELD_KEYS.has(compactKey)) {
    return "[REDACTED]";
  }
  if (settings.redactApiKeyInfo && API_KEY_INFO_KEYS.has(compactKey)) {
    return "[REDACTED]";
  }
  if (!settings.includeHeaders && (compactKey === "headers" || compactKey.endsWith("headers"))) {
    return "[OMITTED]";
  }
  if (!settings.includeUsage && USAGE_KEYS.has(compactKey)) {
    return undefined;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (
      compactKey.includes("base64")
      || compactKey.includes("b64")
      || /^data:[^,]*;base64,/i.test(value)
      || isLikelyBase64Value(value, compactKey)
    ) {
      return sanitizeBase64Value(value);
    }
    if (normalizedKey === "url" || normalizedKey.endsWith("url")) {
      return sanitizeUrl(value);
    }
    if (settings.messageContentMode !== "full" && CONTENT_KEYS.has(compactKey)) {
      return "[OMITTED]";
    }
    return truncateString(value, settings.maxStringChars || 4000);
  }
  if (depth >= (settings.maxDepth || 4)) {
    return "[Truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, settings.maxArrayItems || 50).map((item) => sanitizeValue(item, key, depth + 1, settings));
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
      const sanitized = sanitizeValue(childValue, childKey, depth + 1, settings);
      if (sanitized !== undefined) {
        out[childKey] = sanitized;
      }
    });
    return out;
  }
  return String(value);
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  return {
    value: bytes.subarray(0, maxBytes).toString("utf8").replace(/\ufffd$/, ""),
    truncated: true
  };
}

function countContentItems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { messageCount: 0, toolCount: 0, itemCount: value == null ? 0 : 1 };
  }
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const directTools = Array.isArray(value.tools) ? value.tools.length : 0;
  const messageTools = messages.reduce((total, message) => (
    total + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0)
  ), 0);
  const collection = Array.isArray(value.input)
    ? value.input
    : Array.isArray(value.output)
      ? value.output
      : Array.isArray(value.data)
        ? value.data
        : [];
  return {
    messageCount: messages.length,
    toolCount: directTools + messageTools,
    itemCount: collection.length || (value.prompt != null ? 1 : 0)
  };
}

export function buildContentLogSnapshot(value, options = {}) {
  const configured = resolveLogSettings();
  const mode = options.mode === "full" ? "full" : "summary";
  const maxPayloadBytes = clampInteger(
    options.maxPayloadBytes,
    DEFAULT_MAX_PAYLOAD_LOG_BYTES,
    1024,
    10 * 1024 * 1024
  );
  const previewChars = clampInteger(
    options.previewChars,
    DEFAULT_PARTIAL_PREVIEW_CHARS,
    0,
    4096
  );
  const sanitized = sanitizeValue(value, options.kind || "content", 0, {
    ...configured,
    includeHeaders: false,
    includeUsage: true,
    messageContentMode: "full",
    maxStringChars: maxPayloadBytes,
    maxArrayItems: 500,
    maxDepth: 12
  });
  const serialized = JSON.stringify(sanitized ?? null);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  const full = truncateUtf8(serialized, maxPayloadBytes);
  const previewTruncated = serialized.length > previewChars;
  const counts = countContentItems(value);

  return {
    preview: previewChars > 0 ? serialized.slice(0, previewChars) : "",
    bodyJson: mode === "full" ? full.value : "",
    bytes: serializedBytes,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    truncated: mode === "full" ? full.truncated : previewTruncated,
    ...counts
  };
}

function normalizeLevel(value) {
  if (typeof value === "number") {
    return PINO_LEVELS[value] || "info";
  }
  const normalized = String(value || "info").trim().toLowerCase();
  if (normalized === "warning") return "warn";
  if (normalized === "err") return "error";
  if (normalized === "log") return "info";
  return Object.hasOwn(LOG_LEVEL_PRIORITIES, normalized) ? normalized : "info";
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

function estimateLogEntryBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  } catch {
    return 1024;
  }
}

function trimMemoryLogBuffer() {
  while (logBuffer.length > maxLogEntries || logBufferBytes > maxLogBufferBytes) {
    logBuffer.shift();
    const removedBytes = logBufferEntryBytes.shift() || 0;
    logBufferBytes = Math.max(0, logBufferBytes - removedBytes);
    logBufferDroppedEntries += 1;
    logBufferDroppedBytes += removedBytes;
  }
}

function appendEntry(entry) {
  const entryBytes = estimateLogEntryBytes(entry);
  if (entryBytes > maxLogBufferBytes) {
    logBufferDroppedEntries += 1;
    logBufferDroppedBytes += entryBytes;
    return entry;
  }
  logBuffer.push(entry);
  logBufferEntryBytes.push(entryBytes);
  logBufferBytes += entryBytes;
  trimMemoryLogBuffer();
  return entry;
}

function writeConsoleEntry(entry) {
  const { id, fields, ...base } = entry;
  try {
    const serialized = JSON.stringify({ ...(fields || {}), ...base });
    if (entry.level === "error" || entry.level === "fatal") {
      console.error(serialized);
    } else if (entry.level === "warn") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  } catch {
  }
}

function recordEntry(entry, options = {}) {
  const settings = resolveLogSettings();
  const outputEnabled = options.bypassLevel || shouldRecordLevel(entry.level, settings.level);
  const adminCaptureEnabled = options.bypassLevel || shouldRecordLevel(entry.level, settings.adminLevel);
  if (adminCaptureEnabled) {
    appendEntry(entry);
  }
  if (outputEnabled && options.emitConsole !== false && (options.forceConsole || settings.sinks.has("console"))) {
    writeConsoleEntry(entry);
  }
  if (outputEnabled && options.enqueue !== false) {
    enqueueLogAnalyticsEntry(entry);
  }
  return entry;
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
    conversationId,
    sessionId,
    azureRequestId,
    consumerKeyId,
    modelId,
    actualModelName,
    routeKey,
    backendRouteKey,
    sourceProtocol,
    targetProtocol,
    stream,
    attempt,
    source,
    status,
    errorCode,
    failureReason,
    latencyMs,
    clientIp,
    userAgent,
    forwardedFor,
    usageAvailable,
    usageSource,
    usageEstimated,
    usageEstimationReason,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    estimatedCostAmount,
    modelRouterCostAmount,
    actualModelCostAmount,
    currency,
    requestPreview,
    responsePreview,
    requestBodyJson,
    responseBodyJson,
    requestBytes,
    responseBytes,
    requestSha256,
    responseSha256,
    requestTruncated,
    responseTruncated,
    requestMessageCount,
    requestToolCount,
    requestItemCount,
    responseMessageCount,
    responseToolCount,
    responseItemCount,
    ...rest
  } = payload || {};
  const settings = resolveLogSettings();

  return {
    id: nextLogId++,
    ts: normalizeTimestamp(ts ?? time ?? timestamp),
    level: normalizeLevel(level),
    event: typeof event === "string" ? event : "",
    message: truncateString(typeof msg === "string" ? msg : typeof message === "string" ? message : ""),
    requestId: typeof requestId === "string" ? requestId : "",
    conversationId: typeof conversationId === "string" ? conversationId : "",
    sessionId: typeof sessionId === "string" ? sessionId : "",
    azureRequestId: typeof azureRequestId === "string" ? azureRequestId : "",
    consumerKeyId: settings.redactApiKeyInfo ? "[REDACTED]" : typeof consumerKeyId === "string" ? consumerKeyId : "",
    modelId: typeof modelId === "string" ? modelId : "",
    actualModelName: typeof actualModelName === "string" ? actualModelName : "",
    routeKey: typeof routeKey === "string" ? routeKey : "",
    backendRouteKey: typeof backendRouteKey === "string" ? backendRouteKey : "",
    sourceProtocol: typeof sourceProtocol === "string" ? sourceProtocol : "",
    targetProtocol: typeof targetProtocol === "string" ? targetProtocol : "",
    stream: stream === true,
    attempt: Number.isInteger(attempt) ? attempt : null,
    source: typeof source === "string" ? source : "",
    status: Number.isFinite(status) ? status : null,
    errorCode: typeof errorCode === "string" ? errorCode : "",
    failureReason: truncateString(typeof failureReason === "string" ? failureReason : failureReason == null ? "" : String(failureReason)),
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    clientIp: settings.includeClientIp && typeof clientIp === "string" ? truncateString(clientIp, 512) : "",
    userAgent: typeof userAgent === "string" ? truncateString(userAgent, 1024) : "",
    forwardedFor: settings.includeClientIp && typeof forwardedFor === "string" ? truncateString(forwardedFor, 1024) : "",
    usageAvailable: settings.includeUsage && usageAvailable === true,
    usageSource: settings.includeUsage && typeof usageSource === "string" ? usageSource : "",
    usageEstimated: settings.includeUsage && usageEstimated === true,
    usageEstimationReason: settings.includeUsage && typeof usageEstimationReason === "string" ? usageEstimationReason : "",
    promptTokens: settings.includeUsage && Number.isFinite(promptTokens) ? Math.trunc(promptTokens) : null,
    completionTokens: settings.includeUsage && Number.isFinite(completionTokens) ? Math.trunc(completionTokens) : null,
    totalTokens: settings.includeUsage && Number.isFinite(totalTokens) ? Math.trunc(totalTokens) : null,
    cachedTokens: settings.includeUsage && Number.isFinite(cachedTokens) ? Math.trunc(cachedTokens) : null,
    estimatedCostAmount: settings.includeUsage && Number.isFinite(estimatedCostAmount) ? estimatedCostAmount : null,
    modelRouterCostAmount: settings.includeUsage && Number.isFinite(modelRouterCostAmount) ? modelRouterCostAmount : null,
    actualModelCostAmount: settings.includeUsage && Number.isFinite(actualModelCostAmount) ? actualModelCostAmount : null,
    currency: settings.includeUsage && typeof currency === "string" ? currency : "",
    requestPreview: typeof requestPreview === "string" ? truncateString(requestPreview, 4096) : "",
    responsePreview: typeof responsePreview === "string" ? truncateString(responsePreview, 4096) : "",
    requestBodyJson: typeof requestBodyJson === "string" ? requestBodyJson : "",
    responseBodyJson: typeof responseBodyJson === "string" ? responseBodyJson : "",
    requestBytes: Number.isInteger(requestBytes) ? requestBytes : null,
    responseBytes: Number.isInteger(responseBytes) ? responseBytes : null,
    requestSha256: typeof requestSha256 === "string" ? requestSha256 : "",
    responseSha256: typeof responseSha256 === "string" ? responseSha256 : "",
    requestTruncated: requestTruncated === true,
    responseTruncated: responseTruncated === true,
    requestMessageCount: Number.isInteger(requestMessageCount) ? requestMessageCount : 0,
    requestToolCount: Number.isInteger(requestToolCount) ? requestToolCount : 0,
    requestItemCount: Number.isInteger(requestItemCount) ? requestItemCount : 0,
    responseMessageCount: Number.isInteger(responseMessageCount) ? responseMessageCount : 0,
    responseToolCount: Number.isInteger(responseToolCount) ? responseToolCount : 0,
    responseItemCount: Number.isInteger(responseItemCount) ? responseItemCount : 0,
    fields: {
      ...sanitizeValue(rest, "", 0, settings),
      ...(typeof sourceProtocol === "string" ? { sourceProtocol } : {}),
      ...(typeof targetProtocol === "string" ? { targetProtocol } : {})
    }
  };
}

export function appendStructuredLog(level, payload = {}, options = {}) {
  return recordEntry(buildEntry({ ...payload, level }), options);
}

function ingestPinoLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    recordEntry(buildEntry({ level: "info", message: line, event: "stdout.raw" }), { emitConsole: false });
    return;
  }
  recordEntry(buildEntry(parsed), { emitConsole: false });
}

export function createPinoCaptureStream() {
  let buffered = "";

  return new Writable({
    write(chunk, encoding, callback) {
      const resolvedEncoding = typeof encoding === "string" && encoding && encoding !== "buffer"
        ? encoding
        : "utf8";
      const text = typeof chunk === "string" ? chunk : chunk.toString(resolvedEncoding);
      if (resolveLogSettings().sinks.has("console")) {
        process.stdout.write(text);
      }
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
    if (event && entry.event.toLowerCase() !== event) return false;
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