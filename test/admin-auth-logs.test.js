import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { DEFAULT_LOG_FILTERS, getValueByPath } from "../admin-ui/src/utils.js";
import { fireEvent, loadAdminModule, renderAdminComponent, renderElement, renderWorkspace, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

function opsProps(config, loggingRuntime, overrides = {}) {
  return {
    config,
    loggingRuntime,
    logFilters: DEFAULT_LOG_FILTERS,
    diagnosticsBusy: {},
    logs: { view: "requests", total: 0, retainedEvents: 0, items: [] },
    getValueByPath,
    getLogDetails: entry => entry?.fields || {},
    getLogMessage: entry => entry?.message || entry?.failureReason || entry?.event || "-",
    getLogEventLabel: event => event || "",
    getLogSourceLabel: source => source || "",
    formatDateTime: () => "-",
    testEndpoints: [],
    t: (_key, fallback, values = {}) => fallback.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? "")),
    ...overrides
  };
}

function renderOps(config, loggingRuntime, overrides = {}) {
  return renderAdminComponent("/admin-ui/src/components/OpsTab.jsx", opsProps(config, loggingRuntime, overrides));
}

test("auth log recording defaults off and changes only its config field", () => {
  const view = renderWorkspace({}, "workspace-logging");
  const checkbox = view.fields.getByLabelText("Log Auth-Rejected Requests");
  assert.equal(checkbox.checked, false);
  fireEvent.click(checkbox);
  assert.deepEqual(view.changes, [["observability.logs.includeAuthRejected", true]]);
});

test("historical auth logs can be unhidden while recording is disabled", async () => {
  let filters = { ...DEFAULT_LOG_FILTERS };
  const view = await renderOps(
    { observability: { logs: { includeAuthRejected: false } } },
    { includeAuthRejected: false, authRejectedSuppressed: 7 },
    { logFilters: filters, setLogFilters: update => { filters = update(filters); } }
  );
  const checkbox = view.getByLabelText("Hide auth rejections");
  assert.equal(checkbox.checked, true);
  fireEvent.click(checkbox);
  assert.equal(filters.hideAuthRejected, false);
  assert.ok(view.getByText(/7 suppressed since start/));
});

test("an unsaved disable draft does not claim active auth logging is off", async () => {
  const view = await renderOps(
    { observability: { logs: { includeAuthRejected: false } } },
    { includeAuthRejected: true }
  );
  assert.ok(view.getByLabelText("Hide auth rejections"));
  assert.equal(view.queryByText(/Requests rejected by authentication are not logged/), null);
});

test("an unsaved enable draft does not hide the active suppression notice", async () => {
  const view = await renderOps(
    { observability: { logs: { includeAuthRejected: true } } },
    { includeAuthRejected: false, authRejectedSuppressed: 3 }
  );
  assert.ok(view.getByText(/3 suppressed since start/));
});

test("unknown runtime state does not claim auth logging is disabled", async () => {
  const view = await renderOps({ observability: { logs: { includeAuthRejected: false } } }, {});
  assert.ok(view.getByLabelText("Hide auth rejections"));
  assert.equal(view.queryByText(/Requests rejected by authentication are not logged/), null);
});

test("request logs show one result with the failure cause and expandable event timeline", async () => {
  const view = await renderOps({}, {}, {
    logs: {
      view: "requests",
      total: 1,
      retainedEvents: 2,
      items: [{
        id: "request-instance-1",
        requestId: "request-1",
        ts: "2026-11-04T06:00:00.000Z",
        outcome: "failed",
        level: "warn",
        status: 400,
        method: "POST",
        url: "/v1/responses",
        modelId: "mai-transcribe-2",
        routeKey: "responses",
        backendRouteKey: "audio/transcriptions",
        errorCode: "RESPONSES_SPEECH_UNREPRESENTABLE",
        message: "stream is not supported",
        failureReason: "stream is not supported",
        events: [
          { id: 1, event: "proxy.media_failed", level: "warn", message: "media request failed", failureReason: "stream is not supported", fields: {}, ts: "2026-11-04T06:00:00.000Z" },
          { id: 2, event: "http.request_completed", level: "warn", message: "request completed with error", fields: {}, ts: "2026-11-04T06:00:00.003Z" }
        ]
      }]
    }
  });
  assert.ok(view.getByRole("tab", { name: "Requests" }));
  assert.ok(view.getByText("RESPONSES_SPEECH_UNREPRESENTABLE"));
  assert.ok(view.getByText("stream is not supported"));
  fireEvent.click(view.getByRole("button", { name: "Details" }));
  assert.ok(view.getByText("Request timeline (2 events)"));
  assert.ok(view.getByText("request completed with error"));
});

