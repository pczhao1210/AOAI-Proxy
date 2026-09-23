import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { resetModelStats } from "../admin-ui/src/api.js";
import { formatBillingTier, formatCacheHitRatio, formatDateTime, getModelBillingRows } from "../admin-ui/src/utils.js";

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

afterEach(() => {
  testing.cleanup();
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
  assert.equal(formatBillingTier({ kind: "flat" }), "Single rate");
  assert.equal(formatBillingTier({ kind: "unknown" }), "Unclassified");
  for (const invalid of [undefined, tier(null, null), tier(3, 3), tier(-1, 3), tier(0, 1.5), tier("0", 10)]) {
    assert.equal(formatBillingTier(invalid), "Unclassified");
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
    ["a", "≤272K", 0], ["a", ">272K", 1], ["a", "Unclassified", null], ["z", "Single rate", 1]
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
    assert.equal(formatBillingTier(entry.tier), "Unclassified");
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
    "8", "2", "1000", "250", "50", "100", "25.0%", "0.7500 USD"
  ]);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand model-router" }));
  const breakdown = modelSection.querySelector(".model-breakdown");
  assert.deepEqual([...breakdown.querySelectorAll("th")].map(th => th.textContent), [
    "Actual Model", "Billing Tier", "Settled Requests", "Input Total (Including Cache)",
    "Cache Read Tokens", "Cache Write Tokens", "Output Tokens", "Cache Hit Ratio", "Estimated Cost"
  ]);
  assert.deepEqual([...breakdown.querySelectorAll(":scope table > tbody > tr")].map(tr => [...tr.children].slice(0, 3).map(td => td.textContent)), [
    ["gpt", "short <=272K", "3"], ["gpt", "long >272K", "1"], ["gpt", "Unclassified", "—"],
    ["grok", "<200K", "1"], ["grok", "≥200K", "1"]
  ]);
  assert.equal(breakdown.querySelectorAll(":scope table > tbody > tr")[2].lastElementChild.textContent, "0.7500 USD + Unknown");
  for (const label of ["Total Tokens", "Cache Write Cost", "Model Router Cost", "Actual Model Cost"]) {
    assert.equal(modelSection.textContent.includes(label), false);
  }
  const help = testing.within(breakdown).getByRole("columnheader", { name: "Cache Hit Ratio" }).title;
  assert.match(help, /do not add them again/);
  assert.match(help, /Legacy missing cache reads may already be recorded as 0/);
  testing.fireEvent.click(view.getByRole("button", { name: "Expand direct" }));
  assert.ok(view.getByText("Single rate"));
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
    assert.equal(entry.children[1].textContent, "Unclassified");
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
        modelsResetAt: "2026-09-23T04:00:00.000Z",
        modelStats: { model: { ...tokens, billingTiers: [row("model", { kind: "flat" }), row("model", { kind: "unknown" }, { requests: null })] } }
      }))
    );
  }
  const view = testing.render(React.createElement(I18nProvider, null, React.createElement(LocalizedRuntime)));
  testing.fireEvent.click(view.getByRole("button", { name: "中文" }));
  view.container.querySelector("#runtime-models").open = true;
  testing.fireEvent.click(view.getByRole("button", { name: "展开 model" }));
  assert.ok(view.getByText("统一费率"));
  assert.ok(view.getByText("未分类"));
  assert.ok(view.getByText("模型统计清空时间: 2026-09-23T04:00:00.000Z"));
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
  assert.match(summary.textContent, /Input Total \(Including Cache\) 1000/);
  assert.match(summary.textContent, /Cache Hit Ratio 25.0%/);
  assert.equal(summary.textContent.includes("Cache Write Cost"), false);
  const mutation = fetchMock.mock.calls.find(call => String(call.arguments[0]).endsWith("/stats/models/reset"));
  assert.equal(mutation.arguments[1].headers["x-aoai-admin-csrf"], "1");
});
