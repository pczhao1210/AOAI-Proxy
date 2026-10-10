import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import toast from "react-hot-toast";
import { resetModelStats } from "../admin-ui/src/api.js";
import { formatBillingTier, formatCacheHitRatio, formatDateTime, formatRuntimeNumber, formatTokenCountK, formatTokenSummary, getModelBillingRows } from "../admin-ui/src/utils.js";

let dom;
let vite;
let React;
let testing;
let RuntimeTab;
let I18nProvider;
let useI18n;
const originals = new Map();
const fallback = (_key, value) => value;
const tokens = {
  promptTokens: 1000, cachedTokens: 250, completionTokens: 100, totalTokens: 1100,
  cacheWrite: { requests: 1, tokens: 50 },
  estimatedCostAmount: 0.75, estimatedCostCurrency: "USD"
};
const tier = (lower, upper) => ({ kind: "tier", promptTokensAtLeast: lower, promptTokensBelow: upper });
const row = (actualModelId, billingTier, extra = {}) => ({ ...tokens, actualModelId, tier: billingTier, requests: 1, ...extra });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

before(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/admin/", pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLDetailsElement", "Node", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] });
  }
  React = await import("react");
  testing = await import("@testing-library/react/pure.js");
  vite = await createServer({
    configFile: fileURLToPath(new URL("../admin-ui/vite.config.js", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { dedupe: ["react", "react-dom"] },
    server: { middlewareMode: true, watch: null, ws: false },
    appType: "custom"
  });
  ({ default: RuntimeTab } = await vite.ssrLoadModule("/admin-ui/src/components/RuntimeTab.jsx"));
  ({ I18nProvider, useI18n } = await vite.ssrLoadModule("/admin-ui/src/i18n.jsx"));
});

afterEach(async () => {
  await testing.act(async () => {
    toast.remove();
    testing.cleanup();
  });
  window.history.replaceState(null, "", "/admin/");
  window.localStorage.clear();
});

