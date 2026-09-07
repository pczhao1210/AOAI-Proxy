function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeRouteProfile(routeKey) {
  if (routeKey === "chat/completions") return "chatCompletions";
  if (routeKey === "responses") return "responses";
  if (routeKey === "images/generations") return "imageGenerations";
  return routeKey;
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return value;
  }
  return undefined;
}

function resolveRetryStatuses(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.filter((item) => Number.isInteger(item));
    }
  }
  return [408, 409, 425, 429, 500, 502, 503, 504];
}

export function resolveUpstreamPolicy(config, options = {}) {
  const legacyCfg = config?.server?.upstream || {};
  const proxyCfg = asPlainObject(config?.proxy);
  const timeoutCfg = asPlainObject(proxyCfg.timeouts);
  const retryCfg = asPlainObject(proxyCfg.retries);
  const routeProfiles = asPlainObject(config?.routing?.routeProfiles);
  const routeProfile = asPlainObject(routeProfiles[normalizeRouteProfile(options.routeKey)]);
  const routeTimeouts = asPlainObject(routeProfile.timeouts || routeProfile.timeoutProfile);
  const modelTimeouts = asPlainObject(options.model?.timeoutProfile);
  const modelRetries = asPlainObject(options.model?.retryProfile);
  const upstreamTimeouts = asPlainObject(options.upstream?.timeoutProfile);
  const upstreamRetries = asPlainObject(options.upstream?.retryProfile);
  const requestOverrides = asPlainObject(options.requestOverrides);
  const imageGeneration = options.routeKey === "images/generations"
    ? asPlainObject(config?.media?.generation)
    : {};
  const retryStatuses = resolveRetryStatuses(
    requestOverrides.retryStatuses,
    modelRetries.statuses,
    upstreamRetries.statuses,
    retryCfg.statuses,
    legacyCfg.retryStatuses
  );
  return {
    connectTimeoutMs: pickInteger(
      requestOverrides.connectMs,
      modelTimeouts.connectMs,
      upstreamTimeouts.connectMs,
      routeTimeouts.connectMs,
      timeoutCfg.connectMs,
      legacyCfg.connectTimeoutMs,
      5000
    ),
    requestTimeoutMs: pickInteger(
      requestOverrides.requestMs,
      modelTimeouts.requestMs,
      upstreamTimeouts.requestMs,
      routeTimeouts.requestMs,
      imageGeneration.requestTimeoutMs,
      timeoutCfg.requestMs,
      legacyCfg.requestTimeoutMs,
      600000
    ),
    firstByteTimeoutMs: pickInteger(
      requestOverrides.firstByteMs,
      modelTimeouts.firstByteMs,
      upstreamTimeouts.firstByteMs,
      routeTimeouts.firstByteMs,
      timeoutCfg.firstByteMs,
      legacyCfg.firstByteTimeoutMs,
      90000
    ),
    idleTimeoutMs: pickInteger(
      requestOverrides.idleMs,
      modelTimeouts.idleMs,
      upstreamTimeouts.idleMs,
      routeTimeouts.idleMs,
      timeoutCfg.idleMs,
      legacyCfg.idleTimeoutMs,
      600000
    ),
    maxStreamDurationMs: pickInteger(
      requestOverrides.maxStreamDurationMs,
      modelTimeouts.maxStreamDurationMs,
      upstreamTimeouts.maxStreamDurationMs,
      routeTimeouts.maxStreamDurationMs,
      timeoutCfg.maxStreamDurationMs,
      0
    ),
    maxRetries: pickInteger(
      requestOverrides.maxRetries,
      modelRetries.maxRetries,
      upstreamRetries.maxRetries,
      retryCfg.maxRetries,
      legacyCfg.maxRetries,
      0
    ),
    retryBaseMs: pickInteger(
      requestOverrides.retryBaseMs,
      modelRetries.baseDelayMs,
      upstreamRetries.baseDelayMs,
      retryCfg.baseDelayMs,
      legacyCfg.retryBaseMs,
      800
    ),
    retryMaxMs: pickInteger(
      requestOverrides.retryMaxMs,
      modelRetries.maxDelayMs,
      upstreamRetries.maxDelayMs,
      retryCfg.maxDelayMs,
      legacyCfg.retryMaxMs,
      8000
    ),
    retryStatuses: new Set(retryStatuses),
    classifyNetworkErrorsAsRetryable: retryCfg.classifyNetworkErrorsAsRetryable !== false
  };
}

