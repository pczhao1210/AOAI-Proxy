import { getUpstreamAuthHeaders } from "./auth.js";
import { appendStructuredLog } from "./logs.js";
import { recordError, recordRequest, recordUsage } from "./stats.js";
import { recordRuntimeError, recordRuntimeRequest, recordRuntimeUsage } from "./runtime-store.js";
import {
  findUpstream,
  findModel,
  buildUpstreamUrl,
  buildDirectUpstreamUrl,
  resolveModelRoute,
  resolveEffectiveRouteKey,
  normalizeBackendRouteKey,
  inferBackendRouteKey,
  resolveUpstreamBaseUrl,
  hasUsableUpstreamBaseUrl
} from "./proxy/routing.js";
import {
  sanitizeIncomingHeaders,
  getStreamFlag,
  sanitizeRequestBody,
  extractProxyRequestControls,
  maybeCompressImages
} from "./proxy/body.js";
import { prepareImageGenerationRequest } from "./proxy/image-adapter.js";
import {
  chatToResponsesRequest,
  responsesToChatRequest,
  sanitizeChatToolTranscript,
  mapResponsesJsonToChatCompletion,
  mapChatCompletionJsonToResponses
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
  parseJsonWithTimeout
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

function emitInfoLog(payload) {
  const normalizedPayload = {
    source: "proxy",
    ...payload
  };
  appendStructuredLog("info", normalizedPayload);
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      ...normalizedPayload
    }));
  } catch {
    console.log(normalizedPayload.message || normalizedPayload.event || "info");
  }
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
  requestId,
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
    requestId,
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
  if (routeKey === "responses") return "responses";
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

