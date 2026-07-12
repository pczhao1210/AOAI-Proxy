import { markErrorWithCode } from "./reliability.js";

const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

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

async function writeSseDone(replyRaw) {
  await writeWithBackpressure(replyRaw, "data: [DONE]\n\n");
}

function extractUsageFromSseChunk(chunkText, usageState, onUsage, onModel) {
  usageState.buffer += chunkText;
  let idx;
  while ((idx = usageState.buffer.indexOf("\n")) >= 0) {
    const line = usageState.buffer.slice(0, idx).trim();
    usageState.buffer = usageState.buffer.slice(idx + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const resolvedModel = json.model || json.response?.model;
      if (typeof resolvedModel === "string" && resolvedModel) {
        onModel?.(resolvedModel);
      }
      const usage = json.usage || json.response?.usage;
      if (!usageState.recorded && usage) {
        onUsage?.(usage);
        usageState.recorded = true;
      }
    } catch {
      // ignore parse errors
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

export async function writeSseError(replyRaw, errorBody) {
  await writeSse(replyRaw, errorBody);
  await writeSseDone(replyRaw);
}

export async function writeSseDoneFrame(replyRaw) {
  await writeSseDone(replyRaw);
}

export async function streamPassthrough({
  upstreamResponse,
  reply,
  policy,
  onFirstChunk,
  onUsage,
  onModel
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
  const usageState = { buffer: "", recorded: false };
  const decoder = new TextDecoder();
  let providerBuffer = "";
  let providerError = null;
  let clientDisconnected = false;
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
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(firstByteTimer);
        onFirstChunk();
      }
      resetIdle();
      const chunk = Buffer.from(value);
      const text = decoder.decode(value, { stream: true });
      extractUsageFromSseChunk(text, usageState, onUsage, onModel);
      providerBuffer += text;
      let idx;
      while ((idx = providerBuffer.indexOf("\n")) >= 0) {
        const rawLine = providerBuffer.slice(0, idx);
        providerBuffer = providerBuffer.slice(idx + 1);
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (
            evt?.type === "error"
            || (evt?.type === "response.failed" && evt?.response?.error)
          ) {
            providerError = buildProviderStreamError(evt);
          }
        } catch {
          // ignore parse errors for passthrough events
        }
      }
      if (usageState.buffer.length > MAX_SSE_BUFFER_CHARS || providerBuffer.length > MAX_SSE_BUFFER_CHARS) {
        throw markErrorWithCode(new Error("upstream SSE event exceeded buffer limit"), "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      }
      await writeWithBackpressure(reply.raw, chunk);
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
      providerErrorForwarded: true,
      providerError
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
  model,
  policy,
  onFirstChunk,
  onUsage,
  onModel
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
  let providerError = null;
  let terminalFrameWritten = false;
  let sawOutputTextDone = false;
  let clientDisconnected = false;
  const created = Math.floor(Date.now() / 1000);
  const streamId = `chatcmpl_${created}`;
  const toolCallMap = new Map();
  let toolCallIndex = 0;
  let sawToolCall = false;
  let usageRecorded = false;
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
  const updateResolvedModel = (value) => {
    if (typeof value === "string" && value.trim()) {
      resolvedModel = value.trim();
      onModel?.(resolvedModel);
    }
  };
  const maybeRecordUsage = (usage) => {
    if (!usage || usageRecorded) return;
    onUsage?.(usage);
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
    await writeSseDone(reply.raw);
    terminalFrameWritten = true;
  };
  const buildReverseUsage = () => reverseUsage ? {
    input_tokens: reverseUsage.prompt_tokens ?? reverseUsage.input_tokens ?? 0,
    output_tokens: reverseUsage.completion_tokens ?? reverseUsage.output_tokens ?? 0,
    total_tokens: reverseUsage.total_tokens ?? 0,
    ...(reverseUsage.prompt_tokens_details ? { input_tokens_details: reverseUsage.prompt_tokens_details } : {}),
    ...(reverseUsage.completion_tokens_details ? { output_tokens_details: reverseUsage.completion_tokens_details } : {})
  } : null;
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
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(firstByteTimer);
        onFirstChunk();
      }
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          if (routeKey === "responses" && backendRouteKey === "chat/completions") {
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
        if (routeKey === "chat/completions" && backendRouteKey === "responses") {
          updateResolvedModel(evt?.model || evt?.response?.model);
          maybeRecordUsage(evt?.usage);
          const t = evt?.type;
          if (t === "error" || t === "response.failed") {
            providerError = buildProviderStreamError(evt);
            break;
          } else if (t === "response.output_text.delta") {
            const delta = evt?.delta ?? "";
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
              const callId = item.call_id || item.id || `call_${toolCallIndex}`;
              if (!toolCallMap.has(item.id || callId)) {
                toolCallMap.set(item.id || callId, {
                  index: toolCallIndex,
                  id: callId,
                  name: item.name || ""
                });
                toolCallIndex += 1;
              }
            }
          } else if (t === "response.function_call_arguments.delta") {
            const entry = toolCallMap.get(evt?.item_id);
            if (entry) {
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
                      id: entry.id,
                      type: "function",
                      function: { name: entry.name, arguments: evt?.delta ?? "" }
                    }]
                  },
                  finish_reason: null
                }]
              });
            }
          } else if (t === "response.output_text.done") {
            sawOutputTextDone = true;
          } else if (t === "response.completed") {
            const usage = evt?.response?.usage;
            maybeRecordUsage(usage);
            await finishChatCompletionStream();
          } else if (t === "response.incomplete") {
            const usage = evt?.response?.usage;
            maybeRecordUsage(usage);
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
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw markErrorWithCode(new Error("upstream SSE event exceeded buffer limit"), "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      }
      if (providerError) {
        await reader.cancel("provider-error").catch(() => {});
        break;
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
      providerErrorForwarded: false,
      providerError
    };
  }
  if (routeKey === "responses" && backendRouteKey === "chat/completions" && firstChunkSeen && !reverseCompleted) {
    await finishResponsesStream();
  }
  if (
    routeKey === "chat/completions"
    && backendRouteKey === "responses"
    && sawOutputTextDone
    && !terminalFrameWritten
  ) {
    await finishChatCompletionStream();
  }
  return { ok: true, firstChunkSeen };
}
