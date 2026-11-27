import { billingTierIdentity, summarizeCacheWrite } from "./statistics.js";

const counts = ["requests", "errors", "settledRequests", "unknownCostRequests", "promptTokens", "completionTokens",
  "totalTokens", "cachedTokens", "textUnknownCostRequests", "estimatedCostAmount"];
const writeFields = ["requests", "observedRequests", "pricedRequests", "partialCostRequests",
  "unreportedRequests", "observedTokens", "knownCostAmount"];
const nullable = value => typeof value === "string" && value ? value : null;

// Only evidence captured by this event belongs here. Revision is kept on the event,
// not the group key: an unrelated configuration save must not split a billing row.
export function channelIdentity(modelId, fields, phase, audit, costStatus, currency) {
  return {
    modelId, canonicalModelId: nullable(fields.canonicalModelId), channelId: nullable(fields.channelId),
    sourceModelId: nullable(fields.sourceModelId), routeKey: nullable(fields.routeKey),
    backendRouteKey: nullable(fields.backendRouteKey), actualModelName: nullable(fields.reportedModelName || fields.actualModelName),
    tier: phase === "usage" ? billingTierIdentity(modelId, fields.actualModelName, audit).tier : null,
    usageSource: phase === "usage" ? nullable(fields.usageSource) : null,
    costStatus: phase === "usage" ? nullable(costStatus) : null, currency: phase === "usage" ? nullable(currency) : null
  };
}

function sumEvidence(left, right) {
  return left == null && right == null ? null : (left ?? 0) + (right ?? 0);
}

function emptyMetrics() {
  return { ...Object.fromEntries(counts.map(key => [key, 0])), cacheWrite: summarizeCacheWrite(), knownCostAmounts: Object.create(null) };
}

export function addChannelMetrics(target, row) {
  for (const field of counts) {
    if (row[field] === null || target[field] === null) target[field] = null;
    else target[field] += row[field] ?? 0;
  }
  const write = {};
  for (const field of writeFields) {
    const a = target.cacheWrite[field], b = row.cacheWrite?.[field];
    write[field] = field === "unreportedRequests" && (a === null || b === null) ? null : sumEvidence(a, b);
  }
  target.cacheWrite = summarizeCacheWrite(write);
  for (const [currency, value] of Object.entries(row.knownCostAmounts || {})) {
    target.knownCostAmounts[currency] = (target.knownCostAmounts[currency] ?? 0) + value;
  }
  return target;
}

export function channelMetric(phase, count, metric, identity) {
  const usage = phase === "usage";
  return {
    ...(usage ? metric : {}), requests: phase === "request" ? count : 0, errors: phase === "error" ? count : 0,
    settledRequests: usage ? count : 0, unknownCostRequests: usage && identity.costStatus !== "priced" ? count : 0,
    knownCostAmounts: usage && identity.currency && (metric.estimatedCostAmount > 0 || identity.costStatus === "priced")
      ? { [identity.currency]: metric.estimatedCostAmount ?? 0 } : {}
  };
}

export function accumulateChannelDetail(map, identity, metric, key = JSON.stringify(identity)) {
  let detail = map.get(key);
  if (!detail) map.set(key, detail = { ...identity, ...emptyMetrics() });
  addChannelMetrics(detail, metric);
}

function finalize(node) {
  node.knownCostAmounts = { ...node.knownCostAmounts };
  const currencies = Object.keys(node.knownCostAmounts);
  node.estimatedCostCurrency = currencies.length === 1 ? currencies[0] : null;
  node.knownCostAmount = node.estimatedCostCurrency ? node.knownCostAmounts[node.estimatedCostCurrency] : null;
  node.estimatedCostAmount = node.unknownCostRequests === 0 && node.settledRequests > 0 ? node.knownCostAmount : null;
  return node;
}

