import assert from "node:assert/strict";
import test from "node:test";
import { calculateTokenCost, compilePricingPolicy } from "../src/token-pricing.js";

const rates = {
  inputPer1mTokens: 2,
  outputPer1mTokens: 10,
  cachedInputPer1mTokens: 0.2,
  cacheWritePer1mTokens: 2.5
};
const tiering = { basis: "inputTokensIncludingCache", method: "whole-request" };
const tieredEntry = {
  currency: "EUR",
  billingUnit: "1M tokens",
  tiering,
  tiers: [
    { id: "short", promptTokensBelow: 200000, ...rates },
    {
      id: "long", promptTokensAtLeast: 200000,
      inputPer1mTokens: 4, outputPer1mTokens: 15,
      cachedInputPer1mTokens: 0.4, cacheWritePer1mTokens: 5
    }
  ]
};
const flat = compilePricingPolicy(rates);
const tiered = compilePricingPolicy(tieredEntry);

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("compiler creates immutable USD policies, independent of mutable source metadata", () => {
  const source = structuredClone(tieredEntry);
  const before = structuredClone(source);
  const policy = compilePricingPolicy(source);
  assert.deepEqual(source, before);
  assert.equal(policy.currency, "USD");
  assert.equal(policy.billingUnit, "1M tokens");
  for (const value of [policy, policy.rates, policy.tiering, policy.tiers, ...policy.tiers, ...policy.tiers.map(tier => tier.rates)]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.equal(policy.tiers[0].promptTokensAtLeast, 0);
  assert.equal(policy.tiers[1].promptTokensBelow, null);
  source.tiers[0].inputPer1mTokens = 999;
  assert.equal(policy.tiers[0].rates.inputPer1mTokens, 2);
  const defaults = compilePricingPolicy({ tiering, tiers: [{ inputPer1mTokens: 1 }] });
  assert.equal(defaults.tiers[0].id, "tier-1");
  assert.equal(defaults.tiers[0].promptTokensAtLeast, 0);
});

test("legacy per-1K aliases and consistent dual units normalize to per-1M", () => {
  const policy = compilePricingPolicy({
    currency: "CNY", billingUnit: "1K tokens",
    promptPer1kTokens: "0.002", inputPer1mTokens: 2,
    completionPer1kTokens: 0.01, cachedPromptPer1kTokens: 0.0002,
    cacheWritePer1kTokens: 0.0025, cacheWrite5mPer1kTokens: 0.003, cacheWrite1hPer1kTokens: 0.004
  });
  assert.deepEqual(policy.rates, { ...rates, cacheWrite5mPer1mTokens: 3, cacheWrite1hPer1mTokens: 4 });
  assert.equal(policy.currency, "USD");
  assert.equal(compilePricingPolicy({ inputPer1kTokens: 0.0003, inputPer1mTokens: 0.1 + 0.2 }).rates.inputPer1mTokens, 0.1 + 0.2);
  const cost = calculateTokenCost(policy, { prompt_tokens: 1000, completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 } });
  close(cost.amount, 0.00682);
  assert.equal(cost.costStatus, "priced");
});

test("absence of token prices and non-token billing units never imply free token pricing", () => {
  for (const entry of [undefined, null, {}, { currency: "USD" }, { channels: { audio: rates } },
    { billingUnit: "image", ...rates }, { billingUnit: "minute", ...rates },
    { billingUnit: "1M characters", ...rates }, { billingUnit: "tokens", ...rates }]) {
    assert.equal(compilePricingPolicy(entry), null);
  }
  const result = calculateTokenCost(null, { prompt_tokens: 1, completion_tokens: 1 });
  assert.equal(result.costStatus, "unknown");
  assert.equal(result.estimatedCostAmount, null);
  assert.equal(result.amount, 0);
  assert.match(result.reason, /pricing/i);
});

test("malformed token rates fail with their configuration path", () => {
  for (const value of [-1, Infinity, NaN, "", "no", null, true, [], {}]) {
    assert.throws(() => compilePricingPolicy({ inputPer1mTokens: value }, "models[0].pricing"), /models\[0\]\.pricing\.inputPer1mTokens/);
  }
  for (const entry of [
    { inputPer1mTokens: 2, inputPer1kTokens: 0.003 },
    { inputPer1mTokens: 2, promptPer1mTokens: 3 },
    { inputPer1mTokens: 0, inputPer1kTokens: 1e-15 },
    { cacheWritePer1mTokens: 2, cacheWritePer1kTokens: 0.003 },
    { cacheWrite1hPer1mTokens: -1 },
    { outputPer1kTokens: Number.MAX_VALUE }
  ]) assert.throws(() => compilePricingPolicy(entry, "custom.pricing"), /custom\.pricing/);
});

