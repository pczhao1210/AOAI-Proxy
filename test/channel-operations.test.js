import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { queryChannelOperations, recordChannelConfigChanges, recordChannelOperation } from "../src/channel-operations.js";
import { appendStructuredLog, buildContentLogSnapshot, buildLogAnalyticsRecord, queryLogs, setLogConfig } from "../src/logs.js";
import { buildLogSummaryText } from "../admin-ui/src/utils.js";
import { registerInferenceRevision } from "../src/inference-binding.js";
import { closeSharedPostgresPools, quoteIdentifier } from "../src/postgres.js";
import { drainRuntimeEvents, getRuntimeStatsSnapshot, getRuntimeStoreInfo, readGovernanceRuntimes, recordRuntimeOperation, recordRuntimeRequest, setRuntimeStoreConfig } from "../src/runtime-store.js";

const config = {
  observability: { logs: { messageContentMode: "full", sinks: ["memory"] }, runtimeStore: { enabled: false } },
  persistence: { configStore: { mode: "file" } }
};

test("operation payload, Full logs, nested errors and copied diagnostics cannot disclose device flow secrets", async () => {
  setLogConfig(config);
  const operationId = randomUUID();
  registerInferenceRevision(config, "b".repeat(64));
  const secret = "PRIVATE-DEVICE-FIXTURE";
  const fields = { operationId, channelId: "blue", authProfile: "vscode", event: "admin.copilot_auth_failed",
    errorCode: "COPILOT_DEVICE_DENIED", stateAfter: "failed", userCode: secret, device_code: secret,
    authResponse: { message: secret }, responsePreview: secret, failureReason: secret, requestId: "req-trigger" };
  const uid = recordChannelOperation(config, fields);
  const result = await queryChannelOperations(config, { connectionId: "blue", operationId });
  assert.equal(result.persistence, "disabled");
  assert.equal(result.items.length, 1);
  const entry = result.items[0];
  assert.equal(entry.fields.eventUid, uid);
  assert.equal(entry.requestId, "req-trigger");
  assert.equal(entry.fields.stateAfter, "failed");
  assert.equal(entry.fields.configRevision, "b".repeat(64));
  assert.equal(queryLogs({ view: "requests", requestId: "req-trigger" }).total, 0);
  assert.equal(queryLogs({ view: "events", operationId, connectionId: "red" }).total, 0);
  assert.equal(recordChannelOperation(config, { ...fields, event: "poll.tick" }), null);
  const retained = await queryChannelOperations(config, { recordSource: "database", limit: 50000 });
  assert.equal(retained.persistence, "disabled");
  assert.equal(retained.limit, 100);
  const copy = buildLogSummaryText(entry, (_key, fallback) => fallback);
  assert.ok(copy.includes(operationId));
  const generic = appendStructuredLog("warn", {
    event: "fixture.provider", failureReason: `nested JSON: {"githubAccessToken":"${secret}"}`,
    details: { err: new Error(`denied user_code=${secret}`), deviceFlowResponse: { arbitrary: secret } },
    url: `/login?state=result&copilotToken=${secret}`
  });
  const snapshot = buildContentLogSnapshot({ provider: { userCode: secret, device_code: secret,
    oauthResponse: { error: secret }, credentialCiphertext: secret, copilotToken: secret } }, { mode: "full" });
  const control = appendStructuredLog("warn", {
    event: "http.request_completed", source: "http.admin", requestId: "admin-device-req", method: "POST",
    url: "/private/api/copilot/blue/login?profile=vscode", responsePreview: secret,
    err: new Error(secret), failureReason: secret, responseSha256: secret
  });
  assert.equal(queryLogs({ view: "requests", requestId: "admin-device-req" }).total, 0);
  assert.equal(queryLogs({ view: "access", requestId: "admin-device-req" }).total, 1);
  assert.ok(snapshot.bodyJson.includes("[REDACTED]"));
  assert.doesNotMatch(JSON.stringify([result, buildLogAnalyticsRecord(entry), copy, generic, control, snapshot]), /PRIVATE-DEVICE-FIXTURE/);
});

