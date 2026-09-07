import assert from "node:assert/strict";
import test from "node:test";
import { buildUpstreamHeaders } from "../src/proxy/upstream-headers.js";
import { withTestContext } from "./lib/harness.js";

const protocols = ["chat/completions", "responses", "messages"];
const models = ["gpt-5-mini", "gpt-5.6-luna", "claude-native"];

function headerOptions(overrides = {}) {
  return {
    incomingHeaders: {}, config: {}, backendRouteKey: "messages", upstream: {},
    targetUrl: "https://upstream.example/anthropic/v1/messages",
    upstreamAuthHeaders: { "x-api-key": "upstream-key" },
    requestContext: { requestId: "request-one", conversationId: "conversation-one", sessionId: "session-one" },
    ...overrides
  };
}

test("header assembly preserves inputs, replaces client credentials and uses resolved correlation context", () => {
  const options = headerOptions({
    backendRouteKey: "responses",
    incomingHeaders: { Authorization: "client-secret", "x-api-key": "client-secret", "x-request-id": "client-id", "x-order": "client" },
    upstream: { headersTemplate: {
      Authorization: "template-secret", "api-key": "template-secret", "content-length": 100,
      "x-order": "template", "Anthropic-Version": "template-version", "Anthropic-Beta": "template-beta",
      "x-template-array": ["not-supported"], "x-template-object": { invalid: true }
    } },
    upstreamAuthHeaders: { authorization: "Bearer upstream-token" }
  });
  const original = structuredClone(options);
  const result = buildUpstreamHeaders(options);
  assert.deepEqual(result, { headers: {
    "x-order": "template", "content-type": "application/json", authorization: "Bearer upstream-token",
    "x-request-id": "request-one", "x-conversation-id": "conversation-one", "x-session-id": "session-one"
  }, filteredBetas: [] });
  assert.deepEqual(options, original);
  result.headers["x-order"] = "changed-output";
  assert.equal(buildUpstreamHeaders(options).headers["x-order"], "template");
});

test("correlation injection toggle preserves ordinary forwarding rules and context fallbacks", () => {
  const incomingHeaders = { "x-request-id": "client-request", "x-session-id": "client-session" };
  for (const [mode, expected] of [["allowlist", {}], ["denylist", incomingHeaders]]) {
    const { headers } = buildUpstreamHeaders(headerOptions({
      backendRouteKey: "chat/completions", incomingHeaders,
      config: { proxy: { forwardHeaders: { mode, allow: [], addRequestIdHeader: false } } }
    }));
    assert.deepEqual(headers, { ...expected, "content-type": "application/json", "x-api-key": "upstream-key" });
  }
  const { headers } = buildUpstreamHeaders(headerOptions({ requestContext: { requestId: "fallback-id" } }));
  assert.equal(headers["x-request-id"], "fallback-id");
  assert.equal(headers["x-conversation-id"], "fallback-id");
  assert.equal(headers["x-session-id"], "fallback-id");
});

test("Messages version fallback and disabled SDK forwarding retain the existing policy boundary", () => {
  for (const version of [undefined, "", "   ", " 2023-06-01 "]) {
    for (const mode of ["allowlist", "denylist"]) {
      const { headers } = buildUpstreamHeaders(headerOptions({
        incomingHeaders: {
          "anthropic-version": version, "anthropic-beta": "allowed-beta",
          "x-claude-client": "client", "x-stainless-lang": "typescript", "x-anthropic-client": "client"
        },
        upstream: { headersTemplate: { "anthropic-version": "template-version", "x-stainless-runtime": "configured-runtime" } },
        config: {
          proxy: { forwardHeaders: { mode, allow: ["anthropic-beta", "x-claude-client", "x-stainless-lang", "x-anthropic-client"] } },
          compatibility: { anthropic: { forwardSdkMetadataHeaders: false, betaAllowlist: ["allowed-beta"] } }
        }
      }));
      assert.equal(headers["anthropic-version"], "2023-06-01");
      assert.equal(headers["anthropic-beta"], "allowed-beta");
      for (const name of ["x-claude-client", "x-stainless-lang", "x-anthropic-client"]) assert.equal(headers[name], undefined);
      assert.equal(headers["x-stainless-runtime"], "configured-runtime");
    }
  }
});

