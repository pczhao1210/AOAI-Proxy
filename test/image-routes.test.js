import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";
import { createImageFixtures } from "./lib/image-fixtures.js";
import { optimizeInlineImage } from "../src/proxy/image-optimizer.js";

test("adaptive images freeze all nine JSON/SSE directions and preflight budgets", async context => {
  const { photo } = await createImageFixtures();
  const settings = { enabled: true, mode: "adaptive", minBytes: 1, maxLongSidePx: 320, quality: 0.8 };
  const expected = (await optimizeInlineImage(photo, settings)).buffer.toString("base64");
  const protocols = ["chat/completions", "responses", "messages"];
  const makeBody = (source, model, stream) => {
    const url = `data:image/jpeg;base64,${photo.toString("base64")}`;
    const image = source === "messages"
      ? { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photo.toString("base64") } }
      : source === "responses" ? { type: "input_image", image_url: url, detail: "high" }
        : { type: "image_url", image_url: { url, detail: "high" } };
    const content = [{ type: source === "responses" ? "input_text" : "text", text: "Inspect this image" }, image];
    return { model, stream, ...(source === "responses" ? { input: [{ role: "user", content }] } : { max_tokens: 32, messages: [{ role: "user", content }] }) };
  };
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { ...config.media, inputCompression: settings };
    const models = ["gpt-5-mini", "gpt-5.6-luna", "claude-native"];
    for (const [index, protocol] of protocols.entries()) {
      config.models.find(model => model.id === models[index]).routes = { "*": protocol };
    }
    const save = async () => {
      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
      });
      assert.equal(saved.status, 200, saved.text);
    };
    await save();
    for (const source of protocols) {
      for (const [index, target] of protocols.entries()) {
        for (const stream of [false, true]) {
          await context.test(`${source} -> ${target} ${stream ? "SSE" : "JSON"}`, async () => {
            ctx.clearUpstreamRequests();
            const result = await ctx.publicRequest(`/v1/${source}`, { method: "POST", json: makeBody(source, models[index], stream) });
            assert.equal(result.status, 200, result.text);
            assert.equal(ctx.upstreamRequests.length, 1);
            const upstream = ctx.upstreamRequests[0];
            assert.ok(new URL(upstream.url, "http://localhost").pathname.endsWith(`/${target}`), upstream.url);
            assert.equal(upstream.body.stream, stream);
            const content = (target === "responses" ? upstream.body.input : upstream.body.messages)[0].content;
            assert.equal(content[0].text, "Inspect this image");
            const image = content[1];
            if (target === "messages") {
              assert.equal(image.source.media_type, "image/jpeg");
              assert.ok(image.source.data === expected, "Messages must carry the optimized bytes");
              assert.equal(upstream.headers["x-api-key"], "test-upstream-key");
              assert.equal(upstream.headers.authorization, undefined);
            } else {
              const url = typeof image.image_url === "string" ? image.image_url : image.image_url.url;
              assert.ok(url === `data:image/jpeg;base64,${expected}`, "Image data URL must match the selected encoding");
              assert.equal(upstream.headers["api-key"], "test-upstream-key");
            }
            assert.ok(!Object.values(upstream.headers).includes("Bearer test-client-key"));
            if (source === target && source !== "messages") {
              assert.equal(source === "responses" ? image.detail : image.image_url.detail, "high");
            }
            if (stream) {
              assert.ok(result.text.includes(source === "messages" ? "message_stop" : source === "responses" ? "response.completed" : "[DONE]"));
            } else assert.equal(result.json.model, models[index]);
          });
        }
      }
    }
    const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.image_optimization");
    assert.equal(logs.status, 200);
    assert.ok(logs.text.includes("optimized"));
    assert.ok(!logs.text.includes(photo.toString("base64").slice(0, 100)));
    assert.ok(!logs.text.includes("data:image/"));

    for (const [inlineImages, errorCode] of [
      [{ maxImages: 1 }, "IMAGE_COUNT_LIMIT_EXCEEDED"],
      [{ maxTotalBytes: photo.length - 1 }, "INLINE_IMAGES_TOTAL_TOO_LARGE"]
    ]) {
      config.media.inlineImages = inlineImages;
      await save();
      const body = makeBody("chat/completions", models[0], false);
      body.messages[0].content.push(structuredClone(body.messages[0].content[1]));
      ctx.clearUpstreamRequests();
      const rejected = await ctx.publicRequest("/v1/chat/completions", { method: "POST", json: body });
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal(rejected.json.error.code, errorCode);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    config.media.inlineImages = { maxImages: 0, maxTotalBytes: 0 };
    config.apiKeys[0].rateLimit = { rpm: 1, windowSeconds: 60 };
    await save();
    const before = await ctx.adminRequest("/admin/api/logs?event=proxy.image_optimization");
    ctx.clearUpstreamRequests();
    const denied = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST", json: makeBody("chat/completions", models[0], false)
    });
    assert.equal(denied.status, 429, denied.text);
    assert.equal(ctx.upstreamRequests.length, 0);
    const after = await ctx.adminRequest("/admin/api/logs?event=proxy.image_optimization");
    assert.equal(after.text, before.text, "Governance-denied requests must not start image processing");
  });
});