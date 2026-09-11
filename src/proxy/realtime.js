import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { getUpstreamAuthHeaders } from "../auth.js";
import { acquireRequestGovernance, checkUnmeteredRequestAccess, resolveApiConsumer } from "../governance.js";
import { resolveRequestContext } from "../request-context.js";
import { buildUpstreamHeaders } from "./upstream-headers.js";
import { DEFAULT_REALTIME, mapRealtimeEvent, realtimeError, resolveRealtimeBinding } from "./realtime-policy.js";
import { createMediaUsageTracker } from "./media-usage.js";
import { recordRequest } from "../stats.js";
import { recordRuntimeRequest } from "../runtime-store.js";
import { resolveModelDescriptor } from "../model-catalog.js";
import { findModel } from "./routing.js";
import { resolveMediaPricing, settleMediaUsage } from "./media-accounting.js";

function rejectUpgrade(socket, status, code) {
  if (socket.destroyed || socket.writableEnded) return;
  const body = JSON.stringify({ error: { type: "proxy_error", code } });
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] || "Error"}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function installRealtimeProxy({ server, getConfig, extractApiKey, log, callRegistry }) {
  const sessions = new Set();
  let draining = false;
  const handleUpgrade = async (request, socket, head) => {
    socket.on("error", () => {});
    socket.pause();
    let config = getConfig();
    const limits = { ...DEFAULT_REALTIME, ...config.media?.realtime };
    let upstreamSocket;
    let downstreamSocket;
    let lease;
    let stopped = false;
    let idleTimer;
    let heartbeat;
    let binding;
    let callRecord;
    let usageTracker = createMediaUsageTracker();
    let primaryPricing;
    let transcriptionPricing = null;
    let requestRecorded = false;
    let consumer;
    let routeKey;
    let initialEvent;
    let connecting = false;
    const pendingResponses = new Set();
    const pendingTranscripts = new Map();
    let translationPending = false;
    let transcriptionEnabled = false;
    let responseRequested = false;
    const context = resolveRequestContext({ headers: request.headers, id: randomUUID() });
    const timers = [];
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(idleTimer);
      clearInterval(heartbeat);
      lease?.release();
      sessions.delete(stop);
      callRecord?.observers.delete(stop);
      const incomplete = pendingResponses.size || pendingTranscripts.size || translationPending || responseRequested;
      const usage = requestRecorded && !callRecord
        ? settleMediaUsage({ config, consumer, model: binding.model, usage: usageTracker.snapshot(), completed: !incomplete, requestContext: context,
          routeKey: binding.routeKey, backendRouteKey: binding.routeKey }) : usageTracker.snapshot();
      log.info({ ...context, event: "proxy.realtime_closed", modelId: binding?.model.id,
        terminalStatus: incomplete ? "incomplete" : "observed-or-idle",
        ...usage }, "Realtime connection closed");
    };
    const closeSocket = (peer, code, reason = "") => {
      if (!peer || peer.readyState === WebSocket.CLOSED) return;
      if (peer.readyState === WebSocket.CONNECTING) peer.terminate();
      else {
        peer.close(code === 1005 ? 1000 : code === 1006 ? 1011 : code, reason);
        const timer = setTimeout(() => peer.terminate(), 1000);
        timer.unref();
        peer.once("close", () => clearTimeout(timer));
      }
    };
    const stop = (code = "REALTIME_CLOSED", status = 502, closeCode = 1011) => {
      if (stopped) return;
      if (!downstreamSocket) rejectUpgrade(socket, status, code);
      closeSocket(downstreamSocket, closeCode, code);
      closeSocket(upstreamSocket, closeCode, code);
      cleanup();
    };
    socket.once("close", () => {
      closeSocket(upstreamSocket, 1000);
      cleanup();
    });
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("REALTIME_IDLE_TIMEOUT", 504), limits.idleTimeoutMs);
    };
    const relay = (source, destination, data, binary, fromClient) => {
      if (stopped) return;
      if (binary) return stop("REALTIME_JSON_REQUIRED", 400, 1003);
      try {
        const mapped = mapRealtimeEvent(data, binding, config, consumer, fromClient);
        const event = mapped.event;
        if (fromClient && event?.type === "response.create") responseRequested = true;
        if (fromClient && routeKey === "realtime/translations" && ["session.input_audio_buffer.append", "session.close"].includes(event?.type)) translationPending = true;
        if (!fromClient) {
          if (event?.type === "response.done" && typeof event.response?.id === "string") usageTracker.observe(`response:${event.response.id}`, event.response.usage);
          if (event?.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string") {
            usageTracker.observe(`transcription:${event.item_id}`, event.usage, { pricing: pendingTranscripts.has(event.item_id)
              ? pendingTranscripts.get(event.item_id) : binding.transcription ? primaryPricing : null });
          }
          if (routeKey === "realtime/translations" && event?.type === "session.closed") usageTracker.observe("translation-session", event.usage, { cumulative: true });
          if (["session.created", "session.updated", "transcription_session.created", "transcription_session.updated"].includes(event?.type)) {
            const session = event.session;
            if (session?.audio?.input && Object.hasOwn(session.audio.input, "transcription")) transcriptionEnabled = typeof session.audio.input.transcription?.model === "string";
            else if (session && Object.hasOwn(session, "input_audio_transcription")) transcriptionEnabled = typeof session.input_audio_transcription?.model === "string";
            const auxiliaryId = session?.audio?.input?.transcription?.model ?? session?.input_audio_transcription?.model;
            const auxiliary = findModel(config, auxiliaryId);
            transcriptionPricing = auxiliary && auxiliary.upstream === binding.model.upstream
              ? resolveMediaPricing(config, auxiliary, binding.upstream, resolveModelDescriptor(auxiliary.id), binding.targetUrl.replace(/^ws/, "http")) : null;
          }
          if (event?.type === "response.created") { responseRequested = false; pendingResponses.add(event.response?.id || "pending"); }
          if (event?.type === "response.done") { responseRequested = false; pendingResponses.delete(event.response?.id || "pending"); }
          if ((binding.transcription || transcriptionEnabled) && event?.type === "input_audio_buffer.committed") pendingTranscripts.set(event.item_id, binding.transcription ? primaryPricing : transcriptionPricing);
          if (["conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.failed"].includes(event?.type)) pendingTranscripts.delete(event.item_id);
          if (event?.type === "session.closed") translationPending = false;
        }
        if (destination.bufferedAmount + Buffer.byteLength(mapped.data) > limits.maxBufferedBytes) return stop("REALTIME_BACKPRESSURE_LIMIT", 429, 1009);
        touch();
        source.pause();
        destination.send(mapped.data, { binary: false }, error => {
          if (error) stop("REALTIME_SEND_FAILED");
          else if (!fromClient && event?.type === "session.closed" && callRecord) {
            callRecord.terminalObserved = true;
            callRegistry.finish(callRecord);
          }
          else if (!stopped) source.resume();
        });
      } catch (error) { stop(error.code || "REALTIME_EVENT_FAILED", error.status || 400, 1008); }
    };
    const acceptDownstream = () => {
      const wsServer = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: limits.maxMessageBytes,
        perMessageDeflate: false, handleProtocols: protocols => protocols.has("realtime") ? "realtime" : false });
      wsServer.handleUpgrade(request, socket, head, downstream => {
        downstreamSocket = downstream;
        timers.push(setTimeout(() => stop("REALTIME_MAX_DURATION", 408, 1000), limits.maxSessionMs));
        downstream.on("message", (data, binary) => {
          if (stopped) return;
          if (binding && upstreamSocket?.readyState === WebSocket.OPEN) return relay(downstream, upstreamSocket, data, binary, true);
          if (binding || connecting) return stop("REALTIME_NOT_READY", 400, 1008);
          if (binary || data.length > limits.maxInitialConfigBytes) return stop("REALTIME_CONFIG_TOO_LARGE", 400, 1009);
          try {
            const event = JSON.parse(data.toString());
            const modelId = event?.session?.audio?.input?.transcription?.model;
            if (event?.type !== "session.update" || event?.session?.type !== "transcription" || typeof modelId !== "string") {
              throw realtimeError(400, "REALTIME_CONFIG_REQUIRED", "A transcription session.update is required before audio");
            }
            binding = resolveRealtimeBinding(config, consumer, modelId, "realtime/transcription_sessions", true);
            mapRealtimeEvent(data, binding, config, consumer, true);
            initialEvent = data;
            clearTimeout(timers[0]);
            timers.push(setTimeout(() => stop("REALTIME_HANDSHAKE_TIMEOUT", 504), limits.handshakeTimeoutMs));
            void connectUpstream().catch(error => stop(error.code || "REALTIME_UPSTREAM_ERROR", error.status || 502));
          } catch (error) { stop(error.code || "INVALID_REALTIME_CONFIG", error.status || 400, 1008); }
        });
        downstream.on("error", () => stop("REALTIME_CLIENT_ERROR", 400));
        downstream.once("close", (code, reason) => { closeSocket(upstreamSocket, code, reason); cleanup(); });
        socket.resume();
      });
    };
    const connectUpstream = async () => {
      connecting = true;
      primaryPricing = callRecord ? callRecord.pricing : resolveMediaPricing(config, binding.model, binding.upstream,
        resolveModelDescriptor(binding.model.id), binding.targetUrl.replace(/^ws/, "http"));
      if (!callRecord && !requestRecorded) {
        usageTracker = createMediaUsageTracker({ pricing: primaryPricing });
        recordRequest(binding.model.id, consumer);
        recordRuntimeRequest(config, { ...context, keyId: consumer?.keyId, modelId: binding.model.id, routeKey: binding.routeKey, stream: true });
        requestRecorded = true;
      }
      const upstream = binding.upstream;
      const azure = upstream.provider === "azure-openai" || new URL(binding.targetUrl).pathname.startsWith("/openai/");
      const upstreamAuth = await getUpstreamAuthHeaders(azure ? "https://ai.azure.com/.default" : config.auth.scope, { auth: upstream.auth });
      if (!azure && upstreamAuth["api-key"]) {
        upstreamAuth.authorization = `Bearer ${upstreamAuth["api-key"]}`;
        delete upstreamAuth["api-key"];
      }
      if (stopped) return;
      const { headers } = buildUpstreamHeaders({ incomingHeaders: request.headers, config, backendRouteKey: routeKey,
        upstream, targetUrl: binding.targetUrl, upstreamAuthHeaders: upstreamAuth, requestContext: context });
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase().startsWith("sec-websocket-") || ["content-type", "content-length", "content-encoding", "openai-beta"].includes(name.toLowerCase())) delete headers[name];
      }
      upstreamSocket = new WebSocket(binding.targetUrl, { headers, maxPayload: limits.maxMessageBytes,
        perMessageDeflate: false, followRedirects: false, handshakeTimeout: limits.handshakeTimeoutMs });
      upstreamSocket.once("open", () => {
        if (stopped) return closeSocket(upstreamSocket, 1000);
        for (const timer of timers) clearTimeout(timer);
        timers.length = 0;
        if (!downstreamSocket) acceptDownstream();
        else timers.push(setTimeout(() => stop("REALTIME_MAX_DURATION", 408, 1000), limits.maxSessionMs));
        if (!downstreamSocket) return stop("REALTIME_HANDSHAKE_FAILED");
        touch();
        if (initialEvent) relay(downstreamSocket, upstreamSocket, initialEvent, false, true);
        const alive = new Map([[downstreamSocket, true], [upstreamSocket, true]]);
        for (const peer of alive.keys()) peer.on("pong", () => alive.set(peer, true));
        heartbeat = setInterval(() => {
          for (const [peer, responded] of alive) {
            if (!responded) return stop("REALTIME_HEARTBEAT_TIMEOUT", 504);
            if (peer.readyState === WebSocket.OPEN) { alive.set(peer, false); peer.ping(); }
          }
        }, limits.heartbeatMs);
      });
      upstreamSocket.on("message", (data, binary) => {
        if (downstreamSocket) relay(upstreamSocket, downstreamSocket, data, binary, false);
        else stop("REALTIME_HANDSHAKE_FAILED");
      });
      upstreamSocket.on("error", () => stop("REALTIME_UPSTREAM_ERROR"));
      upstreamSocket.once("unexpected-response", (upstreamRequest, response) => {
        const chunks = [];
        let size = 0;
        response.on("data", chunk => {
          size += chunk.length;
          if (size > limits.maxInitialConfigBytes) { response.destroy(); stop("REALTIME_UPSTREAM_ERROR_TOO_LARGE"); }
          else chunks.push(chunk);
        });
        response.on("error", () => stop("REALTIME_UPSTREAM_ERROR"));
        response.on("end", () => {
          if (stopped) return;
          const body = Buffer.concat(chunks);
          if (downstreamSocket) {
            if (downstreamSocket.bufferedAmount + body.length <= limits.maxBufferedBytes) downstreamSocket.send(body, { binary: false });
            stop("REALTIME_UPSTREAM_REJECTED", response.statusCode);
          } else {
            const status = response.statusCode >= 400 ? response.statusCode : 502;
            const retryAfter = response.headers["retry-after"];
            socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: ${response.headers["content-type"] || "application/json"}\r\n${retryAfter ? `Retry-After: ${retryAfter}\r\n` : ""}Content-Length: ${body.length}\r\n\r\n`);
            socket.end(body);
            cleanup();
          }
          upstreamRequest.destroy();
        });
      });
      upstreamSocket.once("close", (code, reason) => {
        if (!downstreamSocket) return stop("REALTIME_UPSTREAM_CLOSED");
        if (pendingResponses.size || pendingTranscripts.size || translationPending || responseRequested) {
          closeSocket(downstreamSocket, 1011, "REALTIME_INCOMPLETE_STREAM");
        } else closeSocket(downstreamSocket, code, reason);
        cleanup();
      });
    };
    try {
      const url = new URL(request.url, "http://proxy");
      routeKey = url.pathname === "/v1/realtime" ? "realtime" : url.pathname === "/v1/realtime/translations" ? "realtime/translations" : "";
      const sideband = url.searchParams.has("call_id");
      if (!routeKey || (sideband ? config.media?.webrtc?.enabled !== true : limits.enabled !== true) || draining) throw realtimeError(404, "REALTIME_DISABLED", "Realtime disabled");
      const authResult = resolveApiConsumer(config, extractApiKey(config, request.headers));
      if (!authResult.ok) throw realtimeError(authResult.status || 401, "UNAUTHORIZED", "Unauthorized");
      consumer = authResult.consumer;
      const metering = checkUnmeteredRequestAccess(config, consumer);
      if (!metering.ok) throw realtimeError(metering.status, metering.code, metering.message);
      if (request.method !== "GET" || request.headers["sec-websocket-version"] !== "13"
        || !/^[+/0-9A-Za-z]{22}==$/.test(request.headers["sec-websocket-key"] || "")) throw realtimeError(400, "INVALID_WEBSOCKET_HANDSHAKE", "Invalid handshake");
      if (sessions.size >= limits.maxConnections) throw realtimeError(429, "REALTIME_CAPACITY", "Realtime capacity exceeded");
      const transcription = routeKey === "realtime" && url.searchParams.get("intent") === "transcription";
      if (sideband) {
        if ([...url.searchParams.keys()].some(name => name !== "call_id") || url.searchParams.getAll("call_id").length !== 1 || !callRegistry) {
          throw realtimeError(400, "INVALID_WEBRTC_CONTROL", "Only one owned call_id may be supplied");
        }
        callRecord = callRegistry.get(url.searchParams.get("call_id"), consumer, routeKey);
        usageTracker = callRecord.usageTracker;
        if (callRecord.observers.size) throw realtimeError(429, "WEBRTC_OBSERVER_ACTIVE", "A sideband is already attached");
        config = callRecord.config;
        const target = new URL(callRecord.binding.targetUrl);
        target.searchParams.delete("model");
        target.searchParams.delete("intent");
        target.searchParams.set("call_id", callRecord.callId);
        binding = { ...callRecord.binding, targetUrl: target.toString() };
        callRecord.observers.add(stop);
      } else if ([...url.searchParams.keys()].some(name => !["model", "intent"].includes(name)) || url.searchParams.getAll("model").length > 1
        || url.searchParams.getAll("intent").length > 1 || (!transcription && !url.searchParams.get("model"))) {
        throw realtimeError(400, "REALTIME_MODEL_REQUIRED", "Exactly one public model is required");
      }
      if (url.searchParams.has("intent") && !transcription) throw realtimeError(400, "REALTIME_INTENT_UNSUPPORTED", "Invalid realtime intent");
      if (url.searchParams.has("model")) binding = resolveRealtimeBinding(config, consumer, url.searchParams.get("model"), transcription ? "realtime/transcription_sessions" : routeKey, transcription);
      sessions.add(stop);
      timers.push(setTimeout(() => stop(binding ? "REALTIME_HANDSHAKE_TIMEOUT" : "REALTIME_CONFIG_TIMEOUT", 504), binding ? limits.handshakeTimeoutMs : limits.initialConfigTimeoutMs));
      const admission = callRecord ? { ok: true } : await acquireRequestGovernance(config, consumer, binding?.model, Date.now(), { ...context, routeKey });
      if (!admission.ok) throw realtimeError(admission.status || 429, admission.code, admission.message);
      lease = admission.lease;
      if (stopped) { lease?.release(); return; }
      if (!binding) acceptDownstream();
      else await connectUpstream();
    } catch (error) { stop(error.code || "REALTIME_REQUEST_FAILED", error.status || 502); }
  };
  server.on("upgrade", handleUpgrade);
  return { close() {
    draining = true;
    for (const stop of sessions) stop("REALTIME_SERVER_SHUTDOWN", 503, 1001);
  } };
}