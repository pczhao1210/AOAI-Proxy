import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ENV_NAMES = ["CONFIG_PATH", "AOAI_PROXY_ADMIN_PASSWORD", "AOAI_PROXY_API_KEY"];

function captureEnvironment() {
  return Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(previousEnvironment) {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function readSampleConfig() {
  return JSON.parse(await fs.readFile(path.resolve("config/sample_config.json"), "utf8"));
}

test("reload upgrades a v2 config to validated v3 persistence without environment secrets", async () => {
  const previousEnvironment = captureEnvironment();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-v2-upgrade-"));
  const configPath = path.join(tempDir, "config.json");
  const config = await readSampleConfig();
  config.version = 2;
  config.server.host = "127.0.0.1";
  config.server.adminPath = "/legacy-admin";
  config.server.adminAuth = { enabled: true, username: "legacy-admin", password: "legacy-password" };
  config.server.imageCompression = { enabled: true, maxSize: 1200, quality: 0.7, format: "webp" };
  config.server.upstream = { requestTimeoutMs: 123456, maxResponseBytes: 12 * 1024 * 1024 };
  delete config.admin;
  delete config.media;
  delete config.proxy.timeouts;
  config.proxy.guards = { maxRequestBodyBytes: 0, maxResponseBodyBytes: 0 };
  config.models.push({
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    status: "active",
    upstream: "foundry",
    targetModel: "gpt-5.6-terra",
    capabilities: ["reasoning"],
    pricingRef: "gpt-5.6-terra",
    routes: { "*": "responses" }
  });
  config.persistence.configStore.filePath = configPath;
  config.persistence.compatibilityExport.enabled = false;
  config.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
  config.persistence.compatibilityExport.legacyConfigPath = configPath;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  process.env.CONFIG_PATH = configPath;
  process.env.AOAI_PROXY_ADMIN_PASSWORD = "environment-admin-secret";
  process.env.AOAI_PROXY_API_KEY = "environment-proxy-secret";

  try {
    const { getPersistedConfig, reloadConfig } = await import("../src/config.js");
    const effectiveConfig = await reloadConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    const migratedModel = persisted.models.find((model) => model.id === "gpt-5.6-terra");

    assert.equal(effectiveConfig.version, 3);
    assert.equal(persisted.version, 3);
    assert.equal(persisted.proxy.guards.maxRequestBodyBytes, 50 * 1024 * 1024);
    assert.equal(persisted.proxy.guards.maxResponseBodyBytes, 12 * 1024 * 1024);
    assert.equal(persisted.proxy.timeouts.requestMs, 123456);
    assert.equal(persisted.admin.basePath, "/legacy-admin");
    assert.equal(persisted.media.inputCompression.outputFormat, "webp");
    assert.deepEqual(migratedModel.routes, {});
    assert.equal(getPersistedConfig().version, 3);
    assert.doesNotMatch(JSON.stringify(persisted), /environment-admin-secret|environment-proxy-secret/);
    assert.equal(effectiveConfig.server.adminAuth.password, "environment-admin-secret");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
});

test("reload does not rewrite an existing v3 config", async () => {
  const previousEnvironment = captureEnvironment();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-v3-noop-"));
  const configPath = path.join(tempDir, "config.json");
  const config = await readSampleConfig();
  config.server.host = "127.0.0.1";
  config.persistence.configStore.filePath = configPath;
  config.persistence.compatibilityExport.enabled = false;
  config.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
  config.persistence.compatibilityExport.legacyConfigPath = configPath;
  const originalText = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, originalText, "utf8");

  process.env.CONFIG_PATH = configPath;
  delete process.env.AOAI_PROXY_ADMIN_PASSWORD;
  delete process.env.AOAI_PROXY_API_KEY;

  try {
    const { reloadConfig } = await import("../src/config.js");
    const effectiveConfig = await reloadConfig();
    assert.equal(effectiveConfig.version, 3);
    assert.equal(await fs.readFile(configPath, "utf8"), originalText);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
});

test("reload repairs legacy zero guards already stamped as v3", async () => {
  const previousEnvironment = captureEnvironment();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-v3-zero-guard-"));
  const configPath = path.join(tempDir, "config.json");
  const config = await readSampleConfig();
  config.server.host = "127.0.0.1";
  config.server.upstream = { maxResponseBytes: 12 * 1024 * 1024 };
  config.proxy.guards.maxRequestBodyBytes = 0;
  config.proxy.guards.maxResponseBodyBytes = 0;
  config.persistence.configStore.filePath = configPath;
  config.persistence.compatibilityExport.enabled = false;
  config.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
  config.persistence.compatibilityExport.legacyConfigPath = configPath;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  process.env.CONFIG_PATH = configPath;
  delete process.env.AOAI_PROXY_ADMIN_PASSWORD;
  delete process.env.AOAI_PROXY_API_KEY;

  try {
    const { reloadConfig } = await import("../src/config.js");
    const effectiveConfig = await reloadConfig();
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));

    assert.equal(effectiveConfig.version, 3);
    assert.equal(persisted.version, 3);
    assert.equal(persisted.proxy.guards.maxRequestBodyBytes, 50 * 1024 * 1024);
    assert.equal(persisted.proxy.guards.maxResponseBodyBytes, 12 * 1024 * 1024);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
});

test("reload preserves strict validation for other invalid v3 guards", async () => {
  const previousEnvironment = captureEnvironment();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-v3-strict-"));
  const configPath = path.join(tempDir, "config.json");
  const config = await readSampleConfig();
  config.server.host = "127.0.0.1";
  config.proxy.guards.maxResponseBodyBytes = -1;
  config.persistence.configStore.filePath = configPath;
  config.persistence.compatibilityExport.enabled = false;
  config.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
  config.persistence.compatibilityExport.legacyConfigPath = configPath;
  const originalText = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, originalText, "utf8");

  process.env.CONFIG_PATH = configPath;
  delete process.env.AOAI_PROXY_ADMIN_PASSWORD;
  delete process.env.AOAI_PROXY_API_KEY;

  try {
    const { reloadConfig } = await import("../src/config.js");
    await assert.rejects(reloadConfig(), /maxResponseBodyBytes must be a positive integer/);
    assert.equal(await fs.readFile(configPath, "utf8"), originalText);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    restoreEnvironment(previousEnvironment);
  }
});