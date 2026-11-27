import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";
import { resolveChannelModels, validateMappingRows } from "../src/channel-bindings.js";
import { redactConfigSecrets, restoreConfigSecrets, restoreHistorySecrets } from "../src/admin-config.js";

test("channel mapping validation rejects ambiguous input and never uses a sibling deployment's permission", () => {
  const ids = new Set(["mini", "other"]);
  const row = { sourceModelId: "deployment", canonicalModelId: "mini", enabled: true };
  const rows = value => validateMappingRows(value, "modelMappings", ids);
  assert.throws(() => rows([row, row]), /modelMappings\[1\].*duplicates/);
  assert.throws(() => rows([row, { ...row, sourceModelId: "mini", canonicalModelId: "other" }]), /mapping chain/);
  assert.throws(() => rows([{ ...row, sourceModelId: "*" }]), /exact deployment ID/);
  assert.throws(() => rows([{ ...row, canonicalModelId: "Mini" }]), /exact Model Catalog ID/);
  assert.throws(() => rows([{ ...row, enabled: "false" }]), /must be a boolean/);
  const config = {
    upstreams: [{ name: "A", channelId: "a", modelMappings: [row] },
      { name: "B", channelId: "b", modelMappings: [{ ...row, enabled: false }] }],
    models: [{ id: "alias", canonicalModelId: "mini", selectedBinding: { channelId: "b", sourceModelId: "deployment" } }]
  };
  assert.throws(() => resolveChannelModels(config, ids), /alias.*enabled mapping/);
  config.models[0].selectedBinding.channelId = "a";
  config.models[0].clientNativeRoute = { codex: true };
  assert.throws(() => resolveChannelModels(config, ids), /confirm Harness routing/);
  config.models[0].confirmedRouteBinding = { ...config.models[0].selectedBinding };
  assert.equal(resolveChannelModels(config, ids)[0].upstream, "A");
  config.models = [{ id: "bypass", targetModel: "deployment", upstream: "B" }];
  assert.throws(() => resolveChannelModels(config, ids), /requires a selectedBinding/);
});

test("channel rename and reorder restore credentials by stable ID, including history rollback", () => {
  const original = { upstreams: ["a", "b"].map(channelId => ({ channelId, name: channelId,
    auth: { apiKey: `fixture-${channelId}` } })) };
  const draft = redactConfigSecrets(original);
  draft.upstreams.reverse();
  for (const [i, up] of draft.upstreams.entries()) up.name = original.upstreams[i].name;
  assert.deepEqual(restoreConfigSecrets(draft, original).upstreams.map(up => up.auth.apiKey), ["fixture-b", "fixture-a"]);
  assert.deepEqual(restoreHistorySecrets(draft, original).upstreams.map(up => up.auth.apiKey), ["fixture-b", "fixture-a"]);
  draft.upstreams[0].channelId = "new";
  assert.throws(() => restoreConfigSecrets(draft, original), /re-enter/);
  assert.throws(() => restoreHistorySecrets(draft, original), /Historical credentials/);
});