test("executable tiers require explicit supported modes and complete ordered intervals", () => {
  const row = { inputPer1mTokens: 1 };
  const malformed = [
    { tiers: [row] },
    { tiering, tiers: [] },
    { tiering },
    { tiering: {}, tiers: [row] },
    { tiering: { ...tiering, basis: "totalTokens" }, tiers: [row] },
    { tiering: { ...tiering, method: "marginal" }, tiers: [row] },
    { tiering, tiers: "bad" },
    { tiering, tiers: [null] },
    { tiering, tiers: [{}], ...rates },
    { tiering, tiers: [{ ...row, promptTokensAtLeast: 1 }] },
    { tiering, tiers: [{ ...row, promptTokensAtLeast: -1 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 0 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 10 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 1.5 }, { ...row, promptTokensAtLeast: 1.5 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: "10" }, { ...row, promptTokensAtLeast: 10 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 10 }, row] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 10 }, { ...row, promptTokensAtLeast: 11 }] },
    { tiering, tiers: [{ ...row, promptTokensBelow: 10 }, { ...row, promptTokensAtLeast: 9 }] },
    { tiering, tiers: [row, { ...row, promptTokensAtLeast: 10 }] },
    { tiering, tiers: [{ ...row, promptTokensAtLeast: 10 }, { ...row, promptTokensBelow: 10 }] },
    { tiering, tiers: [{ ...row, id: "" }] },
    { tiering, tiers: [{ ...row, id: "x", promptTokensBelow: 10 }, { ...row, id: "x", promptTokensAtLeast: 10 }] },
    { tiering, tiers: [{ ...row, cacheWrite5mPer1mTokens: -1 }] }
  ];
  for (const entry of malformed) {
    assert.throws(() => compilePricingPolicy(entry, "catalog.example"), /catalog\.example/, JSON.stringify(entry));
  }
});

test("tier rates never inherit root rates", () => {
  const policy = compilePricingPolicy({ ...rates, tiering, tiers: [{ inputPer1mTokens: 4 }] });
  assert.deepEqual(policy.tiers[0].rates, { inputPer1mTokens: 4 });
  const cost = calculateTokenCost(policy, { prompt_tokens: 100, completion_tokens: 1 });
  assert.equal(cost.costStatus, "partial");
  close(cost.amount, 0.0004);
  assert.equal(cost.estimatedCostAmount, null);
  assert.match(cost.reason, /outputPer1mTokens/);
});

for (const input of [199999, 200000, 200001]) {
  test(`whole-request boundary ${input} selects all input and output rates from one tier`, () => {
    const cost = calculateTokenCost(tiered, {
      input_tokens: input, output_tokens: 1000, input_tokens_details: { cache_write_tokens: 0 }
    }, { backendProtocol: "responses" });
    const long = input >= 200000;
    assert.equal(cost.costStatus, "priced");
    assert.equal(cost.tier.id, long ? "long" : "short");
    assert.equal(cost.tier.promptTokensAtLeast, long ? 200000 : 0);
    assert.equal(cost.tier.promptTokensBelow, long ? null : 200000);
    assert.equal(cost.tier.rates.inputPer1mTokens, long ? 4 : 2);
    close(cost.amount, (input * (long ? 4 : 2) + 1000 * (long ? 15 : 10)) / 1e6);
    assert.equal(cost.estimatedCostAmount, cost.amount);
    assert.ok(Object.isFrozen(cost.tier));
  });
}

test("output tokens never determine the input context tier", () => {
  const cost = calculateTokenCost(tiered, {
    prompt_tokens: 1, completion_tokens: 1000000, prompt_tokens_details: { cache_write_tokens: 0 }
  });
  assert.equal(cost.tier.id, "short");
  close(cost.amount, 10.000002);
});

test("Chat and Responses cached input is already included in total input", () => {
  for (const [backendProtocol, usage] of [
    ["chat/completions", { prompt_tokens: 200000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 190000, cache_write_tokens: 0 } }],
    ["responses", { input_tokens: 200000, output_tokens: 10, input_tokens_details: { cached_tokens: 190000, cache_write_tokens: 0 } }]
  ]) {
    const original = structuredClone(usage);
    const cost = calculateTokenCost(tiered, usage, { backendProtocol });
    assert.equal(cost.costStatus, "priced");
    assert.equal(cost.tier.id, "long");
    assert.equal(cost.counters.inputTokens, 200000);
    assert.equal(cost.counters.uncachedInputTokens, 10000);
    assert.equal(cost.counters.cacheWriteTokens, 0);
    close(cost.amount, (10000 * 4 + 190000 * 0.4 + 10 * 15) / 1e6);
    assert.deepEqual(usage, original);
  }
});

test("Messages cache reads and writes cross the context boundary without double counting", () => {
  const usage = { input_tokens: 10000, cache_read_input_tokens: 189999, cache_creation_input_tokens: 1, output_tokens: 2 };
  const cost = calculateTokenCost(tiered, usage, { backendProtocol: "messages" });
  assert.equal(cost.costStatus, "priced");
  assert.equal(cost.tier.id, "long");
  assert.deepEqual(cost.counters, {
    inputTokens: 200000, outputTokens: 2, uncachedInputTokens: 10000, cachedInputTokens: 189999,
    cacheWriteTokens: 1, cacheWrite5mTokens: null, cacheWrite1hTokens: null
  });
  close(cost.amount, (10000 * 4 + 189999 * 0.4 + 1 * 5 + 2 * 15) / 1e6);
  assert.deepEqual(calculateTokenCost(tiered, usage), cost);
  const normalized = calculateTokenCost(tiered, { ...usage, prompt_tokens: 200000, completion_tokens: 0 }, { backendProtocol: "messages" });
  assert.equal(normalized.counters.inputTokens, 200000);
  assert.equal(normalized.counters.outputTokens, 0);
  close(normalized.amount, cost.amount - 30 / 1e6);
});

