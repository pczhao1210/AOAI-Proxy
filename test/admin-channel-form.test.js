import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { waitFor, within } from "@testing-library/dom";
import { fireEvent, loadAdminModule, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";
import { resolveChannelModels } from "../src/channel-bindings.js";

setupWorkspaceFormTests();

test("same-name upstream and target model IDs work with either implicit or explicit mappings", async () => {
  const { MappingEditor } = await loadAdminModule("/admin-ui/src/components/ChannelModels.jsx");
  for (const mappings of [[], [{ sourceModelId: "same", canonicalModelId: "same", enabled: false }]]) {
    let latest;
    function Form() {
      const [config, setConfig] = useState({ upstreams: [{ name: "One", channelId: "one", modelMappings: mappings }], models: [] });
      const [drafts, setDrafts] = useState({});
      latest = config;
      return createElement(MappingEditor, { config, up: config.upstreams[0], index: 0,
        definitions: [{ id: "same" }], drafts, setDrafts, t: key => key,
        updateConfig: mutate => setConfig(current => { const next = structuredClone(current); mutate(next); return next; }) });
    }
    const ui = renderElement(createElement(Form));
    fireEvent.change(ui.getByRole("combobox", { name: "channel.modelIds" }), { target: { value: "same" } });
    fireEvent.click(ui.getByRole("button", { name: "channel.addModels" }));
    assert.deepEqual(latest.upstreams[0].modelMappings, [{ sourceModelId: "same", canonicalModelId: "same", enabled: true }]);
    assert.deepEqual(latest.models, []);
    ui.unmount();
  }
});

test("channel model IDs create identity bindings or enable deployment mappings without publishing models", async () => {
  const { MappingEditor } = await loadAdminModule("/admin-ui/src/components/ChannelModels.jsx");
  const initial = { upstreams: [{ channelId: "one", name: "One", modelMappings: [
    { sourceModelId: "mini-jpeast", canonicalModelId: "mini", enabled: false, pricing: { inputPer1mTokens: 0 } },
    { sourceModelId: "large-west", canonicalModelId: "large", enabled: false }
  ] }], models: [], apiKeys: [{ allowedModels: [] }] };
  let latest;
  function Form() {
    const [config, setConfig] = useState(initial);
    const [drafts, setDrafts] = useState({});
    latest = config;
    return createElement(MappingEditor, { config, up: config.upstreams[0], index: 0,
      definitions: ["mini", "large", "direct"].map(id => ({ id })), drafts, setDrafts, t: key => key,
      updateConfig: change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; }) });
  }
  const ui = renderElement(createElement(Form));
  const input = ui.getByRole("combobox", { name: "channel.modelIds" });
  fireEvent.change(input, { target: { value: "not-in-catalog" } });
  fireEvent.click(ui.getByRole("button", { name: "channel.addModels" }));
  assert.match(ui.getByRole("alert").textContent, /channel.unknownModelIds/);
  assert.deepEqual(latest, initial);
  fireEvent.change(input, { target: { value: "mini, direct" } });
  fireEvent.click(ui.getByRole("button", { name: "channel.addModels" }));
  assert.deepEqual(latest.upstreams[0].modelMappings, [
    { ...initial.upstreams[0].modelMappings[0], enabled: true },
    initial.upstreams[0].modelMappings[1],
    { sourceModelId: "direct", canonicalModelId: "direct", enabled: true }
  ]);
  fireEvent.click(ui.getByRole("button", { name: "channel.addMappedModels" }));
  assert.ok(latest.upstreams[0].modelMappings.every(row => row.enabled));
  assert.deepEqual(latest.models, []);
  assert.deepEqual(latest.apiKeys, initial.apiKeys);
  fireEvent.click(ui.getByRole("button", { name: "entity.delete direct" }));
  assert.equal(latest.upstreams[0].modelMappings.find(row => row.sourceModelId === "direct").enabled, false);
});

