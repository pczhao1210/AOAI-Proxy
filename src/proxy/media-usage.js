const TOKEN_FIELDS = Object.freeze({
  inputTokens: ["input_tokens", "prompt_tokens"],
  outputTokens: ["output_tokens", "completion_tokens"],
  totalTokens: ["total_tokens"]
});

export function normalizeMediaUsage(raw) {
  const counters = {};
  const add = (name, value, integer = true) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))) counters[name] = value;
  };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [name, fields] of Object.entries(TOKEN_FIELDS)) {
      const field = fields.find(candidate => Object.hasOwn(raw, candidate));
      if (field) add(name, raw[field]);
    }
    const input = raw.input_token_details ?? raw.input_tokens_details ?? raw.prompt_tokens_details;
    const output = raw.output_token_details ?? raw.output_tokens_details ?? raw.completion_tokens_details;
    add("cachedTokens", input?.cached_tokens);
    for (const [name, details] of [["input", input], ["output", output]]) {
      for (const modality of ["audio", "text", "image"]) {
        const title = modality[0].toUpperCase() + modality.slice(1);
        add(`${name}${title}Tokens`, details?.[`${modality}_tokens`]);
      }
    }
    for (const modality of ["audio", "text", "image"]) {
      const title = modality[0].toUpperCase() + modality.slice(1);
      add(`cached${title}Tokens`, input?.cached_tokens_details?.[`${modality}_tokens`]);
    }
    if (raw.type === "duration") add("durationSeconds", raw.seconds, false);
    add("inputCharacters", raw.input_characters);
  }
  return { raw, counters, usageStatus: Object.keys(counters).length ? "observed" : "unknown", costStatus: "unknown", estimatedCostAmount: null };
}

export function estimateMediaCost(usage, pricing) {
  const unknown = { costStatus: "unknown", estimatedCostAmount: null, currency: "USD" };
  if (usage?.usageStatus !== "observed" || !pricing || pricing.status === "unavailable") return unknown;
  const counters = usage.counters;
  const valid = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  let amount = 0;
  const components = [];
  const charge = (counter, quantity, rate, scale) => {
    if (!valid(quantity) || (quantity > 0 && !valid(rate))) return false;
    const cost = quantity === 0 ? 0 : quantity * rate / scale;
    if (!Number.isFinite(cost)) return false;
    amount += cost;
    components.push({ counter, quantity, rate: valid(rate) ? rate : null, scale, amount: cost });
    return true;
  };
  if (pricing.billingUnit === "minute" || pricing.billingUnit === "second") {
    const perMinute = pricing.perMinute ?? pricing.realtimeAudioDurationPerMinute;
    const perSecond = pricing.perSecond ?? pricing.realtimeAudioDurationPerSecond;
    const byMinute = pricing.billingUnit === "minute" && valid(perMinute);
    if (!charge("durationSeconds", counters.durationSeconds, byMinute ? perMinute : perSecond, byMinute ? 60 : 1)) return unknown;
  } else if (pricing.billingUnit === "1M characters") {
    if (!charge("inputCharacters", counters.inputCharacters, pricing.per1mCharacters, 1000000)) return unknown;
  } else if (pricing.billingUnit === "1M tokens" || pricing.billingUnit === "1K tokens") {
    let cachedTotal = 0;
    for (const direction of ["input", "output"]) {
      const total = counters[`${direction}Tokens`];
      if (!Number.isSafeInteger(total) || total < 0) return unknown;
      let channelTotal = 0;
      for (const channel of ["text", "audio", "image"]) {
        const title = channel[0].toUpperCase() + channel.slice(1);
        const counter = `${direction}${title}Tokens`;
        const rates = channel === "text" ? pricing : pricing.channels?.[channel];
        const quantity = counters[counter] ?? 0;
        if (!Number.isSafeInteger(quantity) || quantity < 0) return unknown;
        channelTotal += quantity;
        const cached = direction === "input" ? counters[`cached${title}Tokens`] ?? (counters.cachedTokens === 0 || quantity === 0 ? 0 : undefined) : 0;
        if (!Number.isSafeInteger(cached) || cached < 0 || cached > quantity) return unknown;
        const rate = name => valid(rates?.[`${name}Per1mTokens`]) ? rates[`${name}Per1mTokens`] / 1000000
          : valid(rates?.[`${name}Per1kTokens`]) ? rates[`${name}Per1kTokens`] / 1000 : undefined;
        if (!charge(counter, quantity - cached, rate(direction), 1)) return unknown;
        if (direction === "input") {
          cachedTotal += cached;
          if (!charge(`cached${title}Tokens`, cached, rate("cachedInput"), 1)) return unknown;
        }
      }
      if (channelTotal !== total) return unknown;
    }
    if (!Number.isSafeInteger(counters.cachedTokens) || cachedTotal !== counters.cachedTokens) return unknown;
    if (Object.hasOwn(counters, "totalTokens") && counters.totalTokens !== counters.inputTokens + counters.outputTokens) return unknown;
  } else return unknown;
  if (!Number.isFinite(amount)) return unknown;
  return { costStatus: "priced", estimatedCostAmount: amount, currency: "USD", components };
}