test("legacy numeric usage strings and explicit zero counter precedence remain valid", () => {
  const usage = {
    prompt_tokens: "12", input_tokens: "2", completion_tokens: "0", output_tokens: "99",
    cache_read_input_tokens: "7", cache_creation_input_tokens: "3",
    prompt_tokens_details: { cached_tokens: "0" }, input_tokens_details: { cached_tokens: "9" }
  };
  const cost = calculateTokenCost(flat, usage, { backendProtocol: "messages" });
  assert.equal(cost.costStatus, "priced");
  assert.equal(cost.counters.inputTokens, 12);
  assert.equal(cost.counters.outputTokens, 0);
  assert.equal(cost.counters.cachedInputTokens, 0);
  assert.equal(cost.counters.uncachedInputTokens, 9);
  close(cost.amount, (9 * 2 + 3 * 2.5) / 1e6);
});

test("Messages TTL write pricing uses the explicit 5m and 1h breakdown", () => {
  const policy = compilePricingPolicy({ ...rates, cacheWrite5mPer1mTokens: 3, cacheWrite1hPer1mTokens: 4 });
  const usage = {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 12,
    cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 }
  };
  const original = structuredClone(usage);
  const cost = calculateTokenCost(policy, usage, { backendProtocol: "messages" });
  assert.equal(cost.costStatus, "priced");
  assert.equal(cost.counters.inputTokens, 27);
  assert.equal(cost.counters.cacheWrite5mTokens, 7);
  assert.equal(cost.counters.cacheWrite1hTokens, 5);
  close(cost.amount, (10 * 2 + 20 * 10 + 5 * 0.2 + 7 * 3 + 5 * 4) / 1e6);
  const { cache_creation_input_tokens: ignored, ...breakdownOnly } = usage;
  assert.deepEqual(calculateTokenCost(policy, breakdownOnly, { backendProtocol: "messages" }), cost);
  assert.deepEqual(usage, original);
});

test("Messages combined writes price totals without TTL details, but explicit TTL data must be trustworthy", () => {
  const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 12 };
  assert.equal(calculateTokenCost(flat, usage, { backendProtocol: "messages" }).costStatus, "priced");
  const policy = compilePricingPolicy({ ...rates, cacheWrite5mPer1mTokens: 3, cacheWrite1hPer1mTokens: 4 });
  const combined = calculateTokenCost(policy, usage, { backendProtocol: "messages" });
  assert.equal(combined.costStatus, "priced");
  close(combined.cacheWrite.knownCostAmount, 12 * 2.5 / 1e6);
  assert.equal(combined.counters.cacheWrite5mTokens, null);
  assert.equal(combined.counters.cacheWrite1hTokens, null);
  for (const cache_creation of [
    { ephemeral_5m_input_tokens: 12 },
    { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 3 },
    { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 13 }
  ]) {
    const cost = calculateTokenCost(policy, { ...usage, cache_creation }, { backendProtocol: "messages" });
    assert.notEqual(cost.costStatus, "priced");
    assert.equal(cost.estimatedCostAmount, null);
    assert.match(cost.reason, /cache|write|5m|1h/i);
  }
  const noWrites = calculateTokenCost(policy, {
    input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0
  }, { backendProtocol: "messages" });
  assert.equal(noWrites.costStatus, "priced");
});

test("combined write rates coexist with TTL rates across Chat, Responses and Messages without fabricating TTL", () => {
  const sharedRates = {
    inputPer1mTokens: 4, outputPer1mTokens: 15, cachedInputPer1mTokens: 0.4,
    cacheWritePer1mTokens: 5, cacheWrite5mPer1mTokens: 5
  };
  const policy = compilePricingPolicy(sharedRates);
  for (const [backendProtocol, usage] of [
    ["chat/completions", { prompt_tokens: 20, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 8 } }],
    ["responses", { input_tokens: 20, output_tokens: 3,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 8 } }],
    ["messages", { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 8 }]
  ]) {
    const original = structuredClone(usage);
    const combined = calculateTokenCost(policy, usage, { backendProtocol });
    assert.equal(combined.costStatus, "priced");
    close(combined.amount, 0.000097);
    assert.equal(combined.cacheWrite.costStatus, "priced");
    close(combined.cacheWrite.knownCostAmount, 0.00004);
    close(combined.cacheWrite.estimatedCostAmount, 0.00004);
    assert.equal(combined.counters.cacheWrite5mTokens, null);
    assert.equal(combined.counters.cacheWrite1hTokens, null);
    assert.deepEqual(usage, original);

    const { cacheWritePer1mTokens: ignored, ...ttlOnly } = sharedRates;
    const unpriceable = calculateTokenCost(compilePricingPolicy(ttlOnly), usage, { backendProtocol });
    assert.equal(unpriceable.costStatus, "partial");
    assert.equal(unpriceable.cacheWrite.costStatus, "unknown");
    assert.equal(unpriceable.cacheWrite.estimatedCostAmount, null);
    close(unpriceable.amount, 0.000057);
  }
  const messages = {
    input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 8,
    cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 2 }
  };
  const specific = calculateTokenCost(compilePricingPolicy({ ...sharedRates, cacheWrite1hPer1mTokens: 10 }), messages,
    { backendProtocol: "messages" });
  assert.equal(specific.costStatus, "priced");
  close(specific.cacheWrite.knownCostAmount, (6 * 5 + 2 * 10) / 1e6);
  close(specific.amount, 0.000107);
});

