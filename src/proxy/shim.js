import { getDefaultProtocolProfile, getDescriptorProtocolProfile } from "../model-catalog.js";

const SHIM_PROTOCOLS = new Set(["chat/completions", "responses", "messages"]);
const TEXT_CONTENT_TYPES = new Set(["text", "input_text", "output_text"]);
const IMAGE_CONTENT_TYPES = new Set(["image", "image_url", "input_image"]);
const RESPONSES_TOOL_SEARCH_ITEM_TYPES = new Set(["tool_search_call", "tool_search_output"]);
const RESPONSES_SHIM_STREAM_LIFECYCLE_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.output_text.delta",
  "response.output_text.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "error"
]);
const SUPPORTED_CHAT_FINAL_FINISH_REASONS = new Set(["stop", "length", "tool_calls"]);
const SUPPORTED_CHAT_STREAM_FINISH_REASONS = new Set([null, undefined, ...SUPPORTED_CHAT_FINAL_FINISH_REASONS]);
const SUPPORTED_ANTHROPIC_FINAL_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use"]);
const SUPPORTED_ANTHROPIC_STREAM_STOP_REASONS = new Set([null, undefined, ...SUPPORTED_ANTHROPIC_FINAL_STOP_REASONS]);

export function normalizeWebSearchToolType(type) {
  const normalized = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (
    normalized === "web_search_preview"
    || normalized === "web_search_preview_2025_03_11"
  ) {
    return "web_search";
  }
  return normalized;
}

function getValueAtPath(value, path) {
  const segments = String(path || "").split(".").filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function setValueAtPath(value, path, nextValue) {
  const segments = String(path || "").split(".").filter(Boolean);
  if (!segments.length) return;
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = nextValue;
}

function deleteValueAtPath(value, path) {
  const segments = String(path || "").split(".").filter(Boolean);
  if (!segments.length) return;
  const parents = [];
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    if (!current || typeof current !== "object") return;
    parents.push([current, segment]);
    current = current[segment];
  }
  if (!current || typeof current !== "object") return;
  delete current[segments.at(-1)];
  for (const [parent, segment] of parents.reverse()) {
    const child = parent[segment];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[segment];
    } else {
      break;
    }
  }
}

function resolveReasoningProfile(descriptor, protocol) {
  const fallback = getDefaultProtocolProfile(protocol)?.reasoning || {};
  const configured = getDescriptorProtocolProfile(descriptor, protocol)?.reasoning;
  const profile = configured && typeof configured === "object" ? configured : fallback;
  const configurable = profile.configurable !== false;
  return {
    ...profile,
    configurable,
    parameter: configurable ? profile.parameter || "" : "",
    aliases: { ...(profile.aliases || {}) }
  };
}

function normalizeReasoningValue(value, profile) {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim().toLowerCase();
  return profile.aliases?.[normalized] || normalized;
}

function transferReasoning(out, body, sourceProtocol, targetProtocol, descriptor) {
  const sourceProfile = resolveReasoningProfile(descriptor, sourceProtocol);
  const targetProfile = resolveReasoningProfile(descriptor, targetProtocol);
  const sourceValue = normalizeReasoningValue(
    getValueAtPath(body, sourceProfile.parameter),
    sourceProfile
  );
  if (!sourceValue || !targetProfile.parameter) return "";
  const targetValue = normalizeReasoningValue(sourceValue, targetProfile);
  setValueAtPath(out, targetProfile.parameter, targetValue);
  if (sourceProfile.parameter !== targetProfile.parameter) {
    deleteValueAtPath(out, sourceProfile.parameter);
  }
  return targetValue;
}

function ensureMessagesThinking(out, descriptor) {
  const fallback = getDefaultProtocolProfile("messages")?.thinking || {};
  const configured = getDescriptorProtocolProfile(descriptor, "messages")?.thinking;
  const profile = configured && typeof configured === "object" ? configured : fallback;
  const parameter = profile.parameter || "";
  const defaultType = profile.default || "";
  if (parameter && defaultType && getValueAtPath(out, parameter) == null) {
    setValueAtPath(out, parameter, defaultType);
  }
}

function createShimCompatibilityIssue({
  phase,
  sourceProtocol,
  targetProtocol,
  path,
  type,
  reason,
  requiredRejection = false
}) {
  return {
    phase,
    sourceProtocol,
    targetProtocol,
    path,
    type: type || "unknown",
    reason,
    ...(requiredRejection ? { requiredRejection: true } : {}),
    message: `Cannot losslessly convert ${sourceProtocol} ${phase} ${path} (${type || "unknown"}) to ${targetProtocol}: ${reason}`
  };
}

function hasNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasMeaningfulShimValue(value) {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).some((key) => value[key] != null);
  return true;
}

function hasStructuredMetadata(value) {
  return value?.cache_control != null
    || value?.prompt_cache_breakpoint != null
    || hasNonEmptyArray(value?.citations)
    || hasNonEmptyArray(value?.annotations)
    || hasNonEmptyArray(value?.logprobs);
}

function validateTextOnlyValue(value, context, path) {
  if (typeof value === "string" || value == null) return null;
  if (!Array.isArray(value)) {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: typeof value,
      reason: "tool output must be text"
    });
  }
  for (let index = 0; index < value.length; index += 1) {
    const part = value[index];
    if (typeof part === "string") continue;
    const partType = part?.type;
    if (!part || !TEXT_CONTENT_TYPES.has(partType) || typeof part.text !== "string" || hasStructuredMetadata(part)) {
      return createShimCompatibilityIssue({
        ...context,
        path: `${path}[${index}]`,
        type: partType || typeof part,
        reason: "tool output contains non-text or annotated content"
      });
    }
  }
  return null;
}

function validateResponsesContent(content, context, path) {
  if (typeof content === "string" || content == null) return null;
  if (!Array.isArray(content)) {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: typeof content,
      reason: "message content must be text or a supported content array"
    });
  }
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (typeof part === "string") continue;
    const partPath = `${path}[${index}]`;
    const partType = part?.type;
    if (!part || typeof part !== "object") {
      return createShimCompatibilityIssue({
        ...context,
        path: partPath,
        type: typeof part,
        reason: "invalid content part"
      });
    }
    if (TEXT_CONTENT_TYPES.has(partType)) {
      if (hasStructuredMetadata(part)) {
        return createShimCompatibilityIssue({
          ...context,
          path: partPath,
          type: partType,
          reason: "citations, annotations, logprobs, and cache metadata are not preserved by the target protocol"
        });
      }
      continue;
    }
    if (context.phase === "request" && IMAGE_CONTENT_TYPES.has(partType)) {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!imageUrl) {
        return createShimCompatibilityIssue({
          ...context,
          path: partPath,
          type: partType,
          reason: "file-backed image references cannot be represented by the target protocol"
        });
      }
      if (context.targetProtocol === "messages" && (part.detail || part.image_url?.detail)) {
        return createShimCompatibilityIssue({
          ...context,
          path: partPath,
          type: partType,
          reason: "image detail is not represented by Anthropic Messages"
        });
      }
      continue;
    }
    return createShimCompatibilityIssue({
      ...context,
      path: partPath,
      type: partType || "unknown",
      reason: "unsupported Responses content type"
    });
  }
  return null;
}

