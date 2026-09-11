import { randomUUID } from "node:crypto";
import { getMediaHttpLimits, reserveMediaBuffer } from "./media-body.js";
import { mapAzureTranscriptionResult } from "./azure-speech.js";

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, code: "RESPONSES_SPEECH_UNREPRESENTABLE" });
}

function validateProfile(body, config, log) {
  if (body.metadata != null && (typeof body.metadata !== "object" || Array.isArray(body.metadata)
    || Object.keys(body.metadata).length > 16 || Object.entries(body.metadata).some(([key, value]) =>
      key.length > 64 || typeof value !== "string" || value.length > 512))) throw invalid("metadata requires at most 16 string pairs (64/512 characters)");
  for (const field of ["stream", "store", "background"]) {
    if (body[field] != null && body[field] !== false) throw invalid(`${field} is not supported by synchronous Speech Responses`);
  }
  for (const field of ["previous_response_id", "conversation", "max_output_tokens", "max_tool_calls", "prompt", "context_management", "reasoning"]) {
    if (body[field] != null) throw invalid(`${field} cannot be represented by stateless Speech`);
  }
  if (body.instructions != null && body.instructions !== "") throw invalid("Speech cannot execute Responses instructions");
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length)) throw invalid("Speech does not execute client tools");
  if (body.tool_choice != null && !["none", "auto"].includes(body.tool_choice)) throw invalid("Speech cannot satisfy tool_choice");
  if (body.text != null && (body.text.format?.type !== "text" || Object.keys(body.text).some(key => key !== "format")
    || Object.keys(body.text.format).some(key => key !== "type"))) throw invalid("Speech does not support structured text output");
  const known = new Set(["model", "input", "aoai_speech", "stream", "store", "background", "previous_response_id", "conversation",
    "max_output_tokens", "max_tool_calls", "prompt", "context_management", "reasoning", "instructions", "tools", "tool_choice", "text", "metadata"]);
  const fields = Object.keys(body).filter(key => !known.has(key) && body[key] != null);
  if (fields.length && config.compatibility?.protocolShim?.rejectLossyRequests !== false) throw invalid(`Speech cannot represent fields: ${fields.join(", ")}`);
  if (fields.length) log.warn({ event: "proxy.protocol_shim_lossy_conversion", sourceProtocol: "responses", targetProtocol: "azure-speech", fields }, "Speech Responses omitted non-core fields");
  const options = body.aoai_speech ?? {};
  if (typeof options !== "object" || Array.isArray(options)) throw invalid("aoai_speech must be an object");
  return options;
}

function inputContent(input) {
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.role !== "user"
    || input[0].type != null && input[0].type !== "message" || !Array.isArray(input[0].content)
    || Object.keys(input[0]).some(key => !["role", "type", "content"].includes(key))) {
    throw invalid("Speech requires exactly one user input message");
  }
  return input[0].content;
}

function responseEnvelope(model, metadata, output) {
  return { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", error: null, incomplete_details: null, model, store: false,
    tools: [], tool_choice: "none", parallel_tool_calls: false, metadata: metadata ?? {}, output };
}

