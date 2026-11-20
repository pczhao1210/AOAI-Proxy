import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { REDACTED_SECRET_VALUE } from "../src/admin-config.js";
import { createTestContext } from "./lib/harness.js";

test("configuration ETags reject stale drafts without exposing configuration secrets", async () => {
  const context = await createTestContext();
  try {
    const loaded = await context.adminRequest("/admin/api/config");
    const originalEtag = loaded.headers.get("etag");
    assert.match(originalEtag || "", /^"[a-f0-9]{64}"$/);
    assert.doesNotMatch(originalEtag || "", /test-upstream-key|test-client-key|admin/);

    const firstDraft = structuredClone(loaded.json);
    firstDraft.server.gracefulShutdownMs += 1000;
    const firstSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1", "if-match": originalEtag },
      json: firstDraft
    });
    assert.equal(firstSave.status, 200, firstSave.text);
    const updatedEtag = firstSave.headers.get("etag");
    assert.notEqual(updatedEtag, originalEtag);

    const staleDraft = structuredClone(loaded.json);
    staleDraft.server.gracefulShutdownMs += 2000;
    const staleSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1", "if-match": originalEtag },
      json: staleDraft
    });
    assert.equal(staleSave.status, 409, staleSave.text);
    assert.equal(staleSave.json?.code, "CONFIG_REVISION_CONFLICT");
    assert.equal((await context.readConfigFile()).server.gracefulShutdownMs, firstDraft.server.gracefulShutdownMs);
    const latest = await context.adminRequest("/admin/api/config/latest");
    assert.equal(latest.status, 200, latest.text);
    assert.equal(latest.json.server.gracefulShutdownMs, firstDraft.server.gracefulShutdownMs);
    assert.doesNotMatch(latest.text, /test-upstream-key|test-client-key|"password":"admin"/);
    assert.equal((await context.adminRequest("/admin/api/config")).headers.get("etag"), updatedEtag);
  } finally {
    await context.cleanup();
  }
});

test("strict configuration revisions reject missing or malformed If-Match", async () => {
  const context = await createTestContext();
  try {
    const loaded = await context.adminRequest("/admin/api/config");
    loaded.json.server.requireConfigRevision = true;
    const saved = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1", "if-match": loaded.headers.get("etag") },
      json: loaded.json
    });
    assert.equal(saved.status, 200, saved.text);
    for (const [header, status, code] of [
      [undefined, 428, "CONFIG_REVISION_REQUIRED"],
      ["*", 400, "CONFIG_REVISION_INVALID"]
    ]) {
      const response = await context.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1", ...(header ? { "if-match": header } : {}) },
        json: saved.json.config
      });
      assert.equal(response.status, status, response.text);
      assert.equal(response.json.code, code);
    }
    const valid = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1", "if-match": saved.headers.get("etag") },
      json: saved.json.config
    });
    assert.equal(valid.status, 200, valid.text);
  } finally {
    await context.cleanup();
  }
});

