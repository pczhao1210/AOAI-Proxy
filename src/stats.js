import { getUsageTotals } from "./usage.js";
import { normalizeCacheWrite, summarizeCacheWrite, billingTierIdentity, billingTierGroupKey, mergeBillingTierIntervals } from "./statistics.js";
export { normalizeCacheWrite, summarizeCacheWrite } from "./statistics.js";

function addCacheWrite(bucket, value) {
  const current = bucket.cacheWrite || summarizeCacheWrite();
  const next = { ...current };
  if (!value) {
    if (next.unreportedRequests !== null) next.unreportedRequests += 1;
  } else {
    next.requests += 1;
    if (value.usageStatus === "observed") {
      next.observedRequests += 1;
      next.observedTokens = (next.observedTokens ?? 0) + value.tokens;
    }
    if (value.costStatus === "priced") next.pricedRequests += 1;
    if (value.costStatus === "partial") next.partialCostRequests += 1;
    next.knownCostAmount = (next.knownCostAmount ?? 0) + value.knownCostAmount;
  }
  bucket.cacheWrite = summarizeCacheWrite(next);
}

const stats = {
  startedAt: new Date().toISOString(),
  totals: {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWrite: summarizeCacheWrite(),
    textUnknownCostRequests: 0,
    modelRouterCostAmount: 0,
    modelRouterCostCurrency: "USD",
    actualModelCostAmount: 0,
    actualModelCostCurrency: "USD",
    estimatedCostAmount: 0,
    estimatedCostCurrency: "USD"
  },
  perModel: {},
  perKey: {}
};
let pendingModelStats = null;

export function beginModelStatsReset(modelsResetAt) {
  const pending = {};
  pendingModelStats = pending;
  return {
    commit() {
      stats.perModel = pending;
      stats.modelsResetAt = modelsResetAt;
      pendingModelStats = null;
    },
    rollback() {
      pendingModelStats = null;
    }
  };
}

function normalizeActualModelName(model) {
  const normalized = String(model || "").trim();
  if (!normalized) return "";
  return normalized.replace(/-(20\d{2}-\d{2}-\d{2})$/, "");
}

function getModelStats(model, models = stats.perModel) {
  if (!models[model]) {
    models[model] = {
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWrite: summarizeCacheWrite(),
      textUnknownCostRequests: 0,
      modelRouterCostAmount: 0,
      modelRouterCostCurrency: "USD",
      actualModelCostAmount: 0,
      actualModelCostCurrency: "USD",
      estimatedCostAmount: 0,
      estimatedCostCurrency: "USD",
      actualModels: {},
      billingTiers: []
    };
  }
  return models[model];
}

function modelBuckets(model) {
  return [getModelStats(model), ...(pendingModelStats ? [getModelStats(model, pendingModelStats)] : [])];
}

function getActualModelStats(modelStats, actualModel) {
  const actualModelId = normalizeActualModelName(actualModel);
  if (!actualModelId) return null;
  if (!modelStats.actualModels[actualModelId]) {
    modelStats.actualModels[actualModelId] = {
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWrite: summarizeCacheWrite(),
      textUnknownCostRequests: 0,
      modelRouterCostAmount: 0,
      modelRouterCostCurrency: "USD",
      actualModelCostAmount: 0,
      actualModelCostCurrency: "USD",
      estimatedCostAmount: 0,
      estimatedCostCurrency: "USD"
    };
  }
  return modelStats.actualModels[actualModelId];
}

function getKeyStats(keyId) {
  if (!stats.perKey[keyId]) {
    stats.perKey[keyId] = {
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWrite: summarizeCacheWrite(),
      textUnknownCostRequests: 0,
      modelRouterCostAmount: 0,
      modelRouterCostCurrency: "USD",
      actualModelCostAmount: 0,
      actualModelCostCurrency: "USD",
      estimatedCostAmount: 0,
      estimatedCostCurrency: "USD"
    };
  }
  return stats.perKey[keyId];
}

function resolveKeyId(context) {
  return String(context?.keyId || "anonymous");
}

export function recordRequest(model, context = {}) {
  stats.totals.requests += 1;
  for (const bucket of modelBuckets(model)) bucket.requests += 1;
  getKeyStats(resolveKeyId(context)).requests += 1;
}

