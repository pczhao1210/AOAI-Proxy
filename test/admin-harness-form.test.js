import assert from "node:assert/strict";
import test from "node:test";
import { getCodexModelMetadata } from "../src/codex-models.js";
import { fireEvent, loadAdminModule, renderAdminComponent, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

const t = (_key, fallback) => fallback;
const model = { id: "native", upstream: "provider", clientCompatibility: {}, codex: { priority: 0 }, hidden: "keep" };
const item = (modelId, eligible = true, reasons = [], nativeRoute, extra = {}) => ({
  modelId,
  clients: {
    claudeCode: { eligible: false, reasons: [] },
    codex: { eligible, reasons, ...(nativeRoute ? { nativeRoute } : {}), ...extra }
  }
});
const conversionPreview = (eligible = true, reasons = [], to = "chat/completions", routePath = "/openai/v1/chat/completions") => ({
  conversion: { active: false, candidate: { eligible, reasons, from: "responses", to, routePath } }
});
const nativeCandidate = (eligible = true, routePath = "/openai/v1/responses", reasons = []) => ({
  active: false, candidate: { eligible, reasons, routePath }
});
const confirmButton = view => view.getByRole("dialog").querySelector(".modal-footer button:last-child");
const props = {
  config: { models: [model] },
  loadedConfig: { models: [model] },
  eligibility: { items: [item("native")] },
  eligibilityLoading: false,
  eligibilityError: "",
  updateConfig() {},
  t
};

test("Harness failed eligibility refresh cannot offer stale model selection", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, eligibilityError: "Preview failed"
  });
  assert.equal(view.getAllByRole("button", { name: "Select models", exact: true })[1].disabled, true);
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
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  const checkbox = view.getByRole("checkbox", { name: "native (native)" });
  fireEvent.click(checkbox);
  view.rerender(React.createElement(HarnessTab, { ...current, eligibilityLoading: true }));
  const confirm = confirmButton(view);
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
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  assert.equal(confirmButton(view).disabled, true);
  fireEvent.click(view.getByRole("checkbox", { name: "native (native)" }));
  current = { models: [other, model] };
  view.rerender(React.createElement(HarnessTab, { ...options, config: current }));
  fireEvent.click(confirmButton(view));
  assert.equal(current.models[0].clientCompatibility.codex, undefined);
  assert.equal(current.models[1].clientCompatibility.codex, true);
  assert.equal(current.models[1].clientNativeRoute, undefined);
  assert.equal(current.models[1].codex.priority, 0);
  assert.equal(current.models[1].hidden, "keep");
});

test("Harness blank, duplicate and missing identities cannot acquire eligibility", async () => {
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props,
    config: { models: [{ ...model }, { ...model }, { ...model, id: "" }, { ...model, id: "missing" }, null] }
  });
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "all" } });
  const boxes = [...view.getByRole("dialog").querySelectorAll(".harness-candidate input[type=checkbox]")];
  assert.ok(boxes.length > 0);
  assert.ok(boxes.every(box => box.disabled));
  assert.equal(confirmButton(view).disabled, true);
});

