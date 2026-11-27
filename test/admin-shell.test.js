import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { readFile } from "node:fs/promises";
import { fireEvent, loadAdminModule, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";
import { getAdminBasePath, fetchRuntime } from "../admin-ui/src/api.js";
import { createTestContext } from "./lib/harness.js";

setupWorkspaceFormTests();

test("language files have matching keys and interpolation variables", async () => {
  const [en, zh] = await Promise.all(["en", "zh-CN"].map(async code => {
    const text = await readFile(new URL(`../admin-ui/src/i18n/${code}.json`, import.meta.url), "utf8");
    const keys = [...text.matchAll(/^  "([^"]+)":/gm)].map(match => match[1]);
    assert.equal(keys.length, new Set(keys).size, `${code} contains duplicate translation keys`);
    return JSON.parse(text);
  }));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    const variables = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(variables(en[key]), variables(zh[key]), key);
  }
});

test("grouped tables keep bulk selection scoped to model identities, not group summaries", async () => {
  const { default: DataTable } = await loadAdminModule("/admin-ui/src/components/ui/DataTable.jsx");
  const { within } = await import("@testing-library/react/pure.js");
  const rows = [{ id: "one", canonical: "shared" }, { id: "two", canonical: "shared" }, { id: "three", canonical: "other" }];
  let affected;
  const ui = renderElement(createElement(DataTable, {
    rows, columns: [{ accessorKey: "id", header: "Model" }, { accessorKey: "canonical", header: "Canonical" }],
    groupBy: "canonical", getRowId: row => row.id, label: "Models", t: key => key,
    onBulkStatus: (models, status) => { affected = { models, status }; }
  }));
  assert.ok(ui.getByRole("rowheader", { name: "shared · 2" }));
  const first = ui.getByRole("row", { name: /one shared/ });
  fireEvent.click(within(first).getByRole("checkbox"));
  fireEvent.click(ui.getByRole("button", { name: "ui.disable" }));
  assert.deepEqual(affected, { models: [rows[0]], status: "disabled" });
  fireEvent.click(ui.getByRole("checkbox", { name: "ui.selectAll" }));
  fireEvent.click(ui.getByRole("button", { name: "ui.enable" }));
  assert.deepEqual(affected, { models: rows, status: "active" });
});

test("every persistence entry point rejects unapplied entity drafts before issuing a save", async context => {
  const { ConfigDraftProvider, useConfigDraft, useConfigActions } = await loadAdminModule("/admin-ui/src/lib/config-draft.jsx");
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ config: {} }); });
  function Form() {
    const { setEntityDrafts } = useConfigDraft();
    const [outcome, setOutcome] = useState("");
    const { persistConfig } = useConfigActions({
      t: key => key, setError: setOutcome, setMessage: setOutcome, loadRequestRef: { current: 0 },
      applyLoadedConfig() {}, async loadSecondaryData() {}
    });
    return createElement("div", null,
      createElement("button", { onClick: () => setEntityDrafts({ "apiKeys:team": { value: { id: "team" } } }) }, "Edit entity"),
      createElement("button", { onClick: () => persistConfig({}, "saved").catch(error => setOutcome(error.message)) }, "Save compression"),
      createElement("output", null, outcome));
  }
  const ui = renderElement(createElement(ConfigDraftProvider, null, createElement(Form)));
  fireEvent.click(ui.getByRole("button", { name: "Edit entity" }));
  fireEvent.click(ui.getByRole("button", { name: "Save compression" }));
  await ui.findByText("ui.unapplied");
  assert.equal(requests, 0);
});

test("injected admin basename is shared by deep-link APIs, including nested roots", async context => {
  const meta = document.createElement("meta");
  meta.name = "aoai-admin-base";
  meta.content = "/ops/logs";
  document.head.append(meta);
  context.after(() => meta.remove());
  const requests = [];
  context.mock.method(globalThis, "fetch", async url => { requests.push(url); return Response.json({}); });
  window.history.replaceState(null, "", "/ops/logs/keys?edit=team");
  assert.equal(getAdminBasePath(), "/ops/logs");
  await fetchRuntime();
  assert.deepEqual(requests, ["/ops/logs/api/runtime"]);
  window.history.replaceState(null, "", "/admin/");
});

