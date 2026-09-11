import assert from "node:assert/strict";
import test from "node:test";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { withTestContext } from "./lib/harness.js";

test("MAI image edits preserve multipart bytes and route legacy model bindings", async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
  let received;
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { ...config.media, http: { enabled: true } };
    for (const pricingRef of ["mai-image-2.6", "mai-image-2.6-flash"]) {
      const definition = listPricingDefinitions().find(entry => entry.id === pricingRef);
      for (const legacy of [false, true]) config.models.push({ ...definition.proxyTemplate, id: `${pricingRef}-${legacy}`,
        targetModel: "my-image-deployment", upstream: config.upstreams[0].name,
        ...(legacy ? { routes: { "*": "openai-image" } } : {}) });
    }
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    for (const model of config.models.filter(entry => entry.id.startsWith("mai-image-"))) {
      const form = new FormData();
      form.append("image", new Blob([image], { type: "image/png" }), "source.png");
      form.append("model", model.id);
      form.append("prompt", "Edit the label");
      form.append("auto_aspect_ratio", "true");
      form.append("web_grounding", "true");
      ctx.clearUpstreamRequests();
      const response = await ctx.publicRequest("/v1/images/edits", { method: "POST", body: form });
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.json, { data: [{ b64_json: "UE5H" }] });
      assert.equal(ctx.upstreamRequests.length, 1);
      assert.equal(ctx.getUpstreamRequest().url, "/mai/v1/images/edits");
      assert.equal(ctx.getUpstreamRequest().headers["api-key"], "test-upstream-key");
      assert.equal(received.get("model"), "my-image-deployment");
      assert.equal(received.get("auto_aspect_ratio"), "true");
      assert.equal(received.get("web_grounding"), "true");
      const file = received.get("image");
      assert.equal(file.name, "source.png");
      assert.equal(file.type, "image/png");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), image);
    }
  }, { upstreamHandler: async ({ req, res, rawBody }) => {
    if (req.url !== "/mai/v1/images/edits") return false;
    received = await new Response(rawBody, { headers: { "content-type": req.headers["content-type"] } }).formData();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: "UE5H" }] }));
    return true;
  } });
});