export function recordError(model, context = {}) {
  stats.totals.errors += 1;
  for (const modelStats of modelBuckets(model)) {
    modelStats.errors += 1;
    const actualModelStats = getActualModelStats(modelStats, context?.actualModelName);
    if (actualModelStats) actualModelStats.errors += 1;
  }
  getKeyStats(resolveKeyId(context)).errors += 1;
}

export function recordMediaUsage(model, usage, context = {}) {
  for (const bucket of [stats.totals, ...modelBuckets(model), getKeyStats(resolveKeyId(context))]) {
    bucket.media ||= { requests: 0, observedRequests: 0, unknownUsageRequests: 0, unknownCostRequests: 0,
      counters: {}, estimatedCostAmount: null };
    bucket.media.requests += 1;
    if (usage?.usageStatus === "observed") bucket.media.observedRequests += 1;
    else bucket.media.unknownUsageRequests += 1;
    if (usage?.costStatus !== "priced") bucket.media.unknownCostRequests += 1;
    bucket.media.costAmounts ||= {};
    for (const [currency, amount] of Object.entries(usage?.knownCostAmounts || {})) {
      if (Number.isFinite(amount) && amount >= 0) bucket.media.costAmounts[currency] = (bucket.media.costAmounts[currency] ?? 0) + amount;
    }
    const currencies = Object.keys(bucket.media.costAmounts);
    bucket.media.estimatedCostAmount = bucket.media.unknownCostRequests === 0 && currencies.length === 1 ? bucket.media.costAmounts[currencies[0]] : null;
    bucket.media.currency = currencies.length === 1 ? currencies[0] : null;
    for (const [name, value] of Object.entries(usage?.counters || {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) bucket.media.counters[name] = (bucket.media.counters[name] ?? 0) + value;
    }
  }
}

export function recordUsage(model, usage, context = {}) {
  if (!usage) return;
  const { promptTokens: prompt, completionTokens: completion, totalTokens: total, cachedTokens: cached } = getUsageTotals(usage);
  const buckets = [stats.totals, getKeyStats(resolveKeyId(context))];
  for (const modelStats of modelBuckets(model)) {
    const identity = billingTierIdentity(model, context.actualModelName, context.cost?.pricing?.actual);
    const key = billingTierGroupKey(identity);
    let tier = modelStats.billingTiers.find(row => billingTierGroupKey(row) === key);
    if (!tier) {
      const { actualModels, billingTiers, ...empty } = getModelStats(model, {});
      tier = { ...empty, ...identity };
      modelStats.billingTiers.push(tier);
    } else {
      tier.tier = mergeBillingTierIntervals(tier.tier, identity.tier);
    }
    tier.requests += 1;
    buckets.push(modelStats, tier);
    const actual = getActualModelStats(modelStats, context.actualModelName);
    if (actual) {
      actual.requests += 1;
      buckets.push(actual);
    }
  }
  const cacheWrite = normalizeCacheWrite(context.cost?.cacheWrite);
  for (const bucket of buckets) {
    bucket.promptTokens += prompt;
    bucket.completionTokens += completion;
    bucket.totalTokens += total;
    bucket.cachedTokens += cached;
    if (context.cost?.pricing || context.cost?.cacheWrite) addCacheWrite(bucket, cacheWrite);
    if (context.cost?.pricing && context.cost.costStatus && context.cost.costStatus !== "priced") bucket.textUnknownCostRequests += 1;
    for (const [field, amount, currency] of [
      ["estimatedCost", context.cost?.amount, context.cost?.currency],
      ["modelRouterCost", context.cost?.modelRouterCostAmount, context.cost?.modelRouterCostCurrency],
      ["actualModelCost", context.cost?.actualModelCostAmount, context.cost?.actualModelCostCurrency]
    ]) {
      if (Number.isFinite(amount) && amount > 0) {
        bucket[`${field}Amount`] += amount;
        bucket[`${field}Currency`] = currency || bucket[`${field}Currency`] || "USD";
      }
    }
  }
}

export function getStats() {
  return stats;
}
