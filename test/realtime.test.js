import assert from "node:assert/strict";
import test from "node:test";
import { once, on } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { renderCaddyfile } from "../src/caddy.js";
import { mapRealtimeEvent } from "../src/proxy/realtime-policy.js";
import { withTestContext } from "./lib/harness.js";

function connect(ctx, path, headers = {}) {
  const socket = new WebSocket(`${ctx.baseUrl.replace(/^http/, "ws")}${path}`, {
    headers: { authorization: "Bearer test-client-key", ...headers }, handshakeTimeout: 3000
  });
  socket.on("error", () => {});
  return socket;
}

if (process.env.REALTIME_CADDY_TEST_IMAGE) test("generated Caddy reverse proxy preserves realtime messages, idle closure and audio bytes", { timeout: 20000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  upstreamServer.on("connection", socket => socket.on("message", data => socket.send(data, { binary: false })));
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  const audio = Buffer.from([0, 255, 1, 128, 4, 0, 25]);
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { http: { enabled: true }, realtime: { enabled: true, idleTimeoutMs: 800 } };
    config.upstreams[0].routes["audio/speech"] = "/v1/audio/speech";
    const realtimeUpstream = { ...config.upstreams[0], name: "caddy-realtime", baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, routes: { realtime: "/v1/realtime" } };
    config.upstreams.push(realtimeUpstream);
    config.models.push({ id: "caddy-voice", pricingRef: "gpt-realtime-2", upstream: realtimeUpstream.name });
    config.models.push({ id: "caddy-speech", pricingRef: "gpt-4o-mini-tts", upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const portReservation = http.createServer();
    portReservation.listen(0, "127.0.0.1");
    await once(portReservation, "listening");
    const port = portReservation.address().port;
    await new Promise(resolve => portReservation.close(resolve));
    const generated = renderCaddyfile({ server: { caddy: { enabled: true, domain: "http://127.0.0.1", email: "test@example.com",
      httpsPort: port, upstreamHost: "127.0.0.1", upstreamPort: Number(new URL(ctx.baseUrl).port) } } });
    const container = `aoai-media-caddy-${process.pid}`;
    const child = spawn("docker", ["run", "--rm", "-i", "--network", "host", "--name", container, "--entrypoint", "caddy",
      process.env.REALTIME_CADDY_TEST_IMAGE, "run", "--config", "/dev/stdin", "--adapter", "caddyfile"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Caddy startup timeout: ${output}`)), 5000);
      const collect = chunk => { output += chunk.toString(); if (output.includes("serving initial configuration")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); if (code) reject(new Error(output)); });
    });
    child.stdin.end(generated.replace("{\n", "{\n  admin off\n"));
    try {
      await ready;
      const baseUrl = `http://127.0.0.1:${port}`;
      const response = await fetch(`${baseUrl}/v1/audio/speech`, { method: "POST", headers: { authorization: "Bearer test-client-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "caddy-speech", input: "test", voice: "alloy" }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
      const socket = connect({ baseUrl }, "/v1/realtime?model=caddy-voice");
      const events = on(socket, "message", { signal: AbortSignal.timeout(5000) });
      try {
        await once(socket, "open", { signal: AbortSignal.timeout(3000) });
        for (let index = 0; index < 3; index += 1) {
          const event = JSON.stringify({ type: "input_audio_buffer.append", audio: "A".repeat(65536), index });
          socket.send(event);
          assert.equal((await events.next()).value[0].toString(), event);
        }
        const [code, reason] = await once(socket, "close", { signal: AbortSignal.timeout(3000) });
        assert.equal(code, 1011);
        assert.equal(reason.toString(), "REALTIME_IDLE_TIMEOUT");
      } finally { await events.return(); socket.terminate(); }
    } finally { await promisify(execFile)("docker", ["rm", "-f", container]); }
  }, { upstreamHandler: ({ req, res }) => {
    if (req.url !== "/v1/audio/speech") return false;
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.write(audio.subarray(0, 3));
    res.end(audio.subarray(3));
    return true;
  } });
});

async function rejectedHandshake(ctx, path, headers) {
  const socket = connect(ctx, path, headers);
  const [request, response] = await once(socket, "unexpected-response", { signal: AbortSignal.timeout(5000) });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  socket.terminate();
  return { status: response.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: response.headers };
}

test("Realtime model edits preserve unrelated JSON tokens and reject ambiguous routing fields", () => {
  const binding = { model: { id: "voice", targetModel: "deployment" }, modelNames: new Map([["deployment", "voice"]]) };
  const raw = '{"type":"session.update", "session":{"model":"voice", "extension":9007199254740993, "scale":1.2300}}';
  const mapped = mapRealtimeEvent(Buffer.from(raw), binding, {}, {}, true);
  assert.equal(mapped.data.toString(), raw.replace('"model":"voice"', '"model":"deployment"'));
  assert.equal(mapRealtimeEvent(mapped.data, binding, {}, {}, false).data.toString(), raw);
  for (const invalid of [
    '{"type":"session.update","session":{"model":"other","model":"voice"}}',
    '{"type":"session.update","session":{"model":"other"},"session":{"model":"voice"}}'
  ]) assert.throws(() => mapRealtimeEvent(Buffer.from(invalid), binding, {}, {}, true), { code: "AMBIGUOUS_REALTIME_EVENT" });
});

test("Realtime is opt-in and rejects invalid ingress credentials before upgrade", { timeout: 10000 }, async () => {
  await withTestContext(async ctx => {
    assert.equal((await rejectedHandshake(ctx, "/v1/realtime?model=voice")).status, 404);
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    assert.equal((await rejectedHandshake(ctx, "/v1/realtime?model=voice", { authorization: "Bearer invalid" })).status, 401);
    assert.equal((await rejectedHandshake(ctx, "/v1/realtime?model=missing")).status, 404);
    assert.equal((await rejectedHandshake(ctx, "/v1/realtime/transcriptions?model=voice")).status, 404);
    assert.equal(ctx.upstreamRequests.length, 0);
  });
});

test("Realtime native WebSocket contracts preserve events, model mapping and isolated credentials", { timeout: 15000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  const requests = [];
  const messages = [];
  upstreamServer.on("connection", (socket, request) => {
    requests.push({ url: request.url, headers: request.headers });
    const model = new URL(request.url, "http://mock").searchParams.get("model");
    socket.send(JSON.stringify({ type: "session.created", session: { id: "native-session", model, native: true } }));
    socket.on("message", data => {
      messages.push(JSON.parse(data.toString()));
      socket.send(data, { binary: false });
    });
  });
  await withTestContext(async ctx => {
    for (const provider of ["openai", "azure-openai"]) {
      for (const routeKey of ["realtime", "realtime/translations"]) {
        const config = await ctx.readConfigFile();
        config.media = { realtime: { enabled: true } };
        const upstream = config.upstreams[0];
        upstream.provider = provider;
        upstream.baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
        const prefix = provider === "openai" ? "/v1/" : "/openai/v1/";
        upstream.routes[routeKey] = `${prefix}${routeKey}`;
        config.models = config.models.filter(model => model.id !== "voice");
        config.models.push({ id: "voice", targetModel: "deployment-voice", pricingRef: routeKey === "realtime" ? "gpt-realtime-2" : "gpt-realtime-translate", upstream: upstream.name });
        const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
        assert.equal(saved.status, 200, saved.text);
        const socket = connect(ctx, `/v1/${routeKey}?model=voice`, { "api-key": "ingress-secret", "ocp-apim-subscription-key": "ingress-secret" });
        const events = on(socket, "message", { signal: AbortSignal.timeout(5000) });
        try {
          await once(socket, "open", { signal: AbortSignal.timeout(5000) });
          const created = JSON.parse((await events.next()).value[0].toString());
          assert.deepEqual(created, { type: "session.created", session: { id: "native-session", model: "voice", native: true } });
          const upstreamRequest = requests.at(-1);
          assert.equal(upstreamRequest.url, `${prefix}${routeKey}?model=deployment-voice`);
          assert.equal(upstreamRequest.headers[provider === "openai" ? "authorization" : "api-key"], provider === "openai" ? "Bearer test-upstream-key" : "test-upstream-key");
          assert.equal(upstreamRequest.headers[provider === "openai" ? "api-key" : "authorization"], undefined);
          assert.equal(upstreamRequest.headers["ocp-apim-subscription-key"], undefined);
          assert.equal(upstreamRequest.headers["openai-beta"], undefined);
          const event = { type: "session.update", session: { model: "voice", instructions: "Preserve", extension: { untouched: true } } };
          socket.send(JSON.stringify(event));
          assert.deepEqual(JSON.parse((await events.next()).value[0].toString()), event);
          assert.equal(messages.at(-1).session.model, "deployment-voice");
          const audioEvent = `{"type":"${routeKey === "realtime" ? "input_audio_buffer.append" : "session.input_audio_buffer.append"}", "audio":"//4AAQ==", "extension":9007199254740993}`;
          socket.send(audioEvent);
          assert.equal((await events.next()).value[0].toString(), audioEvent);
        } finally {
          await events.return();
          if (socket.readyState !== WebSocket.CLOSED) {
            const closed = once(socket, "close", { signal: AbortSignal.timeout(2000) });
            if (socket.readyState === WebSocket.OPEN) socket.close(1000);
            else socket.terminate();
            await closed;
          }
        }
      }
    }
  });
});

test("Realtime upstream handshake errors preserve status, body and retry-after without upgrading", { timeout: 10000 }, async testContext => {
  let attempts = 0;
  const upstreamServer = http.createServer((request, response) => {
    attempts += 1;
    response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    response.end('{"error":{"type":"rate_limit","native":true}}');
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", targetModel: "gpt-realtime-2", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const result = await rejectedHandshake(ctx, "/v1/realtime?model=voice");
    assert.equal(result.status, 429);
    assert.equal(result.headers["retry-after"], "7");
    assert.equal(result.text, '{"error":{"type":"rate_limit","native":true}}');
    assert.equal(attempts, 1);
  });
});

test("Realtime transcription selects an authorized public model in its first bounded configuration", { timeout: 15000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  const requests = [];
  const messages = [];
  upstreamServer.on("connection", (socket, request) => {
    requests.push(request.url);
    socket.send('{"type":"session.created","session":{"type":"transcription","id":"native"}}');
    socket.on("message", data => {
      const event = JSON.parse(data.toString());
      messages.push(event);
      socket.send(JSON.stringify({ ...event, type: "session.updated" }));
    });
  });
  await withTestContext(async ctx => {
    for (const provider of ["openai", "azure-openai"]) {
      const config = await ctx.readConfigFile();
      config.media = { realtime: { enabled: true, initialConfigTimeoutMs: 250 } };
      const upstream = config.upstreams[0];
      upstream.provider = provider;
      upstream.baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
      const prefix = provider === "openai" ? "/v1/" : "/openai/v1/";
      upstream.routes["realtime/transcription_sessions"] = `${prefix}realtime?intent=transcription`;
      config.models = config.models.filter(model => model.id !== "transcribe");
      config.models.push({ id: "transcribe", targetModel: "deployed-transcriber", pricingRef: "gpt-realtime-whisper", upstream: upstream.name });
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
      const socket = connect(ctx, "/v1/realtime?intent=transcription");
      const events = on(socket, "message", { signal: AbortSignal.timeout(3000) });
      try {
        await once(socket, "open");
        const before = requests.length;
        socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: {
          format: { type: "audio/pcm", rate: 24000 }, turn_detection: null,
          transcription: { model: "transcribe", language: "en", delay: "medium" }
        } } } }));
        assert.equal(JSON.parse((await events.next()).value[0].toString()).type, "session.created");
        const update = JSON.parse((await events.next()).value[0].toString());
        assert.equal(update.session.audio.input.transcription.model, "transcribe");
        assert.equal(messages.at(-1).session.audio.input.transcription.model, "deployed-transcriber");
        assert.equal(requests.length, before + 1);
        assert.equal(requests.at(-1), `${prefix}realtime?intent=transcription`);
      } finally {
        await events.return();
        socket.terminate();
      }
      for (const invalid of [null, { type: "input_audio_buffer.append", audio: "AA==" },
        { type: "session.update", session: { type: "transcription", audio: { input: { transcription: { model: "other" } } } } }]) {
        const before = requests.length;
        const rejected = connect(ctx, "/v1/realtime?intent=transcription");
        await once(rejected, "open");
        const closed = once(rejected, "close", { signal: AbortSignal.timeout(3000) });
        if (invalid) rejected.send(JSON.stringify(invalid));
        assert.notEqual((await closed)[0], 1000);
        assert.equal(requests.length, before);
      }
    }
  });
});

