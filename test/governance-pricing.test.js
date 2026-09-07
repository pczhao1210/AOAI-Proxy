import assert from "node:assert/strict";
import test from "node:test";
import { recordGovernanceUsage } from "../src/governance.js";

const ROUTER = { id: "model-router", targetModel: "model-router", pricingRef: "model-router" };
const ACTUAL = { id: "gpt-4o", targetModel: "gpt-4o", pricingRef: "gpt-4o" };
const USAGE = { prompt_tokens: 1000, completion_tokens: 1000 };
let consumerIndex = 0;

function calculateCost(models, actualModelName, access = {}) {
  consumerIndex += 1;
  return recordGovernanceUsage({
    models,
    access: { budgets: { enabled: false, defaultCurrency: "USD" }, ...access }
  }, {
    keyId: `pricing-regression-${consumerIndex}`, apiKey: {}
  }, models[0], USAGE, Date.now(), actualModelName);
}

test("Model Router pricing does not require an actual-model route", () => {
  const configured = calculateCost([ROUTER, ACTUAL], "gpt-4o");
  for (const actualModelName of ["gpt-4o", "gpt-4o-2024-11-20"]) {
    const libraryOnly = calculateCost([ROUTER], actualModelName);
    assert.equal(libraryOnly.amount, configured.amount);
    assert.equal(libraryOnly.actualModelCostAmount, configured.actualModelCostAmount);
    assert.equal(libraryOnly.modelRouterCostAmount, configured.modelRouterCostAmount);
    assert.equal(libraryOnly.configured, true);
    assert.match(libraryOnly.source, /actual:pricing-library\.gpt-4o/);
  }
});

test("Model Router unknown actual pricing remains explicitly unmetered", () => {
  for (const actualModelName of ["unknown-router-backend", "model-router", ""]) {
    const cost = calculateCost([ROUTER], actualModelName);
    assert.equal(cost.actualModelCostAmount, 0);
    assert.equal(cost.amount, cost.modelRouterCostAmount);
    assert.equal(cost.configured, false);
    assert.doesNotMatch(cost.source, /actual:/);
  }
});

test("Model Router custom pricing is not inherited by an actual-model catalog entry", () => {
  const router = { ...ROUTER, pricing: { inputPer1kTokens: 2, outputPer1kTokens: 77 } };
  const cost = calculateCost([router], "custom-backend", {
    pricingCatalog: { "custom-backend": { inputPer1kTokens: 0.003, outputPer1kTokens: 0.004 } }
  });
  assert.equal(cost.modelRouterCostAmount, 2);
  assert.equal(cost.actualModelCostAmount, 0.007);
  assert.equal(cost.amount, 2.007);
  assert.equal(cost.configured, true);
});

test("direct models retain their configured pricing overrides", () => {
  const model = { ...ACTUAL, pricing: { inputPer1kTokens: 1, outputPer1kTokens: 2 } };
  const cost = calculateCost([model], "gpt-4o");
  assert.equal(cost.amount, 3);
  assert.equal(cost.actualModelCostAmount, 3);
  assert.equal(cost.modelRouterCostAmount, 0);
});