function normalizeResponsesCallId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateResponsesToChatFunctionHistory(itemList, context) {
  if (context.phase !== "request" || context.targetProtocol !== "chat/completions") {
    return null;
  }

  let activeBatch = null;
  const seenCallIds = new Set();

  const missingOutputIssue = () => {
    if (!activeBatch) return null;
    for (const [callId, call] of activeBatch.calls) {
      if (activeBatch.outputs.has(callId)) continue;
      return createShimCompatibilityIssue({
        ...context,
        path: `${call.path}.call_id`,
        type: "function_call",
        reason: "function_call requires exactly one matching function_call_output before the next message or end of input",
        requiredRejection: true
      });
    }
    return null;
  };

  for (let index = 0; index < itemList.length; index += 1) {
    const item = itemList[index];
    const itemPath = `input[${index}]`;
    const itemType = item?.type || (item?.role ? "message" : "unknown");

    if (itemType === "function_call") {
      if (activeBatch?.outputStarted) {
        const issue = missingOutputIssue();
        if (issue) return issue;
        activeBatch = null;
      }
      if (!activeBatch) {
        activeBatch = { calls: new Map(), outputs: new Set(), outputStarted: false };
      }
      const callId = normalizeResponsesCallId(item?.call_id)
        || normalizeResponsesCallId(item?.id);
      if (!callId) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${itemPath}.call_id`,
          type: "function_call",
          reason: "function_call must provide a non-empty call_id or id",
          requiredRejection: true
        });
      }
      if (seenCallIds.has(callId)) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${itemPath}.call_id`,
          type: "function_call",
          reason: "function call IDs must be unique in converted Chat history",
          requiredRejection: true
        });
      }
      seenCallIds.add(callId);
      activeBatch.calls.set(callId, { path: itemPath });
      continue;
    }

    if (itemType === "function_call_output") {
      const callId = normalizeResponsesCallId(item?.call_id);
      if (!callId) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${itemPath}.call_id`,
          type: "function_call_output",
          reason: "function_call_output must provide a non-empty call_id",
          requiredRejection: true
        });
      }
      if (!activeBatch?.calls.has(callId)) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${itemPath}.call_id`,
          type: "function_call_output",
          reason: "function_call_output must match a preceding function_call in the same uninterrupted tool-call batch",
          requiredRejection: true
        });
      }
      if (activeBatch.outputs.has(callId)) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${itemPath}.call_id`,
          type: "function_call_output",
          reason: "function_call_output must occur exactly once for each function_call",
          requiredRejection: true
        });
      }
      activeBatch.outputStarted = true;
      activeBatch.outputs.add(callId);
      continue;
    }

    const issue = missingOutputIssue();
    if (issue) return issue;
    activeBatch = null;
  }

  return missingOutputIssue();
}

function getRequiredResponsesToChatIssue(payload, context) {
  if (context.targetProtocol !== "chat/completions") return null;

  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  for (let index = 0; index < tools.length; index += 1) {
    if (tools[index]?.type !== "tool_search") continue;
    return createShimCompatibilityIssue({
      ...context,
      path: `tools[${index}]`,
      type: "tool_search",
      reason: "Responses Tool Search definitions cannot be represented by Chat Completions",
      requiredRejection: true
    });
  }

  if (payload?.tool_choice?.type === "tool_search") {
    return createShimCompatibilityIssue({
      ...context,
      path: "tool_choice",
      type: "tool_search",
      reason: "Responses Tool Search choices cannot be represented by Chat Completions",
      requiredRejection: true
    });
  }

  const items = context.phase === "request" ? payload?.input : payload?.output;
  if (items == null || typeof items === "string") return null;
  const itemList = Array.isArray(items) ? items : [items];
  for (let index = 0; index < itemList.length; index += 1) {
    const item = itemList[index];
    const itemType = item?.type || (item?.role ? "message" : "unknown");
    if (itemType === "additional_tools") {
      return createShimCompatibilityIssue({
        ...context,
        path: `${context.phase === "request" ? "input" : "output"}[${index}]`,
        type: itemType,
        reason: "Responses position-scoped additional tool state cannot be represented by Chat Completions",
        requiredRejection: true
      });
    }
    if (!RESPONSES_TOOL_SEARCH_ITEM_TYPES.has(itemType)) continue;
    return createShimCompatibilityIssue({
      ...context,
      path: `${context.phase === "request" ? "input" : "output"}[${index}]`,
      type: itemType,
      reason: "Responses Tool Search state cannot be represented by Chat Completions",
      requiredRejection: true
    });
  }

  return validateResponsesToChatFunctionHistory(itemList, context);
}

function validateResponsesPayload(payload, context) {
  const requiredIssue = getRequiredResponsesToChatIssue(payload, context);
  if (requiredIssue) return requiredIssue;

  if (context.phase === "request") {
    if (context.targetProtocol === "messages") {
      for (const field of ["service_tier", "serviceTier", "verbosity", "top_k"]) {
        if (hasMeaningfulShimValue(payload?.[field])) {
          return createShimCompatibilityIssue({
            ...context,
            path: field,
            type: field,
            reason: "Responses request control is not represented by Anthropic Messages"
          });
        }
      }
    }
    const stateFields = [
      "context_management",
      "conversation",
      "previous_response_id",
      "prompt",
      "prompt_cache_key",
      "prompt_cache_retention",
      "truncation"
    ];
    for (const field of stateFields) {
      if (hasMeaningfulShimValue(payload?.[field])) {
        return createShimCompatibilityIssue({
          ...context,
          path: field,
          type: field,
          reason: "Responses conversation or cache state cannot be preserved"
        });
      }
    }
    if (hasMeaningfulShimValue(payload?.include)) {
      const supportedInclude = context.targetProtocol === "messages"
        && Array.isArray(payload.include)
        && payload.include.every((value) => value === "reasoning.encrypted_content");
      if (!supportedInclude) {
        return createShimCompatibilityIssue({
          ...context,
          path: "include",
          type: "include",
          reason: "Responses include state cannot be preserved"
        });
      }
    }
    if (payload?.max_tool_calls != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: "max_tool_calls",
        type: "max_tool_calls",
        reason: "Responses tool-call limits cannot be preserved"
      });
    }
    if (payload?.background === true || payload?.store === true) {
      const field = payload.background === true ? "background" : "store";
      return createShimCompatibilityIssue({
        ...context,
        path: field,
        type: field,
        reason: "Responses server-side state cannot be preserved"
      });
    }
    if (payload?.reasoning != null) {
      const reasoningKeys = payload.reasoning && typeof payload.reasoning === "object"
        ? Object.keys(payload.reasoning).filter((key) => payload.reasoning[key] != null)
        : [];
      if (reasoningKeys.some((key) => key !== "effort")) {
        return createShimCompatibilityIssue({
          ...context,
          path: "reasoning",
          type: "reasoning",
          reason: "reasoning configuration is not fully represented by the target protocol"
        });
      }
    }
    if (context.targetProtocol === "messages" && payload?.text?.format != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: "text.format",
        type: payload.text.format?.type || "format",
        reason: "structured output format is not represented by Anthropic Messages"
      });
    }
  } else {
    const status = payload?.status;
    if (status != null && status !== "completed" && status !== "incomplete") {
      return createShimCompatibilityIssue({
        ...context,
        path: "status",
        type: status,
        reason: "a non-success Responses state cannot be represented as a final target-protocol response",
        requiredRejection: true
      });
    }
    if (status === "incomplete" && payload?.incomplete_details?.reason !== "max_output_tokens") {
      return createShimCompatibilityIssue({
        ...context,
        path: "incomplete_details.reason",
        type: payload?.incomplete_details?.reason || "unknown",
        reason: "only max_output_tokens can be represented by the target protocol's length termination"
      });
    }
  }

  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  for (let index = 0; index < tools.length; index += 1) {
    if (tools[index]?.type !== "function") {
      const toolType = tools[index]?.type || "unknown";
      return createShimCompatibilityIssue({
        ...context,
        path: `tools[${index}]`,
        type: toolType,
        reason: "only function tools can be converted across protocols"
      });
    }
  }
  if (payload?.tool_choice && typeof payload.tool_choice === "object" && payload.tool_choice.type !== "function") {
    const toolChoiceType = payload.tool_choice.type || "unknown";
    return createShimCompatibilityIssue({
      ...context,
      path: "tool_choice",
      type: toolChoiceType,
        reason: "only function tool choices can be converted across protocols"
    });
  }

  const items = context.phase === "request" ? payload?.input : payload?.output;
  if (items == null || typeof items === "string") return null;
  const itemList = Array.isArray(items) ? items : [items];
  for (let index = 0; index < itemList.length; index += 1) {
    const item = itemList[index];
    const itemPath = `${context.phase === "request" ? "input" : "output"}[${index}]`;
    if (typeof item === "string") continue;
    if (!item || typeof item !== "object") {
      return createShimCompatibilityIssue({
        ...context,
        path: itemPath,
        type: typeof item,
        reason: "invalid Responses item"
      });
    }
    const itemType = item.type || (item.role ? "message" : "unknown");
    if (itemType === "message") {
      const issue = validateResponsesContent(item.content, context, `${itemPath}.content`);
      if (issue) return issue;
      continue;
    }
    if (itemType === "function_call") continue;
    if (context.targetProtocol === "messages" && itemType === "reasoning") {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const validSummary = summary.every((part) => part?.type === "summary_text" && typeof part.text === "string");
      if (typeof item.encrypted_content === "string" && validSummary) continue;
      return createShimCompatibilityIssue({
        ...context,
        path: itemPath,
        type: itemType,
        reason: "Anthropic thinking continuation requires encrypted_content and optional summary_text parts"
      });
    }
    if (context.phase === "request" && itemType === "function_call_output") {
      const issue = validateTextOnlyValue(item.output, context, `${itemPath}.output`);
      if (issue) return issue;
      continue;
    }
    return createShimCompatibilityIssue({
      ...context,
      path: itemPath,
      type: itemType,
      reason: "unsupported Responses item type"
    });
  }
  return null;
}

function validateAnthropicTextBlock(block, context, path) {
  if (hasStructuredMetadata(block)) {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: block?.type || "text",
      reason: "citations and cache metadata are not preserved by the target protocol"
    });
  }
  return null;
}

function validateAnthropicContent(content, context, path) {
  if (typeof content === "string" || content == null) return null;
  if (!Array.isArray(content)) {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: typeof content,
      reason: "Anthropic content must be text or a supported content array"
    });
  }
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    const blockPath = `${path}[${index}]`;
    if (typeof block === "string") continue;
    const blockType = block?.type;
    if (blockType === "text") {
      const issue = validateAnthropicTextBlock(block, context, blockPath);
      if (issue) return issue;
      continue;
    }
    if (context.phase === "request" && blockType === "image" && block?.source && !block.cache_control) {
      const sourceType = block.source.type;
      const supportedSource = sourceType === "base64"
        ? typeof block.source.media_type === "string" && typeof block.source.data === "string"
        : sourceType === "url" && typeof block.source.url === "string";
      if (supportedSource) continue;
      return createShimCompatibilityIssue({
        ...context,
        path: `${blockPath}.source`,
        type: sourceType || "unknown",
        reason: "only base64 and URL Anthropic image sources can be converted"
      });
    }
    if (blockType === "tool_use" && !block?.cache_control && !block?.caller) continue;
    if (context.phase === "request" && blockType === "tool_result" && !block?.cache_control) {
      if (block.is_error === true) {
        return createShimCompatibilityIssue({
          ...context,
          path: `${blockPath}.is_error`,
          type: "is_error",
          reason: "Anthropic tool error state cannot be preserved by the target protocol"
        });
      }
      const issue = validateTextOnlyValue(block.content, context, `${blockPath}.content`);
      if (issue) return issue;
      continue;
    }
    if (
      context.phase === "request"
      && context.targetProtocol === "responses"
      && blockType === "thinking"
      && typeof block.thinking === "string"
      && (block.signature == null || typeof block.signature === "string")
    ) {
      continue;
    }
    if (
      context.phase === "request"
      && context.targetProtocol === "responses"
      && blockType === "redacted_thinking"
      && typeof block.data === "string"
    ) {
      continue;
    }
    if (context.phase === "response" && blockType === "thinking") {
      if (context.targetProtocol === "chat/completions" && !block?.signature) continue;
      if (context.targetProtocol === "responses" && typeof block.thinking === "string") continue;
    }
    if (
      context.phase === "response"
      && context.targetProtocol === "responses"
      && blockType === "redacted_thinking"
      && typeof block.data === "string"
    ) {
      continue;
    }
    return createShimCompatibilityIssue({
      ...context,
      path: blockPath,
      type: blockType || "unknown",
      reason: "unsupported Anthropic content block"
    });
  }
  return null;
}

function validateMessagesPayload(payload, context) {
  if (context.phase === "request") {
    if (payload?.thinking != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: "thinking",
        type: "thinking",
        reason: "Anthropic thinking mode cannot be preserved"
      });
    }
    if (payload?.output_config != null) {
      const outputConfigKeys = payload.output_config && typeof payload.output_config === "object"
        ? Object.keys(payload.output_config).filter((key) => payload.output_config[key] != null)
        : [];
      const mapsToResponsesEffort = context.targetProtocol === "responses"
        && outputConfigKeys.every((key) => key === "effort")
        && (payload.output_config.effort == null || typeof payload.output_config.effort === "string");
      if (!mapsToResponsesEffort) {
        return createShimCompatibilityIssue({
          ...context,
          path: "output_config",
          type: "output_config",
          reason: "Anthropic output configuration cannot be preserved"
        });
      }
    }
    for (const field of ["top_k", "metadata", "service_tier", "serviceTier", "verbosity"]) {
      if (context.targetProtocol !== "responses" && hasMeaningfulShimValue(payload?.[field])) {
        return createShimCompatibilityIssue({
          ...context,
          path: field,
          type: field,
          reason: "Anthropic request control is not represented by the target protocol"
        });
      }
    }
    if (Array.isArray(payload?.system)) {
      for (let index = 0; index < payload.system.length; index += 1) {
        const block = payload.system[index];
        if (block?.type !== "text") {
          return createShimCompatibilityIssue({
            ...context,
            path: `system[${index}]`,
            type: block?.type || "unknown",
            reason: "only text system blocks can be converted across protocols"
          });
        }
        const issue = validateAnthropicTextBlock(block, context, `system[${index}]`);
        if (issue) return issue;
      }
    }
    const tools = Array.isArray(payload?.tools) ? payload.tools : [];
    for (let index = 0; index < tools.length; index += 1) {
      const toolType = tools[index]?.type;
      if (toolType && toolType !== "custom") {
        return createShimCompatibilityIssue({
          ...context,
          path: `tools[${index}]`,
          type: toolType,
          reason: "only custom function tools can be converted across protocols"
        });
      }
    }
    if (context.targetProtocol !== "responses" && payload?.tool_choice?.disable_parallel_tool_use === true) {
      return createShimCompatibilityIssue({
        ...context,
        path: "tool_choice.disable_parallel_tool_use",
        type: "disable_parallel_tool_use",
        reason: "Anthropic parallel tool-call restrictions cannot be preserved"
      });
    }
  } else if (!SUPPORTED_ANTHROPIC_FINAL_STOP_REASONS.has(payload?.stop_reason)) {
    return createShimCompatibilityIssue({
      ...context,
      path: "stop_reason",
      type: payload?.stop_reason || "unknown",
      reason: "Anthropic termination reason cannot be represented by the target protocol"
    });
  }

  const messages = context.phase === "request"
    ? (Array.isArray(payload?.messages) ? payload.messages : [])
    : [{ content: payload?.content }];
  for (let index = 0; index < messages.length; index += 1) {
    const issue = validateAnthropicContent(
      messages[index]?.content,
      context,
      context.phase === "request" ? `messages[${index}].content` : "content"
    );
    if (issue) return issue;
  }
  return null;
}

function validateChatContent(content, context, path) {
  if (typeof content === "string" || content == null) return null;
  if (!Array.isArray(content)) {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: typeof content,
      reason: "Chat content must be text or a supported content array"
    });
  }
  if (context.phase === "response") {
    return createShimCompatibilityIssue({
      ...context,
      path,
      type: "content_array",
      reason: "structured Chat response content is not preserved by the target protocol"
    });
  }
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (typeof part === "string") continue;
    const partPath = `${path}[${index}]`;
    const partType = part?.type;
    if (TEXT_CONTENT_TYPES.has(partType) && !hasStructuredMetadata(part)) continue;
    if (IMAGE_CONTENT_TYPES.has(partType)) {
      const imageUrl = typeof part?.image_url === "string" ? part.image_url : part?.image_url?.url;
      if (!imageUrl || (context.targetProtocol === "messages" && (part.detail || part.image_url?.detail))) {
        return createShimCompatibilityIssue({
          ...context,
          path: partPath,
          type: partType,
          reason: "image reference or detail cannot be represented by the target protocol"
        });
      }
      continue;
    }
    if (partType === "input_file" && context.targetProtocol === "responses") continue;
    return createShimCompatibilityIssue({
      ...context,
      path: partPath,
      type: partType || "unknown",
      reason: "unsupported Chat content type"
    });
  }
  return null;
}

function validateChatPayload(payload, context) {
  if (context.phase === "request") {
    if (context.targetProtocol === "messages") {
      for (const field of ["service_tier", "serviceTier", "verbosity"]) {
        if (hasMeaningfulShimValue(payload?.[field])) {
          return createShimCompatibilityIssue({
            ...context,
            path: field,
            type: field,
            reason: "Chat request control is not represented by Anthropic Messages"
          });
        }
      }
    }
    if (payload?.n != null && payload.n !== 1) {
      return createShimCompatibilityIssue({
        ...context,
        path: "n",
        type: "n",
        reason: "the target protocol cannot preserve multiple completion candidates"
      });
    }
    const droppedControls = [
      "frequency_penalty",
      "logit_bias",
      "logprobs",
      "prediction",
      "presence_penalty",
      "seed",
      "top_logprobs",
      ...(context.targetProtocol === "messages" ? [] : ["stop", "top_k", "top_p"])
    ];
    for (const field of droppedControls) {
      const value = payload?.[field];
      const isNoOpPenalty = (field === "frequency_penalty" || field === "presence_penalty") && value === 0;
      const isNoOpLogprobs = field === "logprobs" && value === false;
      const isNoOpTopLogprobs = field === "top_logprobs" && value === 0;
      if (!isNoOpPenalty && !isNoOpLogprobs && !isNoOpTopLogprobs && hasMeaningfulShimValue(value)) {
        return createShimCompatibilityIssue({
          ...context,
          path: field,
          type: field,
          reason: "Chat request control is not represented by the target protocol"
        });
      }
    }
    if (hasMeaningfulShimValue(payload?.stream_options)) {
      const streamOptions = payload.stream_options;
      if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
        return createShimCompatibilityIssue({
          ...context,
          path: "stream_options",
          type: typeof streamOptions,
          reason: "Chat stream options must be an object"
        });
      }
      const unsupportedOption = Object.keys(streamOptions).find((field) => field !== "include_usage");
      if (unsupportedOption) {
        return createShimCompatibilityIssue({
          ...context,
          path: `stream_options.${unsupportedOption}`,
          type: unsupportedOption,
          reason: "Chat stream option cannot be represented by the target protocol"
        });
      }
      if (streamOptions.include_usage != null && typeof streamOptions.include_usage !== "boolean") {
        return createShimCompatibilityIssue({
          ...context,
          path: "stream_options.include_usage",
          type: typeof streamOptions.include_usage,
          reason: "Chat include_usage must be a boolean"
        });
      }
    }
    if (payload?.best_of != null && payload.best_of !== 1) {
      return createShimCompatibilityIssue({
        ...context,
        path: "best_of",
        type: "best_of",
        reason: "the target protocol cannot preserve multiple completion candidates"
      });
    }
    const modalities = payload?.modalities;
    if (hasNonEmptyArray(modalities) && !(modalities.length === 1 && modalities[0] === "text")) {
      return createShimCompatibilityIssue({
        ...context,
        path: "modalities",
        type: "modalities",
        reason: "non-text Chat modalities cannot be preserved"
      });
    }
    if (context.targetProtocol === "messages" && payload?.parallel_tool_calls != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: "parallel_tool_calls",
        type: "parallel_tool_calls",
        reason: "Chat parallel tool-call policy cannot be preserved by Anthropic Messages"
      });
    }
  } else {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    if (choices.length !== 1) {
      return createShimCompatibilityIssue({
        ...context,
        path: "choices",
        type: choices.length > 1 ? "multiple_choices" : "missing_choice",
        reason: choices.length > 1
          ? "the target protocol cannot preserve multiple completion candidates"
          : "a final Chat response must contain exactly one completion choice"
      });
    }
    const finishReason = choices[0]?.finish_reason;
    if (!SUPPORTED_CHAT_FINAL_FINISH_REASONS.has(finishReason)) {
      return createShimCompatibilityIssue({
        ...context,
        path: "choices[0].finish_reason",
        type: finishReason || "unknown",
        reason: "Chat termination reason cannot be represented by the target protocol"
      });
    }
  }
  if (context.phase === "request" && context.targetProtocol === "messages") {
    for (const field of ["function_call", "functions", "reasoning", "reasoning_effort", "response_format"]) {
      if (payload?.[field] != null) {
        return createShimCompatibilityIssue({
          ...context,
          path: field,
          type: field,
          reason: "Chat structured configuration is not represented by Anthropic Messages"
        });
      }
    }
  }
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  for (let index = 0; index < tools.length; index += 1) {
    const toolType = normalizeWebSearchToolType(tools[index]?.type);
    const supportedWebSearch = context.targetProtocol === "responses" && toolType === "web_search";
    if (toolType !== "function" && !supportedWebSearch) {
      return createShimCompatibilityIssue({
        ...context,
        path: `tools[${index}]`,
        type: tools[index]?.type || "unknown",
        reason: "only function tools can be converted across protocols"
      });
    }
  }

  const messages = context.phase === "request"
    ? (Array.isArray(payload?.messages) ? payload.messages : [])
    : [payload?.choices?.[0]?.message].filter(Boolean);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const basePath = context.phase === "request" ? `messages[${index}]` : "choices[0].message";
    if (message?.role === "function") {
      return createShimCompatibilityIssue({
        ...context,
        path: `${basePath}.role`,
        type: "function",
        reason: "legacy Chat function messages cannot be converted losslessly"
      });
    }
    if (message?.function_call != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: `${basePath}.function_call`,
        type: "function_call",
        reason: "legacy Chat function calls cannot be converted losslessly"
      });
    }
    if (message?.reasoning_content != null || message?.refusal != null || message?.audio != null) {
      const field = message.reasoning_content != null ? "reasoning_content" : message.refusal != null ? "refusal" : "audio";
      return createShimCompatibilityIssue({
        ...context,
        path: `${basePath}.${field}`,
        type: field,
        reason: "structured assistant content is not preserved by the target protocol"
      });
    }
    const contentIssue = validateChatContent(message?.content, context, `${basePath}.content`);
    if (contentIssue) return contentIssue;
    for (let toolIndex = 0; toolIndex < (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0); toolIndex += 1) {
      const toolCall = message.tool_calls[toolIndex];
      if (toolCall?.type !== "function") {
        return createShimCompatibilityIssue({
          ...context,
          path: `${basePath}.tool_calls[${toolIndex}]`,
          type: toolCall?.type || "unknown",
          reason: "only function tool calls can be converted across protocols"
        });
      }
    }
    if (message?.role === "tool") {
      if (context.targetProtocol === "responses" && typeof message.content !== "string") {
        return createShimCompatibilityIssue({
          ...context,
          path: `${basePath}.content`,
          type: Array.isArray(message.content) ? "content_array" : typeof message.content,
          reason: "Responses function_call_output conversion requires a string tool result"
        });
      }
      const outputIssue = validateTextOnlyValue(message.content, context, `${basePath}.content`);
      if (outputIssue) return outputIssue;
    }
  }
  return null;
}

export function getProtocolShimCompatibilityIssue(payload, {
  phase = "request",
  sourceProtocol,
  targetProtocol
} = {}) {
  if (
    !payload
    || typeof payload !== "object"
    || sourceProtocol === targetProtocol
    || !SHIM_PROTOCOLS.has(sourceProtocol)
    || !SHIM_PROTOCOLS.has(targetProtocol)
  ) {
    return null;
  }
  const context = { phase, sourceProtocol, targetProtocol };
  if (sourceProtocol === "responses") return validateResponsesPayload(payload, context);
  if (sourceProtocol === "messages") return validateMessagesPayload(payload, context);
  return validateChatPayload(payload, context);
}

export function getProtocolShimStreamCompatibilityIssue(event, {
  sourceProtocol,
  targetProtocol
} = {}) {
  if (
    !event
    || typeof event !== "object"
    || sourceProtocol === targetProtocol
    || !SHIM_PROTOCOLS.has(sourceProtocol)
    || !SHIM_PROTOCOLS.has(targetProtocol)
  ) {
    return null;
  }
  const context = { phase: "stream", sourceProtocol, targetProtocol };

  if (sourceProtocol === "responses") {
    const eventType = event.type;
    if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      return validateResponsesPayload({ output: [event.item] }, { ...context, phase: "response" });
    }
    if (eventType === "response.content_part.added" || eventType === "response.content_part.done") {
      return validateResponsesContent([event.part], { ...context, phase: "response" }, "part");
    }
    if (["response.created", "response.in_progress", "response.completed", "response.incomplete"].includes(eventType) && event.response) {
      const responsePayload = eventType === "response.created" || eventType === "response.in_progress"
        ? { ...event.response, status: undefined }
        : event.response;
      const responseIssue = validateResponsesPayload(responsePayload, { ...context, phase: "response" });
      if (responseIssue) return responseIssue;
    }
    if (eventType === "response.incomplete" && !event.response) {
      return createShimCompatibilityIssue({
        ...context,
        path: "response.incomplete_details.reason",
        type: "unknown",
        reason: "Responses incomplete termination lacks a representable reason"
      });
    }
    if (RESPONSES_SHIM_STREAM_LIFECYCLE_EVENTS.has(eventType)) return null;
    return createShimCompatibilityIssue({
      ...context,
      path: "event.type",
      type: eventType || "unknown",
      reason: "unsupported Responses stream event"
    });
  }

  if (sourceProtocol === "messages") {
    const eventType = event.type;
    if (["message_start", "message_delta", "message_stop", "content_block_stop", "ping", "error"].includes(eventType)) {
      if (eventType === "message_start" && hasNonEmptyArray(event?.message?.content)) {
        return validateAnthropicContent(event.message.content, { ...context, phase: "response" }, "message.content");
      }
      if (eventType === "message_delta" && !SUPPORTED_ANTHROPIC_STREAM_STOP_REASONS.has(event?.delta?.stop_reason)) {
        return createShimCompatibilityIssue({
          ...context,
          path: "delta.stop_reason",
          type: event?.delta?.stop_reason || "unknown",
          reason: "Anthropic termination reason cannot be represented by the target protocol"
        });
      }
      return null;
    }
    if (eventType === "content_block_start") {
      return validateAnthropicContent([event.content_block], { ...context, phase: "response" }, "content_block");
    }
    if (eventType === "content_block_delta") {
      const deltaType = event?.delta?.type;
      if (deltaType === "text_delta" || deltaType === "input_json_delta") return null;
      if (deltaType === "thinking_delta" && (targetProtocol === "chat/completions" || targetProtocol === "responses")) return null;
      if (deltaType === "signature_delta" && targetProtocol === "responses") return null;
      return createShimCompatibilityIssue({
        ...context,
        path: "delta.type",
        type: deltaType || "unknown",
        reason: "unsupported Anthropic stream delta"
      });
    }
    return createShimCompatibilityIssue({
      ...context,
      path: "event.type",
      type: eventType || "unknown",
      reason: "unsupported Anthropic stream event"
    });
  }

  if (event.type === "error" || event.error) return null;
  const choices = Array.isArray(event.choices) ? event.choices : [];
  if (choices.length > 1) {
    return createShimCompatibilityIssue({
      ...context,
      path: "choices",
      type: "multiple_choices",
      reason: "the target protocol cannot preserve multiple completion candidates"
    });
  }
  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
    const choice = choices[choiceIndex];
    const delta = choice?.delta || {};
    if (!SUPPORTED_CHAT_STREAM_FINISH_REASONS.has(choice?.finish_reason)) {
      return createShimCompatibilityIssue({
        ...context,
        path: `choices[${choiceIndex}].finish_reason`,
        type: choice?.finish_reason || "unknown",
        reason: "Chat termination reason cannot be represented by the target protocol"
      });
    }
    if (delta.function_call != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: `choices[${choiceIndex}].delta.function_call`,
        type: "function_call",
        reason: "legacy Chat function-call deltas cannot be converted losslessly"
      });
    }
    for (const field of ["reasoning_content", "refusal", "audio"]) {
      if (delta[field] != null) {
        return createShimCompatibilityIssue({
          ...context,
          path: `choices[${choiceIndex}].delta.${field}`,
          type: field,
          reason: "structured Chat stream content is not preserved by the target protocol"
        });
      }
    }
    if (delta.content != null && typeof delta.content !== "string") {
      return createShimCompatibilityIssue({
        ...context,
        path: `choices[${choiceIndex}].delta.content`,
        type: typeof delta.content,
        reason: "structured Chat stream content is not preserved by the target protocol"
      });
    }
    if (choice?.logprobs != null) {
      return createShimCompatibilityIssue({
        ...context,
        path: `choices[${choiceIndex}].logprobs`,
        type: "logprobs",
        reason: "Chat stream logprobs are not preserved by the target protocol"
      });
    }
    for (let toolIndex = 0; toolIndex < (Array.isArray(delta.tool_calls) ? delta.tool_calls.length : 0); toolIndex += 1) {
      const toolCall = delta.tool_calls[toolIndex];
      if (toolCall?.type && toolCall.type !== "function") {
        return createShimCompatibilityIssue({
          ...context,
          path: `choices[${choiceIndex}].delta.tool_calls[${toolIndex}]`,
          type: toolCall.type,
          reason: "only function tool calls can be converted across protocols"
        });
      }
    }
  }
  return null;
}

function extractLastUserTextFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const textParts = [];
      for (const part of c) {
        if (!part) continue;
        if (typeof part === "string") {
          textParts.push(part);
        } else if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        } else if (part.type === "input_text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      return textParts.join("");
    }
  }
  return "";
}

function normalizeMessageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (!part) continue;
      if (typeof part === "string") {
        textParts.push(part);
      } else if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.type === "input_text" && typeof part.text === "string") {
        textParts.push(part.text);
      }
    }
    return textParts.join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function normalizeMessageContentForResponses(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeMessageContentToText(content);

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
      continue;
    }
    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if ((part.type === "image_url" || part.type === "input_image" || part.type === "image") && typeof imageUrl === "string") {
      parts.push({
        type: "input_image",
        image_url: imageUrl,
        ...(part.detail || part.image_url?.detail ? { detail: part.detail || part.image_url.detail } : {})
      });
      continue;
    }
    if (part.type === "input_image" && typeof part.file_id === "string") {
      parts.push({ type: "input_image", file_id: part.file_id, ...(part.detail ? { detail: part.detail } : {}) });
      continue;
    }
    if (part.type === "input_file") {
      parts.push({ ...part });
    }
  }
  return parts.length ? parts : "";
}

function collectToolCallIds(toolCalls) {
  const ids = new Set();
  for (const call of toolCalls) {
    const id = call?.id || call?.call_id;
    if (typeof id === "string" && id) {
      ids.add(id);
    }
  }
  return ids;
}

export function sanitizeChatToolTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages,
      changed: false,
      droppedToolMessages: 0,
      droppedAssistantTurns: 0
    };
  }

  const sanitized = [];
  let changed = false;
  let droppedToolMessages = 0;
  let droppedAssistantTurns = 0;
  let pendingToolTurn = null;

  const flushPendingToolTurn = () => {
    if (!pendingToolTurn) return;
    if (pendingToolTurn.isComplete) {
      sanitized.push(pendingToolTurn.message, ...pendingToolTurn.toolMessages);
    } else {
      changed = true;
      droppedAssistantTurns += 1;
      droppedToolMessages += pendingToolTurn.toolMessages.length + pendingToolTurn.discardedToolMessages;
    }
    pendingToolTurn = null;
  };

  for (const message of messages) {
    if (pendingToolTurn) {
      if (message?.role === "tool") {
        const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
        if (
          toolCallId
          && pendingToolTurn.expectedToolCallIds.has(toolCallId)
          && !pendingToolTurn.seenToolCallIds.has(toolCallId)
        ) {
          pendingToolTurn.toolMessages.push(message);
          pendingToolTurn.seenToolCallIds.add(toolCallId);
          pendingToolTurn.isComplete =
            pendingToolTurn.seenToolCallIds.size === pendingToolTurn.expectedToolCallIds.size;
        } else {
          changed = true;
          pendingToolTurn.discardedToolMessages += 1;
        }
        continue;
      }

      flushPendingToolTurn();
    }

    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const expectedToolCallIds = collectToolCallIds(message.tool_calls);
      if (expectedToolCallIds.size === 0) {
        changed = true;
        droppedAssistantTurns += 1;
        continue;
      }

      pendingToolTurn = {
        message,
        expectedToolCallIds,
        seenToolCallIds: new Set(),
        toolMessages: [],
        discardedToolMessages: 0,
        isComplete: false
      };
      continue;
    }

    if (message?.role === "tool") {
      changed = true;
      droppedToolMessages += 1;
      continue;
    }

    sanitized.push(message);
  }

  flushPendingToolTurn();

  if (!changed) {
    return {
      messages,
      changed: false,
      droppedToolMessages: 0,
      droppedAssistantTurns: 0
    };
  }

  return {
    messages: sanitized,
    changed,
    droppedToolMessages,
    droppedAssistantTurns
  };
}

function buildResponsesInputFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const input = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const role = m.role;
    if (role === "system" || role === "developer") continue;
    if (role === "assistant") {
      const content = normalizeMessageContentForResponses(m.content, role);
      if ((typeof content === "string" && content) || (Array.isArray(content) && content.length > 0)) {
        input.push({ type: "message", role, content });
      }
      for (const call of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!call || call.type !== "function") continue;
        const name = call.function?.name || call.name;
        if (!name) continue;
        input.push({
          type: "function_call",
          call_id: call.id || call.call_id,
          name,
          arguments: call.function?.arguments || call.arguments || ""
        });
      }
      continue;
    }
    if (role === "tool" && m.tool_call_id && typeof m.content === "string") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content
      });
      continue;
    }
    if (role === "user") {
      const content = normalizeMessageContentForResponses(m.content, role);
      input.push({
        type: "message",
        role,
        content
      });
    }
  }
  return input;
}

function coerceToText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    const texts = [];
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
      } else if (item && typeof item === "object") {
        if (typeof item.text === "string") texts.push(item.text);
        else if (typeof item.content === "string") texts.push(item.content);
      }
    }
    return texts.join("\n");
  }
  if (typeof input === "object") {
    if (typeof input.text === "string") return input.text;
  }
  return "";
}

function extractInstructionTextFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const instructions = [];
  for (const m of messages) {
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    const c = m.content;
    if (typeof c === "string" && c) {
      instructions.push(c);
      continue;
    }
    if (Array.isArray(c)) {
      const textParts = [];
      for (const part of c) {
        if (!part) continue;
        if (typeof part === "string") {
          textParts.push(part);
        } else if (part.type === "text" && typeof part.text === "string") {
          textParts.push(part.text);
        } else if (part.type === "input_text" && typeof part.text === "string") {
          textParts.push(part.text);
        }
      }
      const text = textParts.join("");
      if (text) instructions.push(text);
    }
  }
  return instructions.join("\n\n");
}

function normalizeToolsForResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const name = tool.function.name;
      if (!name) continue;
      out.push({
        type: "function",
        name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict
      });
      continue;
    }
    if (tool.type === "function" && tool.name) {
      out.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict
      });
      continue;
    }
    out.push(tool);
  }
  return out.length ? out : undefined;
}

function normalizeFunctionsForResponses(functions) {
  if (!Array.isArray(functions)) return undefined;
  const out = [];
  for (const fn of functions) {
    if (!fn || typeof fn !== "object" || !fn.name) continue;
    out.push({
      type: "function",
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters
    });
  }
  return out.length ? out : undefined;
}

function normalizeResponseFormatForResponses(responseFormat) {
  if (!responseFormat) return undefined;
  if (typeof responseFormat === "string") {
    return { type: responseFormat };
  }
  if (typeof responseFormat === "object" && responseFormat.type) {
    if (responseFormat.type === "json_schema") {
      const jsonSchema = responseFormat.json_schema && typeof responseFormat.json_schema === "object"
        ? responseFormat.json_schema
        : responseFormat;
      if (!jsonSchema.name || !jsonSchema.schema) return undefined;
      return {
        type: "json_schema",
        name: jsonSchema.name,
        schema: jsonSchema.schema,
        ...(jsonSchema.strict != null ? { strict: jsonSchema.strict } : {}),
        ...(jsonSchema.description ? { description: jsonSchema.description } : {})
      };
    }
    return responseFormat;
  }
  return undefined;
}

function normalizeToolChoiceForResponses(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice === "object") {
    const toolType = normalizeWebSearchToolType(toolChoice.type);
    if (toolType === "web_search") {
      return { ...toolChoice, type: toolType };
    }
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "function", name: toolChoice.function.name };
    }
    if (toolChoice.type === "function" && toolChoice.name) {
      return { type: "function", name: toolChoice.name };
    }
  }
  return undefined;
}

function normalizeResponsesContentToChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && typeof content.text === "string") {
      return content.text;
    }
    return "";
  }

  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }

    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text")
      && typeof part.text === "string"
    ) {
      parts.push({ type: "text", text: part.text });
      continue;
    }

    const imageUrl = typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
    if ((part.type === "input_image" || part.type === "image") && typeof imageUrl === "string") {
      parts.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
          ...(part.detail ? { detail: part.detail } : {})
        }
      });
    }
  }

  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

function buildChatMessagesFromResponsesInput(input, instructions) {
  const messages = [];
  let pendingToolCalls = [];
  let pendingReasoningBlocks = [];

  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const pushMessage = (message) => {
    if (!message || !message.role) return;
    const next = { ...message };
    if (typeof next.content === "string" && !next.content && !Array.isArray(next.tool_calls)) {
      delete next.content;
    }
    messages.push(next);
  };

  const flushAssistantItems = () => {
    if (!pendingToolCalls.length && !pendingReasoningBlocks.length) return;
    pushMessage({
      role: "assistant",
      content: pendingReasoningBlocks,
      ...(pendingToolCalls.length ? { tool_calls: pendingToolCalls } : {})
    });
    pendingToolCalls = [];
    pendingReasoningBlocks = [];
  };

  const mapInputItem = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      flushAssistantItems();
      pushMessage({ role: "user", content: item });
      return;
    }
    if (typeof item !== "object") return;

    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || ""
        }
      });
      return;
    }

    if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      const thinking = (Array.isArray(item.summary) ? item.summary : [])
        .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      pendingReasoningBlocks.push({ type: "thinking", thinking, signature: item.encrypted_content });
      return;
    }

    flushAssistantItems();

    if (item.type === "function_call_output") {
      pushMessage({
        role: "tool",
        tool_call_id: item.call_id,
        content: coerceToText(item.output)
      });
      return;
    }

    if (item.type === "message" || item.role) {
      const role = item.role || "user";
      pushMessage({
        role: role === "developer" ? "system" : role,
        content: normalizeResponsesContentToChatContent(item.content)
      });
      return;
    }

    const text = coerceToText(item);
    if (text) pushMessage({ role: "user", content: text });
  };

  if (Array.isArray(input)) {
    for (const item of input) mapInputItem(item);
  } else if (input != null) {
    mapInputItem(input);
  }
  flushAssistantItems();

  return messages;
}

function normalizeToolsForChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") {
      const name = tool.function.name;
      if (!name) continue;
      out.push({
        type: "function",
        function: {
          name,
          description: tool.function.description,
          parameters: tool.function.parameters,
          strict: tool.function.strict
        }
      });
      continue;
    }
    if (tool.type === "function" && tool.name) {
      out.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict
        }
      });
    }
  }
  return out.length ? out : undefined;
}

function normalizeToolChoiceForChat(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = toolChoice.function?.name || toolChoice.name;
    if (!name) return undefined;
    return {
      type: "function",
      function: { name }
    };
  }
  return undefined;
}

function normalizeResponseFormatForChat(textConfig) {
  const format = textConfig?.format;
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "json_object") {
    return { type: "json_object" };
  }
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name,
        schema: format.schema,
        strict: format.strict,
        description: format.description
      }
    };
  }
  return undefined;
}

function anthropicSystemToText(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function anthropicImageToChatPart(source) {
  if (!source || typeof source !== "object") return null;
  if (
    source.type === "base64"
    && typeof source.media_type === "string"
    && typeof source.data === "string"
  ) {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type};base64,${source.data}` }
    };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

