import { getUpstreamAuthHeaders } from "./auth.js";
import { appendStructuredLog } from "./logs.js";
import { recordError, recordRequest, recordUsage } from "./stats.js";
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
  const startAt = Date.now();
  const requestId = typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]
    ? req.headers["x-request-id"]
    : req.id;
  const log = req.log;
  const body = sanitizeRequestBody(req.body || {}, { preserveNull: routeKey === "responses" });
  const modelId = body.model || config.models[0]?.id;
  if (!modelId) {
    log.error({
      source: "proxy",
      requestId,
      routeKey,
      status: 400,
      event: "proxy.request_rejected",
      errorCode: "MODEL_REQUIRED",
      failureReason: "model is required"
    }, "request rejected: model is required");
    reply.code(400).send({ error: "model is required" });
    return;
  }
  const model = findModel(config, modelId);
  if (!model) {
    log.error({
      source: "proxy",
      requestId,
      modelId,
      routeKey,
      status: 404,
      event: "proxy.request_rejected",
      errorCode: "MODEL_NOT_FOUND",
      failureReason: `model ${modelId} not found`
    }, "request rejected: model not found");
    reply.code(404).send({ error: `model ${modelId} not found` });
    return;
  }
  const upstream = findUpstream(config, model.upstream);
  if (!upstream) {
    log.error({
      source: "proxy",
      requestId,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.upstream_missing",
      errorCode: "UPSTREAM_NOT_FOUND",
      failureReason: `upstream ${model.upstream} not found`
    }, "configured upstream not found");
    reply.code(500).send({ error: `upstream ${model.upstream} not found` });
    return;
  }

  if (isPlaceholderBaseUrl(upstream.baseUrl)) {
    log.error({
      source: "proxy",
      requestId,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.upstream_invalid",
      errorCode: "INVALID_UPSTREAM_CONFIG",
      failureReason: "upstream baseUrl placeholder is still present"
    }, "invalid upstream baseUrl placeholder");
    reply.code(500).send({
      error: "InvalidUpstreamConfig",
      message:
        "upstreams[].baseUrl 仍是占位符或无效：请将 YOUR-RESOURCE-NAME 替换为真实 Azure OpenAI/Foundry 资源域名（*.openai.azure.com 或 *.services.ai.azure.com）"
    });
    return;
  }

  const deployment = model.targetModel || model.id;
  const override = resolveModelRoute(model, routeKey);
  const effectiveRouteKey = override?.type === "routeKey" ? override.value : routeKey;
  const backendRouteKey = inferBackendRouteKey(routeKey, override);
  const targetUrl = override?.type === "path"
    ? buildDirectUpstreamUrl(upstream, override.value, deployment)
    : buildUpstreamUrl(upstream, effectiveRouteKey, deployment);
  const policy = resolveUpstreamPolicy(config);
  let upstreamAuthHeaders;
  try {
    upstreamAuthHeaders = await getUpstreamAuthHeaders(config.auth.scope);
  } catch (error) {
    recordError(model.id);
    log.error({
      source: "proxy",
      requestId,
      modelId,
      routeKey,
      status: 500,
      event: "proxy.auth_prepare_failed",
      errorCode: "UPSTREAM_AUTH_PREPARE_FAILED",
      failureReason: error?.message || "upstream authentication failed",
      error: error?.message
    }, "failed to prepare upstream authentication");
    const classified = { code: "UPSTREAM_AUTH_PREPARE_FAILED", retryable: false, status: 500 };
    reply.code(500).send(buildErrorBody({ classified, requestId, detail: error?.message || "upstream authentication failed" }));
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
        modelId,
        routeKey,
        backendRouteKey,
        status: 400,
        event: "proxy.request_rejected",
        errorCode: "UNSUPPORTED_PARAMETER",
        param: unsupportedRequest.param,
        failureReason: unsupportedRequest.message
      }, unsupportedRequest.message);
      reply.code(400).send({
        error: "UnsupportedParameter",
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
    nextBody = await maybeCompressImages(nextBody, config, routeKey);
  }

  recordRequest(model.id);
  emitInfoLog({
    requestId,
    modelId,
    event: "proxy.request_started",
    routeKey,
    backendRouteKey,
    targetUrl,
    stream: isStream,
    message: "proxy request started"
  });

  const headers = {
    ...sanitizeIncomingHeaders(req.headers),
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
        recordError(model.id);
        const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
        log.error({
          source: "upstream",
          requestId,
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
        recordError(model.id);
        const errBody = buildErrorBody({
          classified: { ...classified, retryable: retryableStatus && attempt < maxAttempts },
          requestId,
          detail,
          upstreamStatus: upstreamResponse.status
        });
        log.error({
          source: "upstream",
          requestId,
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
          modelId: model.id,
          policy,
          onFirstChunk: () => {
            startStreamingResponse();
          }
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
          }
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

      recordError(model.id);
      const providerError = streamResult.providerError;
      const errBody = buildErrorBody({ classified, requestId, detail: providerError?.message || classified.detail });
      if (!streamResult.providerErrorForwarded) {
        writeSseError(reply.raw, errBody);
      }
      reply.raw.end();
      log.error({
        source: providerError ? "provider" : "upstream",
        requestId,
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
    recordError(model.id);
    const classified = { code: "STREAM_INTERRUPTED", retryable: false, status: 502 };
    reply.code(502).send(buildErrorBody({ classified, requestId, detail: "stream retry budget exhausted" }));
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
    recordError(model.id);
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
    recordError(model.id);
    const classified = classifyFetchError(error);
    const status = classified.status || 504;
    const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
    log.error({
      source: "upstream",
      requestId,
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
      if (mapped?.usage) recordUsage(model.id, mapped.usage);
      reply.code(200).send(mapped);
      return;
    }
    if (routeKey === "responses" && backendRouteKey === "chat/completions") {
      const mapped = mapChatCompletionJsonToResponses(payload, modelId);
      if (mapped?.usage) recordUsage(model.id, mapped.usage);
      reply.code(200).send(mapped);
      return;
    }
  }

  if (payload?.usage) {
    recordUsage(model.id, payload.usage);
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