test("a missing TTL rate is not silently replaced by a combined rate", () => {
  const policy = compilePricingPolicy({ ...rates, cacheWrite5mPer1mTokens: 3 });
  const cost = calculateTokenCost(policy, {
    input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 12,
    cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 }
  }, { backendProtocol: "messages" });
  assert.equal(cost.costStatus, "partial");
  close(cost.amount, (10 * 2 + 7 * 3) / 1e6);
  assert.match(cost.reason, /cacheWrite1hPer1mTokens/);
});

test("malformed or inconsistent explicit Messages TTL data is never silently ignored by combined rates", () => {
  for (const cache_creation of [
    null,
    [],
    {},
    { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: "bad" },
    { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 3 }
  ]) {
    const cost = calculateTokenCost(flat, {
      input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 12, cache_creation
    }, { backendProtocol: "messages" });
    assert.equal(cost.costStatus, "partial");
    assert.equal(cost.estimatedCostAmount, null);
    close(cost.amount, 30 / 1e6);
  }
});

test("missing write and cached read rates retain other known costs, never normal-input billing", () => {
  const policy = compilePricingPolicy({ inputPer1mTokens: 2, outputPer1mTokens: 10 });
  const cost = calculateTokenCost(policy, {
    input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 12
  }, { backendProtocol: "messages" });
  assert.equal(cost.costStatus, "partial");
  assert.equal(cost.estimatedCostAmount, null);
  close(cost.amount, (10 * 2 + 1 * 10) / 1e6);
  assert.match(cost.reason, /cachedInputPer1mTokens/);
  assert.match(cost.reason, /cacheWritePer1mTokens/);
});

test("invalid cache bounds do not yield clamped or negative costs", () => {
  for (const usage of [
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } },
    { prompt_tokens: 10, completion_tokens: 1, cache_creation_input_tokens: 11 },
    { prompt_tokens: 10, completion_tokens: 1, cache_read_input_tokens: 6, cache_creation_input_tokens: 5 },
    { prompt_tokens: 10, completion_tokens: 1, cache_read_input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 },
    { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 10, completion_tokens: 1, cache_creation_input_tokens: "bad" }
  ]) {
    const cost = calculateTokenCost(flat, usage, { backendProtocol: "messages" });
    assert.equal(cost.costStatus, "partial");
    assert.equal(cost.estimatedCostAmount, null);
    close(cost.amount, 10 / 1e6);
    assert.match(cost.reason, /cache|input/i);
  }
});

test("missing and invalid required counters are not replaced with fabricated zero", () => {
  for (const usage of [undefined, null, {}, [], { total_tokens: 10 }, { prompt_tokens: null, completion_tokens: -1 },
    { prompt_tokens: false, completion_tokens: "" }, { prompt_tokens: 1.5, completion_tokens: Infinity }]) {
    const cost = calculateTokenCost(flat, usage);
    assert.equal(cost.costStatus, "unknown");
    assert.equal(cost.estimatedCostAmount, null);
    assert.equal(cost.amount, 0);
    assert.equal(cost.counters.inputTokens, null);
    assert.equal(cost.counters.outputTokens, null);
  }
  const inputOnlyKnown = calculateTokenCost(flat, { prompt_tokens: 10, prompt_tokens_details: { cache_write_tokens: 0 } });
  assert.equal(inputOnlyKnown.costStatus, "partial");
  close(inputOnlyKnown.amount, 20 / 1e6);
  const outputOnlyKnown = calculateTokenCost(flat, { output_tokens: 10 });
  assert.equal(outputOnlyKnown.costStatus, "partial");
  close(outputOnlyKnown.amount, 100 / 1e6);
  const unknownTier = calculateTokenCost(tiered, { output_tokens: 10 });
  assert.equal(unknownTier.costStatus, "unknown");
  assert.equal(unknownTier.amount, 0);
  assert.equal(unknownTier.tier, null);
});

