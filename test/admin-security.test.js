import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REDACTED_SECRET_VALUE } from "../src/admin-config.js";
import { createTestContext } from "./lib/harness.js";

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
    unsupportedConfig.routing.fallbacks.enabled = true;
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
