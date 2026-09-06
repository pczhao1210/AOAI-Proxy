import { getUpstreamAuthHeaders } from "./auth.js";
import { appendStructuredLog, buildContentLogSnapshot, resolveLogContentMode } from "./logs.js";
import { recordError, recordRequest, recordUsage } from "./stats.js";
import { recordRuntimeError, recordRuntimeRequest, recordRuntimeUsage } from "./runtime-store.js";
import { getDescriptorProtocolProfile, resolveModelDescriptor } from "./model-catalog.js";
import {
  findUpstream,
  findModel,
  buildUpstreamUrl,
  buildMessagesCountTokensUrl,
  buildResponsesCompactUrl,
  isPublicRouteEnabled,
  reconcileBackendRouteKey,
  resolveRoutePlan,
  resolveUpstreamBaseUrl,
  hasUsableUpstreamBaseUrl
} from "./proxy/routing.js";
import {
  sanitizeIncomingHeaders,
  sanitizeConfiguredUpstreamHeaders,
  getStreamFlag,
  sanitizeRequestBody,
  extractProxyRequestControls,
  maybeCompressImages
} from "./proxy/body.js";
import { prepareImageGenerationRequest } from "./proxy/image-adapter.js";
import {
  chatToMessagesRequest,
  chatToResponsesRequest,
  mapChatCompletionJsonToMessages,
  responsesToChatRequest,
  responsesToMessagesRequest,
  sanitizeChatToolTranscript,
  mapMessagesJsonToChatCompletion,
  mapMessagesJsonToResponses,
  mapResponsesJsonToChatCompletion,
  mapResponsesJsonToMessages,
  mapChatCompletionJsonToResponses,
  getProtocolShimCompatibilityIssue,
  messagesToChatRequest,
  messagesToResponsesRequest,
  normalizeWebSearchToolType
} from "./proxy/shim.js";
import {
  resolveUpstreamPolicy,
  sleep,
  computeBackoffMs,
  classifyHttpStatus,
  classifyFetchError,
  buildErrorBody,
  fetchOnceWithConnectTimeout,
  fetchWithRetry,
  parseJsonWithTimeout,
  readTextWithTimeout
} from "./proxy/reliability.js";
import {
  setSseResponseHeaders,
  writeSseError,
  writeSseDoneFrame,
  streamPassthrough,
  streamShim
} from "./proxy/stream.js";
import {
  DEBUG_LATENCY_HEADER_NAME,
  hasEnabledDebugLatencyHeader
} from "./proxy/debug-latency.js";
import {
  checkConsumerModelAccess,
  acquireRequestGovernance,
  noteGovernanceError,
  recordGovernanceUsage
} from "./governance.js";
import { getRequestNetworkContext } from "./request-network.js";
import { buildCorrelationHeaders, getRequestContext } from "./request-context.js";

const DEFAULT_MAX_RESPONSE_BODY_BYTES = 50 * 1024 * 1024;
const TEXT_PROTOCOL_ROUTE_KEYS = new Set(["chat/completions", "responses", "messages"]);
const MESSAGES_COUNT_TOKENS_ROUTE_KEY = "messages/count_tokens";
const RESPONSES_COMPACT_ROUTE_KEY = "responses/compact";
const ANTHROPIC_REQUEST_HEADERS = new Set(["anthropic-version", "anthropic-beta"]);
const ANTHROPIC_SDK_METADATA_HEADER_PREFIXES = ["x-anthropic-", "x-claude-", "x-stainless-"];
const ANTHROPIC_HEADER_PREFIXES = ["anthropic-", ...ANTHROPIC_SDK_METADATA_HEADER_PREFIXES];
const VALID_ANTHROPIC_CACHE_TTLS = new Set(["5m", "1h"]);

function anthropicCompatibility(config) {
  return config?.compatibility?.anthropic || {};
}

function protocolShimCompatibility(config) {
  return config?.compatibility?.protocolShim || {};
}

function forwardAnthropicSdkMetadataHeaders(config) {
  return anthropicCompatibility(config).forwardSdkMetadataHeaders !== false;
}

function isDirectAnthropicUpstream(upstream, targetUrl) {
  const provider = String(upstream?.provider || "").trim().toLowerCase();
  if (["anthropic", "anthropic-api"].includes(provider)) return true;
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function isSupportedAnthropicCacheLocation(path) {
  if (path.length === 0) return true;
  if (path.length === 2 && path[0] === "tools" && Number.isInteger(path[1])) return true;
  if (path.length === 2 && path[0] === "system" && Number.isInteger(path[1])) return true;
  return path.length === 4
    && path[0] === "messages"
    && Number.isInteger(path[1])
    && path[2] === "content"
    && Number.isInteger(path[3]);
}

function sanitizeAnthropicCacheControls(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => sanitizeAnthropicCacheControls(item, [...path, index]));
    return;
  }
  if (!value || typeof value !== "object") return;

  const currentType = typeof value.type === "string" ? value.type : "";
  if ("cache_control" in value) {
    const cacheControl = value.cache_control;
    const ttl = typeof cacheControl?.ttl === "string" ? cacheControl.ttl : "";
    if (
      !isSupportedAnthropicCacheLocation(path)
      || currentType === "thinking"
      || currentType === "redacted_thinking"
      || (currentType === "text" && !String(value.text || ""))
      || !cacheControl
      || typeof cacheControl !== "object"
      || Array.isArray(cacheControl)
      || cacheControl.type !== "ephemeral"
      || (ttl && !VALID_ANTHROPIC_CACHE_TTLS.has(ttl))
    ) {
      delete value.cache_control;
    } else {
      value.cache_control = {
        type: "ephemeral",
        ...(ttl ? { ttl } : {})
      };
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "cache_control") sanitizeAnthropicCacheControls(child, [...path, key]);
  }
}

function resolveConfiguredAnthropicModelValues(config, profileName, modelId, model) {
  const profiles = anthropicCompatibility(config)[profileName];
  if (!profiles || typeof profiles !== "object") return null;
  for (const candidate of [modelId, model?.targetModel, model?.id, model?.pricingRef]) {
    const modelName = String(candidate || "").trim().toLowerCase();
    const values = profiles[modelName];
    if (Array.isArray(values) && values.length > 0) return values;
  }
  return null;
}

function resolveAnthropicModelPolicy(config, profileName, modelId, model, descriptor) {
  const configuredValues = resolveConfiguredAnthropicModelValues(config, profileName, modelId, model);
  const catalogProfile = getDescriptorProtocolProfile(descriptor, "messages");
  const catalogPolicy = profileName === "thinkingTypesByModel"
    ? catalogProfile?.thinking
    : catalogProfile?.reasoning;
  return {
    values: configuredValues || catalogPolicy?.types || catalogPolicy?.levels || null,
    aliases: catalogPolicy?.aliases || {},
    validation: configuredValues ? "strict" : catalogPolicy?.validation || "passthrough"
  };
}

function applyAnthropicBodyCompatibility(body, config, modelId, model, descriptor) {
  if (!body || typeof body !== "object") return null;
  const policy = anthropicCompatibility(config);
  const thinkingType = typeof body.thinking?.type === "string"
    ? body.thinking.type.trim()
    : "";
  if (thinkingType && policy.validateThinkingByModel !== false) {
    const thinkingPolicy = resolveAnthropicModelPolicy(
      config,
      "thinkingTypesByModel",
      modelId,
      model,
      descriptor
    );
    if (thinkingPolicy.validation === "strict" && thinkingPolicy.values && !thinkingPolicy.values.includes(thinkingType)) {
      return {
        param: "thinking.type",
        message: `thinking.type=${thinkingType} is not supported by ${modelId}; use ${thinkingPolicy.values.join(" or ")}`
      };
    }
  }
  const effort = typeof body.output_config?.effort === "string"
    ? body.output_config.effort.trim().toLowerCase()
    : "";
  if (effort && policy.validateThinkingByModel !== false) {
    const effortPolicy = resolveAnthropicModelPolicy(
      config,
      "effortLevelsByModel",
      modelId,
      model,
      descriptor
    );
    const normalizedEffort = effortPolicy.aliases[effort] || effort;
    if (effortPolicy.validation === "strict" && effortPolicy.values && !effortPolicy.values.includes(normalizedEffort)) {
      return {
        param: "output_config.effort",
        message: `output_config.effort=${effort} is not supported by ${modelId}; use ${effortPolicy.values.join(" or ")}`
      };
    }
    body.output_config.effort = normalizedEffort;
  }
  if (policy.normalizeManualThinkingToolChoice !== false && body.thinking?.type === "enabled") {
    const choiceType = body.tool_choice?.type;
    if (choiceType === "any" || choiceType === "tool") {
      body.tool_choice = {
        ...body.tool_choice,
        type: "auto"
      };
      delete body.tool_choice.name;
    }
  }
  if (policy.sanitizeCacheControl !== false) {
    sanitizeAnthropicCacheControls(body);
  }
  return null;
}

function sanitizeToolControlsWithoutTools(body) {
  if (!body || typeof body !== "object") return;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasLegacyFunctions = Array.isArray(body.functions) && body.functions.length > 0;
  if (hasTools || hasLegacyFunctions) return;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.function_call;
}

function applyAnthropicBetaPolicy(headers, config, { upstream, targetUrl } = {}) {
  const policy = anthropicCompatibility(config);
  const allowUnknownBetas = policy.unknownBetaPolicy !== "allowlist"
    && isDirectAnthropicUpstream(upstream, targetUrl);
  const allowed = new Set(normalizeStringList(policy.betaAllowlist));
  const seen = new Set();
  const accepted = [];
  const filtered = [];
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== "anthropic-beta") continue;
    const values = String(headers[headerName] || "").split(",");
    delete headers[headerName];
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      if (!allowUnknownBetas && policy.betaAllowlistEnabled !== false && !allowed.has(value)) {
        filtered.push(value);
        continue;
      }
      accepted.push(value);
    }
  }
  if (accepted.length) headers["anthropic-beta"] = accepted.join(",");
  return filtered;
}

function emitInfoLog(payload) {
  const normalizedPayload = {
    source: "proxy",
    ...payload
  };
  appendStructuredLog("info", normalizedPayload);
}

function stringifyLogValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractFailureDetails(detail) {
  const detailText = stringifyLogValue(detail).trim();
  let parsed = null;

  if (detail && typeof detail === "object") {
    parsed = detail;
  } else if (detailText) {
    try {
      parsed = JSON.parse(detailText);
    } catch {
      parsed = null;
    }
  }

  const upstreamError = parsed && typeof parsed === "object"
    ? (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed)
    : null;
  const innerMessage = upstreamError?.innererror?.message || upstreamError?.inner_error?.message || "";

  return {
    failureReason: upstreamError?.message || detailText || "",
    ...(detailText ? { detail: detailText } : {}),
    ...(upstreamError ? { upstreamError } : {}),
    ...(typeof upstreamError?.code === "string" && upstreamError.code ? { upstreamCode: upstreamError.code } : {}),
    ...(typeof upstreamError?.type === "string" && upstreamError.type ? { upstreamType: upstreamError.type } : {}),
    ...(upstreamError?.param != null ? { upstreamParam: String(upstreamError.param) } : {}),
    ...(innerMessage ? { upstreamInnerMessage: innerMessage } : {})
  };
}

