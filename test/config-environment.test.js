import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withModelCatalogUpdateLock } from "../src/model-catalog.js";

const ENV_NAMES = [
  "CONFIG_PATH",
  "AOAI_PROXY_PROFILE",
  "AOAI_PROXY_ADMIN_PASSWORD",
  "AOAI_PROXY_API_KEY",
  "AOAI_PROXY_CADDY_DOMAIN"
];

test("a failed proxy stage preserves active binding and catalog; retry installs the saved revision without a second write", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-binding-apply-"));
  const file = path.join(dir, "config.json");
  const previous = process.env.CONFIG_PATH;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const raw = JSON.parse(await fs.readFile("config/sample_config.json", "utf8"));
  raw.server.host = "127.0.0.1";
  raw.persistence.configStore.filePath = file;
  raw.persistence.compatibilityExport.enabled = false;
  raw.observability.runtimeStore.enabled = false;
  raw.upstreams = [{ name: "test", baseUrl: "http://127.0.0.1:1", channelId: "test",
    modelMappings: ["blue", "green"].map(sourceModelId => ({ sourceModelId, canonicalModelId: "gpt-5-mini", enabled: true })) }];
  raw.models = [{ id: "team", canonicalModelId: "gpt-5-mini", selectedBinding: { channelId: "test", sourceModelId: "blue" } }];
  await fs.writeFile(file, JSON.stringify(raw));
  process.env.CONFIG_PATH = file;
  const { getConfig, getEditableConfig, getPersistedConfigRevision, getConfigRuntimeInfo, reloadConfig, saveConfig, applyPreparedProxyConfig } = await import("../src/config.js");
  const { resolveModelDescriptor } = await import("../src/model-catalog.js");
  const original = await reloadConfig();
  const oldRevision = getPersistedConfigRevision();
  raw.models[0].selectedBinding.sourceModelId = "green";
  await saveConfig(raw, { deferApplication: true });
  const newRevision = getPersistedConfigRevision();
  const savedText = await fs.readFile(file, "utf8");
  assert.notEqual(newRevision, oldRevision);
  assert.equal(getEditableConfig().models[0].selectedBinding.sourceModelId, "green");
  const attempts = [];
  await assert.rejects(applyPreparedProxyConfig(candidate => {
    attempts.push(candidate.models[0].targetModel);
    if (candidate !== original) throw new Error("stage unavailable");
  }), /stage unavailable/);
  assert.deepEqual(attempts, ["green", "blue"]);
  assert.equal(getConfig(), original);
  assert.equal(resolveModelDescriptor("team").targetModel, "blue");
  assert.equal(getConfigRuntimeInfo().configuration.appliedRevision, oldRevision);
  await applyPreparedProxyConfig(() => {});
  assert.equal(getConfig().models[0].targetModel, "green");
  assert.equal(resolveModelDescriptor("team").targetModel, "green");
  assert.equal(original.models[0].targetModel, "blue");
  assert.equal(getConfigRuntimeInfo().configuration.appliedRevision, newRevision);
  assert.equal(await fs.readFile(file, "utf8"), savedText);
});

