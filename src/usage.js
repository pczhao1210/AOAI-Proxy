function toNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readReportedWriteCounter(usage, path) {
  const name = path.join(".");
  let value = usage;
  for (const key of path) {
    if (!isObject(value)) return { tokens: null, provided: true, reason: `invalid ${name} usage` };
    if (!Object.hasOwn(value, key)) return { tokens: null, provided: false, reason: `missing ${name} usage` };
    value = value[key];
  }
  const numeric = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? { tokens: numeric === 0 ? 0 : numeric, provided: true, reason: "" }
    : { tokens: null, provided: true, reason: `invalid ${name} usage: expected a nonnegative integer` };
}

export function getCacheWriteUsage(usage, backendProtocol = "") {
  const protocol = backendProtocol || (
    isObject(usage) && ["cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation"].some(key => Object.hasOwn(usage, key))
      ? "messages" : isObject(usage) && (Object.hasOwn(usage, "input_tokens") || Object.hasOwn(usage, "input_tokens_details"))
        ? "responses" : "chat/completions"
  );
  let reported = { tokens: null, provided: false, reason: "cache write usage not reported" };
  if (isObject(usage)) {
    if (protocol === "messages") {
      if (Object.hasOwn(usage, "cache_creation_input_tokens")) {
        reported = readReportedWriteCounter(usage, ["cache_creation_input_tokens"]);
      } else if (Object.hasOwn(usage, "cache_creation")) {
        const five = readReportedWriteCounter(usage, ["cache_creation", "ephemeral_5m_input_tokens"]);
        const hour = readReportedWriteCounter(usage, ["cache_creation", "ephemeral_1h_input_tokens"]);
        const total = five.tokens !== null && hour.tokens !== null ? five.tokens + hour.tokens : null;
        reported = {
          tokens: Number.isSafeInteger(total) ? total : null,
          provided: true,
          reason: five.reason || hour.reason || (Number.isSafeInteger(total) ? "" : "cache write TTL total exceeds safe integer range")
        };
      }
    } else if (protocol === "chat/completions" || protocol === "responses") {
      const details = protocol === "responses" ? "input_tokens_details" : "prompt_tokens_details";
      reported = readReportedWriteCounter(usage, [details, "cache_write_tokens"]);
    }
  }
  return { ...reported, usageStatus: reported.tokens === null ? "unknown" : "observed", protocol };
}

export function getUsageTotals(usage) {
  const promptBase = toNonNegativeInteger(usage?.prompt_tokens ?? usage?.input_tokens, 0);
  const cacheReadTokens = toNonNegativeInteger(usage?.cache_read_input_tokens, 0);
  const cacheCreationTokens = isObject(usage) && Object.hasOwn(usage, "cache_creation_input_tokens")
    ? toNonNegativeInteger(usage.cache_creation_input_tokens, 0)
    : getCacheWriteUsage(usage, "messages").tokens ?? 0;
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