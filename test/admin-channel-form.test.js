import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { waitFor, within } from "@testing-library/dom";
import { fireEvent, loadAdminModule, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";
import { resolveChannelModels } from "../src/channel-bindings.js";

setupWorkspaceFormTests();

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
  const { default: KeysTab } = await loadAdminModule("/admin-ui/src/components/KeysTab.jsx");
  let latest;
  function Form() {
    const [config, setConfig] = useState({ models: [{ id: "published" }], apiKeys: [{ id: "team", allowedModels: ["removed"] }] });
    latest = config;
    return createElement(KeysTab, { config, t: (key, fallback) => fallback || key,
      updateConfig: change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; }) });
  }
  const ui = renderElement(createElement(Form));
  ui.container.querySelector("details").open = true;
  fireEvent.click(ui.getByRole("checkbox", { name: /removed/ }));
  assert.equal(latest.apiKeys[0].modelAccessMode, "selected");
  assert.deepEqual(latest.apiKeys[0].allowedModels, []);
  fireEvent.click(ui.getByRole("checkbox", { name: "published" }));
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
