import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

test("model stats reset requires admin auth and CSRF and preserves global, key and governance counters", async () => {
  await withTestContext(async (ctx) => {
    await ctx.primeTraffic();
    const second = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(second.status, 200, second.text);
    const before = (await ctx.adminRequest("/admin/api/stats")).json;
    assert.equal(Object.keys(before.perModel).length, 2);
    assert.ok(before.totals.totalTokens > 0);

    const unauthenticated = await ctx.request("/admin/api/stats/models/reset", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }
    });
    assert.equal(unauthenticated.status, 401, unauthenticated.text);
    const withoutCsrf = await ctx.adminRequest("/admin/api/stats/models/reset", { method: "POST" });
    assert.equal(withoutCsrf.status, 403, withoutCsrf.text);
    assert.deepEqual((await ctx.adminRequest("/admin/api/stats")).json.perModel, before.perModel);

    const reset = await ctx.adminRequest("/admin/api/stats/models/reset", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }
    });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.json.ok, true);
    assert.ok(Number.isFinite(Date.parse(reset.json.modelsResetAt)));
    const after = (await ctx.adminRequest("/admin/api/stats")).json;
    assert.deepEqual(after.perModel, {});
    assert.equal(after.modelsResetAt, reset.json.modelsResetAt);
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.perKey, before.perKey);
    assert.deepEqual(after.governance.keys, before.governance.keys);

    const logs = await ctx.adminRequest("/admin/api/logs?event=admin.model_stats_reset");
    assert.equal(logs.status, 200, logs.text);
    assert.equal(logs.json.total, 1);
    assert.equal(logs.json.items[0].fields.modelsResetAt, reset.json.modelsResetAt);

    await ctx.primeTraffic();
    const resumed = (await ctx.adminRequest("/admin/api/stats")).json;
    assert.equal(resumed.perModel["gpt-5-mini"].requests, 1);
    assert.equal(resumed.perModel["gpt-5.6-luna"], undefined);
    assert.equal(resumed.totals.requests, before.totals.requests + 1);
    assert.equal(resumed.perModel["gpt-5-mini"].billingTiers.reduce((sum, row) => sum + row.requests, 0), 1);
    assert.equal(resumed.modelsResetAt, reset.json.modelsResetAt);
  }, { logLevel: "info" });
});

test("model stats reset honors custom admin paths and always resets all models despite query filters", async () => {
  await withTestContext(async (ctx) => {
    await ctx.primeTraffic();
    const config = (await ctx.adminRequest("/admin/api/config")).json;
    config.admin.basePath = "/control-panel";
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    const reset = await ctx.adminRequest("/control-panel/api/stats/models/reset?keyId=nonexistent&timeRange=24h", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }
    });
    assert.equal(reset.status, 200, reset.text);
    const after = await ctx.adminRequest("/control-panel/api/stats");
    assert.equal(after.status, 200, after.text);
    assert.deepEqual(after.json.perModel, {});
    assert.equal(after.json.totals.requests, 1);
  });
});

test("a request already in flight can settle after a model-only reset without losing usage", { timeout: 20000 }, async () => {
  let release;
  let upstreamReceived;
  const received = new Promise((resolve) => { upstreamReceived = resolve; });
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    config.models.push({
      id: "stats-inflight", targetModel: "stats-inflight", upstream: "mock-foundry",
      pricingRef: "gpt-5-mini", routes: { "*": "chat/completions" }
    });
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    await ctx.primeTraffic();
    const pending = ctx.publicRequest("/v1/chat/completions", {
      method: "POST", json: { model: "stats-inflight", messages: [{ role: "user", content: "wait" }] }
    });
    try {
      await received;
      const before = (await ctx.adminRequest("/admin/api/stats")).json;
      assert.equal(before.perModel["stats-inflight"].requests, 1);
      const reset = await ctx.adminRequest("/admin/api/stats/models/reset", {
        method: "POST", headers: { "x-aoai-admin-csrf": "1" }
      });
      assert.equal(reset.status, 200, reset.text);
      assert.deepEqual((await ctx.adminRequest("/admin/api/stats")).json.perModel, {});
      release();
      const response = await pending;
      assert.equal(response.status, 200, response.text);
      const after = (await ctx.adminRequest("/admin/api/stats")).json;
      assert.equal(after.totals.requests, before.totals.requests);
      assert.equal(after.totals.totalTokens, before.totals.totalTokens + 9);
      assert.equal(after.perModel["stats-inflight"].totalTokens, 9);
      assert.equal(after.perModel["stats-inflight"].billingTiers[0].requests, 1);
      assert.equal(after.perModel["gpt-5-mini"], undefined);
    } finally {
      release?.();
      await pending;
    }
  }, {
    upstreamHandler({ res, body }) {
      if (body?.model !== "stats-inflight") return false;
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl-stats-inflight", object: "chat.completion", created: 1, model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 2, total_tokens: 9 }
        }));
      };
      upstreamReceived();
      return true;
    }
  });
});
