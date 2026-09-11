import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

test("multipart preserves JSON-typed field text and handles uploads beyond a stream buffer", { timeout: 10000 }, async () => {
  let received;
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true, maxUploadBytes: 128 * 1024, uploadTimeoutMs: 1000 } };
    const upstream = config.upstreams[0];
    upstream.routes["audio/transcriptions"] = "/v1/audio/transcriptions";
    upstream.routes["audio/translations"] = "/v1/audio/translations";
    config.models.push({ id: "transcribe", targetModel: "whisper-1", pricingRef: "whisper-1", upstream: upstream.name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const jsonText = '{ "large": 9007199254740993, "format": "raw" }';
    const body = Buffer.concat([
      Buffer.from('--media-boundary\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
      Buffer.alloc(80 * 1024, 0xfe),
      Buffer.from(`\r\n--media-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\ntranscribe\r\n--media-boundary\r\nContent-Disposition: form-data; name="definition"\r\nContent-Type: application/json\r\n\r\n${jsonText}\r\n--media-boundary--\r\n`)
    ]);
    const response = await ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body,
      headers: { "content-type": "multipart/form-data; boundary=media-boundary" } });
    assert.equal(response.status, 200, response.text);
    assert.equal(received.get("definition"), jsonText);
    assert.deepEqual(Buffer.from(await received.get("file").arrayBuffer()), Buffer.alloc(80 * 1024, 0xfe));
  }, { upstreamHandler: async ({ req, res, rawBody }) => {
    if (req.url !== "/v1/audio/transcriptions") return false;
    received = await new Response(rawBody, { headers: { "content-type": req.headers["content-type"] } }).formData();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("transcript");
    return true;
  } });
});

test("native media preserves SSE terminals and errors and releases failed streams without retries", async context => {
  let scenario = "complete";
  let wire = "";
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const upstream = config.upstreams[0];
    upstream.routes["audio/speech"] = "/openai/deployments/{deployment}/audio/speech?api-version=2025-04-01-preview";
    config.models.push({ id: "speech", targetModel: "speech-deployment", pricingRef: "gpt-4o-mini-tts", upstream: upstream.name });
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    config.proxy.retries = { ...config.proxy.retries, maxRetries: 2 };
    config.media = { ...config.media, http: { enabled: true, maxResponseBytes: 1024 } };
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    for (const mode of ["complete", "incomplete", "http-error", "provider-error", "oversize", "complete"]) {
      await context.test(mode, async () => {
        scenario = mode;
        ctx.clearUpstreamRequests();
        const request = ctx.publicRequest("/v1/audio/speech", { method: "POST", json: {
          model: "speech", input: "Speak", voice: "alloy", stream_format: "sse"
        } });
        if (["incomplete", "oversize"].includes(mode)) await assert.rejects(request);
        else {
          const response = await request;
          assert.equal(response.status, mode === "http-error" ? 429 : 200, response.text);
          assert.equal(response.text, wire);
          if (mode === "http-error") assert.equal(response.headers.get("retry-after"), "2");
        }
        assert.equal(ctx.upstreamRequests.length, 1);
        assert.equal(ctx.getUpstreamRequest().url, "/openai/deployments/speech-deployment/audio/speech?api-version=2025-04-01-preview");
        assert.equal(ctx.getUpstreamRequest().headers["api-key"], "test-upstream-key");
        const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.media_failed");
        assert.equal(logs.status, 200);
      });
    }
  }, { upstreamHandler: ({ req, res }) => {
    if (!req.url.includes("/audio/speech")) return false;
    if (scenario === "http-error") {
      wire = "upstream quota reached";
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "2" });
    } else if (scenario === "oversize") {
      wire = "X".repeat(2048);
      res.writeHead(200, { "content-type": "audio/mpeg" });
    } else {
      wire = ': native\r\n\r\ndata: {"type":"speech.audio.delta","audio":"AAH/"}\r\n\r\n';
      if (scenario === "complete") wire += 'data: {"type":"speech.audio.done","usage":{"input_tokens":0,"output_tokens":4}}\r\n\r\n';
      if (scenario === "provider-error") wire += 'event: error\r\ndata: {"type":"error","error":{"message":"failed"}}\r\n\r\n';
      res.writeHead(200, { "content-type": "text/event-stream" });
    }
    res.end(wire);
    return true;
  } });
});

