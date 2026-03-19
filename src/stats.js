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

export function recordUsage(model, usage, context = {}) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || usage.input_tokens || 0;
  const completion = usage.completion_tokens || usage.output_tokens || 0;
  const total = usage.total_tokens || usage.total || prompt + completion;
  const cached = usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cached_tokens
    ?? 0;
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