function getProviderPayloadError(payload) {
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

function restorePublicResponseModel(payload, modelId) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || typeof payload.model !== "string"
    || !modelId
    || payload.model === modelId
  ) {
    return payload;
  }
  return { ...payload, model: modelId };
}

function markTiming(timing, key) {
  if (!timing.enabled) {
    return;
  }
  if (!Number.isFinite(timing[key])) {
    timing[key] = Date.now();
  }
}

function diffTiming(startAt, endAt) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) {
    return null;
  }
  return endAt - startAt;
}

function buildTimingFields(timing) {
  return {
    preAuthMs: diffTiming(timing.startAt, timing.authStartAt),
    authPrepareMs: diffTiming(timing.authStartAt, timing.authReadyAt),
    requestPrepareMs: diffTiming(timing.authReadyAt, timing.requestPreparedAt),
    governanceAcquireMs: diffTiming(timing.governanceStartAt, timing.governanceReadyAt),
    preUpstreamMs: diffTiming(timing.startAt, timing.upstreamRequestAt),
    upstreamHeadersMs: diffTiming(timing.upstreamRequestAt, timing.upstreamHeadersAt),
    upstreamFirstChunkMs: diffTiming(timing.upstreamRequestAt, timing.firstChunkAt),
    firstChunkLatencyMs: diffTiming(timing.startAt, timing.firstChunkAt),
    totalDurationMs: diffTiming(timing.startAt, timing.completedAt),
    upstreamAttempts: timing.upstreamAttempts || 0
  };
}

function emitTimingLog({
  requestContext,
  requestNetworkContext,
  modelId,
  routeKey,
  backendRouteKey,
  stream,
  status,
  outcome,
  errorCode,
  source = "proxy",
  timing
}) {
  const timingFields = buildTimingFields(timing);
  emitInfoLog({
    ...requestContext,
    ...requestNetworkContext,
    modelId,
    routeKey,
    backendRouteKey,
    stream: !!stream,
    status,
    source,
    event: "proxy.request_timing",
    errorCode,
    outcome,
    latencyMs: timingFields.totalDurationMs,
    ...timingFields,
    message: "proxy request timing"
  });
}