test("fixed channel bindings round trip through config, discovery and native JSON/SSE without expanding key access", async () => {
  await withTestContext(async ctx => {
    const config = (await ctx.adminRequest("/admin/api/config")).json;
    config.upstreams = config.upstreams.map((up, i) => ({
      ...up, channelId: `ch-${i}`, modelMappings: [
        { sourceModelId: `deployment-${i}`, canonicalModelId: "gpt-5-mini", enabled: true }
      ],
      routes: { ...up.routes, "chat/completions": `/ch-${i}/chat/completions` }
    }));
    const bind = i => ({ channelId: `ch-${i}`, sourceModelId: `deployment-${i}` });
    config.models = ["team-mini", "other-alias"].map(id => ({
      id, canonicalModelId: "gpt-5-mini", selectedBinding: bind(0)
    }));
    Object.assign(config.apiKeys[0], { modelAccessMode: "selected", allowedModels: ["team-mini"] });
    const put = json => ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json
    });
    const chat = (model, stream = false) => ctx.publicRequest("/v1/chat/completions", {
      method: "POST", json: { model, stream, messages: [{ role: "user", content: "ok" }] }
    });
    for (const [i, stream] of [[0, false], [1, true], [0, false]]) {
      config.models[0].selectedBinding = bind(i);
      const saved = await put(config);
      assert.equal(saved.status, 200, saved.text);
      if (i === 1) {
        const revision = saved.headers.get("etag").replaceAll('"', "");
        const logs = await ctx.adminRequest(`/admin/api/logs?view=operations&event=admin.model_channel_changed&connectionId=ch-0&configRevision=${revision}`);
        assert.match(logs.headers.get("cache-control"), /no-store/);
        assert.deepEqual(logs.json.items.map(x => x.fields.outcome), ["applied", "persisted"]);
        assert.equal(logs.json.items[0].fields.operationId, logs.json.items[1].fields.operationId);
        assert.ok(logs.json.items[0].fields.historyId);
        assert.equal(logs.json.items[0].fields.channelId, "ch-1");
        assert.notEqual(logs.json.items[0].fields.eventUid, logs.json.items[1].fields.eventUid);
      }
      for (const model of [saved.json.config.models[0], (await ctx.readConfigFile()).models[0]]) {
        assert.deepEqual(model.selectedBinding, bind(i));
        assert.equal(Object.hasOwn(model, "targetModel"), false);
        assert.equal(Object.hasOwn(model, "upstream"), false);
      }
      const result = await chat("team-mini", stream);
      assert.equal(result.status, 200, result.text);
      assert.equal(ctx.getUpstreamRequest().body.model, `deployment-${i}`);
      assert.equal(ctx.getUpstreamRequest().url, `/ch-${i}/chat/completions`);
      if (stream) {
        assert.match(result.text, /"model":"team-mini"/);
        assert.match(result.text, /data: \[DONE\]/);
      } else assert.equal(result.json.model, "team-mini");
    }
    const ids = async () => (await ctx.publicRequest("/v1/models")).json.data.map(m => m.id);
    assert.deepEqual(await ids(), ["team-mini"]);
    ctx.clearUpstreamRequests();
    for (const [model, status] of [["other-alias", 403], ["deployment-0", 404], ["TEAM-MINI", 404], ["gpt-5-mini", 404]]) {
      assert.equal((await chat(model)).status, status, model);
    }
    config.apiKeys[0].allowedModels = [];
    assert.equal((await put(config)).status, 200);
    assert.deepEqual(await ids(), []);
    assert.equal((await chat(undefined)).status, 403);
    config.upstreams[0].modelMappings[0].enabled = false;
    assert.equal((await put(config)).status, 400);
    assert.equal(ctx.upstreamRequests.length, 0);
    delete config.apiKeys[0].modelAccessMode;
    config.upstreams[0].modelMappings[0].enabled = true;
    assert.equal((await put(config)).json.config.apiKeys[0].modelAccessMode, "selected");
    assert.deepEqual(await ids(), []);
    config.apiKeys[0].modelAccessMode = "all";
    assert.equal((await put(config)).status, 200);
    assert.deepEqual(await ids(), ["team-mini", "other-alias"]);
    for (const address of [{ baseUrl: "https://api.githubcopilot.com" },
      { routes: { "chat/completions": "https://example.githubcopilot.com/chat/completions" } },
      { routes: { "chat/completions": "//api.githubcopilot.com/chat/completions" } }]) {
      const bad = structuredClone(config);
      Object.assign(bad.upstreams[0], address);
      const result = await put(bad);
      assert.equal(result.status, 400);
      assert.match(result.text, /require an authorized github-copilot channel/);
    }
    assert.equal(ctx.upstreamRequests.length, 0);
    for (const edit of [
      candidate => { candidate.apiKeys[0].allowedModels = ["team-mini"]; },
      candidate => { candidate.models[0].upstream = candidate.upstreams[0].name; },
      candidate => { candidate.upstreams[0].provider = "github-copilot"; },
      candidate => {
        candidate.models.forEach(model => { model.canonicalModelId = "gpt-5-nano"; });
        candidate.upstreams[0].modelMappings[0].canonicalModelId = "gpt-5-nano";
      }
    ]) {
      const bad = structuredClone(config);
      edit(bad);
      assert.equal((await put(bad)).status, 400);
    }
    assert.deepEqual(await ids(), ["team-mini", "other-alias"]);
  });
});

test("legacy keys retain catalog order; a new API-created key defaults to selected without widening on removal", async () => {
  await withTestContext(async ctx => {
    const before = (await ctx.publicRequest("/v1/models")).json.data.map(m => m.id);
    const original = await ctx.readConfigFile();
    assert.deepEqual(before, original.models.filter(m => m.status !== "disabled").map(m => m.id));
    const config = (await ctx.adminRequest("/admin/api/config")).json;
    const put = json => ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json });
    const invalid = structuredClone(config);
    invalid.apiKeys[0].allowedModels = before[0];
    assert.equal((await put(invalid)).status, 400);
    config.apiKeys.push({ id: "restricted", key: "channel-fixture" });
    const saved = await put(config);
    assert.equal(saved.status, 200, saved.text);
    const fresh = saved.json.config.apiKeys.at(-1);
    assert.equal(fresh.modelAccessMode, "selected");
    const headers = { authorization: "Bearer channel-fixture" };
    assert.deepEqual((await ctx.request("/v1/models", { headers })).json.data, []);
    assert.deepEqual((await ctx.publicRequest("/v1/models")).json.data.map(m => m.id), before);
    fresh.allowedModels = [before[0]];
    assert.equal((await put(saved.json.config)).status, 200);
    saved.json.config.models = saved.json.config.models.filter(m => m.id !== before[0]);
    const rejected = await put(saved.json.config);
    assert.equal(rejected.status, 400);
    assert.match(rejected.text, /restricted.*unpublished/);
    fresh.allowedModels = [];
    assert.equal((await put(saved.json.config)).status, 200);
  });
});

