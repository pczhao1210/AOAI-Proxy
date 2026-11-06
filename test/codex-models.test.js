import assert from "node:assert/strict";
import test from "node:test";
import { getCodexModelMetadata } from "../src/codex-models.js";
import { compileModelCatalog, resolveModelDescriptor } from "../src/model-catalog.js";

test("Codex shared serializer freezes the complete legacy fallback wire object", () => {
  const model = { id: "plain" };
  const result = getCodexModelMetadata(model, 2, null);
  assert.deepEqual(result.info, {
    slug: "plain", display_name: "plain", description: "plain via AOAI Proxy",
    default_reasoning_level: "medium", supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balanced speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth for complex problems" }
    ],
    shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 2,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
    base_instructions: "You are a coding agent working in the user's current workspace. Follow the user's instructions, use the available tools when needed, and complete coding tasks accurately. Respect repository instructions and preserve unrelated user changes.",
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    default_reasoning_summary: "none", support_verbosity: false, default_verbosity: null,
    apply_patch_tool_type: null, web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 }, supports_parallel_tool_calls: false,
    supports_image_detail_original: false, context_window: 128000, max_context_window: 128000,
    effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ["text"],
    supports_search_tool: false, use_responses_lite: false
  });
  assert.equal(result.sources.context_window, "fallback");
  assert.equal(result.sources.priority, "filtered-catalog-order");
  assert.equal(result.sources.supported_reasoning_levels, "fallback");
  assert.deepEqual(model, { id: "plain" });
});

test("Codex metadata uses the supplied draft descriptor and preserves override precedence", () => {
  const model = { id: "public", pricingRef: "card", contextWindow: 640000, codex: {
    contextWindow: 320000, supportedReasoningEfforts: [" LOW ", "high", "high"], defaultReasoningEffort: "high",
    priority: 0, baseInstructions: " custom instructions ", description: "custom description", hidden: true
  } };
  const definition = {
    id: "card", interfaces: ["responses"], contextWindow: 1000000,
    capabilities: ["reasoning", "vision", "parallel-tool-calling", "code-optimized", "web-search"],
    inputModalities: ["text", "image"],
    protocolProfiles: { responses: { reasoning: { parameter: "reasoning.effort", levels: ["medium", "high"], default: "medium" } } }
  };
  const snapshot = compileModelCatalog({ models: [model] }, [definition]);
  const descriptor = resolveModelDescriptor(model, snapshot);
  const before = structuredClone(model);
  const overridden = getCodexModelMetadata(model, 8, descriptor);
  assert.deepEqual(overridden.info.supported_reasoning_levels.map(level => level.effort), ["low", "high"]);
  assert.equal(overridden.info.default_reasoning_level, "high");
  assert.equal(overridden.info.context_window, 320000);
  assert.equal(overridden.info.priority, 0);
  assert.equal(overridden.info.base_instructions, "custom instructions");
  assert.equal(overridden.info.description, "custom description");
  assert.equal(overridden.info.supports_parallel_tool_calls, true);
  assert.equal(overridden.info.apply_patch_tool_type, "freeform");
  assert.equal(overridden.info.web_search_tool_type, "text_and_image");
  assert.deepEqual(model, before);
  const inherited = { ...model, codex: {} };
  const modelLimit = getCodexModelMetadata(inherited, 0, descriptor);
  assert.equal(modelLimit.info.context_window, 640000);
  assert.equal(modelLimit.sources.context_window, "models[].contextWindow");
  delete inherited.contextWindow;
  const catalog = getCodexModelMetadata(inherited, 0, descriptor);
  assert.equal(catalog.info.context_window, 1000000);
  assert.equal(catalog.sources.context_window, "catalog.contextWindow");
  assert.deepEqual(catalog.info.supported_reasoning_levels.map(level => level.effort), ["medium", "high"]);
  assert.equal(catalog.info.default_reasoning_level, "medium");
  const alternate = compileModelCatalog({ models: [inherited] }, [{ ...definition, contextWindow: 2000000 }]);
  assert.equal(getCodexModelMetadata(inherited, 0, resolveModelDescriptor(inherited, alternate)).info.context_window, 2000000);
  assert.equal(getCodexModelMetadata(inherited, 0, descriptor).info.context_window, 1000000);
});

test("Codex incomplete and mismatched overrides retain existing fallback behavior", () => {
  const metadata = getCodexModelMetadata({
    id: "legacy", capabilities: ["reasoning"], codex: {
      supportedReasoningEfforts: ["high", "future"], defaultReasoningEffort: "unsupported",
      contextWindow: 0, baseInstructions: " ", priority: 1.5
    }
  }, 3, null);
  assert.equal(metadata.info.context_window, 128000);
  assert.equal(metadata.info.default_reasoning_level, "high");
  assert.equal(metadata.sources.default_reasoning_level, "fallback");
  assert.equal(metadata.info.priority, 3);
  assert.deepEqual(metadata.info.supported_reasoning_levels.map(level => level.effort), ["high", "future"]);
});
