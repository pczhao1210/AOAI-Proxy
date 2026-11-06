import { getDescriptorProtocolProfile } from "./model-catalog.js";

const REASONING_DESCRIPTIONS = {
  none: "No reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balanced speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems"
};

const DEFAULT_BASE_INSTRUCTIONS = [
  "You are a coding agent working in the user's current workspace.",
  "Follow the user's instructions, use the available tools when needed, and complete coding tasks accurately.",
  "Respect repository instructions and preserve unrelated user changes."
].join(" ");

function normalizeReasoningLevels(values) {
  return Array.isArray(values)
    ? [...new Set(values.map(value => String(value || "").trim().toLowerCase()).filter(Boolean))]
    : [];
}

export function getCodexModelMetadata(model, index, descriptor) {
  const rawCapabilities = descriptor?.capabilities?.length ? descriptor.capabilities : model?.capabilities;
  const capabilities = new Set((Array.isArray(rawCapabilities) ? rawCapabilities : [])
    .filter(value => typeof value === "string")
    .map(value => value.trim().toLowerCase().replaceAll("_", "-")).filter(Boolean));
  const configuredLevels = normalizeReasoningLevels(model?.codex?.supportedReasoningEfforts);
  const protocolProfile = getDescriptorProtocolProfile(descriptor, "responses");
  const profileKey = Object.entries(descriptor?.protocolProfiles || {}).find(([, profile]) => profile === protocolProfile)?.[0];
  const reasoningSource = profileKey ? `catalog.protocolProfiles.${profileKey}.reasoning` : null;
  const catalogReasoning = protocolProfile?.reasoning;
  const catalogLevels = normalizeReasoningLevels(catalogReasoning?.levels);
  const levels = configuredLevels.length ? configuredLevels : catalogLevels.length ? catalogLevels
    : capabilities.has("reasoning") ? ["low", "medium", "high"] : [];
  const levelSource = configuredLevels.length ? "models[].codex.supportedReasoningEfforts"
    : catalogLevels.length && reasoningSource ? `${reasoningSource}.levels` : "fallback";
  const defaultCandidates = [
    [String(model?.codex?.defaultReasoningEffort || "").trim().toLowerCase(), "models[].codex.defaultReasoningEffort"],
    [String(catalogReasoning?.default || "").trim().toLowerCase(), reasoningSource ? `${reasoningSource}.default` : "fallback"],
    ["medium", "fallback"], [levels[0], "fallback"]
  ];
  const [defaultLevel, defaultSource] = defaultCandidates.find(([value]) => value && levels.includes(value)) || ["medium", "fallback"];
  const contextCandidates = [
    [model?.codex?.contextWindow, "models[].codex.contextWindow"],
    [model?.contextWindow, "models[].contextWindow"],
    [descriptor?.tokenLimits?.contextWindow, "catalog.contextWindow"],
    [descriptor?.tokenLimits?.maxInputTokens, "catalog.maxInputTokens"]
  ];
  const [contextWindow, contextSource] = contextCandidates.find(([value]) => Number.isSafeInteger(value) && value > 0) || [128000, "fallback"];
  const inputModalities = descriptor?.inputModalities?.length
    ? descriptor.inputModalities.filter(modality => ["text", "image"].includes(modality))
    : capabilities.has("vision") ? ["text", "image"] : ["text"];
  const supportsVision = inputModalities.includes("image");
  const supportsWebSearch = capabilities.has("web-search");
  const configuredInstructions = typeof model?.codex?.baseInstructions === "string" ? model.codex.baseInstructions.trim() : "";
  const configuredPriority = Number.isInteger(model?.codex?.priority);
  return {
    sources: {
      context_window: contextSource,
      supported_reasoning_levels: levelSource,
      default_reasoning_level: defaultSource,
      priority: configuredPriority ? "models[].codex.priority" : "filtered-catalog-order",
      base_instructions: configuredInstructions ? "models[].codex.baseInstructions" : "fallback"
    },
    info: {
      slug: model.id,
      display_name: model.displayName || model.id,
      description: model?.codex?.description || `${model.displayName || model.id} via AOAI Proxy`,
      default_reasoning_level: defaultLevel,
      supported_reasoning_levels: levels.map(effort => ({ effort, description: REASONING_DESCRIPTIONS[effort] || `${effort} reasoning` })),
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: configuredPriority ? model.codex.priority : index,
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: configuredInstructions || DEFAULT_BASE_INSTRUCTIONS,
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: capabilities.has("code-optimized") ? "freeform" : null,
      web_search_tool_type: supportsVision && supportsWebSearch ? "text_and_image" : "text",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: capabilities.has("parallel-tool-calling"),
      supports_image_detail_original: supportsVision,
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: contextSource === "fallback" ? 95 : 100,
      experimental_supported_tools: [],
      input_modalities: inputModalities,
      supports_search_tool: supportsWebSearch,
      use_responses_lite: false
    }
  };
}
