import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { buildMediaMultipart } from "./media-body.js";

const OUTPUT_FORMATS = Object.freeze({
  mp3: "audio-24khz-160kbitrate-mono-mp3",
  wav: "riff-24khz-16bit-mono-pcm",
  pcm: "raw-24khz-16bit-mono-pcm"
});

function speechError(code, message, status = 400) {
  return Object.assign(new Error(message), { status, code });
}

export function getAzureSpeechOperation(targetUrl) {
  const path = new URL(targetUrl).pathname.replace(/\/+$/, "").toLowerCase();
  if (path.endsWith("/cognitiveservices/v1")) return "speech";
  if (path.endsWith("/speechtotext/transcriptions:transcribe")) return "transcriptions";
  return null;
}

function validateVoice(voice, targetModel) {
  if (typeof voice !== "string" || !voice.endsWith(`:${targetModel}`)) {
    throw speechError("SPEECH_MODEL_MISMATCH", "The native voice must belong to the authorized MAI model");
  }
}

function validateSsml(ssml, targetModel) {
  if (typeof ssml !== "string" || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(ssml) || XMLValidator.validate(ssml) !== true) {
    throw speechError("INVALID_SSML", "Valid SSML without document type or entity declarations is required");
  }
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false }).parse(ssml);
  if (!parsed.speak || typeof parsed.speak !== "object") throw speechError("INVALID_SSML", "SSML requires a speak element");
  let voices = 0;
  const pending = [parsed.speak];
  while (pending.length) {
    const node = pending.pop();
    for (const [name, value] of Object.entries(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (name.split(":").at(-1) === "voice") {
          validateVoice(child?.["@_name"], targetModel);
          voices += 1;
        }
        if (child && typeof child === "object") pending.push(child);
      }
    }
  }
  if (!voices) throw speechError("INVALID_SSML", "SSML requires an authorized voice");
}

function checkLosses(body, allowed, config, log) {
  const fields = Object.keys(body).filter(name => !allowed.includes(name));
  if (!fields.length) return;
  if (config.compatibility?.protocolShim?.rejectLossyRequests !== false) {
    throw speechError("LOSSY_SPEECH_REQUEST", "Some request fields cannot be represented by the Speech adapter; use the native endpoint");
  }
  log.warn({ event: "proxy.protocol_shim_lossy_conversion", targetProtocol: "azure-speech", fields }, "Speech request continued with lossy conversion");
}

function singleFile(upload, name) {
  const parts = upload?.parts.filter(part => part.name === name) || [];
  if (parts.length !== 1 || !parts[0].file) throw speechError("SPEECH_AUDIO_REQUIRED", "Exactly one audio file is required");
  return parts[0];
}

export function prepareAzureSpeechRequest({ operation, native, body, rawBody, upload, model, headers, config, log }) {
  const targetModel = model.targetModel || model.id;
  if (operation === "speech") {
    let ssml;
    let outputFormat;
    if (native) {
      ssml = rawBody;
      validateSsml(ssml, targetModel);
      outputFormat = headers["x-microsoft-outputformat"] || OUTPUT_FORMATS.mp3;
    } else {
      validateVoice(body.voice, targetModel);
      if (typeof body.input !== "string") throw speechError("SPEECH_INPUT_REQUIRED", "Speech input must be text");
      if (body.stream === true || body.stream_format && body.stream_format !== "audio") {
        throw speechError("SPEECH_STREAM_UNREPRESENTABLE", "The Speech adapter returns audio bytes, not SSE events");
      }
      outputFormat = OUTPUT_FORMATS[body.response_format || "mp3"];
      if (!outputFormat) throw speechError("SPEECH_FORMAT_UNREPRESENTABLE", "This output format has no Speech mapping; use the native endpoint");
      checkLosses(body, ["model", "voice", "input", "response_format", "stream", "stream_format"], config, log);
      ssml = new XMLBuilder({ ignoreAttributes: false }).build({ speak: {
        "@_version": "1.0", "@_xmlns": "http://www.w3.org/2001/10/synthesis", "@_xml:lang": body.voice.split("-").slice(0, 2).join("-"),
        voice: { "@_name": body.voice, "#text": body.input }
      } });
    }
    return { body: ssml, headers: { "content-type": "application/ssml+xml", "x-microsoft-outputformat": outputFormat, "user-agent": "aoai-proxy" } };
  }
  if (native) {
    singleFile(upload, "audio");
    const definitions = upload.parts.filter(part => part.name === "definition");
    if (definitions.length !== 1 || typeof definitions[0].value !== "string") {
      throw speechError("INVALID_SPEECH_DEFINITION", "Exactly one JSON definition field is required");
    }
    let definition;
    try { definition = JSON.parse(definitions[0].value); } catch {
      throw speechError("INVALID_SPEECH_DEFINITION", "Speech definition must contain JSON");
    }
    if (definition?.enhancedMode?.enabled !== true || definition?.enhancedMode?.model !== targetModel) {
      throw speechError("SPEECH_MODEL_MISMATCH", "Speech definition must select the authorized MAI model");
    }
    const fields = { ...body };
    delete fields.model;
    return { body: buildMediaMultipart(upload, fields), headers: {} };
  }
  const file = singleFile(upload, "file");
  const responseFormat = body.response_format || "json";
  if (!["json", "text"].includes(responseFormat) || body.stream === true || body.stream === "true") {
    throw speechError("SPEECH_RESPONSE_UNREPRESENTABLE", "The Speech adapter supports synchronous json or text; use the native endpoint for detailed results");
  }
  checkLosses(body, ["model", "file", "language", "response_format", "stream"], config, log);
  const definition = { enhancedMode: { enabled: true, model: targetModel } };
  if (body.language) definition.locales = [body.language];
  const form = new FormData();
  form.append("audio", file.file, file.filename);
  form.append("definition", JSON.stringify(definition));
  return { body: form, headers: {}, responseFormat };
}

export function mapAzureTranscriptionResult(value, format) {
  let text;
  if (Array.isArray(value?.combinedPhrases) && value.combinedPhrases.length <= 1
    && value.combinedPhrases.every(phrase => typeof phrase?.text === "string")) {
    text = value.combinedPhrases.map(phrase => phrase.text).join("");
  } else if (Array.isArray(value?.phrases) && value.phrases.every(phrase => typeof phrase?.text === "string" && Number.isFinite(phrase.offsetMilliseconds))) {
    text = [...value.phrases].sort((left, right) => left.offsetMilliseconds - right.offsetMilliseconds).map(phrase => phrase.text).join(" ");
  } else {
    throw speechError("INVALID_SPEECH_RESULT", "Speech returned an unrecognized transcription result", 502);
  }
  return format === "text" ? text : { text };
}