after(async () => {
  await vite?.close();
  dom?.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function runtimeProps(overrides = {}) {
  return {
    persistenceRuntime: {}, loggingRuntime: {}, runtimeStore: {},
    governanceKeys: [], perKeyStats: {}, modelStats: {},
    analytics: {}, recentSignals: {}, runtimeFilters: {}, runtimeKeyOptions: [],
    formatDateTime: value => value, t: fallback,
    ...overrides
  };
}

function renderRuntime(overrides = {}) {
  const view = testing.render(React.createElement(RuntimeTab, runtimeProps(overrides)));
  view.container.querySelector("#runtime-models").open = true;
  return view;
}

test("overview separates scoped metrics, dated buckets and unfiltered system health", () => {
  const view = renderRuntime({
    totals: { ...tokens, requests: 12, errors: 2 },
    snapshotFilters: { keyId: "key", timeRange: "24h" },
    runtimeFilters: { keyId: "key", timeRange: "24h" },
    persistenceRuntime: { databaseAccessState: "ready" },
    analytics: { rollups: { hourly: [{ ...tokens, bucketStart: "2026-01-01T00:00:00.000Z" }] } }
  });
  const overview = view.container.querySelector("#runtime-overview");
  const metrics = overview.querySelector(".runtime-metrics");
  assert.deepEqual([...metrics.querySelectorAll(".stat-label")].map(label => label.textContent), [
    "Requests", "Errors", "Reference Cost", "Input Total (Including Cache)", "Output Tokens", "Cache Hit Ratio"
  ]);
  assert.ok(testing.within(metrics).getByText("1 K"));
  assert.ok(testing.within(metrics).getByText("0.1 K"));
  assert.equal(metrics.querySelector(".stat-note").textContent, "Cost estimates may be incomplete.");
  assert.match(overview.querySelector(".runtime-periods").textContent, /2026-01-01T00:00:00.000Z/);
  assert.ok(overview.querySelector(".runtime-health-grid"));
  assert.equal(overview.querySelector(".runtime-sync-details").open, false);
});

test("disabled Log Analytics upload hides historical counters without hiding the statistics event queue", () => {
  for (const loggingRuntime of [
    { logAnalyticsEnabled: false, logAnalyticsConfigured: false },
    { logAnalyticsEnabled: false, logAnalyticsConfigured: true, enabled: true, configured: true },
    { enabled: false, configured: false },
    {}
  ]) {
    const view = renderRuntime({
      loggingRuntime: { ...loggingRuntime, queueLength: 0, queueBytes: 0, droppedEntries: 73, flushFailures: 91 },
      runtimeStore: { queueLength: 12 }
    });
    const card = view.getByText("Log Analytics Upload").closest("div");
    assert.equal(card.querySelector("dd").textContent, "Disabled");
    assert.equal(card.querySelector("small"), null);
    assert.equal(card.textContent.includes("73"), false);
    assert.equal(card.textContent.includes("91"), false);
    assert.equal(view.getByText("Event Queue").closest("div").querySelector("dd").textContent, "12");
    view.unmount();
  }
});

test("enabled Log Analytics upload retains queue, drops and failures for configured and incomplete states", () => {
  for (const loggingRuntime of [
    { logAnalyticsEnabled: true, logAnalyticsConfigured: true },
    { logAnalyticsEnabled: true, logAnalyticsConfigured: false },
    { enabled: true, configured: true }
  ]) {
    const noteCalls = [];
    const view = renderRuntime({
      loggingRuntime: { ...loggingRuntime, queueLength: 2, queueBytes: 100, droppedEntries: 3, flushFailures: 4 },
      t: (key, value, params) => {
        if (key === "runtime.logSinkNote") noteCalls.push(params);
        return value;
      }
    });
    const card = view.getByText("Log Analytics Upload").closest("div");
    assert.equal(card.querySelector("dd").textContent,
      (loggingRuntime.logAnalyticsConfigured ?? loggingRuntime.configured) ? "configured" : "incomplete");
    assert.ok(card.querySelector("small"));
    assert.match(card.querySelector("small").textContent, /Queue.*Drops.*Failures/);
    assert.deepEqual(noteCalls, [{ count: 2, bytes: 100, drops: 3, failures: 4 }]);
    view.unmount();
  }
});

test("overview keeps aligned filters below its heading and timestamp out of the filter row", () => {
  const changes = [];
  let syncs = 0;
  const view = renderRuntime({
    statsUpdatedAt: "2026-10-10T03:23:53.555Z",
    runtimeKeyOptions: [{ value: "key", label: "Example Key" }],
    onRuntimeFilterChange: patch => changes.push(patch),
    onSyncRuntime: () => { syncs += 1; }
  });
  const overview = view.container.querySelector("#runtime-overview");
  assert.equal(overview.querySelector(".panel-head .runtime-filter-toolbar"), null);
  const toolbar = overview.querySelector(".section-body > .runtime-filter-toolbar");
  assert.ok(toolbar);
  assert.match(overview.querySelector(".panel-head").textContent, /Updated: 2026-10-10T03:23:53.555Z/);
  assert.equal(toolbar.textContent.includes("Updated:"), false);
  assert.deepEqual([...toolbar.querySelectorAll(".field-label")].map(label => label.textContent), ["Key", "Time Range"]);
  testing.fireEvent.change(view.getByLabelText("Key"), { target: { value: "key" } });
  testing.fireEvent.change(view.getByLabelText("Time Range"), { target: { value: "7d" } });
  testing.fireEvent.click(view.getByRole("button", { name: "Sync Now" }));
  assert.deepEqual(changes, [{ keyId: "key" }, { timeRange: "7d" }]);
  assert.equal(syncs, 1);
  view.rerender(React.createElement(RuntimeTab, runtimeProps({ runtimeSyncBusy: true })));
  assert.equal(view.getByRole("button", { name: "Syncing..." }).disabled, true);
});

test("runtime numbers retain exact small rates and large integer token counters", () => {
  assert.equal(formatRuntimeNumber(123456789), "123,456,789");
  assert.equal(formatRuntimeNumber(0.0028), "0.0028");
  assert.equal(formatRuntimeNumber(0), "0");
  for (const value of [undefined, null, NaN, Infinity, -1, "100"]) assert.equal(formatRuntimeNumber(value), "—");
});

test("input and output K formatting preserves single-token precision and never rounds missing counts to zero", () => {
  for (const [value, expected] of [
    [0, "0 K"], [1, "0.001 K"], [10, "0.01 K"], [999, "0.999 K"],
    [1000, "1 K"], [1001, "1.001 K"], [272001, "272.001 K"], [12458632, "12,458.632 K"],
    [Number.MAX_SAFE_INTEGER, "9,007,199,254,740.991 K"]
  ]) assert.equal(formatTokenCountK(value), expected);
  for (const value of [undefined, null, NaN, Infinity, -1, 0.5, "1000", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatTokenCountK(value), "—");
  }
});

test("tiered cards expose flat history without fabricating short tiers and require explicit price repair", async () => {
  const definition = { id: "gpt-6-astra", pricing: {
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [{ id: "short <=272K", promptTokensBelow: 272001, inputPer1mTokens: 10 },
      { id: "long >272K", promptTokensAtLeast: 272001, inputPer1mTokens: 20 }]
  } };
  let repairs = 0;
  const view = renderRuntime({
    pricingLibrary: [definition],
    config: { models: [{ id: "gpt-6-astra", pricing: { inputPer1mTokens: 10 } }] },
    modelStats: { "gpt-6-astra": { ...tokens, billingTiers: [row("gpt-6-astra", { kind: "flat" })] } },
    onApplyCardPricing: ids => { repairs += 1; assert.deepEqual(ids, ["gpt-6-astra"]); }
  });
  assert.equal(repairs, 0);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand gpt-6-astra" }));
  assert.equal(view.container.querySelector(".model-breakdown tbody tr").children[1].textContent, "Historical non-tiered");
  assert.equal(view.container.querySelector(".model-tier-label").textContent, "Tiered billing");
  assert.equal(view.container.querySelector(".model-cell").textContent.includes("short"), false);
  testing.fireEvent.click(view.getByRole("button", { name: "Review tier pricing" }));
  const dialog = testing.within(view.getByRole("dialog"));
  assert.match(dialog.getByText(/Replaces model-level prices/).textContent, /Save configuration/);
  testing.fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  assert.equal(repairs, 0);
  testing.fireEvent.click(view.getByRole("button", { name: "Review tier pricing" }));
  await testing.act(async () => testing.fireEvent.click(view.getByRole("button", { name: "Apply card prices to draft" })));
  assert.equal(repairs, 1);
  assert.equal(view.queryByRole("dialog"), null);
});

test("collapsed models show only a tiered marker while expansion preserves recorded tier statistics", () => {
  const definition = { id: "tiered", pricing: {
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [{ id: "short <=272K", promptTokensBelow: 272001, inputPer1mTokens: 1 },
      { id: "long >272K", promptTokensAtLeast: 272001, inputPer1mTokens: 2 }]
  } };
  const modelStats = {
    "public-model": { ...tokens, billingTiers: [
      row("tiered", { ...tier(0, 272001), id: "short <=272K" }),
      row("tiered", { ...tier(272001, null), id: "long >272K" }, { promptTokens: 272001, completionTokens: 1 })
    ] },
    flat: { ...tokens, billingTiers: [row("flat", { kind: "flat" })] }
  };
  const before = structuredClone(modelStats);
  const view = renderRuntime({
    pricingLibrary: [definition],
    config: { models: [{ id: "public-model", targetModel: "tiered" }] },
    modelStats
  });
  assert.equal(view.container.querySelectorAll(".model-tier-label").length, 1);
  assert.equal(view.container.querySelector(".model-tier-label").textContent, "Tiered billing");
  assert.equal(view.container.querySelector(".model-breakdown"), null);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand public-model" }));
  const rows = view.container.querySelectorAll(".model-breakdown tbody tr");
  assert.equal(rows[0].children[1].textContent, "short <=272K");
  assert.equal(rows[1].children[1].textContent, "long >272K");
  assert.equal(rows[1].children[3].textContent, "272.001 K");
  assert.equal(rows[1].children[3].querySelector("span").title, "272,001 tokens");
  assert.equal(rows[1].children[6].textContent, "0.001 K");
  assert.deepEqual(modelStats, before);
  assert.match(formatTokenSummary(tokens), /Input Total \(Including Cache\) 1 K.*Output Tokens 0.1 K/);
});

test("GPT-6.1 Sol card updates explain unrecorded tiers without reclassifying historical usage", () => {
  const definition = JSON.parse(readFileSync(new URL("../pricing/gpt-6.1-sol.json", import.meta.url), "utf8"));
  const modelStats = {
    "gpt-6.1-sol": { ...tokens, billingTiers: [row("gpt-6.1-sol", { kind: "unknown" }, { requests: null })] }
  };
  const before = structuredClone(modelStats);
  const view = renderRuntime({
    pricingLibrary: [definition],
    config: { models: [{ id: definition.id }] },
    modelStats
  });
  assert.equal(view.container.querySelector(".model-tier-label").textContent, "Tiered billing");
  testing.fireEvent.click(view.getByRole("button", { name: "Expand gpt-6.1-sol" }));
  const unknown = view.getByText("Tier not recorded");
  assert.match(unknown.title, /pricing was unavailable or disabled.*historical/);
  assert.equal(unknown.closest("tr").children[2].textContent, "—");
  assert.deepEqual(modelStats, before);
});

test("billing breakdown aligns labels and numbers separately and allows headers and long labels to wrap", context => {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../admin-ui/src/styles.css", import.meta.url), "utf8");
  document.head.append(style);
  context.after(() => style.remove());
  const actualModelId = "a-very-long-provider-deployment-name-without-short-aliases";
  const id = "a-long-custom-billing-tier-name <=272K";
  const view = renderRuntime({ modelStats: {
    model: { ...tokens, billingTiers: [row(actualModelId, { ...tier(0, 272001), id })] }
  } });
  testing.fireEvent.click(view.getByRole("button", { name: "Expand model" }));
  const breakdown = view.container.querySelector(".model-breakdown");
  assert.equal(window.getComputedStyle(breakdown).textAlign, "left");
  for (const header of breakdown.querySelectorAll("th")) {
    assert.equal(window.getComputedStyle(header).whiteSpace, "normal");
  }
  const cells = breakdown.querySelectorAll("tbody tr > td");
  for (const cell of [...cells].slice(0, 2)) {
    const computed = window.getComputedStyle(cell);
    assert.equal(computed.textAlign, "left");
    assert.equal(computed.whiteSpace, "normal");
    assert.equal(computed.overflowWrap, "anywhere");
    assert.ok(cell.querySelector(".model-billing-label"));
  }
  for (const cell of [...cells].slice(2)) {
    const computed = window.getComputedStyle(cell);
    assert.equal(computed.textAlign, "right");
    assert.equal(computed.whiteSpace, "nowrap");
  }
  assert.equal(cells[0].textContent, actualModelId);
  assert.equal(cells[1].textContent, id);
});

test("cache hit ratio uses aggregate recorded input including cache without inventing coverage", () => {
  assert.equal(formatCacheHitRatio({ promptTokens: 1000, cachedTokens: 250 }), "25.0%");
  assert.equal(formatCacheHitRatio({ promptTokens: 3, cachedTokens: 1 }), "33.3%");
  assert.equal(formatCacheHitRatio({ promptTokens: 10, cachedTokens: 0 }), "0.0%");
  assert.equal(formatCacheHitRatio({ promptTokens: 10, cachedTokens: 10 }), "100.0%");
  // 5/10 and 9/90 aggregate to 14%, not the 30% mean of request ratios.
  assert.equal(formatCacheHitRatio({ promptTokens: 100, cachedTokens: 14 }), "14.0%");
  for (const value of [null, undefined, NaN, Infinity, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(formatCacheHitRatio({ promptTokens: value, cachedTokens: 0 }), "—");
    assert.equal(formatCacheHitRatio({ promptTokens: 100, cachedTokens: value }), "—");
  }
  for (const value of [{}, { promptTokens: 0, cachedTokens: 0 }, { promptTokens: 1, cachedTokens: 2 }]) {
    assert.equal(formatCacheHitRatio(value), "—");
  }
});

test("billing tier labels preserve integer inclusivity and arbitrary intervals without rounding", () => {
  assert.equal(formatBillingTier({ ...tier(0, 272001), id: "short <=272K" }), "short <=272K");
  assert.equal(formatBillingTier({ ...tier(200000, null), id: "long >=200K" }), "long >=200K");
  assert.equal(formatBillingTier({ ...tier(null, null), id: "custom tier" }), "custom tier");
  for (const [bounds, label] of [
    [[0, 272001], "≤272K"], [[272001, null], ">272K"],
    [[0, 200000], "<200K"], [[200000, null], "≥200K"],
    [[200000, 272001], "≥200K · ≤272K"],
    [[12345, 98765], "≥12345 · <98765"],
    [[272002, 500001], "≥272002 · ≤500K"],
    [[0, 1], "<1"], [[1, 2], "≥1 · <2"],
    [[0, null], "≥0"], [[null, 100], "<100"]
  ]) assert.equal(formatBillingTier(tier(...bounds)), label);
  assert.equal(formatBillingTier({ kind: "flat" }), "Not tiered");
  assert.equal(formatBillingTier({ kind: "unknown" }), "Tier not recorded");
  for (const invalid of [undefined, tier(null, null), tier(3, 3), tier(-1, 3), tier(0, 1.5), tier("0", 10)]) {
    assert.equal(formatBillingTier(invalid), "Tier not recorded");
  }
});

test("billing rows preserve recorded tiers and settlement counts and sort unknown last per actual model", () => {
  const billingTiers = [
    row("z", { kind: "flat" }),
    row("a", { kind: "unknown" }, { requests: null }),
    row("a", tier(272001, null)),
    row("a", tier(0, 272001), { requests: 0 })
  ];
  const stats = { ...tokens, billingTiers, actualModels: { ignored: tokens } };
  const before = structuredClone(stats);
  const rows = getModelBillingRows("router", stats);
  assert.deepEqual(rows.map(item => [item.actualModelId, formatBillingTier(item.tier), item.requests]), [
    ["a", "≤272K", 0], ["a", ">272K", 1], ["a", "Tier not recorded", null], ["z", "Not tiered", 1]
  ]);
  assert.deepEqual(stats, before);
  for (const legacy of [
    { ...tokens, requests: 5, errors: 1 },
    { actualModels: { model: { ...tokens, requests: 4 } } },
    { ...tokens, billingTiers: [] }
  ]) {
    const [entry] = getModelBillingRows("model", legacy);
    assert.equal(entry.actualModelId, "model");
    assert.equal(entry.requests, null);
    assert.equal(formatBillingTier(entry.tier), "Tier not recorded");
    assert.equal(entry.promptTokens, 1000);
  }
});

test("model rows and horizontal tier breakdown expose four token counters, ratio, and only final cost", () => {
  const view = renderRuntime({
    modelStats: {
      "model-router": {
        ...tokens, requests: 8, errors: 2,
        billingTiers: [
          row("grok", tier(200000, null)),
          row("gpt", { kind: "unknown" }, { requests: null, textUnknownCostRequests: 1 }),
          row("gpt", { ...tier(272001, null), id: "long >272K" }),
          row("gpt", { ...tier(0, 272001), id: "short <=272K" }, { requests: 3 }),
          row("grok", tier(0, 200000))
        ]
      },
      direct: { ...tokens, requests: 1, errors: 0, billingTiers: [row("direct", { kind: "flat" })] }
    }
  });
  const modelSection = view.container.querySelector("#runtime-models");
  const mainRow = modelSection.querySelector("tbody tr");
  assert.deepEqual([...mainRow.children].slice(1).map(cell => cell.textContent), [
    "8", "2", "1 K", "250", "50", "0.1 K", "25.0%", "0.7500 USD"
  ]);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand model-router" }));
  const breakdown = modelSection.querySelector(".model-breakdown");
  assert.deepEqual([...breakdown.querySelectorAll("th")].map(th => th.textContent), [
    "Actual Model", "Billing Tier", "Settled Requests", "Input Total (Including Cache)",
    "Cache Read Tokens", "Cache Write Tokens", "Output Tokens", "Cache Hit Ratio", "Reference Cost"
  ]);
  assert.deepEqual([...breakdown.querySelectorAll(":scope table > tbody > tr")].map(tr => [...tr.children].slice(0, 3).map(td => td.textContent)), [
    ["gpt", "short <=272K", "3"], ["gpt", "long >272K", "1"], ["gpt", "Tier not recorded", "—"],
    ["grok", "<200K", "1"], ["grok", "≥200K", "1"]
  ]);
  assert.equal(breakdown.querySelectorAll(":scope table > tbody > tr")[2].lastElementChild.textContent, "0.7500 USD");
  for (const label of ["Total Tokens", "Cache Write Cost", "Model Router Cost", "Actual Model Cost"]) {
    assert.equal(modelSection.textContent.includes(label), false);
  }
  const help = testing.within(breakdown).getByRole("columnheader", { name: "Cache Hit Ratio" }).title;
  assert.match(help, /do not add them again/);
  assert.match(help, /Legacy missing cache reads may already be recorded as 0/);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand direct" }));
  assert.ok(view.getByText("Not tiered"));
  assert.equal(modelSection.querySelectorAll(".model-breakdown .field-hint").length, 0);
  assert.match(modelSection.querySelector(".accordion-copy p").textContent, /incomplete.*reference.*Azure/);
});

test("legacy model expansion stays unclassified and does not infer tiers or settled requests", () => {
  const view = renderRuntime({ modelStats: {
    historical: { ...tokens, requests: 50, errors: 5, actualModels: { legacy: { ...tokens, promptTokens: 9999999, requests: 45 } } },
    "legacy-direct": { ...tokens, requests: 9, errors: 1 }
  } });
  for (const model of ["historical", "legacy-direct"]) {
    testing.fireEvent.click(view.getByRole("button", { name: `Expand ${model}` }));
  }
  const rows = view.container.querySelectorAll(".model-breakdown tbody tr");
  assert.equal(rows.length, 2);
  for (const entry of rows) {
    assert.equal(entry.children[1].textContent, "Tier not recorded");
    assert.equal(entry.children[2].textContent, "—");
  }
});

test("reset confirmation ignores active filters, cancels without requests, and disables duplicates until refresh", async () => {
  const pending = deferred();
  let resets = 0;
  const view = renderRuntime({
    runtimeFilters: { keyId: "filtered-key", timeRange: "24h" },
    onResetModelStats: () => { resets += 1; return pending.promise; }
  });
  testing.fireEvent.click(view.getByRole("button", { name: "Reset all model stats" }));
  let dialog = testing.within(view.getByRole("dialog"));
  assert.match(dialog.getByText(/Active Key and time filters/).textContent, /always affects all models/);
  assert.match(dialog.getByText(/Request logs, Key statistics/).textContent, /governance quotas, and global totals are retained/);
  assert.match(dialog.getByText(/Request logs, Key statistics/).textContent, /database mode this reset is persisted/);
  testing.fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  assert.equal(resets, 0);
  assert.equal(view.queryByRole("dialog"), null);
  testing.fireEvent.click(view.getByRole("button", { name: "Reset all model stats" }));
  dialog = testing.within(view.getByRole("dialog"));
  const confirm = dialog.getByRole("button", { name: "Reset all models" });
  testing.fireEvent.click(confirm);
  testing.fireEvent.click(confirm);
  assert.equal(resets, 1);
  assert.equal(confirm.disabled, true);
  assert.equal(view.container.querySelector("#runtime-models .toolbar button").disabled, true);
  testing.fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  assert.ok(view.getByRole("dialog"));
  await testing.act(async () => pending.resolve());
  assert.equal(view.queryByRole("dialog"), null);
  assert.match(view.getByRole("status").textContent, /All model statistics have been reset/);
  assert.equal(view.getByRole("button", { name: "Reset all model stats" }).disabled, false);
});

test("reset failures are explicit and restore the action", async () => {
  const view = renderRuntime({ onResetModelStats: async () => { throw new Error("Database unavailable"); } });
  testing.fireEvent.click(view.getByRole("button", { name: "Reset all model stats" }));
  await testing.act(async () => testing.fireEvent.click(view.getByRole("button", { name: "Reset all models" })));
  assert.match(view.getByRole("alert").textContent, /Database unavailable/);
  assert.equal(view.queryByRole("status"), null);
  assert.equal(view.getByRole("button", { name: "Reset all model stats" }).disabled, false);
});

test("model stats reset API uses POST, custom admin paths and CSRF without filter parameters", async context => {
  const timestamp = "2026-09-23T04:00:00.000Z";
  const fetchMock = context.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, modelsResetAt: timestamp }));
  for (const path of ["/admin/", "/private-console/"]) {
    window.history.replaceState(null, "", path);
    assert.deepEqual(await resetModelStats(), { ok: true, modelsResetAt: timestamp });
    const [url, options] = fetchMock.mock.calls.at(-1).arguments;
    assert.equal(url, `${path}api/stats/models/reset`);
    assert.equal(options.method, "POST");
    assert.equal(options.headers["x-aoai-admin-csrf"], "1");
    assert.equal(options.body, undefined);
  }
  fetchMock.mock.mockImplementation(async () => Response.json({ error: { message: "Reset rejected" } }, { status: 503 }));
  await assert.rejects(resetModelStats(), error => error.message === "Reset rejected" && error.status === 503);
});

