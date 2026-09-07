import assert from "node:assert/strict";
import test from "node:test";
import { maybeCompressImages } from "../src/proxy/body.js";
import { chatToMessagesRequest, responsesToMessagesRequest } from "../src/proxy/shim.js";
import { withTestContext } from "./lib/harness.js";

const POLICY_CONFIG = {
  media: {
    inputCompression: { enabled: false },
    remoteImages: { allow: false },
    inlineImages: { maxBase64Bytes: 4 }
  }
};

test("native Messages media policy rejects disabled remote images", async () => {
  const body = {
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "https://images.example.com/image.png" } }]
    }]
  };
  await assert.rejects(maybeCompressImages(body, POLICY_CONFIG, "messages"), {
    code: "REMOTE_IMAGE_URLS_DISABLED"
  });
});

test("native Messages media policy rejects oversized inline images", async () => {
  const body = {
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.alloc(5).toString("base64") } }]
    }]
  };
  await assert.rejects(maybeCompressImages(body, POLICY_CONFIG, "messages"), {
    code: "INLINE_IMAGE_TOO_LARGE"
  });
});

test("Chat-to-Messages media policy rejects disabled remote images", async () => {
  const body = chatToMessagesRequest({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://images.example.com/image.png" } }] }]
  }, "test-model");
  await assert.rejects(maybeCompressImages(body, POLICY_CONFIG, "messages"), {
    code: "REMOTE_IMAGE_URLS_DISABLED"
  });
});

test("Responses-to-Messages media policy rejects disabled remote images", async () => {
  const body = responsesToMessagesRequest({
    input: [{ role: "user", content: [{ type: "input_image", image_url: "https://images.example.com/image.png" }] }]
  }, "test-model");
  await assert.rejects(maybeCompressImages(body, POLICY_CONFIG, "messages"), {
    code: "REMOTE_IMAGE_URLS_DISABLED"
  });
});

test("media policy covers Messages tool results without traversing tool input", async () => {
  const image = { type: "image", source: { type: "url", url: "https://images.example.com/image.png" } };
  await assert.rejects(maybeCompressImages({
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [image] }] }]
  }, POLICY_CONFIG, "messages"), { code: "REMOTE_IMAGE_URLS_DISABLED" });
  const body = {
    messages: [{ role: "assistant", content: [{
      type: "tool_use", id: "call-1", name: "save_record", input: { image_url: "https://private.example.com/value" }
    }] }]
  };
  const before = structuredClone(body);
  assert.strictEqual(await maybeCompressImages(body, POLICY_CONFIG, "messages"), body);
  assert.deepEqual(body, before);
});

test("media policy preserves native objects and ignores unrelated image fields", async () => {
  for (const route of ["chat/completions", "responses"]) {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hello", metadata: { image_url: "https://private.example.com/value" } }] }],
      input: [{ role: "user", content: [{ type: "input_image", file_id: "file-image", detail: "high" }] }],
      metadata: { image_url: "https://private.example.com/value", image_base64: "unrelated-business-value" }
    };
    const before = structuredClone(body);
    assert.strictEqual(await maybeCompressImages(body, POLICY_CONFIG, route), body);
    assert.deepEqual(body, before);
  }
  const body = {
    messages: [{ role: "user", content: [{ type: "image", source: {
      type: "base64", media_type: "image/png", data: Buffer.alloc(4).toString("base64")
    }, cache_control: { type: "ephemeral" } }] }]
  };
  const before = structuredClone(body);
  await maybeCompressImages(body, {
    media: { ...POLICY_CONFIG.media, inputCompression: { enabled: true } }
  }, "messages");
  assert.deepEqual(body, before, "Existing Messages images must not acquire new compression behavior");
});

test("media policy counts inline bytes independently of base64 whitespace", async () => {
  const encoded = Buffer.alloc(4).toString("base64").replace(/(.{4})/g, "$1\n");
  const body = { input: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${encoded}` }] }] };
  const before = structuredClone(body);
  await maybeCompressImages(body, POLICY_CONFIG, "responses");
  assert.deepEqual(body, before);
});

test("media preflight rejects requests before upstream and preserves allowed Messages images", async (context) => {
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    config.media = { ...config.media, ...POLICY_CONFIG.media };
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);

    const routes = [
      ["Messages native", "/v1/messages", "claude-native", "messages"],
      ["Messages count tokens", "/v1/messages/count_tokens", "claude-native", "messages"],
      ["Chat native", "/v1/chat/completions", "gpt-5-mini", "chat/completions"],
      ["Responses native", "/v1/responses", "gpt-5.6-luna", "responses"],
      ["Chat-to-Messages", "/v1/chat/completions", "claude-native", "chat/completions"],
      ["Responses-to-Messages", "/v1/responses", "claude-native", "responses"]
    ];
    for (const [name, endpoint, model, protocol] of routes) {
      for (const inline of [false, true]) {
        await context.test(`${name}: ${inline ? "inline byte limit" : "remote images disabled"}`, async () => {
          const data = Buffer.alloc(5).toString("base64");
          const url = inline ? `data:image/png;base64,${data}` : "https://images.example.com/image.png";
          const part = protocol === "messages"
            ? { type: "image", source: inline ? { type: "base64", media_type: "image/png", data } : { type: "url", url } }
            : protocol === "responses"
              ? { type: "input_image", image_url: url }
              : { type: "image_url", image_url: { url } };
          const payload = {
            model,
            ...(protocol === "responses"
              ? { input: [{ role: "user", content: [part] }] }
              : { max_tokens: 16, messages: [{ role: "user", content: [part] }] })
          };
          ctx.clearUpstreamRequests();
          const result = await ctx.publicRequest(endpoint, { method: "POST", json: payload });
          assert.equal(result.status, 400, result.text);
          assert.equal(result.json.error.code, inline ? "INLINE_IMAGE_TOO_LARGE" : "REMOTE_IMAGE_URLS_DISABLED");
          assert.equal(ctx.upstreamRequests.length, 0);
        });
      }
    }

    config.media.remoteImages = { allow: true, allowedHosts: ["images.example.com"] };
    const allowed = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(allowed.status, 200, allowed.text);
    const payload = {
      model: "claude-native", max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://images.example.com/image.png" } }] }]
    };
    ctx.clearUpstreamRequests();
    const result = await ctx.publicRequest("/v1/messages", { method: "POST", json: payload });
    assert.equal(result.status, 200, result.text);
    assert.equal(ctx.upstreamRequests.length, 1);
    const upstream = ctx.upstreamRequests[0];
    assert.deepEqual(upstream.body, { ...payload, model: "claude-native-deployment" });
    assert.ok(new URL(upstream.url, "http://localhost").pathname.endsWith("/messages"));
    assert.equal(upstream.headers["x-api-key"], "test-upstream-key");
    assert.equal(upstream.headers.authorization, undefined);

    payload.messages[0].content[0].source.url = "https://other.example.com/image.png";
    ctx.clearUpstreamRequests();
    const blockedHost = await ctx.publicRequest("/v1/messages", { method: "POST", json: payload });
    assert.equal(blockedHost.status, 400, blockedHost.text);
    assert.equal(blockedHost.json.error.code, "REMOTE_IMAGE_HOST_NOT_ALLOWED");
    assert.equal(ctx.upstreamRequests.length, 0);
  });
});