test("environment-managed config values remain memory-only across saves", async () => {
  const previousEnvironment = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-config-env-"));
  const configPath = path.join(tempDir, "config.json");
  const samplePath = path.resolve("config/sample_config.json");
  const rawConfig = JSON.parse(await fs.readFile(samplePath, "utf8"));
  delete rawConfig.compatibility.protocolShim;
  rawConfig.observability.logAnalytics.enabled = true;
  rawConfig.observability.runtimeStore.enabled = true;
  rawConfig.access.budgets.enabled = true;
  rawConfig.server.host = "127.0.0.1";
  rawConfig.persistence.configStore.filePath = configPath;
  rawConfig.persistence.compatibilityExport.legacyConfigPath = configPath;
  await fs.writeFile(configPath, JSON.stringify(rawConfig), "utf8");

  process.env.CONFIG_PATH = configPath;
  process.env.AOAI_PROXY_PROFILE = "minimum";
  process.env.AOAI_PROXY_ADMIN_PASSWORD = "environment-admin-secret";
  process.env.AOAI_PROXY_API_KEY = "environment-proxy-secret";
  process.env.AOAI_PROXY_CADDY_DOMAIN = "environment.example.com";

  try {
    const { getConfig, getConfigRuntimeInfo, reloadConfig, saveConfig } = await import("../src/config.js");
    const effectiveConfig = await reloadConfig();
    assert.equal(effectiveConfig.distribution.profile, "minimum");
    assert.equal(effectiveConfig.observability.logAnalytics.enabled, false);
    assert.equal(effectiveConfig.observability.runtimeStore.enabled, false);
    assert.equal(effectiveConfig.access.budgets.enabled, false);
    assert.equal(effectiveConfig.routing.routeProfiles.chatCompletions.enabled, true);
    assert.equal(effectiveConfig.routing.routeProfiles.responses.enabled, true);
    assert.equal(effectiveConfig.routing.routeProfiles.messages.enabled, true);
    assert.deepEqual(getConfigRuntimeInfo().distribution, {
      profile: "minimum",
      capabilities: {
        databaseAdmin: false,
        logAnalytics: false,
        modelCatalog: true,
        modelCatalogSync: true,
        runtimeStore: false,
        budgets: false
      }
    });
    assert.equal(getConfigRuntimeInfo().modelCatalog.ready, true);
    assert.ok(getConfigRuntimeInfo().modelCatalog.generation > 0);
    assert.ok(getConfigRuntimeInfo().modelCatalog.definitionCount > 0);
    assert.equal(getConfigRuntimeInfo().modelCatalog.modelCount, effectiveConfig.models.length);
    assert.match(getConfigRuntimeInfo().modelCatalog.sourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(effectiveConfig.server.adminAuth.password, "environment-admin-secret");
    assert.equal(effectiveConfig.apiKeys[0].key, "environment-proxy-secret");
    assert.equal(effectiveConfig.server.caddy.domain, "environment.example.com");
    assert.equal(effectiveConfig.observability.logAnalytics.tableName, "AOAIProxyLogs_CL");
    assert.equal(effectiveConfig.observability.logAnalytics.streamName, "Custom-AOAIProxyLogs");
    assert.equal(effectiveConfig.observability.logAnalytics.dataCollectionRuleName, "aoai-proxy-logs");
    assert.equal(effectiveConfig.compatibility.protocolShim.rejectLossyRequests, false);
    assert.equal(effectiveConfig.compatibility.protocolShim.rejectLossyResponses, false);

    let releaseCatalogUpdate;
    let markCatalogUpdateStarted;
    const catalogUpdateStarted = new Promise((resolve) => {
      markCatalogUpdateStarted = resolve;
    });
    const catalogUpdateRelease = new Promise((resolve) => {
      releaseCatalogUpdate = resolve;
    });
    const heldCatalogUpdate = withModelCatalogUpdateLock(async () => {
      markCatalogUpdateStarted();
      await catalogUpdateRelease;
    });
    await catalogUpdateStarted;

    const invalidConfig = JSON.parse(JSON.stringify(effectiveConfig));
    invalidConfig.server.gracefulShutdownMs = 0;
    let invalidSaveRejected = false;
    const invalidSave = saveConfig(invalidConfig).catch((error) => {
      invalidSaveRejected = true;
      throw error;
    });
    await Promise.resolve();
    assert.equal(invalidSaveRejected, false, "Config validation must wait for the Catalog update lock");
    releaseCatalogUpdate();
    await heldCatalogUpdate;
    await assert.rejects(invalidSave, /gracefulShutdownMs must be a positive integer/);

    const invalidRequestLimit = JSON.parse(JSON.stringify(effectiveConfig));
    invalidRequestLimit.proxy.guards.maxRequestBodyBytes = 0;
    await assert.rejects(
      saveConfig(invalidRequestLimit),
      /maxRequestBodyBytes must be a positive integer/
    );

    effectiveConfig.server.gracefulShutdownMs = 12345;
    await saveConfig(effectiveConfig);

    const persistedText = await fs.readFile(configPath, "utf8");
    const persistedConfig = JSON.parse(persistedText);
    assert.doesNotMatch(persistedText, /environment-admin-secret|environment-proxy-secret|environment\.example\.com/);
    assert.equal(persistedConfig.server.adminAuth.password, "admin");
    assert.equal(persistedConfig.apiKeys[0].key, "CHANGEME");
    assert.equal(persistedConfig.server.gracefulShutdownMs, 12345);
    assert.equal(persistedConfig.distribution.profile, "nextgen");
    assert.equal(persistedConfig.observability.logAnalytics.enabled, true);
    assert.equal(persistedConfig.observability.runtimeStore.enabled, true);
    assert.equal(persistedConfig.access.budgets.enabled, true);
    assert.equal(getConfig().server.adminAuth.password, "environment-admin-secret");

    const withoutPersistedDefault = getConfig();
    withoutPersistedDefault.apiKeys = [{ id: "custom", key: "custom-secret", status: "active" }];
    await saveConfig(withoutPersistedDefault);
    const persistedWithoutDefault = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(persistedWithoutDefault.apiKeys.map((item) => item.id), ["custom"]);
    assert.equal(persistedWithoutDefault.apiKeys[0].key, "custom-secret");
    assert.deepEqual(getConfig().apiKeys.map((item) => item.id), ["custom", "default"]);
    assert.equal(getConfig().apiKeys.find((item) => item.id === "default").key, "environment-proxy-secret");

    delete process.env.AOAI_PROXY_PROFILE;
    const nextgenConfig = getConfig();
    nextgenConfig.distribution.profile = "nextgen";
    await saveConfig(nextgenConfig);
    assert.equal(getConfig().distribution.profile, "nextgen");
    assert.equal(getConfig().observability.logAnalytics.enabled, true);
    assert.equal(getConfig().observability.runtimeStore.enabled, true);
    assert.equal(getConfig().access.budgets.enabled, true);

    process.env.AOAI_PROXY_PROFILE = "unsupported";
    await assert.rejects(reloadConfig(), /distribution\.profile must be minimum or nextgen/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