function normalizeRouteProfileKey(routeKey) {
  if (routeKey === "chat/completions") return "chatCompletions";
  if (routeKey === "images/generations") return "imageGenerations";
  return routeKey;
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function getPositiveByteLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function isAllowedByAllNonEmptyLists(fieldName, lists) {
  for (const list of lists) {
    if (list.size > 0 && !list.has(fieldName)) return false;
  }
  return true;
}

function applyConfiguredRequestPolicy(body, { config, routeKey, model, upstream }) {
  if (!body || typeof body !== "object") return null;
  const routeProfile = config?.routing?.routeProfiles?.[normalizeRouteProfileKey(routeKey)] || {};
  const routeAllowed = new Set(normalizeStringList(routeProfile.allowedRequestFields));
  const modelPolicy = model?.requestPolicy || {};
  const modelAllowed = new Set(normalizeStringList(modelPolicy.allowedParams));
  const modelBlocked = new Set(normalizeStringList(modelPolicy.blockedParams));
  const upstreamPolicy = upstream?.requestPolicy || {};
  const upstreamAllowed = new Set(normalizeStringList(upstreamPolicy.allowedParams));
  const upstreamBlocked = new Set(normalizeStringList(upstreamPolicy.blockedParams));
  const dropUnsupported = modelPolicy.dropUnsupportedParams === true
    || upstreamPolicy.dropUnsupportedParams === true
    || config?.proxy?.guards?.dropUnsupportedOpenAiParams === true;
  const rejectedFields = [];

  for (const fieldName of Object.keys(body)) {
    if (fieldName === "model") continue;
    const blocked = modelBlocked.has(fieldName) || upstreamBlocked.has(fieldName);
    const allowed = isAllowedByAllNonEmptyLists(fieldName, [routeAllowed, modelAllowed, upstreamAllowed]);
    if (!blocked && allowed) continue;
    if (dropUnsupported) {
      delete body[fieldName];
      continue;
    }
    rejectedFields.push(fieldName);
  }

  if (!rejectedFields.length) return null;
  return {
    param: rejectedFields[0],
    fields: rejectedFields,
    message: `Unsupported request field${rejectedFields.length > 1 ? "s" : ""}: ${rejectedFields.join(", ")}`
  };
}

function sendNativeErrorResponse(reply, { status, payload, contentType, retryAfter, requestId }) {
  if (requestId) reply.header("x-request-id", requestId);
  if (typeof contentType === "string" && contentType.trim()) {
    reply.header("content-type", contentType);
  }
  if (typeof retryAfter === "string" && retryAfter.trim()) {
    reply.header("retry-after", retryAfter);
  }
  reply.code(status).send(payload);
}

function validateImageGenerationPolicy(body, config) {
  const generation = config?.media?.generation || {};
  const maxImages = Number.isInteger(generation.maxImages) && generation.maxImages > 0
    ? generation.maxImages
    : 4;
  const imageCount = body?.n == null ? 1 : Number(body.n);
  if (!Number.isInteger(imageCount) || imageCount <= 0 || imageCount > maxImages) {
    return { param: "n", message: `n must be an integer between 1 and ${maxImages}` };
  }
  const allowedSizes = normalizeStringList(generation.allowedSizes);
  if (allowedSizes.length && body?.size != null && !allowedSizes.includes(String(body.size))) {
    return { param: "size", message: `size must be one of: ${allowedSizes.join(", ")}` };
  }
  const allowedQualityModes = normalizeStringList(generation.allowedQualityModes);
  if (allowedQualityModes.length && body?.quality != null && !allowedQualityModes.includes(String(body.quality))) {
    return { param: "quality", message: `quality must be one of: ${allowedQualityModes.join(", ")}` };
  }
  return null;
}

function buildContentSnapshotFields(prefix, snapshot) {
  return {
    [`${prefix}Preview`]: snapshot.preview,
    [`${prefix}BodyJson`]: snapshot.bodyJson,
    [`${prefix}Bytes`]: snapshot.bytes,
    [`${prefix}Sha256`]: snapshot.sha256,
    [`${prefix}Truncated`]: snapshot.truncated,
    [`${prefix}MessageCount`]: snapshot.messageCount,
    [`${prefix}ToolCount`]: snapshot.toolCount,
    [`${prefix}ItemCount`]: snapshot.itemCount
  };
}

function estimateLocalTokensFromBytes(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? Math.max(1, Math.ceil(bytes / 4)) : 0;
}

function estimateSemanticTextBytes(value) {
  const visited = new WeakSet();
  let totalBytes = 0;

  const visit = (current, key = "", parentType = "") => {
    if (typeof current === "string") {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const mediaValue = /(?:image|audio|file|blob|bytes|base64|b64)/.test(normalizedKey)
        || /(?:image|audio|file|screenshot)/.test(parentType);
      const encodedValue = /^data:[^,]*;base64,/i.test(current)
        || (
          current.length >= 256
          && current.length % 4 === 0
          && !/\s/.test(current)
          && /^[A-Za-z0-9+/_-]+={0,2}$/.test(current)
        );
      if (!mediaValue && !encodedValue) totalBytes += Buffer.byteLength(current, "utf8");
      return;
    }
    if (!current || typeof current !== "object" || visited.has(current)) return;
    visited.add(current);
    const currentType = typeof current.type === "string" ? current.type.toLowerCase() : parentType;
    for (const [childKey, childValue] of Object.entries(current)) {
      visit(childValue, childKey, currentType);
    }
  };

  visit(value);
  return totalBytes;
}

function createStreamContentCollector(maxPayloadBytes) {
  const configuredLimit = Number(maxPayloadBytes);
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0
    ? Math.min(configuredLimit, 10 * 1024 * 1024)
    : 102400;
  let captured = "";
  let capturedBytes = 0;
  let observedBytes = 0;
  let truncated = false;
  let lastKind = "";

  return {
    append(value, kind = "text") {
      if (typeof value !== "string" || !value) return;
      const separator = kind === "tool" && lastKind !== "tool" ? "\n[tool]\n" : "";
      const semanticChunk = `${separator}${value}`;
      const chunkBytes = Buffer.from(semanticChunk, "utf8");
      observedBytes += chunkBytes.length;
      lastKind = kind;
      const remaining = limit - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const retained = chunkBytes.length <= remaining ? chunkBytes : chunkBytes.subarray(0, remaining);
      captured += retained.toString("utf8").replace(/\ufffd$/, "");
      capturedBytes += retained.length;
      if (retained.length < chunkBytes.length) truncated = true;
    },
    finish() {
      return {
        payload: {
          output: [{ type: "stream_text", text: captured }]
        },
        observedBytes,
        capturedBytes,
        truncated
      };
    }
  };
}

export async function proxyRequest({
  config,
  routeKey,
  req,
  reply
}) {
  const isMessagesCountTokens = routeKey === MESSAGES_COUNT_TOKENS_ROUTE_KEY;
  const isResponsesCompact = routeKey === RESPONSES_COMPACT_ROUTE_KEY;
  const isNativeUtilityRequest = isMessagesCountTokens || isResponsesCompact;
  const protocolRouteKey = isMessagesCountTokens
    ? "messages"
    : isResponsesCompact
      ? "responses"
      : routeKey;
  const consumer = req.proxyAccess?.consumer || { keyId: "anonymous", displayName: "anonymous", isAnonymous: true, apiKey: null };
  const startAt = Date.now();
  const requestContext = getRequestContext(req);
  const { requestId, conversationId, sessionId } = requestContext;
  const requestNetworkContext = getRequestNetworkContext(config, req);
  const timing = {
    enabled: hasEnabledDebugLatencyHeader(req.headers[DEBUG_LATENCY_HEADER_NAME]),
    startAt,
    authStartAt: null,
    authReadyAt: null,
    requestPreparedAt: null,
    governanceStartAt: null,
    governanceReadyAt: null,
    upstreamRequestAt: null,
    upstreamHeadersAt: null,
    firstChunkAt: null,
    completedAt: null,
    upstreamAttempts: 0
  };
  let isStream = false;
  let governanceLease = null;
  const log = req.log.child(requestContext);
  const finishTiming = ({ status = null, outcome = "", errorCode = "", source = "proxy" } = {}) => {
    if (!timing.enabled) {
      return;
    }
    const hasObservablePhase = Number.isFinite(timing.authStartAt)
      || Number.isFinite(timing.governanceStartAt)
      || Number.isFinite(timing.upstreamRequestAt);
    if (!hasObservablePhase || Number.isFinite(timing.completedAt)) {
      return;
    }
    markTiming(timing, "completedAt");
    emitTimingLog({
      requestContext,
      requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      stream: isStream,
      status,
      outcome,
      errorCode,
      source,
      timing
    });
  };
  const sendProxyError = (status, options = {}) => {
    const classified = {
      code: options.code || "PROXY_ERROR",
      retryable: !!options.retryable,
      status
    };
    reply.code(status).send(buildErrorBody({
      classified,
      requestId,
      detail: options.detail ?? options.message,
      upstreamStatus: options.upstreamStatus,
      message: options.message,
      code: options.exposedCode,
      param: options.param,
      type: options.type
    }));
  };
  const rawBody = isNativeUtilityRequest && req.body && typeof req.body === "object"
    ? structuredClone(req.body)
    : req.body || {};
  let body = sanitizeRequestBody(rawBody, {
    preserveNull: protocolRouteKey === "responses",
    sanitizeMeaninglessValues: config?.proxy?.guards?.sanitizeMeaninglessValues !== false
  });
  let requestOverrides = {};
  try {
    const extractedControls = extractProxyRequestControls(body, config);
    body = extractedControls.body;
    requestOverrides = extractedControls.overrides;
    if (extractedControls.rejectedFields.length) {
      sendProxyError(400, {
        code: "UNKNOWN_PROXY_CONTROL_FIELDS",
        exposedCode: "UnknownProxyControlFields",
        message: `Unsupported proxy control fields: ${extractedControls.rejectedFields.join(", ")}`,
        detail: { fields: extractedControls.rejectedFields }
      });
      return;
    }
  } catch (error) {
    sendProxyError(error?.status || 400, {
      code: "INVALID_PROXY_CONTROL_FIELD",
      exposedCode: error?.code || "InvalidProxyControlField",
      message: error?.message || "Invalid proxy control field"
    });
    return;
  }
  const routeProfile = config?.routing?.routeProfiles?.[normalizeRouteProfileKey(protocolRouteKey)] || {};
  if (!isPublicRouteEnabled(config, protocolRouteKey)) {
    sendProxyError(404, {
      code: "ROUTE_DISABLED",
      exposedCode: "RouteDisabled",
      message: `route ${routeKey} is disabled`
    });
    return;
  }
  const defaultModelId = routeKey === "images/generations"
    ? config?.media?.generation?.defaultModel || config.models[0]?.id
    : config.models[0]?.id;
  const modelId = body.model || defaultModelId;
  if (!modelId) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      routeKey,
      status: 400,
      event: "proxy.request_rejected",
      errorCode: "MODEL_REQUIRED",
      failureReason: "model is required"
    }, "request rejected: model is required");
    sendProxyError(400, {
      code: "MODEL_REQUIRED",
      message: "model is required"
    });
    return;
  }
  const model = findModel(config, modelId);
  if (!model) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      status: 404,
      event: "proxy.request_rejected",
      errorCode: "MODEL_NOT_FOUND",
      failureReason: `model ${modelId} not found`
    }, "request rejected: model not found");
    sendProxyError(404, {
      code: "MODEL_NOT_FOUND",
      message: `model ${modelId} not found`
    });
    return;
  }
  const modelDescriptor = resolveModelDescriptor(modelId);

  body = isNativeUtilityRequest
    ? { ...body, model: modelId }
    : {
      ...(routeProfile.defaultParams && typeof routeProfile.defaultParams === "object" ? routeProfile.defaultParams : {}),
      ...(model.defaultParams && typeof model.defaultParams === "object" ? model.defaultParams : {}),
      ...body,
      model: modelId
    };
  if (routeKey === "images/generations") {
    const imagePolicyError = validateImageGenerationPolicy(body, config);
    if (imagePolicyError) {
      sendProxyError(400, {
        code: "IMAGE_GENERATION_POLICY_REJECTED",
        exposedCode: "InvalidImageGenerationRequest",
        message: imagePolicyError.message,
        param: imagePolicyError.param
      });
      return;
    }
  }

  if (routeKey === "chat/completions" && Array.isArray(body.messages)) {
    const sanitizedToolTranscript = sanitizeChatToolTranscript(body.messages);
    if (sanitizedToolTranscript.changed) {
      body = {
        ...body,
        messages: sanitizedToolTranscript.messages
      };
      log.info({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        event: "proxy.tool_transcript_sanitized",
        droppedToolMessages: sanitizedToolTranscript.droppedToolMessages,
        droppedAssistantTurns: sanitizedToolTranscript.droppedAssistantTurns
      }, "sanitized malformed tool transcript in request messages");
    }
  }

  const modelAccess = checkConsumerModelAccess(consumer, model);
  if (!modelAccess.ok) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      status: modelAccess.status || 403,
      event: "proxy.request_rejected",
      errorCode: modelAccess.code,
      failureReason: modelAccess.message
    }, modelAccess.message);
    sendProxyError(modelAccess.status || 403, {
      code: modelAccess.code || "MODEL_ACCESS_DENIED",
      exposedCode: modelAccess.error || modelAccess.code || "ModelAccessDenied",
      message: modelAccess.message
    });
    return;
  }
  const upstream = findUpstream(config, model.upstream);
  if (!upstream) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.upstream_missing",
      errorCode: "UPSTREAM_NOT_FOUND",
      failureReason: `upstream ${model.upstream} not found`
    }, "configured upstream not found");
    sendProxyError(500, {
      code: "UPSTREAM_NOT_FOUND",
      message: `upstream ${model.upstream} not found`
    });
    return;
  }

  if (!hasUsableUpstreamBaseUrl(upstream, { routeKey: protocolRouteKey, model, descriptor: modelDescriptor })) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.upstream_invalid",
      errorCode: "INVALID_UPSTREAM_CONFIG",
      failureReason: "upstream baseUrl placeholder is still present"
    }, "invalid upstream baseUrl placeholder");
    sendProxyError(500, {
      code: "INVALID_UPSTREAM_CONFIG",
      exposedCode: "InvalidUpstreamConfig",
      message:
        "upstreams[].baseUrl 或 upstreams[].resourceName 无效：请填写真实 Azure 资源域名，或仅填写 resourceName 让代理自动拼接 *.openai.azure.com / *.services.ai.azure.com"
    });
    return;
  }
  const buildRequestRoutePlan = (override) => {
    try {
      return resolveRoutePlan({
        routeKey: protocolRouteKey,
        model,
        upstream,
        ...(override ? { override } : {}),
        descriptor: modelDescriptor
      });
    } catch (error) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        status: 400,
        event: "proxy.request_rejected",
        errorCode: "UNSUPPORTED_PROTOCOL_ROUTE",
        failureReason: error?.message || "Model Catalog route planning failed"
      }, "request rejected: unsupported model route");
      sendProxyError(400, {
        code: "UNSUPPORTED_PROTOCOL_ROUTE",
        exposedCode: "UNSUPPORTED_PROTOCOL_ROUTE",
        message: `Model ${modelId} does not support the requested ${protocolRouteKey} route`,
        detail: {
          clientProtocol: protocolRouteKey,
          catalogModel: modelDescriptor?.catalogId || null,
          reason: error?.message || "route planning failed"
        }
      });
      return null;
    }
  };
  let routePlan = buildRequestRoutePlan();
  if (!routePlan) return;
  if (
    routeKey === "chat/completions"
    && routePlan.backendRouteKey === "chat/completions"
    && !routePlan.override
    && findWebSearchParam(body)
    && supportsWebSearchRequest({
      upstream,
      model,
      descriptor: modelDescriptor
    })
  ) {
    routePlan = buildRequestRoutePlan({ type: "routeKey", value: "responses" });
    if (!routePlan) return;
    log.info({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey: routePlan.backendRouteKey,
      event: "proxy.web_search_route_promoted"
    }, "promoted chat/completions request with web_search to responses backend");
  }

  const {
    deployment,
    backendRouteKey,
    targetUrl: protocolTargetUrl
  } = routePlan;
  if (TEXT_PROTOCOL_ROUTE_KEYS.has(protocolRouteKey) && !TEXT_PROTOCOL_ROUTE_KEYS.has(backendRouteKey)) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      status: 400,
      event: "proxy.request_rejected",
      errorCode: "UNSUPPORTED_PROTOCOL_ROUTE",
      failureReason: `Unsupported text backend protocol: ${backendRouteKey}`
    }, "request rejected: unsupported text backend protocol");
    sendProxyError(400, {
      code: "UNSUPPORTED_PROTOCOL_ROUTE",
      exposedCode: "UNSUPPORTED_PROTOCOL_ROUTE",
      message: `Cannot route ${protocolRouteKey} requests to unsupported backend protocol ${backendRouteKey}`,
      detail: { clientProtocol: protocolRouteKey, backendProtocol: backendRouteKey }
    });
    return;
  }
  if (isMessagesCountTokens && backendRouteKey !== "messages") {
    sendProxyError(400, {
      code: "TOKEN_COUNTING_REQUIRES_NATIVE_MESSAGES",
      exposedCode: "TokenCountingNotSupported",
      message: `Token counting is not supported for model ${modelId}; a native Messages route is required`,
      detail: { modelId, backendProtocol: backendRouteKey }
    });
    return;
  }
  if (isResponsesCompact && backendRouteKey !== "responses") {
    sendProxyError(400, {
      code: "COMPACTION_REQUIRES_NATIVE_RESPONSES",
      exposedCode: "ResponseCompactionNotSupported",
      message: `Response compaction is not supported for model ${modelId}; a native Responses route is required`,
      detail: { modelId, backendProtocol: backendRouteKey }
    });
    return;
  }
  let targetUrl;
  try {
    if (isMessagesCountTokens) {
      targetUrl = buildMessagesCountTokensUrl(upstream, protocolTargetUrl, deployment, model, modelDescriptor);
    } else if (isResponsesCompact) {
      targetUrl = buildResponsesCompactUrl(upstream, protocolTargetUrl, deployment, model, modelDescriptor);
    } else {
      targetUrl = protocolTargetUrl;
    }
  } catch (error) {
    const operation = isMessagesCountTokens ? "Token counting" : "Response compaction";
    sendProxyError(501, {
      code: isMessagesCountTokens ? "TOKEN_COUNTING_NOT_CONFIGURED" : "COMPACTION_NOT_CONFIGURED",
      exposedCode: isMessagesCountTokens ? "TokenCountingNotSupported" : "ResponseCompactionNotSupported",
      message: `${operation} is not configured for model ${modelId}`,
      detail: error?.message || `No usable ${routeKey} route`
    });
    return;
  }
  const needsProtocolShim =
    routeKey !== backendRouteKey
    && TEXT_PROTOCOL_ROUTE_KEYS.has(routeKey)
    && TEXT_PROTOCOL_ROUTE_KEYS.has(backendRouteKey);
  const nativeErrorPassthrough = !needsProtocolShim
    && protocolRouteKey === backendRouteKey
    && (
      upstream?.errorPolicy?.nativePassthrough === true
      || routeProfile?.nativeErrorPassthrough === true
    );
  const shimRequestIssue = needsProtocolShim
    ? getProtocolShimCompatibilityIssue(body, {
      phase: "request",
      sourceProtocol: routeKey,
      targetProtocol: backendRouteKey
    })
    : null;
  const shimPolicy = protocolShimCompatibility(config);
  if (
    shimRequestIssue
    && (shimRequestIssue.requiredRejection === true || shimPolicy.rejectLossyRequests !== false)
  ) {
    log.warn({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      status: 400,
      event: "proxy.protocol_shim_rejected",
      errorCode: "UNSUPPORTED_PROTOCOL_SHIM_REQUEST",
      param: shimRequestIssue.path,
      unsupportedType: shimRequestIssue.type,
      failureReason: shimRequestIssue.message
    }, "protocol shim request rejected");
    sendProxyError(400, {
      code: "UNSUPPORTED_PROTOCOL_SHIM_REQUEST",
      exposedCode: "UnsupportedProtocolShim",
      message: shimRequestIssue.message,
      param: shimRequestIssue.path,
      detail: shimRequestIssue
    });
    return;
  }
  if (shimRequestIssue) {
    log.warn({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      sourceProtocol: routeKey,
      targetProtocol: backendRouteKey,
      event: "proxy.protocol_shim_lossy_conversion",
      shimPhase: "request",
      param: shimRequestIssue.path,
      unsupportedType: shimRequestIssue.type,
      failureReason: shimRequestIssue.message
    }, "protocol shim request continued with lossy conversion");
  }
  const policy = resolveUpstreamPolicy(config, { routeKey: protocolRouteKey, model, upstream, requestOverrides });
  let upstreamAuthHeaders;
  try {
    markTiming(timing, "authStartAt");
    const usesAnthropicMessages = backendRouteKey === "messages";
    upstreamAuthHeaders = await getUpstreamAuthHeaders(
      usesAnthropicMessages ? "https://ai.azure.com/.default" : config.auth.scope,
      {
        auth: upstream.auth,
        apiKeyHeader: usesAnthropicMessages ? "x-api-key" : "api-key"
      }
    );
    markTiming(timing, "authReadyAt");
  } catch (error) {
    recordError(model.id, consumer);
    noteGovernanceError(consumer);
    recordRuntimeError(config, {
      occurredAt: new Date().toISOString(),
      requestId,
      conversationId,
      sessionId,
      keyId: consumer?.keyId,
      modelId: model.id,
      routeKey,
      backendRouteKey,
      status: 500,
      errorCode: "UPSTREAM_AUTH_PREPARE_FAILED",
      failureReason: error?.message || "upstream authentication failed",
      source: "proxy"
    });
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.auth_prepare_failed",
      errorCode: "UPSTREAM_AUTH_PREPARE_FAILED",
      failureReason: error?.message || "upstream authentication failed",
      error: error?.message
    }, "failed to prepare upstream authentication");
    sendProxyError(500, {
      code: "UPSTREAM_AUTH_PREPARE_FAILED",
      message: error?.message || "upstream authentication failed"
    });
    finishTiming({
      status: 500,
      outcome: "auth_failed",
      errorCode: "UPSTREAM_AUTH_PREPARE_FAILED",
      source: "proxy"
    });
    return;
  }

  isStream = !isNativeUtilityRequest && getStreamFlag(body);

  let nextBody;
  if (routeKey === "chat/completions" && backendRouteKey === "responses") {
    nextBody = chatToResponsesRequest(body, deployment, modelDescriptor);
  } else if (routeKey === "responses" && backendRouteKey === "chat/completions") {
    nextBody = responsesToChatRequest(body, deployment, modelDescriptor);
  } else if (routeKey === "chat/completions" && backendRouteKey === "messages") {
    nextBody = chatToMessagesRequest(body, deployment, modelDescriptor);
  } else if (routeKey === "responses" && backendRouteKey === "messages") {
    nextBody = responsesToMessagesRequest(body, deployment, modelDescriptor);
  } else if (routeKey === "messages" && backendRouteKey === "chat/completions") {
    nextBody = messagesToChatRequest(body, deployment, modelDescriptor);
  } else if (routeKey === "messages" && backendRouteKey === "responses") {
    nextBody = messagesToResponsesRequest(body, deployment, modelDescriptor);
  } else {
    nextBody = body.model === deployment
      ? body
      : {
        ...body,
        model: deployment
      };
  }
  if (isStream && needsProtocolShim) nextBody.stream = true;

  nextBody = prepareImageGenerationRequest({
    body: nextBody,
    model,
    descriptor: modelDescriptor,
    routeKey,
    backendRouteKey,
    targetUrl
  });

  if (nextBody && typeof nextBody === "object") {
    normalizeReasoningConfig(nextBody, backendRouteKey);
    normalizeResponsesToolDescriptions(nextBody, backendRouteKey);
    if (backendRouteKey === "messages") {
      const anthropicCompatibilityError = applyAnthropicBodyCompatibility(
        nextBody,
        config,
        deployment || modelId,
        model,
        modelDescriptor
      );
      if (anthropicCompatibilityError) {
        log.error({
          source: "proxy",
          requestId,
          ...requestNetworkContext,
          modelId,
          routeKey,
          backendRouteKey,
          status: 400,
          event: "proxy.request_rejected",
          errorCode: "UNSUPPORTED_PARAMETER",
          param: anthropicCompatibilityError.param,
          failureReason: anthropicCompatibilityError.message
        }, anthropicCompatibilityError.message);
        sendProxyError(400, {
          code: "UNSUPPORTED_PARAMETER",
          exposedCode: "UnsupportedParameter",
          message: anthropicCompatibilityError.message,
          param: anthropicCompatibilityError.param
        });
        return;
      }
    }
    sanitizeToolControlsWithoutTools(nextBody);
    const unsupportedWebSearch = sanitizeWebSearchRequest(nextBody, {
      backendRouteKey,
      upstream,
      model
    });
    if (unsupportedWebSearch) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        status: 400,
        event: "proxy.request_rejected",
        errorCode: "UNSUPPORTED_PARAMETER",
        param: unsupportedWebSearch.param,
        failureReason: unsupportedWebSearch.message
      }, unsupportedWebSearch.message);
      sendProxyError(400, {
        code: "UNSUPPORTED_PARAMETER",
        exposedCode: "UnsupportedParameter",
        message: unsupportedWebSearch.message,
        param: unsupportedWebSearch.param
      });
      return;
    }
    const unsupportedRequest = sanitizeModernModelRequest(nextBody, {
      backendRouteKey,
      descriptor: modelDescriptor
    }) || sanitizeWebSearchRequest(nextBody, {
      backendRouteKey,
      model
    });
    if (unsupportedRequest) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        status: 400,
        event: "proxy.request_rejected",
        errorCode: "UNSUPPORTED_PARAMETER",
        param: unsupportedRequest.param,
        failureReason: unsupportedRequest.message
      }, unsupportedRequest.message);
      sendProxyError(400, {
        code: "UNSUPPORTED_PARAMETER",
        exposedCode: "UnsupportedParameter",
        message: unsupportedRequest.message,
        param: unsupportedRequest.param
      });
      return;
    }
    const configuredPolicyRejection = applyConfiguredRequestPolicy(nextBody, {
      config,
      routeKey: protocolRouteKey,
      model,
      upstream
    });
    if (configuredPolicyRejection) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        status: 400,
        event: "proxy.request_rejected",
        errorCode: "UNSUPPORTED_PARAMETER",
        param: configuredPolicyRejection.param,
        failureReason: configuredPolicyRejection.message
      }, configuredPolicyRejection.message);
      sendProxyError(400, {
        code: "UNSUPPORTED_PARAMETER",
        exposedCode: "UnsupportedParameter",
        message: configuredPolicyRejection.message,
        param: configuredPolicyRejection.param,
        detail: { fields: configuredPolicyRejection.fields }
      });
      return;
    }
  }

  if (
    nextBody
    && typeof nextBody === "object"
    && "stream_options" in nextBody
    && (!isStream || (backendRouteKey !== "chat/completions" && backendRouteKey !== "responses"))
  ) {
    delete nextBody.stream_options;
  }

  if (nextBody && typeof nextBody === "object") {
    try {
      nextBody = await maybeCompressImages(nextBody, config, protocolRouteKey);
    } catch (error) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        status: error?.status || 400,
        event: "proxy.request_rejected",
        errorCode: error?.code || "INVALID_MEDIA_INPUT",
        failureReason: error?.message || "invalid media input"
      }, error?.message || "invalid media input");
      sendProxyError(error?.status || 400, {
        code: error?.code || "INVALID_MEDIA_INPUT",
        exposedCode: error?.code || "INVALID_MEDIA_INPUT",
        message: error?.message || "invalid media input"
      });
      finishTiming({
        status: error?.status || 400,
        outcome: "request_rejected",
        errorCode: error?.code || "INVALID_MEDIA_INPUT",
        source: "proxy"
      });
      return;
    }
  }

  const contentLogOptions = {
    mode: resolveLogContentMode(config),
    maxPayloadBytes: config?.observability?.logs?.maxPayloadLogBytes
  };
  const requestContentSnapshot = buildContentLogSnapshot(nextBody, { ...contentLogOptions, kind: "requestBody" });
  const requestLogFields = buildContentSnapshotFields("request", requestContentSnapshot);
  const streamContentCollector = createStreamContentCollector(contentLogOptions.maxPayloadBytes);

  markTiming(timing, "requestPreparedAt");
  markTiming(timing, "governanceStartAt");
  const governanceResult = await acquireRequestGovernance(config, consumer, model, Date.now(), {
    requestId,
    routeKey,
    backendRouteKey
  });
  markTiming(timing, "governanceReadyAt");
  if (!governanceResult.ok) {
    log.error({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      status: governanceResult.status || 429,
      event: "proxy.request_rejected",
      errorCode: governanceResult.code,
      failureReason: governanceResult.message
    }, governanceResult.message);
    sendProxyError(governanceResult.status || 429, {
      code: governanceResult.code || "REQUEST_REJECTED",
      exposedCode: governanceResult.error || governanceResult.code || "RequestRejected",
      message: governanceResult.message
    });
    finishTiming({
      status: governanceResult.status || 429,
      outcome: "governance_rejected",
      errorCode: governanceResult.code || "REQUEST_REJECTED",
      source: "proxy"
    });
    return;
  }
  governanceLease = governanceResult.lease;

  const upstreamAbortController = new AbortController();
  const abortUpstream = () => {
    if (!upstreamAbortController.signal.aborted && !reply.raw.writableEnded) {
      upstreamAbortController.abort("client-disconnected");
    }
  };
  req.raw?.once?.("aborted", abortUpstream);
  reply.raw?.once?.("close", abortUpstream);
  if (req.raw?.aborted || reply.raw?.destroyed) abortUpstream();

  const recordProxyError = ({ status = null, errorCode = "", failureReason = "", source = "proxy" } = {}) => {
    recordError(model.id, {
      keyId: consumer?.keyId,
      actualModelName: resolvedUpstreamModel
    });
    noteGovernanceError(consumer);
    recordRuntimeError(config, {
      occurredAt: new Date().toISOString(),
      requestId,
      conversationId,
      sessionId,
      keyId: consumer?.keyId,
      modelId: model.id,
      actualModelName: resolvedUpstreamModel,
      routeKey,
      backendRouteKey,
      status,
      errorCode,
      failureReason,
      source
    });
  };
  let resolvedUpstreamModel = "";
  let usageRecorded = false;
  let usageSource = "none";
  let usageEstimated = false;
  let usageEstimationReason = "";
  const noteResolvedUpstreamModel = (value) => {
    if (typeof value === "string" && value.trim()) {
      resolvedUpstreamModel = value.trim();
    }
  };
  const recordProxyUsage = (usage, actualModelName = "", metadata = {}) => {
    if (!usage || usageRecorded) return;
    usageRecorded = true;
    usageSource = metadata.source || "upstream";
    usageEstimated = metadata.estimated === true;
    usageEstimationReason = metadata.reason || "";
    noteResolvedUpstreamModel(actualModelName);
    const cost = recordGovernanceUsage(config, consumer, model, usage, Date.now(), actualModelName || resolvedUpstreamModel, {
      requestId,
      routeKey,
      backendRouteKey,
      modelDescriptor
    });
    recordUsage(model.id, usage, {
      keyId: consumer?.keyId,
      cost,
      actualModelName: cost?.actualModelName || actualModelName || resolvedUpstreamModel
    });
    recordRuntimeUsage(config, {
      occurredAt: new Date().toISOString(),
      requestId,
      conversationId,
      sessionId,
      keyId: consumer?.keyId,
      modelId: model.id,
      actualModelName: cost?.actualModelName || actualModelName || resolvedUpstreamModel,
      routeKey,
      backendRouteKey,
      promptTokens: cost?.promptTokens,
      completionTokens: cost?.completionTokens,
      totalTokens: cost?.totalTokens,
      cachedTokens: cost?.cachedTokens,
      estimatedCostAmount: cost?.amount,
      modelRouterCostAmount: cost?.modelRouterCostAmount,
      actualModelCostAmount: cost?.actualModelCostAmount,
      currency: cost?.currency,
      source: "proxy",
      usageSource,
      usageEstimated,
      usageEstimationReason
    });
    emitInfoLog({
      ...requestContext,
      modelId,
      actualModelName: cost?.actualModelName || actualModelName || resolvedUpstreamModel,
      event: "proxy.usage_recorded",
      routeKey,
      backendRouteKey,
      consumerKeyId: consumer?.keyId || "anonymous",
      usageAvailable: true,
      usageSource,
      usageEstimated,
      usageEstimationReason,
      promptTokens: cost?.promptTokens,
      completionTokens: cost?.completionTokens,
      totalTokens: cost?.totalTokens,
      cachedTokens: cost?.cachedTokens,
      estimatedCostAmount: cost?.amount,
      modelRouterCostAmount: cost?.modelRouterCostAmount,
      actualModelCostAmount: cost?.actualModelCostAmount,
      currency: cost?.currency,
      message: usageEstimated ? "proxy usage estimated locally" : "proxy usage recorded"
    });
  };
  const recordEstimatedUsageIfMissing = (completionBytes, reason) => {
    if (usageRecorded || !TEXT_PROTOCOL_ROUTE_KEYS.has(routeKey)) return false;
    const semanticPromptBytes = estimateSemanticTextBytes(nextBody);
    const promptTokens = estimateLocalTokensFromBytes(semanticPromptBytes || requestContentSnapshot.bytes);
    const completionTokens = estimateLocalTokensFromBytes(completionBytes);
    recordProxyUsage({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }, resolvedUpstreamModel, {
      source: "local_estimate",
      estimated: true,
      reason
    });
    return true;
  };
  const finalizeStreamObservation = (reason) => {
    const collectedResponse = streamContentCollector.finish();
    const responseContentSnapshot = buildContentLogSnapshot(
      collectedResponse.payload,
      { ...contentLogOptions, kind: "responseBody" }
    );
    const responseLogFields = buildContentSnapshotFields("response", responseContentSnapshot);
    recordEstimatedUsageIfMissing(collectedResponse.observedBytes, reason);
    return { collectedResponse, responseLogFields };
  };
  const deferPostResponse = (operation) => {
    setImmediate(() => {
      try {
        operation();
      } catch (error) {
        log.error({
          source: "proxy",
          ...requestContext,
          modelId,
          routeKey,
          backendRouteKey,
          event: "proxy.post_response_logging_failed",
          errorCode: error?.code || "POST_RESPONSE_LOGGING_FAILED",
          failureReason: error?.message || "post-response logging failed"
        }, "post-response logging failed");
      }
    });
  };
  const emitRequestCompleted = ({ responsePayload, status, attempt }) => {
    const responseContentSnapshot = buildContentLogSnapshot(responsePayload, { ...contentLogOptions, kind: "responseBody" });
    const responseLogFields = buildContentSnapshotFields("response", responseContentSnapshot);
    recordEstimatedUsageIfMissing(responseContentSnapshot.bytes, "upstream_usage_missing");
    emitInfoLog({
      ...requestContext,
      ...requestLogFields,
      ...responseLogFields,
      modelId,
      actualModelName: resolvedUpstreamModel,
      event: "proxy.request_completed",
      routeKey,
      backendRouteKey,
      stream: false,
      attempt,
      status,
      usageAvailable: usageRecorded,
      usageSource,
      usageEstimated,
      usageEstimationReason,
      latencyMs: Date.now() - startAt,
      message: "proxy request completed"
    });
  };

  try {
    recordRequest(model.id, consumer);
    recordRuntimeRequest(config, {
      occurredAt: new Date().toISOString(),
      requestId,
      conversationId,
      sessionId,
      keyId: consumer?.keyId,
      modelId: model.id,
      routeKey,
      backendRouteKey,
      stream: isStream,
      targetUrl
    });
    emitInfoLog({
      ...requestContext,
      ...requestLogFields,
      modelId,
      event: "proxy.request_started",
      routeKey,
      backendRouteKey,
      targetUrl,
      stream: isStream,
      consumerKeyId: consumer?.keyId || "anonymous",
      message: "proxy request started"
    });

    const forwardSdkMetadata = backendRouteKey === "messages" && forwardAnthropicSdkMetadataHeaders(config);
    const headers = {
      ...sanitizeIncomingHeaders(req.headers, config, {
        allowPrefixes: forwardSdkMetadata ? ANTHROPIC_HEADER_PREFIXES : [],
        denyPrefixes: backendRouteKey === "messages" && !forwardSdkMetadata
          ? ANTHROPIC_SDK_METADATA_HEADER_PREFIXES
          : []
      }),
      ...sanitizeConfiguredUpstreamHeaders(upstream.headersTemplate),
      "content-type": "application/json",
      ...(backendRouteKey === "messages"
        ? { "anthropic-version": String(req.headers["anthropic-version"] || "2023-06-01").trim() || "2023-06-01" }
        : {}),
      ...upstreamAuthHeaders,
      ...(config?.proxy?.forwardHeaders?.addRequestIdHeader === false ? {} : buildCorrelationHeaders(requestContext))
    };
    if (backendRouteKey !== "messages") {
      for (const headerName of Object.keys(headers)) {
        if (ANTHROPIC_REQUEST_HEADERS.has(headerName.toLowerCase())) {
          delete headers[headerName];
        }
      }
    } else {
      const filteredBetas = applyAnthropicBetaPolicy(headers, config, { upstream, targetUrl });
      if (filteredBetas.length > 0) {
        emitInfoLog({
          ...requestContext,
          ...requestLogFields,
          modelId,
          event: "proxy.anthropic_betas_filtered",
          routeKey,
          backendRouteKey,
          upstreamName: `upstream:${upstream.name || "unknown"}`,
          upstreamProvider: `provider:${upstream.provider || "unknown"}`,
          filteredBetas: JSON.stringify(filteredBetas),
          filteredBetaCount: filteredBetas.length,
          message: "unsupported Anthropic beta values filtered for upstream"
        });
      }
    }
    const bodyText = JSON.stringify(nextBody);
    const maxRequestBodyBytes = getPositiveByteLimit(config?.proxy?.guards?.maxRequestBodyBytes);
    if (maxRequestBodyBytes > 0 && Buffer.byteLength(bodyText) > maxRequestBodyBytes) {
      log.error({
        source: "proxy",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        status: 413,
        event: "proxy.request_rejected",
        errorCode: "PAYLOAD_TOO_LARGE",
        failureReason: `Request body exceeds ${maxRequestBodyBytes} bytes`
      }, "request body exceeds configured limit");
      sendProxyError(413, {
        code: "PAYLOAD_TOO_LARGE",
        exposedCode: "PayloadTooLarge",
        message: `Request body exceeds ${maxRequestBodyBytes} bytes`
      });
      finishTiming({
        status: 413,
        outcome: "request_rejected",
        errorCode: "PAYLOAD_TOO_LARGE",
        source: "proxy"
      });
      return;
    }

    if (isStream) {
      const maxAttempts = Math.max(1, policy.maxRetries + 1);
      let streamingStarted = false;
      const startStreamingResponse = () => {
        if (streamingStarted) return;
        reply.hijack();
        setSseResponseHeaders(reply.raw);
        streamingStarted = true;
      };

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        timing.upstreamAttempts = Math.max(timing.upstreamAttempts, attempt);
        markTiming(timing, "upstreamRequestAt");
        let upstreamResponse;
        try {
          upstreamResponse = await fetchOnceWithConnectTimeout({
            targetUrl,
            headers,
            bodyText,
            connectTimeoutMs: policy.connectTimeoutMs,
            timeoutMs: policy.firstByteTimeoutMs,
            timeoutCode: "UPSTREAM_FIRST_BYTE_TIMEOUT",
            timeoutLabel: "first byte",
            signal: upstreamAbortController.signal
          });
          markTiming(timing, "upstreamHeadersAt");
        } catch (error) {
          const classified = classifyFetchError(error);
          if (classified.code === "CLIENT_DISCONNECTED") {
            finishTiming({ status: 499, outcome: "client_disconnected", errorCode: classified.code, source: "client" });
            return;
          }
          const retryableNetworkError = classified.retryable && policy.classifyNetworkErrorsAsRetryable !== false;
          if (attempt < maxAttempts && retryableNetworkError) {
            const backoffMs = computeBackoffMs(policy, attempt);
            log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream fetch retry");
            try {
              await sleep(backoffMs, upstreamAbortController.signal);
            } catch (abortError) {
              const aborted = classifyFetchError(abortError);
              if (aborted.code === "CLIENT_DISCONNECTED") {
                finishTiming({ status: 499, outcome: "client_disconnected", errorCode: aborted.code, source: "client" });
                return;
              }
              throw abortError;
            }
            continue;
          }
          recordProxyError({
            status: classified.status || 502,
            errorCode: classified.code,
            failureReason: classified.detail,
            source: "upstream"
          });
          const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
          log.error({
            source: "upstream",
            requestId,
            ...requestNetworkContext,
            modelId,
            routeKey,
            backendRouteKey,
            includeReasoningEncryptedContent: Array.isArray(body.include)
              && body.include.includes("reasoning.encrypted_content"),
            attempt,
            status: classified.status || 502,
            event: "proxy.stream_fetch_failed",
            errorCode: classified.code,
            latencyMs: Date.now() - startAt,
            ...extractFailureDetails(classified.detail)
          }, "stream fetch failed");
          reply.code(classified.status || 502).send(errBody);
          finishTiming({
            status: classified.status || 502,
            outcome: "upstream_fetch_failed",
            errorCode: classified.code,
            source: "upstream"
          });
          return;
        }

        if (!upstreamResponse.ok) {
          let detail = "";
          let nativeErrorBodyAvailable = true;
          try {
            detail = await readTextWithTimeout(
              upstreamResponse,
              policy.requestTimeoutMs,
              1024 * 1024,
              upstreamAbortController.signal
            );
          } catch (readError) {
            nativeErrorBodyAvailable = false;
            const readFailure = classifyFetchError(readError);
            if (readFailure.code === "CLIENT_DISCONNECTED") {
              finishTiming({ status: 499, outcome: "client_disconnected", errorCode: readFailure.code, source: "client" });
              return;
            }
            if (attempt < maxAttempts && readFailure.retryable && policy.classifyNetworkErrorsAsRetryable !== false) {
              const backoffMs = computeBackoffMs(policy, attempt);
              log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, errorCode: readFailure.code }, "stream retry on HTTP error body read failure");
              try {
                await sleep(backoffMs, upstreamAbortController.signal);
              } catch (abortError) {
                const aborted = classifyFetchError(abortError);
                if (aborted.code === "CLIENT_DISCONNECTED") {
                  finishTiming({ status: 499, outcome: "client_disconnected", errorCode: aborted.code, source: "client" });
                  return;
                }
                throw abortError;
              }
              continue;
            }
            detail = readFailure.detail;
          }
          const classified = classifyHttpStatus(upstreamResponse.status);
          const retryableStatus = policy.retryStatuses.has(upstreamResponse.status) || classified.retryable;
          if (attempt < maxAttempts && retryableStatus) {
            const backoffMs = computeBackoffMs(policy, attempt);
            log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, status: upstreamResponse.status, errorCode: classified.code }, "stream upstream retry on status");
            try {
              await sleep(backoffMs, upstreamAbortController.signal);
            } catch (abortError) {
              const aborted = classifyFetchError(abortError);
              if (aborted.code === "CLIENT_DISCONNECTED") {
                finishTiming({ status: 499, outcome: "client_disconnected", errorCode: aborted.code, source: "client" });
                return;
              }
              throw abortError;
            }
            continue;
          }
          recordProxyError({
            status: upstreamResponse.status,
            errorCode: classified.code,
            failureReason: detail,
            source: "upstream"
          });
          if (nativeErrorPassthrough && nativeErrorBodyAvailable) {
            log.error({
              source: "upstream",
              requestId,
              ...requestNetworkContext,
              modelId,
              routeKey,
              backendRouteKey,
              attempt,
              status: upstreamResponse.status,
              event: "proxy.native_error_passthrough",
              errorCode: classified.code,
              latencyMs: Date.now() - startAt,
              ...extractFailureDetails(detail)
            }, "native upstream error passed through");
            sendNativeErrorResponse(reply, {
              status: upstreamResponse.status,
              payload: detail,
              contentType: upstreamResponse.headers.get("content-type") || "",
              retryAfter: upstreamResponse.headers.get("retry-after") || "",
              requestId
            });
            finishTiming({
              status: upstreamResponse.status,
              outcome: "native_upstream_error_passthrough",
              errorCode: classified.code,
              source: "upstream"
            });
            return;
          }
          const errBody = buildErrorBody({
            classified: { ...classified, retryable: retryableStatus && attempt < maxAttempts },
            requestId,
            detail,
            upstreamStatus: upstreamResponse.status
          });
          log.error({
            source: "upstream",
            requestId,
            ...requestNetworkContext,
            modelId,
            routeKey,
            backendRouteKey,
            attempt,
            status: upstreamResponse.status,
            event: "proxy.stream_upstream_failed",
            errorCode: classified.code,
            latencyMs: Date.now() - startAt,
            ...extractFailureDetails(detail)
          }, "stream upstream request failed");
          reply.code(upstreamResponse.status).send(errBody);
          finishTiming({
            status: upstreamResponse.status,
            outcome: "upstream_http_failed",
            errorCode: classified.code,
            source: "upstream"
          });
          return;
        }

        const streamResult = !needsProtocolShim
          ? await streamPassthrough({
            upstreamResponse,
            reply,
            modelId,
            backendRouteKey,
            forwardProviderErrors: nativeErrorPassthrough,
            policy,
            onFirstChunk: () => {
              markTiming(timing, "firstChunkAt");
              startStreamingResponse();
            },
            onUsage: recordProxyUsage,
            onModel: noteResolvedUpstreamModel,
            onContent: streamContentCollector.append
          })
          : await streamShim({
            upstreamResponse,
            reply,
            modelId,
            routeKey,
            backendRouteKey,
            includeReasoningEncryptedContent: routeKey === "responses"
              && Array.isArray(body.include)
              && body.include.includes("reasoning.encrypted_content"),
            includeChatStreamUsage: routeKey === "chat/completions"
              && body?.stream_options?.include_usage === true,
            rejectLossyResponses: shimPolicy.rejectLossyResponses !== false,
            model,
            policy,
            onFirstChunk: () => {
              markTiming(timing, "firstChunkAt");
              startStreamingResponse();
            },
            onUsage: recordProxyUsage,
            onModel: noteResolvedUpstreamModel,
            onContent: streamContentCollector.append,
            onCompatibilityIssue: (issue) => {
              log.warn({
                source: "proxy",
                requestId,
                ...requestNetworkContext,
                modelId,
                routeKey,
                backendRouteKey,
                sourceProtocol: backendRouteKey,
                targetProtocol: routeKey,
                event: "proxy.protocol_shim_lossy_conversion",
                shimPhase: "stream",
                param: issue.path,
                unsupportedType: issue.type,
                failureReason: issue.message
              }, "protocol shim stream continued with lossy conversion");
            }
          });

        if (streamResult.ok) {
          if (!streamingStarted) {
            const classified = {
              code: "UPSTREAM_EMPTY_STREAM",
              retryable: false,
              status: 502,
              detail: "upstream stream ended before any data was sent"
            };
            recordProxyError({
              status: classified.status,
              errorCode: classified.code,
              failureReason: classified.detail,
              source: "upstream"
            });
            const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
            log.error({
              source: "upstream",
              requestId,
              ...requestNetworkContext,
              modelId,
              routeKey,
              backendRouteKey,
              attempt,
              status: classified.status,
              event: "proxy.stream_empty",
              errorCode: classified.code,
              latencyMs: Date.now() - startAt,
              failureReason: classified.detail
            }, "stream ended before any data was sent");
            reply.code(classified.status).send(errBody);
            deferPostResponse(() => finalizeStreamObservation("empty_stream_before_usage"));
            finishTiming({
              status: classified.status,
              outcome: "upstream_empty_stream",
              errorCode: classified.code,
              source: "upstream"
            });
            return;
          }
          reply.raw.end();
          deferPostResponse(() => {
            const { collectedResponse, responseLogFields } = finalizeStreamObservation("stream_usage_missing");
            emitInfoLog({
              ...requestContext,
              ...requestLogFields,
              ...responseLogFields,
              responseBytes: collectedResponse.observedBytes,
              responseSha256: responseLogFields.responseSha256,
              responseTruncated: collectedResponse.truncated || responseLogFields.responseTruncated,
              modelId,
              actualModelName: resolvedUpstreamModel,
              event: "proxy.stream_completed",
              routeKey,
              backendRouteKey,
              stream: true,
              attempt,
              status: 200,
              usageAvailable: usageRecorded,
              usageSource,
              usageEstimated,
              usageEstimationReason,
              latencyMs: Date.now() - startAt,
              message: "stream request completed"
            });
          });
          finishTiming({
            status: 200,
            outcome: "success",
            source: "proxy"
          });
          return;
        }

        const classified = classifyFetchError(streamResult.error);
        if (streamResult.clientDisconnected || classified.code === "CLIENT_DISCONNECTED") {
          const { collectedResponse, responseLogFields } = finalizeStreamObservation("client_disconnected_before_usage");
          emitInfoLog({
            ...requestContext,
            ...requestLogFields,
            ...responseLogFields,
            responseBytes: collectedResponse.observedBytes,
            responseTruncated: collectedResponse.truncated || responseLogFields.responseTruncated,
            modelId,
            actualModelName: resolvedUpstreamModel,
            event: "proxy.stream_client_disconnected",
            routeKey,
            backendRouteKey,
            stream: true,
            attempt,
            status: 499,
            usageAvailable: usageRecorded,
            usageSource,
            usageEstimated,
            usageEstimationReason,
            latencyMs: Date.now() - startAt,
            message: "client disconnected during stream"
          });
          finishTiming({
            status: 499,
            outcome: "client_disconnected",
            errorCode: "CLIENT_DISCONNECTED",
            source: "client"
          });
          return;
        }
        const canRetry = streamResult.beforeFirstChunk
          && classified.retryable
          && policy.classifyNetworkErrorsAsRetryable !== false
          && attempt < maxAttempts;
        if (canRetry) {
          const backoffMs = computeBackoffMs(policy, attempt);
          log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream retry before first chunk");
          try {
            await sleep(backoffMs, upstreamAbortController.signal);
          } catch (abortError) {
            const aborted = classifyFetchError(abortError);
            if (aborted.code === "CLIENT_DISCONNECTED") {
              finishTiming({ status: 499, outcome: "client_disconnected", errorCode: aborted.code, source: "client" });
              return;
            }
            throw abortError;
          }
          continue;
        }

        const providerError = streamResult.providerError;
        recordProxyError({
          status: classified.status || 502,
          errorCode: providerError?.code || classified.code,
          failureReason: providerError?.message || classified.detail || "stream request failed",
          source: providerError ? "provider" : "upstream"
        });
        const errBody = buildErrorBody({
          classified,
          requestId,
          detail: providerError?.message || classified.detail,
          message: providerError?.message,
          code: providerError?.code,
          type: providerError?.type,
          param: providerError?.param
        });
        if (!streamingStarted) {
          reply.code(classified.status || 502).send(errBody);
        } else if (!streamResult.providerErrorForwarded) {
          await writeSseError(reply.raw, errBody, routeKey);
          reply.raw.end();
        } else {
          reply.raw.end();
        }
        deferPostResponse(() => finalizeStreamObservation(
          providerError ? "provider_error_before_usage" : "stream_interrupted_before_usage"
        ));
        log.error({
          source: providerError ? "provider" : "upstream",
          requestId,
          ...requestNetworkContext,
          azureRequestId: providerError?.azureRequestId || "",
          modelId,
          event: providerError ? "proxy.stream_provider_error" : "proxy.stream_failed",
          routeKey,
          backendRouteKey,
          errorCode: providerError?.code || classified.code,
          failureReason: providerError?.message || classified.detail || "stream request failed",
          providerErrorType: providerError?.type || "",
          providerMessage: providerError?.message || classified.detail || "",
          latencyMs: Date.now() - startAt
        }, providerError ? "stream provider error" : "stream request failed");
        finishTiming({
          status: classified.status || 502,
          outcome: providerError ? "provider_stream_failed" : "stream_failed",
          errorCode: providerError?.code || classified.code,
          source: providerError ? "provider" : "upstream"
        });
        return;
      }
      recordProxyError({
        status: 502,
        errorCode: "STREAM_INTERRUPTED",
        failureReason: "stream retry budget exhausted",
        source: "upstream"
      });
      sendProxyError(502, {
        code: "STREAM_INTERRUPTED",
        message: "stream retry budget exhausted"
      });
      deferPostResponse(() => finalizeStreamObservation("stream_retry_exhausted_before_usage"));
      finishTiming({
        status: 502,
        outcome: "stream_retry_exhausted",
        errorCode: "STREAM_INTERRUPTED",
        source: "upstream"
      });
      return;
    }

    markTiming(timing, "upstreamRequestAt");
    const fetchResult = await fetchWithRetry({
      targetUrl,
      headers,
      bodyText,
      policy,
      logMeta: { source: "upstream", requestId, modelId, routeKey, backendRouteKey },
      log,
      signal: upstreamAbortController.signal
    });
    timing.upstreamAttempts = fetchResult.attempt || timing.upstreamAttempts;
    if (!fetchResult.ok) {
      if (fetchResult.classified.code === "CLIENT_DISCONNECTED") {
        finishTiming({ status: 499, outcome: "client_disconnected", errorCode: fetchResult.classified.code, source: "client" });
        return;
      }
      recordProxyError({
        status: fetchResult.upstreamStatus || fetchResult.classified.status || 502,
        errorCode: fetchResult.classified.code,
        failureReason: fetchResult.detail,
        source: "upstream"
      });
      const status = fetchResult.upstreamStatus || fetchResult.classified.status || 502;
      if (nativeErrorPassthrough && fetchResult.hasUpstreamHttpResponse) {
        log.error({
          source: "upstream",
          requestId,
          ...requestNetworkContext,
          modelId,
          routeKey,
          backendRouteKey,
          attempt: fetchResult.attempt,
          status,
          event: "proxy.native_error_passthrough",
          errorCode: fetchResult.classified.code,
          latencyMs: Date.now() - startAt,
          ...extractFailureDetails(fetchResult.detail)
        }, "native upstream error passed through");
        sendNativeErrorResponse(reply, {
          status,
          payload: fetchResult.detail,
          contentType: fetchResult.upstreamContentType,
          retryAfter: fetchResult.upstreamRetryAfter,
          requestId
        });
        finishTiming({
          status,
          outcome: "native_upstream_error_passthrough",
          errorCode: fetchResult.classified.code,
          source: "upstream"
        });
        return;
      }
      const errBody = buildErrorBody({
        classified: fetchResult.classified,
        requestId,
        detail: fetchResult.detail,
        upstreamStatus: fetchResult.upstreamStatus
      });
      log.error({
        source: "upstream",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        attempt: fetchResult.attempt,
        status,
        errorCode: fetchResult.classified.code,
        latencyMs: Date.now() - startAt,
        ...extractFailureDetails(fetchResult.detail)
      }, "non-stream upstream request failed");
      reply.code(status).send(errBody);
      finishTiming({
        status,
        outcome: "upstream_http_failed",
        errorCode: fetchResult.classified.code,
        source: "upstream"
      });
      return;
    }

    const upstreamResponse = fetchResult.upstreamResponse;
    markTiming(timing, "upstreamHeadersAt");
    const maxResponseBodyBytes = getPositiveByteLimit(config?.proxy?.guards?.maxResponseBodyBytes)
      || DEFAULT_MAX_RESPONSE_BODY_BYTES;
    const responseContentLength = Number(upstreamResponse.headers.get("content-length"));
    if (maxResponseBodyBytes > 0 && Number.isFinite(responseContentLength) && responseContentLength > maxResponseBodyBytes) {
      const classified = {
        code: "UPSTREAM_RESPONSE_TOO_LARGE",
        retryable: false,
        status: 502,
        detail: `Upstream response exceeds ${maxResponseBodyBytes} bytes`
      };
      recordProxyError({
        status: classified.status,
        errorCode: classified.code,
        failureReason: classified.detail,
        source: "upstream"
      });
      await upstreamResponse.body?.cancel?.().catch(() => {});
      reply.code(classified.status).send(buildErrorBody({ classified, requestId, detail: classified.detail }));
      finishTiming({
        status: classified.status,
        outcome: "upstream_response_too_large",
        errorCode: classified.code,
        source: "upstream"
      });
      return;
    }
    let payload = null;
    let rawPayloadText = null;
    try {
      if (nativeErrorPassthrough) {
        rawPayloadText = await readTextWithTimeout(
          upstreamResponse,
          policy.requestTimeoutMs,
          maxResponseBodyBytes,
          upstreamAbortController.signal
        );
        payload = JSON.parse(rawPayloadText);
      } else {
        payload = await parseJsonWithTimeout(
          upstreamResponse,
          policy.requestTimeoutMs,
          maxResponseBodyBytes,
          upstreamAbortController.signal
        );
      }
    } catch (error) {
      const classified = classifyFetchError(error);
      if (classified.code === "CLIENT_DISCONNECTED") {
        finishTiming({ status: 499, outcome: "client_disconnected", errorCode: classified.code, source: "client" });
        return;
      }
      recordProxyError({
        status: classified.status || 504,
        errorCode: classified.code,
        failureReason: classified.detail,
        source: "upstream"
      });
      const status = classified.status || 504;
      const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
      log.error({
        source: "upstream",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        attempt: fetchResult.attempt,
        errorCode: classified.code,
        latencyMs: Date.now() - startAt,
        ...extractFailureDetails(classified.detail)
      }, "non-stream response parse failed");
      reply.code(status).send(errBody);
      finishTiming({
        status,
        outcome: "upstream_parse_failed",
        errorCode: classified.code,
        source: "upstream"
      });
      return;
    }

    const providerPayloadError = getProviderPayloadError(payload);
    if (providerPayloadError) {
      recordProxyError({
        status: 502,
        errorCode: providerPayloadError.code,
        failureReason: providerPayloadError.message,
        source: "provider"
      });
      if (nativeErrorPassthrough) {
        log.error({
          source: "provider",
          requestId,
          ...requestNetworkContext,
          modelId,
          routeKey,
          backendRouteKey,
          status: upstreamResponse.status,
          event: "proxy.native_error_passthrough",
          errorCode: providerPayloadError.code,
          failureReason: providerPayloadError.message
        }, "native provider failure payload passed through");
        sendNativeErrorResponse(reply, {
          status: upstreamResponse.status,
          payload: rawPayloadText ?? JSON.stringify(payload),
          contentType: upstreamResponse.headers.get("content-type") || "application/json",
          retryAfter: upstreamResponse.headers.get("retry-after") || "",
          requestId
        });
        finishTiming({
          status: upstreamResponse.status,
          outcome: "native_provider_error_passthrough",
          errorCode: providerPayloadError.code,
          source: "provider"
        });
        return;
      }
      sendProxyError(502, {
        code: "UPSTREAM_PROVIDER_RESPONSE_ERROR",
        exposedCode: providerPayloadError.code,
        type: providerPayloadError.type,
        param: providerPayloadError.param,
        message: providerPayloadError.message,
        detail: payload
      });
      finishTiming({
        status: 502,
        outcome: "provider_response_failed",
        errorCode: providerPayloadError.code,
        source: "provider"
      });
      return;
    }

    const shimResponseIssue = needsProtocolShim
      ? getProtocolShimCompatibilityIssue(payload, {
        phase: "response",
        sourceProtocol: backendRouteKey,
        targetProtocol: routeKey
      })
      : null;
    if (
      shimResponseIssue
      && (shimResponseIssue.requiredRejection === true || shimPolicy.rejectLossyResponses !== false)
    ) {
      recordProxyError({
        status: 502,
        errorCode: "UNSUPPORTED_PROTOCOL_SHIM_RESPONSE",
        failureReason: shimResponseIssue.message,
        source: "provider"
      });
      log.error({
        source: "provider",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        status: 502,
        event: "proxy.protocol_shim_response_rejected",
        errorCode: "UNSUPPORTED_PROTOCOL_SHIM_RESPONSE",
        param: shimResponseIssue.path,
        unsupportedType: shimResponseIssue.type,
        failureReason: shimResponseIssue.message
      }, "protocol shim response rejected");
      sendProxyError(502, {
        code: "UNSUPPORTED_PROTOCOL_SHIM_RESPONSE",
        exposedCode: "UnsupportedProtocolShimResponse",
        message: shimResponseIssue.message,
        param: shimResponseIssue.path,
        detail: shimResponseIssue
      });
      finishTiming({
        status: 502,
        outcome: "protocol_shim_response_rejected",
        errorCode: "UNSUPPORTED_PROTOCOL_SHIM_RESPONSE",
        source: "provider"
      });
      return;
    }
    if (shimResponseIssue) {
      log.warn({
        source: "provider",
        requestId,
        ...requestNetworkContext,
        modelId,
        routeKey,
        backendRouteKey,
        sourceProtocol: backendRouteKey,
        targetProtocol: routeKey,
        event: "proxy.protocol_shim_lossy_conversion",
        shimPhase: "response",
        param: shimResponseIssue.path,
        unsupportedType: shimResponseIssue.type,
        failureReason: shimResponseIssue.message
      }, "protocol shim response continued with lossy conversion");
    }

    if (
      isMessagesCountTokens
      && (!Number.isInteger(payload?.input_tokens) || payload.input_tokens < 0)
    ) {
      recordProxyError({
        status: 502,
        errorCode: "INVALID_TOKEN_COUNT_RESPONSE",
        failureReason: "upstream token count response must contain a non-negative integer input_tokens",
        source: "provider"
      });
      sendProxyError(502, {
        code: "INVALID_TOKEN_COUNT_RESPONSE",
        exposedCode: "InvalidTokenCountResponse",
        message: "Upstream token count response is invalid",
        detail: payload
      });
      finishTiming({
        status: 502,
        outcome: "provider_response_invalid",
        errorCode: "INVALID_TOKEN_COUNT_RESPONSE",
        source: "provider"
      });
      return;
    }

    if (
      isResponsesCompact
      && (
        payload?.object !== "response.compaction"
        || !Array.isArray(payload.output)
        || !payload.usage
        || typeof payload.usage !== "object"
        || Array.isArray(payload.usage)
      )
    ) {
      recordProxyError({
        status: 502,
        errorCode: "INVALID_COMPACTION_RESPONSE",
        failureReason: "upstream compaction response must contain object=response.compaction, output, and usage",
        source: "provider"
      });
      sendProxyError(502, {
        code: "INVALID_COMPACTION_RESPONSE",
        exposedCode: "InvalidCompactionResponse",
        message: "Upstream compaction response is invalid",
        detail: payload
      });
      finishTiming({
        status: 502,
        outcome: "provider_response_invalid",
        errorCode: "INVALID_COMPACTION_RESPONSE",
        source: "provider"
      });
      return;
    }

    if (needsProtocolShim) {
      if (routeKey === "chat/completions" && backendRouteKey === "responses") {
        const mapped = mapResponsesJsonToChatCompletion(payload, modelId);
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({
          status: 200,
          outcome: "success",
          source: "proxy"
        });
        return;
      }
      if (routeKey === "responses" && backendRouteKey === "chat/completions") {
        const mapped = mapChatCompletionJsonToResponses(payload, modelId);
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({
          status: 200,
          outcome: "success",
          source: "proxy"
        });
        return;
      }
      if (routeKey === "chat/completions" && backendRouteKey === "messages") {
        const mapped = mapMessagesJsonToChatCompletion(payload, modelId);
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({ status: 200, outcome: "success", source: "proxy" });
        return;
      }
      if (routeKey === "responses" && backendRouteKey === "messages") {
        const mapped = mapMessagesJsonToResponses(payload, modelId, {
          includeEncryptedContent: Array.isArray(body.include)
            && body.include.includes("reasoning.encrypted_content")
        });
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({ status: 200, outcome: "success", source: "proxy" });
        return;
      }
      if (routeKey === "messages" && backendRouteKey === "chat/completions") {
        const mapped = mapChatCompletionJsonToMessages(payload, modelId);
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({ status: 200, outcome: "success", source: "proxy" });
        return;
      }
      if (routeKey === "messages" && backendRouteKey === "responses") {
        const mapped = mapResponsesJsonToMessages(payload, modelId);
        reply.code(200).send(mapped);
        deferPostResponse(() => {
          noteResolvedUpstreamModel(payload?.model || mapped?.model);
          if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
          emitRequestCompleted({ responsePayload: mapped, status: 200, attempt: fetchResult.attempt });
        });
        finishTiming({ status: 200, outcome: "success", source: "proxy" });
        return;
      }
    }

    const downstreamPayload = restorePublicResponseModel(payload, modelId);
    reply.code(upstreamResponse.status).send(downstreamPayload);
    deferPostResponse(() => {
      noteResolvedUpstreamModel(payload?.model);
      if (payload?.usage) {
        recordProxyUsage(payload.usage, payload?.model || (isResponsesCompact ? deployment : ""));
      }
      emitRequestCompleted({ responsePayload: downstreamPayload, status: upstreamResponse.status, attempt: fetchResult.attempt });
    });
    finishTiming({
      status: upstreamResponse.status,
      outcome: "success",
      source: "proxy"
    });
  } finally {
    req.raw?.removeListener?.("aborted", abortUpstream);
    reply.raw?.removeListener?.("close", abortUpstream);
    governanceLease?.release();
    finishTiming({
      status: reply.statusCode || null,
      outcome: reply.statusCode && reply.statusCode < 400 ? "success" : "completed",
      errorCode: reply.statusCode && reply.statusCode >= 400 ? "REQUEST_FAILED" : "",
      source: "proxy"
    });
  }
}

