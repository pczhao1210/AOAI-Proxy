import assert from "node:assert/strict";
import test from "node:test";
import { appendStructuredLog, getLogRuntimeInfo, queryLogs, setLogConfig } from "../src/logs.js";
import { createTestContext } from "./lib/harness.js";

function configureLogs({ level = "info", sinks = ["memory"], bufferSize = 500, logAnalytics = {}, ...settings } = {}) {
  setLogConfig({
    observability: {
      logs: { level, sinks, bufferSize, ...settings },
      logAnalytics: { enabled: false, ...logAnalytics }
    }
  });
}

test("structured logs honor the configured minimum level", () => {
  configureLogs({ level: "warn" });
  appendStructuredLog("info", { event: "test.level.info" });
  appendStructuredLog("warn", { event: "test.level.warn" });

  assert.equal(queryLogs({ event: "test.level.info" }).total, 0);
  assert.equal(queryLogs({ event: "test.level.warn" }).total, 1);
});

test("structured logs honor the memory sink setting", () => {
  configureLogs({ sinks: [] });
  appendStructuredLog("error", { event: "test.sink.disabled" });

  assert.equal(queryLogs({ event: "test.sink.disabled" }).total, 0);
});

test("configured buffers can retain more than one hundred entries", () => {
  configureLogs({ bufferSize: 150 });
  for (let index = 0; index < 150; index += 1) {
    appendStructuredLog("info", { event: "test.buffer.capacity", index });
  }

  assert.equal(queryLogs({ event: "test.buffer.capacity", limit: 500 }).items.length, 150);
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
    prompt: "private prompt text",
    imageBase64: "YWJjZGVmZ2hp"
  });

  const entry = queryLogs({ event: "test.privacy.controls" }).items[0];
  assert.equal(entry.clientIp, "");
  assert.equal(entry.forwardedFor, "");
  assert.equal(entry.fields.keyId, "[REDACTED]");
  assert.equal(entry.fields.headers, "[OMITTED]");
  assert.equal("promptTokens" in entry.fields, false);
  assert.equal(entry.fields.prompt, "[OMITTED]");
  assert.equal(entry.fields.imageBase64, "YWJj...<truncated>");
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

test("HTTP logs skip successful admin reads and redact warning URLs", async (context) => {
  const testContext = await createTestContext({ logLevel: "info" });
  context.after(() => testContext.cleanup());

  const configResponse = await testContext.adminRequest("/admin/api/config");
  assert.equal(configResponse.status, 200, configResponse.text);

  const unauthorized = await testContext.request("/v1/models?api_key=HTTP_SECRET_PROBE");
  assert.equal(unauthorized.status, 401, unauthorized.text);

  const logsResponse = await testContext.adminRequest("/admin/api/logs?level=warn&limit=50");
  assert.equal(logsResponse.status, 200, logsResponse.text);
  const httpEntries = logsResponse.json.items.filter((entry) => entry.event === "http.request_completed");
  const warning = httpEntries.find((entry) => entry.status === 401);

  assert.ok(warning);
  assert.equal(warning.level, "warn");
  assert.equal(warning.source, "http");
  assert.doesNotMatch(warning.fields.url, /HTTP_SECRET_PROBE/);
  assert.match(warning.fields.url, /api_key=.*REDACTED/);
  assert.equal(httpEntries.some((entry) => entry.fields.url === "/admin/api/config"), false);
});