test("beta normalization preserves case, stable order and inputs across mixed header casing", () => {
  const options = headerOptions({
    incomingHeaders: { "Anthropic-Beta": " allowed , unknown , allowed,ALLOWED,, " },
    upstream: { headersTemplate: { "anthropic-beta": "unknown,second,template-only" } },
    config: { compatibility: { anthropic: { betaAllowlist: [" allowed ", "second", "", 123] } } }
  });
  const before = structuredClone(options);
  const { headers, filteredBetas } = buildUpstreamHeaders(options);
  assert.equal(headers["Anthropic-Beta"], undefined);
  assert.equal(headers["anthropic-beta"], "allowed,second");
  assert.deepEqual(filteredBetas, ["unknown", "ALLOWED", "template-only"]);
  assert.deepEqual(options, before);
});

test("unknown beta policy preserves direct-provider and final-host rules", () => {
  for (const scenario of [
    { provider: "anthropic", targetUrl: "https://upstream.example/messages", accepted: true },
    { provider: " Anthropic-API ", targetUrl: "https://upstream.example/messages", accepted: true },
    { provider: "openai", targetUrl: "https://api.anthropic.com/v1/messages", accepted: true },
    { provider: "openai", targetUrl: "https://eu.anthropic.com/v1/messages", accepted: true },
    { provider: "openai", targetUrl: "https://api.anthropic.com.example/messages", accepted: false },
    { provider: "openai", targetUrl: "https://notanthropic.com/messages", accepted: false },
    { provider: "openai", targetUrl: "invalid URL", accepted: false },
    { provider: "anthropic", targetUrl: "https://api.anthropic.com/messages", policy: { unknownBetaPolicy: "allowlist" }, accepted: false },
    { provider: "openai", targetUrl: "https://upstream.example/messages", policy: { betaAllowlistEnabled: false }, accepted: true }
  ]) {
    const { headers, filteredBetas } = buildUpstreamHeaders(headerOptions({
      incomingHeaders: { "anthropic-beta": "future-beta,future-beta" },
      upstream: { provider: scenario.provider }, targetUrl: scenario.targetUrl,
      config: { compatibility: { anthropic: { betaAllowlist: [], ...scenario.policy } } }
    }));
    assert.equal(headers["anthropic-beta"], scenario.accepted ? "future-beta" : undefined, JSON.stringify(scenario));
    assert.deepEqual(filteredBetas, scenario.accepted ? [] : ["future-beta"]);
  }
});