test("per-connection failure suppression preserves the first failure and reports repeats on recovery", () => {
  setLogConfig(config);
  const fail = { event: "proxy.copilot_token_refresh_failed", channelId: "repeat", errorCode: "COPILOT_RATE_LIMIT" };
  assert.ok(recordChannelOperation(config, fail));
  for (let i = 0; i < 50; i++) assert.equal(recordChannelOperation(config, fail), null);
  assert.ok(recordChannelOperation(config, { ...fail, channelId: "other" }));
  recordChannelOperation(config, { ...fail, event: "proxy.copilot_token_refresh_succeeded" });
  const result = queryChannelOperations(config, { connectionId: "repeat" });
  assert.equal(result.total, 2);
  assert.equal(result.items[0].fields.suppressedFailures, 50);
  assert.ok(result.items[0].fields.firstFailureAt);
  assert.ok(!result.items[0].requestId);
  assert.ok(recordChannelOperation(config, fail));
});

test("channel config difference limits rows, identifies both bindings, redacts Keys and ignores permission order", () => {
  setLogConfig(config);
  const operationId = randomUUID();
  const old = { upstreams: [{ channelId: "blue", name: "Blue", auth: { apiKey: "PRIVATE" }, modelMappings: [] }],
    models: [{ id: "public", selectedBinding: { channelId: "blue", sourceModelId: "d1" } }],
    apiKeys: [{ id: "secret-id", key: "PRIVATE-KEY", allowedModels: ["public"] }] };
  const next = structuredClone(old);
  next.upstreams[0].modelMappings = Array.from({ length: 40 }, (_, i) => ({ sourceModelId: `d${i}`, enabled: true }));
  next.models[0].selectedBinding = { channelId: "green", sourceModelId: "d2" };
  next.models.push({ id: "extra" });
  next.apiKeys[0].allowedModels = Array.from({ length: 30 }, (_, i) => `public-${i}`);
  recordChannelConfigChanges(config, old, next, { operationId, outcome: "persisted" });
  const result = queryChannelOperations(config, { operationId });
  assert.equal(result.items.filter(x => x.event === "admin.channel_mappings_changed").length, 17);
  assert.equal(result.items.find(x => x.fields.change === "summary").fields.omittedCount, 24);
  const change = result.items.find(x => x.event === "admin.model_channel_changed");
  assert.equal(change.fields.previousChannelId, "blue");
  assert.equal(change.fields.sourceModelId, "d2");
  assert.equal(result.items.find(x => x.event === "admin.key_model_access_changed").fields.addedModels.length, 8);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret-id/);
  const same = structuredClone(next);
  same.apiKeys[0].allowedModels.reverse();
  same.apiKeys[0].key = "NEW-PRIVATE";
  const retryId = randomUUID();
  recordChannelConfigChanges(config, next, same, { operationId: retryId, outcome: "applied" });
  assert.equal(queryChannelOperations(config, { operationId: retryId }).total, 0);
});

