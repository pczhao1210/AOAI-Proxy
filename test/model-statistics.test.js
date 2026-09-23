import assert from "node:assert/strict";
import test from "node:test";
import { getStats, recordRequest, recordError, recordUsage, recordMediaUsage, beginModelStatsReset } from "../src/stats.js";
import { recordGovernanceUsage } from "../src/governance.js";
import { resetRuntimeModelStats } from "../src/runtime-store.js";
import { billingTierIdentity, billingTierKey, billingTierFromKey, reconcileBillingTiers, summarizeCacheWrite } from "../src/statistics.js";

function pricing(threshold = 272001, rate = 1) {
  return {
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [
      { id: "base", promptTokensBelow: threshold, inputPer1mTokens: rate, outputPer1mTokens: rate * 2 },
      { id: "long", promptTokensAtLeast: threshold, inputPer1mTokens: rate * 2, outputPer1mTokens: rate * 4 }
    ]
  };
}

function settle(model, prompt, actual = model.id, extra = {}) {
  const usage = { prompt_tokens: prompt, completion_tokens: 3, total_tokens: prompt + 3,
    prompt_tokens_details: { cached_tokens: 0 } };
  const cost = recordGovernanceUsage({ models: [model], access: { budgets: { enabled: false } } },
    { keyId: "statistics-test", apiKey: {} }, model, usage, Date.now(), actual, extra);
  recordUsage(model.id, usage, { keyId: "statistics-test", actualModelName: actual, cost });
  return cost;
}

test("billing tiers group by captured IDs across rate and threshold changes without repricing", async () => {
  await resetRuntimeModelStats({});
  const model = { id: "statistics-model", targetModel: "statistics-model", pricing: pricing() };
  recordRequest(model.id, { keyId: "statistics-test" });
  recordError(model.id, { keyId: "statistics-test" });
  const first = settle(model, 272000);
  assert.equal(first.pricing.actual.tieringState, "tier");
  settle(model, 272001);
  const changedPrice = { ...model, pricing: pricing(272001, 3) };
  settle(changedPrice, 272000);
  const changedThreshold = { ...model, pricing: pricing(300001, 4) };
  settle(changedThreshold, 272001);
  const row = getStats().perModel[model.id];
  assert.equal(row.requests, 1);
  assert.equal(row.errors, 1);
  assert.equal(row.billingTiers.length, 2);
  assert.deepEqual(row.billingTiers.map(row => [row.tier.id, row.requests]), [["base", 3], ["long", 1]]);
  assert.equal(row.billingTiers[0].tier.promptTokensAtLeast, null);
  assert.equal(row.billingTiers[0].tier.promptTokensBelow, null);
  assert.deepEqual(row.billingTiers[0].tier.intervals, [
    { promptTokensAtLeast: 0, promptTokensBelow: 272001 },
    { promptTokensAtLeast: 0, promptTokensBelow: 300001 }
  ]);
  for (const field of ["promptTokens", "completionTokens", "totalTokens", "cachedTokens", "estimatedCostAmount", "actualModelCostAmount"]) {
    assert.ok(Math.abs(row[field] - row.billingTiers.reduce((sum, tier) => sum + tier[field], 0)) < 1e-10, field);
  }
  assert.equal(row.actualModels[model.id].requests, 4);
  assert.equal(row.cacheWrite.tokens, null);
  assert.equal(row.billingTiers[0].cacheWrite.tokens, null);
});

