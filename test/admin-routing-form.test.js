import assert from "node:assert/strict";
import test from "node:test";
import { fireEvent, renderWorkspace, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";
import { setValueByPath } from "../admin-ui/src/utils.js";

setupWorkspaceFormTests();

const listFields = [
  ["Chat Allowed Fields", "routing.routeProfiles.chatCompletions.allowedRequestFields"],
  ["Responses Allowed Fields", "routing.routeProfiles.responses.allowedRequestFields"],
  ["Messages Allowed Fields", "routing.routeProfiles.messages.allowedRequestFields"],
  ["Anthropic Beta Allowlist", "compatibility.anthropic.betaAllowlist"],
  ["Image Allowed Fields", "routing.routeProfiles.imageGenerations.allowedRequestFields"]
];

const switches = [
  ["Enable chat/completions", "routing.routeProfiles.chatCompletions.enabled", true],
  ["Enable responses", "routing.routeProfiles.responses.enabled", true],
  ["Enable messages", "routing.routeProfiles.messages.enabled", true],
  ["Reject lossy shim requests", "compatibility.protocolShim.rejectLossyRequests", false],
  ["Reject lossy shim responses", "compatibility.protocolShim.rejectLossyResponses", false],
  ["Forward Anthropic SDK metadata headers", "compatibility.anthropic.forwardSdkMetadataHeaders", true],
  ["Normalize manual thinking tool choice", "compatibility.anthropic.normalizeManualThinkingToolChoice", true],
  ["Sanitize Anthropic cache controls", "compatibility.anthropic.sanitizeCacheControl", true],
  ["Validate thinking mode by model", "compatibility.anthropic.validateThinkingByModel", true],
  ["Enable image generations", "routing.routeProfiles.imageGenerations.enabled", true]
];

test("routing form preserves its section anchor, group, placement and complete control order", () => {
  const view = renderWorkspace({}, "workspace-routing");
  assert.equal(view.section.tagName, "DETAILS");
  assert.equal(view.section.dataset.accordionGroup, "workspace-sections");
  assert.equal(view.section.previousElementSibling.id, "workspace-media");
  assert.ok(view.section.classList.contains("accordion-section"));
  assert.equal(view.section.querySelectorAll(".form-grid").length, 1);
  assert.equal(view.section.querySelectorAll(".checkbox-row").length, 1);
  assert.deepEqual([...view.section.querySelectorAll(".field-label")].map(label => label.textContent), [
    "Chat Allowed Fields", "Responses Allowed Fields", "Messages Allowed Fields", "Anthropic Beta Allowlist",
    "Unknown Anthropic Beta Policy", "Image Allowed Fields", "Image Poll Interval ms", "Image Poll Timeout ms"
  ]);
  assert.deepEqual([...view.section.querySelectorAll(".checkbox-row label")].map(label => label.textContent.trim()), switches.map(([label]) => label));
  assert.deepEqual(view.changes, []);
});

test("routing lists preserve case and order and update only their exact configuration paths", () => {
  const config = {};
  for (const [, path] of listFields) setValueByPath(config, path, ["Model", "stream"]);
  const original = structuredClone(config);
  const view = renderWorkspace(config, "workspace-routing");
  for (const [label, path] of listFields) {
    const input = view.fields.getByLabelText(label, { exact: true });
    assert.equal(input.value, "Model, stream");
    fireEvent.change(input, { target: { value: " First, , second, First " } });
    assert.deepEqual(view.changes.at(-1), [path, ["First", "second", "First"]]);
    assert.equal(input.value, "First, second, First");
    fireEvent.change(input, { target: { value: " , " } });
    assert.deepEqual(view.changes.at(-1), [path, []]);
    assert.equal(input.value, "");
  }
  assert.equal(view.changes.length, listFields.length * 2);
  assert.deepEqual(config, original);
});

test("unknown beta policy preserves its default, options and unrelated allowlist", () => {
  const view = renderWorkspace({ compatibility: { anthropic: { betaAllowlist: ["Beta-A"] } } }, "workspace-routing");
  const select = view.fields.getByLabelText("Unknown Anthropic Beta Policy", { exact: true });
  assert.equal(select.value, "allow-direct-anthropic");
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
    ["passthrough", "Forward all beta values"],
    ["allow-direct-anthropic", "Allow for direct Anthropic upstreams"],
    ["allowlist", "Require allowlist for every upstream"]
  ]);
  for (const value of ["passthrough", "allowlist", "allow-direct-anthropic"]) {
    fireEvent.change(select, { target: { value } });
    assert.deepEqual(view.changes.at(-1), ["compatibility.anthropic.unknownBetaPolicy", value]);
    assert.equal(select.value, value);
    assert.equal(view.fields.getByLabelText("Anthropic Beta Allowlist").value, "Beta-A");
  }
  assert.equal(view.changes.length, 3);
  assert.equal(view.fields.queryByLabelText("Filter Anthropic beta headers"), null);
});