function anthropicImageToResponsesPart(source) {
  const chatPart = anthropicImageToChatPart(source);
  const imageUrl = chatPart?.image_url?.url;
  return imageUrl ? { type: "input_image", image_url: imageUrl } : null;
}

function anthropicContentToResponsesContent(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeMessageContentToText(content);

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const imagePart = anthropicImageToResponsesPart(block.source);
      if (imagePart) parts.push(imagePart);
    }
  }
  if (!parts.length) return "";
  if (parts.every((part) => part.type === "input_text" || part.type === "output_text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

function buildResponsesInputFromAnthropic(messages) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const blocks = Array.isArray(message.content) ? message.content : null;
    if (!blocks) {
      const content = anthropicContentToResponsesContent(message.content, message.role);
      if (content !== "") input.push({ type: "message", role: message.role, content });
      continue;
    }

    let messageBlocks = [];
    const flushMessageBlocks = () => {
      const content = anthropicContentToResponsesContent(messageBlocks, message.role);
      if (content !== "") input.push({ type: "message", role: message.role, content });
      messageBlocks = [];
    };

    for (const block of blocks) {
      if (block?.type === "text" || block?.type === "image") {
        messageBlocks.push(block);
        continue;
      }
      flushMessageBlocks();
      if (block?.type === "tool_use" && block.name) {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        });
        continue;
      }
      if (block?.type === "tool_result" && block.tool_use_id) {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: anthropicToolResultToText(block.content),
          ...(block.is_error === true ? { is_error: true } : {})
        });
        continue;
      }
      if (block?.type === "thinking" || block?.type === "redacted_thinking") {
        const summaryText = block.type === "thinking" && typeof block.thinking === "string"
          ? block.thinking
          : "";
        const encryptedContent = block.type === "thinking" ? block.signature : block.data;
        input.push({
          type: "reasoning",
          summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
          ...(typeof encryptedContent === "string" ? { encrypted_content: encryptedContent } : {})
        });
      }
    }
    flushMessageBlocks();
  }
  return input;
}

function anthropicContentToChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeMessageContentToText(content);

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const imagePart = anthropicImageToChatPart(block.source);
      if (imagePart) parts.push(imagePart);
    }
  }

  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

function anthropicToolResultToText(content) {
  if (typeof content === "string") return content;
  const text = normalizeMessageContentToText(content);
  if (text) return text;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function buildChatMessagesFromAnthropic(body) {
  const messages = [];
  const system = anthropicSystemToText(body?.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const blocks = Array.isArray(message.content) ? message.content : [];

    if (message.role === "assistant") {
      const toolCalls = [];
      for (const block of blocks) {
        if (block?.type !== "tool_use" || !block.name) continue;
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          }
        });
      }
      const content = anthropicContentToChatContent(message.content);
      if (content !== "" || toolCalls.length) {
        messages.push({
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        });
      }
      continue;
    }

    if (!Array.isArray(message.content)) {
      const content = anthropicContentToChatContent(message.content);
      if (content !== "") messages.push({ role: "user", content });
      continue;
    }

    let regularBlocks = [];
    const flushRegularBlocks = () => {
      const content = anthropicContentToChatContent(regularBlocks);
      if (content !== "") messages.push({ role: "user", content });
      regularBlocks = [];
    };
    for (const block of blocks) {
      if (block?.type !== "tool_result") {
        regularBlocks.push(block);
        continue;
      }
      flushRegularBlocks();
      if (!block.tool_use_id) continue;
      messages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: anthropicToolResultToText(block.content)
      });
    }
    flushRegularBlocks();
  }

  return messages;
}

function normalizeAnthropicToolsForChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = tools
    .filter((tool) => tool && typeof tool === "object" && tool.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} }
      }
    }));
  return normalized.length ? normalized : undefined;
}

function normalizeAnthropicToolsForResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = tools
    .filter((tool) => tool && typeof tool === "object" && tool.name)
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: "object", properties: {} }
    }));
  return normalized.length ? normalized : undefined;
}

function normalizeAnthropicToolChoiceForChat(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function normalizeAnthropicToolChoiceForResponses(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", name: toolChoice.name };
  }
  return undefined;
}

function chatImageToAnthropicBlock(part) {
  const imageUrl = typeof part?.image_url === "string"
    ? part.image_url
    : part?.image_url?.url;
  if (typeof imageUrl !== "string" || !imageUrl) return null;
  const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  if (dataMatch) {
    return {
      type: "image",
      source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] }
    };
  }
  return { type: "image", source: { type: "url", url: imageUrl } };
}

function chatContentToAnthropicBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = normalizeMessageContentToText(content);
    return text ? [{ type: "text", text }] : [];
  }

  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if ((part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "thinking" && typeof part.thinking === "string" && typeof part.signature === "string") {
      blocks.push({ type: "thinking", thinking: part.thinking, signature: part.signature });
      continue;
    }
    if (part.type === "redacted_thinking" && typeof part.data === "string") {
      blocks.push({ type: "redacted_thinking", data: part.data });
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
      const imageBlock = chatImageToAnthropicBlock(part);
      if (imageBlock) blocks.push(imageBlock);
    }
  }
  return blocks;
}