function extractReasoningEffort(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.effort === "string") {
    return value.effort;
  }
  return undefined;
}

function normalizeReasoningConfig(body, backendRouteKey) {
  const thinking = body?.thinking;
  const reasoning = body?.reasoning;
  const thinkingEffort = extractReasoningEffort(thinking);
  const reasoningEffort = extractReasoningEffort(reasoning);
  const directReasoningEffort = typeof body?.reasoning_effort === "string"
    ? body.reasoning_effort
    : undefined;

  if (backendRouteKey === "responses") {
    if ((reasoning == null || typeof reasoning !== "object") && thinking && typeof thinking === "object") {
      body.reasoning = {
        ...thinking,
        ...(reasoning && typeof reasoning === "object" ? reasoning : {})
      };
    }
    if (body.reasoning == null && (thinkingEffort || directReasoningEffort)) {
      body.reasoning = {
        ...(reasoning && typeof reasoning === "object" ? reasoning : {}),
        effort: directReasoningEffort || thinkingEffort
      };
    } else if (body.reasoning && typeof body.reasoning === "object" && (directReasoningEffort || thinkingEffort) && body.reasoning.effort == null) {
      body.reasoning.effort = directReasoningEffort || thinkingEffort;
    }
    delete body.reasoning_effort;
    delete body.thinking;
    return;
  }

  if (backendRouteKey === "chat/completions") {
    if (body.reasoning_effort == null && (reasoningEffort || thinkingEffort)) {
      body.reasoning_effort = reasoningEffort || thinkingEffort;
    }
    delete body.reasoning;
    delete body.thinking;
  }
}