test("audio multipart preserves file-before-model bytes and fields and rejects ambiguous controls", async context => {
  const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0xfe, 0x81]);
  let recordedParts;
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const upstream = config.upstreams[0];
    upstream.provider = "openai";
    upstream.routes["audio/transcriptions"] = "/v1/audio/transcriptions";
    upstream.routes["audio/translations"] = "/v1/audio/translations";
    config.models.push({ id: "transcribe", targetModel: "whisper-1", pricingRef: "whisper-1", upstream: upstream.name });
    config.media = { ...config.media, http: { enabled: true, maxUploadBytes: 2048 } };
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const makeForm = () => {
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/wav" }), "clip.wav");
      form.append("model", "transcribe");
      form.append("response_format", "text");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      form.append("provider_extension", "preserved");
      return form;
    };
    for (const operation of ["transcriptions", "translations"]) {
      await context.test(operation, async () => {
        ctx.clearUpstreamRequests();
        const response = await ctx.publicRequest(`/v1/audio/${operation}`, { method: "POST", body: makeForm() });
        assert.equal(response.status, 200, response.text);
        assert.equal(response.text, "Transcribed text\n");
        assert.equal(response.headers.get("content-type"), "text/plain");
        assert.equal(ctx.upstreamRequests.length, 1);
        assert.equal(ctx.getUpstreamRequest().url, `/v1/audio/${operation}`);
        assert.deepEqual(recordedParts, [["file", "clip.wav", "audio/wav", audio], ["model", "whisper-1"],
          ["response_format", "text"], ["timestamp_granularities[]", "word"], ["timestamp_granularities[]", "segment"], ["provider_extension", "preserved"]]);
      });
    }
    for (const scenario of ["duplicate", "oversize", "unauthorized"]) {
      await context.test(scenario, async () => {
        ctx.clearUpstreamRequests();
        const form = makeForm();
        if (scenario === "duplicate") form.append("model", "another-model");
        if (scenario === "oversize") form.append("file", new Blob([Buffer.alloc(4096)]), "large.wav");
        const response = await ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body: form,
          ...(scenario === "unauthorized" ? { headers: { authorization: "Bearer invalid-key" } } : {}) });
        assert.equal(response.status, scenario === "duplicate" ? 400 : scenario === "oversize" ? 413 : 401, response.text);
        assert.equal(ctx.upstreamRequests.length, 0);
      });
    }
  }, { upstreamHandler: async ({ req, res, rawBody }) => {
    if (!req.url.startsWith("/v1/audio/")) return false;
    const form = await new Response(rawBody, { headers: { "content-type": req.headers["content-type"] } }).formData();
    recordedParts = [];
    for (const [name, value] of form) recordedParts.push(typeof value === "string" ? [name, value]
      : [name, value.name, value.type, Buffer.from(await value.arrayBuffer())]);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Transcribed text\n");
    return true;
  } });
});

