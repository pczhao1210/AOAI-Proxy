import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getConfig, getConfigRuntimeInfo, getPersistedConfig, prepareConfigPreview, reloadConfig, saveConfig } from "../src/config.js";
import { isPublicRouteEnabled } from "../src/proxy/routing.js";
import { createTestContext } from "./lib/harness.js";

function get(object, field) {
  return field.split(".").reduce((value, key) => value?.[key], object);
}

function set(object, field, value) {
  const parts = field.split(".");
  let current = object;
  for (const part of parts.slice(0, -1)) current = current[part] ||= {};
  current[parts.at(-1)] = value;
}

test("all default boolean flags reject strings, numbers, null and arrays before normalization", () => {
  const fields = [];
  function collect(value, prefix = "") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (typeof item === "boolean") fields.push(field);
      else collect(item, field);
    }
  }
  collect(prepareConfigPreview({}));
  assert.ok(fields.includes("admin.security.csrfProtection"));
  assert.ok(fields.includes("routing.routeProfiles.responses.enabled"));
  for (const field of fields) {
    for (const value of ["false", 0, null, []]) {
      const raw = {};
      set(raw, field, value);
      assert.throws(() => prepareConfigPreview(raw), error => error.message === `${field} must be a boolean`, field);
    }
  }
  for (const field of [
    "server.trustProxy", "media.generation.enabled", "persistence.configStore.database.enabled",
    "persistence.compatibilityExport.exportLegacyConfigOnChange", "compatibility.anthropic.betaAllowlistEnabled"
  ]) {
    const raw = {};
    set(raw, field, "false");
    assert.throws(() => prepareConfigPreview(raw), /must be a boolean/, field);
  }
  for (const collection of ["models", "upstreams"]) {
    const raw = { [collection]: [{ requestPolicy: { dropUnsupportedParams: null } }] };
    assert.throws(() => prepareConfigPreview(raw), /must be a boolean/);
  }
  assert.throws(() => prepareConfigPreview({ models: [{ clientCompatibility: { codex: "false" } }] }), /must be a boolean/);
});

test("export and image gate migration preserves every legacy AND combination without mutating input", () => {
  for (const canonical of [false, true]) {
    for (const legacy of [false, true]) {
      const raw = {
        persistence: { compatibilityExport: { enabled: canonical, exportLegacyConfigOnChange: legacy, legacyConfigPath: "/tmp/unchanged" } },
        routing: { routeProfiles: { imageGenerations: { enabled: canonical } } },
        media: { generation: { enabled: legacy, maxImages: 0 } }
      };
      const before = structuredClone(raw);
      const result = prepareConfigPreview(raw);
      assert.equal(result.persistence.compatibilityExport.enabled, canonical && legacy);
      assert.equal(result.persistence.compatibilityExport.exportLegacyConfigOnChange, undefined);
      assert.equal(result.persistence.compatibilityExport.legacyConfigPath, "/tmp/unchanged");
      assert.equal(result.routing.routeProfiles.imageGenerations.enabled, canonical && legacy);
      assert.equal(result.media.generation.enabled, undefined);
      assert.equal(result.media.generation.maxImages, 0);
      assert.equal(isPublicRouteEnabled(result, "images/generations"), canonical && legacy);
      assert.deepEqual(raw, before);
      const repeated = prepareConfigPreview(result);
      assert.deepEqual(repeated.persistence, result.persistence);
      assert.deepEqual(repeated.routing, result.routing);
      assert.deepEqual(repeated.media.generation, result.media.generation);
      assert.deepEqual(repeated.compatibility, result.compatibility);
    }
  }
  assert.equal(prepareConfigPreview({ media: { generation: { enabled: false } } }).routing.routeProfiles.imageGenerations.enabled, false);
});

test("beta migration keeps filtering off and removes the checkbox alias while allowing canonical edits", () => {
  for (const policy of ["allow-direct-anthropic", "allowlist"]) {
    for (const enabled of [false, true]) {
      const raw = { compatibility: { anthropic: { unknownBetaPolicy: policy, betaAllowlistEnabled: enabled, betaAllowlist: [] } } };
      const result = prepareConfigPreview(raw);
      assert.equal(result.compatibility.anthropic.unknownBetaPolicy, enabled ? policy : "passthrough");
      assert.equal(result.compatibility.anthropic.betaAllowlistEnabled, undefined);
      assert.deepEqual(result.compatibility.anthropic.betaAllowlist, []);
      result.compatibility.anthropic.unknownBetaPolicy = "allowlist";
      assert.equal(prepareConfigPreview(result).compatibility.anthropic.unknownBetaPolicy, "allowlist");
    }
  }
  assert.equal(prepareConfigPreview({ compatibility: { anthropic: { unknownBetaPolicy: "passthrough" } } }).compatibility.anthropic.unknownBetaPolicy, "passthrough");
  assert.throws(() => prepareConfigPreview({ compatibility: { anthropic: { unknownBetaPolicy: "invalid" } } }), /unknownBetaPolicy/);
});

