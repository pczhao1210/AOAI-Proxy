import { Readable } from "node:stream";
import sharp from "sharp";
import { getBearerToken } from "./auth.js";
import { recordError, recordRequest, recordUsage } from "./stats.js";

function findUpstream(config, name) {
  return config.upstreams.find((u) => u.name === name);
}

function findModel(config, modelId) {
  return config.models.find((m) => m.id === modelId) || null;
}

function buildUpstreamUrl(upstream, routeKey, deployment) {
  const route = upstream.routes?.[routeKey];
  if (!route) {
    throw new Error(`No route configured for ${routeKey}`);
  }
  const renderedRoute = typeof route === "string" && deployment
    ? route.replaceAll("{deployment}", encodeURIComponent(deployment))
    : route;
  return new URL(renderedRoute, upstream.baseUrl).toString();
}

function buildDirectUpstreamUrl(upstream, routePath, deployment) {
  if (!routePath || typeof routePath !== "string") {
    throw new Error("routePath must be a string");
  }
  const renderedRoute = deployment
    ? routePath.replaceAll("{deployment}", encodeURIComponent(deployment))
    : routePath;
  return new URL(renderedRoute, upstream.baseUrl).toString();
}

function resolveModelRoute(model, incomingRouteKey) {
  const routes = model?.routes;
  if (!routes || typeof routes !== "object") return null;
  const mapped = routes[incomingRouteKey] ?? routes["*"];
  if (!mapped || typeof mapped !== "string") return null;
  const trimmed = mapped.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return { type: "path", value: trimmed };
  }
  return { type: "routeKey", value: trimmed };
}

function isPlaceholderBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return true;
  try {
    const url = new URL(baseUrl);
    return url.hostname.toLowerCase().includes("your-resource-name");
  } catch {
    return true;
  }
}

