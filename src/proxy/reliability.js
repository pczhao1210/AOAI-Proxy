export function resolveUpstreamPolicy(config) {
  const cfg = config?.server?.upstream || {};
  const retryStatuses = Array.isArray(cfg.retryStatuses) && cfg.retryStatuses.length
    ? cfg.retryStatuses
    : [408, 409, 425, 429, 500, 502, 503, 504];
  return {
    connectTimeoutMs: Number.isFinite(cfg.connectTimeoutMs) ? cfg.connectTimeoutMs : 5000,
    requestTimeoutMs: Number.isFinite(cfg.requestTimeoutMs) ? cfg.requestTimeoutMs : 120000,
    firstByteTimeoutMs: Number.isFinite(cfg.firstByteTimeoutMs) ? cfg.firstByteTimeoutMs : 30000,
    idleTimeoutMs: Number.isFinite(cfg.idleTimeoutMs) ? cfg.idleTimeoutMs : 45000,
    maxRetries: Number.isFinite(cfg.maxRetries) ? cfg.maxRetries : 2,
    retryBaseMs: Number.isFinite(cfg.retryBaseMs) ? cfg.retryBaseMs : 400,
    retryMaxMs: Number.isFinite(cfg.retryMaxMs) ? cfg.retryMaxMs : 5000,
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

export function buildErrorBody({ classified, requestId, detail, upstreamStatus }) {
  return {
    error: classified.code,
    code: classified.code,
    retryable: !!classified.retryable,
    requestId,
    upstreamStatus,
    detail: detail || classified.detail || ""
  };
}

export function markErrorWithCode(error, code, message) {
  const e = error instanceof Error ? error : new Error(message || String(error || ""));
  e.code = code;
  if (message) e.message = message;
  return e;
}

export async function fetchOnceWithConnectTimeout({ targetUrl, headers, bodyText, connectTimeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort("connect-timeout");
  }, connectTimeoutMs);
  try {
    return await fetch(targetUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "connect-timeout") {
      throw markErrorWithCode(error, "UPSTREAM_CONNECT_TIMEOUT", `connect timeout after ${connectTimeoutMs}ms`);
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
        connectTimeoutMs: policy.connectTimeoutMs
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

export async function parseJsonWithTimeout(response, timeoutMs) {
  let timerId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(markErrorWithCode(new Error(`request timeout after ${timeoutMs}ms`), "UPSTREAM_REQUEST_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([response.json(), timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}
