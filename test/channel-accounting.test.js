import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { recordError, recordRequest, recordUsage, getStats, beginModelStatsReset } from "../src/stats.js";
import { createMemoryChannelLedger, channelIdentity, channelMetric } from "../src/channel-statistics.js";
import { closeSharedPostgresPools } from "../src/postgres.js";
import { inferenceBinding, registerInferenceRevision } from "../src/inference-binding.js";
import { recordRuntimeRequest, recordRuntimeUsage, recordRuntimeError, getRuntimeStatsSnapshot, setRuntimeStoreConfig,
  drainRuntimeEvents, resetRuntimeModelStats } from "../src/runtime-store.js";

const dayAgo = days => new Date(Date.now() - days * 86400000).toISOString();
const offline = { observability: { runtimeStore: { enabled: false } } };
const recent = { keyId: "team", timeRange: "24h", readOnly: true };
const metrics = row => [row.requests, row.errors, row.promptTokens, row.completionTokens, row.totalTokens,
  row.cachedTokens, row.cacheWrite.tokens, row.knownCostAmount, row.unknownCostRequests];

test("delayed selection on an older runtime clone does not borrow the replacement's legacy catalog or history", () => {
  const previous = {}, current = {}, model = { id: "legacy" };
  registerInferenceRevision(previous, "old", "saved-old", [{ publicId: "legacy", catalogId: "first" }]);
  registerInferenceRevision(current, "new", null, [{ publicId: "legacy", catalogId: "second" }]);
  const binding = inferenceBinding(previous, model, { catalogId: "second" }, "deployment", "responses", "responses");
  assert.deepEqual([binding.canonicalModelId, binding.channelId, binding.configRevision, binding.historyId],
    ["first", null, "old", "saved-old"]);
});

function emit(config) {
  const rows = [
    ["alias-one", "east", 4000, 1000, "team", 0], ["alias-two", "east", 8000, 2000, "team", 0],
    ["alias-one", "west", 8000, 2000, "team", 0], ["alias-one", "west", 300, 30, "other", 0],
    ["alias-two", "west", 100, 25, "team", 3]
  ];
  let duplicate;
  for (const [modelId, channelId, prompt, completion, keyId, age] of rows) {
    const binding = { requestId: randomUUID(), modelId, canonicalModelId: "canon", channelId,
      sourceModelId: `deployment-${channelId}`, routeKey: "messages", backendRouteKey: "responses",
      configRevision: `${channelId}-rev`, keyId, occurredAt: dayAgo(age) };
    const fields = { ...binding, actualModelName: "reported-model", usageSource: "upstream",
      promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion, cachedTokens: 7,
      estimatedCostAmount: 0.25, currency: "USD", costStatus: channelId === "west" ? "partial" : "priced",
      cacheWrite: { tokens: 11, usageStatus: "observed", knownCostAmount: 0, costStatus: "priced", estimatedCostAmount: 0 },
      pricing: { actual: { tier: { id: "observed", promptTokensAtLeast: 0, promptTokensBelow: null } } },
      eventUid: randomUUID() };
    recordRequest(modelId, binding);
    recordRuntimeRequest(config, { ...binding, totalTokens: 12345 }); // Only usage events settle tokens.
    recordUsage(modelId, { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
      prompt_tokens_details: { cached_tokens: 7 } }, { ...fields, cost: { ...fields, amount: fields.estimatedCostAmount } });
    recordRuntimeUsage(config, fields);
    duplicate = fields;
    if (channelId === "east" && modelId === "alias-one") {
      recordError(modelId, binding);
      recordRuntimeError(config, binding);
    }
  }
  return duplicate;
}

function verify(snapshot) {
  assert.equal(snapshot.canonicalModels.length, 1);
  const [parent] = snapshot.canonicalModels;
  assert.equal(parent.canonicalModelId, "canon");
  assert.deepEqual(metrics(parent), [3, 1, 20000, 5000, 25000, 21, 33, 0.75, 1]);
  assert.equal(parent.estimatedCostAmount, null);
  assert.equal(parent.settledRequests, 3);
  const children = [...parent.channels].sort((a, b) => a.channelId.localeCompare(b.channelId));
  assert.deepEqual(children.map(row => [row.channelId, ...metrics(row)]), [
    ["east", 2, 1, 12000, 3000, 15000, 14, 22, 0.5, 0], ["west", 1, 0, 8000, 2000, 10000, 7, 11, 0.25, 1]
  ]);
  const detail = children[0].details.find(row => row.modelId === "alias-two" && row.settledRequests);
  assert.deepEqual([detail.sourceModelId, detail.routeKey, detail.backendRouteKey, detail.actualModelName, detail.tier.id, detail.usageSource],
    ["deployment-east", "messages", "responses", "reported-model", "observed", "upstream"]);
}

test("memory fallback reconciles two aliases after a channel switch, filters and atomic reset", async () => {
  beginModelStatsReset(dayAgo(4)).commit();
  emit(offline);
  const snapshot = await getRuntimeStatsSnapshot(offline, getStats(), recent);
  assert.equal(snapshot.snapshot.source, "memory");
  assert.equal(snapshot.filters, undefined, "compatibility totals remain explicitly cumulative");
  verify(snapshot);
  const reset = beginModelStatsReset(dayAgo(0));
  recordRequest("new", { keyId: "team" });
  reset.commit();
  const cleared = await getRuntimeStatsSnapshot(offline, getStats(), recent);
  assert.deepEqual(cleared.canonicalModels.map(model => [model.canonicalModelId, model.requests]), [[null, 1]]);
  assert.equal(cleared.canonicalModels[0].channels[0].channelId, null);
});

