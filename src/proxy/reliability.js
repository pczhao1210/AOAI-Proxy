export function resolveUpstreamPolicy(config) {
  const cfg = config?.server?.upstream || {};
  const retryStatuses = Array.isArray(cfg.retryStatuses) && cfg.retryStatuses.length
    ? cfg.retryStatuses
    : [408, 409, 425, 429, 500, 502, 503, 504];
  return {
    connectTimeoutMs: Number.isFinite(cfg.connectTimeoutMs) ? cfg.connectTimeoutMs : 5000,
    requestTimeoutMs: Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : 600000,
    maxResponseBytes: Number.isFinite(cfg.maxResponseBytes) ? cfg.maxResponseBytes : 32 * 1024 * 1024,
    firstByteTimeoutMs: Number.isFinite(cfg.firstByteTimeoutMs) ? cfg.firstByteTimeoutMs : 90000,
    idleTimeoutMs: Number.isFinite(cfg.idleTimeoutMs) ? cfg.idleTimeoutMs : 600000,
    maxRetries: Number.isFinite(cfg.maxRetries) ? cfg.maxRetries : 1,
    retryBaseMs: Number.isFinite(cfg.retryBaseMs) ? cfg.retryBaseMs : 800,
    retryMaxMs: Number.isFinite(cfg.retryMaxMs) ? cfg.retryMaxMs : 8000,
    retryStatuses: new Set(retryStatuses)
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeBackoffMs(policy, attempt) {
  const exp = Math.max(0, attempt - 1);
  const base = Math.min(policy.retryMaxMs, policy.retryBaseMs * (2 ** exp));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.25)));
  return Math.min(policy.retryMaxMs, base + jitter);
}

export function classifyHttpStatus(status) {
  if (status === 429) {
    return { code: "UPSTREAM_RATE_LIMIT", retryable: true, status };
  }
  if (status >= 500) {
    return { code: "UPSTREAM_HTTP_5XX", retryable: true, status };
  }
  if (status >= 400) {
    return { code: "UPSTREAM_HTTP_4XX", retryable: false, status };
  }
  return { code: "UPSTREAM_HTTP_ERROR", retryable: false, status };
}

export function classifyFetchError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code === "UPSTREAM_CONNECT_TIMEOUT") {
    return { code: "UPSTREAM_CONNECT_TIMEOUT", retryable: true, status: 504, detail: message };
  }
  if (code === "UPSTREAM_REQUEST_TIMEOUT") {
    return { code: "UPSTREAM_REQUEST_TIMEOUT", retryable: true, status: 504, detail: message };
  }
  if (code === "UPSTREAM_FIRST_BYTE_TIMEOUT") {
    return { code: "UPSTREAM_FIRST_BYTE_TIMEOUT", retryable: true, status: 504, detail: message };
  }
  if (code === "UPSTREAM_IDLE_TIMEOUT") {
    return { code: "UPSTREAM_IDLE_TIMEOUT", retryable: true, status: 504, detail: message };
  }
  if (code === "UPSTREAM_RESPONSE_TOO_LARGE") {
    return { code: "UPSTREAM_RESPONSE_TOO_LARGE", retryable: false, status: 502, detail: message };
  }
  if (code === "UPSTREAM_STREAM_EVENT_TOO_LARGE") {
    return { code: "UPSTREAM_STREAM_EVENT_TOO_LARGE", retryable: false, status: 502, detail: message };
  }
  if (code === "UPSTREAM_PROVIDER_STREAM_ERROR") {
    return { code: "UPSTREAM_PROVIDER_STREAM_ERROR", retryable: false, status: 502, detail: message };
  }
  if (code === "UPSTREAM_INCOMPLETE_STREAM") {
    return { code: "UPSTREAM_INCOMPLETE_STREAM", retryable: false, status: 502, detail: message };
  }
  if (code === "CLIENT_DISCONNECTED") {
    return { code: "CLIENT_DISCONNECTED", retryable: false, status: 499, detail: message };
  }
  if (code === "ENOTFOUND" || message.includes("ENOTFOUND")) {
    return { code: "UPSTREAM_DNS_ERROR", retryable: true, status: 502, detail: message };
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") {
    return { code: "UPSTREAM_NETWORK_ERROR", retryable: true, status: 502, detail: message };
  }
  if (code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /tls|certificate/i.test(message)) {
    return { code: "UPSTREAM_TLS_ERROR", retryable: false, status: 502, detail: message };
  }
  if (error?.name === "AbortError") {
    return { code: "UPSTREAM_REQUEST_TIMEOUT", retryable: true, status: 504, detail: message || "request aborted" };
  }
  return { code: "UPSTREAM_FETCH_FAILED", retryable: true, status: 502, detail: message || "fetch failed" };
}

