import { getUsageTotals } from "./usage.js";

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

function normalizeActualModelName(model) {
  const normalized = String(model || "").trim();
  if (!normalized) return "";
  return normalized.replace(/-(20\d{2}-\d{2}-\d{2})$/, "");
}

function getModelStats(model) {
  if (!stats.perModel[model]) {
    stats.perModel[model] = {
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
      actualModels: {}
    };
  }
  return stats.perModel[model];
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
  getModelStats(model).requests += 1;
  getKeyStats(resolveKeyId(context)).requests += 1;
}

export function recordError(model, context = {}) {
  stats.totals.errors += 1;
  const modelStats = getModelStats(model);
  modelStats.errors += 1;
  const actualModelStats = getActualModelStats(modelStats, context?.actualModelName);
  if (actualModelStats) {
    actualModelStats.errors += 1;
  }
  getKeyStats(resolveKeyId(context)).errors += 1;
}

export function recordMediaUsage(model, usage, context = {}) {
  for (const bucket of [stats.totals, getModelStats(model), getKeyStats(resolveKeyId(context))]) {
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
  stats.totals.promptTokens += prompt;
  stats.totals.completionTokens += completion;
  stats.totals.totalTokens += total;
  stats.totals.cachedTokens += cached;
  const modelStats = getModelStats(model);
  modelStats.promptTokens += prompt;
  modelStats.completionTokens += completion;
  modelStats.totalTokens += total;
  modelStats.cachedTokens += cached;

  const actualModelStats = getActualModelStats(modelStats, context?.actualModelName);
  if (actualModelStats) {
    actualModelStats.requests += 1;
    actualModelStats.promptTokens += prompt;
    actualModelStats.completionTokens += completion;
    actualModelStats.totalTokens += total;
    actualModelStats.cachedTokens += cached;
  }

  const keyStats = getKeyStats(resolveKeyId(context));
  keyStats.promptTokens += prompt;
  keyStats.completionTokens += completion;
  keyStats.totalTokens += total;
  keyStats.cachedTokens += cached;

  if (context.cost?.pricing || context.cost?.cacheWrite) {
    const cacheWrite = normalizeCacheWrite(context.cost.cacheWrite);
    for (const bucket of [stats.totals, modelStats, keyStats, actualModelStats]) {
      if (bucket) addCacheWrite(bucket, cacheWrite);
    }
  }

  if (context.cost?.pricing && context.cost.costStatus && context.cost.costStatus !== "priced") {
    for (const bucket of [stats.totals, modelStats, keyStats, actualModelStats]) {
      if (bucket) bucket.textUnknownCostRequests += 1;
    }
  }

  if (Number.isFinite(context?.cost?.amount) && context.cost.amount > 0) {
    stats.totals.estimatedCostAmount += context.cost.amount;
    stats.totals.estimatedCostCurrency = context.cost.currency || stats.totals.estimatedCostCurrency || "USD";
    modelStats.estimatedCostAmount += context.cost.amount;
    modelStats.estimatedCostCurrency = context.cost.currency || modelStats.estimatedCostCurrency || "USD";
    if (actualModelStats) {
      actualModelStats.estimatedCostAmount += context.cost.amount;
      actualModelStats.estimatedCostCurrency = context.cost.currency || actualModelStats.estimatedCostCurrency || "USD";
    }
    keyStats.estimatedCostAmount += context.cost.amount;
    keyStats.estimatedCostCurrency = context.cost.currency || keyStats.estimatedCostCurrency || "USD";
  }

  if (Number.isFinite(context?.cost?.modelRouterCostAmount) && context.cost.modelRouterCostAmount > 0) {
    stats.totals.modelRouterCostAmount += context.cost.modelRouterCostAmount;
    stats.totals.modelRouterCostCurrency = context.cost.modelRouterCostCurrency || stats.totals.modelRouterCostCurrency || "USD";
    modelStats.modelRouterCostAmount += context.cost.modelRouterCostAmount;
    modelStats.modelRouterCostCurrency = context.cost.modelRouterCostCurrency || modelStats.modelRouterCostCurrency || "USD";
    if (actualModelStats) {
      actualModelStats.modelRouterCostAmount += context.cost.modelRouterCostAmount;
      actualModelStats.modelRouterCostCurrency = context.cost.modelRouterCostCurrency || actualModelStats.modelRouterCostCurrency || "USD";
    }
    keyStats.modelRouterCostAmount += context.cost.modelRouterCostAmount;
    keyStats.modelRouterCostCurrency = context.cost.modelRouterCostCurrency || keyStats.modelRouterCostCurrency || "USD";
  }

  if (Number.isFinite(context?.cost?.actualModelCostAmount) && context.cost.actualModelCostAmount > 0) {
    stats.totals.actualModelCostAmount += context.cost.actualModelCostAmount;
    stats.totals.actualModelCostCurrency = context.cost.actualModelCostCurrency || stats.totals.actualModelCostCurrency || "USD";
    modelStats.actualModelCostAmount += context.cost.actualModelCostAmount;
    modelStats.actualModelCostCurrency = context.cost.actualModelCostCurrency || modelStats.actualModelCostCurrency || "USD";
    if (actualModelStats) {
      actualModelStats.actualModelCostAmount += context.cost.actualModelCostAmount;
      actualModelStats.actualModelCostCurrency = context.cost.actualModelCostCurrency || actualModelStats.actualModelCostCurrency || "USD";
    }
    keyStats.actualModelCostAmount += context.cost.actualModelCostAmount;
    keyStats.actualModelCostCurrency = context.cost.actualModelCostCurrency || keyStats.actualModelCostCurrency || "USD";
  }
}

export function getStats() {
  return stats;
}
