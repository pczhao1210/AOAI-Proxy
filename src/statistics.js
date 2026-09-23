export function normalizeCacheWrite(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tokens = value.usageStatus === "observed" && Number.isInteger(value.tokens) && value.tokens >= 0 ? value.tokens : null;
  const knownCostAmount = Number.isFinite(value.knownCostAmount) && value.knownCostAmount >= 0 ? value.knownCostAmount : 0;
  const priced = value.costStatus === "priced" && Number.isFinite(value.estimatedCostAmount) && value.estimatedCostAmount >= 0;
  return {
    tokens,
    usageStatus: tokens === null ? "unknown" : "observed",
    knownCostAmount,
    estimatedCostAmount: priced ? value.estimatedCostAmount : null,
    costStatus: priced ? "priced" : value.costStatus === "partial" || knownCostAmount > 0 ? "partial" : "unknown"
  };
}

export function summarizeCacheWrite({
  requests = 0, observedRequests = 0, pricedRequests = 0, partialCostRequests = 0,
  unreportedRequests = 0, observedTokens = null, knownCostAmount = null
} = {}) {
  const usageComplete = requests > 0 && unreportedRequests === 0 && observedRequests === requests;
  const costComplete = requests > 0 && unreportedRequests === 0 && pricedRequests === requests;
  return {
    requests, observedRequests, pricedRequests, partialCostRequests, unreportedRequests,
    unknownUsageRequests: requests - observedRequests,
    unknownCostRequests: requests - pricedRequests,
    observedTokens,
    tokens: usageComplete ? observedTokens : null,
    usageStatus: usageComplete ? "observed" : "unknown",
    knownCostAmount,
    estimatedCostAmount: costComplete ? knownCostAmount : null,
    costStatus: costComplete ? "priced" : pricedRequests > 0 || partialCostRequests > 0 || knownCostAmount > 0 ? "partial" : "unknown"
  };
}

export function billingTierIdentity(modelId, actualModelId, audit) {
  const actual = String(actualModelId || modelId || "__unclassified__").trim() || "__unclassified__";
  const selected = audit?.tier;
  const lower = selected?.promptTokensAtLeast;
  const upper = selected?.promptTokensBelow;
  const validTier = Number.isSafeInteger(lower) && lower >= 0
    && (upper === null || Number.isSafeInteger(upper) && upper > lower);
  const tier = validTier
    ? { kind: "tier", promptTokensAtLeast: lower, promptTokensBelow: upper,
      ...(typeof selected.id === "string" && selected.id.trim() ? { id: selected.id.trim() } : {}) }
    : { kind: audit?.tieringState === "flat" ? "flat" : "unknown", promptTokensAtLeast: null, promptTokensBelow: null };
  return { actualModelId: actual, tier };
}

export function billingTierKey(identity) {
  const parts = [identity.actualModelId, identity.tier.kind, identity.tier.promptTokensAtLeast, identity.tier.promptTokensBelow];
  if (identity.tier.id) parts.push(identity.tier.id);
  return JSON.stringify(parts);
}

export function billingTierGroupKey(identity) {
  return identity.tier.id
    ? JSON.stringify([identity.actualModelId, identity.tier.kind, identity.tier.id])
    : billingTierKey(identity);
}

export function mergeBillingTierIntervals(left, right) {
  if (!left.id || left.id !== right.id) return left;
  if (!left.intervals && !right.intervals && left.promptTokensAtLeast === right.promptTokensAtLeast
    && left.promptTokensBelow === right.promptTokensBelow) return left;
  const intervals = new Map();
  for (const tier of [left, right]) {
    for (const interval of tier.intervals || [tier]) {
      const bounds = { promptTokensAtLeast: interval.promptTokensAtLeast, promptTokensBelow: interval.promptTokensBelow };
      intervals.set(JSON.stringify(bounds), bounds);
    }
  }
  return {
    ...left, promptTokensAtLeast: null, promptTokensBelow: null,
    intervals: [...intervals.values()].sort((a, b) => a.promptTokensAtLeast - b.promptTokensAtLeast
      || (a.promptTokensBelow ?? Infinity) - (b.promptTokensBelow ?? Infinity))
  };
}

export function billingTierFromKey(key) {
  try {
    const [actualModelId, kind, promptTokensAtLeast, promptTokensBelow, id] = JSON.parse(key);
    if (typeof actualModelId !== "string" || !["tier", "flat", "unknown"].includes(kind)) return null;
    if (id !== undefined && (typeof id !== "string" || !id.trim())) return null;
    return { actualModelId, tier: { kind, promptTokensAtLeast, promptTokensBelow, ...(id ? { id: id.trim() } : {}) } };
  } catch {
    return null;
  }
}

const USAGE_FIELDS = ["promptTokens", "completionTokens", "totalTokens", "cachedTokens",
  "textUnknownCostRequests", "estimatedCostAmount", "modelRouterCostAmount", "actualModelCostAmount"];
const WRITE_FIELDS = ["requests", "observedRequests", "pricedRequests", "partialCostRequests",
  "unreportedRequests", "observedTokens", "knownCostAmount"];

function residualUsage(parent, rows) {
  const residual = { requests: null };
  let hasResidual = false;
  for (const field of USAGE_FIELDS) {
    const amount = Math.max(0, (parent[field] || 0) - rows.reduce((sum, row) => sum + (row[field] || 0), 0));
    residual[field] = amount;
    if (amount > 1e-12) hasResidual = true;
  }
  const write = {};
  for (const field of WRITE_FIELDS) {
    const value = parent.cacheWrite?.[field];
    write[field] = value == null ? null : Math.max(0, value - rows.reduce((sum, row) => sum + (row.cacheWrite?.[field] || 0), 0));
    if (write[field] > 1e-12) hasResidual = true;
  }
  // NULL is historical missing evidence, not observed zero cache creation.
  if (parent.cacheWrite?.unreportedRequests === null && !rows.some(row => row.cacheWrite?.unreportedRequests === null)) hasResidual = true;
  residual.cacheWrite = summarizeCacheWrite(write);
  for (const field of ["estimatedCostCurrency", "modelRouterCostCurrency", "actualModelCostCurrency"]) {
    residual[field] = parent[field] || "USD";
  }
  return hasResidual ? residual : null;
}

export function reconcileBillingTiers(modelId, model) {
  model.billingTiers ||= [];
  for (const [actualModelId, actual] of Object.entries(model.actualModels || {})) {
    const residual = residualUsage(actual, model.billingTiers.filter(row => row.actualModelId === actualModelId));
    if (residual) model.billingTiers.push({ ...billingTierIdentity(modelId, actualModelId), ...residual });
  }
  const residual = residualUsage(model, model.billingTiers);
  if (residual) model.billingTiers.push({ ...billingTierIdentity(modelId), ...residual });
  const rows = new Map();
  for (const row of model.billingTiers) {
    const key = billingTierGroupKey(row);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, row);
      continue;
    }
    existing.tier = mergeBillingTierIntervals(existing.tier, row.tier);
    existing.requests = existing.requests === null || row.requests === null ? null : existing.requests + row.requests;
    for (const field of USAGE_FIELDS) existing[field] += row[field] || 0;
    const write = {};
    for (const field of WRITE_FIELDS) {
      const left = existing.cacheWrite?.[field];
      const right = row.cacheWrite?.[field];
      write[field] = field === "unreportedRequests" && (left === null || right === null)
        || left == null && right == null ? null : (left || 0) + (right || 0);
    }
    existing.cacheWrite = summarizeCacheWrite(write);
  }
  model.billingTiers = [...rows.values()];
}
