import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-runtime-spill-"));
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
    await waitFor(() => getRuntimeStoreInfo(config).persistedEventCount === 5);

    const info = getRuntimeStoreInfo(config);
    const persisted = await fs.readFile(localBufferPath, "utf8");
    assert.equal(info.configured, false);
    assert.equal(info.spilloverActive, true);
    assert.equal(info.persistedEventCount, 5);
    assert.match(persisted, /spill-request/);
    const events = persisted.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.eventType), ["request", "usage", "error", "usage", "usage"]);
    assert.equal(events[3].estimatedCostAmount, 0.006);
    assert.deepEqual(events[3].payload.media.counters, { durationSeconds: 60 });
    assert.equal(events[3].payload.media.estimatedCostAmount, 0.006);
    assert.deepEqual(events[3].payload.media.pricingSources, ["model.pricing"]);
    assert.equal(events[4].payload.media.estimatedCostAmount, null);
    assert.equal(events[4].payload.media.costStatus, "unknown");
    assert.equal(persisted.includes("private-audio"), false);
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

if (process.env.RUNTIME_MEDIA_TEST_DATABASE_URL) test("media ledger persists known and unknown usage and restores budget totals from PostgreSQL", { timeout: 15000 }, async () => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname), "Use an isolated loopback database");
  const previousConnectionString = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = connectionString;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-media-ledger-"));
  const schema = `media_test_${process.pid}_${Date.now()}`;
  const quotedSchema = quoteIdentifier(schema, "test schema");
  const pool = new pg.Pool({ connectionString });
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
    await waitFor(async () => {
      await flushRuntimeEvents();
      const exists = await pool.query("SELECT to_regclass($1) AS table_name", [`${schema}.runtime_events`]);
      if (!exists.rows[0].table_name) return false;
      const result = await pool.query(`SELECT COUNT(*) AS count FROM ${quotedSchema}.runtime_events`);
      return Number(result.rows[0].count) === 4 && !getRuntimeStoreInfo(config).flushing;
    }, 8000);
    const events = await pool.query(`SELECT request_id, estimated_cost_amount, payload FROM ${quotedSchema}.runtime_events WHERE event_type = 'usage' ORDER BY request_id`);
    assert.equal(Number(events.rows[0].estimated_cost_amount), 0.006);
    assert.equal(events.rows[0].payload.media.costStatus, "priced");
    assert.deepEqual(events.rows[0].payload.media.counters, { durationSeconds: 60 });
    assert.equal(events.rows[1].payload.media.estimatedCostAmount, null);
    assert.equal(events.rows[1].payload.media.costStatus, "unknown");
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    setRuntimeStoreConfig(config);
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const restored = await hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    assert.ok(restored);
    assert.equal(Number(restored.total_requests), 2);
    assert.equal(Number(restored.budget_requests), 2);
    assert.equal(Number(restored.budget_media_unknown_cost_requests), 1);
    assert.equal(Number(restored.budget_spent_amount), 0.006);
    const again = await hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    assert.equal(Number(again.budget_spent_amount), 0.006);
    const stats = await getRuntimeStatsSnapshot(config);
    assert.equal(stats.totals.media.unknownCostRequests, 1);
    assert.equal(stats.totals.media.estimatedCostAmount, null);
    assert.deepEqual(stats.totals.media.costAmounts, { USD: 0.006 });
    assert.deepEqual(stats.totals.media.counters, { durationSeconds: 60 });
    assert.deepEqual(stats.perModel.voice.media, stats.perKey[consumer.keyId].media);
    const filtered = await getRuntimeStatsSnapshot(config, null, { keyId: consumer.keyId, timeRange: "24h" });
    assert.deepEqual(filtered.totals.media, stats.totals.media);
    const other = await getRuntimeStatsSnapshot(config, null, { keyId: "other-key" });
    assert.equal(other.totals.media, undefined);
    assert.deepEqual(other.perKey, {});
  } finally {
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.end();
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousConnectionString === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previousConnectionString;
  }
});