test("custom admin HTML injects basename for root and deep links while API misses stay non-HTML", async () => {
  const context = await createTestContext({ configureConfig: config => { config.server.adminPath = "/ops/logs"; } });
  try {
    for (const path of ["/ops/logs/", "/ops/logs/channels?edit=test", "/ops/logs/settings/persistence"]) {
      const result = await context.adminRequest(path);
      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /<meta name="aoai-admin-base" content="\/ops\/logs">/);
      assert.match(result.headers.get("content-type"), /text\/html/);
    }
    const missing = await context.adminRequest("/ops/logs/api/no-such-endpoint");
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.headers.get("content-type"), /text\/html/);
    const alias = await context.adminRequest("/admin/channels?edit=test", { redirect: "manual" });
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.get("location"), "/ops/logs/channels?edit=test");
    const runtime = await context.adminRequest("/ops/logs/api/runtime");
    assert.equal(runtime.json.runtime.configuration.fieldMetadata["server.port"].restartRequired, true);
    const unsupported = await context.adminRequest("/ops/logs/api/logs?view=operations&keyId=team");
    assert.equal(unsupported.status, 400);
  } finally { await context.cleanup(); }
});

test("Key sheets retain unapplied edits across history navigation and preserve complete objects on apply", async context => {
  const { MemoryRouter, useNavigate, useLocation } = await import("react-router");
  const { act } = await import("@testing-library/react/pure.js");
  const { ConfigDraftProvider } = await loadAdminModule("/admin-ui/src/lib/config-draft.jsx");
  const { default: KeysTab } = await loadAdminModule("/admin-ui/src/components/KeysTab.jsx");
  const initial = { apiKeys: [{ id: "team", key: "__AOAI_PROXY_REDACTED__", modelAccessMode: "selected",
    allowedModels: [], owner: "original", hidden: { enabled: false }, rateLimit: { windowSeconds: 0, rpm: 0 }, budget: { limitAmount: 0 } }], models: [] };
  let latest = initial;
  let goBack;
  context.mock.method(window, "confirm", () => true);
  function Form() {
    const [config, setConfig] = useState(initial);
    const navigate = useNavigate();
    goBack = () => navigate(-1);
    const location = useLocation();
    latest = config;
    return createElement("div", null,
      createElement("button", { onClick: () => navigate(-1) }, "Back"),
      createElement("output", null, location.search),
      createElement(KeysTab, { config, loadedConfig: initial, t: (key, fallback) => fallback || key,
        updateConfig: mutate => setConfig(current => { const next = structuredClone(current); mutate(next); return next; }) }));
  }
  const ui = renderElement(createElement(MemoryRouter, { initialEntries: ["/keys"] }, createElement(ConfigDraftProvider, null, createElement(Form))));
  fireEvent.click(ui.getByRole("button", { name: "team", exact: true }));
  fireEvent.change(await ui.findByRole("textbox", { name: "field.owner" }), { target: { value: "draft-owner" } });
  assert.equal(latest.apiKeys[0].owner, "original");
  await act(async () => goBack());
  fireEvent.click(ui.getByRole("button", { name: "team", exact: true }));
  assert.equal((await ui.findByRole("textbox", { name: "field.owner" })).value, "draft-owner");
  fireEvent.click(ui.getByRole("button", { name: "ui.applyDraft" }));
  assert.deepEqual(latest, { ...initial, apiKeys: [{ ...initial.apiKeys[0], owner: "draft-owner" }] });
  fireEvent.change(ui.getByRole("textbox", { name: "field.id" }), { target: { value: "renamed" } });
  fireEvent.click(ui.getByRole("button", { name: "ui.applyDraft" }));
  assert.match(ui.container.querySelector("output").textContent, /edit=renamed/);
  assert.equal(latest.apiKeys[0].rateLimit.windowSeconds, 0);
});

