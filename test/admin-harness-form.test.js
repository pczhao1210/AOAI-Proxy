import assert from "node:assert/strict";
import test from "node:test";
import { getCodexModelMetadata } from "../src/codex-models.js";
import { fireEvent, loadAdminModule, renderAdminComponent, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

const t = (_key, fallback) => fallback;
const model = { id: "native", upstream: "provider", clientCompatibility: {}, codex: { priority: 0 }, hidden: "keep" };
const item = (modelId, eligible = true, reasons = []) => ({
  modelId,
  clients: {
    claudeCode: { eligible: false, reasons: [] },
    codex: { eligible, reasons }
  }
});
const props = {
  config: { models: [model] },
  loadedConfig: { models: [model] },
  eligibility: { items: [item("native")] },
  eligibilityLoading: false,
  eligibilityError: "",
  updateConfig() {},
  t
};

test("Harness failed eligibility refresh cannot offer stale Add Model actions", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, eligibilityError: "Preview failed"
  });
  assert.equal(view.getAllByRole("button", { name: "Add Model", exact: true })[1].disabled, true);
});

test("Harness joins eligibility by unique model identity, never array position", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props,
    config: { models: [{ ...model, id: "different", clientCompatibility: { codex: true } }] }
  });
  assert.equal(view.queryAllByText(/^(Eligible|Configuration matches native routing)$/).length, 0);
});

test("Harness refresh invalidates open modal confirmation while keeping removal available", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const changes = [];
  const current = { ...props, updateConfig: change => changes.push(change) };
  const view = renderElement(React.createElement(HarnessTab, current));
  fireEvent.click(view.getAllByRole("button", { name: "Add Model", exact: true })[1]);
  const radio = view.queryByRole("radio");
  assert.ok(radio);
  fireEvent.click(radio);
  view.rerender(React.createElement(HarnessTab, { ...current, eligibilityLoading: true }));
  const confirm = view.getByRole("dialog").querySelector(".modal-footer button:last-child");
  assert.equal(confirm.disabled, true);
  fireEvent.click(confirm);
  assert.deepEqual(changes, []);
});

test("Harness selection survives reorder by ID and preserves hidden fields and zeros", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const other = { ...model, id: "other" };
  let current = { models: [model, other] };
  const options = {
    ...props, config: current, eligibility: { items: [item("native"), item("other")] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  fireEvent.click(view.getAllByRole("button", { name: "Add Model", exact: true })[1]);
  assert.equal(view.getByRole("dialog").querySelector(".modal-footer button:last-child").disabled, true);
  fireEvent.click(view.getByRole("radio", { name: "native (native)" }));
  current = { models: [other, model] };
  view.rerender(React.createElement(HarnessTab, { ...options, config: current }));
  fireEvent.click(view.getByRole("dialog").querySelector(".modal-footer button:last-child"));
  assert.equal(current.models[0].clientCompatibility.codex, undefined);
  assert.equal(current.models[1].clientCompatibility.codex, true);
  assert.equal(current.models[1].codex.priority, 0);
  assert.equal(current.models[1].hidden, "keep");
});

test("Harness blank, duplicate and missing identities cannot acquire eligibility", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props,
    config: { models: [{ ...model }, { ...model }, { ...model, id: "" }, { ...model, id: "missing" }, null] }
  });
  fireEvent.click(view.getAllByRole("button", { name: "Add Model", exact: true })[1]);
  assert.ok(view.getAllByRole("radio").every(radio => radio.disabled));
  assert.equal(view.getByRole("dialog").querySelector(".modal-footer button:last-child").disabled, true);
});

test("Harness lists all blocking reasons, unknown codes, filters and repair targets", async () => {
  const navigations = [];
  const reasons = [
    { code: "UPSTREAM_DISABLED", message: "original English" },
    { code: "PUBLIC_ROUTE_DISABLED", message: "original English" },
    { code: "FUTURE_REASON", message: "New provider invariant" }
  ];
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, eligibility: { items: [item("native", false, reasons)] },
    onNavigate: target => navigations.push(target)
  });
  fireEvent.click(view.getAllByRole("button", { name: "Add Model", exact: true })[1]);
  assert.equal(view.getByRole("radio").disabled, true);
  assert.ok(view.getByText("The upstream is disabled."));
  assert.ok(view.getByText("The public client route is disabled."));
  assert.ok(view.getByText("New provider invariant"));
  fireEvent.click(view.getByRole("button", { name: "Edit upstream" }));
  fireEvent.click(view.getByRole("button", { name: "Edit public routes" }));
  assert.deepEqual(navigations, [{ type: "upstream", id: "provider" }, { type: "route" }]);
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "absent" } });
  assert.ok(view.getByText("No models match these filters."));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "provider" } });
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "ineligible" } });
  assert.equal(view.getAllByRole("radio").length, 1);
});