test("Chinese runtime labels, tier statuses, reset explanation and timestamp are localized", () => {
  function LocalizedRuntime() {
    const { t, setLanguage } = useI18n();
    return React.createElement(React.Fragment, null,
      React.createElement("button", { onClick: () => setLanguage("zh-CN") }, "中文"),
      React.createElement(RuntimeTab, runtimeProps({
        t, onResetModelStats: async () => {},
        loggingRuntime: { logAnalyticsEnabled: false, droppedEntries: 73, flushFailures: 91 },
        modelsResetAt: "2026-09-23T04:00:00.000Z",
        modelStats: { model: { ...tokens, billingTiers: [row("model", { kind: "flat" }), row("model", { kind: "unknown" }, { requests: null })] } }
      }))
    );
  }
  const view = testing.render(React.createElement(I18nProvider, null, React.createElement(LocalizedRuntime)));
  testing.fireEvent.click(view.getByRole("button", { name: "中文" }));
  view.container.querySelector("#runtime-models").open = true;
  testing.fireEvent.click(view.getByRole("button", { name: "展开 model" }));
  assert.ok(view.getByText("不分档"));
  assert.ok(view.getByText("未记录档位"));
  assert.ok(view.getByText("模型统计清空时间: 2026-09-23T04:00:00.000Z"));
  assert.ok(view.getByText("费用估算可能不完整"));
  const uploadCard = view.getByText("Log Analytics 上传").closest("div");
  assert.equal(uploadCard.querySelector("dd").textContent, "未启用");
  assert.equal(uploadCard.querySelector("small"), null);
  for (const label of ["输入总量（含缓存）", "缓存命中率", "计费档位", "已结算请求"]) {
    assert.ok(view.getAllByRole("columnheader", { name: label }).length);
  }
  testing.fireEvent.click(view.getByRole("button", { name: "清空模型统计" }));
  const dialog = testing.within(view.getByRole("dialog"));
  assert.match(dialog.getByText(/当前 Key 和时间筛选/).textContent, /始终清空全部模型/);
  assert.ok(dialog.getByText(/请求日志、Key 统计、治理配额和全局总计均保留/));
});