test("new Key edits survive closing and reopening Add without granting access or changing the global draft", async context => {
  const { MemoryRouter } = await import("react-router");
  const { ConfigDraftProvider } = await loadAdminModule("/admin-ui/src/lib/config-draft.jsx");
  const { default: KeysTab } = await loadAdminModule("/admin-ui/src/components/KeysTab.jsx");
  const initial = { apiKeys: [], models: [{ id: "published" }], access: { budgets: { softLimitRatio: 0 } } };
  let latest = initial;
  context.mock.method(window, "confirm", () => true);
  function Form() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return createElement(KeysTab, { config, loadedConfig: initial, t: (key, fallback) => fallback || key,
      updateConfig: mutate => setConfig(current => { const next = structuredClone(current); mutate(next); return next; }) });
  }
  const ui = renderElement(createElement(MemoryRouter, { initialEntries: ["/keys"] },
    createElement(ConfigDraftProvider, null, createElement(Form))));
  fireEvent.click(ui.getByRole("button", { name: "keys.add" }));
  fireEvent.change(await ui.findByRole("textbox", { name: "field.owner" }), { target: { value: "new-owner" } });
  assert.equal(latest.apiKeys.length, 0);
  fireEvent.click(ui.getByRole("button", { name: "common.close" }));
  fireEvent.click(ui.getByRole("button", { name: "keys.add" }));
  assert.equal((await ui.findByRole("textbox", { name: "field.owner" })).value, "new-owner");
  fireEvent.click(ui.getByRole("button", { name: "ui.applyDraft" }));
  assert.equal(latest.apiKeys.length, 1);
  assert.equal(latest.apiKeys[0].owner, "new-owner");
  assert.equal(latest.apiKeys[0].modelAccessMode, "selected");
  assert.deepEqual(latest.apiKeys[0].allowedModels, []);
  assert.equal(latest.apiKeys[0].budget.softLimitRatio, 0);
});

test("settings search and modified-only filters preserve zero values and keep environment fields locked", async () => {
  const { SettingsFieldsProvider } = await loadAdminModule("/admin-ui/src/lib/settings-fields.jsx");
  const { Field, SettingLabel } = await loadAdminModule("/admin-ui/src/components/ui.jsx");
  const baseline = { server: { port: 0 }, admin: { auth: { enabled: true } } };
  function Form() {
    const [config, setConfig] = useState(baseline);
    const [modifiedOnly, setModifiedOnly] = useState(false);
    const [search, setSearch] = useState("");
    return createElement("div", null,
      createElement("button", { onClick: () => setModifiedOnly(true) }, "Changed"),
      createElement("button", { onClick: () => setSearch("unmatched") }, "Search"),
      createElement(SettingsFieldsProvider, { value: { config, loadedConfig: baseline, search, modifiedOnly, t: key => key,
        metadata: { "admin.auth.enabled": { source: "environment", variable: "ADMIN_AUTH_ENABLED", readOnly: true } } } },
      createElement(Field, { path: "server.port", label: "Port" }, createElement("input", { type: "number", value: config.server.port,
        onChange: event => setConfig({ ...config, server: { port: Number(event.target.value) } }) })),
      createElement(SettingLabel, { path: "admin.auth.enabled" }, createElement("input", { type: "checkbox", checked: true, onChange() {} }), "Auth")));
  }
  const ui = renderElement(createElement(Form));
  assert.equal(ui.getByRole("spinbutton", { name: "Port" }).value, "0");
  assert.equal(ui.getByRole("checkbox", { name: "Auth" }).matches(":disabled"), true);
  fireEvent.change(ui.getByRole("spinbutton", { name: "Port" }), { target: { value: "3000" } });
  fireEvent.click(ui.getByRole("button", { name: "Changed" }));
  assert.ok(!ui.queryByRole("checkbox"));
  assert.equal(ui.getByRole("spinbutton").value, "3000");
  fireEvent.click(ui.getByRole("button", { name: "Search" }));
  assert.ok(!ui.queryByRole("spinbutton"));
});

test("model route editing writes deployment-bound overrides without changing native membership or hidden fields", async () => {
  const { default: Editor } = await loadAdminModule("/admin-ui/src/features/channels/RoutePolicyEditor.jsx");
  const initial = { id: "public", selectedBinding: { channelId: "one", sourceModelId: "source" },
    clientNativeRoute: { codex: true }, hidden: { zero: 0 }, requestPolicy: { blockedParams: ["private"] } };
  let latest = initial;
  function Form() {
    const [item, setItem] = useState(initial);
    latest = item;
    return createElement(Editor, { item, channels: false, tab: "routes", t: key => key,
      update: mutate => setItem(current => { const next = structuredClone(current); mutate(next); return next; }) });
  }
  const ui = renderElement(createElement(Form));
  fireEvent.change(ui.getByLabelText("chat/completions"), { target: { value: "responses" } });
  assert.deepEqual(latest, { ...initial, bindingOverride: { ...initial.selectedBinding, routes: { "chat/completions": "responses" } } });
  assert.equal(Object.hasOwn(latest, "routes"), false);
});