test("zero rates are free, missing rates are unknown, and zero usage needs no nonexistent rates", () => {
  const free = compilePricingPolicy({ inputPer1mTokens: 0, outputPer1mTokens: 0, cachedInputPer1mTokens: 0 });
  const result = calculateTokenCost(free, { prompt_tokens: 10, completion_tokens: 10, cached_tokens: 5 });
  assert.equal(result.costStatus, "priced");
  assert.equal(result.amount, 0);
  assert.equal(result.estimatedCostAmount, 0);
  const missing = calculateTokenCost(compilePricingPolicy({ outputPer1mTokens: 0 }), { prompt_tokens: 10, completion_tokens: 10 });
  assert.equal(missing.costStatus, "partial");
  assert.equal(missing.estimatedCostAmount, null);
  const empty = calculateTokenCost(compilePricingPolicy({ inputPer1mTokens: 0 }), { prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(empty.costStatus, "priced");
  assert.equal(empty.estimatedCostAmount, 0);
});

test("estimated usage never selects a precise tier; flat estimates remain explicitly partial", () => {
  const usage = { prompt_tokens: 200000, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 0 } };
  const unknown = calculateTokenCost(tiered, usage, { estimated: true });
  assert.equal(unknown.costStatus, "unknown");
  assert.equal(unknown.amount, 0);
  assert.equal(unknown.estimatedCostAmount, null);
  assert.equal(unknown.tier, null);
  assert.match(unknown.reason, /estimated/i);
  const estimate = calculateTokenCost(flat, usage, { estimated: true });
  assert.equal(estimate.costStatus, "partial");
  assert.equal(estimate.estimatedCostAmount, null);
  close(estimate.amount, 0.4001);
  assert.match(estimate.reason, /estimated/i);
});

test("inputOnly charges the full tier-selected input at its input rate, ignoring cache discounts and output", () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 199980, cache_creation_input_tokens: 10 };
  const cost = calculateTokenCost(tiered, usage, { backendProtocol: "messages", inputOnly: true });
  assert.equal(cost.costStatus, "priced");
  assert.equal(cost.tier.id, "long");
  assert.equal(cost.amount, 0.8);
  const router = compilePricingPolicy({ inputPer1kTokens: 0.001 });
  assert.equal(calculateTokenCost(router, { input_tokens: 200000 }, { inputOnly: true }).amount, 0.2);
  assert.equal(calculateTokenCost(tiered, usage, { inputOnly: true, estimated: true }).costStatus, "unknown");
});

test("unproven OpenAI cache-write names are not invented or inferred from uncached input", () => {
  for (const backendProtocol of ["responses", "chat/completions"]) {
    const cost = calculateTokenCost(flat, {
      input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 2 },
      unrelated_extension: { cache_write_tokens: 8 }
    }, { backendProtocol });
    assert.equal(cost.costStatus, "partial");
    assert.equal(cost.counters.cacheWriteTokens, null);
    assert.equal(cost.cacheWrite.tokens, null);
    close(cost.amount, (2 * 0.2 + 10) / 1e6);
  }
});

test("documented Chat cache-write usage partitions input into separately priced categories", () => {
  const usage = {
    prompt_tokens: 100, completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }
  };
  const cost = calculateTokenCost(flat, usage, { backendProtocol: "chat/completions" });
  assert.equal(cost.counters.inputTokens, 100);
  assert.equal(cost.counters.cachedInputTokens, 20);
  assert.equal(cost.counters.cacheWriteTokens, 10);
  assert.equal(cost.counters.uncachedInputTokens, 70);
  assert.equal(cost.costStatus, "priced");
  assert.equal(cost.estimatedCostAmount, cost.amount);
  assert.equal(cost.reason, "");
  close(cost.amount, (70 * 2 + 20 * 0.2 + 10 * 2.5 + 1 * 10) / 1e6);

  const noWriteRate = compilePricingPolicy({ inputPer1mTokens: 2, outputPer1mTokens: 10, cachedInputPer1mTokens: 0.2 });
  const missing = calculateTokenCost(noWriteRate, usage, { backendProtocol: "chat/completions" });
  assert.equal(missing.costStatus, "partial");
  assert.match(missing.reason, /cacheWritePer1mTokens/);
  close(missing.amount, (70 * 2 + 20 * 0.2 + 10) / 1e6);
  assert.equal(missing.cacheWrite.tokens, 10);
  assert.equal(missing.cacheWrite.costStatus, "unknown");
  assert.equal(missing.cacheWrite.estimatedCostAmount, null);

  const zero = calculateTokenCost(flat, {
    ...usage, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 }
  }, { backendProtocol: "chat/completions" });
  assert.equal(zero.costStatus, "priced");
  assert.equal(zero.counters.uncachedInputTokens, 80);
  assert.equal(zero.counters.cacheWriteTokens, 0);
});

