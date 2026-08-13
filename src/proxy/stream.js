import { markErrorWithCode } from "./reliability.js";
import { getProtocolShimStreamCompatibilityIssue } from "./shim.js";

const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

function sseDataFromBlock(block) {
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "data") {
      dataLines.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return dataLines.length ? dataLines.join("\n") : null;
}

function createSseDataParser() {
  let buffer = "";

  const drain = (final = false) => {
    const payloads = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const payload = sseDataFromBlock(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (payload != null) payloads.push(payload);
    }
    if (final && buffer.trim()) {
      const payload = sseDataFromBlock(buffer);
      buffer = "";
      if (payload != null) payloads.push(payload);
    }
    return payloads;
  };

  return {
    feed(text) {
      buffer += text;
      return drain(false);
    },
    finish(text = "") {
      buffer += text;
      return drain(true);
    },
    get bufferedLength() {
      return buffer.length;
    }
  };
}

function createRawSseParser() {
  let buffer = Buffer.alloc(0);
  const lfDelimiter = Buffer.from("\n\n");
  const crlfDelimiter = Buffer.from("\r\n\r\n");

  const nextEvent = () => {
    const lfIndex = buffer.indexOf(lfDelimiter);
    const crlfIndex = buffer.indexOf(crlfDelimiter);
    if (lfIndex < 0 && crlfIndex < 0) return null;
    const useCrlf = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex);
    const index = useCrlf ? crlfIndex : lfIndex;
    const delimiter = useCrlf ? crlfDelimiter : lfDelimiter;
    const raw = buffer.subarray(0, index + delimiter.length);
    const block = buffer.subarray(0, index).toString("utf8");
    buffer = buffer.subarray(index + delimiter.length);
    return { raw, payload: sseDataFromBlock(block) };
  };

  const drain = () => {
    const events = [];
    while (true) {
      const event = nextEvent();
      if (!event) return events;
      events.push(event);
    }
  };

  return {
    feed(chunk) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      return drain();
    },
    finish() {
      const events = drain();
      if (buffer.length > 0) {
        const raw = buffer;
        buffer = Buffer.alloc(0);
        events.push({ raw, payload: sseDataFromBlock(raw.toString("utf8")) });
      }
      return events;
    },
    get bufferedLength() {
      return buffer.length;
    }
  };
}

function extractAzureRequestId(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/request ID\s+([0-9a-fA-F-]{16,})/i);
  return match ? match[1] : "";
}

function buildProviderStreamError(evt) {
  const error = evt?.error && typeof evt.error === "object"
    ? evt.error
    : (evt?.response?.error && typeof evt.response.error === "object"
        ? evt.response.error
        : (evt?.type === "error" ? evt : {}));
  const message = typeof error.message === "string" ? error.message : "upstream provider stream error";
  const azureRequestId =
    (typeof error.request_id === "string" && error.request_id)
    || (typeof evt?.request_id === "string" && evt.request_id)
    || extractAzureRequestId(message);

  return {
    type: typeof error.type === "string" ? error.type : typeof evt?.type === "string" ? evt.type : "error",
    code: typeof error.code === "string" ? error.code : "UPSTREAM_PROVIDER_STREAM_ERROR",
    message,
    param: error?.param ?? null,
    azureRequestId
  };
}

function createClientDisconnectedError() {
  return markErrorWithCode(new Error("client disconnected"), "CLIENT_DISCONNECTED");
}

async function writeWithBackpressure(replyRaw, data) {
  if (replyRaw.destroyed || replyRaw.writableEnded) {
    throw createClientDisconnectedError();
  }
  if (replyRaw.write(data) !== false || typeof replyRaw.once !== "function") {
    return;
  }
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      replyRaw.removeListener?.("drain", onDrain);
      replyRaw.removeListener?.("close", onClose);
      replyRaw.removeListener?.("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(createClientDisconnectedError());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    replyRaw.once("drain", onDrain);
    replyRaw.once("close", onClose);
    replyRaw.once("error", onError);
  });
}

async function writeSse(replyRaw, dataObj) {
  await writeWithBackpressure(replyRaw, `data: ${JSON.stringify(dataObj)}\n\n`);
}

async function writeAnthropicSse(replyRaw, event) {
  await writeWithBackpressure(
    replyRaw,
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  );
}

async function writeSseDone(replyRaw) {
  await writeWithBackpressure(replyRaw, "data: [DONE]\n\n");
}

function emitOutputDeltas(json, onContent) {
  if (typeof onContent !== "function") return;
  if (json?.type === "response.output_text.delta" && typeof json.delta === "string") {
    onContent(json.delta, "text");
  }
  if (json?.type === "response.function_call_arguments.delta" && typeof json.delta === "string") {
    onContent(json.delta, "tool");
  }
  if (json?.type === "content_block_delta") {
    if (typeof json.delta?.text === "string") {
      onContent(json.delta.text, "text");
    }
    if (typeof json.delta?.thinking === "string") {
      onContent(json.delta.thinking, "text");
    }
    if (typeof json.delta?.partial_json === "string") {
      onContent(json.delta.partial_json, "tool");
    }
  }
  for (const choice of Array.isArray(json?.choices) ? json.choices : []) {
    if (typeof choice?.delta?.content === "string") {
      onContent(choice.delta.content, "text");
    }
    for (const toolCall of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
      if (typeof toolCall?.function?.arguments === "string") {
        onContent(toolCall.function.arguments, "tool");
      }
    }
  }
}

function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const cacheReadTokens = Number(usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  return {
    ...usage,
    total_tokens: Number(usage.total_tokens ?? inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens),
    cached_tokens: cacheReadTokens
  };
}

function normalizeChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const cachedTokens = Number(usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0);
  const cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const hasAnthropicBreakdown = usage.cache_read_input_tokens != null
    || usage.cache_creation_input_tokens != null;
  const sourcePromptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const promptTokens = hasAnthropicBreakdown
    ? sourcePromptTokens + cachedTokens + cacheCreationTokens
    : sourcePromptTokens;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const promptDetails = usage.prompt_tokens_details
    ?? usage.input_tokens_details
    ?? (cachedTokens > 0 ? { cached_tokens: cachedTokens } : null);
  const completionDetails = usage.completion_tokens_details ?? usage.output_tokens_details;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Number(usage.total_tokens ?? usage.total ?? promptTokens + completionTokens),
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    ...(completionDetails ? { completion_tokens_details: completionDetails } : {})
  };
}

