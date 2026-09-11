import { checkConsumerModelAccess } from "../governance.js";
import { applyEdits, parseTree } from "jsonc-parser";
import { resolveModelDescriptor } from "../model-catalog.js";
import { findModel, findUpstream, isPublicRouteEnabled, resolveRoutePlan } from "./routing.js";

export const DEFAULT_REALTIME = Object.freeze({
  enabled: false,
  maxConnections: 100,
  maxMessageBytes: 8 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  handshakeTimeoutMs: 10000,
  initialConfigTimeoutMs: 10000,
  maxInitialConfigBytes: 64 * 1024,
  idleTimeoutMs: 60000,
  maxSessionMs: 3600000,
  heartbeatMs: 30000
});

export function realtimeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function resolveRealtimeBinding(config, consumer, modelId, routeKey, transcription = false) {
  const model = findModel(config, modelId);
  if (!model) throw realtimeError(404, "MODEL_NOT_FOUND", "Model not found");
  const access = checkConsumerModelAccess(consumer, model);
  if (!access.ok) throw realtimeError(access.status, access.code, access.message);
  if (!isPublicRouteEnabled(config, routeKey)) throw realtimeError(404, "REALTIME_DISABLED", "Realtime route is disabled");
  const upstream = findUpstream(config, model.upstream);
  if (!upstream || upstream.status === "disabled") throw realtimeError(503, "UPSTREAM_UNAVAILABLE", "Upstream unavailable");
  let plan;
  try { plan = resolveRoutePlan({ routeKey, model, upstream, descriptor: resolveModelDescriptor(model.id) }); } catch {
    throw realtimeError(400, "UNSUPPORTED_PROTOCOL_ROUTE", "Model has no usable native realtime route");
  }
  const target = new URL(plan.targetUrl);
  const suffix = transcription ? "/realtime" : `/${routeKey}`;
  if (!target.pathname.replace(/\/+$/, "").endsWith(suffix) || !["http:", "https:"].includes(target.protocol)) {
    throw realtimeError(400, "UNSUPPORTED_PROTOCOL_ROUTE", "Invalid realtime endpoint");
  }
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  if (transcription) {
    target.searchParams.delete("model");
    target.searchParams.set("intent", "transcription");
  } else target.searchParams.set("model", model.targetModel || model.id);
  return { model, upstream, targetUrl: target.toString(), routeKey, transcription, modelNames: new Map([[model.targetModel || model.id, model.id]]) };
}

export function mapRealtimeEvent(data, binding, config, consumer, fromClient, configuration = false) {
  let event;
  try { event = JSON.parse(data.toString()); } catch {
    if (!fromClient) return { data, event: null };
    throw realtimeError(400, "INVALID_REALTIME_EVENT", "Realtime events must be JSON objects");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    if (!fromClient) return { data, event };
    throw realtimeError(400, "INVALID_REALTIME_EVENT", "Realtime events must be JSON objects");
  }
  const text = data.toString();
  const tree = parseTree(text);
  const edits = [];
  const findUniqueNode = path => {
    let node = tree;
    for (const key of path) {
      if (node?.type !== "object") return;
      const matches = node.children.filter(property => property.children[0].value === key);
      if (matches.length > 1) throw realtimeError(400, "AMBIGUOUS_REALTIME_EVENT", "Duplicate realtime routing fields are not allowed");
      node = matches[0]?.children[1];
    }
    return node;
  };
  findUniqueNode(["type"]);
  if (configuration) {
    findUniqueNode(["expires_after", "anchor"]);
    findUniqueNode(["expires_after", "seconds"]);
  }
  const rewrite = (object, primary, path) => {
    const node = findUniqueNode(path);
    if (!object || !Object.hasOwn(object, "model")) return;
    const original = object.model;
    if (!fromClient) {
      if (binding.modelNames.has(original)) object.model = binding.modelNames.get(original);
    } else if (primary) {
      if (original !== binding.model.id) throw realtimeError(403, "REALTIME_MODEL_BOUND", "Session model is bound to the authorized public model");
      object.model = binding.model.targetModel || binding.model.id;
    } else {
      const secondary = findModel(config, original);
      const access = secondary && checkConsumerModelAccess(consumer, secondary);
      if (!access?.ok || secondary.upstream !== binding.model.upstream) {
        throw realtimeError(403, "REALTIME_TRANSCRIPTION_MODEL_DENIED", "Transcription model must be authorized on the same upstream");
      }
      object.model = secondary.targetModel || secondary.id;
      binding.modelNames.set(object.model, secondary.id);
    }
    if (original !== object.model && node) edits.push({ offset: node.offset, length: node.length, content: JSON.stringify(object.model) });
  };
  if (configuration || !fromClient || event.type === "session.update" || event.type === "transcription_session.update") {
    rewrite(event.session, true, ["session", "model"]);
    rewrite(event.session?.audio?.input?.transcription, binding.transcription, ["session", "audio", "input", "transcription", "model"]);
    rewrite(event.session?.input_audio_transcription, binding.transcription, ["session", "input_audio_transcription", "model"]);
  }
  if (!fromClient || event.type === "response.create") rewrite(event.response, true, ["response", "model"]);
  return { data: edits.length ? applyEdits(text, edits) : data, event };
}