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
    logs: { total: 0, items: [] },
    getValueByPath,
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