test("MAI native Image and Thinking wire contracts", async context => {
  let scenario = "json";
  let upstreamPayload;
  const encrypted = "opaque reasoning contract probe!";
  const assistant = {
    role: "assistant", content: null, refusal: null,
    reasoning: { encrypted_content: encrypted, content: null, summary: null },
    tool_calls: [{ id: "call-mai", type: "function", function: { name: "lookup", arguments: '{"city":"Seattle"}' } }]
  };
  const usage = { prompt_tokens: 19, completion_tokens: 76, total_tokens: 95, prompt_tokens_details: { cached_tokens: 0 } };
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const upstream = config.upstreams[0];
    upstream.errorPolicy = { nativePassthrough: true };
    config.observability.logs = { ...config.observability.logs, messageContentMode: "full", bufferSize: 500 };
    for (const pricingRef of ["mai-image-2.6", "mai-image-2.6-flash", "mai-thinking-1"]) {
      const definition = listPricingDefinitions().find(entry => entry.id === pricingRef);
      config.models.push({ ...definition.proxyTemplate, id: `public-${pricingRef}`, targetModel: `deployment-${pricingRef}`, upstream: upstream.name });
    }
    const saved = await ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
    });
    assert.equal(saved.status, 200, saved.text);

    const assertRequest = (path, body) => {
      assert.equal(ctx.upstreamRequests.length, 1);
      const request = ctx.getUpstreamRequest();
      assert.equal(request.method, "POST");
      assert.equal(request.url, path);
      assert.deepEqual(request.body, body);
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["api-key"], "test-upstream-key");
      for (const name of ["authorization", "x-api-key", "ocp-apim-subscription-key"]) assert.equal(request.headers[name], undefined);
    };
    for (const pricingRef of ["mai-image-2.6", "mai-image-2.6-flash"]) {
      await context.test(`${pricingRef} generation JSON`, async () => {
        ctx.clearUpstreamRequests();
        const body = { model: `public-${pricingRef}`, prompt: "A poster", size: "1024x1024", web_grounding: true, auto_aspect_ratio: false, extension: { preserve: true } };
        const response = await ctx.publicRequest("/v1/images/generations", { method: "POST", json: body });
        assert.equal(response.status, 200, response.text);
        assert.deepEqual(response.json, JSON.parse(upstreamPayload));
        const { size, ...expected } = body;
        assertRequest("/mai/v1/images/generations", { ...expected, model: `deployment-${pricingRef}`, width: 1024, height: 1024 });
      });
    }

    const body = {
      model: "public-mai-thinking-1", max_completion_tokens: 128, reasoning_display: "encrypted",
      messages: [{ role: "system", content: "Follow instructions" }, { role: "user", content: "Check the weather" }, assistant,
        { role: "tool", tool_call_id: "call-mai", content: "Sunny" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } } } } }]
    };
    for (const mode of ["json", "sse", "safety", "http-error", "truncated"]) {
      await context.test(`Thinking ${mode}`, async () => {
        scenario = mode;
        ctx.clearUpstreamRequests();
        const requestBody = { ...body, stream: !["json", "http-error"].includes(mode) };
        const response = await ctx.publicRequest("/v1/chat/completions", { method: "POST", json: requestBody });
        assert.equal(response.status, mode === "http-error" ? 400 : 200, response.text);
        assertRequest("/mai/v1/chat/completions", { ...requestBody, model: "deployment-mai-thinking-1" });
        const publicFrames = upstreamPayload.split("\n").map(line => {
          if (!line.startsWith("data: {")) return line;
          const event = JSON.parse(line.slice(6));
          if (event.model) event.model = body.model;
          return `data: ${JSON.stringify(event)}`;
        }).join("\n");
        if (mode === "json") {
          assert.deepEqual(response.json, { ...JSON.parse(upstreamPayload), model: body.model });
          assert.deepEqual(response.json.choices[0].message, assistant);
          assert.deepEqual(response.json.usage, usage);
        } else if (mode === "http-error") {
          assert.deepEqual(response.json, JSON.parse(upstreamPayload));
        } else if (mode === "truncated") {
          assert.ok(response.text.startsWith(publicFrames));
          assert.match(response.text, /error/);
        } else {
          assert.equal(response.text, publicFrames);
        }
      });
    }
    const logs = await ctx.adminRequest("/admin/api/logs?limit=500");
    assert.equal(logs.status, 200);
    assert.ok(!logs.text.includes(encrypted), "Full logging must never retain encrypted reasoning");
  }, {
    upstreamHandler: ({ req, res, body }) => {
      if (!req.url.startsWith("/mai/")) return false;
      if (req.url === "/mai/v1/images/generations") {
        upstreamPayload = JSON.stringify({ created: 1789110000, data: [{ b64_json: "UE5H", revised_prompt: "A poster" }] });
      } else if (scenario === "http-error") {
        upstreamPayload = JSON.stringify({ error: { type: "SafetyBlockedError", message: "Blocked by upstream" }, provider_field: "preserved" });
      } else if (body.stream) {
        const chunk = { id: "mai-api-test", object: "chat.completion.chunk", model: body.model,
          choices: [{ index: 0, delta: { content: "Visible answer" }, finish_reason: null }], usage: null };
        upstreamPayload = `: provider comment\n\ndata: ${JSON.stringify(chunk)}\n\n`;
        if (scenario === "safety") {
          upstreamPayload += `event: error\ndata: ${JSON.stringify({ error: { type: "SafetyBlockedError", message: "Blocked" } })}\n\ndata: [DONE]\n\n`;
        } else if (scenario !== "truncated") {
          upstreamPayload += `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: assistant, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(upstreamPayload);
        return true;
      } else {
        upstreamPayload = JSON.stringify({ id: "mai-api-test", object: "chat.completion", created: 1789110000, model: body.model,
          choices: [{ index: 0, message: assistant, finish_reason: "stop" }], usage });
      }
      res.writeHead(scenario === "http-error" ? 400 : 200, { "content-type": "application/json" });
      res.end(upstreamPayload);
      return true;
    }
  });
});