test("legacy database flag only fills an absent persistence mode and retired flags do not reappear", () => {
  assert.equal(prepareConfigPreview({ persistence: { configStore: { database: { enabled: true } } } }).persistence.configStore.mode, "database");
  const result = prepareConfigPreview({
    admin: { auth: { allowOidc: true }, security: { maskSecretsInUi: false }, features: { enableDangerousActions: true } },
    routing: { preCallChecks: { validateContextWindow: true }, healthChecks: { enabled: false } },
    observability: { metrics: { exposePrometheus: true }, audit: { enabled: false, retentionDays: 91 }, logs: { redactSecrets: false } },
    media: { inlineImages: { redactInLogs: false } },
    persistence: { configStore: { mode: "file", database: { enabled: true } } },
    upstreams: [{ healthCheck: { enabled: true } }],
    compatibility: { enableLegacyConfigRead: false, warnOnDeprecatedFields: true }
  });
  assert.equal(result.persistence.configStore.mode, "file");
  assert.equal(result.persistence.configStore.database.enabled, undefined);
  for (const field of [
    "admin.auth.allowOidc", "admin.security.maskSecretsInUi", "admin.features.enableDangerousActions",
    "admin.features.enableConfigImportExport", "routing.preCallChecks", "routing.healthChecks",
    "observability.metrics", "observability.logs.redactSecrets", "observability.audit.enabled",
    "media.inlineImages.redactInLogs", "compatibility.enableLegacyConfigRead", "compatibility.warnOnDeprecatedFields"
  ]) assert.equal(get(result, field), undefined, field);
  assert.equal(result.observability.audit.retentionDays, 91);
  assert.equal(result.upstreams[0].healthCheck, undefined);
  for (const feature of ["fallbacks", "cooldowns", "healthChecks"]) {
    assert.throws(() => prepareConfigPreview({ routing: { [feature]: { enabled: true } } }), /not supported/);
  }
});