test("Harness active publication, draft removal and failed eligibility remain distinct", async () => {
  const selectedModel = { ...model, clientCompatibility: { codex: true } };
  let next;
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, config: { models: [selectedModel] }, loadedConfig: { models: [selectedModel] },
    eligibilityError: "Preview failed", eligibility: null,
    updateConfig: change => { next = structuredClone({ models: [selectedModel] }); change(next); }
  });
  assert.ok(view.getByText("Saved member"));
  assert.ok(view.getByText(/Client connectivity has not been verified/));
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  assert.equal(next.models[0].clientCompatibility.codex, false);
  view.unmount();
  const draft = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, dirty: true, loadedConfig: { models: [selectedModel] },
    eligibility: { items: [item("native")], active: {
      catalogs: { codex: { enabled: false } },
      items: [{ ...item("native"), selected: { codex: true } }]
    } }
  });
  assert.ok(draft.getByText("Pending removal: native"));
  assert.ok(draft.getAllByText(/Publication disabled/).length);
});

test("Harness connection guide only copies explicit templates and surfaces clipboard failures", async context => {
  const { act } = await import("@testing-library/react/pure.js");
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copied = [];
  let fail = false;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    async writeText(text) { if (fail) throw new Error("Clipboard denied"); copied.push(text); }
  } });
  context.after(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete navigator.clipboard;
  });
  context.mock.method(globalThis, "fetch", () => { throw new Error("Connection guide must not send requests"); });
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessSetup.jsx", {
    client: { id: "codex" }, models: [model], adminPath: "/control", t
  });
  assert.equal(view.queryByRole("button", { name: "Copy TOML" }), null);
  fireEvent.change(view.getByRole("textbox", { name: /^Public proxy address/ }), { target: { value: "https://proxy.example.com/v1" } });
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy TOML" })));
  assert.match(copied[0], /model = "native"/);
  assert.match(copied[0], /base_url = "https:\/\/proxy.example.com\/v1"/);
  assert.equal(copied[0].includes("hidden"), false);
  fail = true;
  await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy shell commands" })));
  assert.equal(view.getByRole("alert").textContent, "Clipboard denied");
  fireEvent.change(view.getByRole("textbox", { name: /^Public proxy address/ }), { target: { value: "https://proxy.example.com/control" } });
  assert.equal(view.queryByRole("button", { name: "Copy TOML" }), null);
  assert.ok(view.getByText("Use the public proxy address, not the administration path."));
});

test("Codex settings edit only explicit overrides, preserve zeros and unknown fields, and clear inheritance", async () => {
  const React = await import("react");
  const { default: Settings } = await loadAdminModule("/admin-ui/src/components/CodexModelSettings.jsx");
  let current = { models: [{ ...model, codex: { priority: 0, hidden: "retain" } }] };
  let changes = 0;
  const options = () => ({
    model: current.models[0], metadata: getCodexModelMetadata(current.models[0], 3, null),
    unique: true, t, updateConfig: change => {
      current = structuredClone(current);
      change(current);
      changes++;
      view.rerender(React.createElement(Settings, options()));
    }
  });
  const view = renderElement(React.createElement(Settings, options()));
  assert.equal(changes, 0, "Preview must not persist inherited values");
  const contextWindow = view.getByRole("spinbutton", { name: "Context window override" });
  fireEvent.change(contextWindow, { target: { value: "0" } });
  assert.ok(view.getByRole("alert").textContent.includes("positive safe integer"));
  fireEvent.change(contextWindow, { target: { value: "256000" } });
  assert.equal(current.models[0].codex.contextWindow, 256000);
  const efforts = view.getByRole("textbox", { name: /^Supported efforts override/ });
  fireEvent.change(efforts, { target: { value: "high, future" } });
  assert.equal(current.models[0].codex.supportedReasoningEfforts, undefined);
  fireEvent.blur(efforts);
  assert.deepEqual(current.models[0].codex.supportedReasoningEfforts, ["high", "future"]);
  fireEvent.change(view.getByRole("textbox", { name: "Base instructions override" }), { target: { value: "Custom instructions" } });
  assert.equal(current.models[0].codex.priority, 0);
  assert.equal(current.models[0].hidden, "keep");
  fireEvent.click(view.getByRole("button", { name: "Clear displayed overrides" }));
  assert.deepEqual(current.models[0].codex, { hidden: "retain" });
  assert.equal(view.getByRole("spinbutton", { name: "Priority override" }).value, "");
});
