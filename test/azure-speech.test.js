import assert from "node:assert/strict";
import test from "node:test";
import { XMLParser } from "fast-xml-parser";
import { withTestContext } from "./lib/harness.js";
import { mapAzureTranscriptionResult } from "../src/proxy/azure-speech.js";
import { prepareResponsesSpeechRequest } from "../src/proxy/responses-media.js";

test("Azure Speech native and compatible TTS preserve bytes and enforce SSML model ownership", async () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0xff, 0x00, 0xfe]);
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true } };
    const upstream = config.upstreams[0];
    upstream.routes["audio/speech"] = "/cognitiveservices/v1";
    config.models.push({ id: "voice", targetModel: "MAI-Voice-2-Flash", pricingRef: "mai-voice-2-flash", upstream: upstream.name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const voice = "en-US-Harper:MAI-Voice-2-Flash";
    const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${voice}">Read &amp; speak</voice></speak>`;
    const response = await ctx.publicRequest("/v1/providers/azure-speech/voice/speech", {
      method: "POST", headers: { "content-type": "application/ssml+xml", "x-microsoft-outputformat": "audio-24khz-160kbitrate-mono-mp3",
        "ocp-apim-subscription-key": "inbound-secret" }, body: ssml
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.bytes, audio);
    const request = ctx.getUpstreamRequest();
    assert.equal(request.url, "/cognitiveservices/v1");
    assert.equal(request.rawBody.toString(), ssml);
    assert.equal(request.headers["content-type"], "application/ssml+xml");
    assert.equal(request.headers["ocp-apim-subscription-key"], "test-upstream-key");
    assert.equal(request.headers["api-key"], undefined);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-microsoft-outputformat"], "audio-24khz-160kbitrate-mono-mp3");
    for (const responseFormat of ["mp3", "wav", "pcm"]) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/audio/speech", { method: "POST", json: {
        model: "voice", voice, input: '<voice name="other"> & literal text', response_format: responseFormat
      } });
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.bytes, audio);
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(ctx.getUpstreamRequest().rawBody.toString());
      assert.equal(parsed.speak.voice["@_name"], voice);
      assert.equal(parsed.speak.voice["#text"], '<voice name="other"> & literal text');
      assert.equal(ctx.getUpstreamRequest().headers["x-microsoft-outputformat"], {
        mp3: "audio-24khz-160kbitrate-mono-mp3", wav: "riff-24khz-16bit-mono-pcm", pcm: "raw-24khz-16bit-mono-pcm"
      }[responseFormat]);
      ctx.clearUpstreamRequests();
      const wrapped = await ctx.publicRequest("/v1/responses", { method: "POST", json: {
        model: "voice", input: [{ role: "user", content: [{ type: "input_text", text: "Read & " }, { type: "input_text", text: "speak" }] }],
        aoai_speech: { voice, response_format: responseFormat }
      } });
      assert.equal(wrapped.status, 200, wrapped.text);
      assert.equal(wrapped.json.object, "response");
      assert.equal(wrapped.json.status, "completed");
      assert.equal(wrapped.json.model, "voice");
      assert.equal(wrapped.json.store, false);
      assert.equal(wrapped.json.usage, undefined);
      const [call, output] = wrapped.json.output;
      assert.equal(call.type, "function_call");
      assert.equal(call.name, "mai_speech_synthesize");
      assert.equal(call.status, "completed");
      assert.equal(output.type, "function_call_output");
      assert.equal(output.status, "completed");
      assert.equal(call.call_id, output.call_id);
      assert.deepEqual(JSON.parse(call.arguments), { voice, response_format: responseFormat });
      assert.equal(output.output[0].type, "input_file");
      assert.equal(output.output[0].filename, `speech.${responseFormat}`);
      assert.deepEqual(Buffer.from(output.output[0].file_data.split(",")[1], "base64"), audio);
      assert.equal(ctx.upstreamRequests.length, 1);
      const wrappedSsml = new XMLParser({ ignoreAttributes: false }).parse(ctx.getUpstreamRequest().rawBody.toString());
      assert.equal(wrappedSsml.speak.voice["#text"], "Read & speak");
      assert.equal(wrappedSsml.speak.voice["@_name"], voice);
    }
    for (const invalid of [ssml.replace(voice, "en-US-JennyNeural"), '<!DOCTYPE speak [<!ENTITY probe SYSTEM "file:///etc/passwd">]>' + ssml,
      ssml.replace("</speak>", '<voice name="en-US-Harper:MAI-Voice-2">Other model</voice></speak>'), "<speak><voice>"]) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/providers/azure-speech/voice/speech", {
        method: "POST", headers: { "content-type": "application/ssml+xml" }, body: invalid
      });
      assert.equal(result.status, 400, result.text);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    config.compatibility = { protocolShim: { rejectLossyRequests: true } };
    const strict = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(strict.status, 200, strict.text);
    for (const extra of [{ instructions: "unrepresentable style" }, { stream_format: "sse" }, { voice: "alloy" }, { response_format: "flac" }]) {
      ctx.clearUpstreamRequests();
      const rejected = await ctx.publicRequest("/v1/audio/speech", { method: "POST", json: { model: "voice", voice, input: "Hello", ...extra } });
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
  }, { upstreamHandler: ({ req, res }) => {
    if (req.url !== "/cognitiveservices/v1") return false;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(audio);
    return true;
  } });
});