test("Realtime leases span the connection and response.done is not a session terminal", { timeout: 15000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  let connections = 0;
  upstreamServer.on("connection", socket => {
    connections += 1;
    socket.send('{"type":"session.created","session":{"model":"deployment"}}');
    socket.on("message", data => {
      const event = JSON.parse(data.toString());
      if (event.type === "response.create") {
        socket.send('{"type":"input_audio_buffer.committed","item_id":"no-transcription"}');
        socket.send('{"type":"response.created","response":{"id":"response-1"}}');
        socket.send('{"type":"response.done","response":{"id":"response-1","status":"completed","usage":{"total_tokens":0}}}');
      } else if (event.type === "session.close") socket.close(1000, "done");
      else socket.send(data, { binary: false });
    });
  });
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    assert.equal((await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config })).status, 200);
    const socket = connect(ctx, "/v1/realtime?model=voice");
    const events = on(socket, "message", { signal: AbortSignal.timeout(5000) });
    try {
      await once(socket, "open");
      await events.next();
      const denied = await rejectedHandshake(ctx, "/v1/realtime?model=voice");
      assert.equal(denied.status, 429, denied.text);
      assert.equal(connections, 1);
      socket.send('{"type":"response.create"}');
      await events.next();
      await events.next();
      assert.equal(JSON.parse((await events.next()).value[0].toString()).type, "response.done");
      socket.send('{"type":"session.update","session":{"instructions":"still connected"}}');
      assert.equal(JSON.parse((await events.next()).value[0].toString()).session.instructions, "still connected");
      const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
      socket.send('{"type":"session.close"}');
      assert.equal((await closed)[0], 1000);
      const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.realtime_closed");
      assert.match(logs.text, /"usageStatus":"observed"/);
      assert.match(logs.text, /"totalTokens":0/);
      const recovered = connect(ctx, "/v1/realtime?model=voice");
      try { await once(recovered, "open"); } finally { recovered.terminate(); }
      assert.equal(connections, 2);
    } finally {
      await events.return();
      socket.terminate();
    }
  }, { logLevel: "info" });
});