test("reload reports deprecated fields without rewriting v3; save persists canonical flags and failed saves retain state", async () => {
  const previousPath = process.env.CONFIG_PATH;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-flag-migration-"));
  const configPath = path.join(tempDir, "config.json");
  const raw = JSON.parse(await fs.readFile("config/sample_config.json", "utf8"));
  raw.server.host = "127.0.0.1";
  raw.persistence.configStore.filePath = configPath;
  raw.persistence.compatibilityExport.enabled = false;
  raw.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
  raw.admin.features.enableDangerousActions = false;
  raw.compatibility.anthropic.betaAllowlistEnabled = false;
  const originalText = `${JSON.stringify(raw, null, 2)}\n`;
  await fs.writeFile(configPath, originalText);
  process.env.CONFIG_PATH = configPath;
  try {
    await reloadConfig();
    assert.equal(await fs.readFile(configPath, "utf8"), originalText);
    const warnings = getConfigRuntimeInfo().configuration.deprecatedFlags;
    assert.equal(getConfigRuntimeInfo().configuration.cleanupRequired, true);
    assert.ok(warnings.some(warning => warning.path === "admin.features.enableDangerousActions" && warning.kind === "ignored"));
    assert.ok(warnings.some(warning => warning.path === "compatibility.anthropic.betaAllowlistEnabled" && warning.replacement === "compatibility.anthropic.unknownBetaPolicy"));
    assert.equal(JSON.stringify(warnings).includes("password"), false);
    const current = getConfig();
    const invalid = structuredClone(getPersistedConfig());
    invalid.proxy.guards.dropUnsupportedOpenAiParams = "false";
    await assert.rejects(saveConfig(invalid), /must be a boolean/);
    assert.equal(getConfig(), current);
    assert.deepEqual(getConfigRuntimeInfo().configuration.deprecatedFlags, warnings);
    assert.equal(getConfigRuntimeInfo().configuration.cleanupRequired, true);
    const corrupt = structuredClone(raw);
    corrupt.routing.routeProfiles.responses.enabled = "false";
    await fs.writeFile(configPath, JSON.stringify(corrupt));
    await assert.rejects(reloadConfig(), /routing.routeProfiles.responses.enabled must be a boolean/);
    assert.equal(getConfig(), current);
    assert.deepEqual(getConfigRuntimeInfo().configuration.deprecatedFlags, warnings);
    assert.equal(getConfigRuntimeInfo().configuration.cleanupRequired, true);
    await fs.writeFile(configPath, originalText);
    await saveConfig(getPersistedConfig());
    const stored = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(stored.persistence.compatibilityExport.enabled, false);
    assert.equal(stored.persistence.compatibilityExport.exportLegacyConfigOnChange, undefined);
    assert.equal(stored.admin.features.enableDangerousActions, undefined);
    assert.equal(stored.compatibility.anthropic.unknownBetaPolicy, "passthrough");
    assert.equal(stored.compatibility.anthropic.betaAllowlistEnabled, undefined);
    assert.deepEqual(getConfigRuntimeInfo().configuration.deprecatedFlags, []);
    assert.equal(getConfigRuntimeInfo().configuration.cleanupRequired, false);
    await reloadConfig();
    assert.equal(getConfig().compatibility.anthropic.unknownBetaPolicy, "passthrough");
  } finally {
    if (previousPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("admin save rejects malformed flags, reports migrations and preserves canonical edits across reload", async () => {
  const context = await createTestContext({ tempPrefix: "aoai-flag-api-" });
  try {
    const baseline = (await context.adminRequest("/admin/api/config")).json;
    for (const field of [
      "admin.auth.enabled", "admin.security.csrfProtection", "admin.features.enableLegacyJsonEditor",
      "server.trustProxy", "proxy.guards.dropUnsupportedOpenAiParams",
      "proxy.forwardHeaders.addRequestIdHeader", "routing.routeProfiles.responses.enabled",
      "compatibility.anthropic.betaAllowlistEnabled", "compatibility.anthropic.validateThinkingByModel",
      "media.generation.enabled", "persistence.compatibilityExport.enabled", "access.budgets.enabled"
    ]) {
      const config = structuredClone(baseline);
      set(config, field, "false");
      const result = await context.adminRequest("/admin/api/config", {
        method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
      });
      assert.equal(result.status, 400, field);
      assert.equal(result.json.error, `${field} must be a boolean`);
    }
    const legacy = structuredClone(baseline);
    legacy.admin.features.enableDangerousActions = false;
    legacy.compatibility.anthropic.betaAllowlistEnabled = false;
    legacy.persistence.compatibilityExport.exportLegacyConfigOnChange = false;
    let saved = await context.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: legacy
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.config.compatibility.anthropic.unknownBetaPolicy, "passthrough");
    assert.equal(saved.json.config.persistence.compatibilityExport.enabled, false);
    assert.equal(saved.json.config.admin.features.enableDangerousActions, undefined);
    const runtime = await context.adminRequest("/admin/api/runtime");
    assert.equal(runtime.json.runtime.configuration.cleanupRequired, false);
    assert.ok(runtime.json.runtime.configuration.deprecatedFlags.some(warning => warning.path === "admin.features.enableDangerousActions"));
    const logs = await context.adminRequest("/admin/api/logs?event=config.deprecated_flags");
    assert.ok(logs.json.items.length);
    saved.json.config.compatibility.anthropic.unknownBetaPolicy = "allowlist";
    saved.json.config.persistence.compatibilityExport.enabled = true;
    saved = await context.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: saved.json.config
    });
    assert.equal(saved.status, 200, saved.text);
    const reloaded = await context.adminRequest("/admin/api/reload", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }
    });
    assert.equal(reloaded.status, 200, reloaded.text);
    assert.equal(reloaded.json.config.compatibility.anthropic.unknownBetaPolicy, "allowlist");
    assert.equal(reloaded.json.config.persistence.compatibilityExport.enabled, true);
    const stored = await context.readConfigFile();
    assert.equal(stored.compatibility.anthropic.betaAllowlistEnabled, undefined);
    assert.equal(stored.persistence.compatibilityExport.exportLegacyConfigOnChange, undefined);
    assert.equal((await context.adminRequest("/admin/api/runtime")).json.runtime.configuration.deprecatedFlags.length, 0);
  } finally {
    await context.cleanup();
  }
});
