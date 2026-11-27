import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import pg from "pg";
import { openFileCredentialStore, openPostgresCredentialStore } from "../src/copilot-credentials.js";
import { credentialAdapter } from "../src/copilot-storage.js";

const binding = { channelId: "test-channel", profile: "opencode", principalId: "test-subject" };
const configured = (credentialRef, b = binding) => ({ channelId: b.channelId, authProfile: b.profile, credentialRef });
const initial = { oauth: "synthetic-oauth-marker", refresh: "synthetic-refresh-marker" };
const inactive = { code: "CREDENTIAL_NOT_ACTIVE" };

async function fixture(t) {
  const directory = path.resolve(`.test-copilot-credentials-${randomUUID()}`);
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function open() {
    const store = await openFileCredentialStore({ directory });
    stores.push(store);
    return store;
  }
  return { directory, filename: path.join(directory, "copilot-credentials.sqlite"), open };
}

async function login(store, b = binding) {
  const { generation } = await store.status(b);
  const candidate = await store.prepare(b, initial, generation);
  await store.activate(b, candidate.credentialRef, generation);
  return candidate.credentialRef;
}

test("prepare is durable, not admission, and re-login publishes only the exact pending reference", async t => {
  const f = await fixture(t);
  const first = await f.open();
  const { credentialRef: oldRef } = await first.prepare(binding, initial, 0);
  assert.equal((await first.inspect(binding, oldRef)).state, "prepared");
  assert.equal(Object.hasOwn(await first.inspect(binding, oldRef), "secrets"), false);
  const management = await first.readForManagement(binding, oldRef);
  assert.deepEqual(management.secrets, initial);
  assert.equal(JSON.stringify(management).includes(initial.oauth), false);
  await assert.rejects(first.admit(binding, oldRef), inactive);
  await first.close();
  const db = new DatabaseSync(f.filename);
  const record = db.prepare("SELECT record FROM copilot_credentials_v1").get().record;
  db.close();
  for (const value of Object.values(initial)) assert.equal(record.includes(value), true);
  for (const name of await fs.readdir(f.directory)) {
    assert.equal((await fs.stat(path.join(f.directory, name))).mode & 0o077, 0);
  }
  const store = await f.open();
  assert.deepEqual(await store.resolveBinding(configured(oldRef)), binding);
  for (const mismatch of [{ principalId: "different" }, { profile: "vscode" }, { channelId: "different" }]) {
    const other = { ...binding, ...mismatch };
    await assert.rejects(store.readForManagement(other, oldRef));
    await assert.rejects(store.activate(other, oldRef, 0));
  }
  await assert.rejects(store.resolveBinding({ ...configured(oldRef), authProfile: "vscode" }));
  const active = await store.activate(binding, oldRef, 0);
  assert.deepEqual(await store.activate(binding, oldRef, 0), active);
  const { credentialRef: fresh } = await store.prepare(binding, { oauth: "synthetic-new" }, 1);
  const second = { ...binding, channelId: "z-second" };
  const secondCandidate = await store.prepare(second, initial, 0);
  await assert.rejects(store.activateMany([
    { binding, credentialRef: fresh, generation: 1 },
    { binding: second, ...secondCandidate, generation: 1 }
  ]), { code: "CREDENTIAL_CONFLICT" });
  assert.equal((await store.inspect(binding, fresh)).state, "prepared");
  assert.deepEqual((await store.admit(binding, oldRef)).secrets, initial);
  await assert.rejects(store.prepare(binding, { oauth: "unpublished" }, 1), { code: "CREDENTIAL_PREPARED_EXISTS" });
  await assert.rejects(store.admit(binding, fresh), inactive);
  assert.deepEqual((await store.admit(binding, oldRef)).secrets, initial);
  assert.equal((await store.readForManagement(binding, fresh)).state, "prepared");
  await assert.rejects(store.activate(binding, fresh, 0), { code: "CREDENTIAL_CONFLICT" });
  assert.equal((await store.activate(binding, fresh, 1)).generation, 2);
  await assert.rejects(store.admit(binding, oldRef), inactive);
  await assert.rejects(store.resolveBinding(configured(oldRef)), inactive);
  const unused = await store.prepare(binding, initial, 2);
  await assert.rejects(store.discardPrepared(binding, fresh, 2), { code: "CREDENTIAL_CONFLICT" });
  await store.discardPrepared(binding, unused.credentialRef, 2);
  await assert.rejects(store.readForManagement(binding, unused.credentialRef));
  assert.equal((await store.admit(binding, fresh)).secrets.oauth, "synthetic-new");
});

