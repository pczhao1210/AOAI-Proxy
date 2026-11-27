import assert from "node:assert/strict";
import test from "node:test";
import { copilotIdentityHeaders, createCopilotTransport, discoveryModels } from "../src/copilot-provider.js";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { withTestContext } from "./lib/harness.js";
import { CopilotRuntime } from "../src/copilot-runtime.js";
import { approveCopilotSelection } from "../src/copilot-approval.js";

test("direct OAuth never exchanges a token; exchange profile requires real lifetime evidence", async () => {
  const calls = [];
  const transport = createCopilotTransport({
    env: {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ token: "short" });
    }
  });
  const oauth = { accessToken: "fixture" };
  assert.equal((await transport.inferenceCredential("opencode", oauth)).token, "fixture");
  assert.equal(calls.length, 0);
  await assert.rejects(transport.inferenceCredential("vscode", oauth), { code: "COPILOT_TOKEN_METADATA_INVALID" });
  assert.equal(calls[0].url, "https://api.github.com/copilot_internal/v2/token");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(calls[0].options.headers, { accept: "application/json", authorization: "token fixture",
    "user-agent": "GitHubCopilotChat/0.38.2", "editor-version": "vscode/1.110.1", "editor-plugin-version": "copilot-chat/0.38.2" });
});

test("selected profile supplies the reference client identity; environment IDs only override it", async () => {
  const device = { device_code: "d", user_code: "U", verification_uri: "https://github.com/login/device", expires_in: 60 };
  const run = async (env, profile) => {
    const calls = [];
    const transport = createCopilotTransport({ env, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(url.endsWith("/models") ? { data: [] } : device);
    } });
    await transport.start(profile);
    await transport.discover(profile, { token: "inference" });
    return calls;
  };
  const [vsLogin, vsModels] = await run({}, "vscode");
  assert.equal(vsLogin.options.body, "client_id=Iv1.b507a08c87ecfe98&scope=read%3Auser");
  assert.equal(vsLogin.options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(vsLogin.options.headers["user-agent"], "GitHubCopilotChat/0.38.2");
  assert.equal(vsModels.options.headers["copilot-integration-id"], "vscode-chat");
  assert.equal(vsModels.options.headers["x-github-api-version"], "2025-10-01");
  const [ocLogin, ocModels] = await run({ COPILOT_OPENCODE_CLIENT_ID: " " }, "opencode");
  assert.deepEqual(JSON.parse(ocLogin.options.body), { client_id: "Ov23li8tweQw6odWQebz", scope: "read:user" });
  assert.equal(ocLogin.options.headers["content-type"], "application/json");
  assert.equal(ocLogin.options.headers["user-agent"], "opencode/1.0.0");
  assert.deepEqual(Object.keys(ocModels.options.headers).filter(key => /editor|integration|intent/.test(key)), []);
  const [overridden] = await run({ COPILOT_VSCODE_CLIENT_ID: "owned-app" }, "vscode");
  assert.equal(new URLSearchParams(overridden.options.body).get("client_id"), "owned-app");
  await assert.rejects(run({ COPILOT_VSCODE_CLIENT_ID: "Ov23li8tweQw6odWQebz" }, "vscode"), { code: "COPILOT_APPLICATION_NOT_CONFIGURED" });
  assert.equal(copilotIdentityHeaders("opencode")["openai-intent"], "conversation-edits");
  assert.equal(copilotIdentityHeaders("vscode")["copilot-integration-id"], undefined);
});

test("discovery cannot substitute a name, duplicate, or unsupported endpoint for provider evidence", () => {
  const models = discoveryModels({ data: [
    { id: "A", supported_endpoints: ["/v1/messages"] },
    { id: "B", model_picker_enabled: false, supported_endpoints: ["/v1/messages"] },
    { id: "C", supported_endpoints: ["https://untrusted.invalid/messages"] }
  ] });
  assert.deepEqual(models.map(m => m.selectable), [true, false, false]);
  assert.equal(models[0].routes.responses, "messages");
  assert.throws(() => discoveryModels({ data: [{ id: "x" }, { id: "x" }] }), { code: "COPILOT_DISCOVERY_INVALID" });
});

test("pending and slow_down schedule polls independently of status; cancellation fences late success", async () => {
  const waits = [];
  let release, reached, count = 0, touchedStore = false;
  const entered = new Promise(resolve => { reached = resolve; });
  const ref = { channelId: "test", profile: "opencode" };
  const runtime = new CopilotRuntime({ now: () => 10, wait: async ms => { waits.push(ms); },
    storage: async () => ({ prepare: async () => { touchedStore = true; } }),
    transport: { application: () => "own", start: async () => ({ interval: 1000, expiresAt: 60010 }),
      poll: async () => {
        count++;
        if (count === 1) return { pending: "authorization_pending" };
        if (count === 2) return { pending: "slow_down" };
        reached();
        return new Promise(r => { release = r; });
      } }
  });
  runtime.apply({ upstreams: [] });
  try {
    const login = await runtime.login(ref.channelId, ref.profile);
    await entered;
    for (let i = 0; i < 10; i++) assert.equal((await runtime.status(ref, login.operationId)).state, "pending");
    runtime.cancel(ref, login.operationId);
    release({ accessToken: "fixture" });
    await Promise.all([...runtime.work]);
    assert.deepEqual(waits, [1000, 1000, 6000]);
    assert.equal(touchedStore, false);
    assert.equal((await runtime.status(ref, login.operationId)).state, "cancelled");
  } finally { await runtime.close(); }
});