test("event and access views remain separate from request summaries", async () => {
  let filters = { ...DEFAULT_LOG_FILTERS };
  const view = await renderOps({}, {}, {
    logFilters: filters,
    setLogFilters: update => { filters = update(filters); },
    logs: { total: 0, items: [] }
  });
  fireEvent.click(view.getByRole("tab", { name: "System & Cost Events" }));
  assert.equal(filters.view, "events");
  fireEvent.click(view.getByRole("tab", { name: "Access & Auth" }));
  assert.equal(filters.view, "access");
});

for (const logsLoading of [false, true]) {
  test(`request view hides stale access entries while the matching query is ${logsLoading ? "loading" : "not loaded"}`, async () => {
    const view = await renderOps({}, {}, {
      logsLoading,
      logs: {
        view: "access",
        total: 1,
        retainedEvents: 1,
        items: [{ id: 17, requestId: "stale-access", event: "http.request_completed", status: 400, fields: {} }]
      }
    });
    assert.ok(!view.queryByText("stale-access"));
    assert.ok(!view.queryByRole("button", { name: "Details" }));
    assert.ok(view.getByText(/Showing 0 requests/));
    if (!logsLoading) assert.ok(view.getByText("This log view has not loaded. Refresh to retry."));
  });
}

test("request view preserves zero retained events instead of showing the buffer capacity", async () => {
  const view = await renderOps({}, { memoryBufferSize: 500 });
  assert.ok(view.getByText(/Retained events: 0/));
  assert.ok(!view.queryByText(/Retained events: 500/));
});

test("request view supports unknown outcomes without claiming success", async () => {
  let filters = { ...DEFAULT_LOG_FILTERS };
  const view = await renderOps({}, {}, {
    setLogFilters: update => { filters = update(filters); },
    logs: {
      view: "requests", total: 1, retainedEvents: 1,
      items: [{ id: "pending-instance", requestId: "pending-request", outcome: "unknown", message: "Request completion not recorded", events: [] }]
    }
  });
  const row = view.container.querySelector(".log-table tbody tr.log-row");
  const badge = row.querySelector(".badge");
  assert.equal(badge.textContent, "Pending");
  assert.equal(badge.title, "Pending / Unknown");
  assert.ok(!badge.classList.contains("level-info"));
  assert.ok(!row.textContent.includes("Success"));
  fireEvent.click(view.getByRole("button", { name: "Pending / Unknown" }));
  assert.equal(filters.outcome, "unknown");
});

