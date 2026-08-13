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

function buildResponsesInputFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const input = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const role = m.role;
    if (role === "system" || role === "developer") continue;
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
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
    }
    if (role === "tool" && m.tool_call_id && typeof m.content === "string") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: m.content
      });
      continue;
    }
    if (role === "user" || role === "assistant") {
      const text = normalizeMessageContentToText(m.content);
      input.push({
        type: "message",
        role,
        content: text
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
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

function collectToolCallIds(toolCalls) {
  const ids = new Set();
  for (const call of toolCalls) {
    const id = call?.id || call?.call_id;
    if (typeof id === "string" && id) ids.add(id);
  }
  return ids;
}

export function sanitizeChatToolTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, changed: false, droppedToolMessages: 0, droppedAssistantTurns: 0 };
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
    return { messages, changed: false, droppedToolMessages: 0, droppedAssistantTurns: 0 };
  }
  return { messages: sanitized, changed, droppedToolMessages, droppedAssistantTurns };
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

function normalizeResponsesToolDescriptionList(tools) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace") {
      normalizeResponsesToolDescriptionList(tool.tools);
      continue;
    }
    if (tool.type !== "function" && tool.type !== "custom") continue;
    if (tool.description == null || (typeof tool.description === "string" && !tool.description.trim())) {
      const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
      tool.description = toolName || "Tool";
    }
  }
}

export function normalizeResponsesToolDescriptions(body) {
  normalizeResponsesToolDescriptionList(body?.tools);
  if (!Array.isArray(body?.input)) return;
  for (const item of body.input) {
    if (item?.type === "additional_tools") {
      normalizeResponsesToolDescriptionList(item.tools);
    }
  }
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
    return responseFormat;
  }
  return undefined;
}

function normalizeToolChoiceForResponses(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice === "object") {
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "function", name: toolChoice.function.name };
    }
    if (toolChoice.type === "function" && toolChoice.name) {
      return { type: "function", name: toolChoice.name };
    }
  }
  return undefined;
}

export function chatToResponsesRequest(body, deployment) {
  const messages = body?.messages;
  const text = extractLastUserTextFromMessages(messages);
  const instructionText = extractInstructionTextFromMessages(messages);
  const inputItems = buildResponsesInputFromMessages(messages);
  const out = {
    ...body,
    model: deployment
  };
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
    out.tool_choice = normalizeToolChoiceForResponses({
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

  if (typeof out.reasoning_effort === "string") {
    const effort = out.reasoning_effort.toLowerCase();
    const allowedEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (allowedEfforts.has(effort)) {
      out.reasoning = {
        ...(out.reasoning && typeof out.reasoning === "object" ? out.reasoning : {}),
        effort
      };
    }
  }
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
  delete out.verbosity;
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

export function responsesToChatRequest(body, deployment) {
  const text = coerceToText(body?.input);
  const out = {
    ...body,
    model: deployment
  };
  if (out.messages == null) {
    out.messages = [{ role: "user", content: text }];
  }
  delete out.input;
  return out;
}

export function mapResponsesJsonToChatCompletion(payload, modelId) {
  const created = Math.floor(Date.now() / 1000);
  const outputText = payload?.output_text
    ?? payload?.output?.[0]?.content?.map((c) => c?.text).filter(Boolean).join("")
    ?? "";
  const toolCalls = [];
  if (Array.isArray(payload?.output)) {
    let index = 0;
    for (const item of payload.output) {
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
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: outputText,
          tool_calls: toolCalls.length ? toolCalls : undefined
        },
        finish_reason: toolCalls.length ? "tool_calls" : "stop"
      }
    ],
    usage: payload?.usage
  };
}

export function mapChatCompletionJsonToResponses(payload, modelId) {
  const text = payload?.choices?.[0]?.message?.content
    ?? payload?.choices?.[0]?.text
    ?? "";
  return {
    id: payload?.id,
    object: "response",
    model: modelId,
    output_text: text,
    usage: payload?.usage
  };
}
