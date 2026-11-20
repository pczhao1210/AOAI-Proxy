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
});