function sanitizeIncomingHeaders(headers) {
  const blocked = new Set([
    "authorization",
    "x-api-key",
    "api-key",
    "ocp-apim-subscription-key",
    "content-length",
    "host",
    "connection",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer"
  ]);
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!blocked.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function getStreamFlag(body) {
  return body?.stream === true;
}

function isMeaninglessValue(value) {
  return (
    value === undefined
    || value === null
    || value === "[undefined]"
    || value === "undefined"
  );
}

function pruneMeaningless(value) {
  if (isMeaninglessValue(value)) return undefined;
  if (Array.isArray(value)) {
    const out = value
      .map((v) => pruneMeaningless(v))
      .filter((v) => v !== undefined);
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = pruneMeaningless(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return out;
  }
  return value;
}

function sanitizeRequestBody(body) {
  const pruned = pruneMeaningless(body);
  // Ensure we always have an object for downstream logic.
  return pruned && typeof pruned === "object" ? pruned : {};
}

function resolveImageCompression(config) {
  const cfg = config?.server?.imageCompression || {};
  const enabled = cfg.enabled !== false;
  const maxSize = Number.isFinite(cfg.maxSize) ? cfg.maxSize : 1600;
  const quality = Number.isFinite(cfg.quality) ? cfg.quality : 0.85;
  const format = cfg.format === "webp" ? "webp" : "jpeg";
  return {
    enabled,
    maxSize,
    quality: Math.min(1, Math.max(0.1, quality)),
    format
  };
}

function isDataUrlImage(value) {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

async function compressImageBuffer(buffer, options) {
  let pipeline = sharp(buffer, { failOnError: false });
  try {
    const metadata = await pipeline.metadata();
    if (metadata?.width && metadata?.height && options.maxSize > 0) {
      const maxSize = options.maxSize;
      pipeline = pipeline.resize({
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true
      });
    }
  } catch {
    // ignore metadata errors
  }
  const quality = Math.round(options.quality * 100);
  if (options.format === "webp") {
    return {
      buffer: await pipeline.webp({ quality }).toBuffer(),
      mime: "image/webp"
    };
  }
  return {
    buffer: await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer(),
    mime: "image/jpeg"
  };
}

async function compressDataUrl(dataUrl, options, cache) {
  const cached = cache.get(dataUrl);
  if (cached) return cached;
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return dataUrl;
  try {
    const buffer = Buffer.from(match[2], "base64");
    const out = await compressImageBuffer(buffer, options);
    const result = `data:${out.mime};base64,${out.buffer.toString("base64")}`;
    cache.set(dataUrl, result);
    return result;
  } catch {
    return dataUrl;
  }
}

async function compressBase64String(base64, options) {
  try {
    const buffer = Buffer.from(base64, "base64");
    const out = await compressImageBuffer(buffer, options);
    return out.buffer.toString("base64");
  } catch {
    return base64;
  }
}

async function compressImagesInPlace(value, options, cache) {
  if (Array.isArray(value)) {
    for (const item of value) {
      await compressImagesInPlace(item, options, cache);
    }
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      if (key === "image_base64") {
        value[key] = await compressBase64String(raw, options);
        continue;
      }
      if (isDataUrlImage(raw)) {
        value[key] = await compressDataUrl(raw, options, cache);
        continue;
      }
    }

    if (key === "image_url") {
      if (typeof raw === "string" && isDataUrlImage(raw)) {
        value[key] = await compressDataUrl(raw, options, cache);
        continue;
      }
      if (raw && typeof raw === "object" && typeof raw.url === "string" && isDataUrlImage(raw.url)) {
        raw.url = await compressDataUrl(raw.url, options, cache);
        continue;
      }
    }

    await compressImagesInPlace(raw, options, cache);
  }
}

async function maybeCompressImages(payload, config) {
  const options = resolveImageCompression(config);
  if (!options.enabled) return payload;
  const cache = new Map();
  await compressImagesInPlace(payload, options, cache);
  return payload;
}

function inferBackendRouteKey(routeKey, override) {
  if (override?.type === "routeKey") return override.value;
  if (override?.type === "path") {
    const p = override.value.toLowerCase();
    if (p.endsWith("/responses")) return "responses";
    if (p.endsWith("/chat/completions")) return "chat/completions";
    if (p.endsWith("/images/generations")) return "images/generations";
  }
  return routeKey;
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
    // best-effort stringify for common "input" shapes
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

function chatToResponsesRequest(body, deployment) {
  const messages = body?.messages;
  const text = extractLastUserTextFromMessages(messages);
  const instructionText = extractInstructionTextFromMessages(messages);
  const inputItems = buildResponsesInputFromMessages(messages);
  const out = {
    ...body,
    model: deployment
  };
  // Responses API typically uses `input`; we keep extra fields best-effort.
  if (out.input == null) {
    out.input = inputItems.length ? inputItems : text;
  }
  delete out.messages;

  if (!out.instructions && instructionText) {
    out.instructions = instructionText;
  }

  // Normalize tools/tool_choice for Responses API schema
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

  // best-effort param mapping
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

  // Remove unsupported or chat-only fields for Responses API
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

function responsesToChatRequest(body, deployment) {
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

function mapResponsesJsonToChatCompletion(payload, modelId) {
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

function mapChatCompletionJsonToResponses(payload, modelId) {
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

function writeSse(replyRaw, dataObj) {
  replyRaw.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

function writeSseDone(replyRaw) {
  replyRaw.write("data: [DONE]\n\n");
}

export async function proxyRequest({
  config,
  routeKey,
  req,
  reply
}) {
  const body = sanitizeRequestBody(req.body || {});
  const modelId = body.model || config.models[0]?.id;
  if (!modelId) {
    reply.code(400).send({ error: "model is required" });
    return;
  }
  const model = findModel(config, modelId);
  if (!model) {
    reply.code(404).send({ error: `model ${modelId} not found` });
    return;
  }
  const upstream = findUpstream(config, model.upstream);
  if (!upstream) {
    reply.code(500).send({ error: `upstream ${model.upstream} not found` });
    return;
  }

  if (isPlaceholderBaseUrl(upstream.baseUrl)) {
    reply.code(500).send({
      error: "InvalidUpstreamConfig",
      message:
        "upstreams[].baseUrl 仍是占位符或无效：请将 YOUR-RESOURCE-NAME 替换为真实 Azure OpenAI/Foundry 资源域名（*.openai.azure.com 或 *.services.ai.azure.com）"
    });
    return;
  }

  const deployment = model.targetModel || model.id;
  const override = resolveModelRoute(model, routeKey);
  const effectiveRouteKey = override?.type === "routeKey" ? override.value : routeKey;
  const backendRouteKey = inferBackendRouteKey(routeKey, override);
  const targetUrl = override?.type === "path"
    ? buildDirectUpstreamUrl(upstream, override.value, deployment)
    : buildUpstreamUrl(upstream, effectiveRouteKey, deployment);
  const bearer = await getBearerToken(config.auth.scope);

  const isStream = getStreamFlag(body);
  const needsChatResponsesShim =
    (routeKey === "chat/completions" && backendRouteKey === "responses")
    || (routeKey === "responses" && backendRouteKey === "chat/completions");

  let nextBody;
  if (needsChatResponsesShim && routeKey === "chat/completions" && backendRouteKey === "responses") {
    nextBody = chatToResponsesRequest(body, deployment);
    // ensure upstream sees stream flag when client asked for it
    if (isStream) nextBody.stream = true;
  } else if (needsChatResponsesShim && routeKey === "responses" && backendRouteKey === "chat/completions") {
    nextBody = responsesToChatRequest(body, deployment);
    if (isStream) nextBody.stream = true;
  } else {
    nextBody = {
      ...body,
      model: deployment
    };
  }

  // Azure/Foundry v1 does not reliably support OpenAI `stream_options` (e.g. include_usage).
  // Keep streaming itself (`stream: true`) but drop `stream_options` to avoid 400 unknown_parameter.
  if (nextBody && typeof nextBody === "object" && "stream_options" in nextBody) {
    delete nextBody.stream_options;
  }

  if (nextBody && typeof nextBody === "object") {
    nextBody = await maybeCompressImages(nextBody, config);
  }

  recordRequest(model.id);

  const headers = {
    ...sanitizeIncomingHeaders(req.headers),
    "content-type": "application/json",
    authorization: `Bearer ${bearer}`
  };

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(nextBody)
    });
  } catch (error) {
    recordError(model.id);
    reply.code(502).send({
      error: "UpstreamFetchFailed",
      message: error?.message || "fetch failed",
      hint: "检查 upstreams[].baseUrl 是否正确、网络/DNS 是否可达，以及 models[].targetModel 是否为部署名 (deployment identifier)"
    });
    return;
  }

  if (isStream) {
    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text().catch(() => "");
      recordError(model.id);
      reply.code(upstreamResponse.status).send({
        error: "Upstream error",
        detail: errText
      });
      return;
    }

    // If we are not shimming between modes, keep passthrough behavior.
    if (!needsChatResponsesShim) {
      reply.raw.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
      const nodeStream = Readable.fromWeb(upstreamResponse.body);
      let buffer = "";
      let usageRecorded = false;
      nodeStream.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        buffer += text;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              try {
                const json = JSON.parse(payload);
                const usage = json.usage || json.response?.usage;
                if (!usageRecorded && usage) {
                  recordUsage(model.id, usage);
                  usageRecorded = true;
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
        reply.raw.write(chunk);
      });
      nodeStream.on("end", () => {
        reply.raw.end();
      });
      nodeStream.on("error", () => {
        recordError(model.id);
        reply.raw.end();
      });
      reply.hijack();
      return;
    }

    // Shim stream: responses -> chat.completion.chunk (or reverse)
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });

    const nodeStream = Readable.fromWeb(upstreamResponse.body);
    let buffer = "";
    const created = Math.floor(Date.now() / 1000);
    const streamId = `chatcmpl_${created}`;
    const toolCallMap = new Map();
    let toolCallIndex = 0;
    let sawToolCall = false;

    nodeStream.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
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

        // backend=responses, incoming=chat
        if (routeKey === "chat/completions" && backendRouteKey === "responses") {
          try {
            const evt = JSON.parse(payload);
            if (evt?.usage) recordUsage(model.id, evt.usage);
            const t = evt?.type;
            if (t === "response.output_text.delta") {
              const delta = evt?.delta ?? "";
              const chunkObj = {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
              };
              writeSse(reply.raw, chunkObj);
            } else if (t === "response.output_item.added" || t === "response.output_item.done") {
              const item = evt?.item;
              if (item?.type === "function_call") {
                const callId = item.call_id || item.id || `call_${toolCallIndex}`;
                if (!toolCallMap.has(item.id)) {
                  toolCallMap.set(item.id || callId, {
                    index: toolCallIndex,
                    id: callId,
                    name: item.name || ""
                  });
                  toolCallIndex += 1;
                }
              }
            } else if (t === "response.function_call_arguments.delta") {
              const itemId = evt?.item_id;
              const entry = toolCallMap.get(itemId);
              if (entry) {
                sawToolCall = true;
                const argsDelta = evt?.delta ?? "";
                const chunkObj = {
                  id: streamId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: entry.index,
                          id: entry.id,
                          type: "function",
                          function: {
                            name: entry.name,
                            arguments: argsDelta
                          }
                        }
                      ]
                    },
                    finish_reason: null
                  }]
                };
                writeSse(reply.raw, chunkObj);
              }
            } else if (t === "response.completed" || t === "response.output_text.done") {
              const usage = evt?.response?.usage;
              if (usage) recordUsage(model.id, usage);
              const doneChunk = {
                id: streamId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" }]
              };
              writeSse(reply.raw, doneChunk);
              writeSseDone(reply.raw);
            }
          } catch {
            // ignore
          }
          continue;
        }

        // backend=chat, incoming=responses (best-effort passthrough as response text chunks)
        if (routeKey === "responses" && backendRouteKey === "chat/completions") {
          try {
            const evt = JSON.parse(payload);
            if (evt?.usage) recordUsage(model.id, evt.usage);
            // We cannot fully emulate Responses streaming; provide a minimal `output_text` stream.
            const choiceDelta = evt?.choices?.[0]?.delta?.content;
            if (typeof choiceDelta === "string" && choiceDelta.length > 0) {
              writeSse(reply.raw, { type: "response.output_text.delta", delta: choiceDelta });
            }
          } catch {
            // ignore
          }
        }
      }
    });

    nodeStream.on("end", () => {
      reply.raw.end();
    });
    nodeStream.on("error", () => {
      recordError(model.id);
      reply.raw.end();
    });
    reply.hijack();
    return;
  }

  const payload = await upstreamResponse.json().catch(() => null);
  if (!upstreamResponse.ok) {
    recordError(model.id);
    reply.code(upstreamResponse.status).send(payload || { error: "Upstream error" });
    return;
  }

  // Shim non-stream JSON between chat/responses when model routes override the backend route.
  if (needsChatResponsesShim) {
    if (routeKey === "chat/completions" && backendRouteKey === "responses") {
      const mapped = mapResponsesJsonToChatCompletion(payload, modelId);
      if (mapped?.usage) recordUsage(model.id, mapped.usage);
      reply.code(200).send(mapped);
      return;
    }
    if (routeKey === "responses" && backendRouteKey === "chat/completions") {
      const mapped = mapChatCompletionJsonToResponses(payload, modelId);
      if (mapped?.usage) recordUsage(model.id, mapped.usage);
      reply.code(200).send(mapped);
      return;
    }
  }

  if (payload?.usage) {
    recordUsage(model.id, payload.usage);
  }
  reply.code(upstreamResponse.status).send(payload);
}