test("committed credentials survive unclean process exit without a stale writer lock", async t => {
  const f = await fixture(t);
  const first = await f.open(), { credentialRef } = await first.prepare(binding, initial, 0);
  await first.close();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { openFileCredentialStore } from './src/copilot-credentials.js';
    const store = await openFileCredentialStore({ directory: process.env.DIRECTORY });
    await store.activate(${JSON.stringify(binding)}, process.env.TEST_REF, 0);
    process.exit(0);
  `], { timeout: 10_000, env: { DIRECTORY: f.directory, TEST_REF: credentialRef } });
  assert.equal(child.status, 0);
  const store = await f.open();
  const admitted = await store.admit(binding, credentialRef);
  assert.deepEqual(admitted.secrets, initial);
  assert.equal(JSON.stringify(admitted).includes(initial.refresh), false);
});

test("legacy ciphertext is retained and refused until a new login candidate is published", async t => {
  const f = await fixture(t);
  const store = await f.open();
  const ref = await login(store);
  await store.close();
  const db = new DatabaseSync(f.filename);
  const row = JSON.parse(db.prepare("SELECT record FROM copilot_credentials_v1").get().record);
  row.active = { ref, envelope: { version: "old-key", nonce: "synthetic-nonce",
    tag: "synthetic-tag", ciphertext: "synthetic-legacy-ciphertext" } };
  const original = JSON.stringify(row);
  db.prepare("UPDATE copilot_credentials_v1 SET record=?").run(original);
  db.close();
  const reopened = await f.open();
  const legacy = { code: "CREDENTIAL_LEGACY_ENCRYPTION_UNSUPPORTED" };
  await assert.rejects(reopened.admit(binding, ref), legacy);
  await assert.rejects(reopened.resolveBinding(configured(ref)), legacy);
  await assert.rejects(reopened.refresh(binding, ref, () => assert.fail()), legacy);
  assert.deepEqual(await reopened.resolveIdentity(configured(ref)), binding);
  await assert.rejects(reopened.resolveIdentity({ ...configured(ref), authProfile: "vscode" }),
    { code: "CREDENTIAL_BINDING_MISMATCH" });
  const adapter = credentialAdapter(reopened);
  const scoped = { channelId: binding.channelId, profile: binding.profile, credentialRef: ref };
  assert.equal((await adapter.identity(scoped)).subject, binding.principalId);
  await assert.rejects(adapter.read(scoped), { code: "COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED" });
  await reopened.close();
  const unchanged = new DatabaseSync(f.filename);
  assert.equal(unchanged.prepare("SELECT record FROM copilot_credentials_v1").get().record, original);
  unchanged.close();
  const replacement = await f.open();
  const candidate = await replacement.prepare(binding, { oauth: "replacement" }, row.generation);
  await replacement.close();
  const pending = new DatabaseSync(f.filename);
  assert.deepEqual(JSON.parse(pending.prepare("SELECT record FROM copilot_credentials_v1").get().record).active, row.active);
  pending.close();
  const published = await f.open();
  await published.activate(binding, candidate.credentialRef, candidate.generation);
  await assert.rejects(published.admit(binding, ref), inactive);
  assert.deepEqual((await published.admit(binding, candidate.credentialRef)).secrets, { oauth: "replacement" });
});

test("legacy pending ciphertext requires explicit discard and never blocks local revocation", async t => {
  const f = await fixture(t), store = await f.open();
  const candidate = await store.prepare(binding, initial, 0);
  await store.close();
  const db = new DatabaseSync(f.filename);
  const row = JSON.parse(db.prepare("SELECT record FROM copilot_credentials_v1").get().record);
  row.prepared = { ref: candidate.credentialRef, envelope: { version: "old-key", ciphertext: "legacy" } };
  db.prepare("UPDATE copilot_credentials_v1 SET record=?").run(JSON.stringify(row));
  db.close();
  const reopened = await f.open();
  await assert.rejects(reopened.prepare(binding, initial, 0), { code: "CREDENTIAL_PREPARED_EXISTS" });
  const adapter = credentialAdapter(reopened);
  await adapter.disconnect({ ...binding, credentialRef: candidate.credentialRef });
  assert.equal((await reopened.status(binding)).preparedRef, null);
  await login(reopened);
});

test("sidecar still rejects unsafe permissions and concurrent writers without encryption", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o700 });
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(f.open(), { code: "CREDENTIAL_PATH_UNSAFE" });
  await fs.chmod(f.directory, 0o700);
  const store = await f.open();
  await login(store);
  await assert.rejects(f.open(), { code: "CREDENTIAL_WRITER_BUSY" });
});

test("disconnect cannot revoke a replacement published after resolving the old identity", async t => {
  const f = await fixture(t), store = await f.open(), oldRef = await login(store);
  let newRef;
  const adapter = credentialAdapter({ ...store, status: async b => {
    newRef = await login(store, b);
    return store.status(b);
  } });
  await assert.rejects(adapter.disconnect({ ...binding, credentialRef: oldRef }), { code: "COPILOT_AUTH_REQUIRED" });
  assert.deepEqual((await store.admit(binding, newRef)).secrets, initial);
});

test("plaintext storage rejects malformed payloads and unknown formats without replacing credentials", async t => {
  const f = await fixture(t), store = await f.open(), ref = await login(store);
  const cycle = { oauth: "synthetic" };
  cycle.self = cycle;
  for (const payload of [cycle, { oauth: "x".repeat(32769) }]) {
    await assert.rejects(store.prepare(binding, payload, 1), { code: "CREDENTIAL_PAYLOAD_INVALID" });
    assert.equal((await store.status(binding)).preparedRef, null);
    assert.deepEqual((await store.admit(binding, ref)).secrets, initial);
  }
  await store.close();
  const db = new DatabaseSync(f.filename);
  const row = JSON.parse(db.prepare("SELECT record FROM copilot_credentials_v1").get().record);
  row.active.format = "unknown-future-format";
  db.prepare("UPDATE copilot_credentials_v1 SET record=?").run(JSON.stringify(row));
  db.close();
  const reopened = await f.open();
  await assert.rejects(reopened.admit(binding, ref), { code: "CREDENTIAL_STORE_UNAVAILABLE" });
});

test("thirty requests share one refresh; late failures, rotations and revocations cannot un-fence a channel", async t => {
  const f = await fixture(t), store = await f.open(), ref = await login(store);
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let calls = 0;
  async function renew(secrets) {
    calls++;
    assert.deepEqual(secrets, initial);
    started.resolve();
    return gate.promise;
  }
  const requests = Array.from({ length: 31 }, () => store.refresh(binding, ref, renew));
  await started.promise;
  gate.resolve({ oauth: "new-test-token" });
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.ok(results.every(m => m.credentialVersion === 2 && !Object.hasOwn(m, "secrets")));
  await assert.rejects(store.revoke(binding, 1, 1), { code: "CREDENTIAL_CONFLICT" });
  await assert.rejects(store.refresh(binding, ref, () => { throw new Error(initial.oauth); }), error => {
    assert.equal(error.code, "CREDENTIAL_REFRESH_FAILED");
    assert.equal(JSON.stringify(error).includes(initial.oauth), false);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return !error.stack.includes(initial.oauth);
  });
  const delayed = Promise.withResolvers(), late = Promise.withResolvers();
  const refreshing = store.refresh(binding, ref, () => { late.resolve(); return delayed.promise; });
  await late.promise;
  const tombstone = await store.revoke(binding, 1, 2);
  assert.equal(tombstone.state, "revoked");
  delayed.resolve(initial);
  await assert.rejects(refreshing, inactive);
  await assert.rejects(store.admit(binding, ref), inactive);
  await assert.rejects(store.prepare(binding, initial, 1), { code: "CREDENTIAL_CONFLICT" });
  await store.close();
  const recovered = await f.open();
  assert.deepEqual(await recovered.status(binding), tombstone);
  await assert.rejects(recovered.readForManagement(binding, ref), inactive);
});

test("one-use rotation failure leaves a durable barrier; successful re-login is required", async t => {
  const f = await fixture(t), store = await f.open(), ref = await login(store);
  await assert.rejects(store.refresh(binding, ref, () => new Promise(() => {}), { rotating: true, leaseMs: 20 }),
    { code: "CREDENTIAL_REFRESH_TIMEOUT" });
  await store.close();
  const restarted = await f.open();
  assert.equal((await restarted.status(binding)).rotationPending, true);
  await assert.rejects(restarted.admit(binding, ref), { code: "CREDENTIAL_ROTATION_PENDING" });
  await assert.rejects(restarted.refresh(binding, ref, () => assert.fail()), { code: "CREDENTIAL_ROTATION_PENDING" });
  const newRef = await login(restarted);
  assert.notEqual(newRef, ref);
  assert.deepEqual((await restarted.admit(binding, newRef)).secrets, initial);
});

test("close cancels blocked renewals and prevents delayed callback results from being persisted", async t => {
  const f = await fixture(t), store = await f.open(), ref = await login(store);
  const started = Promise.withResolvers(), delayed = Promise.withResolvers();
  const refreshing = store.refresh(binding, ref, (_, { signal }) => {
    started.resolve(signal);
    return delayed.promise;
  });
  const signal = await started.promise;
  const checked = assert.rejects(refreshing, { code: "CREDENTIAL_STORE_CLOSED" });
  await store.close();
  await checked;
  assert.equal(signal.aborted, true);
  delayed.resolve({ oauth: "late" });
  const restarted = await f.open();
  assert.deepEqual((await restarted.admit(binding, ref)).secrets, initial);
  assert.equal((await restarted.refresh(binding, ref, () => initial)).credentialVersion, 2);
});

test("PostgreSQL: independent instances fence expired workers, observe revocation, and deny admission offline", {
  skip: !process.env.RUNTIME_MEDIA_TEST_DATABASE_URL, timeout: 30_000
}, async t => {
  const connectionString = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(connectionString).hostname));
  const pool = new pg.Pool({ connectionString }), pool2 = new pg.Pool({ connectionString });
  const schema = `credential_test_${randomBytes(8).toString("hex")}`, stores = [];
  await pool.query(`CREATE SCHEMA "${schema}"`);
  t.after(async () => {
    for (const store of stores) await store.close();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await Promise.all([pool.end(), pool2.end()]);
  });
  const [a, b] = await Promise.all([pool, pool2].map(pool => openPostgresCredentialStore({ pool, schema })));
  stores.push(a, b);
  const candidates = await Promise.allSettled([a, b].map(s => s.prepare(binding, initial, 0)));
  assert.deepEqual(candidates.map(c => c.status).sort(), ["fulfilled", "rejected"]);
  const ref = candidates.find(c => c.status === "fulfilled").value.credentialRef;
  await assert.rejects(a.activateMany([{ binding, credentialRef: ref, generation: 0 },
    { binding: { ...binding, channelId: "z-missing" }, credentialRef: ref, generation: 0 }]), inactive);
  assert.equal((await b.inspect(binding, ref)).state, "prepared");
  await a.activate(binding, ref, 0);
  assert.deepEqual((await b.admit(binding, ref)).secrets, initial);
  const renewing = Promise.withResolvers(), proceed = Promise.withResolvers();
  const late = a.refresh(binding, ref, () => { renewing.resolve(); return proceed.promise; });
  await renewing.promise;
  await assert.rejects(b.refresh(binding, ref, () => assert.fail()), { code: "CREDENTIAL_LEASE_BUSY" });
  // Advance only this test lease to avoid sleeping or relying on synchronized process clocks.
  await pool.query(`UPDATE "${schema}".copilot_credentials_v1 SET record=jsonb_set(record,'{lease,until}','0')`);
  const replacement = Promise.withResolvers(), complete = Promise.withResolvers();
  const second = b.refresh(binding, ref, () => { replacement.resolve(); return complete.promise; });
  await replacement.promise;
  proceed.resolve({ oauth: "expired-holder" });
  await assert.rejects(late, { code: "CREDENTIAL_CONFLICT" });
  await assert.rejects(a.refresh(binding, ref, () => assert.fail()), { code: "CREDENTIAL_LEASE_BUSY" });
  complete.resolve({ oauth: "winner" });
  await second;
  assert.equal((await a.admit(binding, ref)).secrets.oauth, "winner");
  const denied = t.mock.method(pool, "query", async () => { throw new Error(initial.refresh); });
  await assert.rejects(a.admit(binding, ref), { code: "CREDENTIAL_STORE_UNAVAILABLE", message: "CREDENTIAL_STORE_UNAVAILABLE" });
  denied.mock.restore();
  await b.revoke(binding, 1, 2);
  await assert.rejects(a.admit(binding, ref), inactive);
  await assert.rejects(a.activate(binding, ref, 0), inactive);
  const newRef = await login(a);
  const safe = await a.admit(binding, newRef);
  const cycle = { oauth: initial.oauth };
  cycle.self = cycle;
  await assert.rejects(a.prepare(binding, cycle, safe.generation), { code: "CREDENTIAL_PAYLOAD_INVALID" });
  assert.equal((await b.status(binding)).preparedRef, null);
  const rotate = Promise.withResolvers(), resume = Promise.withResolvers();
  const failed = a.refresh(binding, newRef, () => { rotate.resolve(); return resume.promise; }, { rotating: true });
  await rotate.promise;
  const unavailable = t.mock.method(pool, "connect", async () => { throw new Error(initial.oauth); });
  resume.resolve({ oauth: "remote-rotated-once" });
  await assert.rejects(failed, { code: "CREDENTIAL_STORE_UNAVAILABLE", message: "CREDENTIAL_STORE_UNAVAILABLE" });
  unavailable.mock.restore();
  await assert.rejects(b.admit(binding, newRef), { code: "CREDENTIAL_ROTATION_PENDING" });
  const record = (await pool.query(`SELECT record::text AS data FROM "${schema}".copilot_credentials_v1`)).rows[0].data;
  for (const value of Object.values(initial)) assert.equal(record.includes(value), true);
  assert.equal(record.includes("remote-rotated-once"), false);
});
