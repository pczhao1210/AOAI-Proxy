import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

async function withCapabilityContext(cards, run, options) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-capability-contract-"));
  const previousPricingDir = process.env.PRICING_DIR;
  const pricingDir = path.join(tempDir, "pricing");
  try {
    await fs.cp(new URL("../pricing/", import.meta.url), pricingDir, { recursive: true });
    for (const card of cards) {
      await fs.writeFile(path.join(pricingDir, `${card.id}.json`), JSON.stringify({
        provider: "azure-openai", defaultInterface: "responses", proxyTemplate: {}, ...card
      }));
    }
    process.env.PRICING_DIR = pricingDir;
    await withTestContext(async ctx => {
      const config = await ctx.readConfigFile();
      config.models.push(...cards.map(card => ({
        id: card.id, pricingRef: card.id, targetModel: "capability-deployment", upstream: "mock-foundry",
        routes: card.interfaces.length === 1 ? { "*": card.interfaces[0] } : {},
        clientCompatibility: { codex: card.interfaces.includes("responses") }
      })));
      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
      });
      assert.equal(saved.status, 200, saved.text);
      await run(ctx);
    }, options);
  } finally {
    if (previousPricingDir == null) delete process.env.PRICING_DIR;
    else process.env.PRICING_DIR = previousPricingDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("explicit Chat token profiles freeze JSON and SSE requests independently of capability labels in all incoming directions", async t => {
  const cards = ["max_tokens", "max_completion_tokens"].flatMap(parameter => [false, true].map(reasoning => ({
    id: `token-${parameter}-${reasoning}`, interfaces: ["chat/completions"], capabilities: reasoning ? ["reasoning"] : [],
    protocolProfiles: { "chat/completions": { request: { outputTokenParameter: parameter } } }
  })));
  await withCapabilityContext(cards, async ctx => {
    for (const parameter of ["max_tokens", "max_completion_tokens"]) {
      for (const protocol of ["chat/completions", "responses", "messages"]) {
        for (const stream of [false, true]) {
          await t.test(`${protocol} -> Chat ${parameter} ${stream ? "SSE" : "JSON"}`, async () => {
            let baseline;
            for (const reasoning of [false, true]) {
              ctx.clearUpstreamRequests();
              const input = protocol === "responses"
                ? { input: "hello", max_output_tokens: 17 }
                : { messages: [{ role: "user", content: "hello" }], max_tokens: 17 };
              const model = `token-${parameter}-${reasoning}`;
              const result = await ctx.publicRequest(`/v1/${protocol}`, {
                method: "POST",
                headers: { "x-request-id": "capability-contract", "x-conversation-id": "capability-contract", "x-session-id": "capability-contract" },
                json: { model, ...input, stream }
              });
              assert.equal(result.status, 200, result.text);
              const upstream = ctx.getUpstreamRequest();
              assert.equal(upstream.url, "/openai/v1/chat/completions");
              assert.equal(upstream.body.model, "capability-deployment");
              assert.equal(upstream.body[parameter], 17);
              assert.equal(Object.hasOwn(upstream.body, parameter === "max_tokens" ? "max_completion_tokens" : "max_tokens"), false);
              const contract = { url: upstream.url, body: upstream.body, headers: upstream.headers };
              if (baseline) assert.deepEqual(contract, baseline);
              else baseline = contract;
              if (stream) {
                assert.match(result.text, protocol === "responses" ? /response\.completed/ : protocol === "messages" ? /message_stop/ : /\[DONE\]/);
              } else {
                assert.equal(result.json.model, model);
              }
            }
          });
        }
      }
    }
  });
});

test("explicit token normalization preserves malformed client values for a real upstream error", async () => {
  const card = { id: "invalid-token-value", interfaces: ["chat/completions"], capabilities: [],
    protocolProfiles: { "chat/completions": { request: { outputTokenParameter: "max_completion_tokens" } } } };
  const errorBody = { error: { code: "invalid_token_limit", message: "invalid output token limit" } };
  await withCapabilityContext([card], async ctx => {
    const config = await ctx.readConfigFile();
    config.upstreams.find(upstream => upstream.name === "mock-foundry").errorPolicy = { nativePassthrough: true };
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    for (const [parameters, expected] of [
      [{ max_tokens: "invalid" }, "invalid"],
      [{ max_tokens: null }, null],
      [{ max_completion_tokens: "invalid", max_tokens: 64 }, "invalid"],
      [{ max_completion_tokens: "undefined", max_tokens: 64 }, "undefined"],
      [{ max_completion_tokens: "[undefined]", max_tokens: 64 }, "[undefined]"],
      [{ max_completion_tokens: null, max_tokens: 64 }, null],
      [{ max_completion_tokens: 0, max_tokens: 64 }, 0]
    ]) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST", json: { model: card.id, messages: [{ role: "user", content: "hello" }], ...parameters }
      });
      assert.equal(ctx.getUpstreamRequest().body.max_completion_tokens, expected);
      assert.equal(Object.hasOwn(ctx.getUpstreamRequest().body, "max_tokens"), false);
      assert.equal(result.status, 422);
      assert.deepEqual(result.json, errorBody);
    }
  }, {
    upstreamHandler: ({ res, body }) => {
      if (body?.model !== "capability-deployment") return false;
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify(errorBody));
      return true;
    }
  });
});

test("Codex uses explicit modalities and reasoning profiles while preserving legacy vision fallback and tool labels", async () => {
  const cards = [
    { id: "catalog-no-labels", capabilities: [], inputModalities: ["text", "image"] },
    { id: "catalog-text-only", capabilities: ["vision", "parallel-tool-calling"], inputModalities: ["text"] },
    { id: "catalog-legacy-vision", capabilities: ["vision"] }
  ].map(card => ({
    ...card, interfaces: ["responses"],
    protocolProfiles: { responses: { reasoning: { parameter: "reasoning.effort", levels: ["low", "high"] } } }
  }));
  await withCapabilityContext(cards, async ctx => {
    const result = await ctx.publicRequest("/v1/models?format=codex");
    assert.equal(result.status, 200, result.text);
    for (const [id, image, parallel] of [
      ["catalog-no-labels", true, false], ["catalog-text-only", false, true], ["catalog-legacy-vision", true, false]
    ]) {
      const model = result.json.models.find(item => item.slug === id);
      assert.ok(model, id);
      assert.deepEqual(model.input_modalities, image ? ["text", "image"] : ["text"]);
      assert.equal(model.supports_image_detail_original, image);
      assert.equal(model.supports_parallel_tool_calls, parallel);
      assert.deepEqual(model.supported_reasoning_levels.map(level => level.effort), ["low", "high"]);
      assert.equal(model.default_reasoning_level, "low");
    }
    const config = await ctx.readConfigFile();
    config.models.find(model => model.id === "catalog-no-labels").codex = {
      supportedReasoningEfforts: ["minimal", "high"], defaultReasoningEffort: "high"
    };
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    const overridden = await ctx.publicRequest("/v1/models?format=codex");
    const model = overridden.json.models.find(item => item.slug === "catalog-no-labels");
    assert.deepEqual(model.supported_reasoning_levels.map(level => level.effort), ["minimal", "high"]);
    assert.equal(model.default_reasoning_level, "high");
    const library = await ctx.adminRequest("/admin/api/pricing-library");
    for (const card of cards) {
      const normalized = library.json.items.find(item => item.id === card.id);
      assert.equal(normalized.protocolProfiles.responses.reasoning.default, "");
    }
  });
});
