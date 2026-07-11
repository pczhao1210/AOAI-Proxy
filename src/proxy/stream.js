import { recordUsage } from "../stats.js";
import { markErrorWithCode } from "./reliability.js";

const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

function buildProviderStreamError(event) {
  const providerError = event?.error && typeof event.error === "object"
    ? event.error
    : (event?.response?.error && typeof event.response.error === "object" ? event.response.error : event);
  const message = typeof providerError?.message === "string"
    ? providerError.message
    : "upstream provider stream error";
  const error = markErrorWithCode(new Error(message), "UPSTREAM_PROVIDER_STREAM_ERROR");
  error.providerError = {
    code: typeof providerError?.code === "string" ? providerError.code : "UPSTREAM_PROVIDER_STREAM_ERROR",
    message,
    type: typeof providerError?.type === "string" ? providerError.type : event?.type,
    param: providerError?.param ?? null
  };
  return error;
}

function isProviderErrorEvent(event) {
  return event?.type === "error" || event?.type === "response.failed";
}

function parseSseJson(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
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

function extractUsageFromSseChunk(chunkText, modelId, usageState) {
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
      const usage = json.usage || json.response?.usage;
      if (!usageState.recorded && usage) {
        recordUsage(modelId, usage);
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
  if (replyRaw.destroyed || replyRaw.writableEnded) return false;
  try {
    await writeSse(replyRaw, { error: errorBody });
    await writeSseDone(replyRaw);
    return true;
  } catch {
    return false;
  }
}

export async function writeSseDoneFrame(replyRaw) {
  await writeSseDone(replyRaw);
}

export async function streamPassthrough({
  upstreamResponse,
  reply,
  modelId,
  policy,
  onFirstChunk
}) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return { ok: false, beforeFirstChunk: true, error: markErrorWithCode(new Error("stream body unavailable"), "STREAM_INTERRUPTED") };
  }
  let firstChunkSeen = false;
  let firstByteTimedOut = false;
  let idleTimedOut = false;
  let idleTimer = null;
  const usageState = { buffer: "", recorded: false };
  const decoder = new TextDecoder();
  let providerBuffer = "";
  let providerError = null;
  let clientDisconnected = false;
  const onClientClose = () => {
    if (reply.raw.writableEnded) return;
    clientDisconnected = true;
    reader.cancel("client-disconnected").catch(() => {});
  };
  if (typeof reply.raw.once === "function") {
    reply.raw.once("close", onClientClose);
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
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
      extractUsageFromSseChunk(text, modelId, usageState);
      providerBuffer += text;
      let idx;
      while ((idx = providerBuffer.indexOf("\n")) >= 0) {
        const line = providerBuffer.slice(0, idx).trim();
        providerBuffer = providerBuffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          if (isProviderErrorEvent(event)) {
            providerError = buildProviderStreamError(event);
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
    reply.raw.removeListener?.("close", onClientClose);
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: clientDisconnected ? createClientDisconnectedError() : error,
      clientDisconnected
    };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
  reply.raw.removeListener?.("close", onClientClose);
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
  if (providerError) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: providerError,
      providerErrorForwarded: true
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
  onFirstChunk
}) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
    return { ok: false, beforeFirstChunk: true, error: markErrorWithCode(new Error("stream body unavailable"), "STREAM_INTERRUPTED") };
  }
  let firstChunkSeen = false;
  let firstByteTimedOut = false;
  let idleTimedOut = false;
  let idleTimer = null;
  let buffer = "";
  const decoder = new TextDecoder();
  let providerError = null;
  let terminalFrameWritten = false;
  let clientDisconnected = false;
  const created = Math.floor(Date.now() / 1000);
  const streamId = `chatcmpl_${created}`;
  const toolCallMap = new Map();
  let toolCallIndex = 0;
  let sawToolCall = false;
  const finishChatCompletionStream = async (finishReason = sawToolCall ? "tool_calls" : "stop") => {
    if (terminalFrameWritten) return;
    await writeSse(reply.raw, {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
    });
    await writeSseDone(reply.raw);
    terminalFrameWritten = true;
  };
  const onClientClose = () => {
    if (reply.raw.writableEnded) return;
    clientDisconnected = true;
    reader.cancel("client-disconnected").catch(() => {});
  };
  if (typeof reply.raw.once === "function") {
    reply.raw.once("close", onClientClose);
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
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
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw markErrorWithCode(new Error("upstream SSE event exceeded buffer limit"), "UPSTREAM_STREAM_EVENT_TOO_LARGE");
      }
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          if (routeKey === "chat/completions" && backendRouteKey === "responses") {
            await finishChatCompletionStream();
          } else if (!terminalFrameWritten) {
            await writeSseDone(reply.raw);
            terminalFrameWritten = true;
          }
          continue;
        }
        if (routeKey === "chat/completions" && backendRouteKey === "responses") {
          const evt = parseSseJson(payload);
          if (!evt) continue;
          if (isProviderErrorEvent(evt)) {
            providerError = buildProviderStreamError(evt);
            continue;
          }
          if (evt?.usage) recordUsage(model.id, evt.usage);
          const t = evt?.type;
          if (t === "response.output_text.delta") {
            const delta = evt?.delta ?? "";
            await writeSse(reply.raw, {
              id: streamId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
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
                model: modelId,
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
          } else if (t === "response.completed") {
            const usage = evt?.response?.usage;
            if (usage) recordUsage(model.id, usage);
            await finishChatCompletionStream();
          } else if (t === "response.incomplete") {
            const usage = evt?.response?.usage;
            if (usage) recordUsage(model.id, usage);
            await finishChatCompletionStream("length");
          }
          continue;
        }

        if (routeKey === "responses" && backendRouteKey === "chat/completions") {
          const evt = parseSseJson(payload);
          if (!evt) continue;
          if (isProviderErrorEvent(evt)) {
            providerError = buildProviderStreamError(evt);
            continue;
          }
          if (evt?.usage) recordUsage(model.id, evt.usage);
          const choiceDelta = evt?.choices?.[0]?.delta?.content;
          if (typeof choiceDelta === "string" && choiceDelta.length > 0) {
            await writeSse(reply.raw, { type: "response.output_text.delta", delta: choiceDelta });
          }
        }
      }
    }
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearIdle();
    reply.raw.removeListener?.("close", onClientClose);
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: clientDisconnected ? createClientDisconnectedError() : error,
      clientDisconnected
    };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
  reply.raw.removeListener?.("close", onClientClose);
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
  if (providerError) {
    return {
      ok: false,
      beforeFirstChunk: !firstChunkSeen,
      error: providerError
    };
  }
  return { ok: true, firstChunkSeen };
}
