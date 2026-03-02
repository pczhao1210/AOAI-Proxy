import { getBearerToken } from "./auth.js";
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
  const body = sanitizeRequestBody(req.body || {});
  const modelId = body.model || config.models[0]?.id;
  if (!modelId) {
    reply.code(400).send({ error: "model is required" });
    return;
  }
  const model = findModel(config, modelId);
  if (!model) {
    reply.code(404).send({ error: `model ${modelId} not found` });
    return;
  }
  const upstream = findUpstream(config, model.upstream);
  if (!upstream) {
    reply.code(500).send({ error: `upstream ${model.upstream} not found` });
    return;
  }

  if (isPlaceholderBaseUrl(upstream.baseUrl)) {
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
  let bearer;
  try {
    bearer = await getBearerToken(config.auth.scope);
  } catch (error) {
    recordError(model.id);
    log.error({ requestId, modelId, routeKey, error: error?.message }, "failed to acquire AAD token");
    const classified = { code: "AAD_TOKEN_ACQUIRE_FAILED", retryable: false, status: 500 };
    reply.code(500).send(buildErrorBody({ classified, requestId, detail: error?.message || "token acquisition failed" }));
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
    nextBody = {
      ...body,
      model: deployment
    };
  }

  if (nextBody && typeof nextBody === "object" && "stream_options" in nextBody) {
    delete nextBody.stream_options;
  }

  if (nextBody && typeof nextBody === "object") {
    nextBody = await maybeCompressImages(nextBody, config, routeKey);
  }

  recordRequest(model.id);
  log.info({
    requestId,
    modelId,
    routeKey,
    backendRouteKey,
    targetUrl,
    stream: isStream
  }, "proxy request started");

  const headers = {
    ...sanitizeIncomingHeaders(req.headers),
    "content-type": "application/json",
    authorization: `Bearer ${bearer}`,
    "x-request-id": requestId
  };
  const bodyText = JSON.stringify(nextBody);

  if (isStream) {
    const maxAttempts = Math.max(1, policy.maxRetries + 1);
    let streamingStarted = false;
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
        if (attempt < maxAttempts && classified.retryable && !streamingStarted) {
          const backoffMs = computeBackoffMs(policy, attempt);
          log.warn({ requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream fetch retry");
          await sleep(backoffMs);
          continue;
        }
        recordError(model.id);
        const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
        if (streamingStarted) {
          writeSseError(reply.raw, errBody);
          reply.raw.end();
          return;
        }
        reply.code(classified.status || 502).send(errBody);
        return;
      }

      if (!upstreamResponse.ok) {
        const detail = await upstreamResponse.text().catch(() => "");
        const classified = classifyHttpStatus(upstreamResponse.status);
        const retryableStatus = policy.retryStatuses.has(upstreamResponse.status) || classified.retryable;
        if (attempt < maxAttempts && retryableStatus && !streamingStarted) {
          const backoffMs = computeBackoffMs(policy, attempt);
          log.warn({ requestId, modelId, routeKey, attempt, backoffMs, status: upstreamResponse.status, errorCode: classified.code }, "stream upstream retry on status");
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
        if (streamingStarted) {
          writeSseError(reply.raw, errBody);
          reply.raw.end();
          return;
        }
        reply.code(upstreamResponse.status).send(errBody);
        return;
      }

      const streamResult = !needsChatResponsesShim
        ? await streamPassthrough({
          upstreamResponse,
          reply,
          modelId: model.id,
          policy,
          onFirstChunk: () => {
            if (streamingStarted) return;
            reply.raw.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
            reply.hijack();
            streamingStarted = true;
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
            if (streamingStarted) return;
            setSseResponseHeaders(reply.raw);
            reply.hijack();
            streamingStarted = true;
          }
        });

      if (streamResult.ok) {
        if (streamingStarted) {
          reply.raw.end();
        } else {
          setSseResponseHeaders(reply.raw);
          reply.hijack();
          writeSseDoneFrame(reply.raw);
          reply.raw.end();
        }
        log.info({
          requestId,
          modelId,
          routeKey,
          backendRouteKey,
          attempt,
          latencyMs: Date.now() - startAt
        }, "stream request completed");
        return;
      }

      const classified = classifyFetchError(streamResult.error);
      const canRetry = streamResult.beforeFirstChunk && classified.retryable && attempt < maxAttempts;
      if (canRetry) {
        const backoffMs = computeBackoffMs(policy, attempt);
        log.warn({ requestId, modelId, routeKey, attempt, backoffMs, errorCode: classified.code }, "stream retry before first chunk");
        await sleep(backoffMs);
        continue;
      }

      recordError(model.id);
      const errBody = buildErrorBody({ classified, requestId, detail: classified.detail });
      if (!streamingStarted) {
        reply.code(classified.status || 502).send(errBody);
        return;
      }
      writeSseError(reply.raw, errBody);
      reply.raw.end();
      log.error({
        requestId,
        modelId,
        routeKey,
        backendRouteKey,
        errorCode: classified.code,
        latencyMs: Date.now() - startAt
      }, "stream request failed");
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
    logMeta: { requestId, modelId, routeKey, backendRouteKey },
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
      requestId,
      modelId,
      routeKey,
      backendRouteKey,
      attempt: fetchResult.attempt,
      status,
      errorCode: fetchResult.classified.code,
      latencyMs: Date.now() - startAt
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
      requestId,
      modelId,
      routeKey,
      backendRouteKey,
      attempt: fetchResult.attempt,
      errorCode: classified.code,
      latencyMs: Date.now() - startAt
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
  log.info({
    requestId,
    modelId,
    routeKey,
    backendRouteKey,
    attempt: fetchResult.attempt,
    status: upstreamResponse.status,
    latencyMs: Date.now() - startAt
  }, "proxy request completed");
  reply.code(upstreamResponse.status).send(payload);
}