test("native speech is opt-in and preserves binary audio, model mapping and credential isolation", async () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x81, 0x00, 0x01]);
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const upstream = config.upstreams[0];
    upstream.provider = "openai";
    upstream.headersTemplate = { "Content-Type": "application/template", "Content-Encoding": "gzip" };
    upstream.routes["audio/speech"] = "/v1/audio/speech";
    config.models.push({ id: "speech", targetModel: "gpt-4o-mini-tts", pricingRef: "gpt-4o-mini-tts", upstream: upstream.name });
    const save = async () => {
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
    };
    await save();
    const body = { model: "speech", input: "Read this", voice: { id: "existing-custom-voice" }, response_format: "mp3", extension: true };
    const disabled = await ctx.publicRequest("/v1/audio/speech", { method: "POST", json: body });
    assert.equal(disabled.status, 404);
    assert.equal(ctx.upstreamRequests.length, 0);
    config.media = { ...config.media, http: { enabled: true } };
    await save();
    const response = await ctx.publicRequest("/v1/audio/speech", {
      method: "POST", json: body, headers: { "ocp-apim-subscription-key": "client-secret" }
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(response.bytes, audio);
    assert.equal(ctx.upstreamRequests.length, 1);
    const request = ctx.getUpstreamRequest();
    assert.equal(request.url, "/v1/audio/speech");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["content-encoding"], undefined);
    assert.deepEqual(request.body, { ...body, model: "gpt-4o-mini-tts" });
    assert.equal(request.headers.authorization, "Bearer test-upstream-key");
    for (const name of ["api-key", "x-api-key", "ocp-apim-subscription-key"]) assert.equal(request.headers[name], undefined);
  }, { upstreamHandler: ({ req, res }) => {
    if (req.url !== "/v1/audio/speech") return false;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.write(audio.subarray(0, 4));
    res.end(audio.subarray(4));
    return true;
  } });
});

test("media cancellation and idle timeout release upload reservations and governance leases", { timeout: 10000 }, async () => {
  let started;
  let closed;
  let scenario = "stall";
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const upstream = config.upstreams[0];
    upstream.routes["audio/transcriptions"] = "/v1/audio/transcriptions";
    config.models.push({ id: "transcribe", targetModel: "gpt-4o-transcribe", pricingRef: "gpt-4o-transcribe", upstream: upstream.name });
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    config.media = { ...config.media, http: { enabled: true, maxUploadBytes: 2048, maxBufferedUploadBytes: 6144, maxConcurrentUploads: 1 } };
    config.proxy.timeouts = { ...config.proxy.timeouts, idleMs: 200, firstByteMs: 2000, requestMs: 5000 };
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const makeRequest = async signal => {
      const form = new FormData();
      form.append("file", new Blob(["audio"]), "clip.wav");
      form.append("model", "transcribe");
      const encoded = new Request(`${ctx.baseUrl}/v1/audio/transcriptions`, { method: "POST", body: form });
      return ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body: Buffer.from(await encoded.arrayBuffer()),
        headers: { "content-type": encoded.headers.get("content-type") }, signal });
    };
    for (const mode of ["cancel", "timeout"]) {
      scenario = "stall";
      const upstreamStarted = new Promise(resolve => { started = resolve; });
      const upstreamClosed = new Promise(resolve => { closed = resolve; });
      const controller = new AbortController();
      const failedRequest = assert.rejects(makeRequest(controller.signal));
      await upstreamStarted;
      const blocked = await makeRequest();
      assert.equal(blocked.status, 429, blocked.text);
      if (mode === "cancel") controller.abort();
      await failedRequest;
      await upstreamClosed;
      scenario = "complete";
      const recovered = await makeRequest();
      assert.equal(recovered.status, 200, recovered.text);
      assert.equal(recovered.text, "transcript");
    }
  }, { upstreamHandler: ({ req, res }) => {
    if (req.url !== "/v1/audio/transcriptions") return false;
    res.writeHead(200, { "content-type": "text/plain" });
    if (scenario === "complete") res.end("transcript");
    else {
      res.on("close", () => closed());
      res.write("partial");
      started();
    }
    return true;
  } });
});

