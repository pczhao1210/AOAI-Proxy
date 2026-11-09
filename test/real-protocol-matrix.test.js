import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, parseArgs, selectMatrixCases } from "./run-real-protocol-matrix.js";

test("real matrix selects all default scenarios across the nine directions offline", () => {
  const cases = selectMatrixCases(buildPlan(), parseArgs([]));
  assert.equal(cases.length, 36);
  for (const scenario of ["basic", "stream", "tool", "reasoning"]) {
    const selected = cases.filter(entry => entry.scenario === scenario);
    assert.equal(selected.length, 9, scenario);
    assert.equal(new Set(selected.map(entry => `${entry.source}->${entry.target}`)).size, 9, scenario);
  }
});

test("real matrix skips unverified Grok reasoning without losing basic, stream or tools", () => {
  const plan = buildPlan();
  const cases = selectMatrixCases(plan, parseArgs(["--model=grok-4.6"]));
  assert.equal(cases.length, 9);
  assert.deepEqual(new Set(cases.map(entry => entry.scenario)), new Set(["basic", "stream", "tool"]));
  assert.ok(cases.every(entry => entry.target === "chat/completions"));
  assert.deepEqual(selectMatrixCases(plan, parseArgs(["--model=grok-4.6", "--scenario=reasoning"])), []);
  const reasoning = selectMatrixCases(plan, parseArgs(["--model=deepseek-v4", "--scenario=reasoning"]));
  assert.equal(reasoning.length, 3);
  assert.ok(reasoning.every(entry => entry.target === "chat/completions"));
});