test("Harness dialog lists selectable models first and toggles from the whole card", async () => {
  const blocked = { ...model, id: "blocked" };
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, config: { models: [blocked, model] }, onNavigate() {},
    eligibility: { items: [item("blocked", false, [{ code: "ROUTE_UNAVAILABLE" }]), item("native")] }
  });
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  const dialog = view.getByRole("dialog");
  assert.equal(dialog.querySelectorAll(".harness-candidate").length, 1);
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "all" } });
  const cards = [...dialog.querySelectorAll(".harness-candidate")];
  assert.deepEqual(cards.map(card => card.querySelector("input").disabled), [false, true]);
  assert.equal(cards[0].querySelector("button"), null);
  assert.ok(cards[1].querySelector("button"));
  fireEvent.click(cards[1]);
  assert.equal(view.getByRole("checkbox", { name: "blocked (blocked)" }).checked, false);
  fireEvent.click(cards[0]);
  assert.equal(view.getByRole("checkbox", { name: "native (native)" }).checked, true);
  assert.equal(confirmButton(view).disabled, false);
  fireEvent.click(cards[0]);
  assert.equal(view.getByRole("checkbox", { name: "native (native)" }).checked, false);
  assert.equal(confirmButton(view).disabled, true);
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
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  assert.equal(view.getByRole("dialog").querySelectorAll(".harness-candidate").length, 0);
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "unselectable" } });
  assert.equal(view.getByRole("checkbox", { name: "native (native)" }).disabled, true);
  assert.ok(view.getByText("The upstream is disabled."));
  assert.ok(view.getByText("The public client route is disabled."));
  assert.ok(view.getByText("New provider invariant"));
  fireEvent.click(view.getByRole("button", { name: "Edit upstream" }));
  fireEvent.click(view.getByRole("button", { name: "Edit public routes" }));
  assert.deepEqual(navigations, [{ type: "upstream", id: "provider" }, { type: "route" }]);
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "absent" } });
  assert.ok(view.getByText("No models match these filters."));
  fireEvent.change(view.getByRole("searchbox"), { target: { value: "provider" } });
  assert.equal(view.getByRole("dialog").querySelectorAll(".harness-candidate").length, 1);
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "native" } });
  assert.equal(view.getByRole("dialog").querySelectorAll(".harness-candidate").length, 0);
});

