import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { closeSharedPostgresPools } from "../src/postgres.js";
import * as runtimeStore from "../src/runtime-store.js";
import { acquireRequestGovernance, getGovernanceSnapshot, recordGovernanceUsage } from "../src/governance.js";

function mockLedger() {
  const state = { events: [], rollups: [], meta: new Map(), statements: [], fail: "", transaction: null, releases: 0 };
  state.query = async (sql, values = []) => {
    state.statements.push(sql);
    if (sql === "BEGIN") state.transaction = structuredClone({ events: state.events, rollups: state.rollups, meta: state.meta });
    if (sql === "ROLLBACK" && state.transaction) { Object.assign(state, state.transaction); state.transaction = null; }
    if (sql === "COMMIT") {
      state.transaction = null;
      if (state.fail === "commit-ack") { state.fail = ""; throw new Error("Lost commit acknowledgement"); }
    }
    if (sql.startsWith("SELECT meta_value")) return { rows: [{ meta_value: state.meta.get(values[0]) || "" }] };
    if (sql.startsWith("INSERT") && sql.includes('"runtime_store_meta"')) {
      if (state.fail === "checkpoint") { state.fail = ""; throw new Error("Checkpoint write failed"); }
      state.meta.set(values[0], values[1]);
    }
    const insert = sql.match(/^INSERT INTO .*"runtime_(events|rollups)" \(([^)]+)\) VALUES /);
    if (insert) {
      const cols = insert[2].split(",").map(s => s.trim());
      for (let offset = 0; offset < values.length; offset += cols.length) {
        const row = Object.fromEntries(cols.map((col, i) => [col, values[offset + i]]));
        if (insert[1] === "events") {
          if (sql.includes("ON CONFLICT") && row.event_uid && state.events.some(e => e.event_uid === row.event_uid)) continue;
          state.events.push({ ...row, event_id: state.events.length + 1, payload: JSON.parse(row.payload) });
        } else {
          const existing = state.rollups.find(r => ["grain", "bucket_start", "scope_type", "scope_key", "scope_subkey"].every(k => r[k] === row[k]));
          if (existing) existing.estimated_cost_amount += row.estimated_cost_amount;
          else state.rollups.push(row);
        }
      }
      if (insert[1] === "events" && state.fail === "insert-ack") { state.fail = ""; throw new Error("Lost insert acknowledgement"); }
    }
    if (sql.includes("WHERE event_id > $1")) return { rows: state.events.filter(e => e.event_id > Number(values[0])) };
    return { rows: [] };
  };
  return state;
}