test("renamed tier IDs stay distinct even at identical bounds and rollup keys preserve IDs", async () => {
  await resetRuntimeModelStats({});
  const model = { id: "renamed-tier", pricing: pricing() };
  const first = settle(model, 272000);
  const renamed = structuredClone(model);
  renamed.pricing.tiers[0].id = "short <=272K";
  const second = settle(renamed, 272000);
  const rows = getStats().perModel[model.id].billingTiers;
  assert.deepEqual(rows.map(row => [row.tier.id, row.requests]), [["base", 1], ["short <=272K", 1]]);
  assert.equal(rows[0].estimatedCostAmount, first.amount);
  assert.equal(rows[1].estimatedCostAmount, second.amount);
  for (const cost of [first, second]) {
    const identity = billingTierIdentity(model.id, "actual", cost.pricing.actual);
    assert.deepEqual(billingTierFromKey(billingTierKey(identity)), identity);
  }
  const legacy = billingTierFromKey(JSON.stringify(["actual", "tier", 0, 272001]));
  assert.deepEqual(legacy, { actualModelId: "actual", tier: { kind: "tier", promptTokensAtLeast: 0, promptTokensBelow: 272001 } });
  assert.notEqual(billingTierKey(legacy), billingTierKey(billingTierIdentity(model.id, "actual", second.pricing.actual)));
});

test("flat policy evidence is explicit and missing or failed tier selection stays unknown", async () => {
  await resetRuntimeModelStats({});
  const flat = { id: "statistics-flat", pricing: { inputPer1mTokens: 1, outputPer1mTokens: 2 } };
  const flatCost = settle(flat, 2);
  assert.equal(flatCost.pricing.actual.tieringState, "flat");
  assert.equal(getStats().perModel[flat.id].billingTiers[0].tier.kind, "flat");
  assert.equal(billingTierIdentity("public", "", { source: "old", tier: null }).tier.kind, "unknown");
  assert.equal(billingTierIdentity("public", "", { tieringState: "unknown", tier: null }).actualModelId, "public");
  const tiered = { id: "statistics-tier-missing", pricing: pricing() };
  const cost = recordGovernanceUsage({ models: [tiered], access: { budgets: { enabled: false } } },
    { keyId: "statistics-test", apiKey: {} }, tiered, { completion_tokens: 1 });
  assert.equal(cost.pricing.actual.tieringState, "unknown");
  recordUsage(tiered.id, { completion_tokens: 1 }, { cost });
  const tier = getStats().perModel[tiered.id].billingTiers[0];
  assert.equal(tier.actualModelId, tiered.id);
  assert.equal(tier.tier.kind, "unknown");
  assert.equal(tier.textUnknownCostRequests, 1);
});

test("Model Router tier rows retain actual-model identity and both cost components", async () => {
  await resetRuntimeModelStats({});
  const router = { id: "model-router", targetModel: "model-router", pricing: { inputPer1mTokens: 2 } };
  const cost = settle(router, 100, "gpt-4o");
  const row = getStats().perModel["model-router"].billingTiers[0];
  assert.equal(row.actualModelId, "gpt-4o");
  assert.equal(row.tier.kind, "flat");
  assert.equal(row.modelRouterCostAmount, cost.modelRouterCostAmount);
  assert.equal(row.actualModelCostAmount, cost.actualModelCostAmount);
  assert.equal(row.estimatedCostAmount, cost.amount);
  recordUsage("model-router", { prompt_tokens: 1 }, {});
  const unknown = getStats().perModel["model-router"].billingTiers.find(row => row.actualModelId === "model-router");
  assert.equal(unknown.tier.kind, "unknown");
  assert.equal(unknown.requests, 1);
});

test("media accounting without a text pricing audit does not add missing cache-write reports", async () => {
  await resetRuntimeModelStats({});
  const before = structuredClone(getStats().totals.cacheWrite);
  recordUsage("media-without-text-audit", { prompt_tokens: 2 }, { keyId: "media-write-test", cost: { amount: 0 } });
  recordMediaUsage("media-without-text-audit", { costStatus: "unknown" }, { keyId: "media-write-test" });
  assert.deepEqual(getStats().totals.cacheWrite, before);
  const model = getStats().perModel["media-without-text-audit"];
  assert.equal(model.billingTiers[0].requests, 1);
  assert.equal(model.billingTiers[0].tier.kind, "unknown");
  assert.equal(model.cacheWrite.unreportedRequests, 0);
  assert.deepEqual(model.billingTiers[0].cacheWrite, model.cacheWrite);
});