test("Azure Speech transcription binds the native model and maps only documented result text", async () => {
  const result = { durationMilliseconds: 2000, combinedPhrases: [{ text: "Weather" }],
    phrases: [{ offsetMilliseconds: 40, durationMilliseconds: 320, text: "Weather", locale: "en-US", confidence: 0.78983736 }] };
  let received;
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true } };
    const upstream = config.upstreams[0];
    upstream.routes["audio/transcriptions"] = "/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
    config.models.push({ id: "transcribe", targetModel: "MAI-Transcribe-2", pricingRef: "mai-transcribe-2", upstream: upstream.name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const definition = { enhancedMode: { enabled: true, model: "MAI-Transcribe-2" }, diarization: { enabled: true }, locales: ["en"] };
    const audio = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    const native = new FormData();
    native.append("audio", new Blob([audio], { type: "audio/wav" }), "clip.wav");
    native.append("definition", JSON.stringify(definition));
    const response = await ctx.publicRequest("/v1/providers/azure-speech/transcribe/transcriptions", { method: "POST", body: native });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json, result);
    assert.deepEqual(JSON.parse(received.get("definition")), definition);
    assert.equal(received.has("model"), false);
    assert.deepEqual(Buffer.from(await received.get("audio").arrayBuffer()), audio);
    assert.equal(ctx.getUpstreamRequest().headers["ocp-apim-subscription-key"], "test-upstream-key");
    for (const format of ["json", "text"]) {
      const compatible = new FormData();
      compatible.append("file", new Blob([audio], { type: "audio/wav" }), "clip.wav");
      compatible.append("model", "transcribe");
      compatible.append("language", "en");
      compatible.append("response_format", format);
      const response = await ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body: compatible });
      assert.equal(response.status, 200, response.text);
      if (format === "json") assert.deepEqual(response.json, { text: "Weather" });
      else assert.equal(response.text, "Weather");
      assert.deepEqual(JSON.parse(received.get("definition")), { enhancedMode: { enabled: true, model: "MAI-Transcribe-2" }, locales: ["en"] });
    }
    const responsesInput = { model: "transcribe", store: false, aoai_speech: { language: "en" }, input: [{ role: "user", content: [
      { type: "input_file", filename: "clip.wav", file_data: `data:audio/wav;base64,${audio.toString("base64")}` }
    ] }] };
    ctx.clearUpstreamRequests();
    const wrapped = await ctx.publicRequest("/v1/responses", { method: "POST", json: responsesInput });
    assert.equal(wrapped.status, 200, wrapped.text);
    assert.equal(wrapped.json.object, "response");
    assert.equal(wrapped.json.model, "transcribe");
    assert.equal(wrapped.json.status, "completed");
    assert.equal(wrapped.json.store, false);
    assert.equal(wrapped.json.usage, undefined);
    assert.deepEqual(wrapped.json.output[0].content, [{ type: "output_text", text: "Weather", annotations: [] }]);
    assert.equal(ctx.upstreamRequests.length, 1);
    assert.equal(ctx.getUpstreamRequest().url, "/speechtotext/transcriptions:transcribe?api-version=2025-10-15");
    assert.equal(ctx.getUpstreamRequest().headers["ocp-apim-subscription-key"], "test-upstream-key");
    assert.deepEqual(Buffer.from(await received.get("audio").arrayBuffer()), audio);
    assert.deepEqual(JSON.parse(received.get("definition")), { enhancedMode: { enabled: true, model: "MAI-Transcribe-2" }, locales: ["en"] });
    for (const extra of [{ stream: true }, { store: true }, { previous_response_id: "resp_old" }, { instructions: "Summarize instead" }]) {
      ctx.clearUpstreamRequests();
      const rejected = await ctx.publicRequest("/v1/responses", { method: "POST", json: { ...responsesInput, ...extra } });
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    ctx.clearUpstreamRequests();
    native.set("definition", JSON.stringify({ enhancedMode: { enabled: true, model: "other" } }));
    const denied = await ctx.publicRequest("/v1/providers/azure-speech/transcribe/transcriptions", { method: "POST", body: native });
    assert.equal(denied.status, 400, denied.text);
    assert.equal(ctx.upstreamRequests.length, 0);
    native.append("definition", JSON.stringify(definition));
    const duplicate = await ctx.publicRequest("/v1/providers/azure-speech/transcribe/transcriptions", { method: "POST", body: native });
    assert.equal(duplicate.status, 400, duplicate.text);
    assert.equal(ctx.upstreamRequests.length, 0);
    native.set("definition", JSON.stringify(definition));
    native.append("trigger_error", "true");
    const providerError = await ctx.publicRequest("/v1/providers/azure-speech/transcribe/transcriptions", { method: "POST", body: native });
    assert.equal(providerError.status, 429, providerError.text);
    assert.equal(providerError.headers.get("retry-after"), "3");
    assert.deepEqual(providerError.json, { code: "TooManyRequests", message: "Speech limit", native: true });
  }, { upstreamHandler: async ({ req, res, rawBody }) => {
    if (!req.url.startsWith("/speechtotext/transcriptions:transcribe")) return false;
    received = await new Response(rawBody, { headers: { "content-type": req.headers["content-type"] } }).formData();
    if (received.has("trigger_error")) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
      res.end(JSON.stringify({ code: "TooManyRequests", message: "Speech limit", native: true }));
      return true;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return true;
  } });
});