function applyConfiguredRequestPolicy(body, { config, routeKey, model }) {
  if (!body || typeof body !== "object") return null;
  const routeProfile = config?.routing?.routeProfiles?.[normalizeRouteProfileKey(routeKey)] || {};
  const routeAllowed = new Set(normalizeStringList(routeProfile.allowedRequestFields));
  const modelPolicy = model?.requestPolicy || {};
  const modelAllowed = new Set(normalizeStringList(modelPolicy.allowedParams));
  const modelBlocked = new Set(normalizeStringList(modelPolicy.blockedParams));
  const dropUnsupported = modelPolicy.dropUnsupportedParams === true || config?.proxy?.guards?.dropUnsupportedOpenAiParams === true;
  const rejectedFields = [];

  for (const fieldName of Object.keys(body)) {
    if (fieldName === "model") continue;
    const blocked = modelBlocked.has(fieldName);
    const allowed = isAllowedByAllNonEmptyLists(fieldName, [routeAllowed, modelAllowed]);
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

export async function proxyRequest({
  config,
  routeKey,
  req,
  reply
}) {
  const consumer = req.proxyAccess?.consumer || { keyId: "anonymous", displayName: "anonymous", isAnonymous: true, apiKey: null };
  const startAt = Date.now();
  const requestId = typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]
    ? req.headers["x-request-id"]
    : req.id;
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
  const log = req.log;
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
      requestId,
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
  let body = sanitizeRequestBody(req.body || {}, {
    preserveNull: routeKey === "responses",
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
  const modelId = body.model || config.models[0]?.id;
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

  if (Array.isArray(body.messages)) {
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

  if (!hasUsableUpstreamBaseUrl(upstream, { routeKey, model })) {
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
  const deployment = model.targetModel || model.id;
  const usesModelRouter = String(deployment || "").trim().toLowerCase() === "model-router";
  const override = resolveModelRoute(model, routeKey);
  let effectiveRouteKey = usesModelRouter
    ? "chat/completions"
    : resolveEffectiveRouteKey(routeKey, model, upstream, override);
  let backendRouteKey = override
    ? inferBackendRouteKey(routeKey, override)
    : normalizeBackendRouteKey(effectiveRouteKey);
  if (
    routeKey === "chat/completions"
    && backendRouteKey === "chat/completions"
    && override?.type !== "path"
    && findWebSearchParam(body)
    && supportsWebSearchRequest({
      backendRouteKey: "responses",
      upstream,
      model
    })
  ) {
    effectiveRouteKey = "responses";
    backendRouteKey = "responses";
    log.info({
      source: "proxy",
      requestId,
      ...requestNetworkContext,
      modelId,
      routeKey,
      backendRouteKey,
      event: "proxy.web_search_route_promoted"
    }, "promoted chat/completions request with web_search to responses backend");
  }

  const targetUrl = override?.type === "path"
    ? buildDirectUpstreamUrl(upstream, override.value, deployment, model)
    : buildUpstreamUrl(upstream, effectiveRouteKey, deployment, model);
  const policy = resolveUpstreamPolicy(config, { routeKey, model, upstream, requestOverrides });
  let upstreamAuthHeaders;
  try {
    markTiming(timing, "authStartAt");
    upstreamAuthHeaders = await getUpstreamAuthHeaders(config.auth.scope);
    markTiming(timing, "authReadyAt");
  } catch (error) {
    recordError(model.id, consumer);
    noteGovernanceError(consumer);
    recordRuntimeError(config, {
      occurredAt: new Date().toISOString(),
      requestId,
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

  isStream = getStreamFlag(body);
  const needsChatResponsesShim =
    (routeKey === "chat/completions" && backendRouteKey === "responses")
    || (routeKey === "responses" && backendRouteKey === "chat/completions");

  let nextBody;
  if (needsChatResponsesShim && routeKey === "chat/completions" && backendRouteKey === "responses") {
    nextBody = chatToResponsesRequest(body, deployment);
    if (isStream) nextBody.stream = true;
  } else if (needsChatResponsesShim && routeKey === "responses" && backendRouteKey === "chat/completions") {
    nextBody = responsesToChatRequest(body, deployment);
    if (isStream) nextBody.stream = true;
  } else {
    nextBody = body.model === deployment
      ? body
      : {
        ...body,
        model: deployment
      };
  }

  nextBody = prepareImageGenerationRequest({
    body: nextBody,
    model,
    routeKey,
    backendRouteKey,
    targetUrl
  });

  if (nextBody && typeof nextBody === "object") {
    normalizeReasoningConfig(nextBody, backendRouteKey);
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
      modelId: deployment || modelId
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
    const configuredPolicyRejection = applyConfiguredRequestPolicy(nextBody, { config, routeKey, model });
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
      nextBody = await maybeCompressImages(nextBody, config, routeKey);
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

  const recordProxyError = ({ status = null, errorCode = "", failureReason = "", source = "proxy" } = {}) => {
    recordError(model.id, {
      keyId: consumer?.keyId,
      actualModelName: resolvedUpstreamModel
    });
    noteGovernanceError(consumer);
    recordRuntimeError(config, {
      occurredAt: new Date().toISOString(),
      requestId,
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
  const noteResolvedUpstreamModel = (value) => {
    if (typeof value === "string" && value.trim()) {
      resolvedUpstreamModel = value.trim();
    }
  };
  const recordProxyUsage = (usage, actualModelName = "") => {
    if (!usage) return;
    noteResolvedUpstreamModel(actualModelName);
    const cost = recordGovernanceUsage(config, consumer, model, usage, Date.now(), actualModelName || resolvedUpstreamModel, {
      requestId,
      routeKey,
      backendRouteKey
    });
    recordUsage(model.id, usage, {
      keyId: consumer?.keyId,
      cost,
      actualModelName: cost?.actualModelName || actualModelName || resolvedUpstreamModel
    });
    recordRuntimeUsage(config, {
      occurredAt: new Date().toISOString(),
      requestId,
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
      source: "proxy"
    });
  };

  try {
    recordRequest(model.id, consumer);
    recordRuntimeRequest(config, {
      occurredAt: new Date().toISOString(),
      requestId,
      keyId: consumer?.keyId,
      modelId: model.id,
      routeKey,
      backendRouteKey,
      stream: isStream,
      targetUrl
    });
    emitInfoLog({
      requestId,
      modelId,
      event: "proxy.request_started",
      routeKey,
      backendRouteKey,
      targetUrl,
      stream: isStream,
      consumerKeyId: consumer?.keyId || "anonymous",
      message: "proxy request started"
    });

    const headers = {
      ...sanitizeIncomingHeaders(req.headers, config),
      "content-type": "application/json",
      ...upstreamAuthHeaders,
      "x-request-id": requestId
    };
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
            timeoutLabel: "first byte"
          });
          markTiming(timing, "upstreamHeadersAt");
        } catch (error) {
          const classified = classifyFetchError(error);
          if (attempt < maxAttempts && classified.retryable) {
            const backoffMs = computeBackoffMs(policy, attempt);
            log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream fetch retry");
            await sleep(backoffMs);
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
          const detail = await upstreamResponse.text().catch(() => "");
          const classified = classifyHttpStatus(upstreamResponse.status);
          const retryableStatus = policy.retryStatuses.has(upstreamResponse.status) || classified.retryable;
          if (attempt < maxAttempts && retryableStatus) {
            const backoffMs = computeBackoffMs(policy, attempt);
            log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, status: upstreamResponse.status, errorCode: classified.code }, "stream upstream retry on status");
            await sleep(backoffMs);
            continue;
          }
          recordProxyError({
            status: upstreamResponse.status,
            errorCode: classified.code,
            failureReason: detail,
            source: "upstream"
          });
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

        const streamResult = !needsChatResponsesShim
          ? await streamPassthrough({
            upstreamResponse,
            reply,
            policy,
            onFirstChunk: () => {
              markTiming(timing, "firstChunkAt");
              startStreamingResponse();
            },
            onUsage: recordProxyUsage,
            onModel: noteResolvedUpstreamModel
          })
          : await streamShim({
            upstreamResponse,
            reply,
            modelId,
            routeKey,
            backendRouteKey,
            model,
            policy,
            onFirstChunk: () => {
              markTiming(timing, "firstChunkAt");
              startStreamingResponse();
            },
            onUsage: recordProxyUsage,
            onModel: noteResolvedUpstreamModel
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
            finishTiming({
              status: classified.status,
              outcome: "upstream_empty_stream",
              errorCode: classified.code,
              source: "upstream"
            });
            return;
          }
          reply.raw.end();
          emitInfoLog({
            requestId,
            modelId,
            event: "proxy.stream_completed",
            routeKey,
            backendRouteKey,
            attempt,
            latencyMs: Date.now() - startAt,
            message: "stream request completed"
          });
          finishTiming({
            status: 200,
            outcome: "success",
            source: "proxy"
          });
          return;
        }

        const classified = classifyFetchError(streamResult.error);
        const canRetry = streamResult.beforeFirstChunk && classified.retryable && attempt < maxAttempts;
        if (canRetry) {
          const backoffMs = computeBackoffMs(policy, attempt);
          log.warn({ source: "upstream", requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream retry before first chunk");
          await sleep(backoffMs);
          continue;
        }

        const providerError = streamResult.providerError;
        recordProxyError({
          status: classified.status || 502,
          errorCode: providerError?.code || classified.code,
          failureReason: providerError?.message || classified.detail || "stream request failed",
          source: providerError ? "provider" : "upstream"
        });
        const errBody = buildErrorBody({ classified, requestId, detail: providerError?.message || classified.detail });
        if (!streamingStarted) {
          reply.code(classified.status || 502).send(errBody);
        } else if (!streamResult.providerErrorForwarded) {
          writeSseError(reply.raw, errBody);
          reply.raw.end();
        } else {
          reply.raw.end();
        }
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
      log
    });
    timing.upstreamAttempts = fetchResult.attempt || timing.upstreamAttempts;
    if (!fetchResult.ok) {
      recordProxyError({
        status: fetchResult.upstreamStatus || fetchResult.classified.status || 502,
        errorCode: fetchResult.classified.code,
        failureReason: fetchResult.detail,
        source: "upstream"
      });
      const status = fetchResult.upstreamStatus || fetchResult.classified.status || 502;
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
    const maxResponseBodyBytes = getPositiveByteLimit(config?.proxy?.guards?.maxResponseBodyBytes);
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
    try {
      payload = await parseJsonWithTimeout(upstreamResponse, policy.requestTimeoutMs);
    } catch (error) {
      const classified = classifyFetchError(error);
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

    if (needsChatResponsesShim) {
      if (routeKey === "chat/completions" && backendRouteKey === "responses") {
        const mapped = mapResponsesJsonToChatCompletion(payload, modelId);
        noteResolvedUpstreamModel(payload?.model || mapped?.model);
        if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
        reply.code(200).send(mapped);
        finishTiming({
          status: 200,
          outcome: "success",
          source: "proxy"
        });
        return;
      }
      if (routeKey === "responses" && backendRouteKey === "chat/completions") {
        const mapped = mapChatCompletionJsonToResponses(payload, modelId);
        noteResolvedUpstreamModel(payload?.model || mapped?.model);
        if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
        reply.code(200).send(mapped);
        finishTiming({
          status: 200,
          outcome: "success",
          source: "proxy"
        });
        return;
      }
    }

    noteResolvedUpstreamModel(payload?.model);
    if (payload?.usage) {
      recordProxyUsage(payload.usage, payload?.model);
    }
    emitInfoLog({
      requestId,
      modelId,
      event: "proxy.request_completed",
      routeKey,
      backendRouteKey,
      attempt: fetchResult.attempt,
      status: upstreamResponse.status,
      latencyMs: Date.now() - startAt,
      message: "proxy request completed"
    });
    reply.code(upstreamResponse.status).send(payload);
    finishTiming({
      status: upstreamResponse.status,
      outcome: "success",
      source: "proxy"
    });
  } finally {
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

function isModernModel(modelId) {
  const value = String(modelId || "").toLowerCase();
  return /^gpt-(?:[5-9]|\d{2,})(?:$|[.-])/.test(value) || /^o\d(?:$|[.-])/.test(value);
}

function normalizeModernReasoningEffort(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "xhigh") return "high";
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function normalizeCapabilityName(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replaceAll("_", "-")
    : "";
}

function collectCapabilityNames(...values) {
  const names = new Set();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const normalized = normalizeCapabilityName(item);
      if (normalized) names.add(normalized);
    }
  }
  return names;
}

function normalizeWebSearchToolType(type) {
  const normalized = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (
    normalized === "web_search_preview"
    || normalized === "web_search_preview_2025_03_11"
  ) {
    return "web_search";
  }
  return normalized;
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

function supportsWebSearchRequest({ backendRouteKey, upstream, model }) {
  if (backendRouteKey !== "responses") {
    return false;
  }

  const capabilityNames = collectCapabilityNames(model?.capabilities, upstream?.capabilities);
  if (capabilityNames.has("web-search")) {
    return true;
  }

  try {
    const hostname = new URL(resolveUpstreamBaseUrl(upstream, { routeKey: backendRouteKey, model })).hostname.toLowerCase();
    return hostname.endsWith(".openai.azure.com");
  } catch {
    return false;
  }
}

function sanitizeWebSearchRequest(body, { backendRouteKey, upstream, model }) {
  if (!body || typeof body !== "object") {
    return null;
  }

  const webSearchParam = findWebSearchParam(body);
  if (!webSearchParam) {
    return null;
  }

  if (!supportsWebSearchRequest({ backendRouteKey, upstream, model })) {
    return {
      param: webSearchParam,
      message: "web_search 仅在 Azure OpenAI Responses API 后端受支持；请使用 *.openai.azure.com 的 /openai/v1/responses 路由。若仍失败，请检查订阅是否禁用了 OpenAI.BlockedTools.web_search。"
    };
  }

  normalizeWebSearchRequest(body);
  return null;
}

function sanitizeModernModelRequest(body, { backendRouteKey, modelId }) {
  if (!body || typeof body !== "object" || !isModernModel(modelId)) {
    return null;
  }

  delete body.serviceTier;
  delete body.service_tier;
  delete body.verbosity;
  delete body.top_k;

  if (backendRouteKey === "chat/completions") {
    if (typeof body.max_completion_tokens !== "number" && typeof body.max_tokens === "number") {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;

    if (body.top_logprobs != null && body.logprobs == null) {
      body.logprobs = true;
    }

    if (body.reasoning_effort != null) {
      const normalizedEffort = normalizeModernReasoningEffort(body.reasoning_effort);
      if (!normalizedEffort) {
        return {
          param: "reasoning_effort",
          message: "reasoning_effort 仅支持 low、medium、high；xhigh 已自动降级为 high。"
        };
      }
      body.reasoning_effort = normalizedEffort;
    }
  }

  if (backendRouteKey === "responses" && body.reasoning && typeof body.reasoning === "object" && body.reasoning.effort != null) {
    const normalizedEffort = normalizeModernReasoningEffort(body.reasoning.effort);
    if (!normalizedEffort) {
      return {
        param: "reasoning.effort",
        message: "reasoning.effort 仅支持 low、medium、high；xhigh 已自动降级为 high。"
      };
    }
    body.reasoning.effort = normalizedEffort;
  }

  return null;
}