test("App reset refreshes with latest filters and fences pre-reset responses while retaining global totals", async context => {
  const { default: App } = await vite.ssrLoadModule("/admin-ui/src/App.jsx");
  const stale = deferred();
  const refreshed = deferred();
  const timestamp = "2026-09-23T04:00:00.000Z";
  const originalStats = {
    totals: { ...tokens, requests: 99 }, perModel: { "old-model": { ...tokens, requests: 5 } },
    perKey: { key: tokens }, governance: { keys: [{ keyId: "key" }] }
  };
  let statsCalls = 0;
  let resets = 0;
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname.endsWith("/stats/models/reset")) {
      resets += 1;
      assert.equal(options.method, "POST");
      return Response.json({ ok: true, modelsResetAt: timestamp });
    }
    if (parsed.pathname.endsWith("/stats")) {
      statsCalls += 1;
      if (statsCalls === 1) return Response.json(originalStats);
      if (statsCalls === 2) return stale.promise;
      assert.equal(parsed.searchParams.get("timeRange"), "24h");
      return refreshed.promise;
    }
    if (parsed.pathname.endsWith("/pricing-library")) return Response.json({ items: [{ id: "unused" }] });
    if (parsed.pathname.endsWith("/runtime")) return Response.json({ runtime: {} });
    if (parsed.pathname.endsWith("/caddy/status")) return Response.json({ status: {} });
    if (parsed.pathname.endsWith("/config")) return Response.json({});
    throw new Error(`Unexpected request ${url}`);
  });

  const view = testing.render(React.createElement(I18nProvider, null, React.createElement(App)));
  await testing.waitFor(() => assert.ok(view.container.querySelector(".left-nav")));
  testing.fireEvent.click(view.getByRole("button", { name: "Runtime" }));
  await testing.waitFor(() => assert.ok(view.container.querySelector("#runtime-models")));
  view.container.querySelector("#runtime-models").open = true;
  assert.ok(view.getByText("old-model"));
  testing.fireEvent.change(view.getByLabelText("Time Range"), { target: { value: "24h" } });
  assert.equal(statsCalls, 2);
  testing.fireEvent.click(view.getByRole("button", { name: "Reset all model stats" }));
  testing.fireEvent.click(view.getByRole("button", { name: "Reset all models" }));
  await testing.waitFor(() => assert.equal(statsCalls, 3));
  assert.equal(view.queryByText("old-model"), null);
  assert.equal(resets, 1);
  await testing.act(async () => refreshed.resolve(Response.json({ ...originalStats, perModel: {}, modelsResetAt: timestamp })));
  assert.match(view.getByRole("status").textContent, /All model statistics have been reset/);
  await testing.act(async () => stale.resolve(Response.json(originalStats)));
  assert.equal(view.queryByText("old-model"), null);
  assert.ok(view.getByText(`Model stats reset at: ${formatDateTime(timestamp)}`));
  const summary = view.container.querySelector(".status-strip");
  assert.ok(testing.within(summary).getByText("99"));
  assert.match(summary.textContent, /Cost estimates may be incomplete\./);
  assert.equal(summary.textContent.includes("Azure"), false);
  assert.equal(summary.textContent.includes("Input Total (Including Cache)"), false);
  assert.equal(summary.textContent.includes("Cache Write Cost"), false);
  const mutation = fetchMock.mock.calls.find(call => String(call.arguments[0]).endsWith("/stats/models/reset"));
  assert.equal(mutation.arguments[1].headers["x-aoai-admin-csrf"], "1");
});