test("Responses Speech bounds buffers and releases its shared reservation idempotently", () => {
  const config = { media: { http: { maxUploadBytes: 16, maxResponseBytes: 16, maxBufferedUploadBytes: 70000, maxConcurrentUploads: 1 } } };
  const model = { id: "voice", targetModel: "MAI-Voice-2", defaultParams: { voice: "en-US-Harper:MAI-Voice-2" } };
  const prepare = () => prepareResponsesSpeechRequest({ body: { input: "Hello" }, model, adapter: "azure-speech-synthesize", config, log: { warn() {} } });
  const first = prepare();
  assert.throws(prepare, error => error.status === 429 || error.status === 503);
  assert.equal(first.body.voice, model.defaultParams.voice);
  assert.equal(first.maxResponseBytes, 16);
  first.release();
  first.release();
  const second = prepare();
  second.release();
});

test("Responses Speech enforces local boundaries, preserves provider errors and recovers after bounded failures", async () => {
  let mode = "success";
  const audio = Buffer.from("private-audio-fixture");
  const transcript = "private-transcript-fixture";
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true, maxUploadBytes: 32, maxResponseBytes: 512, maxConcurrentUploads: 1 } };
    config.routing = { routeProfiles: {} };
    config.models = [];
    config.observability.logs = { ...config.observability.logs, messageContentMode: "full" };
    const upstream = config.upstreams[0];
    upstream.routes["audio/speech"] = "/cognitiveservices/v1";
    upstream.routes["audio/transcriptions"] = "/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
    config.models.push({ id: "voice", pricingRef: "mai-voice-2", targetModel: "MAI-Voice-2", upstream: upstream.name,
      defaultParams: { voice: "en-US-Harper:MAI-Voice-2" } },
    { id: "transcribe", pricingRef: "mai-transcribe-2", targetModel: "MAI-Transcribe-2", upstream: upstream.name,
      pricing: { currency: "EUR", billingUnit: "minute", perMinute: 0.006 } });
    const save = async () => {
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
    };
    await save();
    const file = { type: "input_file", filename: "clip.wav", file_data: audio.toString("base64") };
    const input = { model: "transcribe", input: [{ role: "user", content: [file] }] };
    const voice = { model: "voice", input: "Read & speak" };
    const send = json => ctx.publicRequest("/v1/responses", { method: "POST", json });
    for (const value of [
      { ...input, input: [{ role: "system", content: [file] }] },
      { ...input, input: [...input.input, ...input.input] },
      ...[{ file_data: "AA=A" }, { file_data: "Zh==" }, { file_data: "" }, { file_url: "https://example.org/audio.wav" },
        { file_id: "file_1" }, { filename: "../clip.wav" }, { file_data: Buffer.alloc(33).toString("base64") }]
        .map(extra => ({ ...input, input: [{ role: "user", content: [{ ...file, ...extra }] }] })),
      { ...input, input: [{ role: "user", content: [file, file] }] },
      { ...input, aoai_speech: { model: "other" } },
      { ...voice, aoai_speech: { voice: "en-US-Harper:MAI-Voice-2-Flash" } },
      { ...voice, aoai_speech: { response_format: "toString" } },
      { ...voice, input: [{ role: "user", content: [file] }] },
      { ...voice, stream: true }, { ...voice, background: true }, { ...voice, conversation: "conv_1" },
      { ...voice, tools: [{ type: "function", name: "do_something" }] }, { ...voice, max_output_tokens: 10 },
      { ...voice, reasoning: { effort: "low" } }, { ...voice, text: { format: { type: "json_object" } } }
    ]) {
      ctx.clearUpstreamRequests();
      const response = await send(value);
      assert.ok([400, 413].includes(response.status), response.text);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    for (const guard of ["model", "budget", "tpm", "enabled", "responses-route", "physical-route"]) {
      config.apiKeys[0].allowedModels = guard === "model" ? ["voice"] : [];
      config.apiKeys[0].budget = guard === "budget" ? { limitAmount: 1 } : { currency: "EUR" };
      config.apiKeys[0].rateLimit = guard === "tpm" ? { tpm: 1 } : {};
      config.media.http.enabled = guard !== "enabled";
      config.routing.routeProfiles.responses = { enabled: guard !== "responses-route" };
      config.routing.routeProfiles["audio/transcriptions"] = { enabled: guard !== "physical-route" };
      await save();
      ctx.clearUpstreamRequests();
      const rejected = await send(input);
      assert.ok([403, 404].includes(rejected.status), `${guard}: ${rejected.text}`);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    config.routing.routeProfiles["audio/transcriptions"].enabled = true;
    config.compatibility = { protocolShim: { rejectLossyRequests: true } };
    await save();
    ctx.clearUpstreamRequests();
    assert.equal((await send({ ...input, temperature: 0.4 })).status, 400);
    assert.equal(ctx.upstreamRequests.length, 0);
    config.compatibility.protocolShim.rejectLossyRequests = false;
    await save();
    assert.equal((await send({ ...input, temperature: 0.4 })).status, 200);
    for (const request of [input, voice]) {
      for (const failure of ["provider-error", "invalid", "oversize", "success"]) {
        mode = failure;
        ctx.clearUpstreamRequests();
        const result = await send(request);
        assert.equal(ctx.upstreamRequests.length, 1);
        if (failure === "provider-error") {
          assert.equal(result.status, 415, result.text);
          assert.equal(result.headers.get("retry-after"), "3");
          assert.deepEqual(result.json, { code: "UnsupportedAudio", message: "Provider rejected content" });
        } else if (failure === "success") {
          assert.equal(result.status, 200, result.text);
          assert.equal(result.json.status, "completed");
        } else {
          assert.equal(result.status, 502, result.text);
          assert.equal(result.json.object, undefined);
        }
      }
    }
    const stats = await ctx.adminRequest("/admin/api/stats");
    assert.equal(stats.json.perModel.transcribe.requests, 5);
    assert.equal(stats.json.perModel.transcribe.media.requests, 5);
    assert.equal(stats.json.perModel.transcribe.estimatedCostAmount, 0.012);
    assert.equal(stats.json.perModel.transcribe.estimatedCostCurrency, "USD");
    assert.deepEqual(stats.json.perModel.transcribe.media.costAmounts, { USD: 0.012 });
    assert.equal(stats.json.perModel.voice.requests, 4);
    assert.equal(stats.json.perModel.voice.media.unknownCostRequests, 4);
    const logs = await ctx.adminRequest("/admin/api/logs");
    assert.match(logs.text, /"routeKey":"responses"/);
    assert.match(logs.text, /"backendRouteKey":"audio\/transcriptions"/);
    assert.match(logs.text, /"estimatedCostAmount":0.006/);
    assert.match(logs.text, /proxy.protocol_shim_lossy_conversion/);
    for (const secret of [transcript, audio.toString(), audio.toString("base64"), voice.input]) assert.equal(logs.text.includes(secret), false);
  }, { logLevel: "info", upstreamHandler: ({ req, res }) => {
    if (req.url !== "/cognitiveservices/v1" && !req.url.startsWith("/speechtotext/")) return false;
    if (mode === "provider-error") res.writeHead(415, { "content-type": "application/json", "retry-after": "3" }).end(JSON.stringify({ code: "UnsupportedAudio", message: "Provider rejected content" }));
    else if (mode === "invalid") res.writeHead(200, { "content-type": "application/json" }).end("{}");
    else if (mode === "oversize") res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.alloc(513));
    else if (req.url === "/cognitiveservices/v1") res.writeHead(200, { "content-type": "audio/mpeg" }).end(audio);
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ durationMilliseconds: 60000, combinedPhrases: [{ text: transcript }] }));
    return true;
  } });
});

