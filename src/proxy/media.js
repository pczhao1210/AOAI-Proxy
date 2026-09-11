import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getUpstreamAuthHeaders } from "../auth.js";
import { acquireRequestGovernance, checkConsumerModelAccess, checkUnmeteredRequestAccess } from "../governance.js";
import { resolveModelDescriptor } from "../model-catalog.js";
import { getRequestContext } from "../request-context.js";
import { findModel, findUpstream, isPublicRouteEnabled, resolveRoutePlan } from "./routing.js";
import { applyConfiguredRequestPolicy } from "./request-policy.js";
import { resolveUpstreamPolicy } from "./reliability.js";
import { buildUpstreamHeaders } from "./upstream-headers.js";
import { buildMediaMultipart, readMediaMultipart } from "./media-body.js";
import { createRawSseParser } from "./stream.js";
import { getAzureSpeechOperation, prepareAzureSpeechRequest, mapAzureTranscriptionResult } from "./azure-speech.js";
import { createMediaUsageTracker } from "./media-usage.js";
import { recordRequest } from "../stats.js";
import { recordRuntimeRequest } from "../runtime-store.js";
import { resolveMediaPricing, settleMediaUsage } from "./media-accounting.js";
import { prepareResponsesSpeechRequest } from "./responses-media.js";

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function mediaError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export async function proxyMediaRequest({ config, routeKey, req, reply, nativeSpeech = false, responsesAdapter = null, requestBody = req.body, requestOverrides = {} }) {
  const clientRouteKey = responsesAdapter ? "responses" : routeKey;
  const requestContext = getRequestContext(req);
  const consumer = req.proxyAccess?.consumer;
  const controller = new AbortController();
  let lease;
  let requestTimer;
  let idleTimer;
  let bytes = 0;
  let model;
  let upload;
  let prepared;
  let usageTracker = createMediaUsageTracker();
  let backendRouteKey = "";
  let completed = false;
  const abort = () => {
    if (!reply.raw.writableFinished) controller.abort(mediaError(499, "CLIENT_DISCONNECTED", "Client disconnected"));
  };
  req.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  try {
    if (config.media?.http?.enabled !== true || !isPublicRouteEnabled(config, routeKey) || !isPublicRouteEnabled(config, clientRouteKey)) {
      throw mediaError(404, "MEDIA_HTTP_DISABLED", "HTTP media routes are disabled");
    }
    const multipart = !responsesAdapter && ["audio/transcriptions", "audio/translations", "images/edits"].includes(routeKey);
    if (multipart && !req.isMultipart?.()) throw mediaError(415, "MULTIPART_REQUIRED", "This media route requires multipart/form-data");
    if (multipart) upload = await readMediaMultipart(req, config, { requireModel: !nativeSpeech });
    if (nativeSpeech && upload && Object.hasOwn(upload.fields, "model")) throw mediaError(400, "AMBIGUOUS_MODEL", "Native Speech uses the model in the route");
    const body = nativeSpeech ? { ...upload?.fields, model: req.params.model } : upload ? upload.fields : requestBody;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string") {
      throw mediaError(400, "MODEL_REQUIRED", "A public model is required");
    }
    model = findModel(config, body.model);
    if (!model) throw mediaError(404, "MODEL_NOT_FOUND", "Model not found");
    const access = checkConsumerModelAccess(consumer, model);
    if (!access.ok) throw mediaError(access.status || 403, access.code, access.message);
    const meteringAccess = checkUnmeteredRequestAccess(config, consumer);
    if (!meteringAccess.ok) throw mediaError(meteringAccess.status, meteringAccess.code, meteringAccess.message);
    const upstream = findUpstream(config, model.upstream);
    if (!upstream || upstream.status === "disabled") throw mediaError(503, "UPSTREAM_UNAVAILABLE", "Upstream is unavailable");
    const descriptor = resolveModelDescriptor(model.id);
    let plan;
    try {
      plan = resolveRoutePlan({ routeKey, model, upstream, descriptor });
    } catch {
      throw mediaError(400, "UNSUPPORTED_PROTOCOL_ROUTE", "The model does not support the requested media route");
    }
    backendRouteKey = plan.backendRouteKey;
    usageTracker = createMediaUsageTracker({ pricing: resolveMediaPricing(config, model, upstream, descriptor, plan.targetUrl) });
    let nextBody = { ...(responsesAdapter ? {} : model.defaultParams), ...body, model: model.targetModel || model.id };
    if (responsesAdapter) {
      const clientIssue = applyConfiguredRequestPolicy(nextBody, { config, routeKey: clientRouteKey, model, upstream });
      if (clientIssue) throw mediaError(400, "REQUEST_POLICY_REJECTED", clientIssue.message);
      prepared = prepareResponsesSpeechRequest({ body: nextBody, model, adapter: responsesAdapter, config, log: req.log });
      nextBody = { ...prepared.body, model: model.targetModel || model.id };
      upload = prepared.upload;
    }
    const issue = applyConfiguredRequestPolicy(nextBody, { config, routeKey, model, upstream });
    if (issue) throw mediaError(400, "REQUEST_POLICY_REJECTED", issue.message);
    const speechOperation = getAzureSpeechOperation(plan.targetUrl);
    if (responsesAdapter && speechOperation !== (routeKey === "audio/speech" ? "speech" : "transcriptions")) throw mediaError(400, "SPEECH_ROUTE_REQUIRED", "Responses Speech requires the matching Speech endpoint");
    if (nativeSpeech && !speechOperation) throw mediaError(400, "SPEECH_ROUTE_REQUIRED", "Native Speech requires a Speech upstream endpoint");
    const speech = speechOperation ? prepareAzureSpeechRequest({ operation: speechOperation, native: nativeSpeech,
      body: nextBody, rawBody: req.body, upload, model, headers: req.headers, config, log: req.log }) : null;
    const admission = await acquireRequestGovernance(config, consumer, model, Date.now(), { ...requestContext, routeKey: clientRouteKey, backendRouteKey: plan.backendRouteKey });
    if (!admission.ok) throw mediaError(admission.status || 429, admission.code, admission.message);
    lease = admission.lease;
    recordRequest(model.id, consumer);
    recordRuntimeRequest(config, { ...requestContext, keyId: consumer?.keyId, modelId: model.id, routeKey: clientRouteKey, backendRouteKey });
    const policy = resolveUpstreamPolicy(config, { routeKey: clientRouteKey, model, upstream, requestOverrides });
    requestTimer = setTimeout(() => controller.abort(mediaError(504, "UPSTREAM_REQUEST_TIMEOUT", "Media request timed out")), positiveInteger(policy.requestTimeoutMs, 600000));
    const auth = await getUpstreamAuthHeaders(upstream.auth?.scope || config.auth.scope, {
      auth: upstream.auth, apiKeyHeader: speech ? "ocp-apim-subscription-key" : "api-key"
    });
    if (["openai", "openai-api"].includes(upstream.provider) && auth["api-key"]) {
      auth.authorization = `Bearer ${auth["api-key"]}`;
      delete auth["api-key"];
    }
    const { headers } = buildUpstreamHeaders({ incomingHeaders: req.headers, config, backendRouteKey: routeKey,
      upstream, targetUrl: plan.targetUrl, upstreamAuthHeaders: auth, requestContext });
    const upstreamBody = speech ? speech.body : upload ? buildMediaMultipart(upload, nextBody) : JSON.stringify(nextBody);
    for (const name of Object.keys(headers)) {
      if (["content-type", "content-encoding", "content-length"].includes(name.toLowerCase())
        || speech && ["x-microsoft-outputformat", "user-agent"].includes(name.toLowerCase())) delete headers[name];
    }
    if (speech) Object.assign(headers, speech.headers);
    else if (!upload) headers["content-type"] = "application/json";
    if (req.raw.aborted || reply.raw.destroyed) abort();
    idleTimer = setTimeout(() => controller.abort(mediaError(504, "UPSTREAM_FIRST_BYTE_TIMEOUT", "Media response did not start")), positiveInteger(policy.firstByteTimeoutMs, 90000));
    const response = await fetch(plan.targetUrl, { method: "POST", headers, body: upstreamBody, redirect: "manual", signal: controller.signal });
    if (!response.body) throw mediaError(502, "UPSTREAM_EMPTY_BODY", "Media response body is unavailable");
    const responseHeaders = { "cache-control": "no-store" };
    for (const [name, value] of response.headers) {
      if (["content-type", "retry-after", "x-request-id", "openai-processing-ms"].includes(name) || name.startsWith("x-ratelimit-")) responseHeaders[name] = value;
    }
    const limit = prepared?.maxResponseBytes ?? positiveInteger(config.media?.http?.maxResponseBytes, 100 * 1024 * 1024);
    const sseParser = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream"
      ? createRawSseParser() : null;
    const terminalType = routeKey === "audio/speech" ? "speech.audio.done" : "transcript.text.done";
    let terminalSeen = false;
    let providerErrorSeen = false;
    let jsonChunks = !sseParser && response.headers.get("content-type")?.includes("application/json") ? [] : null;
    const bounded = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(mediaError(504, "UPSTREAM_IDLE_TIMEOUT", "Media response stalled")), positiveInteger(policy.idleTimeoutMs, 600000));
      if (bytes > limit) return callback(mediaError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "Media response exceeded its byte limit"));
      if (jsonChunks) {
        if (bytes <= Math.min(limit, 1024 * 1024)) jsonChunks.push(chunk);
        else jsonChunks = null;
      }
      if (sseParser) {
        for (const event of sseParser.feed(chunk)) {
          let payload;
          try { payload = JSON.parse(event.payload); } catch { continue; }
          if (payload?.type === terminalType) {
            terminalSeen = true;
            usageTracker.observe("terminal", payload.usage);
          }
          if (payload?.type === "error" || payload?.error) {
            providerErrorSeen = true;
            terminalSeen = true;
          }
        }
        if (sseParser.bufferedLength > Math.min(limit, 8 * 1024 * 1024)) {
          return callback(mediaError(502, "UPSTREAM_STREAM_EVENT_TOO_LARGE", "Media SSE event exceeded its byte limit"));
        }
      }
      callback(null, chunk);
    }, flush(callback) {
      if (sseParser && response.ok && !terminalSeen) {
        return callback(mediaError(502, "UPSTREAM_INCOMPLETE_STREAM", "Media SSE ended without its terminal event"));
      }
      callback();
    } });
    if ((prepared || speech?.responseFormat) && response.ok) {
      const chunks = [];
      await pipeline(Readable.fromWeb(response.body), bounded, new Writable({ write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      } }), { signal: controller.signal });
      const collected = Buffer.concat(chunks);
      if (prepared) {
        reply.code(response.status).headers({ ...responseHeaders, "content-type": "application/json" }).send(prepared.mapResponse(collected, response.headers));
      } else {
        let result;
        try { result = JSON.parse(collected.toString("utf8")); } catch {
          throw mediaError(502, "INVALID_SPEECH_RESULT", "Speech returned an invalid JSON result");
        }
        reply.code(response.status).headers({ ...responseHeaders, "content-type": speech.responseFormat === "text" ? "text/plain; charset=utf-8" : "application/json" })
          .send(mapAzureTranscriptionResult(result, speech.responseFormat));
      }
    } else {
      reply.hijack();
      reply.raw.writeHead(response.status, responseHeaders);
      await pipeline(Readable.fromWeb(response.body), bounded, reply.raw, { signal: controller.signal });
    }
    if (jsonChunks && response.ok) {
      try {
        const result = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
        if (speechOperation === "transcriptions" && typeof result.durationMilliseconds === "number") {
          usageTracker.observe("speech-duration", { type: "duration", seconds: result.durationMilliseconds / 1000 });
        } else usageTracker.observe("json", result.usage);
      } catch {}
    }
    completed = response.ok && !providerErrorSeen;
    req.log.info({ ...requestContext, event: response.ok && !providerErrorSeen ? "proxy.media_completed" : "proxy.media_failed", routeKey: clientRouteKey, backendRouteKey, modelId: model.id,
      status: response.status, responseBytes: bytes, ...usageTracker.snapshot() }, "media request completed");
  } catch (error) {
    const failure = controller.signal.reason instanceof Error ? controller.signal.reason : error;
    controller.abort(failure);
    if (!reply.raw.headersSent && !reply.raw.destroyed) {
      if (req.isMultipart?.()) reply.header("connection", "close");
      reply.code(failure.status || 502).send({ error: { type: "proxy_error", code: failure.code || "MEDIA_REQUEST_FAILED", message: failure.status ? failure.message : "Media upstream request failed" } });
    } else if (!reply.raw.destroyed) {
      reply.raw.destroy();
    }
    req.log.warn({ ...requestContext, event: "proxy.media_failed", routeKey: clientRouteKey, backendRouteKey, modelId: model?.id,
      errorCode: failure.code || "MEDIA_REQUEST_FAILED", responseBytes: bytes, ...usageTracker.snapshot(), usageStatus: "partial" }, "media request failed");
  } finally {
    clearTimeout(requestTimer);
    clearTimeout(idleTimer);
    req.raw.removeListener("aborted", abort);
    reply.raw.removeListener("close", abort);
    try {
      if (lease) settleMediaUsage({ config, consumer, model, usage: usageTracker.snapshot(), completed, requestContext, routeKey: clientRouteKey, backendRouteKey });
    } finally {
      lease?.release();
      upload?.release?.();
      prepared?.release();
    }
  }
}