import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

const policy = {
  tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
  tiers: [
    { id: "short", promptTokensBelow: 20, inputPer1mTokens: 2, cachedInputPer1mTokens: 0.2, cacheWritePer1mTokens: 2.5, cacheWrite5mPer1mTokens: 2.5, outputPer1mTokens: 10 },
    { id: "long", promptTokensAtLeast: 20, inputPer1mTokens: 4, cachedInputPer1mTokens: 0.4, cacheWritePer1mTokens: 5, cacheWrite5mPer1mTokens: 5, outputPer1mTokens: 15 }
  ]
};

function fixture(protocol, model) {
  if (protocol === "messages") {
    const usage = { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 8,
      cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 0 }, output_tokens: 3 };
    const json = { id: "msg_billing", type: "message", role: "assistant", model,
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage };
    return { json, events: [
      { type: "message_start", message: { ...json, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" }, { type: "message_stop" }
    ] };
  }
  if (protocol === "responses") {
    const json = { id: "resp_billing", object: "response", model, status: "completed",
      output: [{ id: "msg_billing", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }] }],
      usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 8 }, output_tokens: 3, total_tokens: 23 } };
    return { json, events: [
      { type: "response.created", response: { id: json.id, model, status: "in_progress", output: [] } },
      { type: "response.output_text.delta", item_id: "msg_billing", output_index: 0, content_index: 0, delta: "ok" },
      { type: "response.completed", response: json },
      { type: "response.completed", response: json }
    ] };
  }
  const json = { id: "chatcmpl-billing", object: "chat.completion", model, created: 1,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 8 }, completion_tokens: 3, total_tokens: 23 } };
  return { json, events: [
    { id: json.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
    { id: json.id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: json.usage },
    "[DONE]", "[DONE]"
  ] };
}

test("all text directions settle JSON and SSE from upstream usage once without changing wire contracts", async () => {
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    const protocols = ["chat/completions", "responses", "messages"];
    let settledRequests = 0;
    for (const backend of protocols) {
      const id = `billing-${backend.split("/")[0]}`;
      config.models.push({ id, targetModel: `${id}-deployment`, upstream: "mock-foundry",
        pricingRef: backend === "messages" ? "claude-sonnet-4-6" : "gpt-5-mini",
        routes: { "*": backend }, pricing: structuredClone(policy) });
    }
    const save = (json) => ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json
    });

    const saved = await save(config);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual((await ctx.readConfigFile()).models.at(-1).pricing, policy);
    const invalid = structuredClone(config);
    invalid.models.at(-1).pricing.tiers[1].promptTokensAtLeast = 19;
    assert.equal((await save(invalid)).status, 400);
    assert.deepEqual((await ctx.readConfigFile()).models.at(-1).pricing, policy);

    for (const backend of protocols) {
      const id = `billing-${backend.split("/")[0]}`;
      const expected = (2 * 4 + 10 * 0.4 + 8 * 5 + 3 * 15) / 1e6;
      let count = 0;
      for (const client of protocols) {
        for (const stream of [false, true]) {
          const result = await ctx.publicRequest(`/v1/${client}`, {
            method: "POST",
            json: { model: id, stream, max_tokens: 10,
              ...(client === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }] }) }
          });
          assert.equal(result.status, 200, `${client} -> ${backend}: ${result.text}`);
          assert.match(result.text, /ok/);
          if (!stream) assert.equal(result.json.model, id);
          if (!stream && client === backend) {
            assert.deepEqual(result.json.usage, fixture(backend, `${id}-deployment`).json.usage,
              "Accounting must preserve native usage, including cache-write details");
          }
          count += 1;
          settledRequests += 1;
          const stats = (await ctx.adminRequest("/admin/api/stats")).json;
          const entry = stats.perModel[id];
          assert.equal(entry.promptTokens, 20 * count);
          assert.equal(entry.completionTokens, 3 * count);
          assert.equal(entry.totalTokens, 23 * count, "Cache writes must not inflate total usage");
          assert.ok(Math.abs(entry.estimatedCostAmount - expected * count) < 1e-12,
            `${client} -> ${backend} stream=${stream}: ${JSON.stringify(entry)}`);
          assert.equal(entry.textUnknownCostRequests || 0, 0);
          assert.equal(entry.billingTiers.length, 1);
          const tier = entry.billingTiers[0];
          assert.equal(tier.actualModelId, `${id}-deployment`);
          assert.equal(tier.tier.kind, "tier");
          assert.equal(tier.tier.id, "long");
          assert.equal(tier.tier.promptTokensAtLeast, 20);
          assert.equal(tier.tier.promptTokensBelow, null);
          assert.equal(tier.requests, count, "Duplicate stream terminals must not duplicate tier settlements");
          assert.equal(tier.promptTokens, entry.promptTokens);
          assert.equal(tier.cachedTokens, entry.cachedTokens);
          assert.equal(tier.completionTokens, entry.completionTokens);
          assert.ok(Math.abs(tier.estimatedCostAmount - entry.estimatedCostAmount) < 1e-12);
          for (const bucket of [entry, entry.actualModels[`${id}-deployment`]]) {
            assert.equal(bucket.cacheWrite.tokens, 8 * count);
            assert.equal(bucket.cacheWrite.observedTokens, 8 * count);
            assert.equal(bucket.cacheWrite.requests, count);
            assert.equal(bucket.cacheWrite.unknownUsageRequests, 0);
            assert.equal(bucket.cacheWrite.unknownCostRequests, 0);
            assert.equal(bucket.cacheWrite.costStatus, "priced");
            assert.ok(Math.abs(bucket.cacheWrite.estimatedCostAmount - 8 * 5 / 1e6 * count) < 1e-12);
          }
          assert.equal(stats.totals.cacheWrite.tokens, 8 * settledRequests);
          assert.equal(Object.values(stats.perKey).reduce((sum, bucket) => sum + bucket.cacheWrite.observedTokens, 0),
            8 * settledRequests);
          const upstream = ctx.upstreamRequests.at(-1);
          assert.ok(upstream.url.endsWith(`/${backend}`), upstream.url);
          assert.equal(upstream.body.model, `${id}-deployment`);
        }
      }
    }
    const before = (await ctx.adminRequest("/admin/api/stats")).json.perModel["billing-responses"];
    const interrupted = await ctx.publicRequest("/v1/responses", {
      method: "POST", json: { model: "billing-responses", input: "interrupt billing", stream: true }
    });
    assert.match(interrupted.text, /UPSTREAM_INCOMPLETE_STREAM|upstream responses stream ended/);
    const after = (await ctx.adminRequest("/admin/api/stats")).json.perModel["billing-responses"];
    assert.equal(after.estimatedCostAmount, before.estimatedCostAmount);
    assert.equal(after.textUnknownCostRequests, 1);
    assert.equal(after.billingTiers.find((row) => row.tier.kind === "unknown")?.requests, 1);
  }, {
    upstreamHandler({ req, res, body }) {
      if (!String(body?.model).startsWith("billing-")) return false;
      const protocol = req.url.endsWith("/messages") ? "messages" : req.url.endsWith("/responses") ? "responses" : "chat/completions";
      const { json, events } = fixture(protocol, body.model);
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      const selectedEvents = body.input === "interrupt billing" ? events.slice(0, 2) : events;
      res.end(body.stream
        ? selectedEvents.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
        : JSON.stringify(json));
      return true;
    }
  });
});

