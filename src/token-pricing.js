import { getCacheWriteUsage } from "./usage.js";

const RATE_NAMES = [
  ["input", "prompt"],
  ["output", "completion"],
  ["cachedInput", "cachedPrompt"],
  ["cacheWrite"],
  ["cacheWrite5m"],
  ["cacheWrite1h"]
];
const PROTOCOLS = new Set(["messages", "responses", "chat/completions"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalid(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function numeric(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function compileRates(entry, path) {
  const rates = {};
  for (const names of RATE_NAMES) {
    const canonical = `${names[0]}Per1mTokens`;
    let selected;
    for (const [unit, multiplier] of [["1m", 1], ["1k", 1000]]) {
      for (const name of names) {
        const key = `${name}Per${unit}Tokens`;
        if (!Object.hasOwn(entry, key)) continue;
        const value = numeric(entry[key]);
        const normalized = value * multiplier;
        if (!Number.isFinite(normalized) || value < 0) {
          invalid(`${path}.${key}`, "rate must be a finite nonnegative number");
        }
        if (selected !== undefined && (
          (selected === 0 || normalized === 0) ? selected !== normalized
            : Math.abs(selected - normalized) > 1e-9 * Math.max(selected, normalized)
        )) {
          invalid(`${path}.${key}`, `rate conflicts with ${canonical} or its aliases/units`);
        }
        selected ??= normalized;
      }
    }
    if (selected !== undefined) rates[canonical] = selected === 0 ? 0 : selected;
  }
  return rates;
}

function bound(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(path, "tier bound must be a nonnegative safe integer");
  }
  return value;
}

export function compilePricingPolicy(entry, path = "pricing") {
  if (entry == null) return null;
  if (!isObject(entry)) invalid(path, "token pricing must be an object");
  if (Object.hasOwn(entry, "billingUnit") && entry.billingUnit !== "1M tokens" && entry.billingUnit !== "1K tokens") {
    return null;
  }
  const rates = compileRates(entry, path);
  const hasTiers = Object.hasOwn(entry, "tiers") || Object.hasOwn(entry, "tiering");
  if (!hasTiers && !Object.keys(rates).length) return null;
  const policy = { currency: "USD", billingUnit: "1M tokens", rates, tiering: null, tiers: [] };
  if (!hasTiers) return freeze(policy);
  if (!isObject(entry.tiering)
    || entry.tiering.basis !== "inputTokensIncludingCache"
    || entry.tiering.method !== "whole-request") {
    invalid(`${path}.tiering`, "executable tiers require basis inputTokensIncludingCache and method whole-request");
  }
  if (!Array.isArray(entry.tiers) || !entry.tiers.length) {
    invalid(`${path}.tiers`, "must be a nonempty array");
  }
  policy.tiering = { basis: "inputTokensIncludingCache", method: "whole-request" };
  let nextLower = 0;
  const ids = new Set();
  for (const [index, row] of entry.tiers.entries()) {
    const rowPath = `${path}.tiers[${index}]`;
    if (!isObject(row)) invalid(rowPath, "tier must be an object");
    const lower = Object.hasOwn(row, "promptTokensAtLeast")
      ? bound(row.promptTokensAtLeast, `${rowPath}.promptTokensAtLeast`)
      : index === 0 ? 0 : invalid(`${rowPath}.promptTokensAtLeast`, "lower bound is required after the first tier");
    const upper = Object.hasOwn(row, "promptTokensBelow")
      ? bound(row.promptTokensBelow, `${rowPath}.promptTokensBelow`)
      : null;
    if (lower !== nextLower) invalid(rowPath, "tiers must be sorted, contiguous and nonoverlapping, starting at zero");
    if (upper !== null && upper <= lower) invalid(rowPath, "tier interval must be nonempty [lower, upper)");
    if ((index === entry.tiers.length - 1) !== (upper === null)) {
      invalid(`${rowPath}.promptTokensBelow`, "only the final tier must be unbounded");
    }
    const id = Object.hasOwn(row, "id") ? row.id : `tier-${index + 1}`;
    if (typeof id !== "string" || !id.trim() || ids.has(id.trim())) {
      invalid(`${rowPath}.id`, "tier id must be a unique nonempty string");
    }
    ids.add(id.trim());
    const tierRates = compileRates(row, rowPath);
    if (!Object.keys(tierRates).length) invalid(rowPath, "tier must define its own token rates; root rates are not inherited");
    policy.tiers.push({
      id: id.trim(),
      promptTokensAtLeast: lower,
      promptTokensBelow: upper,
      rates: tierRates
    });
    nextLower = upper;
  }
  return freeze(policy);
}

function readCounter(usage, path) {
  const name = path.join(".");
  let value = usage;
  for (const key of path) {
    if (!isObject(value)) return { present: true, value: null, reason: `invalid ${name} usage` };
    if (!Object.hasOwn(value, key)) return { present: false, value: null, reason: `missing ${name} usage` };
    value = value[key];
  }
  const number = numeric(value);
  return Number.isSafeInteger(number) && number >= 0
    ? { present: true, value: number === 0 ? 0 : number, reason: "" }
    : { present: true, value: null, reason: `invalid ${name} usage: expected a nonnegative integer` };
}

function selectCounter(usage, paths, optional = false) {
  for (const path of paths) {
    const counter = readCounter(usage, path);
    if (counter.present) return counter;
  }
  return optional
    ? { present: false, value: 0, reason: "" }
    : { present: false, value: null, reason: `missing ${paths[0].join(".")} usage` };
}

function sumCounters(...values) {
  if (values.some(value => value === null)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function normalizeUsage(usage, writeUsage) {
  const counters = {
    inputTokens: null,
    outputTokens: null,
    uncachedInputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null
  };
  const errors = {};
  if (!isObject(usage)) return { counters, errors, unavailable: "token usage unavailable" };
  const protocol = writeUsage.protocol;
  if (!PROTOCOLS.has(protocol)) return { counters, errors, unavailable: `unsupported usage protocol ${protocol}` };
  const normalizedInput = Object.hasOwn(usage, "prompt_tokens");
  const input = selectCounter(usage, [["prompt_tokens"], ["input_tokens"]]);
  const output = selectCounter(usage, [["completion_tokens"], ["output_tokens"]]);
  const cachedPaths = [
    ["prompt_tokens_details", "cached_tokens"],
    ["input_tokens_details", "cached_tokens"],
    ["cached_tokens"]
  ];
  if (protocol === "messages") {
    if (normalizedInput) cachedPaths.push(["cache_read_input_tokens"]);
    else cachedPaths.unshift(["cache_read_input_tokens"]);
  }
  const cached = selectCounter(usage, cachedPaths, true);
  counters.outputTokens = output.value;
  counters.cachedInputTokens = cached.value;
  errors.outputTokens = output.reason;
  errors.cachedInputTokens = cached.reason;

  let writes = { value: writeUsage.provided ? writeUsage.tokens : 0, reason: writeUsage.provided ? writeUsage.reason : "" };
  const writeTtlProvided = protocol === "messages" && Object.hasOwn(usage, "cache_creation");
  if (protocol === "messages") {
    const five = readCounter(usage, ["cache_creation", "ephemeral_5m_input_tokens"]);
    const hour = readCounter(usage, ["cache_creation", "ephemeral_1h_input_tokens"]);
    const ttlTotal = sumCounters(five.value, hour.value);
    if (writeTtlProvided) {
      counters.cacheWrite5mTokens = five.value;
      counters.cacheWrite1hTokens = hour.value;
      if (ttlTotal === null) {
        errors.cacheWriteTtl = five.reason || hour.reason || "cache_creation TTL usage exceeds safe integer range";
      } else if (writes.value !== null && writes.value !== ttlTotal) {
        writes = { value: null, reason: "cache_creation_input_tokens does not equal the 5m and 1h cache write total" };
        errors.cacheWriteTtl = writes.reason;
      }
    } else if (writes.value !== 0) {
      errors.cacheWriteTtl = "cache write TTL breakdown is missing";
    }
  }
  counters.cacheWriteTokens = writes.value;
  errors.cacheWriteTokens = writes.reason;
  if (writes.value === 0 && !errors.cacheWriteTtl) {
    counters.cacheWrite5mTokens = 0;
    counters.cacheWrite1hTokens = 0;
  }

  if (protocol === "messages" && !normalizedInput) {
    // Native Messages input excludes both cache classes; normalized prompt_tokens does not.
    counters.uncachedInputTokens = input.value;
    counters.inputTokens = sumCounters(input.value, cached.value, writes.value);
    errors.uncachedInputTokens = input.reason;
    errors.inputTokens = input.reason || cached.reason || writes.reason
      || (counters.inputTokens === null ? "input token total exceeds safe integer range" : "");
  } else {
    counters.inputTokens = input.value;
    const cacheTotal = sumCounters(cached.value, writes.value);
    // Cache writes are a separate input category, not an additive charge on ordinary input.
    if (input.value !== null && cacheTotal !== null && cacheTotal <= input.value) {
      counters.uncachedInputTokens = input.value - cacheTotal;
    }
    errors.inputTokens = input.reason;
    errors.uncachedInputTokens = input.reason || cached.reason || writes.reason
      || (cacheTotal === null ? "cache token total is unavailable" : "");
    if (input.value !== null && cached.value !== null && writes.value !== null
      && (cached.value > input.value || writes.value > input.value || cached.value > input.value - writes.value)) {
      const reason = "cached read and cache write tokens exceed total input tokens";
      counters.cachedInputTokens = null;
      counters.cacheWriteTokens = null;
      counters.cacheWrite5mTokens = null;
      counters.cacheWrite1hTokens = null;
      errors.cachedInputTokens = reason;
      errors.cacheWriteTokens = reason;
      errors.cacheWriteTtl = reason;
      errors.uncachedInputTokens = reason;
      errors.bounds = reason;
    }
  }
  return { counters, errors, unavailable: "", writeTtlProvided };
}

function priceComponent(tokens, rates, rateName, reason) {
  if (tokens === null) return { amount: 0, complete: false, known: false, reason: reason || `missing ${rateName} token usage` };
  if (tokens === 0) return { amount: 0, complete: true, known: false, reason: "" };
  if (rates[rateName] === undefined) {
    return { amount: 0, complete: false, known: false, reason: `missing ${rateName} rate` };
  }
  const amount = (tokens / 1e6) * rates[rateName];
  if (!Number.isFinite(amount)) return { amount: 0, complete: false, known: false, reason: `${rateName} cost exceeds finite range` };
  return { amount, complete: true, known: true, reason: "" };
}

function summarizeCacheWrite(reported, components = [], estimated = false, invalidZero = false) {
  const result = {
    tokens: reported.tokens,
    usageStatus: reported.usageStatus,
    knownCostAmount: 0,
    estimatedCostAmount: null,
    costStatus: "unknown"
  };
  if (reported.tokens === null) return result;
  if (reported.tokens === 0 && !invalidZero) return { ...result, estimatedCostAmount: 0, costStatus: "priced" };
  if (!components.length) return result;
  result.knownCostAmount = components.reduce((amount, component) => amount + component.amount, 0);
  if (components.every(component => component.complete) && !estimated) {
    result.costStatus = "priced";
    result.estimatedCostAmount = result.knownCostAmount;
  } else if (components.some(component => component.known)) {
    result.costStatus = "partial";
  }
  return result;
}

function unknown(counters, reason, cacheWrite) {
  return { amount: 0, estimatedCostAmount: null, costStatus: "unknown", reason, tier: null, counters, cacheWrite };
}

function expectsCacheWriteUsage(rates) {
  return rates.cacheWritePer1mTokens !== undefined
    || rates.cacheWrite5mPer1mTokens !== undefined
    || rates.cacheWrite1hPer1mTokens !== undefined;
}

function markMissingCacheWrites(counters, errors, reportedWrites, usage) {
  const reason = "cache write usage is missing; cache-write pricing requires a reported count";
  counters.cacheWriteTokens = null;
  counters.cacheWrite5mTokens = null;
  counters.cacheWrite1hTokens = null;
  counters.uncachedInputTokens = null;
  errors.cacheWriteTokens = reason;
  errors.uncachedInputTokens = reason;
  if (reportedWrites.protocol === "messages" && !Object.hasOwn(usage, "prompt_tokens")) {
    counters.inputTokens = null;
    errors.inputTokens ||= reason;
  }
}

export function calculateTokenCost(policy, usage, options = {}) {
  const reportedWrites = getCacheWriteUsage(usage, options.backendProtocol);
  const { counters, errors, unavailable, writeTtlProvided } = normalizeUsage(usage, reportedWrites);
  const invalidWriteZero = !!(errors.cacheWriteTokens || errors.cacheWriteTtl);
  const unpricedWrites = summarizeCacheWrite(reportedWrites, [], options.estimated, invalidWriteZero);
  if (!policy) return unknown(counters, "token pricing unavailable", unpricedWrites);
  if (unavailable) return unknown(counters, unavailable, unpricedWrites);
  let tier = null;
  if (policy.tiering) {
    if (options.estimated) return unknown(counters, "estimated usage cannot select a precise context pricing tier", unpricedWrites);
    if (!options.inputOnly && !reportedWrites.provided && reportedWrites.protocol === "messages"
      && !Object.hasOwn(usage, "prompt_tokens") && policy.tiers.some(row => expectsCacheWriteUsage(row.rates))) {
      markMissingCacheWrites(counters, errors, reportedWrites, usage);
    }
    if (counters.inputTokens === null) return unknown(counters, errors.inputTokens || "input usage required to select a context pricing tier", unpricedWrites);
    tier = policy.tiers.find(row => counters.inputTokens >= row.promptTokensAtLeast
      && (row.promptTokensBelow === null || counters.inputTokens < row.promptTokensBelow));
    if (!tier) return unknown(counters, "no pricing tier matches input usage", unpricedWrites);
  }
  const rates = tier ? tier.rates : policy.rates;
  if (!options.inputOnly && !reportedWrites.provided && expectsCacheWriteUsage(rates)) {
    markMissingCacheWrites(counters, errors, reportedWrites, usage);
  }
  const inputs = [];
  const writeComponents = [];
  if (options.inputOnly) {
    inputs.push(priceComponent(errors.bounds ? null : counters.inputTokens, rates, "inputPer1mTokens", errors.bounds || errors.inputTokens));
  } else {
    inputs.push(
      priceComponent(counters.uncachedInputTokens, rates, "inputPer1mTokens", errors.uncachedInputTokens),
      priceComponent(counters.cachedInputTokens, rates, "cachedInputPer1mTokens", errors.cachedInputTokens)
    );
    const ttlRates = rates.cacheWrite5mPer1mTokens !== undefined || rates.cacheWrite1hPer1mTokens !== undefined;
    if (!writeTtlProvided && rates.cacheWritePer1mTokens !== undefined) {
      writeComponents.push(priceComponent(counters.cacheWriteTokens, rates, "cacheWritePer1mTokens", errors.cacheWriteTokens));
    } else if (errors.cacheWriteTtl && ((ttlRates && counters.cacheWriteTokens !== 0) || writeTtlProvided)) {
      writeComponents.push(priceComponent(null, rates, "cacheWritePer1mTokens", errors.cacheWriteTtl));
    } else if (ttlRates && counters.cacheWriteTokens !== 0) {
      writeComponents.push(
        priceComponent(counters.cacheWrite5mTokens, rates, "cacheWrite5mPer1mTokens", errors.cacheWriteTokens),
        priceComponent(counters.cacheWrite1hTokens, rates, "cacheWrite1hPer1mTokens", errors.cacheWriteTokens)
      );
    } else {
      writeComponents.push(priceComponent(counters.cacheWriteTokens, rates, "cacheWritePer1mTokens", errors.cacheWriteTokens));
    }
    inputs.push(...writeComponents);
  }
  const output = options.inputOnly ? [] : [
    priceComponent(counters.outputTokens, rates, "outputPer1mTokens", errors.outputTokens)
  ];
  const components = [...inputs, ...output];
  let amount = 0;
  const reasons = new Set();
  for (const component of components) {
    if (Number.isFinite(amount + component.amount)) amount += component.amount;
    else {
      component.amount = 0;
      component.complete = false;
      component.known = false;
      reasons.add("combined token cost exceeds finite range");
    }
    if (component.reason) reasons.add(component.reason);
  }
  const complete = counters.inputTokens !== null && components.every(component => component.complete);
  const known = components.some(component => component.known)
    || inputs.every(component => component.complete)
    || (output.length > 0 && output.every(component => component.complete));
  if (counters.inputTokens === null) reasons.add(errors.inputTokens || "input token total is unavailable");
  if (options.estimated) reasons.add("token usage is estimated");
  const costStatus = complete && !options.estimated ? "priced" : known ? "partial" : "unknown";
  return {
    amount,
    estimatedCostAmount: costStatus === "priced" ? amount : null,
    costStatus,
    reason: [...reasons].join("; "),
    tier,
    counters,
    cacheWrite: summarizeCacheWrite(reportedWrites, writeComponents, options.estimated, invalidWriteZero)
  };
}