test("Caddy apply failure does not report a persisted config save as failed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-caddy-save-test-"));
  const previousCaddyfilePath = process.env.CADDYFILE_PATH;
  const previousCaddyBin = process.env.CADDY_BIN;
  process.env.CADDYFILE_PATH = path.join(tempDir, "Caddyfile");
  process.env.CADDY_BIN = path.join(tempDir, "missing-caddy");
  let context;
  try {
    context = await createTestContext();
  } finally {
    if (previousCaddyfilePath === undefined) delete process.env.CADDYFILE_PATH;
    else process.env.CADDYFILE_PATH = previousCaddyfilePath;
    if (previousCaddyBin === undefined) delete process.env.CADDY_BIN;
    else process.env.CADDY_BIN = previousCaddyBin;
    if (!context) await fs.rm(tempDir, { recursive: true, force: true });
  }
  try {
    const config = await context.readConfigFile();
    config.server.caddy = {
      ...config.server.caddy,
      enabled: true,
      domain: "proxy.example.test",
      email: "ops@example.test"
    };
    const saved = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: config
    });

    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json?.ok, true);
    assert.equal(saved.json?.apply?.caddy?.ok, false);
    assert.equal((await context.readConfigFile()).server.caddy.enabled, true);
    const beforeRetry = await context.readConfigFile();
    const retried = await context.adminRequest("/admin/api/config/apply", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1", "if-match": saved.headers.get("etag") }, json: { stage: "caddy" }
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.json.apply.caddy.ok, false);
    assert.equal(retried.json.apply.proxy.appliedAt, saved.json.apply.proxy.appliedAt);
    assert.equal(retried.headers.get("etag"), saved.headers.get("etag"));
    assert.deepEqual(await context.readConfigFile(), beforeRetry);
    const reloaded = await context.adminRequest("/admin/api/reload", { method: "POST", headers: { "x-aoai-admin-csrf": "1" } });
    assert.equal(reloaded.json.apply.caddy.ok, false);
  } finally {
    await context?.cleanup();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("configuration mutations serialize Caddy application with matching response revisions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-apply-order-"));
  const binary = path.join(dir, "caddy");
  const trace = path.join(dir, "trace");
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(process.env.CADDY_TEST_TRACE, "start\\n");
setTimeout(() => fs.appendFileSync(process.env.CADDY_TEST_TRACE, "end\\n"), 250);
`, { mode: 0o700 });
  let context;
  try {
    context = await createTestContext({ proxyEnv: { CADDY_BIN: binary, CADDYFILE_PATH: path.join(dir, "Caddyfile"), CADDY_TEST_TRACE: trace } });
    const loaded = await context.adminRequest("/admin/api/config");
    loaded.json.server.caddy = { ...loaded.json.server.caddy, enabled: true, domain: "proxy.example.test", email: "ops@example.test" };
    const save = (config, etag) => context.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1", "if-match": etag }, json: config
    });
    const first = save(loaded.json, loaded.headers.get("etag"));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        if ((await fs.readFile(trace, "utf8")).includes("start")) break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    assert.equal(await fs.readFile(trace, "utf8"), "start\n");
    const intermediate = await context.adminRequest("/admin/api/config");
    intermediate.json.server.gracefulShutdownMs += 1000;
    const second = save(intermediate.json, intermediate.headers.get("etag"));
    const results = await Promise.all([first, second]);
    for (const result of results) {
      assert.equal(result.status, 200, result.text);
      assert.equal(result.json.apply.caddy.ok, true);
      assert.equal(result.json.apply.proxy.revision, result.headers.get("etag").slice(1, -1));
      assert.equal(result.json.apply.caddy.revision, result.json.apply.proxy.revision);
    }
    assert.equal(await fs.readFile(trace, "utf8"), "start\nend\nstart\nend\n");
    assert.notEqual(results[0].headers.get("etag"), results[1].headers.get("etag"));
    assert.equal((await context.readConfigFile()).server.gracefulShutdownMs, intermediate.json.server.gracefulShutdownMs);
  } finally {
    await context?.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("history rollback preserves current secrets and rejects a stale revision", async () => {
  const context = await createTestContext();
  try {
    const loaded = await context.adminRequest("/admin/api/config");
    const config = loaded.json;
    const save = (etag) => context.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1", "if-match": etag }, json: config
    });
    config.server.gracefulShutdownMs += 1000;
    config.apiKeys[0].key = "history-first-private-key";
    const first = await save(loaded.headers.get("etag"));
    assert.equal(first.status, 200, first.text);
    const firstEntry = (await context.adminRequest("/admin/api/config/history")).json.items[0];
    config.server.gracefulShutdownMs += 1000;
    config.apiKeys[0].key = "history-current-private-key";
    const second = await save(first.headers.get("etag"));
    assert.equal(second.status, 200, second.text);
    const detail = await context.adminRequest(`/admin/api/config/history/${firstEntry.id}`);
    assert.doesNotMatch(detail.text, /history-first-private-key|history-current-private-key/);
    const rollbackPath = `/admin/api/config/history/${firstEntry.id}/rollback`;
    const restored = await context.adminRequest(rollbackPath, {
      method: "POST", headers: { "x-aoai-admin-csrf": "1", "if-match": second.headers.get("etag") }
    });
    assert.equal(restored.status, 200, restored.text);
    const persisted = await context.readConfigFile();
    assert.equal(persisted.server.gracefulShutdownMs, first.json.config.server.gracefulShutdownMs);
    assert.equal(persisted.apiKeys[0].key, "history-current-private-key");
    const history = (await context.adminRequest("/admin/api/config/history")).json.items;
    assert.equal(history[0].action, "rollback");
    assert.equal(history[0].restoredFrom, firstEntry.id);
    assert.notEqual(history[0].id, firstEntry.id);
    assert.equal(history[0].apply.proxy.ok, true);
    const stale = await context.adminRequest(rollbackPath, {
      method: "POST", headers: { "x-aoai-admin-csrf": "1", "if-match": second.headers.get("etag") }
    });
    assert.equal(stale.status, 409);
    assert.equal((await context.adminRequest("/admin/api/config/history")).json.items.length, history.length);
    const missingRevision = await context.adminRequest("/admin/api/reload", {
      method: "POST", headers: { "x-aoai-admin-csrf": "1" }, json: { discardPendingDatabaseSync: true }
    });
    assert.equal(missingRevision.status, 428);
  } finally {
    await context.cleanup();
  }
});

test("admin APIs redact secrets and preserve them on config save", async () => {
  const previousConnectionString = process.env.CONFIG_DB_CONNECTION_STRING;
  process.env.CONFIG_DB_CONNECTION_STRING = "postgresql://admin:database-secret@example.invalid:5432/proxy";
  const context = await createTestContext();

  try {
    const loaded = await context.adminRequest("/admin/api/config");
    assert.equal(loaded.status, 200, loaded.text);
    assert.equal(loaded.json.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(loaded.json.server.adminAuth.password, REDACTED_SECRET_VALUE);
    assert.equal(loaded.json.admin.auth.password, REDACTED_SECRET_VALUE);
    assert.equal(loaded.json.apiKeys[0].key, REDACTED_SECRET_VALUE);
    assert.doesNotMatch(loaded.text, /test-upstream-key|test-client-key|"password":"admin"/);

    const unauthenticatedReveal = await context.request("/admin/api/keys/reveal", {
      method: "POST",
      headers: { "x-aoai-admin-csrf": "1" },
      json: { id: "test-client" }
    });
    assert.equal(unauthenticatedReveal.status, 401, unauthenticatedReveal.text);
    assert.doesNotMatch(unauthenticatedReveal.text, /test-client-key/);

    const revealWithoutCsrf = await context.adminRequest("/admin/api/keys/reveal", {
      method: "POST",
      json: { id: "test-client" }
    });
    assert.equal(revealWithoutCsrf.status, 403, revealWithoutCsrf.text);
    assert.doesNotMatch(revealWithoutCsrf.text, /test-client-key/);

    const revealed = await context.adminRequest("/admin/api/keys/reveal", {
      method: "POST",
      headers: { "x-aoai-admin-csrf": "1" },
      json: { id: "test-client" }
    });
    assert.equal(revealed.status, 200, revealed.text);
    assert.equal(revealed.json.key, "test-client-key");
    assert.match(revealed.headers.get("cache-control") || "", /no-store/);
    assert.equal(revealed.headers.get("pragma"), "no-cache");

    const secretAccessLogs = await context.adminRequest("/admin/api/logs?event=admin.api_key_secret_accessed");
    assert.equal(secretAccessLogs.status, 200, secretAccessLogs.text);
    assert.equal(secretAccessLogs.json.total, 1);
    assert.equal(secretAccessLogs.json.items[0].fields.keyRecordId, "test-client");
    assert.doesNotMatch(secretAccessLogs.text, /test-client-key/);

    loaded.json.server.gracefulShutdownMs = 12000;
    const saved = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: loaded.json
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.config.auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(saved.json.config.apiKeys[0].key, REDACTED_SECRET_VALUE);

    const persisted = await context.readConfigFile();
    assert.equal(persisted.auth.apiKey, "test-upstream-key");
    assert.equal(persisted.server.adminAuth.password, "admin");
    assert.equal(persisted.apiKeys[0].key, "test-client-key");
    assert.equal(persisted.server.gracefulShutdownMs, 12000);

    const databaseDefaults = await context.adminRequest("/admin/api/database/config");
    assert.equal(databaseDefaults.status, 200, databaseDefaults.text);
    assert.equal(databaseDefaults.json.config.connectionString, "");
    assert.equal(databaseDefaults.json.config.connectionStringConfigured, true);
    assert.doesNotMatch(databaseDefaults.text, /database-secret/);

    const unauthenticatedInitialize = await context.request("/admin/api/log-analytics/initialize", {
      method: "POST",
      headers: { "x-aoai-admin-csrf": "1" },
      json: {}
    });
    assert.equal(unauthenticatedInitialize.status, 401, unauthenticatedInitialize.text);

    const initializeWithoutCsrf = await context.adminRequest("/admin/api/log-analytics/initialize", {
      method: "POST",
      json: {}
    });
    assert.equal(initializeWithoutCsrf.status, 403, initializeWithoutCsrf.text);

    const invalidInitialize = await context.adminRequest("/admin/api/log-analytics/initialize", {
      method: "POST",
      headers: { "x-aoai-admin-csrf": "1" },
      json: {}
    });
    assert.equal(invalidInitialize.status, 400, invalidInitialize.text);
    assert.equal(invalidInitialize.json?.status, "failed");
    assert.equal(invalidInitialize.json?.error?.code, "INVALID_AZURE_RESOURCE_ID");

    const runtimeConfig = saved.json.config;
    runtimeConfig.routing.routeProfiles.chatCompletions.enabled = false;
    const disabledSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: runtimeConfig
    });
    assert.equal(disabledSave.status, 200, disabledSave.text);
    context.clearUpstreamRequests();
    const disabledRoute = await context.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: { model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(disabledRoute.status, 404, disabledRoute.text);
    assert.equal(disabledRoute.json?.code, "ROUTE_DISABLED");
    assert.equal(context.upstreamRequests.length, 0);

    const enabledConfig = disabledSave.json.config;
    enabledConfig.routing.routeProfiles.chatCompletions.enabled = true;
    enabledConfig.routing.routeProfiles.chatCompletions.defaultParams = {
      temperature: 0.2,
      presence_penalty: 0.3
    };
    enabledConfig.models[0].defaultParams = {
      temperature: 0.5,
      frequency_penalty: 0.4
    };
    enabledConfig.upstreams[0].headersTemplate = {
      "x-upstream-static": "configured",
      "api-key": "must-not-override-auth"
    };
    enabledConfig.upstreams[0].auth = {
      mode: "apiKey",
      apiKey: "test-per-upstream-key"
    };
    enabledConfig.upstreams[1].auth = {
      mode: "apiKey",
      apiKey: "test-anthropic-upstream-key"
    };
    enabledConfig.proxy.forwardHeaders.addRequestIdHeader = false;
    context.allowUpstreamApiKey("test-per-upstream-key");
    context.allowUpstreamApiKey("test-anthropic-upstream-key");
    const enabledSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: enabledConfig
    });
    assert.equal(enabledSave.status, 200, enabledSave.text);
    assert.equal(enabledSave.json.config.upstreams[0].auth.apiKey, REDACTED_SECRET_VALUE);
    assert.equal(enabledSave.json.config.upstreams[1].auth.apiKey, REDACTED_SECRET_VALUE);
    assert.doesNotMatch(enabledSave.text, /test-per-upstream-key|test-anthropic-upstream-key/);
    const persistedWithUpstreamAuth = await context.readConfigFile();
    assert.equal(persistedWithUpstreamAuth.upstreams[0].auth.apiKey, "test-per-upstream-key");
    assert.equal(persistedWithUpstreamAuth.upstreams[1].auth.apiKey, "test-anthropic-upstream-key");

    context.clearUpstreamRequests();
    const configuredRoute = await context.publicRequest("/v1/chat/completions", {
      method: "POST",
      json: {
        model: "gpt-5-mini",
        temperature: 0.8,
        messages: [{ role: "user", content: "hello" }]
      }
    });
    assert.equal(configuredRoute.status, 200, configuredRoute.text);
    const upstreamRequest = context.getUpstreamRequest();
    assert.equal(upstreamRequest.body.temperature, 0.8);
    assert.equal(upstreamRequest.body.presence_penalty, 0.3);
    assert.equal(upstreamRequest.body.frequency_penalty, 0.4);
    assert.equal(upstreamRequest.headers["x-upstream-static"], "configured");
    assert.equal(upstreamRequest.headers["api-key"], "test-per-upstream-key");
    assert.equal(upstreamRequest.headers["x-request-id"], undefined);

    context.clearUpstreamRequests();
    const messagesRoute = await context.publicRequest("/v1/messages", {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01" },
      json: {
        model: "claude-native",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }]
      }
    });
    assert.equal(messagesRoute.status, 200, messagesRoute.text);
    const messagesUpstreamRequest = context.getUpstreamRequest();
    assert.match(messagesUpstreamRequest.url, /\/anthropic\/v1\/messages/);
    assert.equal(messagesUpstreamRequest.headers["x-api-key"], "test-anthropic-upstream-key");
    assert.equal(messagesUpstreamRequest.headers["api-key"], undefined);
    assert.equal(messagesUpstreamRequest.headers.authorization, undefined);

    const imageConfig = enabledSave.json.config;
    imageConfig.media.generation.defaultModel = "gpt-image-1.5";
    imageConfig.media.generation.maxImages = 1;
    imageConfig.media.generation.allowedSizes = ["1024x1024"];
    imageConfig.media.generation.allowedQualityModes = ["high"];
    const imageSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: imageConfig
    });
    assert.equal(imageSave.status, 200, imageSave.text);

    context.clearUpstreamRequests();
    const rejectedImage = await context.publicRequest("/v1/images/generations", {
      method: "POST",
      json: { prompt: "test", n: 2, size: "1024x1024", quality: "high" }
    });
    assert.equal(rejectedImage.status, 400, rejectedImage.text);
    assert.equal(rejectedImage.json?.code, "IMAGE_GENERATION_POLICY_REJECTED");
    assert.equal(context.upstreamRequests.length, 0);

    const generatedImage = await context.publicRequest("/v1/images/generations", {
      method: "POST",
      json: { prompt: "test", size: "1024x1024", quality: "high" }
    });
    assert.equal(generatedImage.status, 200, generatedImage.text);
    assert.match(context.getUpstreamRequest().url, /gpt-image-1\.5/);

    const missingUpstreamKeyConfig = structuredClone(imageSave.json.config);
    missingUpstreamKeyConfig.upstreams[0].auth = { mode: "apiKey", apiKey: "" };
    const missingUpstreamKeySave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: missingUpstreamKeyConfig
    });
    assert.equal(missingUpstreamKeySave.status, 400, missingUpstreamKeySave.text);
    assert.match(missingUpstreamKeySave.json?.error || "", /upstreams\[0\]\.auth\.apiKey is required/);

    const missingManagedIdentityScopeConfig = structuredClone(imageSave.json.config);
    missingManagedIdentityScopeConfig.auth.scope = "";
    missingManagedIdentityScopeConfig.upstreams[0].auth = { mode: "managedIdentity", apiKey: "" };
    const missingManagedIdentityScopeSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: missingManagedIdentityScopeConfig
    });
    assert.equal(missingManagedIdentityScopeSave.status, 400, missingManagedIdentityScopeSave.text);
    assert.match(missingManagedIdentityScopeSave.json?.error || "", /auth\.scope is required.*managedIdentity/);

    const duplicateUpstreamConfig = structuredClone(imageSave.json.config);
    duplicateUpstreamConfig.upstreams[1].name = duplicateUpstreamConfig.upstreams[0].name;
    const duplicateUpstreamSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: duplicateUpstreamConfig
    });
    assert.equal(duplicateUpstreamSave.status, 400, duplicateUpstreamSave.text);
    assert.match(duplicateUpstreamSave.json?.error || "", /duplicates upstream name/);

    const unsupportedConfig = imageSave.json.config;
    unsupportedConfig.routing.fallbacks = { enabled: true };
    const unsupportedSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: unsupportedConfig
    });
    assert.equal(unsupportedSave.status, 400, unsupportedSave.text);
    assert.match(unsupportedSave.json?.error || "", /not supported/);

    const configStat = await fs.stat(context.configPath);
    assert.equal(configStat.mode & 0o777, 0o600);
    const tempFiles = (await fs.readdir(path.dirname(context.configPath)))
      .filter((name) => name.startsWith(`${path.basename(context.configPath)}.`) && name.endsWith(".tmp"));
    assert.deepEqual(tempFiles, []);
  } finally {
    await context.cleanup();
    if (previousConnectionString === undefined) {
      delete process.env.CONFIG_DB_CONNECTION_STRING;
    } else {
      process.env.CONFIG_DB_CONNECTION_STRING = previousConnectionString;
    }
  }
});

test("matched admin routes require administrator auth and CSRF even with encoded paths", async () => {
  const ctx = await createTestContext();
  try {
    for (const prefix of ["/admin", "/%61dmin", "/a%64min", "/%61%64%6din"]) {
      for (const request of [ctx.request, ctx.publicRequest]) {
        const config = await request(`${prefix}/api/config`);
        assert.equal(config.status, 401, `${prefix}: ${config.text}`);
        const secret = await request(`${prefix}/api/keys/reveal`, {
          method: "POST", headers: { "x-aoai-admin-csrf": "1" }, json: { id: "test-client" }
        });
        assert.equal(secret.status, 401, `${prefix}: ${secret.text}`);
        assert.doesNotMatch(secret.text, /test-client-key/);
      }
      const loaded = await ctx.adminRequest(`${prefix}/api/config`);
      assert.equal(loaded.status, 200, loaded.text);
      assert.equal(loaded.json.apiKeys[0].key, REDACTED_SECRET_VALUE);
      const noCsrf = await ctx.adminRequest(`${prefix}/api/keys/reveal`, {
        method: "POST", json: { id: "test-client" }
      });
      assert.equal(noCsrf.status, 403, noCsrf.text);
    }
    const config = (await ctx.adminRequest("/admin/api/config")).json;
    config.admin.basePath = "/control-panel";
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await ctx.publicRequest("/control-panel/api/config")).status, 401);
    assert.equal((await ctx.publicRequest("/%61dmin/api/config")).status, 401);
    assert.equal((await ctx.adminRequest("/control-panel/api/config")).status, 200);
    // An encoded static suffix still resolves to the protected admin handler.
    assert.equal((await ctx.publicRequest("/control-panel/api/%63onfig")).status, 401);
    config.admin.security.allowedIps = ["192.0.2.1"];
    assert.equal((await ctx.adminRequest("/control-panel/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    })).status, 200);
    assert.equal((await ctx.adminRequest("/%61dmin/api/config")).status, 403);
    assert.equal((await ctx.publicRequest("/v1/models")).status, 200);
    assert.equal(ctx.upstreamRequests.length, 0);
  } finally { await ctx.cleanup(); }
});

test("header authentication rejects unauthorized JSON before body parsing", async () => {
  const ctx = await createTestContext();
  try {
    for (const endpoint of ["/v1/chat/completions", "/admin/api/config", "/%61dmin/api/config"]) {
      const result = await ctx.request(endpoint, {
        method: endpoint.includes("config") ? "PUT" : "POST",
        headers: { "content-type": "application/json" }, body: '{"invalid":'
      });
      assert.equal(result.status, 401, `${endpoint}: ${result.text}`);
    }
    assert.equal((await ctx.publicRequest("/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"invalid":'
    })).status, 400, "Authenticated malformed JSON must still be rejected by the parser");
    assert.equal(ctx.upstreamRequests.length, 0);
  } finally { await ctx.cleanup(); }
});