test("Chat cache-write bounds preserve reported tokens while withholding inconsistent input charges", () => {
  for (const cache_write_tokens of [-1, "invalid"]) {
    const cost = calculateTokenCost(flat, {
      prompt_tokens: 100, completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens }
    }, { backendProtocol: "chat/completions" });
    assert.equal(cost.costStatus, "partial");
    assert.equal(cost.estimatedCostAmount, null);
    assert.equal(cost.counters.uncachedInputTokens, null);
    close(cost.amount, 10 / 1e6);
  }
  for (const cache_write_tokens of [50, 101, 1000]) {
    const usage = {
      prompt_tokens: 100, completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 80, cache_write_tokens }
    };
    const original = structuredClone(usage);
    const overlap = calculateTokenCost(flat, usage, { backendProtocol: "chat/completions" });
    assert.equal(overlap.counters.inputTokens, 100);
    assert.equal(overlap.counters.cachedInputTokens, null);
    assert.equal(overlap.counters.cacheWriteTokens, null);
    assert.equal(overlap.counters.uncachedInputTokens, null);
    assert.equal(overlap.cacheWrite.tokens, cache_write_tokens);
    assert.equal(overlap.cacheWrite.usageStatus, "observed");
    assert.equal(overlap.cacheWrite.costStatus, "unknown");
    assert.equal(overlap.costStatus, "partial");
    assert.match(overlap.reason, /exceed total input/);
    close(overlap.amount, 10 / 1e6);
    assert.deepEqual(usage, original);
  }
});

test("unsafe counter values and arithmetic overflow remain nonnegative unknown amounts", () => {
  const cost = calculateTokenCost(flat, { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 });
  assert.notEqual(cost.costStatus, "priced");
  assert.equal(cost.counters.inputTokens, null);
  assert.equal(cost.amount, 0);
  const enormous = compilePricingPolicy({ inputPer1mTokens: Number.MAX_VALUE, outputPer1mTokens: 0 });
  const overflow = calculateTokenCost(enormous, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 });
  assert.notEqual(overflow.costStatus, "priced");
  assert.ok(Number.isFinite(overflow.amount));
  const totalOverflow = calculateTokenCost(flat, {
    input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, output_tokens: 0
  }, { backendProtocol: "messages" });
  assert.equal(totalOverflow.costStatus, "partial");
  assert.equal(totalOverflow.counters.inputTokens, null);
  assert.equal(totalOverflow.estimatedCostAmount, null);
});

test("cache-write reporting separates absent usage, explicit zero, invalid usage and missing pricing", () => {
  const unknownWrite = {
    tokens: null, usageStatus: "unknown", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown"
  };
  for (const value of [undefined, null, -1, 1.5, "", false, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
    const details = value === undefined ? {} : { cache_write_tokens: value };
    const cost = calculateTokenCost(flat, {
      prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: details
    }, { backendProtocol: "chat/completions" });
    assert.deepEqual(cost.cacheWrite, unknownWrite);
  }
  for (const policy of [null, compilePricingPolicy({ inputPer1mTokens: 2 }), tiered]) {
    const zero = calculateTokenCost(policy, {
      prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 0 }
    }, { backendProtocol: "chat/completions" });
    assert.deepEqual(zero.cacheWrite, {
      tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced"
    });
  }
  const noPolicy = calculateTokenCost(null, {
    input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 12
  }, { backendProtocol: "messages" });
  assert.deepEqual(noPolicy.cacheWrite, {
    tokens: 12, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown"
  });
  assert.deepEqual(calculateTokenCost(flat, null).cacheWrite, unknownWrite);
});

test("documented Chat and Responses writes price valid partitions and retain inconsistent reports", () => {
  for (const [backendProtocol, inputKey, outputKey, detailKey] of [
    ["chat/completions", "prompt_tokens", "completion_tokens", "prompt_tokens_details"],
    ["responses", "input_tokens", "output_tokens", "input_tokens_details"]
  ]) {
    for (const writeTokens of [10, 1000, Number.MAX_SAFE_INTEGER]) {
      const usage = { [inputKey]: 100, [outputKey]: 1, [detailKey]: { cached_tokens: 20, cache_write_tokens: writeTokens } };
      const original = structuredClone(usage);
      const cost = calculateTokenCost(flat, usage, { backendProtocol });
      assert.equal(cost.counters.inputTokens, 100);
      if (writeTokens === 10) {
        assert.deepEqual(cost.cacheWrite, {
          tokens: 10, usageStatus: "observed", knownCostAmount: 0.000025, estimatedCostAmount: 0.000025, costStatus: "priced"
        });
        assert.equal(cost.costStatus, "priced");
        assert.equal(cost.counters.cacheWriteTokens, 10);
        assert.equal(cost.counters.uncachedInputTokens, 70);
        close(cost.amount, (70 * 2 + 20 * 0.2 + 10 * 2.5 + 10) / 1e6);
      } else {
        assert.deepEqual(cost.cacheWrite, {
          tokens: writeTokens, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown"
        });
        assert.equal(cost.costStatus, "partial");
        assert.equal(cost.counters.cacheWriteTokens, null);
        assert.equal(cost.counters.uncachedInputTokens, null);
        close(cost.amount, 10 / 1e6);
        assert.match(cost.reason, /exceed total input/);
      }
      assert.deepEqual(usage, original);
    }
  }
});

