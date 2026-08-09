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

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    pushMessage({ role: "assistant", content: "", tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  const mapInputItem = (item) => {
    if (!item) return;
    if (typeof item === "string") {
      flushToolCalls();
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

    flushToolCalls();

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
  flushToolCalls();

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

    const regularBlocks = blocks.filter((block) => block?.type !== "tool_result");
    const regularContent = Array.isArray(message.content)
      ? anthropicContentToChatContent(regularBlocks)
      : anthropicContentToChatContent(message.content);
    if (regularContent !== "") {
      messages.push({ role: "user", content: regularContent });
    }
    for (const block of blocks) {
      if (block?.type !== "tool_result" || !block.tool_use_id) continue;
      messages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: anthropicToolResultToText(block.content)
      });
    }
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

export function messagesToChatRequest(body, deployment) {
  const out = { ...body, model: deployment };
  out.messages = buildChatMessagesFromAnthropic(body);

  const tools = normalizeAnthropicToolsForChat(body?.tools);
  if (tools) out.tools = tools;
  else delete out.tools;

  const toolChoice = normalizeAnthropicToolChoiceForChat(body?.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  else delete out.tool_choice;

  if (body?.stop_sequences != null) out.stop = body.stop_sequences;
  delete out.system;
  delete out.stop_sequences;
  delete out.thinking;
  delete out.output_config;
  delete out.top_k;
  delete out.metadata;
  return out;
}

export function chatToMessagesRequest(body, deployment) {
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

export function messagesToResponsesRequest(body, deployment) {
  return chatToResponsesRequest(messagesToChatRequest(body, deployment), deployment);
}

export function responsesToMessagesRequest(body, deployment) {
  return chatToMessagesRequest(responsesToChatRequest(body, deployment), deployment);
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
    model: payload?.model || modelId,
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
    model: payload?.model || modelId,
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
    model: payload?.model || modelId,
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
    model: payload?.model || modelId,
    content,
    stop_reason: chatFinishReasonToAnthropic(choice.finish_reason, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage
  };
}

export function mapMessagesJsonToResponses(payload, modelId) {
  return mapChatCompletionJsonToResponses(mapMessagesJsonToChatCompletion(payload, modelId), modelId);
}

export function mapResponsesJsonToMessages(payload, modelId) {
  return mapChatCompletionJsonToMessages(mapResponsesJsonToChatCompletion(payload, modelId), modelId);
}
