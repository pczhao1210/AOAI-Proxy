import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createRealtimeCallRegistry } from "../src/proxy/realtime-calls.js";
import { getStats } from "../src/stats.js";
import { withTestContext } from "./lib/harness.js";

const offer = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=private-offer\r\nt=0 0\r\n";
const answer = "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=private-answer\r\nt=0 0\r\n";

function callForm(sessionText = '{"type":"realtime", "model":"voice", "instructions":"private-instructions", "extension":9007199254740993}') {
  const form = new FormData();
  form.append("sdp", offer);
  form.append("session", sessionText);
  return form;
}

test("WebRTC setup uses provider-specific encoding and keeps Azure client secrets server-side", { timeout: 15000 }, async testContext => {
  const requests = [];
  const upstreamServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const record = { url: request.url, headers: request.headers, body };
    if (request.headers["content-type"]?.startsWith("multipart/")) {
      record.form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
    }
    requests.push(record);
    if (request.url.endsWith("/client_secrets")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "private-ephemeral", expires_at: Math.floor(Date.now() / 1000) + 60 }));
    } else {
      response.writeHead(201, { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_native" });
      response.end(answer);
    }
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  for (const provider of ["openai", "azure-openai"]) {
    await withTestContext(async ctx => {
      const disabled = await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm() });
      assert.equal(disabled.status, 404, disabled.text);
      const config = await ctx.readConfigFile();
      config.media = { webrtc: { enabled: true } };
      config.observability.logs = { ...config.observability.logs, messageContentMode: "full" };
      config.upstreams[0].provider = provider;
      config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
      const prefix = provider === "openai" ? "/v1" : "/openai/v1";
      config.upstreams[0].routes.realtime = `${prefix}/realtime`;
      config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
      const before = requests.length;
      const result = await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm(), headers: { "api-key": "ingress-secret" } });
      assert.equal(result.status, 201, result.text);
      assert.equal(result.text, answer);
      assert.equal(result.headers.get("location"), "/v1/realtime/calls/rtc_native");
      assert.match(result.headers.get("cache-control"), /no-store/);
      assert.equal(requests.length - before, provider === "openai" ? 1 : 2);
      const call = requests.at(-1);
      assert.equal(call.url, `${prefix}/realtime/calls`);
      assert.equal(call.headers["api-key"], undefined);
      assert.equal(call.headers.authorization, provider === "openai" ? "Bearer test-upstream-key" : "Bearer private-ephemeral");
      const expectedSession = '{"type":"realtime", "model":"deployment", "instructions":"private-instructions", "extension":9007199254740993}';
      if (provider === "openai") {
        assert.equal(call.form.get("sdp"), offer);
        assert.equal(call.form.get("session"), expectedSession);
      } else {
        assert.equal(call.body.toString(), offer);
        assert.equal(call.headers["content-type"], "application/sdp");
        const secret = requests.at(-2);
        assert.equal(secret.url, "/openai/v1/realtime/client_secrets");
        assert.equal(secret.headers["api-key"], "test-upstream-key");
        assert.equal(secret.headers.authorization, undefined);
        assert.ok(secret.body.toString().includes(expectedSession));
      }
      assert.equal((await ctx.publicRequest("/v1/realtime/client_secrets", { method: "POST", json: { session: { type: "realtime", model: "voice" } } })).status, 404);
      const logs = await ctx.adminRequest("/admin/api/logs?limit=500");
      assert.equal(logs.status, 200);
      for (const sensitive of ["private-ephemeral", "private-instructions", "private-offer", "private-answer", "ingress-secret"]) assert.equal(logs.text.includes(sensitive), false, sensitive);
    });
  }
});

