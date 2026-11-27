import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { quoteIdentifier } from "./postgres.js";
import { fail, identifier, sanitize } from "./copilot-credential-record.js";

const table = "copilot_credentials_v1";

function privateFile(stat) {
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) fail("CREDENTIAL_PATH_UNSAFE");
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fileBackend({ directory }) {
  let db;
  try {
    if (typeof directory !== "string" || !directory.trim() || typeof process.getuid !== "function") fail("CREDENTIAL_PATH_UNSAFE");
    const root = path.resolve(directory);
    if (await fs.realpath(path.dirname(root)) !== path.dirname(root)) fail("CREDENTIAL_PATH_UNSAFE");
    try {
      await fs.mkdir(root, { mode: 0o700 });
      await syncDirectory(path.dirname(root));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const dir = await fs.lstat(root);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || dir.mode & 0o077) fail("CREDENTIAL_PATH_UNSAFE");
    const filename = path.join(root, "copilot-credentials.sqlite");
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { privateFile(await fs.lstat(filename + suffix)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const handle = await fs.open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try { privateFile(await handle.stat()); } finally { await handle.close(); }
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(filename, { timeout: 0, defensive: true, allowExtension: false });
    // Keep an OS lock for this handle's lifetime; the kernel releases it after a crash.
    db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;
      PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS ${table} (channel TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL);
      COMMIT;`);
    await syncDirectory(root);
    const read = db.prepare(`SELECT record FROM ${table} WHERE channel=?`);
    const write = db.prepare(`INSERT INTO ${table} (channel,record) VALUES (?,?) ON CONFLICT(channel) DO UPDATE SET record=excluded.record`);
    const get = channel => {
      const row = read.get(channel);
      return row ? JSON.parse(row.record) : null;
    };
    function changeMany(steps) {
      db.exec("BEGIN EXCLUSIVE");
      try {
        const results = steps.map(({ channel, mutate }) => {
          const { next, result, deadline } = mutate(get(channel), Date.now());
          if (deadline != null && deadline <= Date.now()) fail("CREDENTIAL_CONFLICT");
          if (next) write.run(channel, JSON.stringify(next));
          return result;
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    return {
      get, changeMany,
      change(channel, mutate) { return changeMany([{ channel, mutate }])[0]; },
      close() { db.close(); }
    };
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the original, sanitized startup error. */ }
    if (error?.errcode === 5 || error?.errcode === 6) fail("CREDENTIAL_WRITER_BUSY");
    sanitize(error);
  }
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL synchronous_commit=on");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function postgresBackend({ pool, schema = "public", namespace = "default" }) {
  if (!identifier(namespace) || typeof schema !== "string" || schema.length > 63) fail("CREDENTIAL_INPUT_INVALID");
  const relation = `${quoteIdentifier(schema, "schema")}.${table}`;
  const clock = "(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)";
  const select = `SELECT record FROM ${relation} WHERE namespace=$1 AND channel=$2`;
  await transaction(pool, async client => {
    // Concurrent first boots must not race PostgreSQL catalog creation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [relation]);
    const exists = (await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [relation])).rows[0].present;
    if (!exists) {
      await client.query(`CREATE TABLE ${relation} (
        namespace text NOT NULL, channel text NOT NULL, record jsonb, PRIMARY KEY(namespace,channel))`);
    }
  });
  async function changeOne(client, { channel, mutate }) {
    const key = [namespace, channel];
    await client.query(`INSERT INTO ${relation} (namespace,channel) VALUES ($1,$2) ON CONFLICT DO NOTHING`, key);
    const { rows } = await client.query(select + " FOR UPDATE", key);
    const now = Number((await client.query(`SELECT ${clock} AS now_ms`)).rows[0].now_ms);
    const { next, result, deadline } = mutate(rows[0].record, now);
    if (next) {
      const updated = await client.query(`UPDATE ${relation} SET record=$3::jsonb
        WHERE namespace=$1 AND channel=$2 AND ($4::bigint IS NULL OR $4::bigint > ${clock})`,
      [...key, JSON.stringify(next), deadline ?? null]);
      if (updated.rowCount !== 1) fail("CREDENTIAL_CONFLICT");
    }
    return result;
  }
  return {
    async get(channel) {
      const { rows } = await pool.query(`SELECT NOT pg_is_in_recovery() AS authoritative, (${select}) AS record`,
        [namespace, channel]);
      if (rows[0]?.authoritative !== true) fail("CREDENTIAL_STORE_UNAVAILABLE");
      return rows[0].record;
    },
    change(channel, mutate) {
      return transaction(pool, client => changeOne(client, { channel, mutate }));
    },
    changeMany(steps) {
      return transaction(pool, async client => {
        const results = [];
        for (const step of steps) results.push(await changeOne(client, step));
        return results;
      });
    },
    close() {}
  };
}