function normalizeResponsesToolDescriptionList(tools) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace") {
      if (tool.description == null || (typeof tool.description === "string" && !tool.description.trim())) {
        const namespaceName = typeof tool.name === "string" ? tool.name.trim() : "";
        tool.description = namespaceName ? `Tools in the ${namespaceName} namespace.` : "Tool namespace";
      }
      normalizeResponsesToolDescriptionList(tool.tools);
      continue;
    }
    if (tool.type !== "function" && tool.type !== "custom") continue;
    if (tool.description == null || (typeof tool.description === "string" && !tool.description.trim())) {
      const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
      tool.description = toolName || "Tool";
    }
  }
}

function normalizeResponsesToolDescriptions(body, backendRouteKey) {
  if (backendRouteKey !== "responses") return;
  normalizeResponsesToolDescriptionList(body?.tools);
  if (!Array.isArray(body?.input)) return;
  for (const item of body.input) {
    if (item?.type === "additional_tools") {
      normalizeResponsesToolDescriptionList(item.tools);
    }
  }
}

function normalizeModernReasoningEffort(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function findWebSearchParam(body) {
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      const type = normalizeWebSearchToolType(tool?.type);
      if (type === "web_search") {
        return "tools";
      }
    }
  }

  const toolChoiceType = typeof body?.tool_choice?.type === "string"
    ? normalizeWebSearchToolType(body.tool_choice.type)
    : "";
  if (toolChoiceType === "web_search") {
    return "tool_choice";
  }

  return null;
}

