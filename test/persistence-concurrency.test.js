import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { closeSharedPostgresPools, quoteIdentifier } from "../src/postgres.js";

test("database config CAS rejects stale instances and preserves conflicting offline edits", {
  skip: !process.env.RUNTIME_MEDIA_TEST_DATABASE_URL,
  timeout: 30000
}, async t => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(connectionString).hostname));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-cas-"));
  const schema = `config_cas_${process.pid}_${Date.now()}`;
  const previous = process.env.CONFIG_DB_CONNECTION_STRING;
  process.env.CONFIG_DB_CONNECTION_STRING = connectionString;
  const pool = new pg.Pool({ connectionString });
  const first = await import("../src/persistence.js?cas-instance=first");
  const second = await import("../src/persistence.js?cas-instance=second");
  const unknown = await import("../src/persistence.js?cas-instance=unknown");
  const resumed = await import("../src/persistence.js?cas-instance=resumed");
  const config = filePath => ({
    persistence: {
      configStore: { mode: "database", filePath, database: { schema } },
      compatibilityExport: { enabled: false }
    }
  });
  const firstConfig = config(path.join(dir, "first.json"));
  const secondConfig = config(path.join(dir, "second.json"));
  t.after(async () => {
    first.setPersistenceConfig(null);
    second.setPersistenceConfig(null);
    unknown.setPersistenceConfig(null);
    resumed.setPersistenceConfig(null);
    await closeSharedPostgresPools();
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema, "test schema")} CASCADE`);
    await pool.end();
    if (previous === undefined) delete process.env.CONFIG_DB_CONNECTION_STRING;
    else process.env.CONFIG_DB_CONNECTION_STRING = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });

  await fs.writeFile(firstConfig.persistence.configStore.filePath, JSON.stringify({ value: "bootstrap" }));
  first.setPersistenceConfig(firstConfig);
  second.setPersistenceConfig(secondConfig);
  await first.readPersistedConfigText();
  await first.writePersistedConfigText(JSON.stringify({ value: "initial" }), firstConfig);
  await second.readPersistedConfigText();
  const unavailableRead = t.mock.method(pg.Pool.prototype, "query", async () => { throw new Error("database unavailable"); });
  assert.deepEqual(JSON.parse(await second.readPersistedConfigText()), { value: "initial" });
  unavailableRead.mock.restore();
  await first.writePersistedConfigText(JSON.stringify({ value: "first" }), firstConfig);
  await second.syncPersistenceState(secondConfig);
  await assert.rejects(second.writePersistedConfigText(JSON.stringify({ value: "stale" }), secondConfig), {
    code: "CONFIG_REVISION_CONFLICT"
  });
  assert.deepEqual(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")), { value: "initial" });
  assert.deepEqual(JSON.parse(await second.readLatestPersistedConfigText()), { value: "first" });
  await assert.rejects(second.writePersistedConfigText(JSON.stringify({ value: "stale-after-preview" }), secondConfig), {
    code: "CONFIG_REVISION_CONFLICT"
  });
  await assert.rejects(second.readPersistedConfigText({
    validate() { throw new Error("Invalid remote configuration"); }
  }), /Invalid remote configuration/);
  assert.deepEqual(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")), { value: "initial" });
  await assert.rejects(second.writePersistedConfigText(JSON.stringify({ value: "stale-after-failed-reload" }), secondConfig), {
    code: "CONFIG_REVISION_CONFLICT"
  });

  await second.readPersistedConfigText();
  const query = pg.Pool.prototype.query;
  const mock = t.mock.method(pg.Pool.prototype, "query", async () => { throw new Error("database unavailable"); });
  await second.writePersistedConfigText(JSON.stringify({ value: "offline" }), secondConfig);
  mock.mock.restore();
  assert.equal(pg.Pool.prototype.query, query);
  assert.equal(second.getPersistenceSummary(secondConfig).pendingDatabaseSync, true);
  await first.writePersistedConfigText(JSON.stringify({ value: "remote" }), firstConfig);
  const summary = await second.syncPersistenceState(secondConfig);
  assert.equal(summary.pendingDatabaseSync, true);
  assert.equal(summary.lastDatabaseError.code, "CONFIG_REVISION_CONFLICT");
  assert.deepEqual(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")), { value: "offline" });
  const stored = await pool.query(`SELECT config_json FROM ${quoteIdentifier(schema, "test schema")}."proxy_configs" WHERE config_key = 'active'`);
  assert.deepEqual(stored.rows[0].config_json, { value: "remote" });
  assert.deepEqual(JSON.parse(await second.readLatestPersistedConfigText()), { value: "remote" });
  assert.deepEqual(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")), { value: "offline" });

  await second.discardPendingDatabaseSync();
  await second.readPersistedConfigText();
  assert.equal(second.getPersistenceSummary(secondConfig).pendingDatabaseSync, false);
  assert.deepEqual(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")), { value: "remote" });
  const unavailable = t.mock.method(pg.Pool.prototype, "query", async () => { throw new Error("database unavailable"); });
  await second.writePersistedConfigText(JSON.stringify({ value: "offline-safe" }), secondConfig);
  unavailable.mock.restore();
  const recovered = await second.syncPersistenceState(secondConfig);
  assert.equal(recovered.pendingDatabaseSync, false);
  const synchronized = await pool.query(`SELECT config_json FROM ${quoteIdentifier(schema, "test schema")}."proxy_configs" WHERE config_key = 'active'`);
  assert.deepEqual(synchronized.rows[0].config_json, { value: "offline-safe" });

  const lostAck = t.mock.method(pg.Pool.prototype, "query", async function (sql, ...args) {
    const result = await query.call(this, sql, ...args);
    if (String(sql).startsWith("UPDATE ") && String(sql).includes('"proxy_configs"')) {
      throw new Error("lost acknowledgement");
    }
    return result;
  });
  await second.writePersistedConfigText(JSON.stringify({ value: "committed" }), secondConfig);
  lostAck.mock.restore();
  assert.equal(second.getPersistenceSummary(secondConfig).pendingDatabaseSync, true);
  const acknowledged = await second.syncPersistenceState(secondConfig);
  assert.equal(acknowledged.pendingDatabaseSync, false);
  assert.deepEqual(JSON.parse(await second.readLatestPersistedConfigText()), { value: "committed" });

  const unknownConfig = config(path.join(dir, "unknown.json"));
  await fs.writeFile(unknownConfig.persistence.configStore.filePath, JSON.stringify({ value: "old-cache" }));
  unknown.setPersistenceConfig(unknownConfig);
  const offlineStartup = t.mock.method(pg.Pool.prototype, "query", async () => { throw new Error("offline startup"); });
  await unknown.readPersistedConfigText();
  offlineStartup.mock.restore();
  await unknown.syncPersistenceState(unknownConfig);
  await unknown.readLatestPersistedConfigText();
  await unknown.writePersistedConfigText(JSON.stringify({ value: "unknown-baseline-edit" }), unknownConfig);
  const unresolved = await unknown.syncPersistenceState(unknownConfig);
  assert.equal(unresolved.pendingDatabaseSync, true);
  assert.equal(unresolved.lastDatabaseError.code, "CONFIG_REVISION_UNKNOWN");
  assert.deepEqual(JSON.parse(await second.readLatestPersistedConfigText()), { value: "committed" });

  for (let index = 0; index < 14; index++) {
    await second.writePersistedConfigText(JSON.stringify({ value: `history-${index}`, auth: { apiKey: "history-database-secret" } }), secondConfig);
  }
  const history = await second.readConfigHistory();
  assert.equal(history.length, 12);
  assert.equal(history[0].config.value, "history-2");
  assert.doesNotMatch(JSON.stringify(history), /history-database-secret/);
  await assert.rejects(first.writePersistedConfigText(JSON.stringify({ value: "stale-history" }), firstConfig), { code: "CONFIG_REVISION_CONFLICT" });
  assert.deepEqual(await second.readConfigHistory(), history);

  const completedId = history.at(-1).id;
  const beforeHistoryUpdate = pg.Pool.prototype.query;
  let injectedApply = false;
  const concurrentApply = t.mock.method(pg.Pool.prototype, "query", async function (sql, ...args) {
    if (!injectedApply && sql.startsWith("UPDATE ") && sql.includes("SET config_json")) {
      injectedApply = true;
      await first.recordConfigHistoryApply(completedId, { proxy: { ok: true } });
    }
    return beforeHistoryUpdate.call(this, sql, ...args);
  });
  await second.writePersistedConfigText(JSON.stringify({ value: "history-with-concurrent-apply" }), secondConfig);
  concurrentApply.mock.restore();
  assert.deepEqual((await second.readConfigHistory()).find(entry => entry.id === completedId).apply, { proxy: { ok: true } });

  const offlineCache = t.mock.method(pg.Pool.prototype, "query", async () => { throw new Error("database unavailable"); });
  const rename = fs.rename;
  const cacheFailure = t.mock.method(fs, "rename", async (source, destination) => {
    if (destination === secondConfig.persistence.configStore.filePath) throw new Error("local cache unavailable");
    return rename(source, destination);
  });
  await second.writePersistedConfigText(JSON.stringify({ value: "pending-with-failed-cache" }), secondConfig);
  offlineCache.mock.restore();
  cacheFailure.mock.restore();
  assert.equal(second.getPersistenceSummary(secondConfig).lastCacheError.message, "local cache unavailable");
  assert.equal(JSON.parse(await fs.readFile(secondConfig.persistence.configStore.filePath, "utf8")).value, "history-with-concurrent-apply");
  resumed.setPersistenceConfig(secondConfig);
  assert.equal(JSON.parse(await resumed.readPersistedConfigText()).value, "pending-with-failed-cache");
  assert.equal((await resumed.syncPersistenceState(secondConfig)).pendingDatabaseSync, false);
  assert.equal(JSON.parse(await resumed.readLatestPersistedConfigText()).value, "pending-with-failed-cache");
});
