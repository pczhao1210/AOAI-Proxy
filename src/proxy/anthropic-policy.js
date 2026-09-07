import { getDescriptorProtocolProfile } from "../model-catalog.js";

const VALID_ANTHROPIC_CACHE_TTLS = new Set(["5m", "1h"]);

function anthropicCompatibility(config) {
  return config?.compatibility?.anthropic || {};
}

function isSupportedAnthropicCacheLocation(path) {
  if (path.length === 0) return true;
  if (path.length === 2 && path[0] === "tools" && Number.isInteger(path[1])) return true;
  if (path.length === 2 && path[0] === "system" && Number.isInteger(path[1])) return true;
  return path.length === 4
    && path[0] === "messages"
    && Number.isInteger(path[1])
    && path[2] === "content"
    && Number.isInteger(path[3]);
}

function sanitizeAnthropicCacheControls(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => sanitizeAnthropicCacheControls(item, [...path, index]));
    return;
  }
  if (!value || typeof value !== "object") return;

  const currentType = typeof value.type === "string" ? value.type : "";
  if ("cache_control" in value) {
    const cacheControl = value.cache_control;
    const ttl = typeof cacheControl?.ttl === "string" ? cacheControl.ttl : "";
    if (
      !isSupportedAnthropicCacheLocation(path)
      || currentType === "thinking"
      || currentType === "redacted_thinking"
      || (currentType === "text" && !String(value.text || ""))
      || !cacheControl
      || typeof cacheControl !== "object"
      || Array.isArray(cacheControl)
      || cacheControl.type !== "ephemeral"
      || (ttl && !VALID_ANTHROPIC_CACHE_TTLS.has(ttl))
    ) {
      delete value.cache_control;
    } else {
      value.cache_control = {
        type: "ephemeral",
        ...(ttl ? { ttl } : {})
      };
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (key !== "cache_control") sanitizeAnthropicCacheControls(child, [...path, key]);
  }
}

function resolveConfiguredAnthropicModelValues(config, profileName, modelId, model) {
  const profiles = anthropicCompatibility(config)[profileName];
  if (!profiles || typeof profiles !== "object") return null;
  for (const candidate of [modelId, model?.targetModel, model?.id, model?.pricingRef]) {
    const modelName = String(candidate || "").trim().toLowerCase();
    const values = profiles[modelName];
    if (Array.isArray(values) && values.length > 0) return values;
  }
  return null;
}

function resolveAnthropicModelPolicy(config, profileName, modelId, model, descriptor) {
  const configuredValues = resolveConfiguredAnthropicModelValues(config, profileName, modelId, model);
  const catalogProfile = getDescriptorProtocolProfile(descriptor, "messages");
  const catalogPolicy = profileName === "thinkingTypesByModel"
    ? catalogProfile?.thinking
    : catalogProfile?.reasoning;
  return {
    values: configuredValues || catalogPolicy?.types || catalogPolicy?.levels || null,
    aliases: catalogPolicy?.aliases || {},
    validation: configuredValues ? "strict" : catalogPolicy?.validation || "passthrough"
  };
}

export function applyAnthropicBodyCompatibility(body, config, modelId, model, descriptor) {
  if (!body || typeof body !== "object") return null;
  const policy = anthropicCompatibility(config);
  const thinkingType = typeof body.thinking?.type === "string"
    ? body.thinking.type.trim()
    : "";
  if (thinkingType && policy.validateThinkingByModel !== false) {
    const thinkingPolicy = resolveAnthropicModelPolicy(
      config,
      "thinkingTypesByModel",
      modelId,
      model,
      descriptor
    );
    if (thinkingPolicy.validation === "strict" && thinkingPolicy.values && !thinkingPolicy.values.includes(thinkingType)) {
      return {
        param: "thinking.type",
        message: `thinking.type=${thinkingType} is not supported by ${modelId}; use ${thinkingPolicy.values.join(" or ")}`
      };
    }
  }
  const effort = typeof body.output_config?.effort === "string"
    ? body.output_config.effort.trim().toLowerCase()
    : "";
  if (effort && policy.validateThinkingByModel !== false) {
    const effortPolicy = resolveAnthropicModelPolicy(
      config,
      "effortLevelsByModel",
      modelId,
      model,
      descriptor
    );
    const normalizedEffort = effortPolicy.aliases[effort] || effort;
    if (effortPolicy.validation === "strict" && effortPolicy.values && !effortPolicy.values.includes(normalizedEffort)) {
      return {
        param: "output_config.effort",
        message: `output_config.effort=${effort} is not supported by ${modelId}; use ${effortPolicy.values.join(" or ")}`
      };
    }
    body.output_config.effort = normalizedEffort;
  }
  if (policy.normalizeManualThinkingToolChoice !== false && body.thinking?.type === "enabled") {
    const choiceType = body.tool_choice?.type;
    if (choiceType === "any" || choiceType === "tool") {
      body.tool_choice = {
        ...body.tool_choice,
        type: "auto"
      };
      delete body.tool_choice.name;
    }
  }
  if (policy.sanitizeCacheControl !== false) {
    sanitizeAnthropicCacheControls(body);
  }
  return null;
}