test("App tier repair stays in the draft until reviewed save and preserves shared prices and historical tiers", async context => {
  const { default: App } = await vite.ssrLoadModule("/admin-ui/src/App.jsx");
  const pricing = {
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [{ id: "short", promptTokensBelow: 101, inputPer1mTokens: 1, cachedInputPer1mTokens: 0, cacheWritePer1mTokens: 1.25, outputPer1mTokens: 2 },
      { id: "long", promptTokensAtLeast: 101, inputPer1mTokens: 2, cachedInputPer1mTokens: 0, cacheWritePer1mTokens: 2.5, outputPer1mTokens: 3 }]
  };
  const original = {
    models: [{ id: "public-model", targetModel: "tiered", pricingRef: "shared", upstream: "mock",
      pricing: { inputPer1mTokens: 7 }, routes: { "*": "responses" }, defaultParams: { temperature: 0 } }],
    upstreams: [{ name: "mock", baseUrl: "http://localhost" }],
    access: { pricingCatalog: { shared: { inputPer1mTokens: 9 } } }
  };
  let saved;
  context.mock.method(window, "confirm", () => true);
  const fetchMock = context.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path.endsWith("/config")) {
      if (options.method === "PUT") {
        saved = JSON.parse(options.body);
        assert.equal(options.headers["x-aoai-admin-csrf"], "1");
        return Response.json({ config: saved });
      }
      return Response.json(original);
    }
    if (path.endsWith("/pricing-library")) return Response.json({ items: [{ id: "tiered", pricing }] });
    if (path.endsWith("/stats")) return Response.json({
      totals: tokens, perModel: { "public-model": { ...tokens, billingTiers: [row("tiered", { kind: "flat" })] } }
    });
    if (path.endsWith("/runtime")) return Response.json({ runtime: {} });
    if (path.endsWith("/caddy/status")) return Response.json({ status: {} });
    throw new Error(`Unexpected request ${url}`);
  });
  const view = testing.render(React.createElement(I18nProvider, null, React.createElement(App)));
  await testing.waitFor(() => assert.ok(view.container.querySelector(".left-nav")));
  testing.fireEvent.click(view.getByRole("button", { name: "Runtime" }));
  await testing.waitFor(() => assert.ok(view.container.querySelector("#runtime-models")));
  view.container.querySelector("#runtime-models").open = true;
  testing.fireEvent.click(view.getByRole("button", { name: "Review tier pricing" }));
  testing.fireEvent.click(view.getByRole("button", { name: "Apply card prices to draft" }));
  assert.equal(saved, undefined);
  await testing.waitFor(() => assert.match(testing.within(view.container.querySelector("#runtime-models")).getByRole("status").textContent, /applied to the draft/));
  testing.fireEvent.click(view.getByRole("button", { name: "Review & Save" }));
  testing.fireEvent.click(testing.within(view.getByRole("dialog")).getByRole("button", { name: "Save", exact: true }));
  await testing.waitFor(() => assert.ok(saved));
  assert.deepEqual(saved.models[0].pricing, pricing);
  assert.deepEqual(saved.access, original.access);
  assert.deepEqual(saved.models[0].routes, original.models[0].routes);
  assert.deepEqual(saved.models[0].defaultParams, { temperature: 0 });
  assert.equal(fetchMock.mock.calls.filter(call => call.arguments[1]?.method === "PUT").length, 1);
  await testing.waitFor(() => assert.ok(testing.within(view.container.querySelector(".status-strip")).getByText("Synced")));
});