test("legacy channels show the same model list and only migrate bindings when edited", async () => {
  const { MappingEditor } = await loadAdminModule("/admin-ui/src/components/ChannelModels.jsx");
  const initial = { upstreams: [{ name: "Legacy" }], apiKeys: [{ allowedModels: ["public"] }],
    models: [{ id: "public", upstream: "Legacy", targetModel: "mini-east", pricingRef: "mini", pricing: { inputPer1mTokens: 0 } }] };
  let latest;
  function Form() {
    const [config, setConfig] = useState(initial);
    const [drafts, setDrafts] = useState({});
    latest = config;
    return createElement(MappingEditor, { up: config.upstreams[0], config, index: 0,
      capabilityView: { models: [{ modelId: "public", canonicalModelId: "mini" }] },
      definitions: [{ id: "mini" }, { id: "direct" }], drafts, setDrafts, t: key => key,
      updateConfig: mutate => setConfig(current => { const next = structuredClone(current); mutate(next); return next; }) });
  }
  const ui = renderElement(createElement(Form));
  const input = ui.getByRole("combobox", { name: "channel.modelIds" });
  assert.deepEqual(latest, initial);
  fireEvent.change(input, { target: { value: "direct" } });
  fireEvent.click(ui.getByRole("button", { name: "channel.addModels" }));
  const resolved = resolveChannelModels(latest, new Set(["mini", "direct"]));
  assert.equal(resolved[0].id, "public");
  assert.equal(resolved[0].targetModel, "mini-east");
  assert.deepEqual(resolved[0].pricing, { inputPer1mTokens: 0 });
  assert.deepEqual(latest.apiKeys, initial.apiKeys);
  assert.equal(latest.upstreams[0].modelMappings.length, 2);
});

test("migrating shared deployments retains public order, private per-alias overrides and zero prices", async () => {
  const { migrateChannel } = await loadAdminModule("/admin-ui/src/components/ChannelModels.jsx");
  const config = {
    upstreams: [{ name: "Original" }, { name: "Other", channelId: "other", modelMappings: [
      { sourceModelId: "b", canonicalModelId: "mini", enabled: true, routes: { "*": "responses" } }
    ] }],
    models: ["public", "alias"].map(id => ({ id, upstream: "Original", targetModel: "a", pricingRef: "mini" })),
    apiKeys: [{ id: "key", allowedModels: ["alias"] }]
  };
  config.models[0].pricing = { inputPer1mTokens: 0 };
  config.models[0].routes = { "*": "chat/completions" };
  const view = { models: config.models.map(m => ({ modelId: m.id, canonicalModelId: "mini" })) };
  migrateChannel(config, 0, "original", view);
  assert.equal(config.upstreams[0].modelMappings.length, 1);
  const resolve = () => resolveChannelModels(config, new Set(["mini"]));
  const original = resolve();
  assert.deepEqual(original.map(m => m.id), ["public", "alias"]);
  assert.deepEqual(original[0].pricing, { inputPer1mTokens: 0 });
  assert.equal(original[1].pricing, undefined);
  config.models[0].selectedBinding = { channelId: "other", sourceModelId: "b" };
  assert.equal(resolve()[0].pricing, undefined);
  assert.deepEqual(resolve()[0].routes, { "*": "responses" });
  config.models[0].selectedBinding = { channelId: "original", sourceModelId: "a" };
  assert.deepEqual(resolve(), original);
  assert.deepEqual(config.apiKeys, [{ id: "key", allowedModels: ["alias"] }]);
});