test("Chat and Responses write charges use the whole-request tier without increasing input totals", () => {
  for (const [backendProtocol, inputKey, outputKey, detailKey] of [
    ["chat/completions", "prompt_tokens", "completion_tokens", "prompt_tokens_details"],
    ["responses", "input_tokens", "output_tokens", "input_tokens_details"]
  ]) {
    const usage = { [inputKey]: 200000, [outputKey]: 1000, [detailKey]: { cached_tokens: 190000, cache_write_tokens: 5000 } };
    const cost = calculateTokenCost(tiered, usage, { backendProtocol });
    assert.equal(cost.counters.inputTokens, 200000);
    assert.equal(cost.counters.uncachedInputTokens, 5000);
    assert.equal(cost.tier.id, "long");
    assert.equal(cost.costStatus, "priced");
    close(cost.amount, (5000 * 4 + 190000 * 0.4 + 5000 * 5 + 1000 * 15) / 1e6);
    assert.equal(cost.cacheWrite.tokens, 5000);
    assert.equal(cost.cacheWrite.costStatus, "priced");
    assert.equal(cost.cacheWrite.knownCostAmount, 0.025);
    assert.equal(cost.cacheWrite.estimatedCostAmount, 0.025);
  }
});

test("Chat and Responses zero or absent writes retain legacy input pricing without fabricated reporting", () => {
  const noWriteRate = compilePricingPolicy({ inputPer1mTokens: 2, outputPer1mTokens: 10, cachedInputPer1mTokens: 0.2 });
  for (const [backendProtocol, inputKey, outputKey, detailKey] of [
    ["chat/completions", "prompt_tokens", "completion_tokens", "prompt_tokens_details"],
    ["responses", "input_tokens", "output_tokens", "input_tokens_details"]
  ]) {
    for (const writeTokens of [undefined, 0, 10]) {
      const details = { cached_tokens: 20, ...(writeTokens === undefined ? {} : { cache_write_tokens: writeTokens }) };
      const cost = calculateTokenCost(noWriteRate, { [inputKey]: 100, [outputKey]: 1, [detailKey]: details }, { backendProtocol });
      assert.equal(cost.counters.inputTokens, 100);
      assert.equal(cost.counters.uncachedInputTokens, 80 - (writeTokens || 0));
      assert.equal(cost.costStatus, writeTokens === 10 ? "partial" : "priced");
      assert.equal(cost.cacheWrite.tokens, writeTokens ?? null);
      assert.equal(cost.cacheWrite.usageStatus, writeTokens === undefined ? "unknown" : "observed");
      assert.equal(cost.cacheWrite.estimatedCostAmount, writeTokens === 0 ? 0 : null);
      assert.equal(cost.cacheWrite.costStatus, writeTokens === 0 ? "priced" : "unknown");
      close(cost.amount, ((80 - (writeTokens || 0)) * 2 + 20 * 0.2 + 10) / 1e6);
    }
  }
});

test("cache-write component costs follow Messages combined and TTL rates independently of other components", () => {
  const usage = {
    input_tokens: 10, cache_creation_input_tokens: 12,
    cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 5 }
  };
  const combined = calculateTokenCost(flat, usage, { backendProtocol: "messages" });
  assert.equal(combined.costStatus, "partial");
  assert.deepEqual(combined.cacheWrite, {
    tokens: 12, usageStatus: "observed", knownCostAmount: 0.00003, estimatedCostAmount: 0.00003, costStatus: "priced"
  });
  const ttlPolicy = compilePricingPolicy({ ...rates, cacheWrite5mPer1mTokens: 3, cacheWrite1hPer1mTokens: 4 });
  const ttl = calculateTokenCost(ttlPolicy, usage, { backendProtocol: "messages" });
  close(ttl.cacheWrite.knownCostAmount, (7 * 3 + 5 * 4) / 1e6);
  assert.equal(ttl.cacheWrite.estimatedCostAmount, ttl.cacheWrite.knownCostAmount);
  assert.equal(ttl.cacheWrite.costStatus, "priced");
  const { cache_creation_input_tokens: ignored, ...breakdownOnly } = usage;
  assert.deepEqual(calculateTokenCost(ttlPolicy, breakdownOnly, { backendProtocol: "messages" }).cacheWrite, ttl.cacheWrite);
  const partial = calculateTokenCost(compilePricingPolicy({ ...rates, cacheWrite5mPer1mTokens: 3 }), usage, { backendProtocol: "messages" });
  assert.equal(partial.cacheWrite.costStatus, "partial");
  close(partial.cacheWrite.knownCostAmount, 7 * 3 / 1e6);
  assert.equal(partial.cacheWrite.estimatedCostAmount, null);
  const inconsistent = calculateTokenCost(ttlPolicy, {
    ...usage, cache_creation_input_tokens: 99
  }, { backendProtocol: "messages" });
  assert.equal(inconsistent.cacheWrite.tokens, 99);
  assert.equal(inconsistent.cacheWrite.usageStatus, "observed");
  assert.equal(inconsistent.cacheWrite.costStatus, "unknown");
});

