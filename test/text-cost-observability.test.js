import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getStats, normalizeCacheWrite, recordMediaUsage, recordRequest, recordUsage, summarizeCacheWrite } from "../src/stats.js";
import { formatEstimatedCost, formatBudgetCost, formatCacheWriteCost, formatCacheWriteTokens } from "../admin-ui/src/utils.js";

test("cache-write dimensions preserve zero, unknowns and known subtotals across every bucket without charging twice", () => {
  const stats = getStats();
  const original = structuredClone(stats);
  try {
    recordRequest("empty-cache", { keyId: "empty-cache" });
    assert.equal(stats.perModel["empty-cache"].cacheWrite.tokens, null);
    assert.equal(stats.perKey["empty-cache"].cacheWrite.estimatedCostAmount, null);
    assert.equal(stats.perKey["empty-cache"].cacheWrite.knownCostAmount, null);
    const before = structuredClone(stats.totals);
    const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 };
    for (const cacheWrite of [
      { tokens: 20, usageStatus: "observed", knownCostAmount: 0.125, estimatedCostAmount: 0.125, costStatus: "priced" },
      { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" },
      { tokens: 3, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "partial" },
      { tokens: null, usageStatus: "unknown", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown" },
      undefined
    ]) recordUsage("cache-model", usage, {
      keyId: "cache-key", actualModelName: "cache-actual-2026-09-01",
      cost: { amount: 1, pricing: {}, costStatus: "priced", cacheWrite }
    });
    for (const bucket of [stats.perModel["cache-model"], stats.perKey["cache-key"], stats.perModel["cache-model"].actualModels["cache-actual"]]) {
      assert.deepEqual(bucket.cacheWrite, summarizeCacheWrite({
        requests: 4, observedRequests: 3, pricedRequests: 2, partialCostRequests: 1,
        unreportedRequests: 1, observedTokens: 23, knownCostAmount: 0.125
      }));
      assert.equal(bucket.totalTokens, 160);
      assert.equal(bucket.promptTokens, 150);
      assert.equal(bucket.estimatedCostAmount, 5);
    }
    assert.equal(stats.totals.cacheWrite.requests - before.cacheWrite.requests, 4);
    assert.equal(stats.totals.cacheWrite.unreportedRequests - before.cacheWrite.unreportedRequests, 1);
    assert.equal(stats.totals.totalTokens - before.totalTokens, 160);
    assert.equal(stats.totals.estimatedCostAmount - before.estimatedCostAmount, 5);
    const beforeMedia = structuredClone(stats.totals.cacheWrite);
    recordUsage("cache-media", usage, { cost: { amount: 0 }, keyId: "cache-media" });
    recordMediaUsage("cache-media", { costStatus: "unknown" }, { keyId: "cache-media" });
    assert.deepEqual(stats.totals.cacheWrite, beforeMedia);
  } finally {
    Object.assign(stats, original);
  }
  assert.deepEqual(getStats(), original);
});

test("cache-write formatting distinguishes measured zero from absent, invalid and historical coverage", () => {
  const empty = summarizeCacheWrite();
  const zero = summarizeCacheWrite({ requests: 1, observedRequests: 1, pricedRequests: 1, observedTokens: 0, knownCostAmount: 0 });
  const historical = summarizeCacheWrite({ ...zero, unreportedRequests: null });
  assert.equal(formatCacheWriteTokens(), "Not reported");
  assert.equal(formatCacheWriteCost(empty), "Not reported");
  assert.equal(formatCacheWriteTokens(zero), "0");
  assert.equal(formatCacheWriteCost(zero), "0.0000 USD");
  assert.equal(historical.tokens, null);
  assert.equal(historical.estimatedCostAmount, null);
  assert.equal(formatCacheWriteTokens(historical), "0 + Unknown");
  assert.equal(formatCacheWriteCost(historical), "0.0000 USD + Unknown");
  const partial = summarizeCacheWrite({ requests: 1, observedRequests: 1, partialCostRequests: 1, observedTokens: 3, knownCostAmount: 0 });
  assert.equal(formatCacheWriteTokens(partial), "3");
  assert.equal(formatCacheWriteCost(partial), "0.0000 USD + Unknown");
  for (const tokens of [null, undefined, -1, 1.5, "0", NaN]) {
    const entry = normalizeCacheWrite({ tokens, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown", raw: "private" });
    assert.equal(entry.tokens, null);
    assert.equal(entry.usageStatus, "unknown");
    assert.equal(entry.raw, undefined);
    assert.equal(formatCacheWriteTokens(entry), "Unknown");
    assert.equal(formatCacheWriteCost(entry), "Unknown");
  }
});

test("text cost completeness reaches every stats bucket without discarding known subtotals", () => {
  const model = "text-completeness";
  const keyId = "text-completeness-key";
  const actualModelName = "actual-text-2026-09-01";
  const before = structuredClone(getStats().totals);
  const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
  for (const cost of [
    { amount: 0, estimatedCostAmount: null, costStatus: "unknown", pricing: { actual: null, router: null } },
    { amount: 0.25, estimatedCostAmount: null, costStatus: "partial", pricing: { actual: null, router: { source: "catalog" } } },
    { amount: 0.5, estimatedCostAmount: 0.5, costStatus: "priced", pricing: { actual: { source: "model" }, router: null } },
    { amount: 0, estimatedCostAmount: 0, costStatus: "priced", pricing: { actual: { source: "model" }, router: null } },
    { amount: 0.1 },
    { amount: 0, costStatus: "unknown" }
  ]) {
    recordUsage(model, usage, { keyId, actualModelName, cost });
  }
  const stats = getStats();
  for (const bucket of [stats.perModel[model], stats.perKey[keyId], stats.perModel[model].actualModels["actual-text"]]) {
    assert.equal(bucket.textUnknownCostRequests, 2);
    assert.equal(bucket.estimatedCostAmount, 0.85);
    assert.equal(bucket.totalTokens, 18);
  }
  assert.equal(stats.totals.textUnknownCostRequests - before.textUnknownCostRequests, 2);
  assert.equal(stats.totals.estimatedCostAmount - before.estimatedCostAmount, 0.85);
});

test("cost formatting never calls unknown text costs free and preserves legacy media output", () => {
  assert.equal(formatEstimatedCost({ estimatedCostAmount: 0 }), "0.0000 USD");
  assert.equal(formatEstimatedCost({ estimatedCostAmount: 0, textUnknownCostRequests: 1 }), "Unknown");
  assert.equal(formatEstimatedCost({ estimatedCostAmount: 0.25, textUnknownCostRequests: 2 }), "0.2500 USD + Unknown");
  assert.equal(formatEstimatedCost({ amount: 0.25, estimatedCostAmount: null, costStatus: "partial", pricing: {} }), "0.2500 USD + Unknown");
  assert.equal(formatEstimatedCost({ amount: 0, estimatedCostAmount: null, costStatus: "unknown", pricing: {} }), "Unknown");
  assert.equal(formatEstimatedCost({ amount: 0, estimatedCostAmount: 0, costStatus: "priced", pricing: {} }), "0.0000 USD");
  assert.equal(formatEstimatedCost({ estimatedCostAmount: 0, media: { unknownCostRequests: 1 } }), "0.0000 USD + Unknown");
  assert.equal(formatEstimatedCost({ estimatedCostAmount: 0.5, textUnknownCostRequests: 1, media: { unknownCostRequests: 1 } }), "0.5000 USD + Unknown");
  assert.equal(formatEstimatedCost({ textUnknownCostRequests: 1 }, () => "未知费用"), "未知费用");
});

test("budget formatting marks unknown text costs with or without a limit", () => {
  assert.equal(formatBudgetCost({ spentAmount: 0 }, {}), "0.0000 USD");
  assert.equal(formatBudgetCost({ spentAmount: 0 }, { limitAmount: 10 }), "0.0000 / 10.00 USD");
  assert.equal(formatBudgetCost({ spentAmount: 0, textUnknownCostRequests: 1 }, {}), "Unknown");
  assert.equal(formatBudgetCost({ spentAmount: 0, textUnknownCostRequests: 1 }, { limitAmount: 10 }), "Unknown / 10.00 USD");
  assert.equal(formatBudgetCost({ spentAmount: 0.25, textUnknownCostRequests: 1 }, { limitAmount: 10 }), "0.2500 USD + Unknown / 10.00 USD");
});

test("runtime views mark incomplete costs in trends, key budgets and actual-model breakdowns", async () => {
  const { JSDOM } = await import("jsdom");
  const { createServer } = await import("vite");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const originals = new Map();
  let vite;
  let cleanup;
  try {
    for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDetailsElement", "Node", "MutationObserver"]) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
    }
    const React = await import("react");
    const testing = await import("@testing-library/react/pure.js");
    cleanup = testing.cleanup;
    vite = await createServer({
      configFile: fileURLToPath(new URL("../admin-ui/vite.config.js", import.meta.url)),
      root: fileURLToPath(new URL("..", import.meta.url)),
      resolve: { dedupe: ["react", "react-dom"] },
      server: { middlewareMode: true, watch: null, ws: false },
      appType: "custom"
    });
    const { default: RuntimeTab } = await vite.ssrLoadModule("/admin-ui/src/components/RuntimeTab.jsx");
    const cacheWrite = summarizeCacheWrite({ requests: 2, observedRequests: 1, pricedRequests: 1, observedTokens: 20, knownCostAmount: 0.125 });
    const incomplete = { estimatedCostAmount: 0, textUnknownCostRequests: 1, cachedTokens: 7, cacheWrite };
    const bucket = { ...incomplete, bucketStart: "2026-09-01T00:00:00.000Z" };
    const view = testing.render(React.createElement(RuntimeTab, {
      persistenceRuntime: {}, loggingRuntime: {}, runtimeStore: {},
      governanceKeys: [{ keyId: "key", budget: { limitAmount: 10 }, runtime: {
        budgetWindow: { spentAmount: 0, textUnknownCostRequests: 1 }
      } }],
      perKeyStats: { key: incomplete },
      modelStats: {
        "model-router": { ...incomplete, actualModels: { actual: incomplete } },
        unreported: { cacheWrite: summarizeCacheWrite() },
        zero: { cacheWrite: summarizeCacheWrite({ requests: 1, observedRequests: 1, pricedRequests: 1, observedTokens: 0, knownCostAmount: 0 }) }
      },
      analytics: { rollups: { hourly: [bucket], daily: [bucket], weekly: [bucket] } },
      recentSignals: {}, runtimeFilters: {}, runtimeKeyOptions: [],
      formatDateTime: value => value, t: (_key, fallback) => fallback
    }));
    for (const section of view.container.querySelectorAll("details")) section.open = true;
    const overview = testing.within(view.container.querySelector("#runtime-overview"));
    assert.ok(overview.getByText("Unknown"));
    assert.ok(overview.getByText(/^Estimated Cost Unknown · Cache Write Tokens 20 \+ Unknown/));
    const trends = view.container.querySelectorAll("#runtime-analytics tbody tr");
    assert.equal(trends.length, 3);
    for (const row of trends) {
      assert.equal(row.lastElementChild.textContent, "Unknown");
      assert.equal(row.children[6].textContent, "7");
      assert.equal(row.children[7].textContent, "20 + Unknown");
      assert.equal(row.children[8].textContent, "0.1250 USD + Unknown");
    }
    for (const id of ["runtime-analytics", "runtime-models", "runtime-keys"]) {
      const section = view.container.querySelector(`#${id}`);
      for (const label of ["Cache Read Tokens", "Cache Write Tokens", "Cache Write Cost (included)"]) {
        assert.ok(testing.within(section).getAllByRole("columnheader", { name: label }).length);
      }
    }
    const keyCells = view.container.querySelector("#runtime-keys tbody tr").children;
    assert.equal(keyCells[6].textContent, "20 + Unknown");
    assert.equal(keyCells[7].textContent, "0.1250 USD + Unknown");
    assert.equal(keyCells[8].textContent, "Unknown");
    assert.equal(keyCells[11].textContent, "Unknown / 10.00 USD");
    const modelCells = view.container.querySelector("#runtime-models tbody tr").children;
    assert.equal(modelCells[5].textContent, "20 + Unknown");
    assert.equal(modelCells[6].textContent, "0.1250 USD + Unknown");
    assert.equal(modelCells[9].textContent, "Unknown");
    const zeroCells = view.getByText("zero").closest("tr").children;
    assert.equal(zeroCells[5].textContent, "0");
    assert.equal(zeroCells[6].textContent, "0.0000 USD");
    const unreportedCells = view.getByText("unreported").closest("tr").children;
    assert.equal(unreportedCells[5].textContent, "Not reported");
    assert.equal(unreportedCells[6].textContent, "Not reported");
    testing.fireEvent.click(view.getByRole("button", { name: "展开" }));
    const actualCells = view.container.querySelector(".model-breakdown tbody tr").children;
    assert.equal(actualCells[5].textContent, "20 + Unknown");
    assert.equal(actualCells[6].textContent, "0.1250 USD + Unknown");
    for (const index of [9, 10, 11]) assert.equal(actualCells[index].textContent, "Unknown");
  } finally {
    cleanup?.();
    await vite?.close();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
