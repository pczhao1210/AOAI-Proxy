import assert from "node:assert/strict";
import test from "node:test";
import { LogsIngestionClient } from "@azure/monitor-ingestion";
import { appendStructuredLog, buildContentLogSnapshot, buildLogAnalyticsRecord, flushLogAnalyticsSink, getLogRuntimeInfo, LOG_ANALYTICS_COLUMNS, queryLogs, setLogConfig } from "../src/logs.js";
import { createTestContext } from "./lib/harness.js";

function configureLogs({ level = "info", sinks = ["memory"], bufferSize = 500, logAnalytics = {}, ...settings } = {}) {
  setLogConfig({
    observability: {
      logs: { level, sinks, bufferSize, ...settings },
      logAnalytics: { enabled: false, ...logAnalytics }
    }
  });
}

test("admin logs retain info requests when external sinks use a higher minimum level", () => {
  configureLogs({ level: "warn" });
  appendStructuredLog("debug", { event: "test.level.debug" });
  appendStructuredLog("info", { event: "test.level.info" });
  appendStructuredLog("warn", { event: "test.level.warn" });

  assert.equal(queryLogs({ event: "test.level.debug" }).total, 0);
  assert.equal(queryLogs({ event: "test.level.info" }).total, 1);
  assert.equal(queryLogs({ event: "test.level.warn" }).total, 1);
});

test("admin logs keep the bounded memory sink available", () => {
  configureLogs({ sinks: [] });
  appendStructuredLog("error", { event: "test.sink.disabled" });

  assert.equal(queryLogs({ event: "test.sink.disabled" }).total, 1);
  assert.equal(getLogRuntimeInfo().memoryEnabled, true);
});

test("non-standard log levels are normalized for admin filters", () => {
  configureLogs();
  appendStructuredLog("log", { event: "test.level.normalized" });

  const result = queryLogs({ event: "test.level.normalized", level: "info" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].level, "info");
});

test("configured buffers can retain more than one hundred entries", () => {
  configureLogs({ bufferSize: 150 });
  for (let index = 0; index < 150; index += 1) {
    appendStructuredLog("info", { event: "test.buffer.capacity", index });
  }

  assert.equal(queryLogs({ event: "test.buffer.capacity", limit: 500 }).items.length, 150);
});

test("admin memory logs are bounded by bytes as well as entry count", () => {
  configureLogs({ bufferSize: 5000, maxBufferBytes: 65536, messageContentMode: "full" });
  for (let index = 0; index < 40; index += 1) {
    appendStructuredLog("info", {
      event: "test.buffer.byte-cap",
      index,
      payload: `${index}:${"x".repeat(6000)}`
    });
  }

  const runtime = getLogRuntimeInfo();
  const retained = queryLogs({ event: "test.buffer.byte-cap", limit: 500 }).items;
  assert.ok(runtime.memoryBufferBytes <= 65536);
  assert.equal(runtime.memoryBufferMaxBytes, 65536);
  assert.ok(runtime.memoryDroppedEntries > 0);
  assert.ok(retained.length < 40);
  assert.equal(retained[0].fields.index, 39);
});

test("structured logs redact sensitive URL query parameters", () => {
  configureLogs();
  appendStructuredLog("info", {
    event: "test.url.redaction",
    url: "/healthz?api_key=LOG_SECRET_PROBE&api-version=2025-01-01"
  });

  const entry = queryLogs({ event: "test.url.redaction" }).items[0];
  assert.ok(entry);
  assert.doesNotMatch(entry.fields.url, /LOG_SECRET_PROBE/);
  assert.match(entry.fields.url, /api_key=.*REDACTED/);
  assert.match(entry.fields.url, /api-version=2025-01-01/);
});

test("event exclusion filters hide noisy events", () => {
  configureLogs();
  appendStructuredLog("info", { event: "test.exclude.noise" });
  appendStructuredLog("info", { event: "test.exclude.keep" });
  const remaining = queryLogs({ keyword: "test.exclude.", excludeEvent: "test.exclude.noise,unrelated" }).items;
  assert.deepEqual(remaining.map((entry) => entry.event), ["test.exclude.keep"]);
});

test("request view groups correlated errors and keeps cost warnings out of the outcome", () => {
  configureLogs();
  const requestContext = {
    requestId: "request-summary",
    requestInstanceId: "fastify-request-17",
    modelId: "mai-transcribe-2",
    routeKey: "responses",
    backendRouteKey: "audio/transcriptions"
  };
  appendStructuredLog("warn", {
    ...requestContext,
    source: "proxy",
    event: "proxy.media_failed",
    status: 400,
    errorCode: "RESPONSES_SPEECH_UNREPRESENTABLE",
    failureReason: "stream is not supported by synchronous Speech Responses",
    message: "media request failed"
  });
  appendStructuredLog("warn", {
    ...requestContext,
    source: "proxy",
    event: "proxy.request_timing",
    status: 400,
    errorCode: "RESPONSES_SPEECH_UNREPRESENTABLE"
  });
  appendStructuredLog("warn", {
    requestId: "request-summary",
    event: "governance.text_cost_incomplete",
    source: "governance",
    modelId: "mai-transcribe-2",
    failureReason: "token pricing unavailable"
  });
  appendStructuredLog("warn", {
    requestId: "request-summary-2",
    event: "governance.text_cost_incomplete",
    source: "governance",
    modelId: "mai-transcribe-2",
    failureReason: "token pricing unavailable"
  });
  appendStructuredLog("warn", {
    ...requestContext,
    source: "http",
    event: "http.request_completed",
    status: 400,
    latencyMs: 11,
    method: "POST",
    url: "/v1/responses",
    message: "request completed with error"
  });
  appendStructuredLog("info", {
    requestId: "request-summary",
    requestInstanceId: "fastify-request-18",
    source: "http",
    event: "http.request_completed",
    status: 200,
    latencyMs: 8,
    method: "POST",
    url: "/v1/responses",
    message: "request completed"
  });
  appendStructuredLog("warn", {
    requestId: "request-parser-failure",
    requestInstanceId: "fastify-parser-failure",
    source: "http",
    event: "http.request_completed",
    status: 400,
    errorCode: "FST_ERR_CTP_INVALID_JSON_BODY",
    failureReason: "Request body is not valid JSON",
    message: "request completed with error"
  });

  const requests = queryLogs({ view: "requests", requestId: "request-summary" });
  assert.equal(requests.total, 2, "reused client request IDs remain separate request instances");
  const failed = requests.items.find((entry) => entry.outcome === "failed");
  assert.equal(failed.status, 400);
  assert.equal(failed.errorCode, "RESPONSES_SPEECH_UNREPRESENTABLE");
  assert.equal(failed.failureReason, "stream is not supported by synchronous Speech Responses");
  assert.equal(failed.method, "POST");
  assert.equal(failed.url, "/v1/responses");
  assert.equal(failed.events.length, 3);
  assert.equal(queryLogs({ view: "requests", outcome: "success", requestId: "request-summary" }).total, 1);
  const parserFailure = queryLogs({ view: "requests", requestId: "request-parser-failure", level: "info" }).items[0];
  assert.equal(parserFailure.errorCode, "FST_ERR_CTP_INVALID_JSON_BODY");
  assert.equal(parserFailure.failureReason, "Request body is not valid JSON");
  const costWarnings = queryLogs({ view: "events", event: "governance.text_cost_incomplete" });
  assert.equal(costWarnings.total, 1);
  assert.equal(costWarnings.items[0].occurrences, 2);
  assert.equal(costWarnings.items[0].events.length, 2);
  assert.equal(queryLogs({ requestId: "request-summary", event: "governance.text_cost_incomplete" }).total, 1);
  assert.equal(queryLogs({ view: "events", requestId: "request-summary" }).total, 1);
  assert.equal(queryLogs({ view: "access", requestId: "request-summary" }).total, 2);
});