test("App allows reviewed canonical cleanup without editing unrelated settings", async context => {
  const { default: App } = await vite.ssrLoadModule("/admin-ui/src/App.jsx");
  const canonical = { models: [], upstreams: [], persistence: { compatibilityExport: { enabled: false } } };
  const deprecatedFlags = [{
    path: "persistence.compatibilityExport.exportLegacyConfigOnChange",
    replacement: "persistence.compatibilityExport.enabled", kind: "migrated"
  }];
  let saved = false;
  context.mock.method(window, "confirm", () => true);
  context.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path.endsWith("/config")) {
      if (options.method === "PUT") {
        assert.deepEqual(JSON.parse(options.body), canonical);
        assert.equal(options.headers["x-aoai-admin-csrf"], "1");
        saved = true;
        return Response.json({ config: canonical });
      }
      return Response.json(canonical);
    }
    if (path.endsWith("/runtime")) return Response.json({ runtime: {
      configuration: { cleanupRequired: !saved, deprecatedFlags: saved ? [] : deprecatedFlags }
    } });
    if (path.endsWith("/stats")) return Response.json({});
    if (path.endsWith("/pricing-library")) return Response.json({ items: [{ id: "unused" }] });
    if (path.endsWith("/caddy/status")) return Response.json({ status: {} });
    throw new Error(`Unexpected request ${url}`);
  });
  const view = testing.render(React.createElement(I18nProvider, null, React.createElement(App)));
  await testing.waitFor(() => assert.ok(view.getByRole("button", { name: "Review & Save" })));
  const dock = testing.within(view.container.querySelector(".save-dock"));
  assert.ok(dock.getByText("Configuration cleanup pending"));
  assert.equal(dock.queryByRole("button", { name: "Discard" }), null);
  testing.fireEvent.click(dock.getByRole("button", { name: "Review & Save" }));
  const dialog = testing.within(view.getByRole("dialog"));
  assert.ok(dialog.getByText(/Existing disabled states are retained/));
  assert.ok(dialog.getByText(deprecatedFlags[0].path));
  assert.equal(saved, false);
  await testing.act(async () => testing.fireEvent.click(dialog.getByRole("button", { name: "Save", exact: true })));
  await testing.waitFor(() => assert.ok(testing.within(view.container.querySelector(".status-strip")).getByText("Synced")));
  assert.equal(view.container.querySelector(".save-dock"), null);
  assert.equal(saved, true);
});
