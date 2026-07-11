import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ENV_NAMES = [
  "CONFIG_PATH",
  "AOAI_PROXY_ADMIN_PASSWORD",
  "AOAI_PROXY_API_KEY",
  "AOAI_PROXY_CADDY_DOMAIN"
];

test("environment-managed config values remain memory-only across saves", async () => {
  const previousEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-env-"));
  const configPath = path.join(tempDir, "config.json");
  const samplePath = path.resolve("config/sample_config.json");
  const rawConfig = JSON.parse(await fs.readFile(samplePath, "utf8"));
  rawConfig.server.host = "127.0.0.1";
  rawConfig.persistence.configStore.filePath = configPath;
  rawConfig.persistence.compatibilityExport.legacyConfigPath = configPath;
  await fs.writeFile(configPath, JSON.stringify(rawConfig), "utf8");

  process.env.CONFIG_PATH = configPath;
  process.env.AOAI_PROXY_ADMIN_PASSWORD = "environment-admin-secret";
  process.env.AOAI_PROXY_API_KEY = "environment-proxy-secret";
  process.env.AOAI_PROXY_CADDY_DOMAIN = "environment.example.com";

  try {
    const { getConfig, loadConfig, saveConfig } = await import("../src/config.js");
    const effectiveConfig = await loadConfig();
    assert.equal(effectiveConfig.server.adminAuth.password, "environment-admin-secret");
    assert.equal(effectiveConfig.apiKeys[0].key, "environment-proxy-secret");
    assert.equal(effectiveConfig.server.caddy.domain, "environment.example.com");

    effectiveConfig.server.gracefulShutdownMs = 12345;
    await saveConfig(effectiveConfig);

    const persistedText = await fs.readFile(configPath, "utf8");
    const persistedConfig = JSON.parse(persistedText);
    assert.doesNotMatch(persistedText, /environment-admin-secret|environment-proxy-secret|environment\.example\.com/);
    assert.equal(persistedConfig.server.adminAuth.password, "admin");
    assert.equal(persistedConfig.apiKeys[0].key, "CHANGEME");
    assert.equal(persistedConfig.server.gracefulShutdownMs, 12345);
    assert.equal(getConfig().server.adminAuth.password, "environment-admin-secret");

    const withoutPersistedDefault = getConfig();
    withoutPersistedDefault.apiKeys = [{ id: "custom", key: "custom-secret", status: "active" }];
    await saveConfig(withoutPersistedDefault);
    const persistedWithoutDefault = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(persistedWithoutDefault.apiKeys.map((item) => item.id), ["custom"]);
    assert.equal(persistedWithoutDefault.apiKeys[0].key, "custom-secret");
    assert.deepEqual(getConfig().apiKeys.map((item) => item.id), ["custom", "default"]);
    assert.equal(getConfig().apiKeys.find((item) => item.id === "default").key, "environment-proxy-secret");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