const databaseUrl = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
test("retained operation history shares event UID, honors retention, never drains, and creates no ledger or rollup rows", {
  skip: !databaseUrl, timeout: 30000
}, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname));
  const schema = `operations_${randomUUID().replaceAll("-", "")}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-ops-"));
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const table = `${quoteIdentifier(schema, "test schema")}."runtime_events"`;
  const previous = process.env.RUNTIME_DB_CONNECTION_STRING;
  process.env.RUNTIME_DB_CONNECTION_STRING = databaseUrl;
  const db = { persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { ...config.observability, runtimeStore: { enabled: true, schema, maxQueueSize: 100, batchSize: 500, flushIntervalMs: 60000 } } };
  t.after(async () => {
    setRuntimeStoreConfig(null);
    await closeSharedPostgresPools();
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema, "test schema")} CASCADE`);
    await pool.end();
    if (previous === undefined) delete process.env.RUNTIME_DB_CONNECTION_STRING;
    else process.env.RUNTIME_DB_CONNECTION_STRING = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  setRuntimeStoreConfig(db);
  setLogConfig(db);
  const query = fields => queryChannelOperations(db, { recordSource: "database", ...fields });
  assert.equal((await query({})).persistence, "unavailable");
  assert.equal((await pool.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema, null, "GET must not create tables");
  const event = { event: "proxy.copilot_token_refresh_failed", channelId: "database", operationId: randomUUID(), authProfile: "opencode" };
  const uid = recordChannelOperation(db, { ...event, keyId: "anonymous", totalTokens: 12345, error: "PRIVATE" });
  assert.equal((await query({})).persistence, "unavailable");
  assert.equal(getRuntimeStoreInfo(db).queueLength, 1);
  assert.equal((await drainRuntimeEvents()).flushed, 1);
  recordRuntimeOperation(db, { ...event, eventUid: uid });
  await drainRuntimeEvents();
  const history = await query({ connectionId: "database", operationId: event.operationId });
  assert.equal(history.persistence, "available");
  assert.deepEqual(history.items.map(x => x.fields.eventUid), [uid]);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE/);
  assert.equal((await query({ connectionId: "other" })).total, 0);
  assert.equal((await pool.query(`SELECT key_id FROM ${table}`)).rows[0].key_id, "");
  const rolls = `${quoteIdentifier(schema, "test schema")}."runtime_rollups"`;
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${rolls}`)).rows[0].n, 0);
  for (const options of [{}, { timeRange: "24h" }]) {
    const stats = await getRuntimeStatsSnapshot(db, {}, { readOnly: true, ...options });
    assert.equal(stats.totals.requests, 0);
    assert.equal(stats.totals.errors, 0);
    assert.equal(stats.totals.totalTokens, 0);
    assert.deepEqual(Object.keys(stats.perKey), []);
  }
  const since = new Date(Date.now() - 86400000).toISOString();
  const governance = await readGovernanceRuntimes(db, [{ keyId: "anonymous", rateWindowStartedAt: since, budgetWindowStartedAt: since }]);
  const anonymous = governance.get("anonymous");
  assert.equal(Number(anonymous.budget_requests), 0);
  assert.equal(Number(anonymous.rate_requests), 0);
  assert.equal(anonymous.last_seen_at, null);
  await pool.query(`UPDATE ${table} SET occurred_at = now() - interval '100 days'`);
  assert.equal((await query({})).total, 0, "expired detail must not be reconstructed from current config or rollups");
  const droppedBefore = getRuntimeStoreInfo(db).droppedEvents;
  for (let n = 0; n < 160; n++) recordChannelOperation(db, { event: "admin.copilot_disconnected", channelId: `storm-${n}` });
  recordRuntimeRequest(db, { keyId: "actual-consumer", modelId: "ordinary" });
  assert.equal(getRuntimeStoreInfo(db).queueLength, 100);
  assert.equal(getRuntimeStoreInfo(db).droppedEvents - droppedBefore, 61);
  await drainRuntimeEvents();
  const bounded = await query({ limit: 3 });
  assert.equal(bounded.items.length, 3);
  assert.equal(bounded.hasMore, true);
  const after = await getRuntimeStatsSnapshot(db, {}, { readOnly: true });
  assert.deepEqual(Object.keys(after.perKey), ["actual-consumer"]);
  assert.equal(after.totals.requests, 1);
});

test("offline spill retains the shared UID but never a provider response; GET cannot consume the spool", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-ops-spool-"));
  const localBufferPath = path.join(dir, "pending.ndjson");
  const env = ["RUNTIME_DB_CONNECTION_STRING", "CONFIG_DB_CONNECTION_STRING", "DATABASE_URL", "RUNTIME_DB_CONNECTION_REF",
    "RUNTIME_STORE_LOCAL_BUFFER_PATH", "PERSISTENCE_MODE", "CONFIG_PERSISTENCE_MODE"];
  const saved = new Map(env.map(k => [k, process.env[k]]));
  for (const k of env) delete process.env[k];
  const db = { persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { ...config.observability, runtimeStore: { localBufferPath, maxPersistedEvents: 100 } } };
  t.after(async () => {
    setRuntimeStoreConfig(null);
    for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  setRuntimeStoreConfig(db);
  setLogConfig(db);
  const start = recordChannelOperation(db, { event: "admin.copilot_auth_started", channelId: "offline",
    operationId: "one", user_code: "PRIVATE", deviceCode: "PRIVATE", credentialRef: "PRIVATE" });
  const drain = await drainRuntimeEvents();
  assert.equal(drain.pendingPersistedEvents, 1);
  const raw = await fs.readFile(localBufferPath, "utf8");
  const row = JSON.parse(raw);
  assert.equal(row.eventType, "operation");
  assert.equal(row.eventUid, start);
  assert.equal(row.payload.operationId, "one");
  assert.equal(row.keyId, "");
  assert.doesNotMatch(raw, /PRIVATE/);
  assert.equal((await queryChannelOperations(db, { recordSource: "database" })).persistence, "unavailable");
  assert.equal(await fs.readFile(localBufferPath, "utf8"), raw);
  assert.equal(getRuntimeStoreInfo(db).persistedEventCount, 1);
});