function supportsWebSearchRequest({ upstream, model, descriptor }) {
  if (
    Array.isArray(descriptor?.interfaces)
    && !descriptor.interfaces.includes("responses")
  ) {
    return false;
  }
  const deployment = model?.targetModel || model?.id;
  try {
    const targetUrl = buildUpstreamUrl(upstream, "responses", deployment, model, descriptor);
    return reconcileBackendRouteKey("responses", targetUrl) === "responses";
  } catch {
    return false;
  }
}

function normalizeWebSearchRequest(body) {
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      const normalizedType = normalizeWebSearchToolType(tool.type);
      if (normalizedType === "web_search" && tool.type !== "web_search") {
        tool.type = "web_search";
      }
    }
  }

  if (body?.tool_choice && typeof body.tool_choice === "object") {
    const normalizedType = normalizeWebSearchToolType(body.tool_choice.type);
    if (normalizedType === "web_search" && body.tool_choice.type !== "web_search") {
      body.tool_choice.type = "web_search";
    }
  }
}

function sanitizeWebSearchRequest(body, { backendRouteKey }) {
  if (!body || typeof body !== "object") {
    return null;
  }

  if (backendRouteKey === "responses" && findWebSearchParam(body)) {
    normalizeWebSearchRequest(body);
  }
  return null;
}

function sanitizeModernModelRequest(body, { backendRouteKey, descriptor }) {
  if (!body || typeof body !== "object") {
    return null;
  }

  if (body.service_tier == null && body.serviceTier != null) {
    body.service_tier = body.serviceTier;
  }
  delete body.serviceTier;

  if (backendRouteKey === "chat/completions") {
    const reasoningRequest = descriptor?.capabilities?.includes("reasoning") || body.reasoning_effort != null;
    if (reasoningRequest && typeof body.max_completion_tokens !== "number" && typeof body.max_tokens === "number") {
      body.max_completion_tokens = body.max_tokens;
    }
    if (reasoningRequest) delete body.max_tokens;

    if (body.top_logprobs != null && body.logprobs == null) {
      body.logprobs = true;
    }

    if (body.reasoning_effort != null) {
      body.reasoning_effort = normalizeModernReasoningEffort(body.reasoning_effort);
    }
  }

  if (backendRouteKey === "responses" && body.reasoning && typeof body.reasoning === "object" && body.reasoning.effort != null) {
    body.reasoning.effort = normalizeModernReasoningEffort(body.reasoning.effort);
  }

  return null;
}
