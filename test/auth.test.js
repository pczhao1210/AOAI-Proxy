import test from "node:test";
import assert from "node:assert/strict";

import { getUpstreamAuthHeaders, initAuth } from "../src/auth.js";

test("per-upstream API key overrides the global upstream key", async () => {
  initAuth({ auth: { mode: "apiKey", apiKey: "global-key" } });

  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", {
      auth: { mode: "apiKey", apiKey: "upstream-key" }
    }),
    { "api-key": "upstream-key" }
  );
  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", {
      auth: { mode: "apiKey", apiKey: "anthropic-key" },
      apiKeyHeader: "x-api-key"
    }),
    { "x-api-key": "anthropic-key" }
  );
});

test("per-upstream API key mode requires a key", async () => {
  initAuth({ auth: { mode: "apiKey", apiKey: "global-key" } });

  await assert.rejects(
    getUpstreamAuthHeaders("unused", { auth: { mode: "apiKey", apiKey: "" } }),
    /upstream\.auth\.apiKey is required/
  );
});

test("upstreams without an auth override inherit the global API key", async () => {
  initAuth({ auth: { mode: "apiKey", apiKey: "global-key" } });

  assert.deepEqual(
    await getUpstreamAuthHeaders("unused"),
    { "api-key": "global-key" }
  );
});
test("OpenAI upstream API keys are sent as Bearer tokens for text routes", async () => {
  initAuth({ auth: { mode: "apiKey", apiKey: "global-key" } });
  const openai = { provider: "openai" };

  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", { auth: { mode: "apiKey", apiKey: "sk-upstream" }, upstream: openai, apiKeyHeader: "api-key" }),
    { authorization: "Bearer sk-upstream" }
  );
  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", { upstream: openai, apiKeyHeader: "api-key" }),
    { authorization: "Bearer global-key" }
  );
  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", { auth: { mode: "apiKey", apiKey: "azure-key" }, upstream: { provider: "azure-openai" }, apiKeyHeader: "api-key" }),
    { "api-key": "azure-key" }
  );
  assert.deepEqual(
    await getUpstreamAuthHeaders("unused", { auth: { mode: "apiKey", apiKey: "msg-key" }, upstream: openai, apiKeyHeader: "x-api-key" }),
    { "x-api-key": "msg-key" }
  );
});