test("native JSON and SSE preserve unreported cache writes rather than charging them as zero", async () => {
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    const protocols = ["chat/completions", "responses"];
    for (const backend of protocols) {
      config.models.push({
        id: `billing-${backend.split("/")[0]}`, targetModel: `billing-${backend.split("/")[0]}-deployment`,
        upstream: "mock-foundry", pricingRef: "gpt-5-mini", routes: { "*": backend },
        pricing: {
          inputPer1mTokens: 4, cachedInputPer1mTokens: 0.4,
          cacheWritePer1mTokens: 5, outputPer1mTokens: 15
        }
      });
    }
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);
    for (const backend of protocols) {
      const id = `billing-${backend.split("/")[0]}`;
      let count = 0;
      let unreported = 0;
      let knownCost = 0;
      for (const missing of [false, true]) {
        for (const stream of [false, true]) {
          const content = missing ? "unreported writes" : "zero writes";
          const result = await ctx.publicRequest(`/v1/${backend}`, {
            method: "POST",
            json: { model: id, stream,
              ...(backend === "responses" ? { input: content } : { messages: [{ role: "user", content }] }) }
          });
          assert.equal(result.status, 200, result.text);
          count += 1;
          unreported += Number(missing);
          knownCost += (missing ? 10 * 0.4 + 3 * 15 : 10 * 4 + 10 * 0.4 + 3 * 15) / 1e6;
          const stats = (await ctx.adminRequest("/admin/api/stats")).json;
          const entry = stats.perModel[id];
          assert.equal(entry.totalTokens, 23 * count);
          assert.equal(entry.cachedTokens, 10 * count);
          assert.equal(entry.cacheWrite.requests, count);
          assert.equal(entry.cacheWrite.observedTokens, 0);
          assert.equal(entry.cacheWrite.tokens, missing ? null : 0);
          assert.equal(entry.cacheWrite.unknownUsageRequests, unreported);
          assert.equal(entry.cacheWrite.unknownCostRequests, unreported);
          assert.equal(entry.cacheWrite.estimatedCostAmount, missing ? null : 0);
          assert.equal(entry.textUnknownCostRequests, unreported);
          assert.equal(entry.billingTiers.length, 1);
          assert.equal(entry.billingTiers[0].tier.kind, "flat");
          assert.equal(entry.billingTiers[0].requests, count);
          assert.equal(entry.billingTiers[0].cacheWrite.tokens, entry.cacheWrite.tokens);
          assert.ok(Math.abs(entry.estimatedCostAmount - knownCost) < 1e-12);
          if (!stream) {
            const details = result.json.usage[backend === "responses" ? "input_tokens_details" : "prompt_tokens_details"];
            assert.equal(Object.hasOwn(details, "cache_write_tokens"), !missing);
          }
        }
      }
    }
  }, {
    upstreamHandler({ req, res, body }) {
      if (!String(body?.model).startsWith("billing-")) return false;
      const backend = req.url.endsWith("/responses") ? "responses" : "chat/completions";
      const { json, events } = fixture(backend, body.model);
      const details = json.usage[backend === "responses" ? "input_tokens_details" : "prompt_tokens_details"];
      if (JSON.stringify(body).includes("unreported writes")) delete details.cache_write_tokens;
      else details.cache_write_tokens = 0;
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(body.stream
        ? events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
        : JSON.stringify(json));
      return true;
    }
  });
});

