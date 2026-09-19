import multipart from "@fastify/multipart";
import { findNodeAtLocation, modify, applyEdits, parseTree } from "jsonc-parser";
import { getUpstreamAuthHeaders } from "../auth.js";
import { acquireRequestGovernance, checkUnmeteredRequestAccess, resolveApiConsumer } from "../governance.js";
import { getModelCatalogRuntimeInfo } from "../model-catalog.js";
import { getRequestContext } from "../request-context.js";
import { readMediaMultipart } from "./media-body.js";
import { buildUpstreamHeaders } from "./upstream-headers.js";
import { mapRealtimeEvent, realtimeError, resolveRealtimeBinding } from "./realtime-policy.js";
import { DEFAULT_WEBRTC } from "./realtime-calls.js";

function controlUrl(binding, operation) {
  const target = new URL(binding.targetUrl);
  target.protocol = target.protocol === "wss:" ? "https:" : "http:";
  target.searchParams.delete("model");
  target.searchParams.delete("intent");
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/${operation}`;
  return target;
}

async function controlHeaders(config, binding, incomingHeaders, context) {
  const azure = binding.upstream.provider === "azure-openai" || new URL(binding.targetUrl).pathname.startsWith("/openai/");
  const auth = await getUpstreamAuthHeaders(azure ? "https://ai.azure.com/.default" : config.auth.scope, { auth: binding.upstream.auth });
  if (!azure && auth["api-key"]) { auth.authorization = `Bearer ${auth["api-key"]}`; delete auth["api-key"]; }
  const { headers } = buildUpstreamHeaders({ incomingHeaders, config, backendRouteKey: binding.routeKey,
    upstream: binding.upstream, targetUrl: binding.targetUrl, upstreamAuthHeaders: auth, requestContext: context });
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase().startsWith("sec-websocket-") || ["content-type", "content-length", "content-encoding"].includes(name.toLowerCase())) delete headers[name];
  }
  return { headers, azure };
}

async function boundedResponse(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw realtimeError(502, "WEBRTC_RESPONSE_TOO_LARGE", "Upstream response exceeded its limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardResponse(reply, response, body) {
  reply.code(response.status);
  for (const name of ["content-type", "retry-after", "x-request-id"]) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
  return reply.send(body);
}

function parseCallLocation(location, target) {
  if (!location) throw realtimeError(502, "WEBRTC_LOCATION_REQUIRED", "Upstream did not return a call location");
  let parsed;
  let callId;
  try {
    parsed = new URL(location, target);
    callId = decodeURIComponent(parsed.pathname.split("/").at(-1));
  } catch {
    throw realtimeError(502, "INVALID_WEBRTC_LOCATION", "Invalid upstream call location");
  }
  const segment = parsed.pathname.split("/").at(-1);
  const acceptedPaths = [target.pathname, target.pathname.replace(/^\/openai\/v1\//, "/v1/")];
  if (parsed.origin !== target.origin || parsed.username || parsed.password || parsed.search || parsed.hash
    || !acceptedPaths.some(prefix => parsed.pathname === `${prefix}/${segment}`)
    || !callId || callId.length > 512 || /[\/\\\x00-\x1f\x7f]/.test(callId) || [".", ".."].includes(callId)) {
    throw realtimeError(502, "INVALID_WEBRTC_LOCATION", "Untrusted upstream call location");
  }
  return callId;
}

function parseUpstreamJson(body) {
  try { return JSON.parse(body.toString()); } catch {
    throw realtimeError(502, "INVALID_WEBRTC_RESULT", "Upstream returned invalid JSON");
  }
}

function checkDirectMediaAccess(config, consumer, secretExport = false) {
  const access = checkUnmeteredRequestAccess(config, consumer);
  if (!access.ok) throw realtimeError(access.status, access.code, access.message);
  const concurrency = consumer.apiKey?.rateLimit?.concurrency || config.access?.rateLimits?.defaultConcurrency || 0;
  if (consumer.apiKey?.allowedModels?.length || (secretExport && concurrency > 0)) {
    throw realtimeError(403, "WEBRTC_INLINE_POLICY_REQUIRED", "Direct provider access cannot enforce this key's policy");
  }
}

export async function registerWebRtcRoutes(app, { getConfig, extractApiKey, callRegistry, limitRequestBodyStream }) {
  await app.register(async rtcApp => {
    await rtcApp.register(multipart);
    rtcApp.removeContentTypeParser("application/json");
    rtcApp.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => done(null, body));
    rtcApp.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store, private");
      const config = getConfig();
      if (config.media?.webrtc?.enabled !== true) return reply.code(404).send({ error: "WEBRTC_DISABLED" });
      if (req.routeOptions.config.secretExport && config.media.webrtc.allowClientSecrets !== true) return reply.code(404).send({ error: "WEBRTC_SECRET_EXPORT_DISABLED" });
      const auth = resolveApiConsumer(config, extractApiKey(config, req.headers));
      if (!auth.ok || !auth.consumer?.keyId || auth.consumer.isAnonymous) return reply.code(401).send({ error: "UNAUTHORIZED" });
      req.proxyAccess = { consumer: auth.consumer };
    });
    rtcApp.addHook("preParsing", async (req, reply, payload) => {
      const limit = getConfig().media.webrtc.maxSetupBytes;
      if (Number(req.headers["content-length"]) > limit) {
        throw Object.assign(realtimeError(413, "WEBRTC_SETUP_TOO_LARGE", "WebRTC setup exceeded its limit"), { statusCode: 413 });
      }
      return limitRequestBodyStream(payload, limit);
    });
    const createCall = async (req, reply) => {
      const config = getConfig();
      const publicRouteKey = req.routeOptions.config.realtimeRouteKey;
      const limits = { ...DEFAULT_WEBRTC, ...config.media?.webrtc };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.setupTimeoutMs);
      const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", abort);
      let upload;
      let lease;
      let reservation;
      let record;
      let committed = false;
      try {
        const consumer = req.proxyAccess.consumer;
        checkDirectMediaAccess(config, consumer);
        reservation = callRegistry.reserve(limits.maxCalls);
        upload = await readMediaMultipart(req, { ...config, media: { ...config.media, http: {
          ...config.media?.http, maxUploadBytes: limits.maxSetupBytes, maxFieldBytes: limits.maxSetupBytes,
          uploadTimeoutMs: limits.setupTimeoutMs
        } } }, { requireModel: false });
        const field = name => {
          const matches = upload.parts.filter(part => part.name === name);
          if (matches.length !== 1 || typeof matches[0].value !== "string") throw realtimeError(400, "WEBRTC_SETUP_REQUIRED", "Exactly one SDP and session field are required");
          return matches[0].value;
        };
        const sdp = field("sdp");
        const sessionText = field("session");
        const session = JSON.parse(sessionText);
        const transcription = publicRouteKey === "realtime" && session?.type === "transcription";
        const modelId = transcription ? session.audio?.input?.transcription?.model : session?.model;
        const binding = resolveRealtimeBinding(config, consumer, modelId, transcription ? "realtime/transcription_sessions" : publicRouteKey, transcription);
        const mapped = mapRealtimeEvent(`{"type":"session.update","session":${sessionText}}`, binding, config, consumer, true).data.toString();
        const sessionNode = findNodeAtLocation(parseTree(mapped), ["session"]);
        const mappedSession = mapped.slice(sessionNode.offset, sessionNode.offset + sessionNode.length);
        const context = getRequestContext(req);
        const admission = await acquireRequestGovernance(config, consumer, binding.model, Date.now(), { ...context, routeKey: `${binding.routeKey}/calls` });
        if (!admission.ok) throw realtimeError(admission.status, admission.code, admission.message);
        lease = admission.lease;
        const { headers, azure } = await controlHeaders(config, binding, req.headers, context);
        let body;
        if (azure || publicRouteKey === "realtime/translations") {
          if (upload.parts.some(part => !["sdp", "session"].includes(part.name))) throw realtimeError(400, "LOSSY_WEBRTC_SETUP", "Azure SDP setup cannot carry additional multipart fields");
          const secretResponse = await fetch(controlUrl(binding, "client_secrets"), { method: "POST", headers: { ...headers, "content-type": "application/json" },
            body: `{"expires_after":{"anchor":"created_at","seconds":${limits.clientSecretTtlSeconds}},"session":${mappedSession}}`,
            signal: controller.signal, redirect: "manual" });
          const secretBody = await boundedResponse(secretResponse, limits.maxResponseBytes);
          if (!secretResponse.ok) return forwardResponse(reply, secretResponse, secretBody);
          const secret = parseUpstreamJson(secretBody);
          if (typeof secret.value !== "string" || !secret.value) throw realtimeError(502, "INVALID_WEBRTC_SECRET", "Invalid upstream client secret");
          for (const name of Object.keys(headers)) if (["authorization", "api-key"].includes(name.toLowerCase())) delete headers[name];
          headers.authorization = `Bearer ${secret.value}`;
          headers["content-type"] = "application/sdp";
          body = sdp;
        } else {
          body = new FormData();
          for (const part of upload.parts) {
            if (part.file) body.append(part.name, part.file, part.filename);
            else body.append(part.name, part.name === "session" ? mappedSession : part.value);
          }
        }
        const target = controlUrl(binding, "calls");
        const response = await fetch(target, { method: "POST", headers, body, signal: controller.signal, redirect: "manual" });
        if (!response.ok) return forwardResponse(reply, response, await boundedResponse(response, limits.maxResponseBytes));
        const callId = parseCallLocation(response.headers.get("location"), target);
        const requestHangup = async () => {
          const control = await controlHeaders(config, binding, {}, context);
          return fetch(controlUrl(binding, `calls/${encodeURIComponent(callId)}/hangup`), {
            method: "POST", headers: control.headers, signal: AbortSignal.timeout(limits.setupTimeoutMs), redirect: "manual"
          });
        };
        record = { callId, keyId: consumer.keyId, consumer, publicRouteKey, binding, config, context, lease,
          catalogGeneration: getModelCatalogRuntimeInfo().generation,
          hangup: async () => {
            const ended = await requestHangup();
            return { response: ended, body: await boundedResponse(ended, limits.maxResponseBytes) };
          } };
        record.terminate = async () => {
          const ended = await requestHangup();
          const confirmed = ended.ok || ended.status === 404;
          try {
            await boundedResponse(ended, limits.maxResponseBytes);
          } catch (error) {
            if (!confirmed) throw error;
          }
          if (!confirmed) throw realtimeError(502, "WEBRTC_TERMINATION_UNCONFIRMED", "Call termination was not confirmed");
        };
        reservation.commit(record, limits.callTtlMs);
        committed = true;
        const responseBody = await boundedResponse(response, limits.maxResponseBytes);
        if (controller.signal.aborted) throw realtimeError(504, "WEBRTC_SETUP_TIMEOUT", "WebRTC setup timed out");
        reply.header("location", `/v1/${publicRouteKey}/calls/${encodeURIComponent(callId)}`);
        return forwardResponse(reply, response, responseBody);
      } catch (error) {
        if (committed) {
          try {
            await record.terminate();
            callRegistry.finish(record);
          } catch {
            req.log.warn({ event: "proxy.webrtc_setup_cleanup_unconfirmed", modelId: record.binding.model.id },
              "WebRTC setup failed after call creation and termination could not be confirmed");
          }
        }
        if (!reply.raw.destroyed) reply.code(error.status || (controller.signal.aborted ? 504 : 400)).send({ error: { code: error.code || "WEBRTC_SETUP_FAILED" } });
      } finally {
        clearTimeout(timeout);
        reply.raw.off("close", abort);
        upload?.release();
        reservation?.release();
        if (!committed) lease?.release();
      }
    };
    const exportSecret = async (req, reply) => {
      const config = getConfig();
      const publicRouteKey = req.routeOptions.config.realtimeRouteKey;
      const limits = config.media.webrtc;
      const consumer = req.proxyAccess.consumer;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), limits.setupTimeoutMs);
      const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", abort);
      let lease;
      let reservation;
      try {
        checkDirectMediaAccess(config, consumer, true);
        if (typeof req.body !== "string") throw realtimeError(400, "WEBRTC_JSON_REQUIRED", "JSON configuration is required");
        const body = JSON.parse(req.body);
        const transcription = publicRouteKey === "realtime" && body?.session?.type === "transcription";
        const modelId = transcription ? body.session.audio?.input?.transcription?.model : body?.session?.model;
        const binding = resolveRealtimeBinding(config, consumer, modelId, transcription ? "realtime/transcription_sessions" : publicRouteKey, transcription);
        const mapped = mapRealtimeEvent(req.body, binding, config, consumer, true, true).data.toString();
        const seconds = body.expires_after?.seconds ?? limits.clientSecretTtlSeconds;
        if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > limits.clientSecretTtlSeconds
          || (body.expires_after?.anchor != null && body.expires_after.anchor !== "created_at")) {
          throw realtimeError(400, "WEBRTC_SECRET_TTL", "Client secret TTL exceeds administrator policy");
        }
        const wireBody = applyEdits(mapped, modify(mapped, ["expires_after"], { anchor: "created_at", seconds }, {}));
        reservation = callRegistry.reserve(limits.maxCalls);
        const context = getRequestContext(req);
        const admission = await acquireRequestGovernance(config, consumer, binding.model, Date.now(), { ...context, routeKey: `${publicRouteKey}/client_secrets` });
        if (!admission.ok) throw realtimeError(admission.status, admission.code, admission.message);
        lease = admission.lease;
        const { headers } = await controlHeaders(config, binding, req.headers, context);
        const response = await fetch(controlUrl(binding, "client_secrets"), { method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: wireBody, signal: controller.signal, redirect: "manual" });
        const responseBody = await boundedResponse(response, limits.maxResponseBytes);
        if (!response.ok) return forwardResponse(reply, response, responseBody);
        const secret = parseUpstreamJson(responseBody);
        const now = Date.now() / 1000;
        if (typeof secret.value !== "string" || !secret.value || !Number.isFinite(secret.expires_at)
          || secret.expires_at <= now || secret.expires_at > now + seconds + 5) {
          throw realtimeError(502, "INVALID_WEBRTC_SECRET", "Upstream secret does not satisfy its TTL contract");
        }
        const publicBody = mapRealtimeEvent(responseBody, binding, config, consumer, false).data;
        return forwardResponse(reply, response, Buffer.from(publicBody));
      } catch (error) {
        if (!reply.raw.destroyed) reply.code(error.status || (controller.signal.aborted ? 504 : 400)).send({ error: { code: error.code || "WEBRTC_SECRET_FAILED" } });
      } finally {
        clearTimeout(timeout);
        reply.raw.off("close", abort);
        lease?.release();
        reservation?.release();
      }
    };
    const hangupCall = async (req, reply) => {
      try {
        const record = callRegistry.get(req.params.callId, req.proxyAccess.consumer, req.routeOptions.config.realtimeRouteKey, { allowExpired: true });
        const result = await record.hangup();
        if (result.response.ok || result.response.status === 404) callRegistry.finish(record);
        return forwardResponse(reply, result.response, result.body);
      } catch (error) {
        return reply.code(error.status || 502).send({ error: { code: error.code || "WEBRTC_CONTROL_FAILED" } });
      }
    };
    for (const realtimeRouteKey of ["realtime", "realtime/translations"]) {
      rtcApp.post(`/v1/${realtimeRouteKey}/calls`, { config: { realtimeRouteKey } }, createCall);
      rtcApp.post(`/v1/${realtimeRouteKey}/client_secrets`, { config: { realtimeRouteKey, secretExport: true } }, exportSecret);
      rtcApp.post(`/v1/${realtimeRouteKey}/calls/:callId/hangup`, { config: { realtimeRouteKey } }, hangupCall);
    }
  });
}