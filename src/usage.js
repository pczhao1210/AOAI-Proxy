function toNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

export function getUsageTotals(usage) {
  const promptBase = toNonNegativeInteger(usage?.prompt_tokens ?? usage?.input_tokens, 0);
  const cacheReadTokens = toNonNegativeInteger(usage?.cache_read_input_tokens, 0);
  const cacheCreationTokens = toNonNegativeInteger(usage?.cache_creation_input_tokens, 0);
  const promptTokens = usage?.prompt_tokens == null && usage?.input_tokens != null
    ? promptBase + cacheReadTokens + cacheCreationTokens
    : promptBase;
  const completionTokens = toNonNegativeInteger(usage?.completion_tokens ?? usage?.output_tokens, 0);
  const totalTokens = toNonNegativeInteger(usage?.total_tokens ?? usage?.total, promptTokens + completionTokens);
  const cachedTokens = toNonNegativeInteger(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.input_tokens_details?.cached_tokens
      ?? usage?.cached_tokens
      ?? cacheReadTokens,
    0
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens
  };
}