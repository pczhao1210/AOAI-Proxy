import { recordUsage } from "../stats.js";
import { markErrorWithCode } from "./reliability.js";

function extractAzureRequestId(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/request ID\s+([0-9a-fA-F-]{16,})/i);
  return match ? match[1] : "";
}

function buildProviderStreamError(evt) {
  const error = evt?.error && typeof evt.error === "object" ? evt.error : {};
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

function writeSse(replyRaw, dataObj) {
  replyRaw.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function writeSseDone(replyRaw) {
  replyRaw.write("data: [DONE]\n\n");
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

export function writeSseError(replyRaw, errorBody) {
  writeSse(replyRaw, { error: errorBody });
  writeSseDone(replyRaw);
}

export function writeSseDoneFrame(replyRaw) {
  writeSseDone(replyRaw);
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
  let providerBuffer = "";
  let providerError = null;
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
      const text = chunk.toString("utf8");
      extractUsageFromSseChunk(text, modelId, usageState);
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
          if (evt?.type === "error" && evt?.error) {
            providerError = buildProviderStreamError(evt);
          }
        } catch {
          // ignore parse errors for passthrough events
        }
      }
      reply.raw.write(chunk);
    }
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearIdle();
    return { ok: false, beforeFirstChunk: !firstChunkSeen, error };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
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
  const created = Math.floor(Date.now() / 1000);
  const streamId = `chatcmpl_${created}`;
  const toolCallMap = new Map();
  let toolCallIndex = 0;
  let sawToolCall = false;
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
      buffer += Buffer.from(value).toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          writeSseDone(reply.raw);
          continue;
        }
        if (routeKey === "chat/completions" && backendRouteKey === "responses") {
          try {
            const evt = JSON.parse(payload);
            if (evt?.usage) recordUsage(model.id, evt.usage);
            const t = evt?.type;
            if (t === "response.output_text.delta") {
              const delta = evt?.delta ?? "";
              writeSse(reply.raw, {
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
                writeSse(reply.raw, {
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
            } else if (t === "response.completed" || t === "response.output_text.done") {
              const usage = evt?.response?.usage;
              if (usage) recordUsage(model.id, usage);
              writeSse(reply.raw, {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" }]
              });
              writeSseDone(reply.raw);
            }
          } catch {
            // ignore parse errors for shim events
          }
          continue;
        }

        if (routeKey === "responses" && backendRouteKey === "chat/completions") {
          try {
            const evt = JSON.parse(payload);
            if (evt?.usage) recordUsage(model.id, evt.usage);
            const choiceDelta = evt?.choices?.[0]?.delta?.content;
            if (typeof choiceDelta === "string" && choiceDelta.length > 0) {
              writeSse(reply.raw, { type: "response.output_text.delta", delta: choiceDelta });
            }
          } catch {
            // ignore parse errors for shim events
          }
        }
      }
    }
  } catch (error) {
    clearTimeout(firstByteTimer);
    clearIdle();
    return { ok: false, beforeFirstChunk: !firstChunkSeen, error };
  }
  clearTimeout(firstByteTimer);
  clearIdle();
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
  return { ok: true, firstChunkSeen };
}