function parseToolArguments(argumentsText) {
  if (argumentsText && typeof argumentsText === "object") return argumentsText;
  if (typeof argumentsText !== "string" || !argumentsText.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value: argumentsText };
  }
}

function appendAnthropicMessage(messages, role, blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function buildAnthropicMessagesFromChat(messages) {
  const output = [];
  const systemParts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.role) continue;
    if (message.role === "system" || message.role === "developer") {
      const text = normalizeMessageContentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      appendAnthropicMessage(output, "user", [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content ?? ""
      }]);
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;

    const blocks = chatContentToAnthropicBlocks(message.content);
    if (message.role === "assistant") {
      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = toolCall?.function?.name || toolCall?.name;
        if (!name) continue;
        blocks.push({
          type: "tool_use",
          id: toolCall.id || toolCall.call_id,
          name,
          input: parseToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments)
        });
      }
    }
    appendAnthropicMessage(output, message.role, blocks);
  }
  return { messages: output, system: systemParts.join("\n\n") };
}

function buildAnthropicMessagesFromResponses(input) {
  const messages = [];
  const systemParts = [];
  const items = Array.isArray(input) ? input : [input];
  for (const item of items) {
    if (typeof item === "string") {
      appendAnthropicMessage(messages, "user", [{ type: "text", text: item }]);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const thinking = (Array.isArray(item.summary) ? item.summary : [])
        .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      appendAnthropicMessage(messages, "assistant", [{
        type: "thinking",
        thinking,
        ...(typeof item.encrypted_content === "string" ? { signature: item.encrypted_content } : {})
      }]);
      continue;
    }
    if (item.type === "function_call" && item.name) {
      appendAnthropicMessage(messages, "assistant", [{
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseToolArguments(item.arguments)
      }]);
      continue;
    }
    if (item.type === "function_call_output" && item.call_id) {
      appendAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id,
        content: coerceToText(item.output),
        ...(item.is_error === true ? { is_error: true } : {})
      }]);
      continue;
    }
    if (item.type === "message" || item.role) {
      const role = item.role || "user";
      const blocks = chatContentToAnthropicBlocks(item.content);
      if (role === "system" || role === "developer") {
        const text = blocks
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text) systemParts.push(text);
      } else if (role === "user" || role === "assistant") {
        appendAnthropicMessage(messages, role, blocks);
      }
    }
  }
  return { messages, system: systemParts.join("\n\n") };
}

function normalizeChatToolsForAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = [];
  for (const tool of tools) {
    const fn = tool?.type === "function" ? (tool.function || tool) : null;
    if (!fn?.name) continue;
    normalized.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: "object", properties: {} }
    });
  }
  return normalized.length ? normalized : undefined;
}

function normalizeResponsesToolsForAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = [];
  for (const tool of tools) {
    if (tool?.type !== "function") continue;
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    if (!fn.name) continue;
    normalized.push({
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters ?? { type: "object", properties: {} }
    });
  }
  return normalized.length ? normalized : undefined;
}

function normalizeChatToolChoiceForAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return { type: "none" };
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = toolChoice.function?.name || toolChoice.name;
    return name ? { type: "tool", name } : undefined;
  }
  return undefined;
}

function normalizeResponsesToolChoiceForAnthropic(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return { type: "none" };
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = toolChoice.function?.name || toolChoice.name;
    return name ? { type: "tool", name } : undefined;
  }
  return undefined;
}