test("routing switches retain missing defaults and exact boolean update paths", () => {
  const view = renderWorkspace({}, "workspace-routing");
  for (const [label, path, initial] of switches) {
    const checkbox = view.fields.getByLabelText(label, { exact: true });
    assert.equal(checkbox.checked, initial, label);
    for (const expected of [!initial, initial]) {
      fireEvent.click(checkbox);
      assert.deepEqual(view.changes.at(-1), [path, expected]);
      assert.equal(checkbox.checked, expected);
    }
  }
  assert.equal(view.changes.length, switches.length * 2);
});

test("routing switches preserve explicit false and strict true interpretation", () => {
  const config = {};
  for (const [, path, initial] of switches) setValueByPath(config, path, !initial);
  const view = renderWorkspace(config, "workspace-routing");
  for (const [label, , initial] of switches) assert.equal(view.fields.getByLabelText(label).checked, !initial);
  for (const [, path] of switches) setValueByPath(config, path, null);
  view.updateConfig(config);
  for (const [label, , initial] of switches) assert.equal(view.fields.getByLabelText(label).checked, initial);
  assert.deepEqual(view.changes, []);
});

test("image polling preserves numeric zero and converts edits and cleared input to numbers", () => {
  const view = renderWorkspace({}, "workspace-routing");
  for (const [label, path] of [
    ["Image Poll Interval ms", "routing.routeProfiles.imageGenerations.polling.intervalMs"],
    ["Image Poll Timeout ms", "routing.routeProfiles.imageGenerations.polling.timeoutMs"]
  ]) {
    const input = view.fields.getByLabelText(label);
    assert.equal(input.type, "number");
    assert.equal(input.value, "0");
    for (const [value, expected] of [["1250", 1250], ["0", 0], ["4000", 4000], ["", 0]]) {
      fireEvent.change(input, { target: { value } });
      assert.deepEqual(view.changes.at(-1), [path, expected]);
      assert.equal(input.value, String(expected));
    }
  }
  assert.equal(view.changes.length, 8);
});

test("disabled routes and beta filtering keep policy fields editable without clearing values", () => {
  const config = {};
  for (const [, path] of listFields) setValueByPath(config, path, ["kept"]);
  const view = renderWorkspace(config, "workspace-routing");
  for (const label of ["Enable chat/completions", "Enable responses", "Enable messages", "Enable image generations"]) {
    fireEvent.click(view.fields.getByLabelText(label, { exact: true }));
  }
  for (const [label] of listFields) {
    const input = view.fields.getByLabelText(label, { exact: true });
    assert.equal(input.disabled, false);
    assert.equal(input.value, "kept");
  }
  assert.equal(view.fields.getByLabelText("Unknown Anthropic Beta Policy").disabled, false);
  assert.equal(view.fields.getByLabelText("Image Poll Interval ms").disabled, false);
  assert.equal(view.fields.getByLabelText("Image Poll Timeout ms").disabled, false);
  assert.equal(view.changes.length, 4);
});

test("persistence form uses mode instead of the legacy database toggle and exposes one export switch", () => {
  const config = { persistence: {
    configStore: { mode: "file", database: { enabled: true, provider: "postgresql" } },
    compatibilityExport: { enabled: true, exportLegacyConfigOnChange: true, legacyConfigPath: "/tmp/legacy" }
  } };
  const original = structuredClone(config);
  const view = renderWorkspace(config, "workspace-persistence");
  assert.equal(view.fields.queryByLabelText("Enable Database Store"), null);
  assert.equal(view.fields.queryByLabelText("Export legacy config on change"), null);
  assert.equal(view.fields.queryByLabelText("Database Provider"), null);
  fireEvent.change(view.fields.getByLabelText("Persistence Mode"), { target: { value: "database" } });
  assert.deepEqual(view.changes.at(-1), ["persistence.configStore.mode", "database"]);
  assert.ok(view.fields.getAllByLabelText("Database Provider").length);
  fireEvent.click(view.fields.getByLabelText("Enable compatibility export"));
  assert.deepEqual(view.changes.at(-1), ["persistence.compatibilityExport.enabled", false]);
  assert.deepEqual(config, original);
});

test("workspace reports migration paths without values and explains active minimum restrictions", () => {
  const view = renderWorkspace({}, "workspace-core", {
    effectiveProfile: "minimum", capabilities: { budgets: false },
    configDeprecations: [
      { path: "media.generation.enabled", replacement: "routing.routeProfiles.imageGenerations.enabled", kind: "migrated" },
      { path: "admin.features.enableDangerousActions", replacement: null, kind: "ignored" }
    ]
  });
  assert.ok(view.getByText("Legacy configuration flags"));
  assert.ok(view.getByText("media.generation.enabled"));
  assert.ok(view.getByText("routing.routeProfiles.imageGenerations.enabled"));
  assert.ok(view.getByText(/Inactive; removed/));
  assert.ok(view.getByText(/active minimum profile disables/));
  assert.equal(view.fields.getByLabelText("Enable Budgets").disabled, true);
});