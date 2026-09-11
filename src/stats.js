import { getUsageTotals } from "./usage.js";

const stats = {
  startedAt: new Date().toISOString(),
  totals: {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
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
