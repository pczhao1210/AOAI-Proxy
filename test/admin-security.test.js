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
    enabledConfig.proxy.forwardHeaders.addRequestIdHeader = false;
    const enabledSave = await context.adminRequest("/admin/api/config", {
      method: "PUT",
      headers: { "x-aoai-admin-csrf": "1" },
      json: enabledConfig
    });
    assert.equal(enabledSave.status, 200, enabledSave.text);

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
    assert.equal(upstreamRequest.headers["api-key"], "test-upstream-key");
    assert.equal(upstreamRequest.headers["x-request-id"], undefined);

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
