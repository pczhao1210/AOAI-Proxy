import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { waitFor, within } from "@testing-library/dom";
import { newCopilotChannel } from "../admin-ui/src/copilot.js";
import { fireEvent, loadAdminModule, renderElement, setupWorkspaceFormTests } from "./lib/admin-workspace-form.js";

setupWorkspaceFormTests();

test("Copilot admin-auth rejection explains the prerequisite and links to security settings", async ctx => {
  const { MemoryRouter } = await import("react-router");
  const { default: CopilotChannel } = await loadAdminModule("/admin-ui/src/components/CopilotChannel.jsx");
  ctx.mock.method(globalThis, "fetch", async () => Response.json({
    code: "COPILOT_ADMIN_AUTH_REQUIRED", error: "COPILOT_ADMIN_AUTH_REQUIRED"
  }, { status: 403 }));
  const ui = renderElement(createElement(MemoryRouter, null, createElement(CopilotChannel, {
    up: newCopilotChannel("test", "Test"), definitions: [], referenced: [], updateConfig() {}, onEvidence() {}, t: key => key
  })));
  await ui.findByText(/copilot.adminAuthRequired/);
  assert.equal(ui.getByRole("link", { name: "shell.settings.service" }).getAttribute("href"), "/settings/service");
  assert.equal(ui.getByRole("button", { name: "copilot.login" }).disabled, true);
  assert.equal(ui.getByRole("button", { name: "copilot.status" }).disabled, false);
});

const routes = { messages: "messages", responses: "messages", "chat/completions": "messages" };
const idle = { state: "idle", discovery: { state: "not_loaded", models: [] } };
const authorized = {
  state: "authorized", credentialRef: "ref-a", discovery: {
    state: "fresh", updatedAt: new Date().toISOString(), models: [
      { id: "exact", name: "Exact", selectable: true, routes },
      { id: "different-deployment", name: "canonical", selectable: true, routes },
      { id: "blocked", name: "Blocked", selectable: false, routes },
      { id: "no-routes", name: "Incomplete", selectable: true }
    ]
  }
};

function fakeApi(ctx, handle) {
  const calls = [];
  window.history.replaceState(null, "", "/private-admin/");
  ctx.mock.method(globalThis, "fetch", async (path, options) => {
    const url = new URL(path, "http://localhost");
    const action = url.pathname.split("/").at(-1);
    const body = options.body && JSON.parse(options.body);
    calls.push({ action, url, body, options });
    const value = await handle(action, body, url.searchParams);
    return Response.json(value);
  });
  return calls;
}

async function form(upstreams) {
  const { default: RoutingTab } = await loadAdminModule("/admin-ui/src/components/RoutingTab.jsx");
  let latest;
  const initial = { upstreams, models: [], apiKeys: [] };
  function Form() {
    const [config, setConfig] = useState(initial);
    const [drafts, setDrafts] = useState({});
    latest = config;
    return createElement(RoutingTab, { config,
      pricingLibrary: ["exact", "canonical", "blocked", "no-routes"].map(id => ({ id })),
      updateConfig: change => setConfig(prev => { const next = structuredClone(prev); change(next); return next; }),
      mappingDrafts: drafts, setMappingDrafts: setDrafts, t: key => key });
  }
  const ui = renderElement(createElement(Form));
  const card = i => {
    const details = ui.container.querySelector(`#upstream-card-${i}`);
    details.open = true;
    return within(details);
  };
  return { ui, card, config: () => latest };
}

test("only fresh selectable Copilot discoveries with exact or explicit Catalog IDs enable mappings and exposure", async ctx => {
  const expiry = Date.now() + 600000;
  let state = { ...authorized, expiresAt: expiry, renewable: false };
  const calls = fakeApi(ctx, action => action === "discover" ? { ok: true } : state);
  const copilot = newCopilotChannel("safe/id", "GitHub");
  copilot.auth.credentialRef = "ref-a";
  const ordinary = { channelId: "ordinary", name: "Ordinary", modelMappings: [] };
  const { ui, card, config } = await form([copilot, ordinary]);
  const fields = card(0);
  const check = name => fields.getByRole("checkbox", { name });
  await fields.findByRole("checkbox", { name: /different-deployment/ });
  assert.ok(fields.getByText(new Date(expiry).toISOString()));
  assert.ok(fields.getByText(/copilot.loginNeeded/));
  assert.equal(fields.queryByRole("button", { name: "channel.json" }), null);
  assert.ok(card(1).getByRole("button", { name: "channel.json" }));
  assert.equal(fields.getByRole("textbox", { name: "field.baseUrl" }).readOnly, true);
  assert.equal(fields.queryByRole("combobox", { name: "field.upstreamAuthMode" }), null);
  assert.deepEqual(config().upstreams[0].modelMappings, []);
  assert.equal(check(/different-deployment/).disabled, true, "display name is not an implicit mapping");
  assert.equal(check(/blocked/).disabled, true);
  assert.equal(check(/no-routes/).disabled, true);
  fireEvent.change(fields.getByRole("combobox", { name: /channel.canonical · different-deployment/ }), { target: { value: "canonical" } });
  fireEvent.click(check(/different-deployment/));
  fireEvent.click(check(/exact · Exact/));
  const expected = ["different-deployment", "exact"].map((id, i) => ({
    sourceModelId: id, canonicalModelId: i ? id : "canonical", routes, enabled: true
  }));
  assert.deepEqual(config().upstreams[0].modelMappings, expected);
  assert.deepEqual(config().models, []);
  const exposed = within(ui.container.querySelector("#routing-models"));
  fireEvent.click(exposed.getByRole("checkbox", { name: "exact" }));
  const publish = () => exposed.getByRole("button", { name: /channel.publish/ });
  assert.equal(publish().disabled, false);

  state = { ...authorized, discovery: { ...authorized.discovery, state: "stale" } };
  fireEvent.click(fields.getByRole("button", { name: "copilot.discover" }));
  await fields.findByText(/copilot.state.stale/);
  assert.equal(exposed.getByRole("checkbox", { name: "exact" }).disabled, true);
  assert.equal(publish().disabled, true);
  assert.deepEqual(config().upstreams[0].modelMappings, expected, "refresh never modifies a saved approval");
  fireEvent.click(check(/exact · Exact/));
  assert.equal(check(/exact · Exact/).disabled, true, "stale rows may be disabled, not re-enabled");
  assert.deepEqual(calls.map(c => c.action), ["status", "discover", "status"]);
  assert.equal(calls[0].url.pathname, "/private-admin/api/copilot/safe%2Fid/status");
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[0].url.searchParams.get("credentialRef"), "ref-a");
  assert.equal(calls[1].options.headers["x-aoai-admin-csrf"], "1");
  assert.deepEqual(calls[1].body, { profile: "vscode", credentialRef: "ref-a" });
});