test("Realtime observes native response, transcription and translation terminals independently", { timeout: 15000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  let scenario;
  upstreamServer.on("connection", socket => {
    socket.on("message", () => {
      for (const event of scenario.events) socket.send(JSON.stringify(event));
      socket.close(1000, "provider-end");
    });
  });
  const cases = [
    { route: "realtime", events: [{ type: "response.created", response: { id: "incomplete" } }], complete: false },
    { route: "realtime", events: [{ type: "error", error: { type: "invalid_request_error", code: "native", message: "nonfatal" } }], complete: true },
    { route: "realtime/translations", events: [{ type: "session.output_audio.delta", delta: "AA==" }], complete: false },
    { route: "realtime/translations", events: [{ type: "session.output_audio.delta", delta: "AA==" }, { type: "session.closed" }], complete: true },
    { route: "realtime/transcription_sessions", events: [
      { type: "input_audio_buffer.committed", item_id: "first" },
      { type: "input_audio_buffer.committed", item_id: "second" },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "second" },
      { type: "conversation.item.input_audio_transcription.failed", item_id: "first", error: { code: "native" } }
    ], complete: true },
    { route: "realtime/transcription_sessions", events: [{ type: "input_audio_buffer.committed", item_id: "unfinished" }], complete: false }
  ];
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    Object.assign(config.upstreams[0].routes, { realtime: "/v1/realtime", "realtime/translations": "/v1/realtime/translations", "realtime/transcription_sessions": "/v1/realtime?intent=transcription" });
    const cards = { realtime: "gpt-realtime-2", "realtime/translations": "gpt-realtime-translate", "realtime/transcription_sessions": "gpt-realtime-whisper" };
    for (const [route, pricingRef] of Object.entries(cards)) config.models.push({ id: route, pricingRef, upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    for (scenario of cases) {
      const transcription = scenario.route === "realtime/transcription_sessions";
      const path = `/v1/${transcription ? "realtime" : scenario.route}?model=${encodeURIComponent(scenario.route)}${transcription ? "&intent=transcription" : ""}`;
      const socket = connect(ctx, path);
      const received = [];
      socket.on("message", data => received.push(JSON.parse(data.toString())));
      try {
        await once(socket, "open");
        const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
        socket.send(JSON.stringify({ type: scenario.route === "realtime/translations" ? "session.close" : "session.update", session: {} }));
        assert.equal((await closed)[0], scenario.complete ? 1000 : 1011, scenario.route);
        assert.deepEqual(received, scenario.events);
      } finally { socket.terminate(); }
    }
  });
});