export function getProviderPayloadError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const explicitError = payload.error && typeof payload.error === "object"
    ? payload.error
    : null;
  const failed = payload.status === "failed"
    || payload.type === "error"
    || payload.type === "response.failed"
    || payload.object === "error"
    || explicitError != null;
  if (!failed) return null;
  const source = explicitError || payload;
  return {
    message: typeof source.message === "string" && source.message
      ? source.message
      : "upstream provider returned a failed response",
    code: typeof source.code === "string" && source.code
      ? source.code
      : "provider_response_failed",
    type: typeof source.type === "string" && source.type
      ? source.type
      : "provider_error",
    param: source.param ?? null
  };
}

function stringifyDetail(detail) {
  if (typeof detail === "string") return detail.trim();
  if (detail == null) return "";
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function parseDetail(detail) {
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail;
  }
  const detailText = stringifyDetail(detail);
  if (!detailText) return null;
  try {
    return JSON.parse(detailText);
  } catch {
    return null;
  }
}

function extractUpstreamError(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.error && typeof parsed.error === "object") return parsed.error;
  return parsed;
}

function buildDefaultMessage(classified, upstreamStatus) {
  if (upstreamStatus === 401 || classified?.status === 401) {
    return "Upstream returned 401 Unauthorized. Check auth.mode, credentials, and Azure RBAC or API key configuration.";
  }
  if (upstreamStatus === 403 || classified?.status === 403) {
    return "Upstream returned 403 Forbidden. Check whether the current credential has permission to access the target Azure OpenAI or Foundry resource.";
  }
  if (typeof upstreamStatus === "number") {
    return `Upstream request failed with status ${upstreamStatus}.`;
  }
  return classified?.detail || classified?.code || "request failed";
}

export function buildErrorBody({ classified, requestId, detail, upstreamStatus, message, code, param, type }) {
  const detailText = stringifyDetail(detail || classified?.detail || "");
  const parsedDetail = parseDetail(detail);
  const upstreamError = extractUpstreamError(parsedDetail);
  const resolvedMessage =
    (typeof message === "string" && message.trim())
    || (typeof upstreamError?.message === "string" && upstreamError.message.trim())
    || (typeof upstreamError?.error_description === "string" && upstreamError.error_description.trim())
    || (typeof upstreamError?.detail === "string" && upstreamError.detail.trim())
    || (typeof upstreamError?.error === "string" && upstreamError.error.trim())
    || buildDefaultMessage(classified, upstreamStatus);
  const resolvedCode =
    (typeof code === "string" && code.trim())
    || (typeof upstreamError?.code === "string" && upstreamError.code.trim())
    || classified.code;
  const resolvedType =
    (typeof type === "string" && type.trim())
    || (typeof upstreamError?.type === "string" && upstreamError.type.trim())
    || classified.code;
  const resolvedParam = param ?? upstreamError?.param;

  return {
    error: resolvedCode,
    message: resolvedMessage,
    type: resolvedType,
    code: classified.code,
    upstreamCode: resolvedCode,
    ...(resolvedParam != null ? { param: resolvedParam } : {}),
    retryable: !!classified.retryable,
    requestId,
    upstreamStatus,
    detail: detailText
  };
}

