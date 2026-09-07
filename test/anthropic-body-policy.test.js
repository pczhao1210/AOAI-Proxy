import assert from "node:assert/strict";
import test from "node:test";
import { applyAnthropicBodyCompatibility } from "../src/proxy/anthropic-policy.js";

const descriptor = {
  protocolProfiles: { messages: {
    thinking: { types: ["adaptive"], validation: "passthrough" },
    reasoning: { levels: ["high"], aliases: { medium: "high" }, validation: "passthrough" }
  } }
};

test("catalog suggestions preserve upstream authority over unknown thinking and effort", () => {
  const body = { thinking: { type: "future-thinking", budget_tokens: 1000 }, output_config: { effort: " FUTURE-EFFORT " } };
  const originalDescriptor = structuredClone(descriptor);
  assert.equal(applyAnthropicBodyCompatibility(body, {}, "public-model", {}, descriptor), null);
  assert.deepEqual(body, { thinking: { type: "future-thinking", budget_tokens: 1000 }, output_config: { effort: "future-effort" } });
  assert.deepEqual(descriptor, originalDescriptor);
});

test("explicit thinking overrides use public model then deployment then model id then pricing reference", () => {
  const model = { targetModel: "deployment", id: "route-id", pricingRef: "catalog-id" };
  for (const key of ["public-model", "deployment", "route-id", "catalog-id"]) {
    const config = { compatibility: { anthropic: { thinkingTypesByModel: { [key]: ["enabled"] } } } };
    const body = { thinking: { type: "adaptive" } };
    const original = structuredClone({ config, model, body });
    assert.deepEqual(applyAnthropicBodyCompatibility(body, config, " PUBLIC-MODEL ", model, descriptor), {
      param: "thinking.type", message: "thinking.type=adaptive is not supported by  PUBLIC-MODEL ; use enabled"
    });
    assert.deepEqual({ config, model, body }, original);
  }
  const config = { compatibility: { anthropic: { thinkingTypesByModel: { "public-model": ["adaptive"], deployment: ["enabled"] } } } };
  assert.equal(applyAnthropicBodyCompatibility({ thinking: { type: "adaptive" } }, config, "public-model", model, descriptor), null);
});

test("effort aliases normalize before explicit administrator validation", () => {
  const config = { compatibility: { anthropic: { effortLevelsByModel: { "public-model": ["high"] } } } };
  const body = { output_config: { effort: " MEDIUM ", extension: 1 } };
  assert.equal(applyAnthropicBodyCompatibility(body, config, "public-model", {}, descriptor), null);
  assert.deepEqual(body.output_config, { effort: "high", extension: 1 });
  assert.deepEqual(applyAnthropicBodyCompatibility({ output_config: { effort: "low" } }, config, "public-model", {}, descriptor), {
    param: "output_config.effort", message: "output_config.effort=low is not supported by public-model; use high"
  });
});

test("disabled compatibility switches preserve their corresponding native fields", () => {
  const body = {
    thinking: { type: "enabled" }, output_config: { effort: " MEDIUM " },
    tool_choice: { type: "tool", name: "lookup" },
    cache_control: { type: "future", ttl: "2h", extension: true }
  };
  const original = structuredClone(body);
  const config = { compatibility: { anthropic: {
    validateThinkingByModel: false, normalizeManualThinkingToolChoice: false, sanitizeCacheControl: false,
    thinkingTypesByModel: { "public-model": ["adaptive"] }, effortLevelsByModel: { "public-model": ["high"] }
  } } };
  assert.equal(applyAnthropicBodyCompatibility(body, config, "public-model", {}, descriptor), null);
  assert.deepEqual(body, original);
});

test("manual thinking tool choice normalization keeps other settings and does not affect adaptive thinking", () => {
  for (const type of ["any", "tool"]) {
    const body = { thinking: { type: "enabled" }, tool_choice: { type, name: "lookup", disable_parallel_tool_use: true } };
    assert.equal(applyAnthropicBodyCompatibility(body, {}, "public-model", {}, descriptor), null);
    assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
  }
  const body = { thinking: { type: "adaptive" }, tool_choice: { type: "tool", name: "lookup" } };
  const original = structuredClone(body);
  assert.equal(applyAnthropicBodyCompatibility(body, {}, "public-model", {}, descriptor), null);
  assert.deepEqual(body, original);
});

test("cache policy keeps supported locations and TTLs while preserving signed thinking state", () => {
  const cache = { type: "ephemeral", ttl: "5m", extension: "removed" };
  const body = {
    cache_control: structuredClone(cache),
    tools: [{ name: "lookup", input_schema: { cache_control: structuredClone(cache) }, cache_control: { type: "ephemeral", ttl: "1h" } }],
    system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "assistant", content: [
      { type: "text", text: "answer", cache_control: structuredClone(cache) },
      { type: "thinking", thinking: "native reasoning", signature: "signed-value", cache_control: structuredClone(cache) },
      { type: "redacted_thinking", data: "redacted-state", cache_control: structuredClone(cache) },
      { type: "tool_use", id: "tool-id", name: "lookup", input: { cache_control: structuredClone(cache) }, cache_control: structuredClone(cache) }
    ] }]
  };
  assert.equal(applyAnthropicBodyCompatibility(body, {}, "public-model", {}, descriptor), null);
  assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: "5m" });
  assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.tools[0].input_schema, {});
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  const content = body.messages[0].content;
  assert.deepEqual(content[0].cache_control, { type: "ephemeral", ttl: "5m" });
  assert.deepEqual(content[1], { type: "thinking", thinking: "native reasoning", signature: "signed-value" });
  assert.deepEqual(content[2], { type: "redacted_thinking", data: "redacted-state" });
  assert.deepEqual(content[3], { type: "tool_use", id: "tool-id", name: "lookup", input: {}, cache_control: { type: "ephemeral", ttl: "5m" } });
});

test("cache sanitization rejects only the existing malformed cache metadata and empty text cases", () => {
  for (const cache_control of [null, [], "ephemeral", { type: "other" }, { type: "ephemeral", ttl: "2h" }]) {
    const body = { system: [{ type: "text", text: "kept", cache_control }] };
    assert.equal(applyAnthropicBodyCompatibility(body, {}, "public-model", {}, descriptor), null);
    assert.deepEqual(body, { system: [{ type: "text", text: "kept" }] });
  }
  const emptyText = { system: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }] };
  assert.equal(applyAnthropicBodyCompatibility(emptyText, {}, "public-model", {}, descriptor), null);
  assert.deepEqual(emptyText, { system: [{ type: "text", text: "" }] });
  assert.equal(applyAnthropicBodyCompatibility(null, {}, "public-model", {}, descriptor), null);
});