test("upstream header assembly preserves all nine JSON/SSE direction contracts", async context => {
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.proxy.forwardHeaders = {
      mode: "allowlist", allow: ["x-order", "x-client-metadata"], deny: ["x-claude-denied"], addRequestIdHeader: true
    };
    config.compatibility = { ...config.compatibility, anthropic: {
      ...config.compatibility?.anthropic,
      forwardSdkMetadataHeaders: true, unknownBetaPolicy: "allowlist",
      betaAllowlistEnabled: true, betaAllowlist: ["allowed-beta"]
    } };
    for (const upstream of config.upstreams) {
      upstream.headersTemplate = {
        "x-order": "template", "x-configured-count": 7, "x-configured-enabled": true,
        "content-type": "application/x-template", "anthropic-version": "template-version",
        "anthropic-beta": "allowed-beta,template-only-beta,allowed-beta",
        "authorization": "Bearer template-secret", "api-key": "template-secret",
        "x-api-key": "template-secret", "cookie": "template-secret",
        "x-request-id": "template-request", "x-conversation-id": "template-conversation", "x-session-id": "template-session"
      };
    }
    for (const [index, protocol] of protocols.entries()) {
      config.models.find(model => model.id === models[index]).routes = { "*": protocol };
    }
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);

    for (const [sourceIndex, source] of protocols.entries()) {
      for (const [targetIndex, target] of protocols.entries()) {
        for (const stream of [false, true]) {
          await context.test(`${source} -> ${target} ${stream ? "SSE" : "JSON"}`, async () => {
            const requestId = `headers-${sourceIndex}-${targetIndex}-${stream}`;
            const body = {
              model: models[targetIndex], stream,
              ...(source === "responses" ? { input: "header contract" }
                : { [source === "messages" ? "max_tokens" : "max_completion_tokens"]: 32,
                  messages: [{ role: "user", content: "header contract" }] })
            };
            ctx.clearUpstreamRequests();
            const result = await ctx.publicRequest(`/v1/${source}`, {
              method: "POST", json: body,
              headers: {
                "x-order": "client", "x-client-metadata": "client-value", "x-private-routing": "hidden",
                "anthropic-version": "2023-06-01", "anthropic-beta": "client-beta",
                "x-stainless-lang": "typescript", "x-claude-client": "test-sdk", "x-anthropic-client": "test-client",
                "x-claude-denied": "hidden", "x-claude-api-key": "client-secret",
                "x-stainless-secret": "client-secret", "cookie": "client-secret",
                "x-request-id": requestId, "x-conversation-id": "conversation-headers", "x-session-id": "session-headers"
              }
            });
            assert.equal(result.status, 200, result.text);
            assert.equal(ctx.upstreamRequests.length, 1);
            const upstream = ctx.upstreamRequests[0];
            assert.equal(new URL(upstream.url, "http://localhost").pathname,
              target === "messages" ? "/anthropic/v1/messages" : `/openai/v1/${target}`);
            assert.equal(upstream.body.model, target === "messages" ? "claude-native-deployment" : models[targetIndex]);
            assert.equal(upstream.body.stream, stream);
            const headers = upstream.headers;
            const expected = {
              "x-order": "template", "x-client-metadata": "client-value",
              "x-configured-count": "7", "x-configured-enabled": "true", "content-type": "application/json",
              "x-request-id": requestId, "x-conversation-id": "conversation-headers", "x-session-id": "session-headers",
              [target === "messages" ? "x-api-key" : "api-key"]: "test-upstream-key",
              ...(target === "messages" ? {
                "anthropic-version": "2023-06-01", "anthropic-beta": "allowed-beta",
                "x-stainless-lang": "typescript", "x-claude-client": "test-sdk", "x-anthropic-client": "test-client"
              } : {})
            };
            assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, headers[key]])), expected);
            const absent = ["authorization", "cookie", "x-private-routing", "x-claude-denied", "x-claude-api-key", "x-stainless-secret",
              target === "messages" ? "api-key" : "x-api-key",
              ...(target === "messages" ? [] : ["anthropic-version", "anthropic-beta", "x-stainless-lang", "x-claude-client", "x-anthropic-client"])
            ];
            for (const name of absent) assert.equal(headers[name], undefined, name);
            assert.ok(!JSON.stringify(headers).includes("template-secret"));
            assert.ok(!JSON.stringify(headers).includes("client-secret"));
            if (source === target) assert.deepEqual(upstream.body, { ...body, model: upstream.body.model });
            if (stream) assert.ok(result.text.includes(source === "messages" ? "message_stop" : source === "responses" ? "response.completed" : "[DONE]"));
            else assert.equal(result.json.model, models[targetIndex]);
          });
        }
      }
    }
    const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.anthropic_betas_filtered");
    assert.equal(logs.status, 200, logs.text);
    assert.equal(logs.json.total, 6);
    for (const entry of logs.json.items) {
      assert.equal(entry.fields.filteredBetas, '["template-only-beta"]');
      assert.equal(entry.fields.filteredBetaCount, 1);
    }
  });
});