test("30 concurrent admissions share one refresh and do not invent expiry for direct OAuth", async () => {
  let renewals = 0;
  const now = 100000;
  const ref = { channelId: "one", profile: "vscode", credentialRef: "candidate" };
  let row = { credentialVersion: 1, state: "active", secrets: { applicationId: "own",
    oauth: { accessToken: "fixture", issuedAt: 20, expiresAt: null },
    inference: { token: "old", issuedAt: 0, expiresAt: now + 6000 } } };
  const store = { read: async () => row, refresh: async (_ref, _row, run) => {
    const secrets = await run(new AbortController().signal);
    return row = { ...row, credentialVersion: 2, secrets };
  } };
  const rt = new CopilotRuntime({ now: () => now, storage: async () => store, transport: {
    application: () => "own", inferenceCredential: async () => {
      renewals++;
      await sleep(10);
      return { token: "renewed", issuedAt: now, expiresAt: now + 600000 };
    }
  } });
  try {
    const result = await Promise.all(Array.from({ length: 31 }, () => rt.credential(ref)));
    assert.equal(renewals, 1);
    assert.ok(result.every(item => item.secrets.inference.token === "renewed"));
    assert.equal(row.secrets.oauth.expiresAt, null);
  } finally { await rt.close(); }
});

test("cold restore requires signed grants and isolates legacy encrypted credentials", async () => {
  const routes = { messages: "messages", responses: "messages", "chat/completions": "messages" };
  const row = { enabled: true, sourceModelId: "deployment", canonicalModelId: "canonical", routes };
  const up = { channelId: "one", provider: "github-copilot", auth: { credentialRef: "ref" },
    copilot: { authProfile: "vscode" }, modelMappings: [row] };
  const models = [{ id: "ordinary", status: "active" }, { id: "alias", canonicalModelId: "canonical",
    selectedBinding: { channelId: "one", sourceModelId: "deployment" } }];
  const config = { upstreams: [up], models };
  const key = "test-key";
  up.copilot.approval = approveCopilotSelection(key, up, models, null, { state: "fresh", at: 1,
    models: [{ id: "deployment", selectable: true, routes }] }, 1);
  let available = true;
  const rt = new CopilotRuntime({ transport: { application: () => "own" }, storage: async () => ({
    read: async () => {
      if (!available) throw Object.assign(new Error(), { code: "COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED" });
      return { secrets: { approvalKey: key, applicationId: "own" } };
    }
  }) });
  try {
    assert.equal(await rt.restore(structuredClone(config), true), false);
    for (const tamper of [proof => { delete proof.grant; }, proof => { proof.models.alias = "not-a-grant"; }]) {
      const forged = structuredClone(config);
      tamper(forged.upstreams[0].copilot.approval);
      await assert.rejects(rt.restore(forged, true), { code: /^COPILOT_(GRANT_INVALID|DISCOVERY_STALE)$/ });
    }
    available = false;
    await assert.rejects(rt.restore(structuredClone(config), false), { code: "COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED" });
    const cold = structuredClone(config);
    assert.equal(await rt.restore(cold, true), true);
    assert.deepEqual(cold.models.map(m => m.status), ["active", "disabled"]);
    assert.notEqual(config.models[1].status, "disabled");
    await rt.activateChanges(cold);
    rt.apply(cold);
    assert.equal(rt.active.size, 0);
    const status = await rt.status({ channelId: up.channelId, profile: up.copilot.authProfile, credentialRef: up.auth.credentialRef });
    assert.equal(status.state, "reauth-required");
    assert.equal(status.errorCode, "COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED");
  } finally { await rt.close(); }
});

test("status distinguishes expired, rejected, renewed and revoked direct credentials without network traffic", async () => {
  const ref = { channelId: "one", profile: "opencode", credentialRef: "test-ref" };
  const now = 100000;
  const row = { state: "active", credentialVersion: 1,
    secrets: { applicationId: "own", oauth: {}, inference: { token: "fixture", expiresAt: now } } };
  let revoked = false;
  const rt = new CopilotRuntime({ now: () => now, transport: { application: () => "own" }, storage: async () => ({
    read: async () => {
      if (revoked) throw Object.assign(new Error(), { code: "COPILOT_AUTH_REQUIRED" });
      return row;
    }
  }) });
  try {
    assert.equal((await rt.status(ref)).state, "reauth-required");
    row.secrets.inference.expiresAt = null;
    rt.entry(ref).rejectedVersion = row.credentialVersion;
    rt.setError(ref, "COPILOT_AUTH_REQUIRED");
    assert.equal((await rt.status(ref)).state, "reauth-required");
    row.credentialVersion++;
    const renewed = await rt.status(ref);
    assert.equal(renewed.state, "authorized");
    assert.equal(renewed.errorCode, null);
    revoked = true;
    assert.equal((await rt.status(ref)).state, "reauth-required");
  } finally { await rt.close(); }
});