export function markErrorWithCode(error, code, message) {
  const e = error instanceof Error ? error : new Error(message || String(error || ""));
  e.code = code;
  if (message) e.message = message;
  return e;
}

export async function fetchOnceWithConnectTimeout({
  targetUrl,
  headers,
  bodyText,
  connectTimeoutMs,
  timeoutMs = connectTimeoutMs,
  timeoutCode = "UPSTREAM_CONNECT_TIMEOUT",
  timeoutLabel = "connect"
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(timeoutCode);
  }, timeoutMs);
  try {
    return await fetch(targetUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutCode) {
      throw markErrorWithCode(error, timeoutCode, `${timeoutLabel} timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetry({
  targetUrl,
  headers,
  bodyText,
  policy,
  logMeta,
  log
}) {
  const maxAttempts = Math.max(1, policy.maxRetries + 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const upstreamResponse = await fetchOnceWithConnectTimeout({
        targetUrl,
        headers,
        bodyText,
        connectTimeoutMs: policy.connectTimeoutMs,
        timeoutMs: policy.firstByteTimeoutMs,
        timeoutCode: "UPSTREAM_FIRST_BYTE_TIMEOUT",
        timeoutLabel: "first byte"
      });
      if (upstreamResponse.ok) {
        return { ok: true, upstreamResponse, attempt };
      }
      const classified = classifyHttpStatus(upstreamResponse.status);
      const detail = await upstreamResponse.text().catch(() => "");
      const retryableStatus = policy.retryStatuses.has(upstreamResponse.status) || classified.retryable;
      if (attempt < maxAttempts && retryableStatus) {
        const backoffMs = computeBackoffMs(policy, attempt);
        log.warn({ ...logMeta, attempt, backoffMs, status: upstreamResponse.status, errorCode: classified.code }, "upstream retry on HTTP status");
        await sleep(backoffMs);
        continue;
      }
      return {
        ok: false,
        classified: { ...classified, retryable: retryableStatus && attempt < maxAttempts },
        upstreamStatus: upstreamResponse.status,
        detail,
        attempt
      };
    } catch (error) {
      const classified = classifyFetchError(error);
      if (attempt < maxAttempts && classified.retryable) {
        const backoffMs = computeBackoffMs(policy, attempt);
        log.warn({ ...logMeta, attempt, backoffMs, errorCode: classified.code, detail: classified.detail }, "upstream retry on fetch error");
        await sleep(backoffMs);
        continue;
      }
      return {
        ok: false,
        classified,
        detail: classified.detail,
        upstreamStatus: classified.status,
        attempt
      };
    }
  }
  return {
    ok: false,
    classified: { code: "UPSTREAM_FETCH_FAILED", retryable: false, status: 502 },
    detail: "unexpected retry loop exit",
    upstreamStatus: 502,
    attempt: 0
  };
}

export async function parseJsonWithTimeout(response, timeoutMs, maxBytes = 0) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw markErrorWithCode(new Error("response body unavailable"), "UPSTREAM_FETCH_FAILED");
  }
  let timedOut = false;
  let totalBytes = 0;
  const chunks = [];
  const timerId = setTimeout(() => {
    timedOut = true;
    reader.cancel("request-timeout").catch(() => {});
  }, timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        await reader.cancel("response-too-large").catch(() => {});
        throw markErrorWithCode(
          new Error(`upstream response exceeds ${maxBytes} bytes`),
          "UPSTREAM_RESPONSE_TOO_LARGE"
        );
      }
      chunks.push(Buffer.from(value));
    }
    if (timedOut) {
      throw markErrorWithCode(
        new Error(`request timeout after ${timeoutMs}ms`),
        "UPSTREAM_REQUEST_TIMEOUT"
      );
    }
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
  } catch (error) {
    if (timedOut && error?.code !== "UPSTREAM_REQUEST_TIMEOUT") {
      throw markErrorWithCode(
        error,
        "UPSTREAM_REQUEST_TIMEOUT",
        `request timeout after ${timeoutMs}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timerId);
    reader.releaseLock();
  }
}