test("Harness dialog is multi-select with native Selectable as the default and no already-selected state", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const kept = { ...model, id: "kept", clientCompatibility: { codex: true } };
  const first = { ...model, id: "first" };
  const second = { ...model, id: "second", clientCompatibility: { claudeCode: true }, zero: 0 };
  let current = { models: [kept, first, second] };
  let updates = 0;
  const options = {
    ...props, config: current, loadedConfig: current,
    eligibility: { items: [item("kept"), item("first"), item("second")] },
    updateConfig: change => { updates++; current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  const status = view.getByRole("combobox", { name: "Model status" });
  assert.equal(status.value, "native");
  assert.deepEqual([...status.options].map(option => option.textContent), [
    "All models", "Selectable - native protocol", "Selectable - needs conversion", "Not selectable"
  ]);
  assert.equal(view.queryByText("Already selected"), null);
  assert.equal(view.getByRole("checkbox", { name: "kept (kept)" }).checked, true);
  assert.equal(view.getByRole("checkbox", { name: "first (first)" }).checked, false);
  fireEvent.click(view.getByRole("checkbox", { name: "first (first)" }));
  fireEvent.click(view.getByRole("checkbox", { name: "second (second)" }));
  fireEvent.click(view.getByRole("checkbox", { name: "kept (kept)" }));
  assert.equal(updates, 0, "Selections stay pending until confirmed");
  fireEvent.click(confirmButton(view));
  assert.equal(updates, 1);
  assert.deepEqual(current.models.map(entry => entry.clientCompatibility.codex), [false, true, true]);
  assert.deepEqual(current.models[2].clientCompatibility, { claudeCode: true, codex: true });
  assert.equal(current.models[2].zero, 0);
  assert.ok(current.models.every(entry => entry.clientNativeRoute === undefined && entry.clientConversion === undefined));
});

test("Harness enables a native route override only for models selected without native catalog support", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const native = { ...model, id: "native" };
  const chatOnly = { ...model, id: "chat-only", clientNativeRoute: { claudeCode: true } };
  const blocked = { ...model, id: "no-route" };
  let current = { models: [native, chatOnly, blocked] };
  const navigations = [];
  const nonNative = [{ code: "NON_NATIVE_PROTOCOL" }];
  const options = {
    ...props, config: current, loadedConfig: current, onNavigate: target => navigations.push(target),
    eligibility: { items: [
      item("native"),
      item("chat-only", false, nonNative, nativeCandidate()),
      item("no-route", false, [{ code: "ROUTE_UNAVAILABLE" }], nativeCandidate(false, "-", [{ code: "ROUTE_UNAVAILABLE" }]))
    ] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  const dialog = view.getByRole("dialog");
  assert.deepEqual([...dialog.querySelectorAll(".harness-candidate")].map(card => card.querySelector("input").checked), [false, false]);
  assert.ok(view.getByText("Selectable with native route override"));
  assert.ok(view.getByText(/Selecting it enables a native route override: responses requests use \/openai\/v1\/responses/));
  assert.equal(view.queryByText("NON_NATIVE_PROTOCOL"), null);
  fireEvent.click(view.getByRole("checkbox", { name: "native (native)" }));
  fireEvent.click(view.getByRole("checkbox", { name: "chat-only (chat-only)" }));
  fireEvent.click(confirmButton(view));
  assert.equal(current.models[0].clientNativeRoute, undefined);
  assert.deepEqual(current.models[1].clientNativeRoute, { claudeCode: true, codex: true });
  assert.equal(current.models[1].clientCompatibility.codex, true);
  assert.equal(current.models[2].clientCompatibility.codex, undefined);

  view.rerender(React.createElement(HarnessTab, { ...options, config: current }));
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  fireEvent.change(view.getByRole("combobox", { name: "Model status" }), { target: { value: "unselectable" } });
  assert.ok(view.getByText(/add a responses entry to this upstream's routes in the JSON editor/));
  assert.equal(view.queryByRole("button", { name: "Edit upstream" }), null);
  assert.equal(view.getByRole("checkbox", { name: "no-route (no-route)" }).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Open JSON editor" }));
  assert.deepEqual(navigations, [{ type: "advanced" }]);
});

test("Harness removal clears only the removed client's native route override", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const member = { ...model, id: "member", clientCompatibility: { codex: true, claudeCode: true }, clientNativeRoute: { codex: true, claudeCode: true } };
  let current = { models: [member] };
  const options = {
    ...props, config: current, loadedConfig: current,
    eligibility: { items: [{ ...item("member"), clients: {
      claudeCode: { eligible: true, reasons: [], nativeRoute: { active: true, routePath: "/anthropic/v1/messages" } },
      codex: { eligible: true, reasons: [], nativeRoute: { active: true, routePath: "/openai/v1/responses" } }
    } }] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  assert.ok(view.getByText(/Native route override: responses requests use \/openai\/v1\/responses/));
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  fireEvent.click(view.getByRole("checkbox", { name: "member (member)" }));
  fireEvent.click(confirmButton(view));
  assert.deepEqual(current.models[0].clientCompatibility, { codex: false, claudeCode: true });
  assert.deepEqual(current.models[0].clientNativeRoute, { claudeCode: true });
  current = { models: [member] };
  view.rerender(React.createElement(HarnessTab, { ...options, config: current }));
  const removeButtons = view.getAllByRole("button", { name: "Remove" });
  assert.equal(removeButtons.length, 2);
  fireEvent.click(removeButtons[0]);
  assert.deepEqual(current.models[0].clientCompatibility, { codex: true, claudeCode: false });
  assert.deepEqual(current.models[0].clientNativeRoute, { codex: true });
});

test("Harness offers protocol conversion as its own category after native routing", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const ids = ["native", "converted", "upgradable", "strict"];
  let current = { models: ids.map(id => ({ ...model, id })) };
  const nonNative = [{ code: "NON_NATIVE_PROTOCOL" }];
  const missing = nativeCandidate(false, null, [{ code: "ROUTE_UNAVAILABLE" }]);
  const policy = [{ code: "CONVERSION_BLOCKED_BY_POLICY" }];
  const navigations = [];
  const options = {
    ...props, config: current, loadedConfig: current, onNavigate: target => navigations.push(target),
    eligibility: { items: [
      item("native"),
      item("converted", false, nonNative, missing, conversionPreview()),
      item("upgradable", false, nonNative, nativeCandidate(), conversionPreview()),
      item("strict", false, nonNative, missing, conversionPreview(false, policy))
    ] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  fireEvent.click(view.getAllByRole("button", { name: "Select models", exact: true })[1]);
  const filter = view.getByRole("combobox", { name: "Model status" });
  const visible = () => [...view.getByRole("dialog").querySelectorAll(".harness-candidate-option span")].map(node => node.textContent);
  assert.deepEqual(visible(), ["native (native)", "upgradable (upgradable)"]);
  fireEvent.change(filter, { target: { value: "conversion" } });
  assert.deepEqual(visible(), ["converted (converted)"]);
  assert.ok(view.getByText("Selectable with protocol conversion"));
  assert.ok(view.getByText(/converts responses requests to chat\/completions \(\/openai\/v1\/chat\/completions\)/));
  assert.ok(view.getByText(/responses\/compact is unavailable/));
  assert.equal(view.queryByText("ROUTE_UNAVAILABLE"), null);
  fireEvent.click(view.getByRole("checkbox", { name: "converted (converted)" }));
  fireEvent.change(filter, { target: { value: "unselectable" } });
  assert.deepEqual(visible(), ["strict (strict)"]);
  assert.ok(view.getByText(/Lossy shim requests are rejected/));
  assert.equal(view.getByRole("checkbox", { name: "strict (strict)" }).disabled, true);
  fireEvent.change(filter, { target: { value: "native" } });
  fireEvent.click(view.getByRole("checkbox", { name: "upgradable (upgradable)" }));
  fireEvent.click(confirmButton(view));
  assert.deepEqual(current.models.map(entry => entry.clientCompatibility.codex), [undefined, true, true, undefined]);
  assert.deepEqual(current.models[1].clientConversion, { codex: true });
  assert.equal(current.models[1].clientNativeRoute, undefined);
  assert.deepEqual(current.models[2].clientNativeRoute, { codex: true });
  assert.equal(current.models[2].clientConversion, undefined);
});

test("Harness converted member can switch to native and removal clears only its own conversion flag", async () => {
  const React = await import("react");
  const { default: HarnessTab } = await loadAdminModule("/admin-ui/src/components/HarnessTab.jsx");
  const member = {
    ...model, id: "member",
    clientCompatibility: { codex: true, claudeCode: true }, clientConversion: { codex: true, claudeCode: true }
  };
  let current = { models: [member] };
  const active = { active: true, from: "responses", to: "chat/completions", routePath: "/openai/v1/chat/completions" };
  const options = {
    ...props, config: current, loadedConfig: current,
    eligibility: { items: [item("member", true, [], nativeCandidate(), { mode: "conversion", conversion: active })] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  };
  const view = renderElement(React.createElement(HarnessTab, options));
  assert.ok(view.getByText(/Protocol conversion: responses requests are converted to chat\/completions/));
  assert.ok(view.getByText(/now provides a native responses route \(\/openai\/v1\/responses\)/));
  fireEvent.click(view.getByRole("button", { name: "Switch to native route" }));
  assert.deepEqual(current.models[0].clientNativeRoute, { codex: true });
  assert.deepEqual(current.models[0].clientConversion, { claudeCode: true });
  assert.equal(current.models[0].clientCompatibility.codex, true);
  current = { models: [member] };
  view.rerender(React.createElement(HarnessTab, { ...options, config: current }));
  fireEvent.click(view.getAllByRole("button", { name: "Remove" })[0]);
  assert.deepEqual(current.models[0].clientCompatibility, { codex: true, claudeCode: false });
  assert.deepEqual(current.models[0].clientConversion, { codex: true });
  assert.equal(current.models[0].clientNativeRoute, undefined);
});

test("Harness member that lost native catalog support can enable the override in place", async () => {
  const member = { ...model, id: "member", clientCompatibility: { codex: true } };
  let current = { models: [member] };
  const view = await renderAdminComponent("/admin-ui/src/components/HarnessTab.jsx", {
    ...props, config: current, loadedConfig: current,
    eligibility: { items: [item("member", false, [{ code: "NON_NATIVE_PROTOCOL" }], nativeCandidate())] },
    updateConfig: change => { current = structuredClone(current); change(current); }
  });
  fireEvent.click(view.getByRole("button", { name: "Enable native route override" }));
  assert.deepEqual(current.models[0].clientNativeRoute, { codex: true });
  assert.equal(current.models[0].clientCompatibility.codex, true);
  assert.equal(current.models[0].hidden, "keep");
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
