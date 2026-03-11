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

  const mapInputItem = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      pushMessage({ role: "user", content: item });
      return;
    }
    if (typeof item !== "object") return;

    if (item.type === "function_call") {
      pushMessage({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: item.call_id || item.id,
          type: "function",
          function: {
            name: item.name || "",
            arguments: item.arguments || ""
          }
        }]
      });
      return;
    }

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
    const allowedEfforts = new Set(["low", "medium", "high", "xhigh"]);
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
  const messages = buildChatMessagesFromResponsesInput(body?.input, body?.instructions);
  const out = {
    ...body,
    model: deployment
  };
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

  if (out.reasoning_effort == null && typeof out.reasoning?.effort === "string") {
    out.reasoning_effort = out.reasoning.effort;
  }

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
