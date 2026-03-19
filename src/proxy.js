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
  inferBackendRouteKey,
  isPlaceholderBaseUrl
} from "./proxy/routing.js";
import {
  sanitizeIncomingHeaders,
  getStreamFlag,
  sanitizeRequestBody,
  extractProxyRequestControls,
  maybeCompressImages
} from "./proxy/body.js";
import {
  chatToResponsesRequest,
  responsesToChatRequest,
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
  const log = req.log;
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

  if (isPlaceholderBaseUrl(upstream.baseUrl)) {
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
        "upstreams[].baseUrl 仍是占位符或无效：请将 YOUR-RESOURCE-NAME 替换为真实 Azure OpenAI/Foundry 资源域名（*.openai.azure.com 或 *.services.ai.azure.com）"
    });
    return;
  }
  const deployment = model.targetModel || model.id;
  const usesModelRouter = String(deployment || "").trim().toLowerCase() === "model-router";
  const override = resolveModelRoute(model, routeKey);
  const effectiveRouteKey = override?.type === "routeKey"
    ? override.value
    : (usesModelRouter ? "chat/completions" : routeKey);
  const backendRouteKey = override
    ? inferBackendRouteKey(routeKey, override)
    : effectiveRouteKey;
  const targetUrl = override?.type === "path"
    ? buildDirectUpstreamUrl(upstream, override.value, deployment)
    : buildUpstreamUrl(upstream, effectiveRouteKey, deployment);
  const policy = resolveUpstreamPolicy(config, { routeKey, model, upstream, requestOverrides });
  let upstreamAuthHeaders;
  try {
    upstreamAuthHeaders = await getUpstreamAuthHeaders(config.auth.scope);
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
    return;
  }

  const isStream = getStreamFlag(body);
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

  if (nextBody && typeof nextBody === "object") {
    normalizeReasoningConfig(nextBody, backendRouteKey);
    const unsupportedRequest = sanitizeModernModelRequest(nextBody, {
      routeKey,
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
      return;
    }
  }

  const governanceResult = await acquireRequestGovernance(config, consumer, model, Date.now(), {
    requestId,
    routeKey,
    backendRouteKey
  });
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
    return;
  }

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

    if (isStream) {
      const maxAttempts = Math.max(1, policy.maxRetries + 1);
      let streamingStarted = false;
      const startStreamingResponse = () => {
        if (streamingStarted) return;
        setSseResponseHeaders(reply.raw);
        reply.hijack();
        streamingStarted = true;
      };

      startStreamingResponse();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let upstreamResponse;
        try {
          upstreamResponse = await fetchOnceWithConnectTimeout({
            targetUrl,
            headers,
            bodyText,
            connectTimeoutMs: policy.connectTimeoutMs
          });
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
          writeSseError(reply.raw, errBody);
          reply.raw.end();
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
          writeSseError(reply.raw, errBody);
          reply.raw.end();
          return;
        }

        const streamResult = !needsChatResponsesShim
          ? await streamPassthrough({
            upstreamResponse,
            reply,
            policy,
            onFirstChunk: () => {
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
              startStreamingResponse();
            },
            onUsage: recordProxyUsage,
            onModel: noteResolvedUpstreamModel
          });

        if (streamResult.ok) {
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
        if (!streamResult.providerErrorForwarded) {
          writeSseError(reply.raw, errBody);
        }
        reply.raw.end();
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
      return;
    }

    const fetchResult = await fetchWithRetry({
      targetUrl,
      headers,
      bodyText,
      policy,
      logMeta: { source: "upstream", requestId, modelId, routeKey, backendRouteKey },
      log
    });
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
      return;
    }

    const upstreamResponse = fetchResult.upstreamResponse;
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
      return;
    }

    if (needsChatResponsesShim) {
      if (routeKey === "chat/completions" && backendRouteKey === "responses") {
        const mapped = mapResponsesJsonToChatCompletion(payload, modelId);
        noteResolvedUpstreamModel(payload?.model || mapped?.model);
        if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
        reply.code(200).send(mapped);
        return;
      }
      if (routeKey === "responses" && backendRouteKey === "chat/completions") {
        const mapped = mapChatCompletionJsonToResponses(payload, modelId);
        noteResolvedUpstreamModel(payload?.model || mapped?.model);
        if (mapped?.usage) recordProxyUsage(mapped.usage, payload?.model || mapped?.model);
        reply.code(200).send(mapped);
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
  } finally {
    governanceResult.lease.release();
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

function findUnsupportedWebSearchParam(body) {
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      const type = typeof tool?.type === "string" ? tool.type.toLowerCase() : "";
      if (type === "web_search" || type === "web_search_preview" || type === "web_search_preview_2025_03_11") {
        return "tools";
      }
    }
  }

  const toolChoiceType = typeof body?.tool_choice?.type === "string"
    ? body.tool_choice.type.toLowerCase()
    : "";
  if (toolChoiceType === "web_search" || toolChoiceType === "web_search_preview" || toolChoiceType === "web_search_preview_2025_03_11") {
    return "tool_choice";
  }

  return null;
}

function sanitizeModernModelRequest(body, { backendRouteKey, modelId }) {
  if (!body || typeof body !== "object" || !isModernModel(modelId)) {
    return null;
  }

  const unsupportedWebSearchParam = findUnsupportedWebSearchParam(body);
  if (unsupportedWebSearchParam) {
    return {
      param: unsupportedWebSearchParam,
      message: "Azure Foundry 当前不支持 web_search 工具，请移除 web_search_preview 相关 tools 或 tool_choice。"
    };
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
