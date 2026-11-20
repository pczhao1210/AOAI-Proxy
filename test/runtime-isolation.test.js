import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { buildPostgresPoolOptions, closeSharedPostgresPools, getSharedPostgresPool, quoteIdentifier } from "../src/postgres.js";
import * as store from "../src/runtime-store.js";
import { acquireRequestGovernance, getGovernanceSnapshot } from "../src/governance.js";
import { createTestContext } from "./lib/harness.js";

const databaseUrl = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
const gate = { skip: !databaseUrl, timeout: 30000 };
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function bounded(promise, message) {
  const timeout = AbortSignal.timeout(3000);
  return Promise.race([promise, new Promise((_, reject) => {
    timeout.addEventListener("abort", () => reject(new Error(message)), { once: true });
  })]);
}

test("slow read-only statistics do not block writers, reset fencing or cold-key admission", gate, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-runtime-read-"));
  const schema = `reader_${process.pid}_${Date.now()}`;
  const previous = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = databaseUrl;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const key = { id: `${schema}_key`, budget: { limitAmount: 5 } };
  const config = {
    persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json"), database: { pool: { max: 1 } } } },
    observability: { runtimeStore: { schema, flushIntervalMs: 60000 } },
    apiKeys: [key]
  };
  let pause;
  t.after(async () => {
    pause?.release.resolve();
    store.setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema, "test schema")} CASCADE`);
    await admin.end();
    if (previous === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  store.setRuntimeStoreConfig(config);
  store.recordRuntimeRequest(config, { keyId: key.id, modelId: "model" });
  store.recordRuntimeUsage(config, { keyId: key.id, modelId: "model", totalTokens: 3, estimatedCostAmount: 6 });
  assert.equal((await store.drainRuntimeEvents()).flushed, 2);
  const reader = getSharedPostgresPool({
    ...buildPostgresPoolOptions({ connectionString: databaseUrl }), max: 2, min: 0, connectionTimeoutMillis: 3000
  }, "runtime-reader");
  const connect = reader.connect.bind(reader);
  t.mock.method(reader, "connect", async () => {
    const client = await connect();
    return {
      async query(sql, ...args) {
        if (pause?.matches(sql) && !pause.used) {
          const current = pause;
          current.used = true;
          current.entered.resolve();
          await current.release.promise;
        }
        return client.query(sql, ...args);
      },
      release: error => client.release(error)
    };
  });
  const hold = matches => {
    pause = { matches, entered: deferred(), release: deferred(), used: false };
    return pause;
  };
  const first = hold(sql => sql.startsWith("SELECT meta_value"));
  const snapshot = store.getRuntimeStatsSnapshot(config, {}, { readOnly: true });
  await bounded(first.entered.promise, "Reader did not start");
  store.recordRuntimeRequest(config, { keyId: key.id, modelId: "model" });
  assert.equal((await bounded(store.flushRuntimeEvents(), "Slow reader blocked the writer")).flushed, 1);
  first.release.resolve();
  assert.equal((await snapshot).totals.requests, 1, "All statistics queries use the same transaction snapshot");
  assert.equal((await store.getRuntimeStatsSnapshot(config, {}, { readOnly: true })).totals.requests, 2);

  const reset = hold(sql => sql.startsWith("SELECT meta_value"));
  const stale = store.getRuntimeStatsSnapshot(config, {}, { readOnly: true });
  const rejected = assert.rejects(stale, { code: "RUNTIME_STATS_SNAPSHOT_STALE" });
  await bounded(reset.entered.promise, "Reset reader did not start");
  await bounded(store.resetRuntimeModelStats(config), "Slow reader blocked model reset");
  reset.release.resolve();
  await rejected;

  const governance = hold(sql => sql.includes("FROM unnest($1::text[]"));
  const dashboard = getGovernanceSnapshot(config, { readOnly: true });
  await bounded(governance.entered.promise, "Governance reader did not start");
  const admission = await bounded(acquireRequestGovernance(config, { keyId: key.id, apiKey: key }, { id: "model" }),
    "Admin snapshot blocked cold-key admission");
  assert.equal(admission.code, "KEY_BUDGET_EXCEEDED");
  governance.release.resolve();
  assert.equal((await dashboard).keys.find(item => item.keyId === key.id).runtime.budgetWindow.spentAmount, 6);

  const duplicateKey = { ...key, id: "cold-duplicate" };
  store.recordRuntimeRequest(config, { keyId: "pending", modelId: "model" });
  const queued = store.getRuntimeStoreInfo().queueLength;
  assert.ok(queued > 0);
  const duplicates = await getGovernanceSnapshot({ ...config, apiKeys: [duplicateKey, { ...duplicateKey }] }, { readOnly: true });
  assert.deepEqual(duplicates.keys.filter(item => item.keyId === duplicateKey.id).map(item => item.runtime.known), [true, true]);
  assert.equal(store.getRuntimeStoreInfo().queueLength, queued, "Duplicate key IDs must not trigger strict hydration and drain writes");
  await store.drainRuntimeEvents();
});

test("upstream JSON/SSE usage reconciles after database outage, hard restart and graceful restart", gate, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname));
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = `e2e_${process.pid}_${Date.now()}`;
  const configSchema = `${schema}_config`;
  const role = `${schema}_writer`;
  const identifier = value => quoteIdentifier(value, "test identifier");
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = role;
  runtimeUrl.password = randomUUID();
  const database = decodeURIComponent(runtimeUrl.pathname.slice(1));
  const upstreamReported = { events: 0, tokens: 0 };
  let ctx;
  t.after(async () => {
    await ctx?.cleanup();
    await admin.query(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${identifier(configSchema)} CASCADE`);
    await admin.query(`REVOKE CREATE ON DATABASE ${identifier(database)} FROM ${identifier(role)}`);
    await admin.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
    await admin.end();
  });
  await admin.query(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${runtimeUrl.password}'`);
  await admin.query(`GRANT CREATE ON DATABASE ${identifier(database)} TO ${identifier(role)}`);
  await admin.query(`CREATE SCHEMA ${identifier(schema)} AUTHORIZATION ${identifier(role)}`);
  ctx = await createTestContext({
    proxyEnv: { CONFIG_DB_CONNECTION_STRING: databaseUrl, RUNTIME_DB_CONNECTION_STRING: runtimeUrl.toString() },
    configureConfig(config) {
      config.persistence.configStore.mode = "database";
      config.persistence.configStore.database.schema = configSchema;
      config.persistence.configStore.database.pool.connectionTimeoutMs = 200;
      config.persistence.compatibilityExport.enabled = false;
      config.observability.runtimeStore = { enabled: true, schema, batchSize: 200, flushIntervalMs: 60000 };
      config.compatibility = { protocolShim: { rejectLossyResponses: true } };
      config.models = [{
        id: "recovery-chat", targetModel: "recovery-upstream", pricingRef: "gpt-5-mini", upstream: "mock-foundry",
        routes: { "*": "chat/completions" }, pricing: { inputPer1mTokens: 1, outputPer1mTokens: 2 }
      }, {
        id: "recovery-responses", targetModel: "recovery-responses-upstream", pricingRef: "gpt-5-mini", upstream: "mock-foundry",
        routes: { "*": "responses" }, pricing: { inputPer1mTokens: 1, outputPer1mTokens: 2 }
      }];
    },
    async upstreamHandler({ req, res, body }) {
      if (body?.model === "recovery-responses-upstream") {
        const usage = { input_tokens: 7, output_tokens: 4, total_tokens: 11 };
        upstreamReported.events++;
        upstreamReported.tokens += usage.total_tokens;
        const response = {
          id: "response", object: "response", model: body.model, status: "completed",
          output: [{ id: "message", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return true;
      }
      if (body?.model !== "recovery-upstream") return false;
      const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
      upstreamReported.events++;
      upstreamReported.tokens += usage.total_tokens;
      const isClientDisconnect = body.stream && body.messages?.some(message => message.content === "abort after usage");
      if (isClientDisconnect) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "disconnect", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: null }], usage })}\n\n`);
        await delay(30);
        if (!res.destroyed) {
          res.write(`data: ${JSON.stringify({ id: "disconnect", object: "chat.completion.chunk", model: body.model,
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`);
          await Promise.race([new Promise(resolve => res.once("close", resolve)), delay(1000)]);
        }
        if (!res.destroyed) res.end();
        return true;
      }
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(body.stream
        ? `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ id: "chat", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "content_filter" }], usage }));
      return true;
    }
  });
  const request = (messages = false, stream = false) => ctx.publicRequest(messages ? "/v1/messages" : "/v1/chat/completions", {
    method: "POST", json: { model: "recovery-chat", messages: [{ role: "user", content: "hello" }], max_tokens: 64, stream }
  });
  const responsesRequest = () => ctx.publicRequest("/v1/responses", {
    method: "POST", json: { model: "recovery-responses", input: "hello", max_output_tokens: 64 }
  });
  const cancelAfterContent = async () => {
    const config = await ctx.readConfigFile();
    const response = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKeys[0].key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "recovery-chat", messages: [{ role: "user", content: "abort after usage" }], max_tokens: 64, stream: true
      })
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      assert.equal(done, false, "Upstream should send content before the client cancels");
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data && data !== "[DONE]" && JSON.parse(data).choices?.some(choice => choice.delta?.content)) {
          await reader.cancel();
          return;
        }
      }
    }
  };
  const sync = () => ctx.adminRequest("/admin/api/runtime/sync", { method: "POST", headers: { "x-aoai-admin-csrf": "1" } });
  const totals = async () => {
    const { rows } = await admin.query(`SELECT COUNT(*) AS events, COUNT(DISTINCT event_uid) AS identities,
      SUM(total_tokens) AS tokens, SUM(estimated_cost_amount) AS cost,
      json_agg(json_build_object('model', model_id, 'prompt', prompt_tokens,
        'completion', completion_tokens, 'total', total_tokens,
        'source', payload->>'usageSource', 'estimated', payload->>'usageEstimated',
        'costStatus', payload->'textCost'->>'costStatus') ORDER BY event_id) AS details
      FROM ${identifier(schema)}.runtime_events WHERE event_type = 'usage'`);
    return {
      ...Object.fromEntries(["events", "identities", "tokens", "cost"].map(key => [key, Number(rows[0][key])])),
      details: rows[0].details
    };
  };
  const refused = await request(true);
  assert.equal(refused.status, 502, refused.text);
  assert.equal(refused.json.error.code, "UnsupportedProtocolShimResponse");
  await sync();
  assert.deepEqual(upstreamReported, { events: 1, tokens: 5 });
  assert.equal((await totals()).tokens, 5, "Strict conversion rejection must retain reported upstream usage");
  const nativeResponses = await responsesRequest();
  assert.equal(nativeResponses.status, 200, nativeResponses.text);
  assert.equal(nativeResponses.json.usage.total_tokens, 11);
  await sync();
  assert.deepEqual(upstreamReported, { events: 2, tokens: 16 });
  assert.equal((await totals()).tokens, upstreamReported.tokens, "Native Responses usage must reconcile with the upstream report");
  const loaded = await ctx.adminRequest("/admin/api/config");
  const persistedBefore = await ctx.readConfigFile();
  loaded.json.observability.runtimeStore.localBufferPath = path.join(ctx.tempDir, "different-buffer.ndjson");
  const pathChange = await ctx.adminRequest("/admin/api/config", {
    method: "PUT", headers: { "x-aoai-admin-csrf": "1", "if-match": loaded.headers.get("etag") }, json: loaded.json
  });
  assert.equal(pathChange.status, 409);
  assert.equal(pathChange.json.code, "RUNTIME_STORE_RESTART_REQUIRED");
  assert.deepEqual(await ctx.readConfigFile(), persistedBefore);

  await admin.query(`ALTER ROLE ${identifier(role)} NOLOGIN`);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [role]);
  assert.equal((await request()).status, 200);
  const stream = await request(false, true);
  assert.equal(stream.status, 200);
  assert.match(stream.text, /data: \[DONE\]/);
  await cancelAfterContent();
  assert.equal((await request(true)).status, 502);
  const offline = await sync();
  assert.ok(offline.json.runtime.runtimeStore.persistedEventCount > 0, offline.text);
  assert.equal((await totals()).tokens, 16, "Database outage must not write new usage before replay");
  await ctx.restartProxy({ force: true });
  const recoveredSpool = await ctx.adminRequest("/admin/api/runtime");
  assert.ok(recoveredSpool.json.runtime.runtimeStore.persistedEventCount > 0);
  await admin.query(`ALTER ROLE ${identifier(role)} LOGIN`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await sync();
    if (result.json.runtime.runtimeStore.persistedEventCount === 0) break;
    await delay(50);
  }
  await sync();
  let ledger = await totals();
  assert.deepEqual(upstreamReported, { events: 6, tokens: 36 });
  assert.equal(ledger.events, upstreamReported.events);
  assert.equal(ledger.identities, upstreamReported.events);
  assert.equal(ledger.tokens, upstreamReported.tokens, JSON.stringify(ledger.details));
  assert.deepEqual(ledger.details.filter(event => event.costStatus === "partial"), [{
    model: "recovery-chat", prompt: 3, completion: 2, total: 5,
    source: "upstream", estimated: "false", costStatus: "partial"
  }], "A client disconnect must retain received upstream usage, marked incomplete rather than estimated");
  assert.ok(Math.abs(ledger.cost - 50 / 1e6) < 1e-12, JSON.stringify(ledger));
  const stats = await ctx.adminRequest("/admin/api/stats");
  assert.equal(stats.json.totals.totalTokens, upstreamReported.tokens);
  assert.equal(stats.json.totals.errors, 2);
  assert.equal((await request()).status, 200);
  await ctx.restartProxy();
  ledger = await totals();
  assert.equal(ledger.events, upstreamReported.events);
  assert.equal(ledger.identities, upstreamReported.events);
  assert.equal(ledger.tokens, upstreamReported.tokens);
  assert.ok(Math.abs(ledger.cost - 57 / 1e6) < 1e-12);
});