test("bounded memory time window marks eviction without losing cumulative counts", () => {
  const ledger = createMemoryChannelLedger(1);
  const id = channelIdentity("public", {}, "request");
  for (const time of [100, 200]) ledger.record("key", time, id, channelMetric("request", 1, {}, id));
  const limited = ledger.snapshot({ since: new Date(90).toISOString() });
  assert.equal(limited.canonicalWindowTruncated, true);
  assert.equal(limited.canonicalModels[0].requests, 1);
  assert.equal(ledger.snapshot().canonicalModels[0].requests, 2);
  assert.equal(ledger.snapshot({ since: new Date(199).toISOString() }).canonicalWindowTruncated, false);
});

test("PostgreSQL and memory reconcile; replay, legacy retained rollups and reset do not reassign history", {
  skip: !process.env.RUNTIME_MEDIA_TEST_DATABASE_URL, timeout: 30000
}, async () => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname));
  const pool = new pg.Pool({ connectionString });
  const schema = `channel_test_${process.pid}_${Date.now()}`;
  const dir = path.resolve(`.${schema}`);
  const previous = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = "postgresql://fixture@127.0.0.1:1/unreachable";
  await fs.mkdir(dir);
  const config = { persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { runtimeStore: { enabled: true, schema, localBufferPath: path.join(dir, "pending.ndjson") } } };
  try {
    beginModelStatsReset(dayAgo(4)).commit();
    setRuntimeStoreConfig(config);
    const duplicate = emit(config);
    recordRuntimeUsage(config, duplicate);
    const pending = await drainRuntimeEvents();
    assert.equal(pending.pendingPersistedEvents, 12);
    const spool = (await fs.readFile(config.observability.runtimeStore.localBufferPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(spool.filter(row => row.eventUid === duplicate.eventUid).map(row => [row.payload.channelId, row.payload.configRevision]),
      [["west", "west-rev"], ["west", "west-rev"]]);
    const fallback = await getRuntimeStatsSnapshot(config, getStats(), recent);
    verify(fallback);
    assert.equal(fallback.snapshot.source, "memory");
    assert.equal(fallback.snapshot.partial, true);
    process.env.RUNTIME_DB_CONNECTION_STRING = connectionString;
    setRuntimeStoreConfig(config);
    assert.equal((await drainRuntimeEvents()).pendingPersistedEvents, 0);
    const scoped = await getRuntimeStatsSnapshot(config, getStats(), recent);
    assert.equal(scoped.snapshot.source, "database", scoped.snapshot.error?.message);
    verify(scoped);
    verify(await getRuntimeStatsSnapshot(offline, getStats(), recent));
    const all = await getRuntimeStatsSnapshot(config, getStats(), { readOnly: true });
    assert.deepEqual(metrics(all.canonicalModels[0]), metrics((await getRuntimeStatsSnapshot(offline, getStats())).canonicalModels[0]));
    assert.equal(all.perModel["alias-one"].requests, 3);
    assert.equal(all.canonicalModels.length, 1);
    const counters = await pool.query(`SELECT SUM(requests)::int requests, SUM(errors)::int errors,
      SUM(channel_settlements)::int settlements FROM ${schema}.runtime_rollups WHERE scope_type='channel_detail'`);
    assert.deepEqual(counters.rows[0], { requests: 5, errors: 1, settlements: 5 });
    const frozen = await pool.query(`SELECT payload FROM ${schema}.runtime_events WHERE request_id = $1`, [duplicate.requestId]);
    assert.deepEqual(frozen.rows.map(row => [row.payload.channelId, row.payload.configRevision]), [["west", "west-rev"], ["west", "west-rev"]]);
    // Drop detail and only one alias's new dimension rows, as on a partially upgraded store.
    await pool.query(`DELETE FROM ${schema}.runtime_events`);
    await pool.query(`DELETE FROM ${schema}.runtime_rollups WHERE scope_type='channel_detail' AND channel_detail->1->>'modelId'='alias-two'`);
    const legacy = await getRuntimeStatsSnapshot(config, getStats(), { readOnly: true });
    const unknown = legacy.canonicalModels.find(row => row.canonicalModelId === null);
    assert.deepEqual([unknown.requests, unknown.promptTokens, unknown.channels[0].channelId, unknown.unknownCostRequests], [2, 8100, null, null]);
    assert.equal(legacy.canonicalModels.reduce((sum, row) => sum + row.totalTokens, 0), all.totals.totalTokens);
    assert.equal(legacy.perModel["alias-two"].promptTokens, 8100);
    await pool.query(`DELETE FROM ${schema}.runtime_rollups WHERE scope_type='channel_detail'`);
    await pool.query(`ALTER TABLE ${schema}.runtime_rollups DROP COLUMN channel_detail, DROP COLUMN channel_settlements`);
    const beforeMigration = await getRuntimeStatsSnapshot(config, getStats(), { readOnly: true });
    assert.equal(beforeMigration.snapshot.source, "database", "a GET on old schema must not migrate or fall back");
    assert.deepEqual(beforeMigration.canonicalModels.map(row => [row.canonicalModelId, row.unknownCostRequests, row.totalTokens]),
      [[null, null, all.totals.totalTokens]]);
    await resetRuntimeModelStats(config);
    const after = await getRuntimeStatsSnapshot(config, getStats(), { readOnly: true });
    assert.deepEqual(after.canonicalModels, []);
    assert.equal(after.totals.totalTokens, all.totals.totalTokens);
  } finally {
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    if (previous == null) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previous;
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
