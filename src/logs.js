import { Writable } from "node:stream";

const DEFAULT_MAX_LOG_ENTRIES = 1000;
const MAX_LOG_ENTRIES = (() => {
  const raw = Number(process.env.ADMIN_LOG_BUFFER_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_LOG_ENTRIES;
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
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
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
    azureRequestId,
    modelId,
    routeKey,
    backendRouteKey,
    source,
    status,
    errorCode,
    failureReason,
    latencyMs,
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
    fields: sanitizeValue(rest)
  };
}

export function appendStructuredLog(level, payload = {}) {
  return appendEntry(buildEntry({ ...payload, level }));
}

function ingestPinoLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    appendStructuredLog("info", { message: line, event: "stdout.raw" });
    return;
  }
  appendEntry(buildEntry(parsed));
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