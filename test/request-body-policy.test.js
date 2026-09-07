import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRouteProfileKey,
  applyConfiguredRequestPolicy,
  sanitizeToolControlsWithoutTools,
  validateImageGenerationPolicy
} from "../src/proxy/request-policy.js";

test("request policy preserves route aliases and leaves native utility keys alone", () => {
  for (const [routeKey, profile] of [
    ["chat/completions", "chatCompletions"], ["images/generations", "imageGenerations"],
    ["responses", "responses"], ["messages", "messages"],
    ["messages/count_tokens", "messages/count_tokens"], ["responses/compact", "responses/compact"]
  ]) assert.equal(normalizeRouteProfileKey(routeKey), profile);
});

test("empty request allowlists are unrestricted and public model mapping is not filtered", () => {
  const body = { model: "mapped-model", extension: { native: true }, temperature: 0 };
  const original = structuredClone(body);
  assert.equal(applyConfiguredRequestPolicy(body, {
    config: { routing: { routeProfiles: { responses: { allowedRequestFields: [] } } } },
    routeKey: "responses", model: { requestPolicy: { allowedParams: [], blockedParams: ["model"] } },
    upstream: { requestPolicy: { allowedParams: [] } }
  }), null);
  assert.deepEqual(body, original);
});

test("explicit request allowlists intersect and blocklists win without mutating rejected bodies", () => {
  const options = {
    routeKey: "chat/completions",
    config: { routing: { routeProfiles: { chatCompletions: { allowedRequestFields: [" messages ", "stream", "temperature", 12, ""] } } } },
    model: { requestPolicy: { allowedParams: ["messages", "stream", "temperature"], blockedParams: ["stream"] } },
    upstream: { requestPolicy: { allowedParams: ["messages", "stream"], blockedParams: ["seed"] } }
  };
  const body = { model: "mapped", messages: [], stream: true, temperature: 0.4, seed: 2, extension: true };
  const originalBody = structuredClone(body);
  const originalOptions = structuredClone(options);
  assert.deepEqual(applyConfiguredRequestPolicy(body, options), {
    param: "stream", fields: ["stream", "temperature", "seed", "extension"],
    message: "Unsupported request fields: stream, temperature, seed, extension"
  });
  assert.deepEqual(body, originalBody);
  assert.deepEqual(options, originalOptions);
});

test("each explicit drop policy removes only unsupported top-level fields", () => {
  for (const scope of ["model", "upstream", "global"]) {
    const options = { config: {}, routeKey: "messages", model: { requestPolicy: { blockedParams: ["blocked"] } }, upstream: {} };
    if (scope === "global") options.config.proxy = { guards: { dropUnsupportedOpenAiParams: true } };
    else options[scope].requestPolicy = { ...options[scope].requestPolicy, dropUnsupportedParams: true };
    const body = { model: "mapped", blocked: 1, content: { blocked: "nested-native-value" } };
    const originalOptions = structuredClone(options);
    assert.equal(applyConfiguredRequestPolicy(body, options), null);
    assert.deepEqual(body, { model: "mapped", content: { blocked: "nested-native-value" } });
    assert.deepEqual(options, originalOptions);
  }
});

test("tool controls remain with modern or legacy tools and are removed only when both are absent", () => {
  for (const tools of [{ tools: [{ type: "function" }] }, { functions: [{ name: "lookup" }] }]) {
    const body = { ...tools, tool_choice: "auto", function_call: "auto", parallel_tool_calls: false };
    const original = structuredClone(body);
    sanitizeToolControlsWithoutTools(body);
    assert.deepEqual(body, original);
  }
  const body = { model: "mapped", tools: [], functions: [], tool_choice: "auto", function_call: "auto", parallel_tool_calls: false };
  sanitizeToolControlsWithoutTools(body);
  assert.deepEqual(body, { model: "mapped", tools: [], functions: [] });
  assert.doesNotThrow(() => sanitizeToolControlsWithoutTools(null));
});

test("image generation uses existing count defaults and explicit administrator size and quality limits", () => {
  assert.equal(validateImageGenerationPolicy({}, {}), null);
  assert.equal(validateImageGenerationPolicy({ n: "4" }, {}), null);
  assert.deepEqual(validateImageGenerationPolicy({ n: 5 }, {}), { param: "n", message: "n must be an integer between 1 and 4" });
  const config = { media: { generation: { maxImages: 2, allowedSizes: [" 1024x1024 "], allowedQualityModes: ["high"] } } };
  const original = structuredClone(config);
  for (const count of [0, -1, 1.5, 3, "invalid"]) {
    assert.deepEqual(validateImageGenerationPolicy({ n: count }, config), { param: "n", message: "n must be an integer between 1 and 2" });
  }
  assert.equal(validateImageGenerationPolicy({ n: 2, size: "1024x1024", quality: "high" }, config), null);
  assert.equal(validateImageGenerationPolicy({ n: 1 }, config), null);
  assert.deepEqual(validateImageGenerationPolicy({ size: "256x256" }, config), { param: "size", message: "size must be one of: 1024x1024" });
  assert.deepEqual(validateImageGenerationPolicy({ quality: "low" }, config), { param: "quality", message: "quality must be one of: high" });
  assert.deepEqual(config, original);
});