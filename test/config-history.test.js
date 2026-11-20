import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REDACTED_SECRET_VALUE, redactConfigSecrets, restoreHistorySecrets } from "../src/admin-config.js";
import { applyConfigurationStages } from "../src/config-application.js";

test("file history retains twelve redacted revisions and application outcomes", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-history-"));
  const store = await import(`../src/persistence.js?history=${path.basename(dir)}`);
  const config = { persistence: { configStore: { mode: "file", filePath: path.join(dir, "config.json") }, compatibilityExport: { enabled: false } } };
  store.setPersistenceConfig(config);
  t.after(async () => { store.setPersistenceConfig(null); await fs.rm(dir, { recursive: true, force: true }); });
  for (let index = 0; index < 15; index++) {
    await store.writePersistedConfigText(JSON.stringify({ index, auth: { apiKey: `private-${index}` } }), config, { actor: "test-admin" });
  }
  const history = await store.readConfigHistory();
  assert.deepEqual(history.map(entry => entry.config.index), Array.from({ length: 12 }, (_, i) => i + 3));
  assert.ok(history.every(entry => entry.actor === "test-admin" && entry.config.auth.apiKey === REDACTED_SECRET_VALUE));
  assert.doesNotMatch(await fs.readFile(`${config.persistence.configStore.filePath}.history.json`, "utf8"), /private-\d/);
  await store.recordConfigHistoryApply(history.at(-1).id, { caddy: { ok: false, error: "test reload failure" } });
  assert.equal((await store.readConfigHistory()).at(-1).apply.caddy.ok, false);
});

test("history rollback matches credentials by identity and never copies another entity's secret", () => {
  const old = redactConfigSecrets({
    auth: { apiKey: "old-global" },
    apiKeys: [{ id: "removed-key", key: "old-key" }],
    upstreams: [{ name: "removed-upstream", auth: { mode: "apiKey", apiKey: "old-upstream" }, headersTemplate: { "X-Api-Key": "old-header" } }]
  });
  const current = {
    auth: { apiKey: "new-global" },
    apiKeys: [{ id: "other-key", key: "new-key" }],
    upstreams: [{ name: "other-upstream", auth: { apiKey: "new-upstream" }, headersTemplate: { "x-api-key": "new-header" } }]
  };
  assert.throws(() => restoreHistorySecrets(old, current), { code: "CONFIG_HISTORY_SECRET_UNAVAILABLE" });
  current.apiKeys[0].id = "removed-key";
  current.upstreams[0].name = "removed-upstream";
  const restored = restoreHistorySecrets(old, current);
  assert.equal(restored.auth.apiKey, "new-global");
  assert.equal(restored.apiKeys[0].key, "new-key");
  assert.equal(restored.upstreams[0].auth.apiKey, "new-upstream");
  assert.deepEqual(restored.upstreams[0].headersTemplate, { "X-Api-Key": "new-header" });
  assert.doesNotMatch(JSON.stringify(restored), /old-global|old-key|old-upstream/);
});

test("application failures are per-stage and retry invokes only the selected stage", async () => {
  const calls = [];
  const handlers = {
    proxy() { calls.push("proxy"); throw new Error("proxy setup failed"); },
    caddy() { calls.push("caddy"); return { status: "applied" }; }
  };
  const result = await applyConfigurationStages({}, "revision", handlers);
  assert.equal(result.proxy.ok, false);
  assert.equal(result.caddy.ok, true);
  calls.length = 0;
  await applyConfigurationStages({}, "revision", handlers, ["caddy"]);
  assert.deepEqual(calls, ["caddy"]);
});