test("in-flight usage, terminal/error logs and channel totals keep the binding's applied revision", async () => {
    const arrived = Promise.withResolvers(), release = Promise.withResolvers();
    await withTestContext(async ctx => {
      const config = (await ctx.adminRequest("/admin/api/config")).json;
      for (const [i, up] of config.upstreams.entries()) {
        up.channelId = `c${i}`;
        up.modelMappings = [{ sourceModelId: `d${i}`, canonicalModelId: "gpt-5-mini", enabled: true }];
      }
      const bind = i => ({ channelId: `c${i}`, sourceModelId: `d${i}` });
      config.models = ["one", "two"].map(id => ({ id, canonicalModelId: "gpt-5-mini", selectedBinding: bind(0) }));
      Object.assign(config.apiKeys[0], { modelAccessMode: "selected", allowedModels: ["one", "two"] });
      const save = async () => {
        const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
        assert.equal(saved.status, 200, saved.text);
        return saved.headers.get("etag").replaceAll('"', "");
      };
      const chat = (model, requestId) => ctx.publicRequest("/v1/chat/completions", { method: "POST",
        headers: { "x-request-id": requestId }, json: { model, messages: [{ role: "user", content: "tokens" }] } });
      const old = await save();
      assert.equal((await chat("two", "first")).status, 200);
      const pending = chat("one", "held");
      try {
        await Promise.race([arrived.promise, pending.then(result => { throw new Error(result.text); })]);
        config.upstreams[0].name = "renamed-east";
        config.models[0].selectedBinding = bind(1);
        const next = await save();
        assert.notEqual(old, next);
        release.resolve();
        assert.equal((await pending).status, 200);
        assert.equal((await chat("one", "switched")).status, 200);
        assert.equal((await chat("one", "nope")).status, 400);
        const snapshot = (await ctx.adminRequest(`/admin/api/stats?timeRange=24h&keyId=${config.apiKeys[0].id}`)).json;
        const [model] = snapshot.canonicalModels;
        assert.equal(model.canonicalModelId, "gpt-5-mini");
        assert.deepEqual([model.requests, model.errors, model.promptTokens, model.completionTokens], [4, 1, 20000, 5000]);
        const byChannel = Object.fromEntries(model.channels.map(row => [row.channelId, [row.requests, row.errors, row.totalTokens]]));
        assert.deepEqual(byChannel, { c0: [2, 0, 15000], c1: [2, 1, 10000] });
        for (const [requestId, channelId, sourceModelId, revision] of [["held", "c0", "d0", old], ["switched", "c1", "d1", next], ["nope", "c1", "d1", next]]) {
          const log = (await ctx.adminRequest(`/admin/api/logs?view=requests&requestId=${requestId}&channelId=${channelId}`)).json.items[0];
          assert.ok(log, requestId);
          assert.deepEqual([log.channelId, log.canonicalModelId, log.sourceModelId, log.configRevision], [channelId, "gpt-5-mini", sourceModelId, revision]);
          for (const event of log.events.filter(entry => entry.event.startsWith("proxy."))) {
            assert.equal(event.configRevision, revision, event.event);
          }
        }
        config.apiKeys[0].allowedModels = ["two"];
        await save();
        assert.equal((await chat("one", "denied")).status, 403);
        assert.deepEqual((await ctx.adminRequest("/admin/api/logs?view=requests&requestId=denied&channelId=c1")).json.items, []);
        assert.equal(ctx.upstreamRequests.length, 4);
      } finally { release.resolve(); await pending; }
    }, { logLevel: "info", upstreamHandler: async ({ req, res }) => {
      const id = req.headers["x-request-id"];
      if (id === "held") { arrived.resolve(); await release.promise; }
      res.writeHead(id === "nope" ? 400 : 200, { "content-type": "application/json" });
      const prompt = id === "first" ? 4000 : 8000, completion = prompt / 4;
      res.end(JSON.stringify(id === "nope" ? { error: { message: "mock rejection" } } : { id: "local", model: "reported",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } }));
      return true;
    } });
});