function mergeUsageSnapshot(current, update) {
  if (!update || typeof update !== "object") return current;
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(update)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const existing = Number(merged[key]);
      merged[key] = Number.isFinite(existing) ? Math.max(existing, value) : value;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = mergeUsageSnapshot(merged[key], value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function flushSseUsage(usageState, onUsage) {
  if (usageState.recorded) return;
  const usage = usageState.anthropicUsage
    ? normalizeAnthropicUsage(usageState.anthropicUsage)
    : usageState.genericUsage;
  if (!usage) return;
  onUsage?.(usage);
  usageState.recorded = true;
}

function recordSseUsage(json, usageState, onUsage) {
  if (usageState.recorded) return;

  if (json?.type === "message_start" && json.message?.usage) {
    usageState.anthropicUsage = { ...json.message.usage };
    return;
  }

  if (json?.type === "message_delta" && json.usage) {
    usageState.anthropicUsage = mergeUsageSnapshot(usageState.anthropicUsage, {
      ...(usageState.anthropicUsage || {}),
      ...json.usage
    });
    return;
  }

  if (json?.type === "message_stop" && usageState.anthropicUsage) {
    flushSseUsage(usageState, onUsage);
    return;
  }

  const usage = json?.usage || json?.response?.usage;
  if (usage) {
    usageState.genericUsage = mergeUsageSnapshot(usageState.genericUsage, usage);
    if (
      json?.type === "response.completed"
      || json?.type === "response.incomplete"
    ) {
      flushSseUsage(usageState, onUsage);
    }
  }
}

export function setSseResponseHeaders(replyRaw) {
  replyRaw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}

export async function writeSseError(replyRaw, errorBody, routeKey = "chat/completions") {
  const sourceError = errorBody?.error && typeof errorBody.error === "object"
    ? errorBody.error
    : {};
  if (routeKey === "messages") {
    await writeAnthropicSse(replyRaw, {
      type: "error",
      error: {
        type: sourceError.type || sourceError.code || "api_error",
        message: sourceError.message || "stream request failed"
      }
    });
    return;
  }
  if (routeKey === "responses") {
    await writeWithBackpressure(
      replyRaw,
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        code: sourceError.code || errorBody?.code || "server_error",
        message: sourceError.message || "stream request failed",
        param: sourceError.param ?? null
      })}\n\n`
    );
    return;
  }
  await writeSse(replyRaw, errorBody);
  await writeSseDone(replyRaw);
}

export async function writeSseDoneFrame(replyRaw) {
  await writeSseDone(replyRaw);
}

export async function streamPassthrough({
  upstreamResponse,
  reply,
  backendRouteKey = "",
  strictResponsesCompletion = false,
  forwardProviderErrors = false,
  policy,
  onFirstChunk,
  onUsage,
  onModel,
  onContent
}) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return { ok: false, beforeFirstChunk: true, error: markErrorWithCode(new Error("stream body unavailable"), "STREAM_INTERRUPTED") };
  }
  let firstChunkSeen = false;
  let firstByteTimedOut = false;
  let idleTimedOut = false;
  let maxDurationTimedOut = false;
  let idleTimer = null;
  let maxDurationTimer = null;
  const usageState = { recorded: false, anthropicUsage: null, genericUsage: null };
  const sseParser = createRawSseParser();
  let providerError = null;
  let terminalMarkerSeen = false;
  let chatFinishReasonSeen = false;
  let responsesTerminalOutputSeen = false;
  let clientDisconnected = false;

  const processPayload = (payload) => {
    if (!payload) return;
    if (payload === "[DONE]") {
      if (backendRouteKey === "messages") {
        providerError = {
          type: "protocol_error",
          code: "UPSTREAM_INCOMPLETE_STREAM",
          message: "Anthropic Messages stream returned an unexpected [DONE] marker",
          param: null,
          azureRequestId: ""
        };
      } else if (!backendRouteKey || backendRouteKey === "chat/completions") {
        flushSseUsage(usageState, onUsage);
        terminalMarkerSeen = true;
      }
      return;
    }

    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }

    const resolvedModel = event.model || event.response?.model || event.message?.model;
    if (typeof resolvedModel === "string" && resolvedModel) onModel?.(resolvedModel);
    recordSseUsage(event, usageState, onUsage);
    emitOutputDeltas(event, onContent);

    if (event?.type === "error" || event?.type === "response.failed" || (event?.error && typeof event.error === "object")) {
      providerError = buildProviderStreamError(event);
      return;
    }
    if (
      (!backendRouteKey || backendRouteKey === "responses")
      && (event?.type === "response.completed" || event?.type === "response.incomplete")
    ) {
      terminalMarkerSeen = true;
    }
    if (
      backendRouteKey === "responses"
      && [
        "response.output_text.done",
        "response.refusal.done",
        "response.output_item.done",
        "response.function_call_arguments.done",
        "response.reasoning_summary_part.done",
        "response.reasoning_summary_text.done",
        "response.reasoning.done"
      ].includes(event?.type)
    ) {
      responsesTerminalOutputSeen = true;
    }
    if ((!backendRouteKey || backendRouteKey === "messages") && event?.type === "message_stop") {
      terminalMarkerSeen = true;
    }
    if (Array.isArray(event?.choices) && event.choices.some((choice) => choice?.finish_reason)) {
      chatFinishReasonSeen = true;
    }
  };
  if (typeof reply.raw.once === "function") {
    reply.raw.once("close", () => {
      if (reply.raw.writableEnded) return;
      clientDisconnected = true;
      reader.cancel("client-disconnected").catch(() => {});
    });
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const clearMaxDuration = () => {
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  };
  const resetIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      reader.cancel("idle-timeout").catch(() => {});
    }, policy.idleTimeoutMs);
  };
  const firstByteTimer = setTimeout(() => {
    if (!firstChunkSeen) {
      firstByteTimedOut = true;
      reader.cancel("first-byte-timeout").catch(() => {});
    }
  }, policy.firstByteTimeoutMs);
  if (policy.maxStreamDurationMs > 0) {
    maxDurationTimer = setTimeout(() => {
      maxDurationTimedOut = true;
      reader.cancel("max-stream-duration").catch(() => {});
    }, policy.maxStreamDurationMs);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (clientDisconnected) break;
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(firstByteTimer);
        onFirstChunk();
      }
      resetIdle();
      for (const event of sseParser.feed(value)) {
        if (providerError || terminalMarkerSeen) break;
        processPayload(event.payload);
        if (!providerError || forwardProviderErrors) {
          await writeWithBackpressure(reply.raw, event.raw);
        }
      }
      if (sseParser.bufferedLength > MAX_SSE_BUFFER_CHARS) {
        throw markErrorWithCode(new Error("upstream SSE event exceeded buffer limit"), "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      }
      if (providerError || terminalMarkerSeen) {
        await reader.cancel(providerError ? "provider-error" : "terminal-event").catch(() => {});
        break;
      }
    }
    if (!providerError && !terminalMarkerSeen) {
      for (const event of sseParser.finish()) {
        if (providerError || terminalMarkerSeen) break;
        processPayload(event.payload);
        if (!providerError || forwardProviderErrors) {
          await writeWithBackpressure(reply.raw, event.raw);
        }
      }
    }
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearIdle();
    clearMaxDuration();
    return { ok: false, beforeFirstChunk: !firstChunkSeen, error, clientDisconnected };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
  clearMaxDuration();
  if (clientDisconnected) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: createClientDisconnectedError(),
      clientDisconnected: true
    };
  }
  if (firstByteTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: true,
      error: markErrorWithCode(new Error(`first byte timeout after ${policy.firstByteTimeoutMs}ms`), "UPSTREAM_FIRST_BYTE_TIMEOUT")
    };
  }
  if (idleTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(`idle timeout after ${policy.idleTimeoutMs}ms`), "UPSTREAM_IDLE_TIMEOUT")
    };
  }
  if (maxDurationTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(`stream exceeded max duration after ${policy.maxStreamDurationMs}ms`), "UPSTREAM_MAX_STREAM_DURATION")
    };
  }
  if (providerError) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(providerError.message), "UPSTREAM_PROVIDER_STREAM_ERROR"),
      providerErrorForwarded: forwardProviderErrors,
      providerError
    };
  }
  if (backendRouteKey === "chat/completions" && chatFinishReasonSeen) {
    flushSseUsage(usageState, onUsage);
  }
  if (
    !terminalMarkerSeen
    && !(backendRouteKey === "chat/completions" && chatFinishReasonSeen)
    && !(backendRouteKey === "responses" && responsesTerminalOutputSeen && !strictResponsesCompletion)
  ) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(
        new Error(`upstream ${backendRouteKey || "SSE"} stream ended before its completion marker`),
        "UPSTREAM_INCOMPLETE_STREAM"
      ),
      providerErrorForwarded: false
    };
  }
  return { ok: true, firstChunkSeen };
}

export async function streamShim({
  upstreamResponse,
  reply,
  modelId,
  routeKey,
  backendRouteKey,
  includeReasoningEncryptedContent = false,
  includeChatStreamUsage = false,
  strictResponsesCompletion = false,
  rejectLossyResponses = true,
  model,
  policy,
  onFirstChunk,
  onUsage,
  onModel,
  onContent,
  onCompatibilityIssue
}) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return { ok: false, beforeFirstChunk: true, error: markErrorWithCode(new Error("stream body unavailable"), "STREAM_INTERRUPTED") };
  }
  let firstChunkSeen = false;
  let firstByteTimedOut = false;
  let idleTimedOut = false;
  let maxDurationTimedOut = false;
  let idleTimer = null;
  let maxDurationTimer = null;
  let buffer = "";
  const decoder = new TextDecoder();
  const sourceSseParser = createSseDataParser();
  let providerError = null;
  let sourceTerminalSeen = false;
  let responsesTerminalOutputSeen = false;
  let terminalFrameWritten = false;
  let clientDisconnected = false;
  const created = Math.floor(Date.now() / 1000);
  const streamId = `chatcmpl_${created}`;
  const toolCallMap = new Map();
  let toolCallIndex = 0;
  let sawToolCall = false;
  let usageRecorded = false;
  let pendingUsage = null;
  let resolvedModel = modelId;
  let reverseResponseId = `resp_${created}`;
  let reverseSequenceNumber = 0;
  let reverseEnvelopeStarted = false;
  let reverseCompleted = false;
  let reverseFinishReason = null;
  let reverseUsage = null;
  let reverseTextItem = null;
  const reverseOutputItems = [];
  const reverseToolItems = new Map();
  const reverseReasoningItems = new Map();
  let anthropicSourceUsage = null;
  let anthropicSourceStopReason = null;
  const anthropicSourceBlocks = new Map();
  let messagesEnvelopeStarted = false;
  let messagesCompleted = false;
  let messagesId = `msg_${created}`;
  let messagesUsage = null;
  let messagesStopReason = null;
  let messagesNextBlockIndex = 0;
  let messagesTextBlock = null;
  const messagesToolBlocks = new Map();
  const messagesToolAliases = new Map();
  const updateResolvedModel = (value) => {
    if (typeof value === "string" && value.trim()) {
      resolvedModel = value.trim();
      onModel?.(resolvedModel);
    }
  };
  const maybeRecordUsage = (usage) => {
    if (!usage || usageRecorded) return;
    pendingUsage = mergeUsageSnapshot(pendingUsage, usage);
  };
  const flushUsage = () => {
    if (!pendingUsage || usageRecorded) return;
    onUsage?.(pendingUsage);
    usageRecorded = true;
  };
  const finishChatCompletionStream = async (finishReason = sawToolCall ? "tool_calls" : "stop") => {
    if (terminalFrameWritten) return;
    await writeSse(reply.raw, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    });
    const chatUsage = includeChatStreamUsage ? normalizeChatUsage(pendingUsage) : null;
    if (chatUsage) {
      await writeSse(reply.raw, {
        id: streamId,
        object: "chat.completion.chunk",
        created,
        model: resolvedModel,
        choices: [],
        usage: chatUsage
      });
    }
    await writeSseDone(reply.raw);
    terminalFrameWritten = true;
  };
  const newChatToolEntry = () => ({
    index: toolCallIndex++,
    id: "",
    fallbackId: "",
    name: "",
    pendingArguments: "",
    started: false,
    argumentsEmitted: false
  });
  const ensureChatToolStarted = async (entry) => {
    if (entry.started) return true;
    const id = entry.id || entry.fallbackId;
    if (!id || !entry.name) return false;
    sawToolCall = true;
    await writeSse(reply.raw, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: entry.index,
            id,
            type: "function",
            function: { name: entry.name, arguments: "" }
          }]
        },
        finish_reason: null
      }]
    });
    entry.started = true;
    return true;
  };
  const writeChatToolArguments = async (entry, delta) => {
    if (typeof delta === "string" && delta) entry.pendingArguments += delta;
    if (!entry.pendingArguments || !(await ensureChatToolStarted(entry))) return;
    const argumentsDelta = entry.pendingArguments;
    entry.pendingArguments = "";
    entry.argumentsEmitted = true;
    onContent?.(argumentsDelta, "tool");
    await writeSse(reply.raw, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: entry.index,
            function: { arguments: argumentsDelta }
          }]
        },
        finish_reason: null
      }]
    });
  };
  const buildReverseUsage = () => {
    if (!reverseUsage) return null;
    const cachedTokens = reverseUsage.prompt_tokens_details?.cached_tokens
      ?? reverseUsage.input_tokens_details?.cached_tokens
      ?? reverseUsage.cache_read_input_tokens
      ?? reverseUsage.cached_tokens
      ?? 0;
    const cacheCreationTokens = reverseUsage.cache_creation_input_tokens ?? 0;
    const hasAnthropicBreakdown = reverseUsage.cache_read_input_tokens != null
      || reverseUsage.cache_creation_input_tokens != null;
    const baseInputTokens = reverseUsage.prompt_tokens ?? reverseUsage.input_tokens ?? 0;
    const inputTokens = hasAnthropicBreakdown
      ? baseInputTokens + cachedTokens + cacheCreationTokens
      : baseInputTokens;
    const outputTokens = reverseUsage.completion_tokens ?? reverseUsage.output_tokens ?? 0;
    return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: reverseUsage.total_tokens ?? reverseUsage.total ?? inputTokens + outputTokens,
    ...(reverseUsage.prompt_tokens_details
      ? { input_tokens_details: reverseUsage.prompt_tokens_details }
      : reverseUsage.input_tokens_details
        ? { input_tokens_details: reverseUsage.input_tokens_details }
        : cachedTokens > 0
          ? { input_tokens_details: { cached_tokens: cachedTokens } }
          : {}),
    ...(reverseUsage.completion_tokens_details ? { output_tokens_details: reverseUsage.completion_tokens_details } : {})
    };
  };
  const buildReverseResponse = (status, output = []) => ({
    id: reverseResponseId,
    object: "response",
    created_at: created,
    status,
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    instructions: null,
    model: resolvedModel,
    output,
    output_text: reverseTextItem?.text || "",
    parallel_tool_calls: true,
    usage: buildReverseUsage()
  });
  const writeResponsesEvent = async (event) => {
    await writeSse(reply.raw, {
      ...event,
      sequence_number: reverseSequenceNumber
    });
    reverseSequenceNumber += 1;
  };
  const ensureReverseEnvelope = async () => {
    if (reverseEnvelopeStarted) return;
    reverseEnvelopeStarted = true;
    await writeResponsesEvent({
      type: "response.created",
      response: buildReverseResponse("in_progress")
    });
    await writeResponsesEvent({
      type: "response.in_progress",
      response: buildReverseResponse("in_progress")
    });
  };
  const ensureReverseTextItem = async () => {
    if (reverseTextItem) return reverseTextItem;
    await ensureReverseEnvelope();
    reverseTextItem = {
      kind: "message",
      id: `msg_${created}`,
      outputIndex: reverseOutputItems.length,
      text: ""
    };
    reverseOutputItems.push(reverseTextItem);
    await writeResponsesEvent({
      type: "response.output_item.added",
      output_index: reverseTextItem.outputIndex,
      item: {
        id: reverseTextItem.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: []
      }
    });
    await writeResponsesEvent({
      type: "response.content_part.added",
      item_id: reverseTextItem.id,
      output_index: reverseTextItem.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] }
    });
    return reverseTextItem;
  };
  const ensureReverseReasoningItem = async (blockIndex, sourceBlock = {}) => {
    const existing = reverseReasoningItems.get(blockIndex);
    if (existing) return existing;
    await ensureReverseEnvelope();
    const item = {
      kind: "reasoning",
      id: sourceBlock.id || `rs_${created}_${blockIndex}`,
      outputIndex: reverseOutputItems.length,
      summary: "",
      encryptedContent: sourceBlock.signature || sourceBlock.data || "",
      summaryPartAdded: false
    };
    reverseReasoningItems.set(blockIndex, item);
    reverseOutputItems.push(item);
    await writeResponsesEvent({
      type: "response.output_item.added",
      output_index: item.outputIndex,
      item: { id: item.id, type: "reasoning", summary: [] }
    });
    return item;
  };
  const appendReverseReasoningSummary = async (item, delta) => {
    if (!delta) return;
    if (!item.summaryPartAdded) {
      item.summaryPartAdded = true;
      await writeResponsesEvent({
        type: "response.reasoning_summary_part.added",
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" }
      });
    }
    item.summary += delta;
    await writeResponsesEvent({
      type: "response.reasoning_summary_text.delta",
      item_id: item.id,
      output_index: item.outputIndex,
      summary_index: 0,
      delta
    });
  };
  const ensureReverseToolItem = async (toolDelta) => {
    const toolIndex = Number.isInteger(toolDelta?.index) ? toolDelta.index : reverseToolItems.size;
    const existing = reverseToolItems.get(toolIndex);
    if (existing) {
      if (toolDelta?.id) existing.callId = toolDelta.id;
      if (toolDelta?.function?.name) existing.name = toolDelta.function.name;
      return existing;
    }
    await ensureReverseEnvelope();
    const callId = toolDelta?.id || `call_${created}_${toolIndex}`;
    const item = {
      kind: "function_call",
      id: `fc_${created}_${toolIndex}`,
      callId,
      name: toolDelta?.function?.name || "",
      arguments: "",
      outputIndex: reverseOutputItems.length
    };
    reverseToolItems.set(toolIndex, item);
    reverseOutputItems.push(item);
    await writeResponsesEvent({
      type: "response.output_item.added",
      output_index: item.outputIndex,
      item: {
        id: item.id,
        type: "function_call",
        status: "in_progress",
        call_id: item.callId,
        name: item.name,
        arguments: ""
      }
    });
    return item;
  };
  const finishResponsesStream = async () => {
    if (reverseCompleted) return;
    await ensureReverseEnvelope();
    const completedOutput = [];
    for (const item of reverseOutputItems) {
      if (item.kind === "reasoning") {
        const summary = item.summary ? [{ type: "summary_text", text: item.summary }] : [];
        if (item.summaryPartAdded) {
          await writeResponsesEvent({
            type: "response.reasoning_summary_text.done",
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: 0,
            text: item.summary
          });
          await writeResponsesEvent({
            type: "response.reasoning_summary_part.done",
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: 0,
            part: summary[0]
          });
        }
        const outputItem = {
          id: item.id,
          type: "reasoning",
          summary,
          ...(includeReasoningEncryptedContent && item.encryptedContent
            ? { encrypted_content: item.encryptedContent }
            : {})
        };
        completedOutput.push(outputItem);
        await writeResponsesEvent({ type: "response.output_item.done", output_index: item.outputIndex, item: outputItem });
        continue;
      }
      if (item.kind === "message") {
        const content = [{ type: "output_text", text: item.text, annotations: [], logprobs: [] }];
        await writeResponsesEvent({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          text: item.text,
          logprobs: []
        });
        await writeResponsesEvent({
          type: "response.content_part.done",
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: content[0]
        });
        const outputItem = { id: item.id, type: "message", status: "completed", role: "assistant", content };
        completedOutput.push(outputItem);
        await writeResponsesEvent({ type: "response.output_item.done", output_index: item.outputIndex, item: outputItem });
        continue;
      }
      await writeResponsesEvent({
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: item.arguments
      });
      const outputItem = {
        id: item.id,
        type: "function_call",
        status: "completed",
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments
      };
      completedOutput.push(outputItem);
      await writeResponsesEvent({ type: "response.output_item.done", output_index: item.outputIndex, item: outputItem });
    }
    const status = reverseFinishReason === "length" ? "incomplete" : "completed";
    await writeResponsesEvent({
      type: status === "completed" ? "response.completed" : "response.incomplete",
      response: buildReverseResponse(status, completedOutput)
    });
    await writeSseDone(reply.raw);
    reverseCompleted = true;
  };
  const buildMessagesUsage = (usage) => {
    if (!usage) return null;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_tokens
      ?? 0;
    const sourceInputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const inputTokens = Math.max(0, sourceInputTokens - cachedTokens);
    const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {})
    };
  };
  const ensureMessagesEnvelope = async () => {
    if (messagesEnvelopeStarted) return;
    messagesEnvelopeStarted = true;
    await writeAnthropicSse(reply.raw, {
      type: "message_start",
      message: {
        id: messagesId,
        type: "message",
        role: "assistant",
        model: resolvedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  };
  const ensureMessagesTextBlock = async () => {
    if (messagesTextBlock) return messagesTextBlock;
    await ensureMessagesEnvelope();
    messagesTextBlock = { index: messagesNextBlockIndex, open: true };
    messagesNextBlockIndex += 1;
    await writeAnthropicSse(reply.raw, {
      type: "content_block_start",
      index: messagesTextBlock.index,
      content_block: { type: "text", text: "" }
    });
    return messagesTextBlock;
  };
  const normalizeToolAliases = (aliases) => aliases
    .filter((alias) => alias !== undefined && alias !== null && alias !== "")
    .map(String);
  const findMessagesToolBlock = (aliases) => normalizeToolAliases(aliases)
    .map((alias) => messagesToolAliases.get(alias))
    .find(Boolean);
  const registerMessagesToolAliases = (block, aliases) => {
    for (const alias of normalizeToolAliases(aliases)) messagesToolAliases.set(alias, block);
  };
  const ensureMessagesToolStarted = async (block, force = false) => {
    if (block.started) return true;
    const id = block.id || (force ? block.fallbackId : "");
    const name = block.name || (force ? "tool" : "");
    if (!id || !name) return false;
    await ensureMessagesEnvelope();
    block.id = id;
    block.name = name;
    block.started = true;
    block.open = true;
    await writeAnthropicSse(reply.raw, {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
    });
    return true;
  };
  const ensureMessagesToolBlock = async (aliases, tool = {}) => {
    let block = findMessagesToolBlock(aliases);
    if (block) {
      if (tool.id) block.id = tool.id;
      if (tool.fallbackId) block.fallbackId = tool.fallbackId;
      if (tool.name) block.name = tool.name;
      registerMessagesToolAliases(block, aliases);
      await ensureMessagesToolStarted(block);
      return block;
    }
    const newBlock = {
      index: messagesNextBlockIndex,
      id: tool.id || "",
      fallbackId: tool.fallbackId || `toolu_${created}_${messagesToolBlocks.size}`,
      name: tool.name || "",
      pendingArguments: "",
      argumentsEmitted: false,
      started: false,
      open: false
    };
    messagesNextBlockIndex += 1;
    messagesToolBlocks.set(newBlock.index, newBlock);
    registerMessagesToolAliases(newBlock, aliases);
    await ensureMessagesToolStarted(newBlock);
    return newBlock;
  };
  const writeMessagesTextDelta = async (delta) => {
    if (typeof delta !== "string" || !delta) return;
    onContent?.(delta, "text");
    const block = await ensureMessagesTextBlock();
    await writeAnthropicSse(reply.raw, {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "text_delta", text: delta }
    });
  };
  const flushMessagesToolArguments = async (block) => {
    if (!block.pendingArguments || !(await ensureMessagesToolStarted(block))) return;
    const delta = block.pendingArguments;
    block.pendingArguments = "";
    block.argumentsEmitted = true;
    onContent?.(delta, "tool");
    await writeAnthropicSse(reply.raw, {
      type: "content_block_delta",
      index: block.index,
      delta: { type: "input_json_delta", partial_json: delta }
    });
  };
  const writeMessagesToolDelta = async (aliases, tool, delta) => {
    const block = await ensureMessagesToolBlock(aliases, tool);
    if (typeof delta === "string" && delta) block.pendingArguments += delta;
    await flushMessagesToolArguments(block);
  };
  const finishMessagesStream = async (stopReason = null) => {
    if (messagesCompleted) return;
    await ensureMessagesEnvelope();
    for (const block of messagesToolBlocks.values()) {
      await ensureMessagesToolStarted(block, true);
      await flushMessagesToolArguments(block);
    }
    const openBlocks = [messagesTextBlock, ...messagesToolBlocks.values()]
      .filter((block) => block?.open)
      .sort((left, right) => left.index - right.index);
    for (const block of openBlocks) {
      if (!block.open) continue;
      await writeAnthropicSse(reply.raw, { type: "content_block_stop", index: block.index });
      block.open = false;
    }
    const usage = buildMessagesUsage(messagesUsage) || { input_tokens: 0, output_tokens: 0 };
    await writeAnthropicSse(reply.raw, {
      type: "message_delta",
      delta: {
        stop_reason: stopReason || messagesStopReason || (messagesToolBlocks.size ? "tool_use" : "end_turn"),
        stop_sequence: null
      },
      usage
    });
    await writeAnthropicSse(reply.raw, { type: "message_stop" });
    messagesCompleted = true;
  };
  if (typeof reply.raw.once === "function") {
    reply.raw.once("close", () => {
      if (reply.raw.writableEnded) return;
      clientDisconnected = true;
      reader.cancel("client-disconnected").catch(() => {});
    });
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const clearMaxDuration = () => {
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    maxDurationTimer = null;
  };
  const resetIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      reader.cancel("idle-timeout").catch(() => {});
    }, policy.idleTimeoutMs);
  };
  const firstByteTimer = setTimeout(() => {
    if (!firstChunkSeen) {
      firstByteTimedOut = true;
      reader.cancel("first-byte-timeout").catch(() => {});
    }
  }, policy.firstByteTimeoutMs);
  if (policy.maxStreamDurationMs > 0) {
    maxDurationTimer = setTimeout(() => {
      maxDurationTimedOut = true;
      reader.cancel("max-stream-duration").catch(() => {});
    }, policy.maxStreamDurationMs);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      const reachedEof = done;
      if (clientDisconnected) break;
      if (!reachedEof && !firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(firstByteTimer);
        onFirstChunk();
      }
      if (!reachedEof) {
        resetIdle();
        for (const payload of sourceSseParser.feed(decoder.decode(value, { stream: true }))) {
          buffer += `data: ${payload.replace(/\r?\n/g, " ")}\n`;
        }
      } else {
        for (const payload of sourceSseParser.finish(decoder.decode())) {
          buffer += `data: ${payload.replace(/\r?\n/g, " ")}\n`;
        }
      }
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        if (providerError || sourceTerminalSeen) {
          buffer = "";
          break;
        }
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          if (backendRouteKey === "messages") {
            providerError = {
              type: "protocol_error",
              code: "UPSTREAM_INCOMPLETE_STREAM",
              message: "Anthropic Messages stream returned an unexpected [DONE] marker",
              param: null,
              azureRequestId: ""
            };
            break;
          }
          if (backendRouteKey === "responses") {
            continue;
          }
          sourceTerminalSeen = true;
          flushUsage();
          if (routeKey === "messages") {
            await finishMessagesStream();
          } else if (routeKey === "responses" && backendRouteKey === "chat/completions") {
            await finishResponsesStream();
          } else if (!terminalFrameWritten) {
            await writeSseDone(reply.raw);
            terminalFrameWritten = true;
          }
          continue;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        const shimEventIssue = getProtocolShimStreamCompatibilityIssue(evt, {
          sourceProtocol: backendRouteKey,
          targetProtocol: routeKey
        });
        if (shimEventIssue) {
          if (rejectLossyResponses) {
            providerError = {
              type: "protocol_error",
              code: "unsupported_protocol_shim_stream",
              message: shimEventIssue.message,
              param: shimEventIssue.path,
              azureRequestId: ""
            };
            break;
          }
          onCompatibilityIssue?.(shimEventIssue);
        }
        if (
          backendRouteKey === "responses"
          && [
            "response.output_text.done",
            "response.refusal.done",
            "response.output_item.done",
            "response.function_call_arguments.done",
            "response.reasoning_summary_part.done",
            "response.reasoning_summary_text.done",
            "response.reasoning.done"
          ].includes(evt?.type)
        ) {
          responsesTerminalOutputSeen = true;
        }
        if (backendRouteKey === "messages") {
          const eventType = evt?.type;
          if (eventType === "error" || evt?.error) {
            providerError = buildProviderStreamError(evt);
            break;
          }
          if (eventType === "message_start") {
            updateResolvedModel(evt?.message?.model);
            if (evt?.message?.id && routeKey === "responses" && !reverseEnvelopeStarted) {
              reverseResponseId = String(evt.message.id).replace(/^msg/, "resp");
            }
            if (evt?.message?.usage) {
              anthropicSourceUsage = { ...evt.message.usage };
            }
            continue;
          }
          if (eventType === "content_block_start") {
            const sourceBlock = evt?.content_block || {};
            const block = {
              type: sourceBlock.type,
              id: sourceBlock.id,
              name: sourceBlock.name,
              reasoningItem: null,
              toolIndex: null
            };
            anthropicSourceBlocks.set(evt?.index, block);
            if ((sourceBlock.type === "thinking" || sourceBlock.type === "redacted_thinking") && routeKey === "responses") {
              block.reasoningItem = await ensureReverseReasoningItem(evt?.index, sourceBlock);
              if (sourceBlock.type === "thinking" && typeof sourceBlock.thinking === "string") {
                await appendReverseReasoningSummary(block.reasoningItem, sourceBlock.thinking);
              }
            }
            if (sourceBlock.type === "tool_use") {
              block.toolIndex = toolCallIndex;
              toolCallIndex += 1;
              sawToolCall = true;
              if (routeKey === "chat/completions") {
                await writeSse(reply.raw, {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolvedModel,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: block.toolIndex,
                        id: block.id,
                        type: "function",
                        function: { name: block.name || "", arguments: "" }
                      }]
                    },
                    finish_reason: null
                  }]
                });
              } else {
                await ensureReverseToolItem({
                  index: block.toolIndex,
                  id: block.id,
                  function: { name: block.name || "" }
                });
              }
            }
            if (sourceBlock.type === "text" && typeof sourceBlock.text === "string" && sourceBlock.text) {
              if (routeKey === "chat/completions") {
                onContent?.(sourceBlock.text, "text");
                await writeSse(reply.raw, {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolvedModel,
                  choices: [{ index: 0, delta: { content: sourceBlock.text }, finish_reason: null }]
                });
              } else {
                onContent?.(sourceBlock.text, "text");
                const textItem = await ensureReverseTextItem();
                textItem.text += sourceBlock.text;
                await writeResponsesEvent({
                  type: "response.output_text.delta",
                  item_id: textItem.id,
                  output_index: textItem.outputIndex,
                  content_index: 0,
                  delta: sourceBlock.text,
                  logprobs: []
                });
              }
            }
            continue;
          }
          if (eventType === "content_block_delta") {
            const sourceBlock = anthropicSourceBlocks.get(evt?.index);
            if (evt?.delta?.type === "text_delta" && typeof evt.delta.text === "string") {
              const delta = evt.delta.text;
              if (routeKey === "chat/completions") {
                onContent?.(delta, "text");
                await writeSse(reply.raw, {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolvedModel,
                  choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
                });
              } else {
                onContent?.(delta, "text");
                const textItem = await ensureReverseTextItem();
                textItem.text += delta;
                await writeResponsesEvent({
                  type: "response.output_text.delta",
                  item_id: textItem.id,
                  output_index: textItem.outputIndex,
                  content_index: 0,
                  delta,
                  logprobs: []
                });
              }
            } else if (evt?.delta?.type === "thinking_delta" && typeof evt.delta.thinking === "string") {
              if (routeKey === "chat/completions") {
                await writeSse(reply.raw, {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolvedModel,
                  choices: [{ index: 0, delta: { reasoning_content: evt.delta.thinking }, finish_reason: null }]
                });
              } else if (routeKey === "responses") {
                const reasoningItem = sourceBlock?.reasoningItem
                  || await ensureReverseReasoningItem(evt?.index, sourceBlock || {});
                await appendReverseReasoningSummary(reasoningItem, evt.delta.thinking);
              }
            } else if (evt?.delta?.type === "signature_delta" && typeof evt.delta.signature === "string" && routeKey === "responses") {
              const reasoningItem = sourceBlock?.reasoningItem
                || await ensureReverseReasoningItem(evt?.index, sourceBlock || {});
              reasoningItem.encryptedContent += evt.delta.signature;
            } else if (
              evt?.delta?.type === "input_json_delta"
              && typeof evt.delta.partial_json === "string"
              && sourceBlock?.type === "tool_use"
            ) {
              const delta = evt.delta.partial_json;
              if (routeKey === "chat/completions") {
                onContent?.(delta, "tool");
                await writeSse(reply.raw, {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: resolvedModel,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: sourceBlock.toolIndex,
                        id: sourceBlock.id,
                        type: "function",
                        function: { name: sourceBlock.name || "", arguments: delta }
                      }]
                    },
                    finish_reason: null
                  }]
                });
              } else {
                onContent?.(delta, "tool");
                const toolItem = await ensureReverseToolItem({
                  index: sourceBlock.toolIndex,
                  id: sourceBlock.id,
                  function: { name: sourceBlock.name || "" }
                });
                toolItem.arguments += delta;
                await writeResponsesEvent({
                  type: "response.function_call_arguments.delta",
                  item_id: toolItem.id,
                  output_index: toolItem.outputIndex,
                  delta
                });
              }
            }
            continue;
          }
          if (eventType === "message_delta") {
            anthropicSourceStopReason = evt?.delta?.stop_reason || anthropicSourceStopReason;
            if (evt?.usage) {
              anthropicSourceUsage = normalizeAnthropicUsage({
                ...(anthropicSourceUsage || {}),
                ...evt.usage
              });
              maybeRecordUsage(anthropicSourceUsage);
              reverseUsage = anthropicSourceUsage;
            }
            reverseFinishReason = anthropicSourceStopReason === "max_tokens"
              ? "length"
              : anthropicSourceStopReason === "tool_use"
                ? "tool_calls"
                : "stop";
            continue;
          }
          if (eventType === "message_stop") {
            sourceTerminalSeen = true;
            if (!usageRecorded && anthropicSourceUsage) {
              anthropicSourceUsage = normalizeAnthropicUsage(anthropicSourceUsage);
              maybeRecordUsage(anthropicSourceUsage);
              reverseUsage = anthropicSourceUsage;
            }
            flushUsage();
            if (routeKey === "chat/completions") {
              const finishReason = anthropicSourceStopReason === "max_tokens"
                ? "length"
                : anthropicSourceStopReason === "tool_use"
                  ? "tool_calls"
                  : "stop";
              await finishChatCompletionStream(finishReason);
            } else {
              await finishResponsesStream();
            }
            continue;
          }
          continue;
        }

        if (routeKey === "messages") {
          if (evt?.type === "error" || evt?.error || evt?.type === "response.failed") {
            providerError = buildProviderStreamError(evt);
            break;
          }
          if (backendRouteKey === "responses") {
            updateResolvedModel(evt?.model || evt?.response?.model);
            if (evt?.response?.id && !messagesEnvelopeStarted) {
              messagesId = String(evt.response.id).replace(/^resp/, "msg");
            }
            if (evt?.type === "response.output_text.delta") {
              await writeMessagesTextDelta(evt?.delta ?? "");
            } else if (evt?.type === "response.output_item.added" || evt?.type === "response.output_item.done") {
              const item = evt?.item;
              if (item?.type === "function_call") {
                const aliases = [
                  item.id ? `item:${item.id}` : "",
                  item.call_id ? `call:${item.call_id}` : "",
                  Number.isInteger(evt?.output_index) ? `output:${evt.output_index}` : ""
                ];
                const block = await ensureMessagesToolBlock(aliases, {
                  id: item.call_id || "",
                  fallbackId: item.id || "",
                  name: item.name || ""
                });
                if (
                  evt.type === "response.output_item.done"
                  && !block.argumentsEmitted
                  && !block.pendingArguments
                  && typeof item.arguments === "string"
                ) {
                  block.pendingArguments = item.arguments;
                  await flushMessagesToolArguments(block);
                }
              }
            } else if (evt?.type === "response.function_call_arguments.delta") {
              const aliases = [
                evt?.item_id ? `item:${evt.item_id}` : "",
                evt?.call_id ? `call:${evt.call_id}` : "",
                Number.isInteger(evt?.output_index) ? `output:${evt.output_index}` : ""
              ];
              await writeMessagesToolDelta(aliases, {}, evt?.delta ?? "");
            } else if (evt?.type === "response.completed" || evt?.type === "response.incomplete") {
              sourceTerminalSeen = true;
              messagesUsage = evt?.response?.usage || messagesUsage;
              maybeRecordUsage(messagesUsage);
              flushUsage();
              messagesStopReason = evt.type === "response.incomplete"
                ? "max_tokens"
                : messagesToolBlocks.size
                  ? "tool_use"
                  : "end_turn";
              await finishMessagesStream();
            }
            continue;
          }

          updateResolvedModel(evt?.model);
          if (evt?.id && !messagesEnvelopeStarted) {
            messagesId = String(evt.id).replace(/^chatcmpl/, "msg");
          }
          if (evt?.usage) {
            messagesUsage = evt.usage;
            maybeRecordUsage(evt.usage);
          }
          const choice = evt?.choices?.[0];
          if (typeof choice?.delta?.content === "string") {
            await writeMessagesTextDelta(choice.delta.content);
          }
          for (const toolDelta of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
            const aliases = [
              Number.isInteger(toolDelta?.index) ? `index:${toolDelta.index}` : "",
              toolDelta?.id ? `id:${toolDelta.id}` : ""
            ];
            await writeMessagesToolDelta(aliases, {
              id: toolDelta?.id,
              name: toolDelta?.function?.name
            }, toolDelta?.function?.arguments ?? "");
          }
          if (choice?.finish_reason) {
            messagesStopReason = choice.finish_reason === "length"
              ? "max_tokens"
              : choice.finish_reason === "tool_calls"
                ? "tool_use"
                : "end_turn";
          }
          continue;
        }

        if (routeKey === "chat/completions" && backendRouteKey === "responses") {
          updateResolvedModel(evt?.model || evt?.response?.model);
          maybeRecordUsage(evt?.usage);
          const t = evt?.type;
          if (t === "error" || t === "response.failed") {
            providerError = buildProviderStreamError(evt);
            break;
          } else if (t === "response.output_text.delta") {
            const delta = evt?.delta ?? "";
            onContent?.(delta, "text");
            await writeSse(reply.raw, {
              id: streamId,
              object: "chat.completion.chunk",
              created,
              model: resolvedModel,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            });
          } else if (t === "response.output_item.added" || t === "response.output_item.done") {
            const item = evt?.item;
            if (item?.type === "function_call") {
              const aliases = [
                item.id,
                item.call_id,
                Number.isInteger(evt?.output_index) ? `output:${evt.output_index}` : ""
              ].filter(Boolean);
              let entry = aliases.map((key) => toolCallMap.get(key)).find(Boolean);
              if (!entry) entry = newChatToolEntry();
              if (item.call_id) entry.id = item.call_id;
              if (item.id) entry.fallbackId = item.id;
              if (item.name) entry.name = item.name;
              for (const alias of aliases) toolCallMap.set(alias, entry);
              await ensureChatToolStarted(entry);
              if (t === "response.output_item.done") {
                if (!entry.pendingArguments && !entry.argumentsEmitted && typeof item.arguments === "string") {
                  entry.pendingArguments = item.arguments;
                }
                await writeChatToolArguments(entry, "");
              }
            }
          } else if (t === "response.function_call_arguments.delta") {
            const aliases = [
              evt?.item_id,
              evt?.call_id,
              Number.isInteger(evt?.output_index) ? `output:${evt.output_index}` : ""
            ].filter(Boolean);
            let entry = aliases.map((key) => toolCallMap.get(key)).find(Boolean);
            if (!entry) {
              entry = newChatToolEntry();
              if (evt?.item_id) entry.fallbackId = evt.item_id;
              for (const alias of aliases) toolCallMap.set(alias, entry);
            }
            if (entry) {
              await writeChatToolArguments(entry, evt?.delta ?? "");
            }
          } else if (t === "response.completed") {
            sourceTerminalSeen = true;
            const usage = evt?.response?.usage;
            maybeRecordUsage(usage);
            flushUsage();
            await finishChatCompletionStream();
          } else if (t === "response.incomplete") {
            sourceTerminalSeen = true;
            const usage = evt?.response?.usage;
            maybeRecordUsage(usage);
            flushUsage();
            await finishChatCompletionStream("length");
          }
          if (providerError) break;
          continue;
        }

        if (routeKey === "responses" && backendRouteKey === "chat/completions") {
          if (evt?.type === "error" || evt?.error) {
            providerError = buildProviderStreamError(evt);
            break;
          }
          updateResolvedModel(evt?.model);
          maybeRecordUsage(evt?.usage);
          if (evt?.id && !reverseEnvelopeStarted) {
            reverseResponseId = String(evt.id).replace(/^chatcmpl/, "resp");
          }
          if (evt?.usage) reverseUsage = evt.usage;
          await ensureReverseEnvelope();
          const choice = evt?.choices?.[0];
          const choiceDelta = choice?.delta?.content;
          if (typeof choiceDelta === "string" && choiceDelta.length > 0) {
            onContent?.(choiceDelta, "text");
            const textItem = await ensureReverseTextItem();
            textItem.text += choiceDelta;
            await writeResponsesEvent({
              type: "response.output_text.delta",
              item_id: textItem.id,
              output_index: textItem.outputIndex,
              content_index: 0,
              delta: choiceDelta,
              logprobs: []
            });
          }
          for (const toolDelta of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
            const toolItem = await ensureReverseToolItem(toolDelta);
            const argumentsDelta = toolDelta?.function?.arguments;
            if (typeof argumentsDelta === "string" && argumentsDelta) {
              onContent?.(argumentsDelta, "tool");
              toolItem.arguments += argumentsDelta;
              await writeResponsesEvent({
                type: "response.function_call_arguments.delta",
                item_id: toolItem.id,
                output_index: toolItem.outputIndex,
                delta: argumentsDelta
              });
            }
          }
          if (choice?.finish_reason) reverseFinishReason = choice.finish_reason;
        }
      }
      if (buffer.length > MAX_SSE_BUFFER_CHARS || sourceSseParser.bufferedLength > MAX_SSE_BUFFER_CHARS) {
        throw markErrorWithCode(new Error("upstream SSE event exceeded buffer limit"), "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      }
      if (providerError) {
        await reader.cancel("provider-error").catch(() => {});
        break;
      }
      if (reachedEof && !sourceTerminalSeen) {
        if (backendRouteKey === "chat/completions" && (messagesStopReason || reverseFinishReason)) {
          sourceTerminalSeen = true;
          flushUsage();
          if (routeKey === "messages") await finishMessagesStream();
          else if (routeKey === "responses") await finishResponsesStream();
        } else if (backendRouteKey === "responses" && responsesTerminalOutputSeen && !strictResponsesCompletion) {
          sourceTerminalSeen = true;
          flushUsage();
          if (routeKey === "messages") await finishMessagesStream();
          else if (routeKey === "chat/completions") await finishChatCompletionStream();
        }
      }
      if (sourceTerminalSeen || reachedEof) break;
    }
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearIdle();
    clearMaxDuration();
    return { ok: false, beforeFirstChunk: !firstChunkSeen, error, clientDisconnected };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
  clearMaxDuration();
  if (clientDisconnected) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: createClientDisconnectedError(),
      clientDisconnected: true
    };
  }
  if (firstByteTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: true,
      error: markErrorWithCode(new Error(`first byte timeout after ${policy.firstByteTimeoutMs}ms`), "UPSTREAM_FIRST_BYTE_TIMEOUT")
    };
  }
  if (idleTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(`idle timeout after ${policy.idleTimeoutMs}ms`), "UPSTREAM_IDLE_TIMEOUT")
    };
  }
  if (maxDurationTimedOut) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(`stream exceeded max duration after ${policy.maxStreamDurationMs}ms`), "UPSTREAM_MAX_STREAM_DURATION")
    };
  }
  if (providerError) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(new Error(providerError.message), "UPSTREAM_PROVIDER_STREAM_ERROR"),
      providerErrorForwarded: false,
      providerError
    };
  }
  if (!sourceTerminalSeen) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: markErrorWithCode(
        new Error(`upstream ${backendRouteKey} stream ended before its completion marker`),
        "UPSTREAM_INCOMPLETE_STREAM"
      ),
      providerErrorForwarded: false
    };
  }
  flushUsage();
  return { ok: true, firstChunkSeen };
}
