import assert from "node:assert/strict";
import test from "node:test";
import { compileModelCatalog, installModelCatalogSnapshot } from "../src/model-catalog.js";
import { recordGovernanceUsage, getGovernanceSnapshot } from "../src/governance.js";
import { upsertPricingCatalogEntry } from "../admin-ui/src/utils.js";

const policy = {
  currency: "USD",
  billingUnit: "1M tokens",
  tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
  tiers: [
    { id: "short", promptTokensBelow: 200000, inputPer1mTokens: 2, cachedInputPer1mTokens: 0.2, outputPer1mTokens: 10 },
    { id: "long", promptTokensAtLeast: 200000, inputPer1mTokens: 4, cachedInputPer1mTokens: 0.4, outputPer1mTokens: 15 }
  ]
};
const model = { id: "public-tier", targetModel: "tier-model", pricingRef: "tier-model" };
const definition = { id: "tier-model", interfaces: ["responses", "messages"], pricingCatalogEntry: policy };
let sequence = 0;
function settle(config, usage, actualModelName = "", metadata = {}) {
  const consumer = { keyId: `context-pricing-${++sequence}`, apiKey: {} };
  const cost = recordGovernanceUsage(config, consumer, config.models[0], usage, Date.now(), actualModelName, metadata);
  return { cost, consumer };
}

test("context tiers charge the whole request including cache and selected output rate", () => {
  const config = { models: [{ ...model, pricing: policy }] };
  for (const input of [199999, 200000, 200001]) {
    const { cost } = settle(config, { input_tokens: input, output_tokens: 1000, input_tokens_details: { cached_tokens: 190000 } });
    const rates = input < 200000 ? [2, 0.2, 10] : [4, 0.4, 15];
    assert.ok(Math.abs(cost.amount - ((input - 190000) * rates[0] + 190000 * rates[1] + 1000 * rates[2]) / 1e6) < 1e-12);
    assert.equal(cost.configured, true);
    assert.equal(cost.costStatus, "priced");
    assert.equal(cost.pricing.actual.tier.id, input < 200000 ? "short" : "long");
  }
});

test("verified xAI catalog tables switch at 200000 input tokens", () => {
  for (const [id, shortRates, longRates] of [
    ["grok-4.3", [1.25, 0.2, 2.5], [2.5, 0.4, 5]],
    ["grok-4.6", [2, 0.5, 6], [4, 1, 12]]
  ]) {
    const config = { models: [{ id, pricingRef: id }] };
    for (const input of [199999, 200000, 200001]) {
      const { cost } = settle(config, { prompt_tokens: input, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 190000 } });
      const rates = input < 200000 ? shortRates : longRates;
      assert.ok(Math.abs(cost.amount - ((input - 190000) * rates[0] + 190000 * rates[1] + 1000 * rates[2]) / 1e6) < 1e-12);
      assert.equal(cost.costStatus, "priced");
      assert.equal(cost.pricing.actual.tier.id, input < 200000 ? "short" : "long");
    }
  }
});

test("GPT catalog policies select the whole-request rate only above 272000 input tokens", () => {
  for (const [id, shortRates, longRates] of [
    ["gpt-5.4", [2.5, 0.25, 15], [5, 0.5, 22.5]],
    ["gpt-5.4-pro", [30, null, 180], [60, null, 270]],
    ["gpt-5.5", [5, 0.5, 30], [10, 1, 45]],
    ["gpt-5.6-sol", [4, 0.4, 20], [8, 0.8, 30]],
    ["gpt-5.6-terra", [2, 0.2, 12], [4, 0.4, 18]],
    ["gpt-5.6-luna", [0.2, 0.02, 1.2], [0.4, 0.04, 1.8]],
    ["gpt-6-astra", [10, 1, 50], [20, 2, 75]],
    ["gpt-6-sol", [2, 0.2, 10], [4, 0.4, 15]],
    ["gpt-6-luna", [0.1, 0.01, 0.5], [0.2, 0.02, 0.75]]
  ]) {
    const config = { models: [{ id, pricingRef: id }] };
    const cached = shortRates[1] === null ? 0 : 271000;
    for (const input of [271999, 272000, 272001]) {
      const rates = input > 272000 ? longRates : shortRates;
      const expected = ((input - cached) * rates[0] + cached * (rates[1] ?? 0) + 128000 * rates[2]) / 1e6;
      for (const protocol of ["chat/completions", "responses"]) {
        const usage = protocol === "responses"
          ? { input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, output_tokens: 128000 }
          : { prompt_tokens: input, prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 }, completion_tokens: 128000 };
        const { cost } = settle(config, usage, id, { backendRouteKey: protocol });
        assert.equal(cost.costStatus, "priced", `${id} ${protocol}: ${cost.costReason}`);
        assert.equal(cost.pricing.actual.tier.id, input > 272000 ? "long" : "short", id);
        assert.ok(Math.abs(cost.amount - expected) < 1e-10, `${id} ${protocol} input=${input}`);
      }
    }
    const consumer = { keyId: `gpt-repeated-${++sequence}`, apiKey: {} };
    for (let request = 0; request < 3; request += 1) {
      const cost = recordGovernanceUsage(config, consumer, config.models[0],
        { input_tokens: 100000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0 });
      assert.equal(cost.pricing.actual.tier.id, "short", "Session totals must not choose a request tier");
    }
  }
});