test("unmetered media cannot bypass token or monetary governance and uses validated opt-in limits", async () => {
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const loaded = await ctx.adminRequest("/admin/api/config");
    assert.equal(loaded.status, 200, loaded.text);
    config.media = loaded.json.media;
    assert.equal(config.media.http.enabled, false);
    assert.equal(config.media.http.maxUploadBytes, 25 * 1024 * 1024);
    const upstream = config.upstreams[0];
    upstream.routes["audio/speech"] = "/v1/audio/speech";
    config.models.push({ id: "speech", targetModel: "gpt-4o-mini-tts", pricingRef: "gpt-4o-mini-tts", upstream: upstream.name });
    config.media.http.enabled = true;
    const save = () => ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    for (const guard of ["tpm", "budget", "model"]) {
      config.apiKeys[0].rateLimit = guard === "tpm" ? { tpm: 100 } : {};
      config.apiKeys[0].budget = guard === "budget" ? { limitAmount: 1 } : {};
      config.apiKeys[0].allowedModels = guard === "model" ? ["gpt-5-mini"] : [];
      const saved = await save();
      assert.equal(saved.status, 200, saved.text);
      const rejected = await ctx.publicRequest("/v1/audio/speech", { method: "POST", json: { model: "speech", input: "Read", voice: "alloy" } });
      assert.equal(rejected.status, 403, rejected.text);
      assert.equal(rejected.json.error.code, guard === "model" ? "MODEL_ACCESS_DENIED" : "MEDIA_METERING_REQUIRED");
      assert.equal(ctx.upstreamRequests.length, 0);
    }
    config.media.http.maxUploadBytes = -1;
    const invalid = await save();
    assert.equal(invalid.status, 400, invalid.text);
  });
});

test("media native duration usage settles known cost without changing response bytes", async () => {
  const wire = '{"text":"private-transcript", "usage":{"type":"duration","seconds":60}}';
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true } };
    config.upstreams[0].routes["audio/transcriptions"] = "/v1/audio/transcriptions";
    config.upstreams[0].routes["audio/translations"] = "/v1/audio/translations";
    config.models.push({ id: "priced-transcribe", pricingRef: "whisper-1", targetModel: "whisper-1", upstream: config.upstreams[0].name,
      pricing: { currency: "USD", billingUnit: "minute", perMinute: 0.006 } });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const form = new FormData();
    form.append("file", new Blob(["audio"]), "clip.wav");
    form.append("model", "priced-transcribe");
    const result = await ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body: form });
    assert.equal(result.text, wire);
    const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.media_completed");
    assert.match(logs.text, /"costStatus":"priced"/);
    assert.match(logs.text, /"estimatedCostAmount":0.006/);
    assert.equal(logs.text.includes("private-transcript"), false);
  }, { logLevel: "info", upstreamHandler: ({ req, res }) => {
    if (req.url !== "/v1/audio/transcriptions") return false;
    res.writeHead(200, { "content-type": "application/json" }).end(wire);
    return true;
  } });
});

test("media usage observation preserves JSON wire bytes and explicit zero without logging audio or transcript", async () => {
  const wire = '{ "text":"private-transcript", "usage":{"type":"tokens","input_tokens":0,"output_tokens":0,"total_tokens":0} }';
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true } };
    config.observability.logs = { ...config.observability.logs, messageContentMode: "full" };
    config.upstreams[0].routes["audio/transcriptions"] = "/v1/audio/transcriptions";
    config.upstreams[0].routes["audio/translations"] = "/v1/audio/translations";
    config.models.push({ id: "transcribe", targetModel: "whisper-1", pricingRef: "whisper-1", upstream: config.upstreams[0].name });
    assert.equal((await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config })).status, 200);
    const form = new FormData();
    form.append("model", "transcribe");
    form.append("file", new Blob(["private-audio"]), "clip.wav");
    const result = await ctx.publicRequest("/v1/audio/transcriptions", { method: "POST", body: form });
    assert.equal(result.status, 200);
    assert.equal(result.text, wire);
    const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.media_completed");
    assert.match(logs.text, /"usageStatus":"observed"/);
    assert.match(logs.text, /"totalTokens":0/);
    assert.equal(logs.text.includes("private-transcript"), false);
    assert.equal(logs.text.includes("private-audio"), false);
  }, { logLevel: "info", upstreamHandler: ({ req, res }) => {
    if (req.url !== "/v1/audio/transcriptions") return false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(wire);
    return true;
  } });
});