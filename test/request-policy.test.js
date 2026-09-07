import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeIncomingHeaders } from "../src/proxy/body.js";
import { fetchWithRetry, resolveUpstreamPolicy } from "../src/proxy/reliability.js";
import { withTestContext } from "./lib/harness.js";

test("empty incoming header allowlists only preserve explicit protocol prefixes", () => {
  const headers = {
    "x-internal-routing": "private", "content-type": "application/json",
    "anthropic-version": "2023-06-01", "anthropic-api-key": "client-secret", authorization: "Bearer client-secret"
  };
  const config = { proxy: { forwardHeaders: { mode: "allowlist", allow: [] } } };
  assert.deepEqual(sanitizeIncomingHeaders(headers, config), {});
  assert.deepEqual(sanitizeIncomingHeaders(headers, config, { allowPrefixes: ["anthropic-"] }), {
    "anthropic-version": "2023-06-01"
  });
});

test("explicit retry status lists override HTTP classifications and defaults", async (context) => {
  for (const scenario of [
    { statuses: [429], status: 503, expectedAttempts: 1 },
    { statuses: [], status: 429, expectedAttempts: 1 },
    { statuses: [503], status: 503, expectedAttempts: 2 },
    { statuses: undefined, status: 503, expectedAttempts: 2 }
  ]) {
    await context.test(JSON.stringify(scenario), async (scenarioContext) => {
      let attempts = 0;
      scenarioContext.mock.method(globalThis, "fetch", async () => {
        attempts += 1;
        return new Response('{"error":{"message":"unavailable"}}', { status: scenario.status });
      });
      const policy = resolveUpstreamPolicy({ proxy: { retries: {
        maxRetries: 1, statuses: scenario.statuses, baseDelayMs: 0, maxDelayMs: 0
      } } });
      const result = await fetchWithRetry({
        targetUrl: "http://mock.invalid", headers: {}, bodyText: "{}", policy, logMeta: {}, log: { warn() {} }
      });
      assert.equal(attempts, scenario.expectedAttempts);
      assert.equal(result.upstreamStatus, scenario.status);
    });
  }
});

test("native JSON and SSE requests honor persisted header and retry policies", async (context) => {
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    config.proxy ||= {};
    config.proxy.forwardHeaders = { mode: "allowlist", allow: [] };
    for (const upstream of config.upstreams) upstream.errorPolicy = { nativePassthrough: true };
    for (const statuses of [[503], [], [429]]) {
      config.proxy.retries = { maxRetries: 1, statuses, baseDelayMs: 1, maxDelayMs: 1 };
      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
      });
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(saved.json.config.proxy.retries.statuses, statuses);
      for (const [endpoint, model] of [
        ["/v1/chat/completions", "gpt-5-mini"],
        ["/v1/responses", "gpt-5.6-luna"],
        ["/v1/messages", "claude-native"]
      ]) {
        for (const stream of [false, true]) {
          await context.test(`${endpoint} stream=${stream} statuses=${JSON.stringify(statuses)}`, async () => {
            ctx.clearUpstreamRequests();
            const result = await ctx.publicRequest(endpoint, {
              method: "POST", headers: { "x-private-routing": "must-not-leak" },
              json: {
                model, stream,
                ...(endpoint === "/v1/responses"
                  ? { input: "trigger native HTTP error" }
                  : { max_tokens: 16, messages: [{ role: "user", content: "trigger native HTTP error" }] })
              }
            });
            assert.equal(result.status, 429, result.text);
            assert.equal(result.json.native_marker, "preserved");
            assert.equal(result.headers.get("retry-after"), "2");
            assert.equal(ctx.upstreamRequests.length, statuses.includes(429) ? 2 : 1);
            for (const upstream of ctx.upstreamRequests) {
              assert.equal(upstream.headers["x-private-routing"], undefined);
              assert.equal(upstream.headers.authorization, undefined);
              assert.equal(upstream.headers[endpoint === "/v1/messages" ? "x-api-key" : "api-key"], "test-upstream-key");
              assert.equal(upstream.body.stream, stream);
            }
          });
        }
      }
    }
  });
});