export function messagesToChatRequest(body, deployment, descriptor) {
  const out = { ...body, model: deployment };
  out.messages = buildChatMessagesFromAnthropic(body);

  const tools = normalizeAnthropicToolsForChat(body?.tools);
  if (tools) out.tools = tools;
  else delete out.tools;

  const toolChoice = normalizeAnthropicToolChoiceForChat(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  else delete out.tool_choice;

  if (body?.stop_sequences != null) out.stop = body.stop_sequences;
  transferReasoning(out, body, "messages", "chat/completions", descriptor);
  delete out.system;
  delete out.stop_sequences;
  delete out.thinking;
  delete out.output_config;
  delete out.top_k;
  delete out.metadata;
  return out;
}

export function chatToMessagesRequest(body, deployment, descriptor) {
  const converted = buildAnthropicMessagesFromChat(body?.messages);
  const out = { ...body, model: deployment, messages: converted.messages };
  const existingSystem = anthropicSystemToText(body?.system);
  const system = [existingSystem, converted.system].filter(Boolean).join("\n\n");
  if (system) out.system = system;
  else delete out.system;

  const tools = normalizeChatToolsForAnthropic(body?.tools);
  if (tools) out.tools = tools;
  else delete out.tools;

  const toolChoice = normalizeChatToolChoiceForAnthropic(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  else delete out.tool_choice;

  out.max_tokens = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? 4096;
  if (body?.stop != null) out.stop_sequences = body.stop;
  if (transferReasoning(out, body, "chat/completions", "messages", descriptor)) {
    ensureMessagesThinking(out, descriptor);
  }

  delete out.max_completion_tokens;
  delete out.max_output_tokens;
  delete out.stop;
  delete out.functions;
  delete out.function_call;
  delete out.response_format;
  delete out.text;
  delete out.reasoning;
  delete out.reasoning_effort;
  delete out.stream_options;
  delete out.n;
  delete out.best_of;
  delete out.seed;
  delete out.logprobs;
  delete out.top_logprobs;
  delete out.frequency_penalty;
  delete out.presence_penalty;
  delete out.logit_bias;
  delete out.prediction;
  delete out.modalities;
  return out;
}

export function messagesToResponsesRequest(body, deployment, descriptor) {
  const out = { ...body, model: deployment };
  const instructions = anthropicSystemToText(body?.system);
  if (instructions) out.instructions = instructions;
  else delete out.instructions;
  out.input = buildResponsesInputFromAnthropic(body?.messages);

  const tools = normalizeAnthropicToolsForResponses(body?.tools);
  if (tools) out.tools = tools;
  else delete out.tools;

  const toolChoice = normalizeAnthropicToolChoiceForResponses(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  else delete out.tool_choice;
  if (body?.tool_choice?.disable_parallel_tool_use === true) {
    out.parallel_tool_calls = false;
  }

  if (typeof body?.max_tokens === "number") out.max_output_tokens = body.max_tokens;
  if (body?.stop_sequences != null) out.stop = body.stop_sequences;
  transferReasoning(out, body, "messages", "responses", descriptor);

  delete out.messages;
  delete out.system;
  delete out.max_tokens;
  delete out.stop_sequences;
  delete out.thinking;
  delete out.output_config;
  return out;
}

export function responsesToMessagesRequest(body, deployment, descriptor) {
  const converted = buildAnthropicMessagesFromResponses(body?.input);
  const out = { ...body, model: deployment, messages: converted.messages };
  const instructions = coerceToText(body?.instructions);
  const system = [instructions, converted.system].filter(Boolean).join("\n\n");
  if (system) out.system = system;
  else delete out.system;

  const tools = normalizeResponsesToolsForAnthropic(body?.tools);
  if (tools) out.tools = tools;
  else delete out.tools;

  const toolChoice = normalizeResponsesToolChoiceForAnthropic(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  else delete out.tool_choice;
  if (body?.parallel_tool_calls === false && out.tool_choice && typeof out.tool_choice === "object") {
    out.tool_choice.disable_parallel_tool_use = true;
  }

  out.max_tokens = body?.max_output_tokens ?? body?.max_tokens ?? 4096;
  if (body?.stop != null) out.stop_sequences = body.stop;
  const effort = transferReasoning(out, body, "responses", "messages", descriptor);
  if (effort) ensureMessagesThinking(out, descriptor);
  if (
    Array.isArray(body?.include)
    && body.include.includes("reasoning.encrypted_content")
  ) {
    ensureMessagesThinking(out, descriptor);
  }

  delete out.input;
  delete out.instructions;
  delete out.max_output_tokens;
  delete out.stop;
  delete out.text;
  delete out.reasoning;
  delete out.include;
  delete out.parallel_tool_calls;
  delete out.stream_options;
  delete out.background;
  delete out.context_management;
  delete out.conversation;
  delete out.max_tool_calls;
  delete out.previous_response_id;
  delete out.prompt;
  delete out.prompt_cache_key;
  delete out.prompt_cache_retention;
  delete out.store;
  delete out.truncation;
  return out;
}

export function chatToResponsesRequest(body, deployment, descriptor) {
  const messages = body?.messages;
  const text = extractLastUserTextFromMessages(messages);
  const instructionText = extractInstructionTextFromMessages(messages);
  const inputItems = buildResponsesInputFromMessages(messages);
  const out = {
    ...body,
    model: deployment
  };
  if (out.service_tier == null && out.serviceTier != null) {
    out.service_tier = out.serviceTier;
  }
  if (out.input == null) {
    out.input = inputItems.length ? inputItems : text;
  }
  delete out.messages;

  if (!out.instructions && instructionText) {
    out.instructions = instructionText;
  }

  const normalizedTools = normalizeToolsForResponses(out.tools)
    ?? normalizeFunctionsForResponses(out.functions);
  if (normalizedTools) out.tools = normalizedTools;
  else delete out.tools;
  delete out.functions;

  if (out.function_call) {
    out.tool_choice = typeof out.function_call === "string"
      ? normalizeToolChoiceForResponses(out.function_call)
      : normalizeToolChoiceForResponses({
        type: "function",
        name: out.function_call.name
      });
    delete out.function_call;
  }

  const normalizedToolChoice = normalizeToolChoiceForResponses(out.tool_choice);
  if (normalizedToolChoice !== undefined) out.tool_choice = normalizedToolChoice;
  else delete out.tool_choice;

  if (out.max_output_tokens == null) {
    if (typeof out.max_completion_tokens === "number") {
      out.max_output_tokens = out.max_completion_tokens;
    } else if (typeof out.max_tokens === "number") {
      out.max_output_tokens = out.max_tokens;
    }
  }
  delete out.max_tokens;
  delete out.max_completion_tokens;

  transferReasoning(out, body, "chat/completions", "responses", descriptor);
  delete out.reasoning_effort;

  const normalizedFormat = normalizeResponseFormatForResponses(out.response_format);
  if (normalizedFormat) {
    out.text = {
      ...(out.text && typeof out.text === "object" ? out.text : {}),
      format: normalizedFormat
    };
  }
  delete out.response_format;

  delete out.stop;
  delete out.n;
  delete out.best_of;
  delete out.stream_options;
  delete out.serviceTier;
  delete out.seed;
  delete out.top_p;
  delete out.top_k;
  delete out.logprobs;
  delete out.top_logprobs;
  delete out.frequency_penalty;
  delete out.presence_penalty;
  delete out.logit_bias;
  delete out.prediction;
  delete out.modalities;
  return out;
}

export function responsesToChatRequest(body, deployment, descriptor) {
  const messages = buildChatMessagesFromResponsesInput(body?.input, body?.instructions);
  const out = {
    ...body,
    model: deployment
  };
  if (out.service_tier == null && out.serviceTier != null) {
    out.service_tier = out.serviceTier;
  }
  delete out.serviceTier;
  if (out.messages == null) {
    out.messages = messages.length ? messages : [{ role: "user", content: coerceToText(body?.input) }];
  }

  const normalizedTools = normalizeToolsForChat(out.tools);
  if (normalizedTools) out.tools = normalizedTools;
  else delete out.tools;

  const normalizedToolChoice = normalizeToolChoiceForChat(out.tool_choice);
  if (normalizedToolChoice !== undefined) out.tool_choice = normalizedToolChoice;
  else if (typeof out.tool_choice !== "string") delete out.tool_choice;

  if (out.response_format == null) {
    const normalizedResponseFormat = normalizeResponseFormatForChat(out.text);
    if (normalizedResponseFormat) out.response_format = normalizedResponseFormat;
  }

  if (out.max_completion_tokens == null && typeof out.max_output_tokens === "number") {
    out.max_completion_tokens = out.max_output_tokens;
  }

  transferReasoning(out, body, "responses", "chat/completions", descriptor);

  delete out.input;
  delete out.instructions;
  delete out.text;
  delete out.max_output_tokens;
  delete out.reasoning;
  delete out.background;
  delete out.context_management;
  delete out.conversation;
  delete out.include;
  delete out.max_tool_calls;
  delete out.previous_response_id;
  delete out.prompt;
  delete out.prompt_cache_key;
  delete out.prompt_cache_retention;
  delete out.store;
  delete out.truncation;
  return out;
}

export function mapResponsesJsonToChatCompletion(payload, modelId) {
  const created = Math.floor(Date.now() / 1000);
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const outputText = payload?.output_text
    ?? output.filter((item) => item?.type === "message")
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .map((content) => content?.text)
      .filter((text) => typeof text === "string")
      .join("")
    ?? "";
  const toolCalls = [];
  if (output.length > 0) {
    let index = 0;
    for (const item of output) {
      if (!item || item.type !== "function_call") continue;
      const callId = item.call_id || item.id || `call_${index}`;
      toolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || ""
        }
      });
      index += 1;
    }
  }
  return {
    id: payload?.id || `chatcmpl_${created}`,
    object: "chat.completion",
    created,
    model: modelId || payload?.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: outputText,
          tool_calls: toolCalls.length ? toolCalls : undefined
        },
        finish_reason: payload?.status === "incomplete" ? "length" : toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: payload?.usage ? (() => {
      const promptTokens = payload.usage.input_tokens ?? payload.usage.prompt_tokens ?? 0;
      const completionTokens = payload.usage.output_tokens ?? payload.usage.completion_tokens ?? 0;
      return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: payload.usage.total_tokens ?? payload.usage.total ?? promptTokens + completionTokens,
      ...(payload.usage.input_tokens_details ? { prompt_tokens_details: payload.usage.input_tokens_details } : {}),
      ...(payload.usage.output_tokens_details ? { completion_tokens_details: payload.usage.output_tokens_details } : {})
      };
    })() : undefined
  };
}