test("buffered Responses Speech cancels upstream and releases capacity after disconnect or timeout", { timeout: 15000 }, async () => {
  let started;
  let closed;
  let stall = true;
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.models = [
      { id: "voice", pricingRef: "mai-voice-2", targetModel: "MAI-Voice-2", upstream: config.upstreams[0].name,
        defaultParams: { voice: "en-US-Harper:MAI-Voice-2" } },
      { id: "transcribe", pricingRef: "mai-transcribe-2", targetModel: "MAI-Transcribe-2", upstream: config.upstreams[0].name }
    ];
    config.upstreams[0].routes["audio/speech"] = "/cognitiveservices/v1";
    config.upstreams[0].routes["audio/transcriptions"] = "/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    config.media = { http: { enabled: true, maxUploadBytes: 2048, maxResponseBytes: 2048, maxConcurrentUploads: 1 } };
    config.proxy.timeouts = { ...config.proxy.timeouts, idleMs: 250, firstByteMs: 2000, requestMs: 5000 };
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    for (const body of [{ model: "voice", input: "Read" }, { model: "transcribe", input: [{ role: "user", content: [
      { type: "input_file", filename: "clip.wav", file_data: "YXVkaW8=" }
    ] }] }]) {
      const send = signal => ctx.publicRequest("/v1/responses", { method: "POST", json: body, signal });
      for (const mode of ["cancel", "timeout"]) {
        stall = true;
        const upstreamStarted = new Promise(resolve => { started = resolve; });
        const upstreamClosed = new Promise(resolve => { closed = resolve; });
        const controller = new AbortController();
        const pending = send(controller.signal);
        const cancelled = mode === "cancel" ? assert.rejects(pending) : null;
        await upstreamStarted;
        assert.equal((await send()).status, 429);
        if (mode === "cancel") {
          controller.abort();
          await cancelled;
        } else {
          const result = await pending;
          assert.equal(result.status, 504, result.text);
        }
        await upstreamClosed;
        stall = false;
        const recovered = await send();
        assert.equal(recovered.status, 200, recovered.text);
        assert.equal(recovered.json.status, "completed");
      }
    }
  }, { upstreamHandler: ({ req, res }) => {
    if (req.url !== "/cognitiveservices/v1" && !req.url.startsWith("/speechtotext/")) return false;
    const speech = req.url === "/cognitiveservices/v1";
    res.writeHead(200, { "content-type": speech ? "audio/mpeg" : "application/json" });
    if (stall) {
      res.on("close", () => closed());
      res.write(speech ? "audio" : "{");
      started();
    } else res.end(speech ? "audio" : JSON.stringify({ combinedPhrases: [{ text: "Recovered" }] }));
    return true;
  } });
});

test("Speech result mapping preserves ordered text and rejects unknown structures", () => {
  const result = { combinedPhrases: [{ channel: 0, text: "Later" }, { channel: 1, text: "Earlier" }],
    phrases: [{ offsetMilliseconds: 10, text: "Later" }, { offsetMilliseconds: 0, text: "Earlier" }] };
  const original = structuredClone(result);
  assert.deepEqual(mapAzureTranscriptionResult(result, "json"), { text: "Earlier Later" });
  assert.deepEqual(result, original);
  assert.equal(mapAzureTranscriptionResult({ combinedPhrases: [] }, "text"), "");
  for (const invalid of [{}, null, { combinedPhrases: [{ text: 12 }] }, { combinedPhrases: [null] }]) {
    assert.throws(() => mapAzureTranscriptionResult(invalid, "text"), error => error.status === 502 && error.code === "INVALID_SPEECH_RESULT");
  }
});