const LOG_VIEW_ITEMS = {
  requests: [
    {
      id: "request-ok", requestId: "req-ok", ts: "2026-11-04T06:00:00.123Z", outcome: "success", level: "info", status: 200,
      method: "POST", url: "/v1/chat/completions", modelId: "gpt-4o", routeKey: "chat/completions", latencyMs: 42,
      totalTokens: 0, estimatedCostAmount: 0, currency: "USD", source: "proxy", message: "proxy request completed",
      events: [{ id: 1, event: "proxy.request_completed", level: "info", message: "proxy request completed", fields: {}, ts: "2026-11-04T06:00:00.123Z" }]
    },
    {
      id: "request-bad", requestId: "req-bad", ts: "2026-11-04T06:00:01.000Z", outcome: "failed", level: "warn", status: 429,
      modelId: "gpt-4o", routeKey: "chat/completions", errorCode: "rate_limit_exceeded", source: "upstream",
      message: "Too many requests", failureReason: "Too many requests", events: []
    },
    {
      id: "request-warn", requestId: "req-warn", ts: "2026-11-04T06:00:02.000Z", outcome: "warning", level: "warn", status: 200,
      routeKey: "responses", backendRouteKey: "chat/completions", source: "proxy", message: "Retried once", retryCount: 1, events: []
    },
    { id: "request-pending", requestId: "req-pending", ts: "2026-11-04T06:00:02.500Z", outcome: "unknown", events: [] }
  ],
  events: [
    { id: 11, ts: "2026-11-04T06:00:03.000Z", level: "info", event: "config.reloaded", fields: { reason: "manual" } },
    {
      id: 12, ts: "2026-11-04T06:00:04.000Z", level: "warn", event: "governance.text_cost_incomplete", modelId: "gpt-4o",
      failureReason: "missing rate", occurrences: 3, fields: {},
      events: [
        { id: 12, ts: "2026-11-04T06:00:04.000Z", event: "governance.text_cost_incomplete", failureReason: "missing rate", fields: {} },
        { id: 13, ts: "2026-11-04T06:00:05.000Z", event: "governance.text_cost_incomplete", failureReason: "missing rate", fields: {} },
        { id: 14, ts: "2026-11-04T06:00:06.000Z", event: "governance.text_cost_incomplete", failureReason: "missing rate", fields: {} }
      ]
    }
  ],
  access: [
    {
      id: 21, ts: "2026-11-04T06:00:07.000Z", level: "info", event: "http.request_completed", requestId: "req-a1", status: 200,
      latencyMs: 8, source: "http", fields: { method: "GET", url: "/v1/models", clientIp: "10.0.0.1" }
    },
    {
      id: 22, ts: "2026-11-04T06:00:08.000Z", level: "warn", event: "http.auth_rejected", requestId: "req-a2", status: 401,
      errorCode: "invalid_api_key", source: "http", message: "authentication rejected",
      fields: { method: "POST", url: "/v1/responses", clientIp: "10.0.0.2" }
    }
  ]
};

function logViewProps(view, overrides = {}) {
  const items = LOG_VIEW_ITEMS[view];
  let filters = { ...DEFAULT_LOG_FILTERS, view };
  return {
    logFilters: filters,
    setLogFilters: update => { filters = update(filters); },
    logs: { view, total: items.length, retainedEvents: items.length, items },
    ...overrides
  };
}

function renderLogView(view, overrides = {}) {
  return renderOps({}, {}, logViewProps(view, overrides));
}

function logHeaders(rendered) {
  return [...rendered.container.querySelectorAll(".log-table thead th")].map(th => th.textContent);
}

function logRows(rendered) {
  return [...rendered.container.querySelectorAll(".log-table tbody tr.log-row")];
}

function cellText(rendered, row, header) {
  return row.children[logHeaders(rendered).indexOf(header)].textContent;
}

for (const view of Object.keys(LOG_VIEW_ITEMS)) {
  test(`${view} log view renders compact one-line rows in the shared table`, async () => {
    const rendered = await renderLogView(view);
    const table = rendered.container.querySelector(`.log-table.log-table-${view}`);
    assert.ok(table);
    assert.equal(rendered.container.querySelectorAll(".log-table").length, 1);
    assert.equal(rendered.container.querySelector(".log-entry, .log-list, .log-request-table"), null);
    assert.equal(table.querySelectorAll("tbody tr").length, LOG_VIEW_ITEMS[view].length);
    assert.equal(table.querySelectorAll("br").length, 0);
    const headers = logHeaders(rendered);
    assert.equal(table.querySelectorAll("colgroup col").length, headers.length);
    assert.ok(headers.includes("Time"));
    assert.ok(headers.includes("Summary"));
    assert.ok(!headers.some(text => /error/i.test(text)));
    for (const row of logRows(rendered)) {
      assert.equal(row.children.length, headers.length);
      assert.equal(row.querySelectorAll(".log-actions button").length, 2);
    }
  });
}

test("a successful request row carries no error title, styling or code", async () => {
  const rendered = await renderLogView("requests");
  const [success, failed, warning] = logRows(rendered);
  for (const cls of ["severity-error", "severity-warn"]) assert.ok(!success.classList.contains(cls));
  assert.equal(success.querySelector(".is-error, .log-error-code"), null);
  assert.equal(success.querySelector(".badge.level-info").textContent, "success");
  assert.equal(success.querySelector(".log-summary-text").textContent, "proxy request completed");
  assert.ok(failed.classList.contains("severity-error"));
  assert.ok(failed.querySelector(".log-cell-summary.is-error"));
  assert.equal(failed.querySelector(".log-error-code").textContent, "rate_limit_exceeded");
  assert.ok(warning.classList.contains("severity-warn"));
  assert.equal(warning.querySelector(".is-error"), null);
});