// Group leaves once. Public aliases, actual models and tiers are details, never
// additional contributions to a parent. Maps distinguish a missing ID from any real ID.
export function channelTree(details) {
  const models = new Map();
  for (const row of details) {
    let parent = models.get(row.canonicalModelId);
    if (!parent) models.set(row.canonicalModelId, parent = {
      canonicalModelId: row.canonicalModelId, channels: new Map(), ...emptyMetrics()
    });
    let child = parent.channels.get(row.channelId);
    if (!child) parent.channels.set(row.channelId, child = { channelId: row.channelId, details: [], ...emptyMetrics() });
    child.details.push(finalize({ ...row }));
    addChannelMetrics(child, row);
    addChannelMetrics(parent, row);
  }
  const sorted = (map, property) => [...map.values()].sort((a, b) => a[property] === b[property] ? 0
    : a[property] === null ? 1 : b[property] === null || a[property] < b[property] ? -1 : 1);
  return sorted(models, "canonicalModelId").map(parent => finalize({
    ...parent, channels: sorted(parent.channels, "channelId").map(finalize)
  }));
}

// Pre-upgrade daily model rollups may outlive their events. Reconcile only the
// uncovered public-model balance, without consulting the current catalog or bindings.
export function reconcileChannelHistory(details, perModel) {
  const covered = new Map();
  for (const row of details) {
    if (!covered.has(row.modelId)) covered.set(row.modelId, emptyMetrics());
    addChannelMetrics(covered.get(row.modelId), row);
  }
  const residuals = [];
  for (const [modelId, model] of Object.entries(perModel)) {
    const known = covered.get(modelId) || emptyMetrics();
    const residual = {};
    let missing = false;
    const difference = (value, accounted, floating = false) => {
      if (value == null) return null;
      const diff = Math.max(0, value - (accounted ?? 0));
      if (floating && accounted > 0 && diff <= 1e-12 * value) return 0;
      if (diff > 0) missing = true;
      return diff;
    };
    for (const name of counts.filter(key => !["settledRequests", "unknownCostRequests"].includes(key))) {
      residual[name] = difference(model[name], known[name], name === "estimatedCostAmount");
    }
    const write = {};
    for (const key of writeFields) {
      write[key] = difference(model.cacheWrite?.[key], known.cacheWrite[key], key === "knownCostAmount");
      if (key === "unreportedRequests" && write[key] === null && known.cacheWrite[key] !== null) missing = true;
    }
    if (!missing) continue;
    if (!write.observedRequests && !write.observedTokens) write.observedTokens = null;
    if (!write.pricedRequests && !write.partialCostRequests && !write.knownCostAmount) write.knownCostAmount = null;
    const identity = channelIdentity(modelId, {}, "", null, null, null);
    residuals.push({ ...identity, ...residual, cacheWrite: summarizeCacheWrite(write),
      knownCostAmounts: residual.estimatedCostAmount > 0 ? { [model.estimatedCostCurrency]: residual.estimatedCostAmount } : {},
      settledRequests: null, unknownCostRequests: null });
  }
  return channelTree([...details, ...residuals]);
}

// A bounded event window supports precise rolling-time filters without keeping
// unbounded event history in a file-only deployment. All-time aggregates survive eviction.
export function createMemoryChannelLedger(capacity = 8192) {
  const keys = new Map(), discardedByKey = new Map(), recent = new Array(capacity);
  let position = 0, size = 0, discardedThrough = -Infinity;
  return {
    record(keyId, timestamp, identity, metric) {
      if (!keys.has(keyId)) keys.set(keyId, new Map());
      accumulateChannelDetail(keys.get(keyId), identity, metric);
      if (size === capacity) {
        const old = recent[position];
        discardedThrough = Math.max(discardedThrough, old.timestamp);
        discardedByKey.set(old.keyId, Math.max(discardedByKey.get(old.keyId) ?? -Infinity, old.timestamp));
      }
      recent[position] = { keyId, timestamp, identity, metric };
      size = Math.min(capacity, size + 1);
      position = (position + 1) % capacity;
    },
    snapshot({ keyId, since } = {}) {
      const leaves = new Map();
      if (since) {
        const from = Date.parse(since);
        for (let i = 0; i < size; i++) {
          const entry = recent[i];
          if (entry.timestamp >= from && (!keyId || entry.keyId === keyId)) accumulateChannelDetail(leaves, entry.identity, entry.metric);
        }
      } else {
        for (const [key, groups] of keys) {
          if (keyId && key !== keyId) continue;
          for (const [id, row] of groups) accumulateChannelDetail(leaves, row, row, id);
        }
      }
      const cutoff = keyId ? discardedByKey.get(keyId) ?? -Infinity : discardedThrough;
      return { canonicalModels: channelTree(leaves.values()), canonicalWindowTruncated: !!since && cutoff >= Date.parse(since) };
    }
  };
}
