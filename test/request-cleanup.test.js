import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRequestBody } from "../src/proxy/body.js";
import { withTestContext } from "./lib/harness.js";

const schema = { type: "object", properties: { value: { enum: [null, "undefined", "[undefined]", "value"], default: null } } };

test("placeholder cleanup still removes invalid optional controls without modifying semantic data", () => {
  const body = {
    temperature: "undefined", top_p: "[undefined]", seed: undefined,
    reasoning: { effort: "undefined", summary: "[undefined]" },
    messages: [
      { role: "user", content: "undefined" },
      { role: "assistant", content: null, tool_calls: [{ id: "call", type: "function", function: { name: "undefined", arguments: "[undefined]" } }] },
      { role: "tool", tool_call_id: "call", content: "[undefined]" },
      { role: "assistant", content: [{ type: "tool_use", id: "call2", name: "fn", input: { value: null, option: "undefined" } }] }
    ],
    tools: [{ type: "function", function: { name: "fn", description: "undefined", parameters: schema, strict: "undefined" } }],
    response_format: { type: "json_schema", json_schema: { name: "fn", schema } }
  };
  const before = structuredClone(body);
  const result = sanitizeRequestBody(body);
  assert.equal(result.temperature, undefined);
  assert.equal(result.top_p, undefined);
  assert.deepEqual(result.reasoning, {});
  assert.equal(result.tools[0].function.strict, undefined);
  assert.deepEqual(result.messages, body.messages);
  assert.deepEqual(result.tools[0].function.parameters, schema);
  assert.equal(result.tools[0].function.description, "undefined");
  assert.deepEqual(result.response_format.json_schema.schema, schema);
  assert.deepEqual(body, before);
});

test("optional null controls retain legacy cleanup while Responses explicit nulls remain supported", () => {
  const controls = { system: null, instructions: null, prompt: null, temperature: null, reasoning: { effort: null } };
  assert.deepEqual(sanitizeRequestBody(controls), { reasoning: {} });
  assert.deepEqual(sanitizeRequestBody(controls, { preserveNull: true }), controls);
});

test("native JSON/SSE keeps client placeholder adaptation while preserving text and schemas", async t => {
  await withTestContext(async ctx => {
    for (const [route, model, data] of [
      ["chat/completions", "gpt-5-mini", {
        messages: [{ role: "user", content: "undefined" }],
        tools: [{ type: "function", function: { name: "fn", description: "test", parameters: schema } }]
      }],
      ["responses", "gpt-5.6-luna", {
        input: "undefined", instructions: "[undefined]",
        tools: [{ type: "function", name: "fn", description: "test", parameters: schema }]
      }],
      ["messages", "claude-native", {
        max_tokens: 32, system: "undefined", messages: [{ role: "user", content: [{ type: "text", text: "[undefined]" }] }],
        tools: [{ name: "fn", description: "test", input_schema: schema }]
      }]
    ]) {
      for (const stream of [false, true]) await t.test(`${route} native ${stream ? "SSE" : "JSON"}`, async () => {
        ctx.clearUpstreamRequests();
        const result = await ctx.publicRequest(`/v1/${route}`, {
          method: "POST", json: { model, ...data, temperature: "undefined", top_p: "[undefined]", stream }
        });
        assert.equal(result.status, 200, result.text);
        assert.equal(ctx.upstreamRequests.length, 1);
        const sent = ctx.getUpstreamRequest().body;
        assert.equal(sent.temperature, undefined);
        assert.equal(sent.top_p, undefined);
        for (const [key, value] of Object.entries(data)) assert.deepEqual(sent[key], value, `Preserve native ${key}`);
      });
    }
    const config = (await ctx.adminRequest("/admin/api/config")).json;
    config.proxy.guards.sanitizeMeaninglessValues = false;
    assert.equal((await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    })).status, 200);
    ctx.clearUpstreamRequests();
    const rejected = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST", json: { model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }], temperature: "undefined" }
    });
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(ctx.upstreamRequests.length, 1, "This is an actual upstream parameter error, not proxy preflight");
    assert.equal(ctx.getUpstreamRequest().body.temperature, "undefined");
    assert.match(rejected.text, /temperature must be numeric/);
  }, { upstreamHandler({ body, res }) {
    if (typeof body.temperature === "string" || typeof body.top_p === "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "InvalidParameter", message: "temperature must be numeric" } }));
      return true;
    }
    return false;
  } });
});