async function setup(t, store, query) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-runtime-recovery-"));
  const previous = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = "postgresql://mock@127.0.0.1:1/test";
  t.mock.method(pg.Pool.prototype, "query", query);
  t.mock.method(pg.Pool.prototype, "connect", async function () {
    return { query: (...args) => query(...args), release() {} };
  });
  const config = { persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { runtimeStore: { schema: `recovery_${path.basename(dir).replaceAll("-", "_")}`, flushIntervalMs: 60000,
      localBufferPath: path.join(dir, "pending.ndjson") } } };
  t.after(async () => {
    store.setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    if (previous === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  store.setRuntimeStoreConfig(config);
  return config;
}

for (const failure of ["checkpoint", "commit-ack", "insert-ack"]) {
  test(`runtime ledger is idempotent after ${failure} failure`, async t => {
    const store = await import(`../src/runtime-store.js?recovery=${failure}`);
    const db = mockLedger();
    const config = await setup(t, store, db.query);
    db.fail = failure;
    store.recordRuntimeUsage(config, { requestId: "request-1", keyId: "key", modelId: "model", estimatedCostAmount: 1 });
    await store.flushRuntimeEvents();
    if (failure === "checkpoint") assert.equal(db.rollups.length, 0, "Failed checkpoint must roll back the additive rollups");
    await store.flushRuntimeEvents();
    assert.equal(db.events.length, 1, "Ambiguous commits must not duplicate the original usage event");
    const daily = () => db.rollups.find(r => r.grain === "daily" && r.scope_type === "global")?.estimated_cost_amount;
    assert.equal(daily(), 1);
    // Repeated usage events with the same request ID are legitimate distinct events.
    store.recordRuntimeUsage(config, { requestId: "request-1", keyId: "key", modelId: "model", estimatedCostAmount: 1 });
    await store.flushRuntimeEvents();
    assert.equal(db.events.length, 2);
    assert.equal(daily(), 2);
    assert.ok(db.statements.includes("BEGIN"));
    assert.ok(db.statements.includes("COMMIT"));
  });
}

test("legacy spool records acquire stable identities before an ambiguous insert and restart", async t => {
  let store = await import("../src/runtime-store.js?legacy-recovery=1");
  const db = mockLedger();
  const config = await setup(t, { setRuntimeStoreConfig: value => store.setRuntimeStoreConfig(value) }, db.query);
  const legacy = { eventType: "usage", occurredAt: new Date().toISOString(), keyId: "key", modelId: "model", estimatedCostAmount: 1 };
  await fs.writeFile(config.observability.runtimeStore.localBufferPath, `${JSON.stringify(legacy)}\n${JSON.stringify(legacy)}\n`);
  store.setRuntimeStoreConfig(config);
  while (store.getRuntimeStoreInfo(config).persistedEventCount !== 2) await new Promise(r => setTimeout(r, 5));
  db.fail = "insert-ack";
  await store.flushRuntimeEvents();
  store.setRuntimeStoreConfig(null);
  store = await import("../src/runtime-store.js?legacy-recovery=2");
  store.setRuntimeStoreConfig(config);
  await store.flushRuntimeEvents();
  assert.equal(db.events.length, 2, "Distinct identical legacy records survive; replay does not add two more");
  assert.ok(db.events.every(e => e.event_uid));
});

test("failed runtime flushes retry automatically without another incoming request", { timeout: 5000 }, async t => {
  const store = await import("../src/runtime-store.js?automatic-retry=1");
  const db = mockLedger();
  const config = await setup(t, store, db.query);
  config.observability.runtimeStore.flushIntervalMs = 100;
  store.setRuntimeStoreConfig(config);
  db.fail = "checkpoint";
  store.recordRuntimeUsage(config, { keyId: "key", modelId: "model", estimatedCostAmount: 1 });
  await store.flushRuntimeEvents();
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !db.rollups.length) await new Promise(r => setTimeout(r, 20));
  assert.equal(db.rollups.find(r => r.grain === "daily" && r.scope_type === "global")?.estimated_cost_amount, 1);
  assert.equal(db.events.length, 1);
});

test("failed budget hydration retries after recovery without resetting in-flight usage", async t => {
  let unavailable = true;
  let hydrationQueries = 0;
  let releaseQuery;
  let queryStarted;
  const started = new Promise(r => { queryStarted = r; });
  const config = await setup(t, runtimeStore, async sql => {
    if (sql.includes("WITH latest_block")) {
      hydrationQueries++;
      if (unavailable) throw new Error("Database temporarily unavailable");
      queryStarted();
      await new Promise(r => { releaseQuery = r; });
      return { rows: [{ budget_spent_amount: 2, budget_requests: 2 }] };
    }
    return { rows: [] };
  });
  const key = { id: "recovery-budget", budget: { limitAmount: 1, hardLimitAction: "block" } };
  config.apiKeys = [key];
  const consumer = { keyId: key.id, apiKey: key };
  const model = { id: "test", pricing: { inputPer1mTokens: 1, outputPer1mTokens: 1 } };
  const now = Date.now();
  const failed = await acquireRequestGovernance(config, consumer, model, now);
  failed.lease?.release();
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
  assert.equal(failed.retryable, true);
  assert.equal(failed.code, "KEY_GOVERNANCE_UNAVAILABLE");
  unavailable = false;
  const retry = acquireRequestGovernance(config, consumer, model, now + 2000);
  await started;
  // An earlier in-flight request can settle while historical state is read.
  recordGovernanceUsage(config, consumer, model, { prompt_tokens: 500000, completion_tokens: 0, total_tokens: 500000 }, now + 2000);
  releaseQuery();
  const recovered = await retry;
  assert.equal(recovered.code, "KEY_BUDGET_EXCEEDED");
  const snapshot = await getGovernanceSnapshot(config);
  assert.equal(snapshot.keys.find(item => item.keyId === key.id).runtime.budgetWindow.spentAmount, 2.5);
  assert.equal(hydrationQueries, 2);
  assert.equal(snapshot.keys.find(item => item.keyId === key.id).runtime.currentConcurrent, 0);
});

test("unmetered keys remain available during hydration failure with local concurrency enforced", async t => {
  const config = await setup(t, runtimeStore, async sql => {
    if (sql.includes("WITH latest_block")) throw new Error("Database temporarily unavailable");
    return { rows: [] };
  });
  const key = { id: "unlimited-recovery", rateLimit: { concurrency: 1 } };
  const consumer = { keyId: key.id, apiKey: key };
  const first = await acquireRequestGovernance(config, consumer, { id: "test" });
  assert.equal(first.ok, true);
  const blocked = await acquireRequestGovernance(config, consumer, { id: "test" });
  assert.equal(blocked.code, "KEY_CONCURRENCY_LIMIT_EXCEEDED");
  first.lease.release();
  const resumed = await acquireRequestGovernance(config, consumer, { id: "test" });
  assert.equal(resumed.ok, true);
  resumed.lease.release();
});

test("hydration crossing a budget window preserves the new window and its settlements", async t => {
  let now = Date.parse("2026-10-31T23:59:59.900Z");
  t.mock.method(Date, "now", () => now);
  let releaseQuery;
  let queryStarted;
  const started = new Promise(r => { queryStarted = r; });
  const config = await setup(t, runtimeStore, async sql => {
    if (sql.includes("WITH latest_block")) {
      queryStarted();
      await new Promise(r => { releaseQuery = r; });
      return { rows: [{ budget_spent_amount: 2, budget_requests: 2, rate_total_tokens: 2000000 }] };
    }
    return { rows: [] };
  });
  const key = { id: "window-budget", budget: { limitAmount: 1, hardLimitAction: "block" } };
  config.apiKeys = [key];
  const consumer = { keyId: key.id, apiKey: key };
  const model = { id: "test", pricing: { inputPer1mTokens: 1, outputPer1mTokens: 1 } };
  const pending = acquireRequestGovernance(config, consumer, model, now);
  await started;
  now = Date.parse("2026-11-01T00:00:00.100Z");
  recordGovernanceUsage(config, consumer, model, { prompt_tokens: 500000, completion_tokens: 0, total_tokens: 500000 }, now);
  releaseQuery();
  const result = await pending;
  result.lease?.release();
  assert.equal(result.ok, true, "Previous month's exhausted balance cannot block the new month");
  const snapshot = await getGovernanceSnapshot(config);
  assert.equal(snapshot.keys.find(item => item.keyId === key.id).runtime.budgetWindow.key, "2026-11");
  assert.equal(snapshot.keys.find(item => item.keyId === key.id).runtime.budgetWindow.spentAmount, 0.5);
  assert.equal(snapshot.keys.find(item => item.keyId === key.id).runtime.rateWindow.totalTokens, 500000);
});

test("PostgreSQL rolls back a failed checkpoint and deduplicates committed event replay", {
  skip: !process.env.RUNTIME_MEDIA_TEST_DATABASE_URL, timeout: 30000
}, async t => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-live-recovery-"));
  const schemaName = `recovery_${process.pid}_${Date.now()}`;
  const schema = `"${schemaName}"`;
  const previous = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = connectionString;
  const pool = new pg.Pool({ connectionString });
  const store = await import(`../src/runtime-store.js?live-recovery=${schemaName}`);
  const config = { persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { runtimeStore: { schema: schemaName, flushIntervalMs: 60000, localBufferPath: path.join(dir, "pending.ndjson") } } };
  const record = () => store.recordRuntimeUsage(config, { requestId: "same-request", keyId: "key", modelId: "model", estimatedCostAmount: 1 });
  const totals = async () => ({
    events: Number((await pool.query(`SELECT COUNT(*) AS n FROM ${schema}.runtime_events`)).rows[0].n),
    cost: Number((await pool.query(`SELECT estimated_cost_amount FROM ${schema}.runtime_rollups WHERE grain='daily' AND scope_type='global'`)).rows[0].estimated_cost_amount)
  });
  try {
    store.setRuntimeStoreConfig(config);
    record();
    assert.equal((await store.flushRuntimeEvents()).flushed, 1);
    await pool.query(`CREATE FUNCTION ${schema}.fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test checkpoint failure'; END $$;
      CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON ${schema}.runtime_store_meta
      FOR EACH ROW WHEN (NEW.meta_key = 'last_rolled_event_id') EXECUTE FUNCTION ${schema}.fail_checkpoint()`);
    record();
    assert.ok((await store.flushRuntimeEvents()).error);
    assert.deepEqual(await totals(), { events: 2, cost: 1 });
    await pool.query(`DROP TRIGGER fail_checkpoint ON ${schema}.runtime_store_meta`);
    assert.equal((await store.flushRuntimeEvents()).flushed, 1);
    assert.deepEqual(await totals(), { events: 2, cost: 2 });

    const originalQuery = pg.Pool.prototype.query;
    let loseInsertAck = true;
    const queryMock = t.mock.method(pg.Pool.prototype, "query", async function (sql, ...args) {
      const result = await originalQuery.call(this, sql, ...args);
      if (loseInsertAck && typeof sql === "string" && sql.startsWith(`INSERT INTO ${schema}."runtime_events"`)) {
        loseInsertAck = false;
        throw new Error("Simulated lost acknowledgement after real PostgreSQL commit");
      }
      return result;
    });
    record();
    assert.ok((await store.flushRuntimeEvents()).error);
    queryMock.mock.restore();
    assert.deepEqual(await totals(), { events: 3, cost: 2 });
    await store.flushRuntimeEvents();
    assert.deepEqual(await totals(), { events: 3, cost: 3 });
  } finally {
    store.setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    if (previous === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
