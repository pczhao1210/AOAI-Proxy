const stats = {
  startedAt: new Date().toISOString(),
  totals: {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  },
  perModel: {}
};

function getModelStats(model) {
  if (!stats.perModel[model]) {
    stats.perModel[model] = {
      requests: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };
  }
  return stats.perModel[model];
}

export function recordRequest(model) {
  stats.totals.requests += 1;
  getModelStats(model).requests += 1;
}

export function recordError(model) {
  stats.totals.errors += 1;
  getModelStats(model).errors += 1;
}

export function recordUsage(model, usage) {
  if (!usage) return;
  const prompt = usage.prompt_tokens || usage.input_tokens || 0;
  const completion = usage.completion_tokens || usage.output_tokens || 0;
  const total = usage.total_tokens || usage.total || prompt + completion;
  stats.totals.promptTokens += prompt;
  stats.totals.completionTokens += completion;
  stats.totals.totalTokens += total;
  const modelStats = getModelStats(model);
  modelStats.promptTokens += prompt;
  modelStats.completionTokens += completion;
  modelStats.totalTokens += total;
}

export function getStats() {
  return stats;
}