test("WebRTC control is owner-bound, retains its upstream snapshot and holds its lease after sideband disconnect", { timeout: 15000 }, async testContext => {
  const requests = [];
  const upstreamServer = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests.push(request.url);
    if (request.url.endsWith("/hangup")) response.writeHead(200).end();
    else if (request.url.endsWith("/client_secrets")) response.writeHead(200, { "content-type": "application/json" }).end('{"value":"private-ephemeral"}');
    else response.writeHead(201, { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_owned" }).end(answer);
  });
  const wsServer = new WebSocketServer({ server: upstreamServer });
  wsServer.on("connection", (socket, request) => {
    requests.push(request.url);
    socket.send('{"type":"session.created","session":{"model":"deployment"}}');
    socket.on("message", data => socket.send(data, { binary: false }));
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(async () => {
    for (const socket of wsServer.clients) socket.terminate();
    await new Promise(resolve => wsServer.close(resolve));
    await new Promise(resolve => upstreamServer.close(resolve));
  });
  for (const provider of ["openai", "azure-openai"]) {
    await withTestContext(async ctx => {
      const config = await ctx.readConfigFile();
      const prefix = provider === "openai" ? "/v1" : "/openai/v1";
      config.media = { webrtc: { enabled: true } };
      config.apiKeys[0].rateLimit = { concurrency: 1 };
      config.apiKeys.push({ ...config.apiKeys[0], id: "other", key: "other-key" });
      config.upstreams[0].provider = provider;
      config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
      config.upstreams[0].routes.realtime = `${prefix}/realtime`;
      config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
      const save = async () => {
        const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
        assert.equal(saved.status, 200, saved.text);
      };
      await save();
      const created = await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm() });
      assert.equal(created.status, 201, created.text);
      const hangupPath = `${created.headers.get("location")}/hangup`;
      const before = requests.length;
      assert.equal((await ctx.publicRequest(hangupPath, { method: "POST", headers: { authorization: "Bearer other-key" } })).status, 404);
      assert.equal(requests.length, before);
      config.upstreams[0].baseUrl = "http://127.0.0.1:1";
      config.models.at(-1).targetModel = "retargeted";
      await save();
      const sideband = new WebSocket(`${ctx.baseUrl.replace(/^http/, "ws")}/v1/realtime?call_id=rtc_owned`, { headers: { authorization: "Bearer test-client-key" } });
      sideband.on("error", () => {});
      const messages = [];
      sideband.on("message", data => messages.push(JSON.parse(data.toString())));
      try {
        const received = once(sideband, "message", { signal: AbortSignal.timeout(3000) });
        await once(sideband, "open");
        await received;
        assert.equal(messages[0].session.model, "voice");
        assert.equal(requests.at(-1), `${prefix}/realtime?call_id=rtc_owned`);
        const closed = once(sideband, "close", { signal: AbortSignal.timeout(3000) });
        sideband.close(1000);
        await closed;
      } finally { sideband.terminate(); }
      assert.equal((await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm() })).status, 429);
      const ended = await ctx.publicRequest(hangupPath, { method: "POST" });
      assert.equal(ended.status, 200, ended.text);
      assert.equal(requests.at(-1), `${prefix}/realtime/calls/rtc_owned/hangup`);
      assert.equal((await ctx.publicRequest(hangupPath, { method: "POST" })).status, 404);
      config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
      config.models.at(-1).targetModel = "deployment";
      await save();
      assert.equal((await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm() })).status, 201);
    });
  }
});