export function createMediaUsageTracker({ maxItems = 1024, pricing = null } = {}) {
  const seen = new Map();
  const totals = {};
  const defaultPricing = structuredClone(pricing);
  return {
    observe(identity, usage, { cumulative = false, pricing: eventPricing = defaultPricing } = {}) {
      const normalized = normalizeMediaUsage(usage);
      if (typeof identity !== "string" || identity.length > 512) throw Object.assign(new Error("Media usage identity exceeded its limit"), { code: "MEDIA_USAGE_CAPACITY" });
      const entry = seen.get(identity);
      const previous = entry?.counters;
      if (previous && Object.keys(previous).length && !cumulative) return null;
      if (!entry && seen.size >= maxItems) throw Object.assign(new Error("Media usage event capacity exceeded"), { code: "MEDIA_USAGE_CAPACITY" });
      const counters = {};
      const snapshot = { ...previous };
      for (const [name, value] of Object.entries(normalized.counters)) {
        if (previous && Object.hasOwn(previous, name) && value <= previous[name]) continue;
        counters[name] = value - (previous?.[name] ?? 0);
        snapshot[name] = value;
        totals[name] = (totals[name] ?? 0) + counters[name];
      }
      seen.set(identity, { counters: snapshot, pricing: entry ? entry.pricing : structuredClone(eventPricing) });
      if (!Object.keys(counters).length) return null;
      return { ...normalized, counters };
    },
    snapshot() {
      const knownCostAmounts = {};
      const pricingSources = new Set();
      let unknownCostItems = 0;
      let unknownUsageItems = 0;
      for (const entry of seen.values()) {
        if (entry.pricing?.source) pricingSources.add(entry.pricing.source);
        const usageStatus = Object.keys(entry.counters).length ? "observed" : "unknown";
        if (usageStatus === "unknown") unknownUsageItems += 1;
        const cost = estimateMediaCost({ counters: entry.counters, usageStatus }, entry.pricing);
        if (cost.costStatus !== "priced") unknownCostItems += 1;
        else knownCostAmounts[cost.currency] = (knownCostAmounts[cost.currency] ?? 0) + cost.estimatedCostAmount;
      }
      const currencies = Object.keys(knownCostAmounts);
      const priced = seen.size > 0 && unknownCostItems === 0 && currencies.length === 1;
      return { counters: { ...totals }, usageStatus: Object.keys(totals).length ? unknownUsageItems ? "partial" : "observed" : "unknown",
        costStatus: priced ? "priced" : currencies.length ? "partial" : "unknown",
        estimatedCostAmount: priced ? knownCostAmounts[currencies[0]] : null, currency: priced ? currencies[0] : null,
        knownCostAmounts, unknownCostItems, unknownUsageItems, pricingSources: [...pricingSources] };
    }
  };
}