test("request rows keep explicit zero usage, routes and retries on one line", async () => {
  const rendered = await renderLogView("requests");
  const [success, failed, warning] = logRows(rendered);
  assert.equal(cellText(rendered, success, "Tokens / Cost"), "0 · 0.0000 USD");
  assert.equal(cellText(rendered, success, "Latency"), "42 ms");
  assert.equal(cellText(rendered, success, "Status"), "200");
  assert.equal(cellText(rendered, failed, "Tokens / Cost"), "—");
  assert.equal(cellText(rendered, failed, "Latency"), "—");
  assert.equal(cellText(rendered, warning, "Route"), "responses → chat/completions");
  assert.ok([...warning.querySelectorAll(".log-summary-line .badge")].some(badge => badge.textContent === "1 retries"));
});

test("log time is compact with the full timestamp kept in the tooltip", async () => {
  const rendered = await renderLogView("requests", { formatDateTime: () => "2026-11-04 06:00:00.123" });
  const cell = rendered.container.querySelector(".log-table tbody tr.log-row .log-cell-time");
  assert.equal(cell.textContent, "11-04 06:00:00.123");
  assert.equal(cell.title, "2026-11-04T06:00:00.123Z");
});

test("event rows expand to the same JSON details, including aggregated occurrences", async () => {
  const rendered = await renderLogView("events");
  const [reloaded, aggregated] = logRows(rendered);
  assert.equal(cellText(rendered, reloaded, "Event"), "config.reloaded");
  assert.equal(reloaded.querySelector(".log-summary-text"), null);
  assert.ok([...aggregated.querySelectorAll(".log-summary-line .badge")].some(badge => badge.textContent === "3 occurrences"));
  assert.equal(aggregated.querySelector(".log-summary-text").textContent, "missing rate");
  assert.ok(aggregated.classList.contains("severity-warn"));

  fireEvent.click(reloaded.querySelector(".log-icon-button[aria-expanded]"));
  fireEvent.click(aggregated.querySelector(".log-icon-button[aria-expanded]"));
  const [reloadedJson, aggregatedJson] = [...rendered.container.querySelectorAll(".log-row-expanded .log-json")]
    .map(pre => JSON.parse(pre.textContent));
  assert.deepEqual(reloadedJson, { reason: "manual" });
  assert.equal(aggregatedJson.length, 3);
  assert.equal(aggregatedJson[0].event, "governance.text_cost_incomplete");
  assert.equal(aggregatedJson[0].message, "missing rate");
});

test("access rows show the method and path from event fields and expand to the raw payload", async () => {
  const rendered = await renderLogView("access");
  const [completed, rejected] = logRows(rendered);
  assert.equal(cellText(rendered, completed, "Route"), "GET /v1/models");
  assert.equal(cellText(rendered, completed, "Latency"), "8 ms");
  assert.equal(cellText(rendered, rejected, "Status"), "401");
  assert.equal(rejected.querySelector(".log-error-code").textContent, "invalid_api_key");
  assert.ok(rejected.classList.contains("severity-warn"));
  assert.ok(!completed.classList.contains("severity-warn"));

  fireEvent.click(rejected.querySelector(".log-icon-button[aria-expanded]"));
  const detail = rendered.container.querySelector(".log-row-expanded");
  assert.deepEqual(JSON.parse(detail.querySelector(".log-json").textContent), { method: "POST", url: "/v1/responses", clientIp: "10.0.0.2" });
  assert.equal(detail.querySelector(".log-detail-headline").textContent, "authentication rejected");
});