export function mapChatCompletionJsonToResponses(payload, modelId) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const text = message.content ?? choice.text ?? "";
  const responseId = payload?.id || `resp_${Math.floor(Date.now() / 1000)}`;
  const output = [];
  if (typeof text === "string") {
    output.push({
      id: `msg_${responseId}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }]
    });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (toolCall?.type !== "function" || !toolCall.function?.name) continue;
    output.push({
      id: toolCall.id,
      type: "function_call",
      status: "completed",
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments || ""
    });
  }
  const incomplete = choice.finish_reason === "length";
  const usage = payload?.usage ? (() => {
    const inputTokens = payload.usage.prompt_tokens ?? payload.usage.input_tokens ?? 0;
    const outputTokens = payload.usage.completion_tokens ?? payload.usage.output_tokens ?? 0;
    return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: payload.usage.total_tokens ?? payload.usage.total ?? inputTokens + outputTokens,
    ...(payload.usage.prompt_tokens_details ? { input_tokens_details: payload.usage.prompt_tokens_details } : {}),
    ...(payload.usage.completion_tokens_details ? { output_tokens_details: payload.usage.completion_tokens_details } : {})
    };
  })() : undefined;
  return {
    id: responseId,
    object: "response",
    created_at: payload?.created || Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: null,
    model: modelId || payload?.model,
    output,
    output_text: text,
    parallel_tool_calls: true,
    usage
  };
}

function anthropicStopReasonToChat(reason, hasToolCalls) {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use" || hasToolCalls) return "tool_calls";
  return "stop";
}

function chatFinishReasonToAnthropic(reason, hasToolCalls) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls" || hasToolCalls) return "tool_use";
  return "end_turn";
}

export function mapMessagesJsonToChatCompletion(payload, modelId) {
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  for (const block of Array.isArray(payload?.content) ? payload.content : []) {
    if (block?.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (block?.type === "thinking" && typeof block.thinking === "string") {
      reasoning.push(block.thinking);
      continue;
    }
    if (block?.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      });
    }
  }
  const usage = payload?.usage ? (() => {
    const uncachedInputTokens = payload.usage.input_tokens ?? 0;
    const cachedTokens = payload.usage.cache_read_input_tokens ?? payload.usage.cached_tokens ?? 0;
    const cacheCreationTokens = payload.usage.cache_creation_input_tokens ?? 0;
    const promptTokens = uncachedInputTokens + cachedTokens + cacheCreationTokens;
    const completionTokens = payload.usage.output_tokens ?? 0;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: payload.usage.total_tokens ?? promptTokens + completionTokens,
      ...((payload.usage.cache_read_input_tokens ?? payload.usage.cached_tokens) != null
        ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
        : {})
    };
  })() : undefined;
  return {
    id: payload?.id || `chatcmpl_${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion",
    created: payload?.created_at || Math.floor(Date.now() / 1000),
    model: modelId || payload?.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text.join(""),
        ...(reasoning.length ? { reasoning_content: reasoning.join("") } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      finish_reason: anthropicStopReasonToChat(payload?.stop_reason, toolCalls.length > 0)
    }],
    usage
  };
}

export function mapChatCompletionJsonToMessages(payload, modelId) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = toolCall?.function?.name || toolCall?.name;
    if (!name) continue;
    content.push({
      type: "tool_use",
      id: toolCall.id || toolCall.call_id,
      name,
      input: parseToolArguments(toolCall?.function?.arguments ?? toolCall?.arguments)
    });
  }
  const usage = payload?.usage ? (() => {
    const promptTokens = payload.usage.prompt_tokens ?? payload.usage.input_tokens ?? 0;
    const cachedTokens = payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.cached_tokens ?? 0;
    return {
      input_tokens: Math.max(0, promptTokens - cachedTokens),
      output_tokens: payload.usage.completion_tokens ?? payload.usage.output_tokens ?? 0,
      ...((payload.usage.prompt_tokens_details?.cached_tokens ?? payload.usage.cached_tokens) != null
        ? { cache_read_input_tokens: cachedTokens }
        : {})
    };
  })() : undefined;
  return {
    id: payload?.id || `msg_${Math.floor(Date.now() / 1000)}`,
    type: "message",
    role: "assistant",
    model: modelId || payload?.model,
    content,
    stop_reason: chatFinishReasonToAnthropic(choice.finish_reason, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage
  };
}

export function mapMessagesJsonToResponses(payload, modelId, { includeEncryptedContent = false } = {}) {
  const responseId = payload?.id || `resp_${Math.floor(Date.now() / 1000)}`;
  const output = [];
  let messageContent = [];
  let messageItemIndex = 0;
  const flushMessage = () => {
    if (!messageContent.length) return;
    output.push({
      id: messageItemIndex === 0 ? `msg_${responseId}` : `msg_${responseId}_${messageItemIndex}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: messageContent
    });
    messageItemIndex += 1;
    messageContent = [];
  };

  for (const [index, block] of (Array.isArray(payload?.content) ? payload.content : []).entries()) {
    if (block?.type === "text" && typeof block.text === "string") {
      messageContent.push({
        type: "output_text",
        text: block.text,
        annotations: Array.isArray(block.citations) ? block.citations : [],
        logprobs: []
      });
      continue;
    }
    flushMessage();
    if (block?.type === "tool_use" && block.name) {
      output.push({
        id: block.id,
        type: "function_call",
        status: "completed",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {})
      });
      continue;
    }
    if (block?.type === "thinking" || block?.type === "redacted_thinking") {
      const summaryText = block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
      const encryptedContent = block.type === "thinking" ? block.signature : block.data;
      output.push({
        id: `rs_${payload?.id || "message"}_${index}`,
        type: "reasoning",
        summary: summaryText ? [{ type: "summary_text", text: summaryText }] : [],
        ...(includeEncryptedContent && typeof encryptedContent === "string"
          ? { encrypted_content: encryptedContent }
          : {})
      });
    }
  }
  flushMessage();

  const inputTokens = payload?.usage
    ? (payload.usage.input_tokens ?? 0)
      + (payload.usage.cache_read_input_tokens ?? payload.usage.cached_tokens ?? 0)
      + (payload.usage.cache_creation_input_tokens ?? 0)
    : 0;
  const outputTokens = payload?.usage?.output_tokens ?? 0;
  const cachedTokens = payload?.usage?.cache_read_input_tokens ?? payload?.usage?.cached_tokens;
  const incomplete = payload?.stop_reason === "max_tokens";
  return {
    id: responseId,
    object: "response",
    created_at: payload?.created_at || Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    error: null,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    instructions: null,
    model: modelId || payload?.model,
    output,
    output_text: output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content)
      .map((part) => part.text)
      .join(""),
    parallel_tool_calls: true,
    usage: payload?.usage ? {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: payload.usage.total_tokens ?? inputTokens + outputTokens,
      ...(cachedTokens != null ? { input_tokens_details: { cached_tokens: cachedTokens } } : {})
    } : undefined
  };
}

export function mapResponsesJsonToMessages(payload, modelId) {
  const content = [];
  let hasToolUse = false;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
          content.push({
            type: "text",
            text: part.text,
            ...(Array.isArray(part.annotations) && part.annotations.length ? { citations: part.annotations } : {})
          });
        }
      }
      continue;
    }
    if (item?.type === "function_call" && item.name) {
      hasToolUse = true;
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input: parseToolArguments(item.arguments)
      });
      continue;
    }
    if (item?.type === "reasoning") {
      const thinking = (Array.isArray(item.summary) ? item.summary : [])
        .filter((part) => part?.type === "summary_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (thinking) {
        content.push({
          type: "thinking",
          thinking,
          ...(typeof item.encrypted_content === "string" ? { signature: item.encrypted_content } : {})
        });
      } else if (typeof item.encrypted_content === "string") {
        content.push({ type: "redacted_thinking", data: item.encrypted_content });
      }
    }
  }

  const inputTokens = payload?.usage?.input_tokens ?? payload?.usage?.prompt_tokens ?? 0;
  const outputTokens = payload?.usage?.output_tokens ?? payload?.usage?.completion_tokens ?? 0;
  const cachedTokens = payload?.usage?.input_tokens_details?.cached_tokens ?? payload?.usage?.cached_tokens;
  const incompleteReason = payload?.incomplete_details?.reason;
  return {
    id: payload?.id || `msg_${Math.floor(Date.now() / 1000)}`,
    type: "message",
    role: "assistant",
    model: modelId || payload?.model,
    content,
    stop_reason: payload?.status === "incomplete" && incompleteReason === "max_output_tokens"
      ? "max_tokens"
      : hasToolUse
        ? "tool_use"
        : "end_turn",
    stop_sequence: payload?.stop_sequence ?? null,
    usage: payload?.usage ? {
      input_tokens: Math.max(0, inputTokens - (cachedTokens ?? 0)),
      output_tokens: outputTokens,
      ...(cachedTokens != null ? { cache_read_input_tokens: cachedTokens } : {})
    } : undefined
  };
}