export function prepareResponsesSpeechRequest({ body, model, adapter, config, log }) {
  const options = validateProfile(body, config, log);
  if (adapter === "azure-speech-synthesize") return prepareSynthesis(body, options, model, config);
  if (adapter !== "azure-speech-transcribe") throw invalid("Unknown Responses Speech adapter");
  if (Object.keys(options).some(key => key !== "language") || options.language != null
    && (typeof options.language !== "string" || !options.language.trim())) throw invalid("aoai_speech supports a nonempty language string for transcription");
  const content = inputContent(body.input);
  const file = content[0];
  if (content.length !== 1 || file?.type !== "input_file" || typeof file.file_data !== "string"
    || typeof file.filename !== "string" || file.filename.length > 255 || /[\\/\r\n\0]/.test(file.filename)
    || Object.keys(file).some(key => !["type", "file_data", "filename"].includes(key))) throw invalid("Transcription requires one inline input_file with filename and file_data");
  const extension = file.filename.split(".").at(-1).toLowerCase();
  if (!["wav", "mp3", "flac"].includes(extension)) throw invalid("The inline transcription profile accepts WAV, MP3 or FLAC filenames");
  const mime = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac" }[extension];
  let encoded = file.file_data;
  if (encoded.startsWith("data:")) {
    const prefix = /^data:(audio\/(?:wav|x-wav|mpeg|mp3|flac|x-flac));base64,/.exec(encoded);
    if (!prefix) throw invalid("Invalid audio data URL");
    encoded = encoded.slice(prefix[0].length);
  }
  const limits = getMediaHttpLimits(config);
  if (encoded.length > Math.ceil(limits.maxUploadBytes / 3) * 4) throw invalid("Inline audio exceeded its byte limit", 413);
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid("Invalid base64 audio");
  const maxResponseBytes = Math.min(limits.maxResponseBytes, 1024 * 1024);
  const release = reserveMediaBuffer(config, Math.ceil(encoded.length / 4) * 3 * 8 + maxResponseBytes * 12 + 65536);
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > limits.maxUploadBytes) throw invalid("Inline audio exceeded its byte limit", 413);
    if (!bytes.length || bytes.toString("base64") !== encoded) throw invalid("Invalid base64 audio");
    const nextBody = { model: model.id, file: true, response_format: "json", ...(options.language ? { language: options.language } : {}) };
    return { body: nextBody, release, maxResponseBytes, upload: { fields: nextBody, parts: [{ name: "file", file: new Blob([bytes], { type: mime }), filename: file.filename }] },
      mapResponse(chunks) {
        let result;
        try { result = JSON.parse(chunks.toString("utf8")); } catch { throw invalid("Speech returned invalid JSON", 502); }
        const text = mapAzureTranscriptionResult(result, "text");
        return responseEnvelope(model.id, body.metadata, [{ id: `msg_${randomUUID()}`, type: "message", role: "assistant",
          status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
      }
    };
  } catch (error) {
    release();
    throw error;
  }
}

function prepareSynthesis(body, options, model, config) {
  if (Object.keys(options).some(key => !["voice", "response_format"].includes(key))) throw invalid("aoai_speech supports voice and response_format for synthesis");
  const voice = options.voice ?? model.defaultParams?.voice;
  const format = options.response_format ?? model.defaultParams?.response_format ?? "mp3";
  if (!["mp3", "wav", "pcm"].includes(format)) throw invalid("Speech supports mp3, wav or pcm output");
  const mime = { mp3: "audio/mpeg", wav: "audio/wav", pcm: "audio/pcm" }[format];
  let input = body.input;
  if (typeof input !== "string") {
    const content = inputContent(input);
    if (!content.length || content.some(part => part?.type !== "input_text" || typeof part.text !== "string"
      || Object.keys(part).some(key => !["type", "text"].includes(key)))) throw invalid("Voice requires ordered input_text blocks");
    input = content.map(part => part.text).join("");
  }
  const limits = getMediaHttpLimits(config);
  const inputBytes = Buffer.byteLength(input);
  if (!inputBytes || inputBytes > limits.maxUploadBytes) throw invalid("Voice text is empty or exceeds the upload limit", inputBytes ? 413 : 400);
  const overhead = 65536;
  const requestReservation = inputBytes * 16 + overhead;
  const maxResponseBytes = Math.min(limits.maxResponseBytes, Math.floor((limits.maxBufferedUploadBytes - requestReservation) / 10));
  if (maxResponseBytes < 1) throw invalid("Voice buffer capacity is insufficient", 503);
  const release = reserveMediaBuffer(config, requestReservation + maxResponseBytes * 10);
  return { body: { model: model.id, input, voice, response_format: format }, release, maxResponseBytes,
    mapResponse(bytes, headers) {
      if (bytes.length > maxResponseBytes) throw invalid("Audio exceeded its byte limit", 502);
      const contentType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (!bytes.length || !contentType?.startsWith("audio/") && contentType !== "application/octet-stream") {
        throw invalid("Speech returned no audio result", 502);
      }
      const callId = `call_${randomUUID()}`;
      const result = responseEnvelope(model.id, body.metadata, [
        { type: "function_call", id: `fc_${randomUUID()}`, call_id: callId, name: "mai_speech_synthesize", status: "completed",
          arguments: JSON.stringify({ voice, response_format: format }) },
        { type: "function_call_output", id: `fco_${randomUUID()}`, call_id: callId, status: "completed",
          output: [{ type: "input_file", filename: `speech.${format}`, file_data: `data:${mime};base64,${bytes.toString("base64")}` }] }
      ]);
      if (Buffer.byteLength(JSON.stringify(result)) > Math.ceil(maxResponseBytes / 3) * 4 + overhead) throw invalid("Encoded audio exceeded its byte limit", 502);
      return result;
    }
  };
}