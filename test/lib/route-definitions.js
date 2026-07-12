import assert from "node:assert/strict";
import { ensure } from "./harness.js";

export const routeTests = [
  {
    id: "chat-completion",
    description: "chat/completions route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          messages: [
            {
              role: "user",
              content: "hello"
            }
          ]
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "chat.completion");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions"));
      ensure(upstreamRequest, "Expected upstream chat completion request");
      assert.equal(upstreamRequest.body?.model, "gpt-5-mini");
    }
  },
  {
    id: "response",
    description: "responses route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          input: "hello"
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "response");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected upstream responses request");
      assert.equal(upstreamRequest.body?.model, "gpt-5-mini");
    }
  },
  {
    id: "gpt-5.6-chat-stream",
    description: "GPT-5.6 Chat stream through Responses upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "use the lookup tool" }],
          tools: [{
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"]
              }
            }
          }],
          reasoning_effort: "max",
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.headers.get("content-type") || "", /^text\/event-stream/);
      assert.match(result.text, /ok from mock responses stream/);
      assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected GPT-5.6 request to use the Responses upstream");
      assert.equal(upstreamRequest.body?.model, "gpt-5.6-luna");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.deepEqual(upstreamRequest.body?.reasoning, { effort: "max" });
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
      assert.equal("messages" in upstreamRequest.body, false);
      assert.equal("reasoning_effort" in upstreamRequest.body, false);
    }
  },
  {
    id: "gpt-5.6-responses-stream",
    description: "native GPT-5.6 Responses stream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "stream a short response",
          tools: [{
            type: "function",
            name: "lookup",
            description: "Look up a value",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"]
            }
          }],
          reasoning: { effort: "max" },
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.headers.get("content-type") || "", /^text\/event-stream/);
      assert.match(result.text, /"type":"response.output_text.delta"/);
      assert.match(result.text, /"type":"response.completed"/);
      assert.doesNotMatch(result.text, /"object":"chat.completion.chunk"/);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected native GPT-5.6 Responses upstream request");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.deepEqual(upstreamRequest.body?.reasoning, { effort: "max" });
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
    }
  },
  {
    id: "openai-image",
    description: "openai-image route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/images/generations", {
        method: "POST",
        json: {
          model: "gpt-image-1.5",
          prompt: "draw a cat",
          size: "1024x1024",
          quality: "hd",
          response_format: "b64_json"
        }
      });

      assert.equal(result.status, 200, result.text);
      ensure(Array.isArray(result.json?.data), "Expected generated image data array");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/deployments/gpt-image-1.5/images/generations"));
      ensure(upstreamRequest, "Expected deployment image generation upstream request");
      assert.equal(upstreamRequest.body?.quality, "high");
      assert.equal("model" in upstreamRequest.body, false);
      assert.equal("response_format" in upstreamRequest.body, false);
    }
  },
  {
    id: "blackforest-image",
    description: "blackforest-image route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/images/generations", {
        method: "POST",
        json: {
          model: "flux-2-pro",
          prompt: "draw a forest",
          size: "1024x1024",
          response_format: "url",
          background: "transparent"
        }
      });

      assert.equal(result.status, 200, result.text);
      ensure(Array.isArray(result.json?.data), "Expected generated image data array");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/providers/blackforestlabs/v1/flux-2-pro"));
      ensure(upstreamRequest, "Expected Black Forest Labs upstream request");
      assert.equal(upstreamRequest.body?.width, 1024);
      assert.equal(upstreamRequest.body?.height, 1024);
      assert.equal("size" in upstreamRequest.body, false);
      assert.equal("background" in upstreamRequest.body, false);
    }
  }
];

export function getRouteTest(id) {
  return routeTests.find((item) => item.id === id) || null;
}