test("Copilot login, scoped status and disconnect pass only an opaque credential reference into the draft", async ctx => {
  let state = idle;
  const calls = fakeApi(ctx, (action, body) => {
    if (action === "login") {
      state = { ...idle, state: "pending", operationId: "op-1" };
      return { operationId: "op-1", userCode: "CODE-FORM", verificationUri: "https://github.com/login/device",
        expiresAt: new Date(Date.now() + 60000).toISOString(), accessToken: "never-copy" };
    }
    if (action === "disconnect") { state = { ...idle, state: "disconnected" }; return { ok: true }; }
    return state;
  });
  const { card, config } = await form([newCopilotChannel("a", "GitHub")]);
  const fields = card(0);
  const button = name => fields.getByRole("button", { name });
  await fields.findByText(/copilot.state.idle/);
  fireEvent.change(fields.getByRole("combobox", { name: /copilot.profile/ }), { target: { value: "opencode" } });
  await waitFor(() => assert.equal(calls.at(-1).url.searchParams.get("profile"), "opencode"));
  await waitFor(() => assert.equal(button("copilot.login").disabled, false));
  fireEvent.click(button("copilot.login"));
  await fields.findByText("CODE-FORM");
  assert.equal(fields.getByRole("link", { name: "copilot.verify" }).href, "https://github.com/login/device");
  await waitFor(() => assert.equal(button("copilot.status").disabled, false));
  assert.equal(calls.at(-1).url.searchParams.get("operationId"), "op-1");
  assert.equal(JSON.stringify(config()).includes("CODE-FORM"), false);
  state = { ...authorized, operationId: "op-1", accessToken: "never-copy" };
  fireEvent.click(button("copilot.status"));
  await waitFor(() => assert.deepEqual(config().upstreams[0].auth, { mode: "githubCopilot", credentialRef: "ref-a" }));
  await fields.findByText(/copilot.state.authorized/);
  assert.equal(fields.queryByText("CODE-FORM"), null);
  assert.doesNotMatch(JSON.stringify(config()), /never-copy|CODE-FORM|op-1/);
  assert.deepEqual(config().models, []);
  assert.deepEqual(config().upstreams[0].modelMappings, []);
  ctx.mock.method(window, "confirm", () => true);
  fireEvent.click(button("copilot.disconnect"));
  await waitFor(() => assert.equal(config().upstreams[0].auth.credentialRef, undefined));
  assert.deepEqual(calls.find(c => c.action === "disconnect").body, { profile: "opencode", credentialRef: "ref-a" });
  assert.ok(calls.every(c => c.url.pathname.startsWith("/private-admin/api/copilot/a/")));
});

test("cancelling while a scoped status read is in flight fences out a late authorization", async ctx => {
  const { act } = await import("@testing-library/react/pure.js");
  let late;
  let state = idle;
  const calls = fakeApi(ctx, (action, _body, params) => {
    if (action === "login") return { operationId: "op-old", userCode: "ONCE", verificationUri: "https://github.com/login/device",
      expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (action === "cancel") { state = { ...idle, state: "cancelled" }; return { ok: true }; }
    if (params.get("operationId")) return new Promise(resolve => { late = resolve; });
    return state;
  });
  const { card, config } = await form([newCopilotChannel("a", "GitHub")]);
  const fields = card(0);
  await fields.findByText(/copilot.state.idle/);
  fireEvent.click(fields.getByRole("button", { name: "copilot.login" }));
  await fields.findByText("ONCE");
  fireEvent.click(fields.getByRole("button", { name: "copilot.cancel" }));
  await fields.findByText(/copilot.state.cancelled/);
  await act(async () => { late({ ...authorized, operationId: "op-old" }); });
  assert.deepEqual(config().upstreams[0].auth, { mode: "githubCopilot" });
  assert.ok(fields.getByText(/copilot.state.cancelled/));
  assert.equal(fields.queryByText("ONCE"), null);
  assert.deepEqual(calls.find(c => c.action === "cancel").body, { profile: "vscode", operationId: "op-old" });
});