test("Realtime settles distinct response and transcription prices without duplicate terminal charges", { timeout: 10000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  upstreamServer.on("connection", socket => socket.on("message", data => {
    const update = JSON.parse(data.toString());
    socket.send(JSON.stringify({ ...update, type: "session.updated" }));
    socket.send('{"type":"input_audio_buffer.committed","item_id":"transcript-1"}');
    socket.send('{"type":"response.created","response":{"id":"response-1"}}');
    const response = JSON.stringify({ type: "response.done", response: { id: "response-1", usage: {
      input_tokens: 100, output_tokens: 0, total_tokens: 100, input_token_details: { audio_tokens: 100, cached_tokens: 0 }
    } } });
    socket.send(response);
    socket.send(response);
    socket.send('{"type":"conversation.item.input_audio_transcription.completed","item_id":"transcript-1","usage":{"type":"duration","seconds":30}}');
    socket.close(1000);
  }));
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.upstreams[0].provider = "openai";
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    Object.assign(config.upstreams[0].routes, { realtime: "/v1/realtime", "realtime/transcription_sessions": "/v1/realtime?intent=transcription" });
    config.models.push({ id: "voice-priced", pricingRef: "gpt-realtime-2", targetModel: "voice-deployment", upstream: config.upstreams[0].name });
    config.models.push({ id: "transcript-priced", pricingRef: "gpt-realtime-whisper", targetModel: "transcript-deployment", upstream: config.upstreams[0].name,
      pricing: { currency: "USD", billingUnit: "minute", perMinute: 0.006 } });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const socket = connect(ctx, "/v1/realtime?model=voice-priced");
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(3000) });
      const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ type: "session.update", session: { audio: { input: { transcription: { model: "transcript-priced" } } } } }));
      assert.equal((await closed)[0], 1000);
      const logs = await ctx.adminRequest("/admin/api/logs?event=proxy.realtime_closed");
      const usage = logs.json.items.find(entry => entry.modelId === "voice-priced");
      assert.equal(usage.fields.costStatus, "priced");
      assert.ok(Math.abs(usage.estimatedCostAmount - 0.0062) < 1e-12);
      assert.equal(usage.fields.counters.inputTokens, 100);
      assert.equal(usage.fields.counters.durationSeconds, 30);
    } finally { socket.terminate(); }
  }, { logLevel: "info" });
});

