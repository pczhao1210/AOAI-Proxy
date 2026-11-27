import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { operationFields, operationLimit } from "./channel-operation-fields.js";
import { getInferenceRevision } from "./inference-binding.js";
import { appendStructuredLog, getLogRuntimeInfo, queryLogs } from "./logs.js";
import { getRuntimeStoreInfo, readRuntimeOperations, recordRuntimeOperation } from "./runtime-store.js";

const failures = new Map();
const recovery = new Map([
  ["proxy.copilot_token_refresh_succeeded", "proxy.copilot_token_refresh_failed"],
  ["proxy.copilot_auth_recovered", "proxy.copilot_auth_required"],
  ["proxy.copilot_models_refreshed", "proxy.copilot_models_refresh_failed"]
]);
const transitions = new Set(recovery.values());

export function recordChannelOperation(config, fields) {
  const record = operationFields({ ...fields, configRevision: fields?.configRevision ?? getInferenceRevision(config) }, config);
  if (!record) return null;
  const now = Date.now();
  const connection = [record.connectionId, record.authProfile];
  if (transitions.has(record.event)) {
    const key = JSON.stringify([...connection, record.event, record.errorCode]);
    const prior = failures.get(key);
    if (prior && now - prior.lastPublished < 60000) {
      prior.count++;
      return null;
    }
    if (prior) {
      record.suppressedFailures = prior.count;
      record.firstFailureAt = prior.first;
    }
    failures.delete(key);
    if (failures.size >= 256) failures.delete(failures.keys().next().value);
    failures.set(key, { event: record.event, connection: JSON.stringify(connection), first: prior?.first || new Date(now).toISOString(), lastPublished: now, count: 0 });
  } else if (recovery.has(record.event)) {
    for (const [key, prior] of failures) {
      if (prior.connection !== JSON.stringify(connection) || prior.event !== recovery.get(record.event)) continue;
      record.suppressedFailures = (record.suppressedFailures || 0) + prior.count;
      if (!record.firstFailureAt || prior.first < record.firstFailureAt) record.firstFailureAt = prior.first;
      failures.delete(key);
    }
  }
  record.eventUid = randomUUID();
  record.operationId ||= randomUUID();
  record.ts = new Date(now).toISOString();
  appendStructuredLog(record.level, record);
  recordRuntimeOperation(config, record);
  return record.eventUid;
}

export function queryChannelOperations(config, filters = {}) {
  if (filters.recordSource === "database") return readRuntimeOperations(config, filters);
  const limit = operationLimit(filters.limit);
  const result = queryLogs({ ...filters, view: "operations", limit });
  const runtime = getRuntimeStoreInfo(config);
  const memory = getLogRuntimeInfo(config);
  return {
    ...result, recordSource: "memory", persistence: !runtime.enabled ? "disabled" : runtime.configured ? "configured" : "unavailable",
    capturedAt: new Date().toISOString(), memoryBufferSize: memory.memoryBufferSize, droppedEvents: memory.memoryDroppedEntries,
    hasMore: result.total > limit
  };
}

function keyed(rows, field) {
  return new Map((rows || []).filter(row => row?.[field]).map(row => [row[field], row]));
}

function *differences(before, after, field) {
  const original = keyed(before, field);
  for (const next of after || []) {
    if (!next?.[field]) continue;
    yield [original.get(next[field]), next];
    original.delete(next[field]);
  }
  for (const previous of original.values()) yield [previous, null];
}

const changeType = (before, after) => !before ? "added" : !after ? "removed" : "updated";
const visible = item => Boolean(item && item.status !== "disabled" && item.enabled !== false);
const MAX_DETAILS_PER_EVENT = 16;

// Compare the previous persisted config to the new persisted one, or the actual running
// snapshot to the candidate being applied. Never serialize or hash a secret-bearing row.
export function recordChannelConfigChanges(config, before, after, context) {
  const counts = new Map();
  const operationId = context.operationId || randomUUID();
  const emit = (event, fields) => {
    const n = (counts.get(event) || 0) + 1;
    counts.set(event, n);
    if (n <= MAX_DETAILS_PER_EVENT) recordChannelOperation(config, { ...context, operationId, event, ...fields });
  };
  for (const [a, b] of differences(before.upstreams, after.upstreams, "channelId")) {
    const channelId = (b || a).channelId;
    if (!a || !b || a.name !== b.name || visible(a) !== visible(b)) emit("admin.channel_mappings_changed", {
      channelId, change: changeType(a, b), upstream: b?.name, previousUpstream: a?.name,
      enabledBefore: visible(a), enabledAfter: visible(b)
    });
    for (const [p, n] of differences(a?.modelMappings, b?.modelMappings, "sourceModelId")) {
      if (p && n && isDeepStrictEqual(p, n)) continue;
      emit("admin.channel_mappings_changed", {
        channelId, change: changeType(p, n), sourceModelId: (n || p).sourceModelId,
        canonicalModelId: n?.canonicalModelId, previousCanonicalModelId: p?.canonicalModelId,
        enabledBefore: p?.enabled, enabledAfter: n?.enabled,
        changedFields: ["canonicalModelId", "enabled", "routes", "pricing", "hostingMode"].filter(field => !isDeepStrictEqual(p?.[field], n?.[field]))
      });
    }
  }
  for (const [p, n] of differences(before.models, after.models, "id")) {
    const modelId = (n || p).id;
    const channelId = n?.selectedBinding?.channelId;
    const previousChannelId = p?.selectedBinding?.channelId;
    const fields = { modelId, channelId, previousChannelId, sourceModelId: n?.selectedBinding?.sourceModelId || n?.targetModel,
      previousSourceModelId: p?.selectedBinding?.sourceModelId || p?.targetModel, canonicalModelId: n?.canonicalModelId,
      previousCanonicalModelId: p?.canonicalModelId, upstream: n?.upstream, previousUpstream: p?.upstream };
    if (!p || !n || visible(p) !== visible(n)) emit("admin.model_exposure_changed", {
      ...fields, change: changeType(p, n), enabledBefore: visible(p), enabledAfter: visible(n)
    });
    if (p && n && (!isDeepStrictEqual(p.selectedBinding, n.selectedBinding)
      || (!channelId && !previousChannelId && (p.upstream !== n.upstream || p.targetModel !== n.targetModel)))) {
      emit("admin.model_channel_changed", { ...fields, change: "updated" });
    }
  }
  for (const [p, n] of differences(before.apiKeys, after.apiKeys, "id")) {
    const prior = new Set(p?.allowedModels || []);
    const next = new Set(n?.allowedModels || []);
    const added = [...next].filter(id => !prior.has(id));
    const removed = [...prior].filter(id => !next.has(id));
    if (p && n && p.modelAccessMode === n.modelAccessMode && visible(p) === visible(n) && !added.length && !removed.length) continue;
    const key = n || p;
    emit("admin.key_model_access_changed", {
      change: changeType(p, n), keyRecordId: [p?.key, n?.key].includes(key.id) ? undefined : key.id,
      modeBefore: p && (p.modelAccessMode || "legacy"), modeAfter: n && (n.modelAccessMode || "legacy"),
      enabledBefore: visible(p), enabledAfter: visible(n),
      addedCount: added.length, removedCount: removed.length, addedModels: added.slice(0, 8), removedModels: removed.slice(0, 8)
    });
  }
  for (const [event, count] of counts) {
    if (count > MAX_DETAILS_PER_EVENT) recordChannelOperation(config, {
      ...context, operationId, event, change: "summary", count, omittedCount: count - MAX_DETAILS_PER_EVENT
    });
  }
}