test("a successful request with retry events stays successful and reports retries", () => {
  configureLogs();
  appendStructuredLog("warn", {
    requestId: "request-retried",
    requestInstanceId: "fastify-retried",
    source: "upstream",
    status: 503,
    errorCode: "UPSTREAM_HTTP_5XX",
    message: "upstream retry on HTTP status"
  });
  appendStructuredLog("info", {
    requestId: "request-retried",
    requestInstanceId: "fastify-retried",
    event: "proxy.request_completed",
    source: "proxy",
    status: 200,
    message: "proxy request completed"
  });

  const result = queryLogs({ view: "requests", requestId: "request-retried" });
  assert.equal(result.items[0].outcome, "success");
  assert.equal(result.items[0].retryCount, 1);
  assert.equal(result.items[0].status, 200);
  assert.equal(result.items[0].errorCode, "");
});

test("request summaries preserve recorded usage and explicit zeros across completion events", () => {
  configureLogs();
  for (const event of ["proxy.request_completed", "proxy.stream_completed"]) {
    for (const amount of [0, 0.00001675, null]) {
      const requestId = `summary-usage-${event}-${amount}`;
      const totalTokens = amount === 0 ? 0 : 18;
      appendStructuredLog("info", {
        requestId, event: "proxy.usage_recorded", usageAvailable: true,
        totalTokens, estimatedCostAmount: amount, currency: "USD"
      });
      appendStructuredLog("info", { requestId, event, usageAvailable: true, status: 200 });
      const summary = queryLogs({ view: "requests", requestId }).items[0];
      assert.equal(summary.usageAvailable, true);
      assert.equal(summary.totalTokens, totalTokens);
      assert.equal(summary.estimatedCostAmount, amount);
      assert.equal(summary.currency, "USD");
    }
  }
});

test("media request summaries retain known costs without a text usage flag", () => {
  configureLogs();
  appendStructuredLog("info", {
    requestId: "summary-media-cost", event: "proxy.media_completed", status: 200,
    usageStatus: "observed", estimatedCostAmount: 0, currency: "USD"
  });
  const summary = queryLogs({ view: "requests", requestId: "summary-media-cost" }).items[0];
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.estimatedCostAmount, 0);
  assert.equal(summary.currency, "USD");
});

test("request summaries require terminal evidence before reporting success or warnings", () => {
  configureLogs();
  for (const event of ["proxy.request_started", "proxy.usage_recorded", "proxy.protocol_shim_lossy_conversion"]) {
    const requestId = `summary-nonterminal-${event}`;
    appendStructuredLog(event.endsWith("conversion") ? "warn" : "info", { requestId, event });
    const summary = queryLogs({ view: "requests", requestId }).items[0];
    assert.equal(summary.outcome, "unknown");
    assert.equal(summary.status, null);
    assert.equal(summary.message, "Request completion not recorded");
    assert.equal(queryLogs({ view: "requests", requestId, outcome: "success" }).total, 0);
    assert.equal(queryLogs({ view: "requests", requestId, outcome: "unknown" }).total, 1);
    appendStructuredLog("info", { requestId, event: "http.request_completed", status: 200 });
    assert.equal(queryLogs({ view: "requests", requestId }).items[0].outcome, event.endsWith("conversion") ? "warning" : "success");
  }
});

test("terminal stream failures remain failures after HTTP 200 and are not counted as retries", () => {
  configureLogs();
  const requestId = "summary-stream-failed";
  appendStructuredLog("info", { requestId, event: "http.request_completed", status: 200 });
  appendStructuredLog("error", {
    requestId, source: "upstream", event: "proxy.stream_failed",
    errorCode: "UPSTREAM_INCOMPLETE_STREAM", message: "stream failed after retry"
  });
  const summary = queryLogs({ view: "requests", requestId }).items[0];
  assert.equal(summary.outcome, "failed");
  assert.equal(summary.status, 200);
  assert.equal(summary.errorCode, "UPSTREAM_INCOMPLETE_STREAM");
  assert.equal(summary.retryCount, 0);
});

test("system logs exclude eventless request events but retain correlated cost warnings", () => {
  configureLogs();
  const context = { requestId: "summary-system-split", requestInstanceId: "system-split-instance" };
  appendStructuredLog("warn", {
    ...context, source: "upstream", status: 503, message: "upstream retry on HTTP status"
  });
  appendStructuredLog("warn", {
    ...context, source: "governance", event: "governance.text_cost_incomplete", failureReason: "token pricing unavailable"
  });
  const requests = queryLogs({ view: "requests", requestId: context.requestId });
  const system = queryLogs({ view: "events", requestId: context.requestId });
  assert.equal(requests.items[0].events.length, 1);
  assert.deepEqual(system.items.map(entry => entry.event), ["governance.text_cost_incomplete"]);
});

