import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { getRuntimeStoreInfo, recordRuntimeError, recordRuntimeRequest, recordRuntimeUsage, recordRuntimeMediaUsage, setRuntimeStoreConfig, flushRuntimeEvents, hydrateGovernanceRuntime, getRuntimeStatsSnapshot } from "../src/runtime-store.js";
import { closeSharedPostgresPools, quoteIdentifier } from "../src/postgres.js";
import { createMediaUsageTracker } from "../src/proxy/media-usage.js";
import { settleMediaUsage } from "../src/proxy/media-accounting.js";

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for runtime-store state");
}

test("runtime events spill locally when database configuration is unavailable", async () => {
  const tempDir = path.resolve(`.runtime-spill-test-${process.pid}-${Date.now()}`);
  await fs.mkdir(tempDir);
  const localBufferPath = path.join(tempDir, "pending.ndjson");
  const previousConnectionString = process.env.CONFIG_DB_CONNECTION_STRING;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.CONFIG_DB_CONNECTION_STRING;
  delete process.env.DATABASE_URL;

  const config = {
    persistence: {
      configStore: {
        mode: "database",
        filePath: path.join(tempDir, "config.json"),
        database: {}
      }
    },
    observability: {
      runtimeStore: {
        enabled: true,
        localBufferPath,
        maxPersistedEvents: 100
      }
    }
  };

  try {
    setRuntimeStoreConfig(config);
    const correlation = { conversationId: "conversation-1", sessionId: "session-1" };
    recordRuntimeRequest(config, { requestId: "spill-request", modelId: "model", ...correlation });
    recordRuntimeUsage(config, { requestId: "spill-request", modelId: "model", totalTokens: 3, ...correlation });
    recordRuntimeError(config, { requestId: "spill-request", modelId: "model", errorCode: "TEST_ERROR", ...correlation });
    recordRuntimeMediaUsage(config, { requestId: "media-priced", modelId: "voice", estimatedCostAmount: 0.006,
      mediaUsage: { usageStatus: "observed", costStatus: "priced", counters: { durationSeconds: 60 },
        estimatedCostAmount: 0.006, currency: "USD", knownCostAmounts: { USD: 0.006 }, pricingSources: ["model.pricing"] }, ...correlation });
    recordRuntimeMediaUsage(config, { requestId: "media-unknown", modelId: "voice",
      mediaUsage: { usageStatus: "unknown", costStatus: "unknown", estimatedCostAmount: null, raw: { audio: "private-audio" } }, ...correlation });
    const tier = { id: "base", promptTokensAtLeast: 0, promptTokensBelow: 200000, rates: { inputPer1mTokens: 1, outputPer1mTokens: 2 } };
    const pricing = {
      actual: { source: "model.pricing", policyDigest: "sha256:actual",
        tier: { ...tier, rates: { ...tier.rates, rawUsage: "private-text" }, rawUsage: "private-text" }, rawUsage: "private-text" },
      router: { source: "catalog:model-router", policyDigest: "sha256:router", tier: null }
    };
    recordRuntimeUsage(config, { requestId: "text-priced", modelId: "text", estimatedCostAmount: 0.5,
      costStatus: "priced", costReason: "", pricing, cacheWrite: {
        tokens: 30, usageStatus: "observed", knownCostAmount: 0.05, estimatedCostAmount: 0.05, costStatus: "priced", raw: "private-cache-write"
      }, ...correlation });
    recordRuntimeUsage(config, { requestId: "text-partial", modelId: "text", amount: 0.25, estimatedCostAmount: null,
      modelRouterCostAmount: 0.25, costStatus: "partial", costReason: "actual model pricing unavailable",
      pricing, cacheWrite: { tokens: 10, usageStatus: "observed", knownCostAmount: 0.02, estimatedCostAmount: null, costStatus: "partial" },
      rawUsage: { prompt: "private-text" }, ...correlation });
    recordRuntimeUsage(config, { requestId: "text-unknown", modelId: "text", estimatedCostAmount: 0,
      costStatus: "unknown", costReason: "missing output price", pricing: { actual: null, router: null },
      cacheWrite: { tokens: null, usageStatus: "unknown", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown" }, ...correlation });
    recordRuntimeUsage(config, { requestId: "text-zero-write", modelId: "text", estimatedCostAmount: 0, costStatus: "priced", pricing,
      cacheWrite: { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" }, ...correlation });
    await waitFor(() => getRuntimeStoreInfo(config).persistedEventCount === 9);

    const info = getRuntimeStoreInfo(config);
    const persisted = await fs.readFile(localBufferPath, "utf8");
    assert.equal(info.configured, false);
    assert.equal(info.spilloverActive, true);
    assert.equal(info.persistedEventCount, 9);
    assert.match(persisted, /spill-request/);
    const events = persisted.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.eventType), ["request", "usage", "error", "usage", "usage", "usage", "usage", "usage", "usage"]);
    assert.equal(events[1].payload.textCost, undefined);
    assert.equal(events[1].textUnknownCostRequests, 0);
    assert.equal(events[1].cacheWrite.tokens, null);
    assert.equal(events[1].cacheWrite.unreportedRequests, 1);
    assert.equal(events[1].cacheWrite.estimatedCostAmount, null);
    assert.equal(events[3].estimatedCostAmount, 0.006);
    assert.deepEqual(events[3].payload.media.counters, { durationSeconds: 60 });
    assert.equal(events[3].payload.media.estimatedCostAmount, 0.006);
    assert.deepEqual(events[3].payload.media.pricingSources, ["model.pricing"]);
    assert.equal(events[4].payload.media.estimatedCostAmount, null);
    assert.equal(events[4].payload.media.costStatus, "unknown");
    assert.equal(events[4].textUnknownCostRequests, 0);
    assert.equal(events[4].cacheWrite.requests, 0);
    assert.equal(events[4].cacheWrite.unreportedRequests, 0);
    assert.equal(persisted.includes("private-audio"), false);
    assert.equal(events[5].payload.textCost.estimatedCostAmount, 0.5);
    assert.equal(events[5].payload.textCost.costStatus, "priced");
    assert.equal(events[5].textUnknownCostRequests, 0);
    assert.equal(events[5].cacheWrite.tokens, 30);
    assert.equal(events[5].cacheWrite.estimatedCostAmount, 0.05);
    assert.equal(events[5].cacheWrite.observedRequests, 1);
    assert.deepEqual(events[5].payload.cacheWrite, {
      tokens: 30, usageStatus: "observed", knownCostAmount: 0.05, estimatedCostAmount: 0.05, costStatus: "priced"
    });
    assert.equal(events[6].estimatedCostAmount, 0.25);
    assert.equal(events[6].modelRouterCostAmount, 0.25);
    assert.equal(events[6].textUnknownCostRequests, 1);
    assert.equal(events[6].cacheWrite.tokens, 10);
    assert.equal(events[6].cacheWrite.knownCostAmount, 0.02);
    assert.equal(events[6].cacheWrite.estimatedCostAmount, null);
    assert.equal(events[6].cacheWrite.partialCostRequests, 1);
    assert.deepEqual(events[6].payload.textCost, {
      costStatus: "partial",
      costReason: "actual model pricing unavailable",
      estimatedCostAmount: null,
      knownCostAmount: 0.25,
      pricing: {
        actual: { source: "model.pricing", policyDigest: "sha256:actual", tier },
        router: { source: "catalog:model-router", policyDigest: "sha256:router", tier: null }
      }
    });
    assert.equal(events[7].payload.textCost.estimatedCostAmount, null);
    assert.equal(events[7].payload.textCost.knownCostAmount, 0);
    assert.equal(events[7].payload.textCost.costStatus, "unknown");
    assert.equal(events[7].textUnknownCostRequests, 1);
    assert.equal(events[7].cacheWrite.tokens, null);
    assert.equal(events[7].cacheWrite.estimatedCostAmount, null);
    assert.equal(events[7].cacheWrite.unknownUsageRequests, 1);
    assert.equal(events[8].cacheWrite.tokens, 0);
    assert.equal(events[8].cacheWrite.estimatedCostAmount, 0);
    assert.equal(persisted.includes("private-text"), false);
    assert.equal(persisted.includes("private-cache-write"), false);
    assert.ok(events.every((event) => event.payload.conversationId === "conversation-1"));
    assert.ok(events.every((event) => event.payload.sessionId === "session-1"));
  } finally {
    setRuntimeStoreConfig(null);
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousConnectionString === undefined) delete process.env.CONFIG_DB_CONNECTION_STRING;
    else process.env.CONFIG_DB_CONNECTION_STRING = previousConnectionString;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test("media and text ledgers restore known subtotals and durable completeness from PostgreSQL", {
  timeout: 30000,
  skip: !process.env.RUNTIME_MEDIA_TEST_DATABASE_URL
}, async () => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname), "Use an isolated loopback database");
  const previousConnectionString = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = connectionString;
  const tempDir = path.resolve(`.media-ledger-test-${process.pid}-${Date.now()}`);
  await fs.mkdir(tempDir);
  const schema = `media_test_${process.pid}_${Date.now()}`;
  const quotedSchema = quoteIdentifier(schema, "test schema");
  const pool = new pg.Pool({ connectionString });
  let restarted;
  const config = { persistence: { configStore: { mode: "database", filePath: path.join(tempDir, "config.json"), database: {} } },
    access: { budgets: { defaultCurrency: "CNY" } }, observability: { runtimeStore: { enabled: true, schema, localBufferPath: path.join(tempDir, "pending.ndjson") } } };
  try {
    setRuntimeStoreConfig(config);
    const model = { id: "voice" };
    const consumer = { keyId: "ledger-key", apiKey: {} };
    const tracker = createMediaUsageTracker({ pricing: { currency: "EUR", billingUnit: "minute", perMinute: 0.006, source: "model.pricing" } });
    tracker.observe("response:1", { type: "duration", seconds: 60 });
    tracker.observe("response:1", { type: "duration", seconds: 60 });
    for (const [requestId, usage] of [["priced", tracker.snapshot()], ["unknown", createMediaUsageTracker().snapshot()]]) {
      recordRuntimeRequest(config, { requestId, keyId: consumer.keyId, modelId: model.id, routeKey: "responses", backendRouteKey: "audio/transcriptions" });
      settleMediaUsage({ config, consumer, model, usage, requestContext: { requestId }, routeKey: "responses", backendRouteKey: "audio/transcriptions" });
    }
    const pricing = { actual: { source: "model.pricing", policyDigest: "sha256:test", tier: "base" }, router: null };
    for (const cost of [
      { requestId: "text-priced", amount: 0.5, estimatedCostAmount: 0.5, costStatus: "priced",
        cacheWrite: { tokens: 30, usageStatus: "observed", knownCostAmount: 0.05, estimatedCostAmount: 0.05, costStatus: "priced" } },
      { requestId: "text-partial", amount: 0.25, estimatedCostAmount: null, costStatus: "partial",
        cacheWrite: { tokens: 10, usageStatus: "observed", knownCostAmount: 0.02, estimatedCostAmount: null, costStatus: "partial" } },
      { requestId: "text-unknown", amount: 0, estimatedCostAmount: null, costStatus: "unknown",
        cacheWrite: { tokens: null, usageStatus: "unknown", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown" } },
      { requestId: "text-free", amount: 0, estimatedCostAmount: 0, costStatus: "priced",
        cacheWrite: { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" } },
      { requestId: "text-legacy", estimatedCostAmount: 0.1 }
    ]) {
      const fields = { keyId: consumer.keyId, modelId: "text", actualModelName: "actual-text", ...cost };
      recordRuntimeRequest(config, fields);
      recordRuntimeUsage(config, { ...fields, pricing, costReason: cost.costStatus === "partial" ? "missing output price" : "" });
    }
    await waitFor(async () => {
      await flushRuntimeEvents();
      const exists = await pool.query("SELECT to_regclass($1) AS table_name", [`${schema}.runtime_events`]);
      if (!exists.rows[0].table_name) return false;
      const result = await pool.query(`SELECT COUNT(*) AS count FROM ${quotedSchema}.runtime_events`);
      return Number(result.rows[0].count) === 14 && !getRuntimeStoreInfo(config).flushing;
    }, 8000);
    const events = await pool.query(`SELECT request_id, estimated_cost_amount, payload FROM ${quotedSchema}.runtime_events WHERE event_type = 'usage' AND payload ? 'media' ORDER BY request_id`);
    assert.equal(Number(events.rows[0].estimated_cost_amount), 0.006);
    assert.equal(events.rows[0].payload.media.costStatus, "priced");
    assert.deepEqual(events.rows[0].payload.media.counters, { durationSeconds: 60 });
    assert.equal(events.rows[1].payload.media.estimatedCostAmount, null);
    assert.equal(events.rows[1].payload.media.costStatus, "unknown");
    const textEvents = await pool.query(`SELECT request_id, estimated_cost_amount, text_unknown_cost_requests,
      cache_write_tokens, cache_write_known_cost_amount, cache_write_estimated_cost_amount, cache_write_requests, cache_write_observed_requests,
      cache_write_priced_requests, cache_write_partial_cost_requests, cache_write_unreported_requests,
      payload FROM ${quotedSchema}.runtime_events WHERE event_type = 'usage' AND model_id = 'text' ORDER BY request_id`);
    assert.equal(Number(textEvents.rows[0].cache_write_tokens), 0);
    assert.equal(Number(textEvents.rows[0].cache_write_observed_requests), 1);
    assert.equal(Number(textEvents.rows[0].cache_write_estimated_cost_amount), 0);
    assert.equal(textEvents.rows[1].request_id, "text-legacy");
    assert.equal(textEvents.rows[1].payload.textCost, undefined);
    assert.equal(Number(textEvents.rows[1].text_unknown_cost_requests), 0);
    assert.equal(textEvents.rows[1].cache_write_tokens, null);
    assert.equal(textEvents.rows[1].cache_write_known_cost_amount, null);
    assert.equal(textEvents.rows[1].cache_write_estimated_cost_amount, null);
    assert.equal(Number(textEvents.rows[1].cache_write_unreported_requests), 1);
    assert.equal(textEvents.rows[2].payload.textCost.estimatedCostAmount, null);
    assert.equal(textEvents.rows[2].payload.textCost.knownCostAmount, 0.25);
    assert.equal(Number(textEvents.rows[2].estimated_cost_amount), 0.25);
    assert.deepEqual(textEvents.rows[2].payload.textCost.pricing, pricing);
    assert.equal(Number(textEvents.rows[2].cache_write_tokens), 10);
    assert.equal(Number(textEvents.rows[2].cache_write_known_cost_amount), 0.02);
    assert.equal(Number(textEvents.rows[2].cache_write_partial_cost_requests), 1);
    assert.equal(textEvents.rows[2].cache_write_estimated_cost_amount, null);
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    setRuntimeStoreConfig(config);
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const restored = await hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    assert.ok(restored);
    assert.equal(Number(restored.total_requests), 7);
    assert.equal(Number(restored.budget_requests), 7);
    assert.equal(Number(restored.budget_media_unknown_cost_requests), 1);
    assert.equal(Number(restored.budget_text_unknown_cost_requests), 2);
    assert.ok(Math.abs(Number(restored.budget_spent_amount) - 0.856) < 1e-12);
    const again = await hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    assert.equal(Number(again.budget_spent_amount), Number(restored.budget_spent_amount));
    assert.equal(Number(again.budget_text_unknown_cost_requests), 2);
    const stats = await getRuntimeStatsSnapshot(config);
    assert.equal(stats.totals.media.unknownCostRequests, 1);
    assert.equal(stats.totals.media.estimatedCostAmount, null);
    assert.deepEqual(stats.totals.media.costAmounts, { USD: 0.006 });
    assert.deepEqual(stats.totals.media.counters, { durationSeconds: 60 });
    assert.deepEqual(stats.perModel.voice.media, stats.perKey[consumer.keyId].media);
    for (const bucket of [stats.totals, stats.perModel.text, stats.perKey[consumer.keyId], stats.perModel.text.actualModels["actual-text"],
      ...Object.values(stats.analytics.rollups).flat()]) {
      assert.equal(bucket.textUnknownCostRequests, 2);
      assert.equal(bucket.cacheWrite.requests, 4);
      assert.equal(bucket.cacheWrite.observedRequests, 3);
      assert.equal(bucket.cacheWrite.unreportedRequests, 1);
      assert.equal(bucket.cacheWrite.observedTokens, 40);
      assert.equal(bucket.cacheWrite.tokens, null);
      assert.equal(bucket.cacheWrite.estimatedCostAmount, null);
      assert.ok(Math.abs(bucket.cacheWrite.knownCostAmount - 0.07) < 1e-12);
    }
    assert.equal(stats.perModel.text.estimatedCostAmount, 0.85);
    const filtered = await getRuntimeStatsSnapshot(config, null, { keyId: consumer.keyId, timeRange: "24h" });
    assert.deepEqual(filtered.totals.media, stats.totals.media);
    for (const bucket of [filtered.totals, filtered.perModel.text, filtered.perKey[consumer.keyId], filtered.perModel.text.actualModels["actual-text"],
      ...Object.values(filtered.analytics.rollups).flat()]) {
      assert.equal(bucket.textUnknownCostRequests, 2);
      assert.deepEqual(bucket.cacheWrite, stats.perModel.text.cacheWrite);
    }
    const other = await getRuntimeStatsSnapshot(config, null, { keyId: "other-key" });
    assert.equal(other.totals.media, undefined);
    assert.deepEqual(other.perKey, {});
    await pool.query(`DELETE FROM ${quotedSchema}.runtime_events WHERE model_id = 'text'`);
    const retained = await getRuntimeStatsSnapshot(config);
    assert.equal(retained.totals.textUnknownCostRequests, 2);
    assert.equal(retained.perModel.text.textUnknownCostRequests, 2);
    assert.deepEqual(retained.perModel.text.cacheWrite, stats.perModel.text.cacheWrite);
    const retainedBudget = await hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    assert.equal(Number(retainedBudget.budget_text_unknown_cost_requests), 2);
    assert.equal(Number(retainedBudget.budget_spent_amount), Number(restored.budget_spent_amount));

    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    const cacheColumns = [
      "cache_write_tokens", "cache_write_known_cost_amount", "cache_write_estimated_cost_amount",
      "cache_write_requests", "cache_write_observed_requests", "cache_write_priced_requests",
      "cache_write_partial_cost_requests", "cache_write_unreported_requests"
    ];
    for (const table of ["runtime_events", "runtime_rollups"]) {
      await pool.query(`ALTER TABLE ${quotedSchema}.${table} ${cacheColumns.map(name => `DROP COLUMN ${name}`).join(", ")}`);
    }
    await pool.query(`INSERT INTO ${quotedSchema}.runtime_events (event_type, key_id, model_id, estimated_cost_amount)
      VALUES ('usage', $1, 'text', 0.3)`, [consumer.keyId]);
    restarted = await import(`../src/runtime-store.js?cache-write-migration=${schema}`);
    restarted.setRuntimeStoreConfig(config);
    const upgraded = await restarted.getRuntimeStatsSnapshot(config);
    assert.ok(upgraded);
    assert.ok(Math.abs(upgraded.totals.estimatedCostAmount - retained.totals.estimatedCostAmount - 0.3) < 1e-12);
    assert.equal(upgraded.totals.cacheWrite.requests, 0);
    assert.equal(upgraded.totals.cacheWrite.tokens, null);
    assert.equal(upgraded.totals.cacheWrite.knownCostAmount, null);
    assert.equal(upgraded.totals.cacheWrite.estimatedCostAmount, null);
    assert.equal(upgraded.totals.cacheWrite.unreportedRequests, null);
    const migratedColumns = await pool.query(`SELECT table_name, column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND column_name = ANY($2::text[])`, [schema, cacheColumns]);
    assert.equal(migratedColumns.rows.length, 16);
    for (const row of migratedColumns.rows.filter(row => row.column_name === "cache_write_unreported_requests")) {
      assert.equal(row.is_nullable, "YES");
    }
    restarted.recordRuntimeUsage(config, { requestId: "zero-after-upgrade", keyId: consumer.keyId, modelId: "text",
      estimatedCostAmount: 0, costStatus: "priced", pricing,
      cacheWrite: { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" } });
    await waitFor(async () => {
      await restarted.flushRuntimeEvents();
      const current = await restarted.getRuntimeStatsSnapshot(config);
      return current?.totals.cacheWrite.requests === 1 && !restarted.getRuntimeStoreInfo(config).flushing;
    }, 8000);
    for (const options of [{}, { keyId: consumer.keyId, timeRange: "24h" }]) {
      const mixed = await restarted.getRuntimeStatsSnapshot(config, null, options);
      assert.equal(mixed.perModel.text.cacheWrite.observedTokens, 0);
      assert.equal(mixed.perModel.text.cacheWrite.tokens, null);
      assert.equal(mixed.perModel.text.cacheWrite.estimatedCostAmount, null);
      assert.equal(mixed.perModel.text.cacheWrite.unreportedRequests, null);
      assert.equal(mixed.perModel.text.cacheWrite.costStatus, "partial");
    }
    const persistedRollup = await pool.query(`SELECT cache_write_tokens, cache_write_known_cost_amount, cache_write_estimated_cost_amount
      FROM ${quotedSchema}.runtime_rollups WHERE grain = 'daily' AND scope_type = 'model' AND scope_key = 'text'`);
    assert.equal(Number(persistedRollup.rows[0].cache_write_tokens), 0);
    assert.equal(Number(persistedRollup.rows[0].cache_write_known_cost_amount), 0);
    assert.equal(persistedRollup.rows[0].cache_write_estimated_cost_amount, null);
  } finally {
    restarted?.setRuntimeStoreConfig(null);
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.end();
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousConnectionString === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previousConnectionString;
  }
});

test("cache-write event and rollup SQL bind every column and retain partial dimensions", async () => {
  const fixtureDir = path.resolve(`.cache-write-sql-test-${process.pid}-${Date.now()}`);
  await fs.mkdir(fixtureDir);
  const originalQuery = pg.Pool.prototype.query;
  const previousConnectionString = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = "postgresql://test@127.0.0.1:1/test";
  const events = [];
  const rollups = [];
  const statements = [];
  let lastRolled = "0";
  pg.Pool.prototype.query = async function (text, values = []) {
    statements.push(text);
    const insert = text.match(/^INSERT INTO .*"runtime_(events|rollups)" \(([^)]+)\) VALUES /);
    if (insert) {
      const columns = insert[2].split(",").map(name => name.trim());
      assert.equal(new Set(columns).size, columns.length);
      assert.equal(columns.length, insert[1] === "events" ? 28 : 27);
      assert.equal(values.length % columns.length, 0);
      const placeholders = [...text.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
      assert.equal(Math.max(...placeholders), values.length);
      for (let offset = 0; offset < values.length; offset += columns.length) {
        const row = Object.fromEntries(columns.map((column, index) => [column, values[offset + index]]));
        if (insert[1] === "events") events.push({ ...row, event_id: events.length + 1, payload: JSON.parse(row.payload) });
        else rollups.push(row);
      }
    } else if (text.startsWith("SELECT meta_value")) {
      return { rows: [{ meta_value: lastRolled }] };
    } else if (text.includes('"runtime_store_meta"') && text.startsWith("INSERT")) {
      lastRolled = String(values[1]);
    } else if (text.includes("WHERE event_id > $1")) {
      return { rows: events.filter(event => event.event_id > Number(values[0])) };
    }
    return { rows: [] };
  };
  const config = { persistence: { configStore: { mode: "database", filePath: path.join(fixtureDir, "config.json") } },
    observability: { runtimeStore: { enabled: true, schema: `cache_write_sql_${process.pid}`, localBufferPath: path.join(fixtureDir, "pending.ndjson") } } };
  try {
    setRuntimeStoreConfig(config);
    const fields = { keyId: "write-key", modelId: "write-model", actualModelName: "write-actual" };
    recordRuntimeUsage(config, { ...fields, estimatedCostAmount: 0.5,
      cacheWrite: { tokens: 5, usageStatus: "observed", knownCostAmount: 0.05, estimatedCostAmount: 0.05, costStatus: "priced" } });
    recordRuntimeUsage(config, { ...fields, estimatedCostAmount: 0.25,
      cacheWrite: { tokens: null, usageStatus: "unknown", knownCostAmount: 0.02, estimatedCostAmount: null, costStatus: "partial" } });
    recordRuntimeUsage(config, { ...fields, estimatedCostAmount: 0.1 });
    recordRuntimeMediaUsage(config, { ...fields, estimatedCostAmount: 0.006, mediaUsage: { costStatus: "unknown" } });
    await waitFor(async () => {
      await flushRuntimeEvents();
      return events.length === 4 && lastRolled === "4" && !getRuntimeStoreInfo(config).flushing;
    });
    assert.equal(events[0].cache_write_tokens, 5);
    assert.equal(events[0].cache_write_estimated_cost_amount, 0.05);
    assert.equal(events[1].cache_write_tokens, null);
    assert.equal(events[1].cache_write_estimated_cost_amount, null);
    assert.equal(events[2].cache_write_unreported_requests, 1);
    assert.equal(events[3].cache_write_unreported_requests, 0);
    for (const scope of ["global", "model", "key", "actual_model"]) {
      for (const grain of ["hourly", "daily", "weekly"]) {
        const row = rollups.find(row => row.grain === grain && row.scope_type === scope);
        assert.ok(row, `${grain}/${scope}`);
        assert.equal(row.cache_write_requests, 2);
        assert.equal(row.cache_write_observed_requests, 1);
        assert.equal(row.cache_write_priced_requests, 1);
        assert.equal(row.cache_write_partial_cost_requests, 1);
        assert.equal(row.cache_write_unreported_requests, 1);
        assert.equal(row.cache_write_tokens, 5);
        assert.equal(row.cache_write_estimated_cost_amount, null);
        assert.ok(Math.abs(row.cache_write_known_cost_amount - 0.07) < 1e-12);
        assert.ok(Math.abs(row.estimated_cost_amount - 0.856) < 1e-12);
      }
    }
    const migrations = statements.filter(text => text.startsWith("ALTER TABLE") && text.includes("cache_write_tokens"));
    assert.equal(migrations.length, 2);
    for (const sql of migrations) {
      assert.match(sql, /ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT,/);
      assert.match(sql, /ADD COLUMN IF NOT EXISTS cache_write_estimated_cost_amount DOUBLE PRECISION,/);
      assert.match(sql, /ADD COLUMN IF NOT EXISTS cache_write_unreported_requests BIGINT$/);
    }
  } finally {
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    pg.Pool.prototype.query = originalQuery;
    if (previousConnectionString === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previousConnectionString;
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