test("mapping editor keeps invalid JSON, and exposure requires an explicit deployment when the canonical ID is ambiguous", async () => {
  const { MappingEditor, ExposurePicker, channelCandidates } = await loadAdminModule("/admin-ui/src/components/ChannelModels.jsx");
  const definitions = [{ id: "mini" }];
  const makeRow = sourceModelId => ({ sourceModelId, canonicalModelId: "mini", enabled: true });
  const initial = { upstreams: [{ channelId: "c", name: "C", modelMappings: [makeRow("a"), makeRow("b")] }],
    models: [], apiKeys: [{ id: "key", modelAccessMode: "selected", allowedModels: [] }] };
  let latest;
  function Form() {
    const [config, setConfig] = useState(initial);
    const [drafts, setDrafts] = useState({});
    latest = config;
    const updateConfig = change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; });
    const t = key => key;
    return createElement("div", null,
      createElement(MappingEditor, { config, definitions, index: 0, up: config.upstreams[0], updateConfig, drafts, setDrafts, t }),
      createElement(ExposurePicker, { groups: channelCandidates(config.upstreams, definitions), models: config.models, search: "", updateConfig, t }));
  }
  const ui = renderElement(createElement(Form));
  fireEvent.click(ui.getByRole("button", { name: "channel.json" }));
  const editor = ui.getByRole("textbox", { name: "channel.json" });
  fireEvent.change(editor, { target: { value: "[" } });
  assert.equal(editor.value, "[");
  assert.equal(ui.getByRole("button", { name: "channel.useJson" }).disabled, true);
  assert.deepEqual(latest, initial);
  const edited = [makeRow("a"), { ...makeRow("b"), routes: { "*": "responses" } }];
  fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
  fireEvent.click(ui.getByRole("button", { name: "channel.useJson" }));
  assert.deepEqual(latest.upstreams[0].modelMappings, edited);
  fireEvent.click(ui.getByRole("checkbox", { name: "mini" }));
  const publish = ui.getByRole("button", { name: /channel.publish/ });
  assert.equal(publish.disabled, true);
  fireEvent.change(ui.getByRole("combobox", { name: "channel.binding" }), { target: { value: '["c","b"]' } });
  fireEvent.click(publish);
  assert.deepEqual(latest.models, [{ id: "mini", canonicalModelId: "mini", selectedBinding: { channelId: "c", sourceModelId: "b" } }]);
  fireEvent.click(ui.getByRole("checkbox", { name: "mini (mini)" }));
  fireEvent.click(publish);
  assert.deepEqual(latest.models, []);
  assert.deepEqual(latest.apiKeys, initial.apiKeys);
  assert.deepEqual(latest.upstreams[0].modelMappings, edited);
});

test("key form removes orphaned permissions without widening a legacy restricted key", async () => {
  const { MemoryRouter } = await import("react-router");
  const { default: KeysTab } = await loadAdminModule("/admin-ui/src/components/KeysTab.jsx");
  const { ConfigDraftProvider } = await loadAdminModule("/admin-ui/src/lib/config-draft.jsx");
  let latest;
  function Form() {
    const [config, setConfig] = useState({ models: [{ id: "published" }], apiKeys: [{ id: "team", allowedModels: ["removed"] }] });
    latest = config;
    return createElement(KeysTab, { config, t: (key, fallback) => fallback || key,
      updateConfig: change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; }) });
  }
  const ui = renderElement(createElement(MemoryRouter, { initialEntries: ["/keys?edit=team&tab=access"] },
    createElement(ConfigDraftProvider, null, createElement(Form))));
  fireEvent.click(await ui.findByRole("button", { name: "entity.delete removed" }));
  assert.deepEqual(latest.apiKeys[0].allowedModels, ["removed"], "entity edits do not modify the global draft");
  fireEvent.click(ui.getByRole("button", { name: "ui.applyDraft" }));
  assert.equal(latest.apiKeys[0].modelAccessMode, "selected");
  assert.deepEqual(latest.apiKeys[0].allowedModels, []);
  const picker = ui.getByRole("combobox", { name: "field.allowedModels" });
  picker.focus();
  fireEvent.click(picker);
  fireEvent.input(picker, { target: { value: "pub" }, inputType: "insertText" });
  fireEvent.click(await ui.findByRole("option", { name: "published" }));
  fireEvent.click(ui.getByRole("button", { name: "ui.applyDraft" }));
  assert.deepEqual(latest.apiKeys[0].allowedModels, ["published"]);
});