test("WebRTC client secret export is opt-in, bounded and denied for keys requiring inline governance", { timeout: 15000 }, async testContext => {
  const requests = [];
  const upstreamServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    requests.push({ url: request.url, headers: request.headers, text });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"value":"private-exported-secret","expires_at":${Math.floor(Date.now() / 1000) + 60},"session":{"model":"deployment","extension":9007199254740993}}`);
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { webrtc: { enabled: true } };
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const save = async () => {
      const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
      assert.equal(saved.status, 200, saved.text);
    };
    const issue = (seconds = 60) => ctx.publicRequest("/v1/realtime/client_secrets", { method: "POST", json: {
      expires_after: { anchor: "created_at", seconds }, session: { type: "realtime", model: "voice" }
    } });
    await save();
    assert.equal((await issue()).status, 404);
    config.media.webrtc.allowClientSecrets = true;
    await save();
    assert.equal((await issue(61)).status, 400);
    for (const guard of ["models", "concurrency", "tpm", "budget"]) {
      config.apiKeys[0].allowedModels = guard === "models" ? ["voice"] : [];
      config.apiKeys[0].rateLimit = guard === "concurrency" ? { concurrency: 1 } : guard === "tpm" ? { tpm: 1 } : {};
      config.apiKeys[0].budget = guard === "budget" ? { limitAmount: 1 } : {};
      await save();
      assert.equal((await issue()).status, 403, guard);
    }
    assert.equal(requests.length, 0);
    config.apiKeys[0].budget = {};
    for (const provider of ["openai", "azure-openai"]) {
      config.upstreams[0].provider = provider;
      const prefix = provider === "openai" ? "/v1" : "/openai/v1";
      config.upstreams[0].routes.realtime = `${prefix}/realtime`;
      await save();
      const result = await issue();
      assert.equal(result.status, 200, result.text);
      assert.equal(result.json.value, "private-exported-secret");
      assert.equal(result.json.session.model, "voice");
      assert.match(result.text, /9007199254740993/);
      assert.match(result.headers.get("cache-control"), /no-store/);
      assert.equal(requests.at(-1).url, `${prefix}/realtime/client_secrets`);
      assert.equal(JSON.parse(requests.at(-1).text).session.model, "deployment");
    }
  });
});

test("WebRTC transcription and translation keep distinct session configuration and native setup paths", { timeout: 15000 }, async testContext => {
  const requests = [];
  const upstreamServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let session;
    if (request.url.endsWith("/client_secrets")) session = JSON.parse(body.toString()).session;
    else if (request.headers["content-type"]?.startsWith("multipart/")) {
      const form = await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData();
      session = JSON.parse(form.get("session"));
    }
    requests.push({ url: request.url, headers: request.headers, body, session });
    if (request.url.endsWith("/hangup")) response.writeHead(200).end();
    else if (request.url.endsWith("/client_secrets")) response.writeHead(200, { "content-type": "application/json" }).end('{"value":"internal-secret"}');
    else response.writeHead(201, { "content-type": "application/sdp", location: `${request.url}/rtc_modes` }).end(answer);
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  await withTestContext(async ctx => {
    for (const provider of ["openai", "azure-openai"]) {
      for (const mode of ["transcription", "translation"]) {
        const config = await ctx.readConfigFile();
        config.media = { webrtc: { enabled: true } };
        const prefix = provider === "openai" ? "/v1" : "/openai/v1";
        const namespace = mode === "translation" ? "realtime/translations" : "realtime";
        config.upstreams[0].provider = provider;
        config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
        config.upstreams[0].routes[mode === "transcription" ? "realtime/transcription_sessions" : namespace] = `${prefix}/${namespace}${mode === "transcription" ? "?intent=transcription" : ""}`;
        config.models = config.models.filter(model => model.id !== "voice");
        config.models.push({ id: "voice", targetModel: "deployment", pricingRef: mode === "translation" ? "gpt-realtime-translate" : "gpt-realtime-whisper", upstream: config.upstreams[0].name });
        const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
        assert.equal(saved.status, 200, saved.text);
        const session = mode === "transcription" ? { type: "transcription", audio: { input: { turn_detection: null, transcription: { model: "voice", language: "en" } } } }
          : { model: "voice", audio: { output: { language: "es" } } };
        const before = requests.length;
        const created = await ctx.publicRequest(`/v1/${namespace}/calls`, { method: "POST", body: callForm(JSON.stringify(session)) });
        assert.equal(created.status, 201, created.text);
        assert.equal(created.text, answer);
        assert.equal(requests.at(-1).url, `${prefix}/${namespace}/calls`);
        const upstreamSession = requests.slice(before).find(record => record.session).session;
        if (mode === "transcription") {
          assert.equal(upstreamSession.type, "transcription");
          assert.equal(upstreamSession.audio.input.transcription.model, "deployment");
          assert.equal(upstreamSession.model, undefined);
        } else {
          assert.equal(upstreamSession.model, "deployment");
          assert.equal(upstreamSession.audio.output.language, "es");
          assert.equal(requests.at(-1).headers["content-type"], "application/sdp");
          assert.equal(requests.at(-1).body.toString(), offer);
        }
        assert.equal((await ctx.publicRequest(`${created.headers.get("location")}/hangup`, { method: "POST" })).status, 200);
      }
    }
  });
});

test("WebRTC rejects untrusted locations, preserves upstream errors and recovers capacity after setup failure", { timeout: 15000 }, async testContext => {
  let scenario = "invalid-location";
  let location = "https://foreign.invalid/v1/realtime/calls/rtc_bad";
  let requests = 0;
  const upstreamServer = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests += 1;
    if (request.url.endsWith("/hangup")) return response.writeHead(200).end();
    if (scenario === "timeout") return;
    if (scenario === "error") return response.writeHead(429, { "content-type": "application/json", "retry-after": "4" }).end('{"error":{"code":"native_limit"}}');
    if (request.url.endsWith("/client_secrets")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(scenario === "malformed-json" ? "{" : '{"value":"must-not-export","expires_at":1}');
    }
    response.writeHead(201, { "content-type": "application/sdp", location }).end(answer);
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  testContext.after(() => new Promise(resolve => upstreamServer.close(resolve)));
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    config.media = { webrtc: { enabled: true, allowClientSecrets: true, setupTimeoutMs: 100, maxCalls: 1 } };
    config.upstreams[0].provider = "openai";
    config.upstreams[0].baseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
    config.upstreams[0].routes.realtime = "/v1/realtime";
    config.models.push({ id: "voice", targetModel: "deployment", pricingRef: "gpt-realtime-2", upstream: config.upstreams[0].name });
    const saved = await ctx.adminRequest("/admin/api/config", { method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config });
    assert.equal(saved.status, 200, saved.text);
    const create = () => ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: callForm() });
    for (location of ["https://foreign.invalid/v1/realtime/calls/rtc_bad", "/v1/realtime/calls/rtc_bad?credential=secret", "/admin/rtc_bad", "http://%invalid"]) {
      const result = await create();
      assert.equal(result.status, 502, result.text);
      assert.equal(result.headers.get("location"), null);
    }
    const before = requests;
    const duplicate = callForm();
    duplicate.append("session", '{"model":"other"}');
    assert.equal((await ctx.publicRequest("/v1/realtime/calls", { method: "POST", body: duplicate })).status, 400);
    assert.equal(requests, before);
    scenario = "error";
    const nativeError = await create();
    assert.equal(nativeError.status, 429);
    assert.equal(nativeError.headers.get("retry-after"), "4");
    assert.equal(nativeError.text, '{"error":{"code":"native_limit"}}');
    scenario = "timeout";
    assert.equal((await create()).status, 504);
    for (scenario of ["expired-secret", "malformed-json"]) {
      const secret = await ctx.publicRequest("/v1/realtime/client_secrets", { method: "POST", json: { session: { type: "realtime", model: "voice" } } });
      assert.equal(secret.status, 502, secret.text);
      assert.equal(secret.text.includes("must-not-export"), false);
    }
    scenario = "complete";
    location = "/v1/realtime/calls/rtc_recovered";
    const recovered = await create();
    assert.equal(recovered.status, 201, recovered.text);
    assert.equal((await ctx.publicRequest(`${recovered.headers.get("location")}/hangup`, { method: "POST" })).status, 200);
  });
});

test("WebRTC call settlement deduplicates observers and keeps unobserved media cost partial", async () => {
  const registry = createRealtimeCallRegistry({ log: { warn() {} } });
  let releases = 0;
  const record = { callId: "settled-call", keyId: "settled-key", publicRouteKey: "realtime", config: {},
    binding: { model: { id: "settled-voice", pricing: { currency: "USD", billingUnit: "minute", perMinute: 0.006 } } },
    lease: { release: () => { releases += 1; } }, terminate: async () => {} };
  registry.reserve(1).commit(record, 60000);
  record.usageTracker.observe("response:1", { type: "duration", seconds: 60 });
  record.usageTracker.observe("response:1", { type: "duration", seconds: 60 });
  registry.finish(record);
  registry.finish(record);
  const media = getStats().perModel["settled-voice"].media;
  assert.equal(releases, 1);
  assert.equal(media.requests, 1);
  assert.deepEqual(media.costAmounts, { USD: 0.006 });
  assert.equal(media.unknownCostRequests, 1);
  assert.equal(media.estimatedCostAmount, null);
  await registry.close();
});

test("WebRTC expiry does not release a lease until upstream termination is confirmed", { timeout: 5000 }, async () => {
  const warnings = [];
  const registry = createRealtimeCallRegistry({ log: { warn: entry => warnings.push(entry) } });
  let releaseCount = 0;
  let expiryAttempted;
  const expired = new Promise(resolve => { expiryAttempted = resolve; });
  const record = { callId: "owned", keyId: "key", publicRouteKey: "realtime", binding: { model: { id: "voice" } },
    lease: { release: () => { releaseCount += 1; } }, terminate: async () => { expiryAttempted(); throw new Error("unconfirmed"); } };
  registry.reserve(1).commit(record, 10);
  await expired;
  await nextTurn();
  try {
    assert.equal(releaseCount, 0);
    assert.equal(warnings.length, 1);
    assert.throws(() => registry.reserve(1), { code: "WEBRTC_CAPACITY" });
    assert.throws(() => registry.get("owned", { keyId: "key" }, "realtime"), { code: "WEBRTC_CALL_NOT_FOUND" });
    assert.equal(registry.get("owned", { keyId: "key" }, "realtime", { allowExpired: true }), record);
    registry.finish(record);
    registry.finish(record);
    assert.equal(releaseCount, 1);
  } finally { await registry.close(); }
});