test("request metadata that resembles Base64 is not omitted as binary", () => {
  configureLogs();
  const jpegBase64 = `/9j/${"A".repeat(400)}`;
  appendStructuredLog("warn", {
    event: "test.metadata.base64-like",
    reqId: "req-12j0",
    method: "POST",
    url: "/v1/chat/completions",
    path: "/v1/responses/compact",
    imageUrl: "data:image/png;base64,QUJDREVGRw==",
    thumbnailUrl: jpegBase64,
    opaqueValue: "QUJD/REVGRw=="
  });

  const entry = queryLogs({ event: "test.metadata.base64-like" }).items[0];
  assert.equal(entry.fields.reqId, "req-12j0");
  assert.equal(entry.fields.method, "POST");
  assert.equal(entry.fields.url, "/v1/chat/completions");
  assert.equal(entry.fields.path, "/v1/responses/compact");
  assert.equal(entry.fields.imageUrl, "[BINARY_OMITTED chars=12]");
  assert.equal(entry.fields.thumbnailUrl, `[BINARY_OMITTED chars=${jpegBase64.length}]`);
  assert.equal(entry.fields.opaqueValue, "[BINARY_OMITTED chars=13]");
});

test("long request paths remain readable without weakening URL query redaction", () => {
  configureLogs();
  const path = `/v1/chat/completions/${"A".repeat(400)}`;
  appendStructuredLog("info", { event: "test.metadata.long-url", url: path });
  assert.equal(queryLogs({ event: "test.metadata.long-url" }).items[0].fields.url, path);

  appendStructuredLog("info", { event: "test.metadata.long-query", url: `${path}?api_key=URL_SECRET_PROBE` });
  const entry = queryLogs({ event: "test.metadata.long-query" }).items[0];
  assert.equal(entry.fields.url, `${path}?api_key=[REDACTED]`);
});

test("URL fields cannot bypass binary omission in structured logs or content snapshots", () => {
  configureLogs();
  const cases = [
    ["url", "QUJDREVGRw=="],
    ["imageUrl", "QUJDREVGRw=="],
    ["thumbnailUrl", `/9j/${"A".repeat(40)}`],
    ["base64Url", "QUJDREVGRw=="],
    ["b64_url", "A".repeat(300)],
    ["image_url", "data:image/png;base64,QUJDREVGRw=="]
  ];
  for (const [key, value] of cases) {
    const payload = { [key]: value };
    const expected = `[BINARY_OMITTED chars=${value.startsWith("data:") ? 12 : value.length}]`;
    const entry = appendStructuredLog("info", { event: "test.binary-url", ...payload });
    assert.equal(entry.fields[key], expected, key);
    for (const mode of ["summary", "full"]) {
      const snapshot = buildContentLogSnapshot(payload, { mode });
      assert.equal(JSON.parse(snapshot.preview)[key], expected, `${mode}: ${key}`);
      if (mode === "full") assert.equal(JSON.parse(snapshot.bodyJson)[key], expected);
    }
  }
  for (const mode of ["summary", "full"]) {
    const snapshot = buildContentLogSnapshot({
      image_url: { url: `/9j/${"A".repeat(40)}` },
      path: "QUJDREVGRw=="
    }, { mode });
    const parsed = JSON.parse(snapshot.preview);
    assert.equal(parsed.image_url.url, "[BINARY_OMITTED chars=44]");
    assert.equal(parsed.path, "[BINARY_OMITTED chars=12]");
  }
});

test("event filters match event names exactly", () => {
  configureLogs();
  appendStructuredLog("info", { event: "test.event.target", message: "target event" });
  appendStructuredLog("info", { event: "test.event.other", message: "mentions test.event.target" });

  const result = queryLogs({ event: "test.event.target" });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].event, "test.event.target");
});

test("structured logs apply configured privacy controls", () => {
  configureLogs({
    includeClientIp: false,
    includeHeaders: false,
    includeUsage: false,
    redactApiKeyInfo: true,
    messageContentMode: "summary",
    maxBase64LogChars: 4
  });
  appendStructuredLog("info", {
    event: "test.privacy.controls",
    clientIp: "203.0.113.10",
    forwardedFor: "198.51.100.10",
    keyId: "customer-key",
    headers: { "x-label": "visible" },
    promptTokens: 100,
    costStatus: "priced",
    costReason: "tier selected",
    pricing: { actual: { tier: { id: "long", promptTokensAtLeast: 200000 } } },
    prompt: "private prompt text",
    imageBase64: "YWJjZGVmZ2hp"
  });

  const entry = queryLogs({ event: "test.privacy.controls" }).items[0];
  assert.equal(entry.clientIp, "");
  assert.equal(entry.forwardedFor, "");
  assert.equal(entry.fields.keyId, "[REDACTED]");
  assert.equal(entry.fields.headers, "[OMITTED]");
  assert.equal("promptTokens" in entry.fields, false);
  assert.equal("pricing" in entry.fields, false);
  assert.equal("costStatus" in entry.fields, false);
  assert.equal("costReason" in entry.fields, false);
  assert.equal(entry.fields.prompt, "[OMITTED]");
  assert.equal(entry.fields.imageBase64, "[BINARY_OMITTED chars=12]");
});

test("cache-write logging preserves observed zero and unknown costs, and usage privacy removes nested dimensions", () => {
  const cacheWrite = { tokens: 0, usageStatus: "observed", knownCostAmount: 0, estimatedCostAmount: 0, costStatus: "priced" };
  const unknown = { tokens: null, usageStatus: "unknown", knownCostAmount: 0, estimatedCostAmount: null, costStatus: "unknown" };
  configureLogs({ includeUsage: true });
  appendStructuredLog("info", { event: "test.cache-write.visible", cacheWrite, nested: { cacheWrite: unknown } });
  const visible = queryLogs({ event: "test.cache-write.visible" }).items[0];
  assert.deepEqual(visible.fields.cacheWrite, cacheWrite);
  assert.deepEqual(visible.fields.nested.cacheWrite, unknown);

  configureLogs({ includeUsage: false });
  appendStructuredLog("info", {
    event: "test.cache-write.private",
    cacheWrite,
    nested: { cacheWrite: unknown, audit: { cache_write: cacheWrite } }
  });
  const hidden = queryLogs({ event: "test.cache-write.private" }).items[0];
  assert.equal("cacheWrite" in hidden.fields, false);
  assert.equal("cacheWrite" in hidden.fields.nested, false);
  assert.equal("cache_write" in hidden.fields.nested.audit, false);
});

test("content snapshots provide bounded partial previews with permanent redaction", () => {
  configureLogs();
  const snapshot = buildContentLogSnapshot({
    messages: [{ role: "user", content: `private prompt ${"x".repeat(600)}` }],
    tools: [{ type: "function", function: { name: "lookup" } }],
    authorization: "Bearer LOG_SECRET_PROBE",
    image_url: "data:image/png;base64,QUJDREVGRw=="
  });

  assert.equal(snapshot.preview.length, 512);
  assert.equal(snapshot.bodyJson, "");
  assert.equal(snapshot.messageCount, 1);
  assert.equal(snapshot.toolCount, 1);
  assert.equal(snapshot.truncated, true);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.preview, /private prompt/);
  assert.doesNotMatch(snapshot.preview, /LOG_SECRET_PROBE|QUJDREVGRw==/);
});