test("GPT cache-write prices use the selected request tier without charging ordinary input twice", () => {
  for (const [id, shortRates, longRates] of [
    ["gpt-5.6-sol", [4, 0.4, 5, 20], [8, 0.8, 10, 30]],
    ["gpt-5.6-terra", [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
    ["gpt-5.6-luna", [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
    ["gpt-6-astra", [10, 1, 12.5, 50], [20, 2, 25, 75]],
    ["gpt-6-sol", [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
    ["gpt-6-luna", [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]]
  ]) {
    const config = { models: [{ id, pricingRef: id }] };
    for (const input of [272000, 272001]) {
      const rates = input > 272000 ? longRates : shortRates;
      const expected = ((input - 271000) * rates[0] + 270000 * rates[1] + 1000 * rates[2] + 1000 * rates[3]) / 1e6;
      for (const protocol of ["chat/completions", "responses"]) {
        const details = { cached_tokens: 270000, cache_write_tokens: 1000 };
        const usage = protocol === "responses"
          ? { input_tokens: input, input_tokens_details: details, output_tokens: 1000 }
          : { prompt_tokens: input, prompt_tokens_details: details, completion_tokens: 1000 };
        const { cost } = settle(config, usage, id, { backendRouteKey: protocol });
        assert.equal(cost.costStatus, "priced", `${id} ${protocol}: ${cost.costReason}`);
        assert.equal(cost.pricing.actual.tier.id, input > 272000 ? "long" : "short");
        assert.equal(cost.promptTokens, input);
        assert.equal(cost.totalTokens, input + 1000);
        assert.ok(Math.abs(cost.amount - expected) < 1e-10, `${id} ${protocol}: ${cost.amount}`);
        assert.equal(cost.cacheWrite.tokens, 1000);
        assert.equal(cost.cacheWrite.usageStatus, "observed");
        assert.equal(cost.cacheWrite.costStatus, "priced");
        assert.equal(cost.cacheWrite.estimatedCostAmount, rates[2] / 1000);
      }
    }
  }
});

test("pricing snapshots retain overrides and catalog rates across activation", () => {
  const config = { models: [model], access: { pricingCatalog: {} } };
  const snapshot = compileModelCatalog(config, [definition]);
  const next = structuredClone(definition);
  next.pricingCatalogEntry.tiers[1].inputPer1mTokens = 40;
  installModelCatalogSnapshot(compileModelCatalog(config, [next]));
  const { cost } = settle(config, { input_tokens: 200000, output_tokens: 0 }, "", { pricingContext: snapshot.pricingContext });
  assert.equal(cost.amount, 0.8);
  assert.match(cost.pricing.actual.policyDigest, /^[a-f0-9]{64}$/);
  assert.equal(cost.pricing.actual.source, "pricing-library.tier-model");
  const overridden = { ...config, models: [{ ...model, pricing: { inputPer1kTokens: 1, outputPer1kTokens: 0 } }] };
  const overrideSnapshot = compileModelCatalog(overridden, [definition]);
  overridden.models[0].pricing.inputPer1kTokens = 999;
  assert.equal(settle(overridden, { input_tokens: 200000, output_tokens: 0 }, "", { pricingContext: overrideSnapshot.pricingContext }).cost.amount, 200);
});

test("catalog explicit null remains unpriced even with reference tier metadata", () => {
  const config = { models: [model] };
  const snapshot = compileModelCatalog(config, [{ ...definition, pricing: policy, pricingCatalogEntry: null }]);
  const { cost } = settle(config, { input_tokens: 200000, output_tokens: 1 }, "", { pricingContext: snapshot.pricingContext });
  assert.equal(cost.configured, false);
  assert.equal(cost.costStatus, "unknown");
  assert.equal(cost.estimatedCostAmount, null);
});

test("a direct deployment keeps its own override when another public model shares its target", () => {
  const own = { ...model, pricing: policy };
  const config = { models: [{ ...model, id: "other", pricing: { inputPer1kTokens: 999 } }, own] };
  const snapshot = compileModelCatalog(config, [definition]);
  const cost = recordGovernanceUsage(config, { keyId: `context-pricing-${++sequence}`, apiKey: {} },
    own, { input_tokens: 200000, output_tokens: 0 }, Date.now(), "tier-model", { pricingContext: snapshot.pricingContext });
  assert.equal(cost.amount, 0.8);
});

test("admin import preserves the full tier policy without aliasing the card", () => {
  const config = {};
  upsertPricingCatalogEntry(config, definition);
  assert.deepEqual(config.access.pricingCatalog["tier-model"], policy);
  assert.notEqual(config.access.pricingCatalog["tier-model"], policy);
  config.access.pricingCatalog["tier-model"].tiers[0].inputPer1mTokens = 999;
  assert.equal(policy.tiers[0].inputPer1mTokens, 2);
});

test("estimated context usage does not choose a precise tier; explicit zero prices are metered", () => {
  const config = { models: [{ ...model, pricing: policy }] };
  const estimated = settle(config, { input_tokens: 200000, output_tokens: 1 }, "", { usageEstimated: true }).cost;
  assert.equal(estimated.configured, false);
  assert.equal(estimated.costStatus, "unknown");
  assert.equal(estimated.estimatedCostAmount, null);
  const free = settle({ models: [{ ...model, pricing: { inputPer1kTokens: 0, outputPer1kTokens: 0 } }] }, { input_tokens: 10, output_tokens: 1 }).cost;
  assert.equal(free.amount, 0);
  assert.equal(free.costStatus, "priced");
  assert.equal(free.configured, true);
});

test("Model Router retains its fee and tiers the actual model using captured catalog", () => {
  const config = { models: [{ id: "model-router", pricing: { inputPer1kTokens: 0.001 } }] };
  const snapshot = compileModelCatalog(config, [definition]);
  const { cost } = settle(config, { input_tokens: 200000, output_tokens: 1000 }, "tier-model", { pricingContext: snapshot.pricingContext });
  assert.equal(cost.modelRouterCostAmount, 0.2);
  assert.ok(Math.abs(cost.actualModelCostAmount - 0.815) < 1e-12);
  assert.equal(cost.costStatus, "priced");
  const unknown = settle(config, { input_tokens: 200000, output_tokens: 1000 }, "unknown-model", { pricingContext: snapshot.pricingContext }).cost;
  assert.equal(unknown.amount, 0.2);
  assert.equal(unknown.costStatus, "partial");
  assert.equal(unknown.estimatedCostAmount, null);
});

test("invalid executable tier policies reject candidate compilation without installing them", () => {
  for (const malformed of [
    { ...policy, tiering: { ...policy.tiering, method: "marginal" } },
    { ...policy, tiers: [policy.tiers[0], { ...policy.tiers[1], promptTokensAtLeast: 200001 }] }
  ]) {
    assert.throws(() => compileModelCatalog({ models: [model] }, [{ ...definition, pricingCatalogEntry: malformed }]), /pricing|tier/i);
    assert.throws(() => compileModelCatalog({ models: [{ ...model, pricing: malformed }] }, [definition]), /pricing|tier/i);
  }
});

test("governance records known tier costs and unknown text request count in budgets", async () => {
  const config = { models: [{ ...model, pricing: policy }], apiKeys: [], access: { budgets: { enabled: false } } };
  const { cost, consumer } = settle(config, { input_tokens: 200000, output_tokens: 1 });
  config.apiKeys.push({ id: consumer.keyId });
  recordGovernanceUsage(config, consumer, config.models[0], { output_tokens: 1 });
  const snapshot = await getGovernanceSnapshot(config);
  const entry = snapshot.keys.find((item) => item.keyId === consumer.keyId);
  assert.equal(entry.runtime.budgetWindow.spentAmount, cost.amount);
  assert.equal(entry.runtime.budgetWindow.textUnknownCostRequests, 1);
});