export function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) {
    return Promise.reject(markErrorWithCode(new Error("client disconnected"), "CLIENT_DISCONNECTED"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(markErrorWithCode(new Error("client disconnected"), "CLIENT_DISCONNECTED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  const code = String(error?.code || error?.cause?.code || "");
  const message = [error?.message, error?.cause?.message].filter(Boolean).map(String).join(": ");
  if (code === "CLIENT_DISCONNECTED") {
    return { code: "CLIENT_DISCONNECTED", retryable: false, status: 499, detail: message || "client disconnected" };
  }
  if (code === "UPSTREAM_STREAM_EVENT_TOO_LARGE") {
    return { code: "UPSTREAM_STREAM_EVENT_TOO_LARGE", retryable: false, status: 502, detail: message };
  }
  if (code === "UPSTREAM_INCOMPLETE_STREAM") {
    return { code: "UPSTREAM_INCOMPLETE_STREAM", retryable: false, status: 502, detail: message || "upstream stream ended before its completion marker" };
  }
  if (code === "UPSTREAM_RESPONSE_TOO_LARGE") {
    return { code: "UPSTREAM_RESPONSE_TOO_LARGE", retryable: false, status: 502, detail: message };
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return { code: "UPSTREAM_CONNECT_TIMEOUT", retryable: true, status: 504, detail: message || "connect timeout" };
  }
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
  if (code === "UPSTREAM_MAX_STREAM_DURATION") {
    return { code: "UPSTREAM_MAX_STREAM_DURATION", retryable: false, status: 504, detail: message };
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
    error: {
      message: resolvedMessage,
      type: resolvedType,
      code: resolvedCode,
      ...(resolvedParam != null ? { param: resolvedParam } : {})
    },
    code: classified.code,
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
  timeoutLabel = "connect",
  signal
}) {
  const controller = new AbortController();
  const abortFromClient = () => controller.abort("client-disconnected");
  if (signal?.aborted) abortFromClient();
  else signal?.addEventListener("abort", abortFromClient, { once: true });
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
    if (controller.signal.aborted && controller.signal.reason === "client-disconnected") {
      throw markErrorWithCode(error, "CLIENT_DISCONNECTED", "client disconnected");
    }
    if (controller.signal.aborted && controller.signal.reason === timeoutCode) {
      throw markErrorWithCode(error, timeoutCode, `${timeoutLabel} timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromClient);
  }
}

export function shouldRetryUpstream(policy, attempt, { status, classified, downstreamStarted = false } = {}) {
  if (downstreamStarted || attempt >= Math.max(1, policy.maxRetries + 1)) return false;
  if (status != null) return policy.retryStatuses.has(status);
  return !!classified?.retryable && policy.classifyNetworkErrorsAsRetryable !== false;
}

export async function fetchWithRetry({
  targetUrl,
  headers,
  bodyText,
  policy,
  logMeta,
  log,
  signal
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
        timeoutLabel: "first byte",
        signal
      });
      if (upstreamResponse.ok) {
        return { ok: true, upstreamResponse, attempt };
      }
      const classified = classifyHttpStatus(upstreamResponse.status);
      const upstreamContentType = upstreamResponse.headers.get("content-type") || "";
      const upstreamRetryAfter = upstreamResponse.headers.get("retry-after") || "";
      let detail = "";
      try {
        detail = await readTextWithTimeout(upstreamResponse, policy.requestTimeoutMs, 1024 * 1024, signal);
      } catch (readError) {
        const readFailure = classifyFetchError(readError);
        if (shouldRetryUpstream(policy, attempt, { classified: readFailure })) {
          const backoffMs = computeBackoffMs(policy, attempt);
          log.warn({ ...logMeta, attempt, backoffMs, errorCode: readFailure.code, detail: readFailure.detail }, "upstream retry on HTTP error body read failure");
          try {
            await sleep(backoffMs, signal);
          } catch (abortError) {
            const aborted = classifyFetchError(abortError);
            return { ok: false, classified: aborted, detail: aborted.detail, upstreamStatus: aborted.status, attempt };
          }
          continue;
        }
        return {
          ok: false,
          classified: readFailure,
          upstreamStatus: readFailure.status,
          detail: readFailure.detail,
          attempt
        };
      }
      const retryable = shouldRetryUpstream(policy, attempt, { status: upstreamResponse.status });
      if (retryable) {
        const backoffMs = computeBackoffMs(policy, attempt);
        log.warn({ ...logMeta, attempt, backoffMs, status: upstreamResponse.status, errorCode: classified.code }, "upstream retry on HTTP status");
        try {
          await sleep(backoffMs, signal);
        } catch (error) {
          const aborted = classifyFetchError(error);
          return { ok: false, classified: aborted, detail: aborted.detail, upstreamStatus: aborted.status, attempt };
        }
        continue;
      }
      return {
        ok: false,
        classified: { ...classified, retryable },
        hasUpstreamHttpResponse: true,
        upstreamStatus: upstreamResponse.status,
        upstreamContentType,
        upstreamRetryAfter,
        detail,
        attempt
      };
    } catch (error) {
      const classified = classifyFetchError(error);
      const retryable = shouldRetryUpstream(policy, attempt, { classified });
      if (retryable) {
        const backoffMs = computeBackoffMs(policy, attempt);
        log.warn({ ...logMeta, attempt, backoffMs, errorCode: classified.code, detail: classified.detail }, "upstream retry on fetch error");
        try {
          await sleep(backoffMs, signal);
        } catch (abortError) {
          const aborted = classifyFetchError(abortError);
          return { ok: false, classified: aborted, detail: aborted.detail, upstreamStatus: aborted.status, attempt };
        }
        continue;
      }
      return {
        ok: false,
        classified: { ...classified, retryable },
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

export async function readTextWithTimeout(response, timeoutMs, maxBytes = 0, signal) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw markErrorWithCode(new Error("response body unavailable"), "UPSTREAM_FETCH_FAILED");
  }
  let timedOut = false;
  let clientDisconnected = false;
  let totalBytes = 0;
  const chunks = [];
  const timerId = setTimeout(() => {
    timedOut = true;
    reader.cancel("request-timeout").catch(() => {});
  }, timeoutMs);
  const abortFromClient = () => {
    clientDisconnected = true;
    reader.cancel("client-disconnected").catch(() => {});
  };
  if (signal?.aborted) abortFromClient();
  else signal?.addEventListener("abort", abortFromClient, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (maxBytes > 0 && totalBytes > maxBytes) {
        reader.cancel("response-too-large").catch(() => {});
        throw markErrorWithCode(
          new Error(`Upstream response exceeds ${maxBytes} bytes`),
          "UPSTREAM_RESPONSE_TOO_LARGE"
        );
      }
      chunks.push(Buffer.from(value));
    }
    if (clientDisconnected) {
      throw markErrorWithCode(new Error("client disconnected"), "CLIENT_DISCONNECTED");
    }
    if (timedOut) {
      throw markErrorWithCode(new Error(`request timeout after ${timeoutMs}ms`), "UPSTREAM_REQUEST_TIMEOUT");
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } catch (error) {
    if (clientDisconnected && error?.code !== "CLIENT_DISCONNECTED") {
      throw markErrorWithCode(error, "CLIENT_DISCONNECTED", "client disconnected");
    }
    if (timedOut && error?.code !== "UPSTREAM_REQUEST_TIMEOUT") {
      throw markErrorWithCode(error, "UPSTREAM_REQUEST_TIMEOUT", `request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timerId);
    signal?.removeEventListener("abort", abortFromClient);
  }
}

export async function parseJsonWithTimeout(response, timeoutMs, maxBytes = 0, signal) {
  return JSON.parse(await readTextWithTimeout(response, timeoutMs, maxBytes, signal));
}
