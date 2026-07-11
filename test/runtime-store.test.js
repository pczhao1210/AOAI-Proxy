import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getRuntimeStoreInfo, recordRuntimeRequest, setRuntimeStoreConfig } from "../src/runtime-store.js";

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
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
    recordRuntimeRequest(config, { requestId: "spill-request", modelId: "model" });
    await waitFor(() => getRuntimeStoreInfo(config).persistedEventCount === 1);

    const info = getRuntimeStoreInfo(config);
    const persisted = await fs.readFile(localBufferPath, "utf8");
    assert.equal(info.configured, false);
    assert.equal(info.spilloverActive, true);
    assert.equal(info.persistedEventCount, 1);
    assert.match(persisted, /spill-request/);
  } finally {
    setRuntimeStoreConfig(null);
    await fs.rm(tempDir, { recursive: true, force: true });
    if (previousConnectionString === undefined) delete process.env.CONFIG_DB_CONNECTION_STRING;
    else process.env.CONFIG_DB_CONNECTION_STRING = previousConnectionString;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