test("Realtime backpressure bounds both directions and recovers connection capacity", { timeout: 20000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true, maxConnections: 1, maxMessageBytes: 1024,
      maxInitialConfigBytes: 256, maxBufferedBytes: 1024, idleTimeoutMs: 2000 } };
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    for (const fromClient of [true, false]) {
      const connected = once(upstreamServer, "connection", { signal: AbortSignal.timeout(3000) });
      const downstream = connect(ctx, "/v1/realtime?model=voice");
      const opened = once(downstream, "open", { signal: AbortSignal.timeout(3000) });
      const [upstream] = await connected;
      await opened;
      const source = fromClient ? downstream : upstream;
      const receiver = fromClient ? upstream : downstream;
      const sourceClosed = once(source, "close", { signal: AbortSignal.timeout(5000) });
      const receiverClosed = once(receiver, "close", { signal: AbortSignal.timeout(5000) });
      try {
        receiver.pause();
        const payload = JSON.stringify({ type: "native.extension", data: "a".repeat(800) });
        for (let index = 0; index < 12000; index += 1) source.send(payload);
        const [code, reason] = await sourceClosed;
        assert.equal(code, 1009, `${fromClient}: ${reason}`);
        assert.equal(reason.toString(), "REALTIME_BACKPRESSURE_LIMIT");
        receiver.resume();
        await receiverClosed;
      } finally { downstream.terminate(); upstream.terminate(); }
    }
    const recovered = connect(ctx, "/v1/realtime?model=voice");
    try { await once(recovered, "open", { signal: AbortSignal.timeout(3000) }); }
    finally { recovered.terminate(); }
  });
});

