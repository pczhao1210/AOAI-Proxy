import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOG_FILTERS, getValueByPath } from "../admin-ui/src/utils.js";
import { fireEvent, renderAdminComponent, renderWorkspace, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

function renderOps(config, loggingRuntime, overrides = {}) {
  return renderAdminComponent("/admin-ui/src/components/OpsTab.jsx", {
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
  });
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
  assert.ok(view.container.querySelector(".log-request-table").textContent.includes("Pending / Unknown"));
  fireEvent.click(view.getByRole("button", { name: "Pending / Unknown" }));
  assert.equal(filters.outcome, "unknown");
});