test("content snapshots permanently redact camelCase credential fields", () => {
  configureLogs();
  const snapshot = buildContentLogSnapshot({
    apiKey: "LOG_API_KEY_PROBE",
    clientSecret: "LOG_CLIENT_SECRET_PROBE",
    accessToken: "LOG_ACCESS_TOKEN_PROBE",
    nested: { subscriptionKey: "LOG_SUBSCRIPTION_KEY_PROBE" }
  }, { mode: "full" });

  assert.doesNotMatch(snapshot.bodyJson, /LOG_(?:API_KEY|CLIENT_SECRET|ACCESS_TOKEN|SUBSCRIPTION_KEY)_PROBE/);
  assert.equal(JSON.parse(snapshot.bodyJson).apiKey, "[REDACTED]");
  assert.equal(JSON.parse(snapshot.bodyJson).clientSecret, "[REDACTED]");
  assert.equal(JSON.parse(snapshot.bodyJson).nested.subscriptionKey, "[REDACTED]");
});

test("content snapshots omit raw Base64 and Base64URL values without explicit b64 field names", () => {
  configureLogs();
  const longBinary = Buffer.alloc(160, 255).toString("base64").replace(/=+$/, "");
  const snapshot = buildContentLogSnapshot({
    opaquePayload: "QUJDREVGRw==",
    generatedValue: longBinary,
    ordinaryId: "abcdef0123456789abcdef0123456789"
  }, { mode: "full" });
  const parsed = JSON.parse(snapshot.bodyJson);

  assert.equal(parsed.opaquePayload, "[BINARY_OMITTED chars=12]");
  assert.match(parsed.generatedValue, /^\[BINARY_OMITTED chars=/);
  assert.equal(parsed.ordinaryId, "abcdef0123456789abcdef0123456789");
  assert.doesNotMatch(snapshot.bodyJson, /QUJDREVGRw==/);
});

test("content snapshots never retain opaque encrypted reasoning state", () => {
  configureLogs({ messageContentMode: "full", redactApiKeyInfo: false });
  const message = { role: "assistant", content: "Visible answer", reasoning: { encrypted_content: "opaque reasoning probe!" } };
  const original = structuredClone(message);
  for (const mode of ["summary", "full"]) {
    const snapshot = buildContentLogSnapshot({ messages: [message] }, { mode, previewChars: 4096 });
    assert.doesNotMatch(JSON.stringify(snapshot), /opaque reasoning probe/);
    assert.match(snapshot.preview, /Visible answer/);
    assert.match(snapshot.preview, /\[REDACTED\]/);
  }
  assert.deepEqual(message, original);
});

test("content snapshots do not decode or omit ordinary long text as Base64", () => {
  configureLogs();
  const content = "x".repeat(1024 * 1024);
  const snapshot = buildContentLogSnapshot({ content }, { mode: "full", maxPayloadBytes: 102400 });

  assert.match(snapshot.bodyJson, /^\{"content":"x+/);
  assert.doesNotMatch(snapshot.bodyJson, /BINARY_OMITTED/);
  assert.equal(snapshot.truncated, true);
});

test("full content snapshots retain text within a byte bound without binary payloads", () => {
  configureLogs();
  const snapshot = buildContentLogSnapshot({
    output: [{ type: "message", content: "model output" }],
    b64_json: "QUJDREVGR0hJSktMTU5PUA==",
    url: "https://example.test/result?sig=LOG_SECRET_PROBE&mode=full"
  }, { mode: "full", maxPayloadBytes: 1024 });

  assert.match(snapshot.bodyJson, /model output/);
  assert.match(snapshot.bodyJson, /BINARY_OMITTED/);
  assert.doesNotMatch(snapshot.bodyJson, /QUJDREVGR0hJSktMTU5PUA==|LOG_SECRET_PROBE/);
  assert.ok(Buffer.byteLength(snapshot.bodyJson) <= 1024);
});

test("Log Analytics records expose correlation, usage, cost, and content as typed columns", () => {
  configureLogs({ redactApiKeyInfo: false });
  const entry = appendStructuredLog("info", {
    event: "proxy.usage_recorded",
    requestId: "request-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    consumerKeyId: "consumer-1",
    modelId: "router-model",
    actualModelName: "actual-model",
    sourceProtocol: "responses",
    targetProtocol: "chat/completions",
    stream: true,
    usageAvailable: true,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    cachedTokens: 2,
    estimatedCostAmount: 0.01,
    currency: "USD",
    requestPreview: "request preview",
    responsePreview: "response preview"
  });
  const record = buildLogAnalyticsRecord(entry, {
    contentMode: "summary",
    maxPayloadLogBytes: 102400,
    workspaceId: "workspace",
    tableName: "AOAIProxyLogs_CL"
  });

  assert.equal(record.SchemaVersion, 2);
  assert.equal(record.ConversationId, "conversation-1");
  assert.equal(record.SessionId, "session-1");
  assert.equal(record.ConsumerKeyId, "consumer-1");
  assert.equal(record.PromptTokens, 10);
  assert.equal(record.TotalTokens, 15);
  assert.equal(record.EstimatedCostAmount, 0.01);
  assert.equal(record.UsageEstimated, false);
  assert.equal(record.RequestPreview, "request preview");
  assert.deepEqual(JSON.parse(record.FieldsJson), {
    sourceProtocol: "responses",
    targetProtocol: "chat/completions"
  });
  assert.equal(new Set(LOG_ANALYTICS_COLUMNS.map((column) => column.name)).size, LOG_ANALYTICS_COLUMNS.length);
  assert.deepEqual(Object.keys(record).sort(), LOG_ANALYTICS_COLUMNS.map((column) => column.name).sort());
});

test("Log Analytics sampling never drops warning or error entries", () => {
  const originalRandom = Math.random;
  Math.random = () => 1;
  try {
    configureLogs({
      logAnalytics: {
        enabled: true,
        endpoint: "https://example.invalid",
        dcrImmutableId: "dcr-test",
        streamName: "Custom-Test",
        samplingRatio: 0,
        flushIntervalMs: 60000
      }
    });
    appendStructuredLog("info", { event: "test.sampling.info" });
    appendStructuredLog("warn", { event: "test.sampling.warn" });
    appendStructuredLog("error", { event: "test.sampling.error" });

    const runtime = getLogRuntimeInfo();
    assert.equal(runtime.queueLength, 2);
  } finally {
    Math.random = originalRandom;
    configureLogs();
  }
});

test("Log Analytics queue is bounded by bytes as well as entry count", () => {
  try {
    configureLogs({
      messageContentMode: "full",
      logAnalytics: {
        enabled: true,
        endpoint: "https://example.invalid",
        dcrImmutableId: "dcr-test",
        streamName: "Custom-Test",
        contentMode: "full",
        flushIntervalMs: 60000,
        maxQueueSize: 100,
        maxQueueBytes: 64 * 1024
      }
    });
    for (let index = 0; index < 10; index += 1) {
      appendStructuredLog("info", {
        event: "test.queue.bytes",
        requestId: `request-${index}`,
        responseBodyJson: "x".repeat(20 * 1024)
      });
    }

    const runtime = getLogRuntimeInfo();
    assert.ok(runtime.queueBytes <= runtime.maxQueueBytes);
    assert.ok(runtime.queueLength < 10);
    assert.ok(runtime.droppedEntries > 0);
    assert.ok(runtime.droppedBytes > 0);
  } finally {
    configureLogs();
  }
});

test("Log Analytics upload timeout aborts, requeues, and applies retry backoff", async (context) => {
  try {
    configureLogs({
      logAnalytics: {
        enabled: true,
        endpoint: "https://example.invalid",
        dcrImmutableId: "dcr-test",
        streamName: "Custom-Test",
        flushIntervalMs: 60000,
        uploadTimeoutMs: 100,
        retryBaseDelayMs: 500,
        retryMaxDelayMs: 2000,
        maxUploadRetries: 2
      }
    });
    appendStructuredLog("info", { event: "test.upload.timeout" });
    let uploadCalls = 0;
    context.mock.method(LogsIngestionClient.prototype, "upload", (ruleId, streamName, records, options) => {
      uploadCalls += 1;
      return new Promise((resolve, reject) => {
        options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
      });
    });
    const startedAt = Date.now();
    const result = await flushLogAnalyticsSink();
    const elapsedMs = Date.now() - startedAt;
    const deferred = await flushLogAnalyticsSink();
    const runtime = getLogRuntimeInfo();

    assert.equal(result.error?.code, "LOG_ANALYTICS_UPLOAD_TIMEOUT");
    assert.equal(result.requeued, 1);
    assert.equal(result.retryDelayMs, 500);
    assert.ok(elapsedMs >= 80 && elapsedMs < 1000, `unexpected timeout duration ${elapsedMs}ms`);
    assert.equal(deferred.deferred, true);
    assert.equal(uploadCalls, 1);
    assert.equal(runtime.queueLength, 1);
    assert.equal(runtime.consecutiveFailures, 1);
    assert.match(runtime.nextRetryAt, /^\d{4}-/);
    assert.match(runtime.nextFlushAt, /^\d{4}-/);
    const scheduledDelayMs = Date.parse(runtime.nextFlushAt) - Date.now();
    assert.ok(scheduledDelayMs > 0 && scheduledDelayMs <= 600, `unexpected scheduled retry ${scheduledDelayMs}ms`);
  } finally {
    configureLogs();
  }
});

test("an upload that ignores abort blocks additional uploads without growing orphaned batches", async (context) => {
  try {
    configureLogs({
      logAnalytics: {
        enabled: true,
        endpoint: "https://example.invalid",
        dcrImmutableId: "dcr-test",
        streamName: "Custom-Test",
        flushIntervalMs: 60000,
        uploadTimeoutMs: 100,
        retryBaseDelayMs: 500,
        retryMaxDelayMs: 500,
        maxUploadRetries: 2
      }
    });
    appendStructuredLog("info", { event: "test.upload.stuck" });
    let releaseUpload;
    let uploadCalls = 0;
    context.mock.method(LogsIngestionClient.prototype, "upload", () => {
      uploadCalls += 1;
      return new Promise((resolve) => { releaseUpload = resolve; });
    });
    const result = await flushLogAnalyticsSink();
    const blocked = await flushLogAnalyticsSink({ force: true });

    assert.equal(result.error?.code, "LOG_ANALYTICS_UPLOAD_TIMEOUT");
    assert.equal(blocked.pendingUpload, true);
    assert.equal(uploadCalls, 1);
    assert.equal(getLogRuntimeInfo().uploadPendingAfterTimeout, true);

    releaseUpload();
    await new Promise((resolve) => setImmediate(resolve));
    const recovered = getLogRuntimeInfo();
    assert.equal(recovered.uploadInFlight, false);
    assert.equal(recovered.uploadPendingAfterTimeout, false);
    assert.equal(recovered.queueLength, 0);
  } finally {
    configureLogs();
  }
});

test("a failed batch does not evict newer queued logs", async (context) => {
  configureLogs({
    bufferSize: 500,
    logAnalytics: {
      enabled: true,
      endpoint: "https://example.test",
      dcrImmutableId: "dcr-test",
      streamName: "Custom-AOAIProxyLogs_CL",
      batchSize: 1,
      flushIntervalMs: 60000,
      maxQueueSize: 10,
      maxQueueBytes: 65536,
      maxUploadRetries: 1,
      retryBaseDelayMs: 60000,
      retryMaxDelayMs: 60000
    }
  });
  appendStructuredLog("info", { event: "test.retry.oldest", payload: "o".repeat(4000) });
  let rejectUpload;
  let firstUpload = true;
  const uploadedEvents = [];
  context.mock.method(LogsIngestionClient.prototype, "upload", (ruleId, streamName, records) => {
    if (firstUpload) {
      firstUpload = false;
      return new Promise((resolve, reject) => { rejectUpload = reject; });
    }
    uploadedEvents.push(...records.map((record) => record.Event));
    return Promise.resolve();
  });
  const failedFlush = flushLogAnalyticsSink({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 20; index += 1) {
    appendStructuredLog("info", { event: `test.retry.new.${index}`, payload: "n".repeat(4000) });
  }
  rejectUpload(Object.assign(new Error("temporary outage"), { code: "ECONNRESET" }));
  await failedFlush;

  while (getLogRuntimeInfo().queueLength > 0) {
    await flushLogAnalyticsSink({ force: true });
  }
  assert.equal(uploadedEvents.includes("test.retry.oldest"), false);
  assert.equal(uploadedEvents.includes("test.retry.new.19"), true);
  configureLogs();
});

test("HTTP logs skip successful admin reads and redact warning URLs", async (context) => {
  const testContext = await createTestContext({ logLevel: "info" });
  context.after(() => testContext.cleanup());

  const configResponse = await testContext.adminRequest("/admin/api/config");
  assert.equal(configResponse.status, 200, configResponse.text);

  const modelsResponse = await testContext.publicRequest("/v1/models");
  assert.equal(modelsResponse.status, 200, modelsResponse.text);

  const correlatedResponse = await testContext.publicRequest("/v1/chat/completions", {
    method: "POST",
    headers: {
      "x-request-id": "request-log-correlation",
      "x-conversation-id": "conversation-log-correlation",
      "x-session-id": "session-log-correlation"
    },
    json: { model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }] }
  });
  assert.equal(correlatedResponse.status, 200, correlatedResponse.text);
  const upstreamRequest = testContext.getUpstreamRequest();
  assert.equal(upstreamRequest.headers["x-request-id"], "request-log-correlation");
  assert.equal(upstreamRequest.headers["x-conversation-id"], "conversation-log-correlation");
  assert.equal(upstreamRequest.headers["x-session-id"], "session-log-correlation");

  const streamResponse = await testContext.publicRequest("/v1/responses", {
    method: "POST",
    headers: {
      "x-request-id": "request-stream-correlation",
      "x-conversation-id": "conversation-stream-correlation",
      "x-session-id": "session-stream-correlation"
    },
    json: { model: "gpt-5.6-luna", input: "hello stream", stream: true }
  });
  assert.equal(streamResponse.status, 200, streamResponse.text);
  assert.match(streamResponse.text, /ok from mock responses stream/);

  const fallbackResponse = await testContext.publicRequest("/v1/responses", {
    method: "POST",
    headers: { "x-request-id": "request-local-usage" },
    json: { model: "gpt-5.6-luna", input: `local usage fallback ${"x".repeat(12000)}` }
  });
  assert.equal(fallbackResponse.status, 200, fallbackResponse.text);

  const fallbackStreamResponse = await testContext.publicRequest("/v1/responses", {
    method: "POST",
    headers: { "x-request-id": "request-local-stream-usage" },
    json: { model: "gpt-5.6-luna", input: "local usage fallback", stream: true }
  });
  assert.equal(fallbackStreamResponse.status, 200, fallbackStreamResponse.text);

  const disconnectController = new AbortController();
  const disconnectResponse = await fetch(`${testContext.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-client-key",
      "content-type": "application/json",
      "x-request-id": "request-disconnect-usage"
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", input: "disconnect usage fallback", stream: true }),
    signal: disconnectController.signal
  });
  await disconnectResponse.body.getReader().read();
  disconnectController.abort();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pendingLogs = await testContext.adminRequest("/admin/api/logs?requestId=request-disconnect-usage&limit=20");
    if (pendingLogs.json.items.some((entry) => entry.event === "proxy.stream_client_disconnected")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const upstreamDisconnectResponse = await testContext.publicRequest("/v1/responses", {
    method: "POST",
    headers: { "x-request-id": "request-upstream-disconnect-usage" },
    json: { model: "gpt-5.6-luna", input: "upstream disconnect usage fallback", stream: true }
  });
  assert.equal(upstreamDisconnectResponse.status, 200, upstreamDisconnectResponse.text);
  assert.match(upstreamDisconnectResponse.text, /ok from mock responses stream/);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pendingLogs = await testContext.adminRequest("/admin/api/logs?requestId=request-upstream-disconnect-usage&limit=20");
    if (pendingLogs.json.items.some((entry) => entry.event === "proxy.usage_recorded")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const rejectedResponse = await testContext.publicRequest("/v1/chat/completions", {
    method: "POST",
    headers: {
      "x-request-id": "request-error-correlation",
      "x-conversation-id": "conversation-error-correlation",
      "x-session-id": "session-error-correlation"
    },
    json: { model: "missing-model", messages: [{ role: "user", content: "hello" }] }
  });
  assert.equal(rejectedResponse.status, 404, rejectedResponse.text);

  const unauthorized = await testContext.request("/v1/models?api_key=HTTP_SECRET_PROBE");
  assert.equal(unauthorized.status, 401, unauthorized.text);

  const logsResponse = await testContext.adminRequest("/admin/api/logs?level=error,warn,info&limit=50");
  assert.equal(logsResponse.status, 200, logsResponse.text);
  const httpEntries = logsResponse.json.items.filter((entry) => entry.event === "http.request_completed");
  const success = httpEntries.find((entry) => entry.status === 200 && entry.fields.url === "/v1/models");
  const correlatedHttp = httpEntries.find((entry) => entry.requestId === "request-log-correlation");
  const proxyEntries = logsResponse.json.items.filter((entry) => entry.requestId === "request-log-correlation" && entry.source === "proxy");

  assert.ok(success);
  assert.equal(success.level, "info");
  assert.equal(success.fields.url, "/v1/models");
  assert.equal(httpEntries.some((entry) => entry.status === 401), false, "Auth rejections are not logged by default");
  assert.equal(logsResponse.json.items.some((entry) => entry.event === "http.auth_rejected"), false);
  assert.equal(correlatedHttp?.conversationId, "conversation-log-correlation");
  assert.equal(correlatedHttp?.sessionId, "session-log-correlation");
  assert.ok(proxyEntries.some((entry) => entry.event === "proxy.request_started"));
  assert.ok(proxyEntries.some((entry) => entry.event === "proxy.request_completed"));
  const startedEntry = proxyEntries.find((entry) => entry.event === "proxy.request_started");
  const completedEntry = proxyEntries.find((entry) => entry.event === "proxy.request_completed");
  const usageEntry = proxyEntries.find((entry) => entry.event === "proxy.usage_recorded");
  const streamEntries = logsResponse.json.items.filter((entry) => entry.requestId === "request-stream-correlation" && entry.source === "proxy");
  const streamCompleted = streamEntries.find((entry) => entry.event === "proxy.stream_completed");
  const streamUsage = streamEntries.find((entry) => entry.event === "proxy.usage_recorded");
  const rejectedEntry = logsResponse.json.items.find((entry) => entry.requestId === "request-error-correlation" && entry.event === "proxy.request_rejected");
  const fallbackUsage = logsResponse.json.items.find((entry) => entry.requestId === "request-local-usage" && entry.event === "proxy.usage_recorded");
  const fallbackStreamUsage = logsResponse.json.items.find((entry) => entry.requestId === "request-local-stream-usage" && entry.event === "proxy.usage_recorded");
  const disconnectedUsage = logsResponse.json.items.find((entry) => entry.requestId === "request-disconnect-usage" && entry.event === "proxy.usage_recorded");
  const disconnectedEntry = logsResponse.json.items.find((entry) => entry.requestId === "request-disconnect-usage" && entry.event === "proxy.stream_client_disconnected");
  const upstreamDisconnectedUsageEntries = logsResponse.json.items.filter((entry) => entry.requestId === "request-upstream-disconnect-usage" && entry.event === "proxy.usage_recorded");
  const upstreamDisconnectedUsage = upstreamDisconnectedUsageEntries[0];
  assert.match(startedEntry?.requestPreview || "", /hello/);
  assert.match(completedEntry?.responsePreview || "", /ok from mock chat/);
  assert.equal(completedEntry?.usageAvailable, true);
  assert.equal(usageEntry?.promptTokens, 11);
  assert.equal(usageEntry?.completionTokens, 7);
  assert.equal(usageEntry?.totalTokens, 18);
  assert.match(streamCompleted?.responsePreview || "", /ok from mock responses stream/);
  assert.equal(streamCompleted?.usageAvailable, true);
  assert.equal(streamCompleted?.conversationId, "conversation-stream-correlation");
  assert.equal(streamCompleted?.sessionId, "session-stream-correlation");
  assert.equal(streamUsage?.totalTokens, 16);
  assert.equal(rejectedEntry?.conversationId, "conversation-error-correlation");
  assert.equal(rejectedEntry?.sessionId, "session-error-correlation");
  assert.equal(fallbackUsage?.usageSource, "local_estimate");
  assert.equal(fallbackUsage?.usageEstimated, true);
  assert.equal(fallbackUsage?.fields.usageEstimationReason, undefined);
  assert.equal(fallbackUsage?.usageEstimationReason, "upstream_usage_missing");
  assert.ok(fallbackUsage?.promptTokens > 2500);
  assert.ok(fallbackUsage?.completionTokens > 0);
  assert.equal(fallbackStreamUsage?.usageSource, "local_estimate");
  assert.equal(fallbackStreamUsage?.usageEstimated, true);
  assert.equal(fallbackStreamUsage?.usageEstimationReason, "stream_usage_missing");
  assert.ok(fallbackStreamUsage?.completionTokens > 0);
  assert.equal(disconnectedUsage?.usageSource, "local_estimate");
  assert.equal(disconnectedUsage?.usageEstimationReason, "client_disconnected_before_usage");
  assert.ok(disconnectedUsage?.promptTokens > 0);
  assert.ok(disconnectedUsage?.completionTokens > 0);
  assert.equal(disconnectedEntry?.status, 499);
  assert.equal(disconnectedEntry?.usageEstimated, true);
  assert.equal(upstreamDisconnectedUsageEntries.length, 1);
  assert.equal(upstreamDisconnectedUsage?.usageSource, "local_estimate");
  assert.equal(upstreamDisconnectedUsage?.usageEstimationReason, "stream_interrupted_before_usage");
  assert.ok(upstreamDisconnectedUsage?.promptTokens > 0);
  assert.ok(upstreamDisconnectedUsage?.completionTokens > 0);
  const expectedStreamSnapshot = buildContentLogSnapshot({
    output: [{ type: "stream_text", text: "ok from mock responses stream" }]
  }, { kind: "responseBody" });
  assert.equal(streamCompleted?.responseSha256, expectedStreamSnapshot.sha256);
  assert.ok(proxyEntries.every((entry) => entry.conversationId === "conversation-log-correlation"));
  assert.ok(proxyEntries.every((entry) => entry.sessionId === "session-log-correlation"));
  assert.equal(httpEntries.some((entry) => entry.fields.url === "/admin/api/config"), false);
  for (const [requestId, recordedUsage] of [
    ["request-log-correlation", usageEntry],
    ["request-stream-correlation", streamUsage]
  ]) {
    const summaries = await testContext.adminRequest(`/admin/api/logs?view=requests&requestId=${requestId}`);
    assert.equal(summaries.status, 200, summaries.text);
    assert.equal(summaries.json.total, 1);
    const summary = summaries.json.items[0];
    assert.equal(summary.outcome, "success");
    assert.equal(summary.totalTokens, recordedUsage.totalTokens);
    assert.equal(summary.estimatedCostAmount, recordedUsage.estimatedCostAmount);
    assert.equal(summary.currency, recordedUsage.currency);
  }
});

test("HTTP status retries produce successful JSON and SSE request summaries without system noise", async context => {
  const attempts = new Map();
  const ctx = await createTestContext({
    logLevel: "info",
    upstreamHandler: async ({ body, res }) => {
      const attempt = (attempts.get(body.stream) || 0) + 1;
      attempts.set(body.stream, attempt);
      if (attempt > 1) return false;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "busy", message: "Temporary upstream failure" } }));
      return true;
    }
  });
  context.after(() => ctx.cleanup());
  const config = (await ctx.adminRequest("/admin/api/config")).json;
  config.proxy.retries = { ...config.proxy.retries, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 };
  const saved = await ctx.adminRequest("/admin/api/config", {
    method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
  });
  assert.equal(saved.status, 200, saved.text);
  for (const stream of [false, true]) {
    const requestId = `summary-http-retry-${stream}`;
    const response = await ctx.publicRequest("/v1/chat/completions", {
      method: "POST",
      headers: { "x-request-id": requestId },
      json: { model: "gpt-5-mini", stream, messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(attempts.get(stream), 2);
    const terminalEvent = stream ? "proxy.stream_completed" : "proxy.request_completed";
    let summary;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const logs = await ctx.adminRequest(`/admin/api/logs?view=requests&requestId=${requestId}`);
      assert.equal(logs.status, 200, logs.text);
      assert.equal(logs.json.total, 1);
      summary = logs.json.items[0];
      if (summary.events.some(entry => entry.event === terminalEvent)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(summary.events.some(entry => entry.event === terminalEvent));
    assert.equal(summary.outcome, "success");
    assert.equal(summary.status, 200);
    assert.equal(summary.retryCount, 1);
    assert.equal(summary.errorCode, "");
    assert.equal(summary.totalTokens, 18);
    const system = await ctx.adminRequest(`/admin/api/logs?view=events&requestId=${requestId}`);
    assert.equal(system.status, 200, system.text);
    assert.equal(system.json.total, 0);
  }
});

test("auth rejections are suppressed by default and logged as a separate event when enabled", async (context) => {
  const testContext = await createTestContext({ logLevel: "info" });
  context.after(() => testContext.cleanup());

  const robots = await testContext.request("/robots.txt");
  assert.equal(robots.status, 200, robots.text);
  assert.equal(robots.text, "User-agent: *\nDisallow: /\n");

  const adminDenied = await testContext.request("/admin/");
  assert.equal(adminDenied.status, 401);
  assert.equal(adminDenied.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal((await testContext.request("/")).status, 401);

  const runtime = await testContext.adminRequest("/admin/api/runtime");
  assert.equal(runtime.status, 200, runtime.text);
  assert.equal(runtime.json.runtime.logging.includeAuthRejected, false);
  assert.ok(runtime.json.runtime.logging.authRejectedSuppressed >= 2);
  const suppressedLogs = await testContext.adminRequest("/admin/api/logs?level=error,warn,info&limit=200");
  assert.equal(suppressedLogs.json.items.some((entry) => entry.status === 401), false);
  assert.equal(suppressedLogs.json.items.some((entry) => entry.fields.url === "/robots.txt"), false);

  const config = (await testContext.adminRequest("/admin/api/config")).json;
  config.observability.logs.includeAuthRejected = true;
  const saved = await testContext.adminRequest("/admin/api/config", {
    method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
  });
  assert.equal(saved.status, 200, saved.text);
  const enabledRuntime = await testContext.adminRequest("/admin/api/runtime");
  assert.equal(enabledRuntime.json.runtime.logging.includeAuthRejected, true);

  assert.equal((await testContext.request("/v1/models?api_key=HTTP_SECRET_PROBE")).status, 401);
  assert.equal((await testContext.request("/v1/models", { headers: { authorization: "Bearer wrong-key" } })).status, 401);
  assert.equal((await testContext.request("/admin/api/config", { headers: { "x-request-id": "req-admin-denied" } })).status, 401);

  const rejectedLogs = await testContext.adminRequest("/admin/api/logs?event=http.auth_rejected&limit=50");
  const rejected = rejectedLogs.json.items;
  const missingKey = rejected.find((entry) => entry.errorCode === "API_KEY_MISSING");
  assert.ok(missingKey);
  assert.equal(missingKey.level, "warn");
  assert.equal(missingKey.source, "http");
  assert.doesNotMatch(missingKey.fields.url, /HTTP_SECRET_PROBE/);
  assert.match(missingKey.fields.url, /^\/v1\/models\?api_key=.*REDACTED/);
  assert.ok(rejected.some((entry) => entry.errorCode === "API_KEY_INVALID"));
  const adminRejected = rejected.find((entry) => entry.errorCode === "ADMIN_UNAUTHORIZED");
  assert.equal(adminRejected?.source, "http.admin");
  assert.equal(adminRejected?.fields.url, "/admin/api/config");
  assert.equal(adminRejected?.requestId, "req-admin-denied");
  assert.match(adminRejected?.fields.reqId || "", /^req-[0-9a-z]+$/);

  const visible = await testContext.adminRequest("/admin/api/logs?level=error,warn,info&excludeEvent=http.auth_rejected&limit=200");
  assert.equal(visible.json.items.some((entry) => entry.event === "http.auth_rejected"), false);
  assert.equal(visible.json.items.some((entry) => entry.status === 401), false);

  config.observability.logs.includeAuthRejected = false;
  const disabled = await testContext.adminRequest("/admin/api/config", {
    method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
  });
  assert.equal(disabled.status, 200, disabled.text);
  const disabledRuntime = await testContext.adminRequest("/admin/api/runtime");
  assert.equal(disabledRuntime.json.runtime.logging.includeAuthRejected, false);
  assert.equal((await testContext.request("/admin/", { headers: { "x-request-id": "request-suppressed-again" } })).status, 401);
  const suppressedAgain = await testContext.adminRequest("/admin/api/logs?requestId=request-suppressed-again");
  assert.equal(suppressedAgain.json.total, 0);
  const historical = await testContext.adminRequest("/admin/api/logs?event=http.auth_rejected&limit=50");
  assert.deepEqual(historical.json.items.map((entry) => entry.id), rejected.map((entry) => entry.id));
  const hiddenHistory = await testContext.adminRequest("/admin/api/logs?event=http.auth_rejected&excludeEvent=http.auth_rejected");
  assert.equal(hiddenHistory.json.total, 0);
});

test("access logs and proxy rejections carry the cause of 400 responses without request content", async (context) => {
  const testContext = await createTestContext({ logLevel: "info" });
  context.after(() => testContext.cleanup());

  const invalid = await testContext.publicRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "request-invalid-json" },
    body: "{\"model\":\"gpt-5-mini\",\"messages\":BODY_CONTENT_PROBE"
  });
  assert.equal(invalid.status, 400, invalid.text);

  const logs = await testContext.adminRequest("/admin/api/logs?requestId=request-invalid-json&limit=20");
  const completed = logs.json.items.find((entry) => entry.event === "http.request_completed");
  assert.equal(completed?.status, 400);
  assert.equal(completed?.fields.url, "/v1/chat/completions");
  assert.equal(completed?.errorCode, "FST_ERR_CTP_INVALID_JSON_BODY");
  assert.match(completed?.failureReason || "", /not valid JSON/);
  assert.doesNotMatch(JSON.stringify(logs.json.items), /BODY_CONTENT_PROBE/);

  const config = (await testContext.adminRequest("/admin/api/config")).json;
  config.proxy.guards.rejectUnknownProxyParams = true;
  config.proxy.timeouts.allowPerRequestOverride = false;
  const saved = await testContext.adminRequest("/admin/api/config", {
    method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json: config
  });
  assert.equal(saved.status, 200, saved.text);
  testContext.clearUpstreamRequests();
  const controlRejected = await testContext.publicRequest("/v1/chat/completions", {
    method: "POST",
    headers: { "x-request-id": "request-proxy-control" },
    json: { model: "gpt-5-mini", messages: [{ role: "user", content: "hello" }], timeoutMs: 1000 }
  });
  assert.equal(controlRejected.status, 400, controlRejected.text);
  assert.equal(testContext.upstreamRequests.length, 0);
  const controlLogs = await testContext.adminRequest("/admin/api/logs?requestId=request-proxy-control&limit=20");
  const rejection = controlLogs.json.items.find((entry) => entry.event === "proxy.request_rejected");
  assert.equal(rejection?.errorCode, "UNKNOWN_PROXY_CONTROL_FIELDS");
  assert.equal(rejection?.status, 400);
  assert.match(rejection?.failureReason || "", /timeoutMs/);
});