test("saved direct OpenAI discovery imports exact IDs only as disabled draft rows and discards late results after rename", async ctx => {
  const { act } = await import("@testing-library/react/pure.js");
  const { default: RoutingTab } = await loadAdminModule("/admin-ui/src/components/RoutingTab.jsx");
  const makeChannel = (channelId, provider, baseUrl, mode = "apiKey") => ({
    channelId, name: channelId, provider, baseUrl, auth: { mode, apiKey: "masked-fixture" }, modelMappings: []
  });
  const saved = { upstreams: [
    makeChannel("direct", "openai", "https://api.openai.com/v1/"),
    makeChannel("azure", "azure-openai", "https://api.openai.com"),
    makeChannel("other", "openai", "https://api.openai.com.evil.example/v1"),
    makeChannel("identity", "openai", "https://api.openai.com", "managedIdentity")
  ], models: [] };
  let latest;
  const calls = [];
  let resolve;
  ctx.mock.method(globalThis, "fetch", (path, options) => {
    calls.push({ path, options });
    return new Promise(done => { resolve = () => done(Response.json({
      channelId: "direct", models: [{ id: "exact" }, { id: "Exact" }], updatedAt: new Date().toISOString()
    })); });
  });
  function Form() {
    const [config, setConfig] = useState({ ...saved, upstreams: [...saved.upstreams, makeChannel("new", "openai", "https://api.openai.com/v1")] });
    latest = config;
    return createElement(RoutingTab, { config, loadedConfig: saved, t: k => k,
      pricingLibrary: [{ id: "exact" }, { id: "another" }], updateConfig: change => setConfig(prev => {
        const next = structuredClone(prev); change(next); return next;
      }) });
  }
  const ui = renderElement(createElement(Form));
  for (const card of ui.container.querySelectorAll("details")) card.open = true;
  const fetchButton = () => ui.queryByRole("button", { name: "channel.fetchIds" });
  assert.equal(ui.getAllByRole("button", { name: "channel.fetchIds" }).length, 1);
  assert.equal(ui.getAllByRole("button", { name: "channel.addRow" }).length, 5);
  fireEvent.click(fetchButton());
  assert.match(calls[0].path, /\/api\/channels\/direct\/discover$/);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-aoai-admin-csrf"], "1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {});
  await act(async () => { resolve(); });
  const results = within(ui.getByRole("group", { name: "channel.availableIds" }));
  assert.deepEqual(latest.upstreams[0].modelMappings, []);
  assert.equal(results.getByRole("checkbox", { name: "Exact" }).disabled, true, "case-insensitive IDs never match implicitly");
  fireEvent.change(results.getByRole("combobox", { name: "channel.canonical · Exact" }), { target: { value: "another" } });
  fireEvent.click(results.getByRole("checkbox", { name: "exact" }));
  fireEvent.click(results.getByRole("checkbox", { name: "Exact" }));
  fireEvent.click(results.getByRole("button", { name: /channel.importIds/ }));
  const expected = [
    { sourceModelId: "exact", canonicalModelId: "exact", enabled: false },
    { sourceModelId: "Exact", canonicalModelId: "another", enabled: false }
  ];
  assert.deepEqual(latest.upstreams[0].modelMappings, expected);
  assert.deepEqual(latest.models, []);
  fireEvent.click(fetchButton());
  const name = within(ui.container.querySelector("#upstream-card-0")).getByRole("textbox", { name: "field.name" });
  fireEvent.change(name, { target: { value: "renamed" } });
  assert.equal(fetchButton(), null);
  assert.equal(calls[1].options.signal.aborted, true);
  await act(async () => { resolve(); });
  fireEvent.change(name, { target: { value: "direct" } });
  await waitFor(() => assert.ok(fetchButton()));
  assert.equal(ui.queryByRole("group", { name: "channel.availableIds" }), null);
  assert.deepEqual(latest.upstreams[0].modelMappings, expected);
});

test("deleting an unused legacy channel does not list models bound to another legacy channel", async () => {
  const { MemoryRouter } = await import("react-router");
  const { default: RoutingPage } = await loadAdminModule("/admin-ui/src/features/channels/RoutingPage.jsx");
  const { ConfigDraftProvider } = await loadAdminModule("/admin-ui/src/lib/config-draft.jsx");
  const initial = { upstreams: [{ name: "east" }, { name: "unused-west" }], models: [{ id: "public", upstream: "east", targetModel: "mini" }] };
  let latest;
  function Form() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return createElement(RoutingPage, { config, loadedConfig: initial, view: "channels", t: (key, fallback) => fallback || key,
      updateConfig: change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; }) });
  }
  const prompt = globalThis.window.prompt;
  globalThis.window.prompt = () => "unused-west";
  try {
    const ui = renderElement(createElement(MemoryRouter, { initialEntries: ["/channels"] },
      createElement(ConfigDraftProvider, null, createElement(Form))));
    const rowFor = name => ui.getAllByRole("row").find(row => within(row).queryByRole("button", { name }));
    fireEvent.click(within(rowFor("east")).getByRole("button", { name: "entity.delete" }));
    assert.match(ui.getByText(/ui\.references/).textContent, /public/, "a bound channel still reports its model");
    fireEvent.click(within(rowFor("unused-west")).getByRole("button", { name: "entity.delete" }));
    await waitFor(() => assert.deepEqual(latest.upstreams, [{ name: "east" }]));
    assert.deepEqual(latest.models, initial.models);
  } finally {
    globalThis.window.prompt = prompt;
  }
});