test("Realtime shutdown closes active, initial-config and upstream-handshake connections", { timeout: 15000 }, async testContext => {
  const upstreamServer = http.createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  const waiting = new Set();
  upstreamServer.on("upgrade", (request, socket, head) => {
    if (new URL(request.url, "http://mock").searchParams.get("model") === "waiting") {
      waiting.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => waiting.delete(socket));
    } else webSockets.handleUpgrade(request, socket, head, peer => webSockets.emit("connection", peer));
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of waiting) socket.destroy();
    for (const socket of webSockets.clients) socket.terminate();
    await new Promise(resolve => webSockets.close(resolve));
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    for (const id of ["voice", "waiting"]) config.models.push({ id, pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const connected = once(webSockets, "connection", { signal: AbortSignal.timeout(3000) });
    const active = connect(ctx, "/v1/realtime?model=voice");
    const opened = once(active, "open", { signal: AbortSignal.timeout(3000) });
    const [upstream] = await connected;
    await opened;
    const unconfigured = connect(ctx, "/v1/realtime?intent=transcription");
    await once(unconfigured, "open", { signal: AbortSignal.timeout(3000) });
    const handshake = once(upstreamServer, "upgrade", { signal: AbortSignal.timeout(3000) });
    const rejection = rejectedHandshake(ctx, "/v1/realtime?model=waiting");
    await handshake;
    const closed = [active, unconfigured, upstream].map(socket => once(socket, "close", { signal: AbortSignal.timeout(5000) }));
    try {
      await ctx.stopProxy();
      assert.equal(await ctx.waitForExit(), 0);
      for (const result of await Promise.all(closed)) {
        assert.equal(result[0], 1001);
        assert.equal(result[1].toString(), "REALTIME_SERVER_SHUTDOWN");
      }
      const denied = await rejection;
      assert.equal(denied.status, 503);
      assert.match(denied.text, /REALTIME_SERVER_SHUTDOWN/);
      assert.match(ctx.output.stdout.join(""), /startup.shutdown_complete/);
    } finally { active.terminate(); unconfigured.terminate(); }
  }, { logLevel: "info" });
});

test("Realtime enforces model ownership, metering and bounded connection lifetimes", { timeout: 15000 }, async testContext => {
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  let connections = 0;
  const messages = [];
  upstreamServer.on("connection", socket => {
    connections += 1;
    socket.on("message", data => { messages.push(data.toString()); socket.send(data, { binary: false }); });
  });
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { realtime: { enabled: true } };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const save = async () => {
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
    };
    for (const guard of ["tpm", "budget", "model"]) {
      config.apiKeys[0].rateLimit = guard === "tpm" ? { tpm: 100 } : {};
      config.apiKeys[0].budget = guard === "budget" ? { limitAmount: 1 } : {};
      config.apiKeys[0].allowedModels = guard === "model" ? ["gpt-5-mini"] : [];
      await save();
      assert.equal((await rejectedHandshake(ctx, "/v1/realtime?model=voice")).status, 403);
      assert.equal(connections, 0);
    }
    config.apiKeys[0].allowedModels = ["voice"];
    config.apiKeys[0].rateLimit = { concurrency: 1 };
    const cases = [
      { input: '{"type":"session.update","session":{"model":"deployment"}}', reason: "REALTIME_MODEL_BOUND" },
      { input: '{"type":"session.update","session":{"audio":{"input":{"transcription":{"model":"gpt-5-mini"}}}}}', reason: "REALTIME_TRANSCRIPTION_MODEL_DENIED" },
      { input: Buffer.from([0, 1, 2]), reason: "REALTIME_JSON_REQUIRED" },
      { limits: { idleTimeoutMs: 100 }, reason: "REALTIME_IDLE_TIMEOUT" },
      { limits: { maxSessionMs: 100 }, reason: "REALTIME_MAX_DURATION" },
      { limits: { maxMessageBytes: 256, maxInitialConfigBytes: 128 }, input: "x".repeat(257), closeCode: 1009 }
    ];
    for (const entry of cases) {
      config.media.realtime = { enabled: true, ...entry.limits };
      await save();
      const upstreamConnected = once(upstreamServer, "connection");
      const socket = connect(ctx, "/v1/realtime?model=voice");
      try {
        const [upstreamSocket] = await upstreamConnected;
        const upstreamClosed = once(upstreamSocket, "close", { signal: AbortSignal.timeout(3000) });
        await once(socket, "open");
        const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
        if (entry.input) socket.send(entry.input);
        const [code, reason] = await closed;
        if (entry.closeCode) assert.equal(code, entry.closeCode);
        else assert.equal(reason.toString(), entry.reason);
        await upstreamClosed;
        assert.equal(messages.length, 0);
      } finally { socket.terminate(); }
    }
  });
});