test("tier statistics preserve GPT pricing boundaries and aggregate historical usage by tier ID", async () => {
  await withTestContext(async (ctx) => {
    const config = await ctx.readConfigFile();
    const boundaryPolicy = structuredClone(policy);
    boundaryPolicy.tiers[0].promptTokensBelow = 272001;
    boundaryPolicy.tiers[1].promptTokensAtLeast = 272001;
    config.models.push({
      id: "billing-boundary", targetModel: "billing-boundary-deployment",
      upstream: "mock-foundry", pricingRef: "gpt-5-mini",
      routes: { "*": "responses" }, pricing: boundaryPolicy
    });
    const save = async () => {
      const result = await ctx.adminRequest("/admin/api/config", {
        method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
      });
      assert.equal(result.status, 200, result.text);
    };
    const send = async (input, stream = false) => {
      const response = await ctx.publicRequest("/v1/responses", {
        method: "POST", json: { model: "billing-boundary", input: String(input), stream }
      });
      assert.equal(response.status, 200, response.text);
      return (await ctx.adminRequest("/admin/api/stats")).json.perModel["billing-boundary"];
    };
    const expectedCost = (input, rates) => (
      (input - 18) * rates.inputPer1mTokens + 10 * rates.cachedInputPer1mTokens
      + 8 * rates.cacheWritePer1mTokens + 3 * rates.outputPer1mTokens
    ) / 1e6;

    await save();
    const shortCost = expectedCost(272000, boundaryPolicy.tiers[0]);
    const oldLongCost = expectedCost(272001, boundaryPolicy.tiers[1]);
    await send(272000);
    const original = await send(272001, true);
    assert.equal(original.billingTiers.length, 2);
    assert.equal(original.billingTiers.find((row) => row.tier.promptTokensBelow === 272001).requests, 1);
    assert.equal(original.billingTiers.find((row) => row.tier.promptTokensAtLeast === 272001).requests, 1);

    boundaryPolicy.tiers[1].inputPer1mTokens = 8;
    await save();
    const newLongCost = expectedCost(272001, boundaryPolicy.tiers[1]);
    const repriced = await send(272001);
    assert.equal(repriced.billingTiers.length, 2, "Rate changes do not create duplicate interval rows");
    const long = repriced.billingTiers.find((row) => row.tier.promptTokensAtLeast === 272001);
    assert.equal(long.requests, 2);
    assert.ok(Math.abs(long.estimatedCostAmount - oldLongCost - newLongCost) < 1e-12);

    boundaryPolicy.tiers[0].promptTokensBelow = 100001;
    boundaryPolicy.tiers[1].promptTokensAtLeast = 100001;
    await save();
    const changed = await send(100001, true);
    assert.equal(changed.billingTiers.length, 2, "Same captured ID remains one category after threshold changes");
    const longHistory = changed.billingTiers.find((row) => row.tier.id === "long");
    assert.equal(longHistory.requests, 3);
    assert.deepEqual(longHistory.tier.intervals, [
      { promptTokensAtLeast: 100001, promptTokensBelow: null },
      { promptTokensAtLeast: 272001, promptTokensBelow: null }
    ]);
    assert.equal(changed.billingTiers.reduce((sum, row) => sum + row.requests, 0), 4);
    assert.equal(changed.billingTiers.reduce((sum, row) => sum + row.promptTokens, 0), changed.promptTokens);
    const expected = shortCost + oldLongCost + newLongCost + expectedCost(100001, boundaryPolicy.tiers[1]);
    assert.ok(Math.abs(changed.estimatedCostAmount - expected) < 1e-12);
    assert.ok(Math.abs(changed.billingTiers.reduce((sum, row) => sum + row.estimatedCostAmount, 0) - expected) < 1e-12);
  }, {
    upstreamHandler({ req, res, body }) {
      if (body?.model !== "billing-boundary-deployment") return false;
      const { json, events } = fixture("responses", body.model);
      json.usage.input_tokens = Number(body.input);
      json.usage.total_tokens = json.usage.input_tokens + json.usage.output_tokens;
      assert.ok(req.url.endsWith("/responses"));
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(body.stream
        ? events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
        : JSON.stringify(json));
      return true;
    }
  });
});