test("legacy residual retains usage, known cost and nullable writes without inventing settlement counts", () => {
  const legacy = {
    requests: 90, promptTokens: 50, completionTokens: 4, totalTokens: 54, cachedTokens: 3,
    estimatedCostAmount: 2, actualModelCostAmount: 1.5, modelRouterCostAmount: 0.5, textUnknownCostRequests: 1,
    cacheWrite: summarizeCacheWrite({ unreportedRequests: null }), actualModels: {}
  };
  const model = structuredClone(legacy);
  model.actualModels.actual = { ...structuredClone(legacy), promptTokens: 30, totalTokens: 34, estimatedCostAmount: 1 };
  reconcileBillingTiers("public", model);
  assert.equal(model.billingTiers.length, 2);
  assert.ok(model.billingTiers.every(row => row.requests === null && row.tier.kind === "unknown"));
  assert.equal(model.billingTiers.reduce((sum, row) => sum + row.promptTokens, 0), 50);
  assert.equal(model.billingTiers.reduce((sum, row) => sum + row.estimatedCostAmount, 0), 2);
  assert.equal(model.billingTiers[0].cacheWrite.tokens, null);
  assert.equal(model.billingTiers[0].cacheWrite.estimatedCostAmount, null);
  const fresh = { ...structuredClone(legacy), actualModels: {}, billingTiers: [{
    ...billingTierIdentity("public", "", { tieringState: "flat" }), ...structuredClone(legacy), requests: 2,
    promptTokens: 10, totalTokens: 14, estimatedCostAmount: 0.5
  }] };
  reconcileBillingTiers("public", fresh);
  assert.deepEqual(fresh.billingTiers.map(row => row.requests), [2, null]);
  assert.equal(fresh.billingTiers.reduce((sum, row) => sum + row.promptTokens, 0), 50);
});

test("memory reset retains totals/keys and stages in-flight settlements until commit or failure", async () => {
  await resetRuntimeModelStats({});
  recordRequest("reset-memory", { keyId: "reset-key" });
  recordUsage("reset-memory", { prompt_tokens: 10 }, { keyId: "reset-key" });
  recordMediaUsage("reset-memory", { usageStatus: "unknown" }, { keyId: "reset-key" });
  const before = structuredClone(getStats());
  const reset = beginModelStatsReset("2026-01-01T00:00:00.000Z");
  recordUsage("reset-memory", { prompt_tokens: 2 }, { keyId: "reset-key" });
  recordRequest("post-reset", { keyId: "reset-key" });
  assert.equal(getStats().perModel["reset-memory"].promptTokens, 12);
  reset.commit();
  assert.equal(getStats().perModel["reset-memory"].promptTokens, 2);
  assert.equal(getStats().perModel["reset-memory"].requests, 0);
  assert.equal(getStats().perModel["reset-memory"].media, undefined);
  assert.equal(getStats().totals.promptTokens, before.totals.promptTokens + 2);
  assert.equal(getStats().perKey["reset-key"].promptTokens, before.perKey["reset-key"].promptTokens + 2);
  const failed = beginModelStatsReset("2026-02-01T00:00:00.000Z");
  recordUsage("reset-memory", { prompt_tokens: 3 }, { keyId: "reset-key" });
  failed.rollback();
  assert.equal(getStats().perModel["reset-memory"].promptTokens, 5);
  assert.equal(getStats().modelsResetAt, "2026-01-01T00:00:00.000Z");
  const totals = structuredClone(getStats().totals);
  const keys = structuredClone(getStats().perKey);
  const result = await resetRuntimeModelStats({ persistence: { configStore: { mode: "file" } } });
  assert.equal(result.modelsResetAt, getStats().modelsResetAt);
  assert.deepEqual(getStats().perModel, {});
  assert.deepEqual(getStats().totals, totals);
  assert.deepEqual(getStats().perKey, keys);
});
