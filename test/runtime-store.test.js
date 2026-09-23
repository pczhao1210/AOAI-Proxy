import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { getRuntimeStoreInfo, recordRuntimeError, recordRuntimeRequest, recordRuntimeUsage, recordRuntimeMediaUsage, setRuntimeStoreConfig, flushRuntimeEvents, hydrateGovernanceRuntime, getRuntimeStatsSnapshot, resetRuntimeModelStats } from "../src/runtime-store.js";
import { closeSharedPostgresPools, quoteIdentifier } from "../src/postgres.js";
import { createMediaUsageTracker } from "../src/proxy/media-usage.js";
import { settleMediaUsage } from "../src/proxy/media-accounting.js";
import { getStats, recordUsage } from "../src/stats.js";

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
    await assert.rejects(resetRuntimeModelStats(config), { code: "RUNTIME_STORE_CONFIG_INCOMPLETE" });
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

    const beforeReset = await restarted.getRuntimeStatsSnapshot(config);
    const beforeResetBudget = await restarted.hydrateGovernanceRuntime(config, consumer.keyId, start, start);
    const countEvents = async () => Number((await pool.query(`SELECT COUNT(*) AS count FROM ${quotedSchema}.runtime_events`)).rows[0].count);
    const eventCount = await countEvents();
    const reset = await restarted.resetRuntimeModelStats(config);
    const afterReset = await restarted.getRuntimeStatsSnapshot(config);
    assert.deepEqual(afterReset.perModel, {});
    assert.deepEqual(afterReset.totals, beforeReset.totals);
    assert.deepEqual(afterReset.perKey, beforeReset.perKey);
    assert.deepEqual(await restarted.hydrateGovernanceRuntime(config, consumer.keyId, start, start), beforeResetBudget);
    assert.equal(await countEvents(), eventCount, "Reset must preserve raw events");
    assert.equal(afterReset.modelsResetAt, reset.modelsResetAt);

    restarted.setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    restarted = await import(`../src/runtime-store.js?model-stats-reset-restart=${schema}`);
    restarted.setRuntimeStoreConfig(config);
    for (const options of [{}, { keyId: consumer.keyId, timeRange: "24h" }]) {
      const current = await restarted.getRuntimeStatsSnapshot(config, null, options);
      assert.deepEqual(current.perModel, {}, "Persisted reset must also filter retained event history");
      assert.equal(current.modelsResetAt, reset.modelsResetAt);
    }
    restarted.recordRuntimeUsage(config, {
      requestId: "tier-after-reset", keyId: consumer.keyId, modelId: "text", actualModelName: "actual-text",
      promptTokens: 272001, completionTokens: 3, totalTokens: 272004, cachedTokens: 100,
      costStatus: "priced", estimatedCostAmount: 1,
      cacheWrite: { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" },
      pricing: { actual: { source: "model.pricing", policyDigest: "sha256:reset-tier", tieringState: "tier",
        tier: { id: "long", promptTokensAtLeast: 272001, promptTokensBelow: null, rates: { inputPer1mTokens: 4 } } } }
    });
    await restarted.flushRuntimeEvents();
    for (const options of [{}, { keyId: consumer.keyId, timeRange: "24h" }]) {
      const current = await restarted.getRuntimeStatsSnapshot(config, null, options);
      assert.equal(current.perModel.text.billingTiers.length, 1);
      const tier = current.perModel.text.billingTiers[0];
      assert.equal(tier.requests, 1);
      assert.equal(tier.actualModelId, "actual-text");
      assert.equal(tier.tier.id, "long");
      assert.equal(tier.tier.promptTokensAtLeast, 272001);
      assert.equal(tier.promptTokens, 272001);
      assert.equal(tier.cacheWrite.tokens, 0);
      assert.equal(tier.estimatedCostAmount, 1);
      assert.equal(current.perModel.voice, undefined);
    }
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
      return { rows: [{ meta_value: values[0] === "last_rolled_event_id" ? lastRolled : "" }] };
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

function mockStatisticsDatabase() {
  const state = { events: [], rollups: [], meta: new Map(), statements: [], onReset: null, onRollup: null };
  const numericColumns = ["requests", "errors", "blocked_count", "warning_count", "prompt_tokens", "completion_tokens",
    "total_tokens", "cached_tokens", "text_unknown_cost_requests", "estimated_cost_amount", "model_router_cost_amount",
    "actual_model_cost_amount", "cache_write_requests", "cache_write_observed_requests", "cache_write_priced_requests",
    "cache_write_partial_cost_requests"];
  const nullableColumns = ["cache_write_tokens", "cache_write_known_cost_amount", "cache_write_estimated_cost_amount"];
  function aggregate(rows) {
    const result = { currency: "USD" };
    for (const name of numericColumns) result[name] = rows.reduce((sum, row) => sum + Number(row[name] || 0), 0);
    for (const name of nullableColumns) {
      result[name] = rows.some(row => row[name] != null) ? rows.reduce((sum, row) => sum + Number(row[name] || 0), 0) : null;
    }
    result.cache_write_unreported_requests = rows.some(row => row.cache_write_unreported_requests === null)
      ? null : rows.reduce((sum, row) => sum + Number(row.cache_write_unreported_requests || 0), 0);
    return result;
  }
  function grouped(rows, key, project) {
    const groups = new Map();
    for (const row of rows) {
      const id = key(row);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(row);
    }
    return [...groups.values()].map(group => ({ ...aggregate(group), ...project(group[0], group) }));
  }
  state.query = async (sql, values = []) => {
    state.statements.push({ sql, values });
    if (sql.includes("WITH reset_models AS")) {
      await state.onReset?.();
      state.rollups = state.rollups.filter(row => !["model", "actual_model", "billing_tier"].includes(row.scope_type));
      state.meta.set(values[0], values[1]);
      return { rows: [] };
    }
    if (sql.startsWith("SELECT meta_value")) return { rows: [{ meta_value: state.meta.get(values[0]) || "" }] };
    if (sql.startsWith("INSERT") && sql.includes('"runtime_store_meta"')) {
      state.meta.set(values[0], values[1]);
      return { rows: [] };
    }
    const insert = sql.match(/^INSERT INTO .*"runtime_(events|rollups)" \(([^)]+)\) VALUES /);
    if (insert) {
      const columns = insert[2].split(",").map(name => name.trim());
      if (insert[1] === "rollups") await state.onRollup?.();
      for (let offset = 0; offset < values.length; offset += columns.length) {
        const row = Object.fromEntries(columns.map((column, index) => [column, values[offset + index]]));
        if (insert[1] === "events") {
          state.events.push({ ...row, event_id: state.events.length + 1, payload: JSON.parse(row.payload) });
        } else {
          const match = state.rollups.find(item => ["grain", "bucket_start", "scope_type", "scope_key", "scope_subkey"].every(name => item[name] === row[name]));
          if (match) Object.assign(match, aggregate([match, row]));
          else state.rollups.push(row);
        }
      }
      return { rows: [] };
    }
    if (sql.includes("WHERE event_id > $1")) return { rows: state.events.filter(row => row.event_id > Number(values[0])) };
    if (!sql.includes("SELECT") || sql.includes("date_trunc(") || sql.includes("ORDER BY occurred_at DESC")) return { rows: [] };
    if (sql.includes("WITH media_events AS")) {
      const cutoff = sql.includes("WHERE model_recorded_at >") ? values.at(-1) : "";
      const media = state.events.filter(row => row.payload.source === "media");
      return { rows: ["total", "model", "key"].flatMap(scope => grouped(
        media.filter(row => scope !== "model" || !cutoff || row.payload.modelStatsRecordedAt > cutoff),
        row => scope === "total" ? "" : row[`${scope}_id`],
        (row, group) => ({ scope_type: scope, scope_key: scope === "total" ? "" : row[`${scope}_id`], requests: group.length,
          observed_requests: group.filter(item => item.payload.media.usageStatus === "observed").length,
          unknown_usage_requests: group.filter(item => item.payload.media.usageStatus !== "observed").length,
          unknown_cost_requests: group.filter(item => item.payload.media.costStatus !== "priced").length,
          counters: {}, cost_amounts: group.reduce((costs, item) => {
            for (const [currency, amount] of Object.entries(item.payload.media.knownCostAmounts || {})) {
              costs[currency] = (costs[currency] || 0) + amount;
            }
            return costs;
          }, {}) })
      )) };
    }
    if (sql.includes('FROM "model_stats_mock"."runtime_rollups"')) {
      const scope = sql.match(/scope_type = '([^']+)'/)?.[1];
      const rows = state.rollups.filter(row => row.grain === "daily" && row.scope_type === scope);
      if (scope === "global") return { rows: [aggregate(rows)] };
      if (scope === "model") return { rows: grouped(rows, row => row.scope_key, row => ({ model_id: row.scope_key })) };
      if (scope === "key") return { rows: grouped(rows, row => row.scope_key, row => ({ key_id: row.scope_key })) };
      if (scope === "actual_model" || scope === "billing_tier") return { rows: grouped(rows, row => `${row.scope_key}/${row.scope_subkey}`,
        row => ({ model_id: row.scope_key, [scope === "billing_tier" ? "tier_key" : "actual_model_id"]: row.scope_subkey })) };
      return { rows: [] };
    }
    if (sql.includes('FROM "model_stats_mock"."runtime_events"')) {
      let rows = state.events;
      for (const [regex, field, comparison] of [
        [/key_id = \$(\d+)/, "key_id", (a, b) => a === b],
        [/occurred_at >= \$(\d+)/, "occurred_at", (a, b) => a >= b],
        [/occurred_at\) > \$(\d+)/, "recorded", (a, b) => a > b]
      ]) {
        const match = sql.match(regex);
        if (match) rows = rows.filter(row => comparison(field === "recorded" ? row.payload.modelStatsRecordedAt || row.occurred_at : row[field], values[Number(match[1]) - 1]));
      }
      const tierQuery = sql.includes("AS pricing_audit");
      if (tierQuery) rows = rows.filter(row => row.event_type === "usage");
      if (sql.includes("actual_model_id <> ''")) rows = rows.filter(row => row.actual_model_id);
      rows = rows.map(row => ({ ...row, requests: row.event_type === (tierQuery || sql.includes("GROUP BY model_id, actual_model_id") ? "usage" : "request") ? 1 : 0,
        errors: row.event_type === "error" ? 1 : 0 }));
      if (tierQuery) return { rows: grouped(rows, row => JSON.stringify([row.model_id, row.actual_model_id, row.payload.textCost?.pricing?.actual]),
        row => ({ model_id: row.model_id, actual_model_id: row.actual_model_id, pricing_audit: row.payload.textCost?.pricing?.actual })) };
      if (sql.includes("GROUP BY model_id, actual_model_id")) return { rows: grouped(rows, row => `${row.model_id}/${row.actual_model_id}`,
        row => ({ model_id: row.model_id, actual_model_id: row.actual_model_id })) };
      if (sql.includes("GROUP BY model_id")) return { rows: grouped(rows, row => row.model_id, row => ({ model_id: row.model_id })) };
      if (sql.includes("GROUP BY key_id")) return { rows: grouped(rows, row => row.key_id, row => ({ key_id: row.key_id })) };
      return { rows: [aggregate(rows)] };
    }
    return { rows: [] };
  };
  return state;
}

    test("billing scopes survive restart and reset excludes pending/replayed history without changing global scopes", async () => {
      const fixtureDir = path.resolve(`.model-stats-test-${process.pid}-${Date.now()}`);
      await fs.mkdir(fixtureDir);
      const originalQuery = pg.Pool.prototype.query;
      const previousConnectionString = process.env.RUNTIME_DB_CONNECTION_STRING;
      process.env.RUNTIME_DB_CONNECTION_STRING = "postgresql://test@127.0.0.1:1/test";
      const database = mockStatisticsDatabase();
      pg.Pool.prototype.query = database.query;
      const config = { persistence: { configStore: { mode: "database", filePath: path.join(fixtureDir, "config.json") } },
        observability: { runtimeStore: { schema: "model_stats_mock", flushIntervalMs: 60000, batchSize: 100,
          localBufferPath: path.join(fixtureDir, "pending.ndjson") } } };
      let store = await import(`../src/runtime-store.js?model-stats=${Date.now()}`);
      const fields = { keyId: "tier-key", modelId: "tier-model", actualModelName: "actual-model" };
      const usage = (prompt, threshold = 272001, rate = 1) => ({
        ...fields, promptTokens: prompt, totalTokens: prompt, estimatedCostAmount: rate, costStatus: "priced",
        pricing: { actual: { source: "snapshot", policyDigest: `price-${rate}`, tieringState: "tier",
          tier: { id: prompt < threshold ? "base" : "long", promptTokensAtLeast: prompt < threshold ? 0 : threshold,
            promptTokensBelow: prompt < threshold ? threshold : null, rates: { inputPer1mTokens: rate } } } }
      });
      try {
        store.setRuntimeStoreConfig(config);
        store.recordRuntimeRequest(config, fields);
        store.recordRuntimeUsage(config, usage(272000));
        store.recordRuntimeUsage(config, usage(272001));
        store.recordRuntimeUsage(config, usage(272000, 272001, 2));
        store.recordRuntimeUsage(config, usage(272001, 300001, 3));
        const renamed = usage(10);
        renamed.pricing.actual.tier.id = "short <=272K";
        store.recordRuntimeUsage(config, renamed);
        store.recordRuntimeUsage(config, { ...fields, actualModelName: "", promptTokens: 1, totalTokens: 1,
          costStatus: "priced", pricing: { actual: { tieringState: "flat", tier: null } } });
        store.recordRuntimeMediaUsage(config, { keyId: "tier-key", modelId: "voice", estimatedCostAmount: 2,
          mediaUsage: { usageStatus: "unknown", costStatus: "partial", knownCostAmounts: { USD: 2 } } });
        const before = await store.getRuntimeStatsSnapshot(config);
        const beforeEventCount = database.events.length;
        assert.ok(before);
        assert.deepEqual(before.perModel["tier-model"].billingTiers.map(row => [row.tier.id, row.requests]),
          [["base", 3], ["long", 1], ["short <=272K", 1], [undefined, 1]]);
        assert.equal(before.perModel["tier-model"].requests, 1);
        assert.equal(before.perModel["tier-model"].actualModels["actual-model"].requests, 1);
        assert.equal(before.perModel.voice.billingTiers[0].requests, 1);
        assert.equal(before.perModel.voice.billingTiers[0].tier.kind, "unknown");
        assert.equal(before.perModel.voice.billingTiers[0].estimatedCostAmount, 2);
        assert.equal(before.perModel.voice.media.unknownCostRequests, 1);
        assert.deepEqual(before.perModel["tier-model"].billingTiers[0].tier.intervals,
          [{ promptTokensAtLeast: 0, promptTokensBelow: 272001 }, { promptTokensAtLeast: 0, promptTokensBelow: 300001 }]);
        assert.equal(before.perModel["tier-model"].billingTiers[3].actualModelId, "tier-model");
        assert.equal(before.perModel["tier-model"].billingTiers[3].tier.kind, "flat");
        assert.equal(before.perModel["tier-model"].billingTiers[0].estimatedCostAmount, 6);
        assert.equal(before.perModel["tier-model"].billingTiers[0].cacheWrite.tokens, null);
        const filtered = await store.getRuntimeStatsSnapshot(config, null, { keyId: "tier-key", timeRange: "24h" });
        assert.deepEqual(filtered.perModel["tier-model"].billingTiers, before.perModel["tier-model"].billingTiers);
        store.setRuntimeStoreConfig(null);
        store = await import(`../src/runtime-store.js?model-stats-restart=${Date.now()}`);
        store.setRuntimeStoreConfig(config);
        assert.deepEqual((await store.getRuntimeStatsSnapshot(config)).perModel["tier-model"].billingTiers, before.perModel["tier-model"].billingTiers);

        for (const row of database.rollups.filter(row => row.scope_type === "billing_tier")) {
          const parts = JSON.parse(row.scope_subkey);
          if (parts[4] === "short <=272K") row.scope_subkey = JSON.stringify(parts.slice(0, 4));
        }
        const oldKeys = await store.getRuntimeStatsSnapshot(config);
        const unnamed = oldKeys.perModel["tier-model"].billingTiers.find(row => row.tier.kind === "tier" && !row.tier.id);
        assert.equal(unnamed.requests, 1);
        assert.equal(unnamed.tier.promptTokensBelow, 272001);
        assert.equal(unnamed.estimatedCostAmount, 1);
        assert.equal(oldKeys.perModel["tier-model"].totalTokens, before.perModel["tier-model"].totalTokens);

        // Simulate retained pre-feature rollups without replaying or resetting their cursor.
        database.rollups = database.rollups.filter(row => row.scope_type !== "billing_tier");
        const legacyCursor = database.meta.get("last_rolled_event_id");
        const legacy = await store.getRuntimeStatsSnapshot(config);
        assert.equal(database.meta.get("last_rolled_event_id"), legacyCursor);
        assert.equal(legacy.perModel["tier-model"].billingTiers[0].requests, null);
        assert.equal(legacy.perModel["tier-model"].billingTiers[0].tier.kind, "unknown");
        assert.equal(legacy.perModel["tier-model"].billingTiers.reduce((sum, row) => sum + row.totalTokens, 0), before.perModel["tier-model"].totalTokens);
        assert.equal(legacy.perModel.voice.billingTiers[0].estimatedCostAmount, 2);
        assert.equal(legacy.perModel.voice.billingTiers[0].tier.kind, "unknown");
        assert.equal(legacy.perModel.voice.billingTiers[0].requests, null);
        assert.equal(legacy.perModel.voice.media.unknownCostRequests, 1);

        store.recordRuntimeUsage(config, usage(9));
        recordUsage(fields.modelId, { prompt_tokens: 9 });
        const pending = { eventType: "usage", occurredAt: "2026-01-01T00:00:00.000Z", modelId: fields.modelId,
          keyId: fields.keyId, promptTokens: 7, totalTokens: 7, payload: {} };
        await fs.writeFile(config.observability.runtimeStore.localBufferPath, `${JSON.stringify(pending)}\n`);
        store.setRuntimeStoreConfig(config);
        await waitFor(() => store.getRuntimeStoreInfo(config).persistedEventCount === 1);
        let resumeReset;
        let resetEntered = false;
        database.onReset = async () => {
          resetEntered = true;
          await new Promise(resolve => { resumeReset = resolve; });
        };
        let resumeRollup;
        let rollupEntered = false;
        database.onRollup = async () => {
          rollupEntered = true;
          await new Promise(resolve => { resumeRollup = resolve; });
        };
        const flushPromise = store.flushRuntimeEvents();
        await waitFor(() => rollupEntered);
        const resetPromise = store.resetRuntimeModelStats(config);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(resetEntered, false, "reset waits for the active rollup");
        database.onRollup = null;
        resumeRollup();
        await flushPromise;
        await waitFor(() => resetEntered);
        store.recordRuntimeUsage(config, usage(3));
        recordUsage(fields.modelId, { prompt_tokens: 3 });
        const snapshotPromise = store.getRuntimeStatsSnapshot(config);
        resumeReset();
        const reset = await resetPromise;
        database.onReset = null;
        const after = await snapshotPromise;
        await store.flushRuntimeEvents();
        const flushed = await store.getRuntimeStatsSnapshot(config);
        assert.equal(after.modelsResetAt, reset.modelsResetAt);
        assert.equal(flushed.perModel["tier-model"].promptTokens, 3);
        assert.equal(flushed.perModel["tier-model"].billingTiers[0].requests, 1);
        assert.equal(flushed.perModel["tier-model"].requests, 0);
        assert.equal(flushed.perModel["tier-model"].actualModels["actual-model"].requests, 0);
        assert.equal(getStats().perModel["tier-model"].promptTokens, 3);
        assert.equal(flushed.perModel.voice, undefined);
        assert.equal(flushed.totals.totalTokens, before.totals.totalTokens + 19);
        assert.deepEqual(flushed.totals.media, before.totals.media);
        assert.equal(flushed.perKey["tier-key"].totalTokens, before.perKey["tier-key"].totalTokens + 19);
        assert.equal(database.events.length, beforeEventCount + 3);
        assert.ok(Number(database.meta.get("last_rolled_event_id")) > Number(legacyCursor));
        const scoped = await store.getRuntimeStatsSnapshot(config, null, { keyId: "tier-key", timeRange: "24h" });
        assert.equal(scoped.perModel["tier-model"].promptTokens, 3);
        assert.equal(scoped.perModel.voice, undefined);
        assert.equal(scoped.modelsResetAt, reset.modelsResetAt);
        assert.deepEqual(scoped.perModel["tier-model"].billingTiers, flushed.perModel["tier-model"].billingTiers);
        store.setRuntimeStoreConfig(null);
        store = await import(`../src/runtime-store.js?model-stats-reset-restart=${Date.now()}`);
        store.setRuntimeStoreConfig(config);
        const restarted = await store.getRuntimeStatsSnapshot(config);
        assert.equal(restarted.modelsResetAt, reset.modelsResetAt);
        assert.equal(restarted.perModel["tier-model"].promptTokens, 3);
        assert.equal(restarted.totals.totalTokens, flushed.totals.totalTokens);

        database.onReset = async () => {
          store.recordRuntimeUsage(config, usage(4));
          recordUsage(fields.modelId, { prompt_tokens: 4 });
          throw new Error("reset transaction failed");
        };
        await assert.rejects(store.resetRuntimeModelStats(config), /reset transaction failed/);
        database.onReset = null;
        assert.equal(getStats().perModel["tier-model"].promptTokens, 7);
        const failed = await store.getRuntimeStatsSnapshot(config);
        assert.equal(failed.modelsResetAt, reset.modelsResetAt);
        assert.equal(failed.perModel["tier-model"].promptTokens, 7);
        assert.equal(database.statements.filter(({ sql }) => sql.includes("DELETE FROM") && sql.includes("scope_type IN")).length, 2);
        store.recordRuntimeMediaUsage(config, { keyId: "tier-key", modelId: "voice", estimatedCostAmount: 0.4,
          mediaUsage: { usageStatus: "unknown", costStatus: "partial", knownCostAmounts: { USD: 0.4 } } });
        const newMedia = await store.getRuntimeStatsSnapshot(config);
        const filteredMedia = await store.getRuntimeStatsSnapshot(config, null, { keyId: "tier-key" });
        assert.equal(newMedia.perModel.voice.billingTiers[0].estimatedCostAmount, 0.4);
        assert.equal(newMedia.perModel.voice.estimatedCostAmount, 0.4);
        assert.equal(newMedia.perModel.voice.billingTiers[0].requests, 1);
        assert.equal(newMedia.perModel.voice.media.unknownCostRequests, 1);
        assert.equal(newMedia.totals.media.unknownCostRequests, 2);
        assert.deepEqual(newMedia.perModel.voice.media.costAmounts, { USD: 0.4 });
        assert.deepEqual(newMedia.totals.media.costAmounts, { USD: 2.4 });
        assert.deepEqual(filteredMedia.perModel.voice, newMedia.perModel.voice);
      } finally {
        store.setRuntimeStoreConfig(null);
        await closeSharedPostgresPools();
        pg.Pool.prototype.query = originalQuery;
        if (previousConnectionString === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
        else process.env.RUNTIME_DB_CONNECTION_STRING = previousConnectionString;
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    });
