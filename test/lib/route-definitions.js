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