test("log rows filter by request ID and copy their summary through the compact actions", async () => {
  const applied = [];
  const copied = [];
  const rendered = await renderLogView("access", {
    onApplyRequestIdFilter: requestId => applied.push(requestId),
    onCopyLogSummary: entry => copied.push(entry.id)
  });
  fireEvent.click(rendered.getByRole("button", { name: "req-a2" }));
  assert.deepEqual(applied, ["req-a2"]);
  const copyButtons = rendered.getAllByRole("button", { name: "Copy Summary" });
  assert.equal(copyButtons.length, 2);
  fireEvent.click(copyButtons[1]);
  assert.deepEqual(copied, [22]);
});

test("log rows expand independently and the toggle exposes its state", async () => {
  const rendered = await renderLogView("access");
  const [first, second] = rendered.container.querySelectorAll(".log-icon-button[aria-expanded]");
  assert.equal(first.getAttribute("aria-expanded"), "false");
  assert.equal(first.getAttribute("aria-label"), "Details");
  fireEvent.click(first);
  fireEvent.click(second);
  assert.equal(rendered.container.querySelectorAll(".log-row-expanded").length, 2);
  assert.equal(first.getAttribute("aria-expanded"), "true");
  assert.equal(first.getAttribute("aria-label"), "Close");
  fireEvent.click(first);
  assert.equal(rendered.container.querySelectorAll(".log-row-expanded").length, 1);
  assert.equal(first.getAttribute("aria-label"), "Details");
});

test("expanded rows do not leak across log views", async () => {
  const { default: OpsTab } = await loadAdminModule("/admin-ui/src/components/OpsTab.jsx");
  const rendered = renderElement(createElement(OpsTab, opsProps({}, {}, logViewProps("requests"))));
  fireEvent.click(rendered.container.querySelector(".log-icon-button[aria-expanded]"));
  assert.equal(rendered.container.querySelectorAll(".log-row-expanded").length, 1);
  rendered.rerender(createElement(OpsTab, opsProps({}, {}, logViewProps("events"))));
  assert.ok(rendered.container.querySelector(".log-table-events"));
  assert.equal(rendered.container.querySelectorAll(".log-row-expanded").length, 0);
});

const LOCALIZED_LOG_HEADERS = {
  "zh-CN": {
    requests: ["时间", "结果", "请求 ID", "模型", "路由", "状态", "耗时", "用量 / 费用", "摘要", ""],
    events: ["时间", "级别", "事件", "请求 ID", "模型", "摘要", ""],
    access: ["时间", "级别", "事件", "请求 ID", "路由", "状态", "耗时", "摘要", ""]
  },
  en: {
    requests: ["Time", "Outcome", "Request ID", "Model", "Route", "Status", "Latency", "Tokens / Cost", "Summary", ""],
    events: ["Time", "Level", "Event", "Request ID", "Model", "Summary", ""],
    access: ["Time", "Level", "Event", "Request ID", "Route", "Status", "Latency", "Summary", ""]
  }
};

test("localized log tables label the summary column and keep one header set per view", async () => {
  const [{ I18nProvider, useI18n }, { default: OpsTab }] = await Promise.all([
    loadAdminModule("/admin-ui/src/i18n.jsx"),
    loadAdminModule("/admin-ui/src/components/OpsTab.jsx")
  ]);
  try {
    for (const [language, viewHeaders] of Object.entries(LOCALIZED_LOG_HEADERS)) {
      window.localStorage.setItem("aoai-admin-ui-lang", language);
      for (const [view, expected] of Object.entries(viewHeaders)) {
        const props = opsProps({}, {}, logViewProps(view));
        const Connected = () => createElement(OpsTab, { ...props, t: useI18n().t });
        const rendered = renderElement(createElement(I18nProvider, null, createElement(Connected)));
        assert.deepEqual(logHeaders(rendered), expected, `${language} ${view} headers`);
        assert.ok(!rendered.container.textContent.includes("错误摘要"));
        assert.ok(!rendered.container.textContent.includes("Error summary"));
        if (view === "requests") {
          const pending = logRows(rendered).at(-1).querySelector(".badge");
          assert.equal(pending.textContent, language === "zh-CN" ? "未完成" : "Pending");
          assert.equal(pending.title, language === "zh-CN" ? "未完成 / 未知" : "Pending / Unknown");
        }
        rendered.unmount();
      }
    }
  } finally {
    window.localStorage.removeItem("aoai-admin-ui-lang");
  }
});