test("cache-write component pricing respects selected tiers and never mistakes router fees for write charges", () => {
  const usage = { input_tokens: 10000, output_tokens: 1, cache_read_input_tokens: 189999, cache_creation_input_tokens: 1 };
  const actual = calculateTokenCost(tiered, usage, { backendProtocol: "messages" });
  assert.equal(actual.tier.id, "long");
  assert.equal(actual.cacheWrite.tokens, 1);
  close(actual.cacheWrite.knownCostAmount, 5 / 1e6);
  assert.equal(actual.cacheWrite.costStatus, "priced");
  const router = calculateTokenCost(tiered, usage, { backendProtocol: "messages", inputOnly: true });
  assert.equal(router.amount, 0.8);
  assert.equal(router.cacheWrite.tokens, 1);
  assert.equal(router.cacheWrite.knownCostAmount, 0);
  assert.equal(router.cacheWrite.estimatedCostAmount, null);
  assert.equal(router.cacheWrite.costStatus, "unknown");
  const estimate = calculateTokenCost(tiered, usage, { backendProtocol: "messages", estimated: true });
  assert.equal(estimate.cacheWrite.tokens, 1);
  assert.equal(estimate.cacheWrite.costStatus, "unknown");
});

test("write-priced OpenAI policies require reported writes while legacy policies and router fees remain compatible", () => {
  const legacy = compilePricingPolicy({ inputPer1mTokens: 2, outputPer1mTokens: 10, cachedInputPer1mTokens: 0.2 });
  for (const [backendProtocol, inputKey, outputKey, detailKey] of [
    ["chat/completions", "prompt_tokens", "completion_tokens", "prompt_tokens_details"],
    ["responses", "input_tokens", "output_tokens", "input_tokens_details"]
  ]) {
    const usage = { [inputKey]: 100, [outputKey]: 1, [detailKey]: { cached_tokens: 20 } };
    const missing = calculateTokenCost(flat, usage, { backendProtocol });
    assert.equal(missing.costStatus, "partial");
    assert.equal(missing.counters.inputTokens, 100);
    assert.equal(missing.counters.uncachedInputTokens, null);
    assert.equal(missing.counters.cacheWriteTokens, null);
    assert.equal(missing.cacheWrite.tokens, null);
    assert.equal(missing.cacheWrite.costStatus, "unknown");
    assert.equal(missing.estimatedCostAmount, null);
    close(missing.amount, (20 * 0.2 + 10) / 1e6);
    assert.match(missing.reason, /cache.write.*(missing|reported)|missing.*cache.write/i);
    const compatible = calculateTokenCost(legacy, usage, { backendProtocol });
    assert.equal(compatible.costStatus, "priced");
    close(compatible.amount, (80 * 2 + 20 * 0.2 + 10) / 1e6);
    assert.equal(compatible.cacheWrite.tokens, null);
    const router = calculateTokenCost(flat, usage, { backendProtocol, inputOnly: true });
    assert.equal(router.costStatus, "priced");
    close(router.amount, 100 * 2 / 1e6);
    assert.equal(router.cacheWrite.costStatus, "unknown");

    const long = calculateTokenCost(tiered, {
      [inputKey]: 200000, [outputKey]: 1000, [detailKey]: { cached_tokens: 190000 }
    }, { backendProtocol });
    assert.equal(long.costStatus, "partial");
    assert.equal(long.tier.id, "long");
    close(long.amount, (190000 * 0.4 + 1000 * 15) / 1e6);
  }
});

test("write-priced Messages usage cannot fabricate missing cache creation or a precise context tier", () => {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 };
  const flatMissing = calculateTokenCost(flat, usage, { backendProtocol: "messages" });
  assert.equal(flatMissing.costStatus, "partial");
  assert.equal(flatMissing.counters.inputTokens, null);
  assert.equal(flatMissing.counters.cacheWriteTokens, null);
  assert.equal(flatMissing.cacheWrite.tokens, null);
  close(flatMissing.amount, (5 * 0.2 + 10) / 1e6);
  const tierMissing = calculateTokenCost(tiered, usage, { backendProtocol: "messages" });
  assert.equal(tierMissing.costStatus, "unknown");
  assert.equal(tierMissing.tier, null);
  assert.equal(tierMissing.amount, 0);
  assert.equal(tierMissing.counters.inputTokens, null);
  const reportedTotal = calculateTokenCost(tiered, { ...usage, prompt_tokens: 15 }, { backendProtocol: "messages" });
  assert.equal(reportedTotal.costStatus, "partial");
  assert.equal(reportedTotal.tier.id, "short");
  close(reportedTotal.amount, (5 * 0.2 + 10) / 1e6);
  const zero = calculateTokenCost(flat, { ...usage, cache_creation_input_tokens: 0 }, { backendProtocol: "messages" });
  assert.equal(zero.costStatus, "priced");
  close(zero.amount, (10 * 2 + 5 * 0.2 + 10) / 1e6);
  const legacy = calculateTokenCost(compilePricingPolicy({ inputPer1mTokens: 2, outputPer1mTokens: 10, cachedInputPer1mTokens: 0.2 }),
    usage, { backendProtocol: "messages" });
  assert.equal(legacy.costStatus, "priced");
  assert.equal(legacy.amount, zero.amount);
});