for (const profile of ["vscode", "opencode"]) test(`offline ${profile}: durable login → approval → public inference → switch out → disconnect`, async () => {
  await withTestContext(async ctx => {
    const endpoint = "/admin/api/copilot/test-channel";
    const post = (action, other = {}) => ctx.adminRequest(`${endpoint}/${action}`, {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }, json: { profile, ...other }
    });
    const save = json => ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json });
    const login = await post("login");
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.userCode, "fixture-user-code");
    let status;
    for (let i = 0; i < 80; i++) {
      status = (await ctx.adminRequest(`${endpoint}/status?profile=${profile}&operationId=${login.json.operationId}`)).json;
      if (status.discovery?.state === "fresh" || status.state === "failed") break;
      await sleep(100);
    }
    assert.equal(status.discovery?.state, "fresh", JSON.stringify(status));
    const { credentialRef } = status;
    const cfg = (await ctx.adminRequest("/admin/api/config")).json;
    const up = { name: "test-copilot", channelId: "test-channel", provider: "github-copilot", copilot: { authProfile: profile },
      baseUrl: "https://api.githubcopilot.com", auth: { mode: "githubCopilot", credentialRef },
      retryProfile: { statuses: [401], maxRetries: 1 },
      routes: { "chat/completions": "/chat/completions" }, modelMappings: [] };
    const row = { enabled: true, sourceModelId: "not-approved", canonicalModelId: "gpt-5-mini", routes: status.discovery.models[0].routes };
    up.modelMappings.push(row);
    cfg.upstreams.push(up);
    assert.equal((await save(cfg)).json.code, "COPILOT_MODEL_NOT_ENABLED");
    row.sourceModelId = "original";
    cfg.models.push({ id: "offline-alias", canonicalModelId: row.canonicalModelId,
      selectedBinding: { channelId: up.channelId, sourceModelId: row.sourceModelId } });
    const saved = await save(cfg);
    assert.equal(saved.status, 200, saved.text);
    const response = await ctx.publicRequest("/v1/chat/completions", { method: "POST", headers: { "editor-version": "untrusted" },
      json: { model: "offline-alias", messages: [{ role: "user", content: "test" }] } });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.model, "offline-alias");
    assert.equal(response.json.id, "from-copilot-fixture");
    await ctx.restartProxy();
    const stream = await ctx.publicRequest("/v1/chat/completions", { method: "POST",
      json: { stream: true, model: "offline-alias", messages: [{ role: "user", content: "test" }] } });
    assert.equal(stream.status, 200, stream.text);
    assert.match(stream.text, /"model":"offline-alias"/);
    assert.match(stream.text, /data: \[DONE\]/);
    const stale = structuredClone(cfg);
    stale.models.push({ ...stale.models.at(-1), id: "unapproved-alias" });
    assert.equal((await save(stale)).json.code, "COPILOT_DISCOVERY_STALE");
    assert.equal((await post("disconnect", { credentialRef })).json.code, "COPILOT_MODEL_IN_USE");
    if (profile === "vscode") for (const stream of [false, true]) {
      const requestId = `reject-once-${stream}`;
      const rejected = await ctx.publicRequest("/v1/chat/completions", { method: "POST",
        headers: { "x-request-id": requestId },
        json: { stream, model: "offline-alias", messages: [{ role: "user", content: "reject-once" }] } });
      assert.equal(rejected.status, 401, rejected.text);
      const history = await ctx.adminRequest(`/admin/api/logs?view=operations&event=proxy.copilot_auth_required&requestId=${requestId}`);
      assert.equal(history.json.items[0]?.fields.trigger, "request");
    }
    cfg.models.pop();
    assert.equal((await save(cfg)).status, 200);
    assert.equal((await post("disconnect", { credentialRef })).status, 200);
    const diagnostics = JSON.stringify([await ctx.readConfigFile(), (await ctx.adminRequest("/admin/api/logs")).json]);
    assert.doesNotMatch(diagnostics, /fixture-user-code|device-fixture-private|fixture-oauth-private|fixture-exchanged-private/);
  }, { proxyArgs: ["--import", "./test/lib/copilot-fixture.js", "src/server.js"],
    proxyEnv: { COPILOT_FIXTURE_PROFILE: profile, COPILOT_VSCODE_CLIENT_ID: "", COPILOT_OPENCODE_CLIENT_ID: "" } });
});
