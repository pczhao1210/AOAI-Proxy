import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_ROUTE = "chat/completions";
const DEFAULT_ITERATIONS = 3;
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), "test/output");
const DEFAULT_ADMIN_LOGS_PATH = "/admin/api/logs";
const DEFAULT_PROMPT = "Reply in one short sentence about latency diagnostics.";
const DEFAULT_CHAT_SYSTEM_PROMPT = "You are a concise assistant.";

function getOptionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function requireEnv(...names) {
  const value = getOptionalEnv(...names);
  if (!value) {
    throw new Error(`Missing required environment variable. Tried: ${names.join(", ")}`);
  }
  return value;
}

function getPositiveIntEnv(names, fallback) {
  const raw = getOptionalEnv(...names);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getBooleanEnv(names, fallback) {
  const raw = getOptionalEnv(...names);
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeRouteKey(value) {
  const normalized = String(value || "").trim().replace(/^\/+/, "").replace(/^v1\//, "");
  if (normalized === "chat/completions" || normalized === "responses") {
    return normalized;
  }
  throw new Error(`Unsupported route for latency analysis: ${value}`);
}

function resolveDefaultModel(routeKey) {
  if (routeKey === "responses") {
    return getOptionalEnv("AOAI_PROXY_LATENCY_MODEL", "AOAI_PROXY_REAL_RESPONSE_MODEL");
  }
  return getOptionalEnv("AOAI_PROXY_LATENCY_MODEL", "AOAI_PROXY_REAL_CHAT_MODEL");
}

function buildConfig() {
  const routeKey = normalizeRouteKey(getOptionalEnv("AOAI_PROXY_LATENCY_ROUTE") || DEFAULT_ROUTE);
  const baseUrl = getOptionalEnv("AOAI_PROXY_LATENCY_BASE_URL", "AOAI_PROXY_REAL_BASE_URL") || DEFAULT_BASE_URL;
  const model = resolveDefaultModel(routeKey);
  if (!model) {
    throw new Error("Missing model. Set AOAI_PROXY_LATENCY_MODEL, or reuse AOAI_PROXY_REAL_CHAT_MODEL / AOAI_PROXY_REAL_RESPONSE_MODEL.");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    routeKey,
    routePath: `/v1/${routeKey}`,
    apiKey: requireEnv("AOAI_PROXY_LATENCY_API_KEY", "AOAI_PROXY_REAL_API_KEY"),
    model,
    prompt: getOptionalEnv("AOAI_PROXY_LATENCY_PROMPT") || DEFAULT_PROMPT,
    chatSystemPrompt: getOptionalEnv("AOAI_PROXY_LATENCY_SYSTEM_PROMPT") || DEFAULT_CHAT_SYSTEM_PROMPT,
    iterations: getPositiveIntEnv(["AOAI_PROXY_LATENCY_ITERATIONS"], DEFAULT_ITERATIONS),
    timeoutMs: getPositiveIntEnv(["AOAI_PROXY_LATENCY_TIMEOUT_MS", "AOAI_PROXY_REAL_TIMEOUT_MS"], DEFAULT_TIMEOUT_MS),
    delayMs: getPositiveIntEnv(["AOAI_PROXY_LATENCY_DELAY_MS"], DEFAULT_DELAY_MS),
    fetchProxyLogs: getBooleanEnv(["AOAI_PROXY_LATENCY_FETCH_PROXY_LOGS"], true),
    adminLogsPath: getOptionalEnv("AOAI_PROXY_LATENCY_ADMIN_LOGS_PATH") || DEFAULT_ADMIN_LOGS_PATH,
    adminUsername: getOptionalEnv("AOAI_PROXY_LATENCY_ADMIN_USERNAME", "AOAI_PROXY_ADMIN_USERNAME"),
    adminPassword: getOptionalEnv("AOAI_PROXY_LATENCY_ADMIN_PASSWORD", "AOAI_PROXY_ADMIN_PASSWORD"),
    outputDir: path.resolve(getOptionalEnv("AOAI_PROXY_LATENCY_OUTPUT_DIR", "AOAI_PROXY_REAL_OUTPUT_DIR") || DEFAULT_OUTPUT_DIR)
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(1)} ms`;
}

function numericOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createProxyHeaders(config, requestId) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-request-id": requestId
  };
}

function createAdminHeaders(config) {
  if (!config.adminUsername || !config.adminPassword) {
    return {};
  }
  const token = Buffer.from(`${config.adminUsername}:${config.adminPassword}`, "utf8").toString("base64");
  return {
    authorization: `Basic ${token}`
  };
}

function buildPayload(config) {
  if (config.routeKey === "responses") {
    return {
      model: config.model,
      input: config.prompt,
      stream: true
    };
  }

  return {
    model: config.model,
    stream: true,
    messages: [
      {
        role: "system",
        content: config.chatSystemPrompt
      },
      {
        role: "user",
        content: config.prompt
      }
    ]
  };
}

function extractTextFragment(json) {
  const chatDelta = json?.choices?.[0]?.delta?.content;
  if (typeof chatDelta === "string" && chatDelta.length > 0) {
    return chatDelta;
  }
  if (Array.isArray(chatDelta)) {
    const joined = chatDelta
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (joined) return joined;
  }
  if (json?.type === "response.output_text.delta" && typeof json?.delta === "string" && json.delta.length > 0) {
    return json.delta;
  }
  return "";
}

function collectMetric(values, selector) {
  const items = values
    .map(selector)
    .filter((value) => Number.isFinite(value));
  if (!items.length) {
    return null;
  }
  const total = items.reduce((sum, value) => sum + value, 0);
  return {
    min: Math.min(...items),
    max: Math.max(...items),
    avg: total / items.length
  };
}

function formatMetricSummary(label, summary) {
  if (!summary) return `${label}=n/a`;
  return `${label}=avg ${formatMs(summary.avg)} min ${formatMs(summary.min)} max ${formatMs(summary.max)}`;
}

async function collectStreamMetrics(response, startedAt) {
  assert.ok(response.body, "Expected streaming response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const metrics = {
    firstChunkMs: null,
    firstEventMs: null,
    firstTokenMs: null,
    streamCompletedMs: null,
    chunkCount: 0,
    dataEventCount: 0,
    bytes: 0,
    firstTokenPreview: ""
  };
  let buffer = "";

  const processLine = (line, now) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (!Number.isFinite(metrics.firstEventMs)) {
      metrics.firstEventMs = now - startedAt;
    }
    if (payload === "[DONE]") {
      return;
    }
    metrics.dataEventCount += 1;
    try {
      const parsed = JSON.parse(payload);
      const fragment = extractTextFragment(parsed);
      if (fragment && !Number.isFinite(metrics.firstTokenMs)) {
        metrics.firstTokenMs = now - startedAt;
        metrics.firstTokenPreview = fragment.slice(0, 80);
      }
    } catch {
      // ignore partial or non-JSON events
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    const now = performance.now();
    if (done) {
      metrics.streamCompletedMs = now - startedAt;
      break;
    }
    metrics.chunkCount += 1;
    metrics.bytes += value.byteLength;
    if (!Number.isFinite(metrics.firstChunkMs)) {
      metrics.firstChunkMs = now - startedAt;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      processLine(line, now);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    processLine(buffer, performance.now());
  }

  return metrics;
}

async function fetchProxyTiming(config, requestId) {
  if (!config.fetchProxyLogs) return null;

  const response = await fetch(`${config.baseUrl}${config.adminLogsPath}?requestId=${encodeURIComponent(requestId)}&limit=50`, {
    method: "GET",
    headers: createAdminHeaders(config)
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: await response.text().catch(() => `Unexpected status ${response.status}`)
    };
  }

  const payload = await response.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const timingEntry = items.find((item) => item?.event === "proxy.request_timing");
  if (!timingEntry) {
    return {
      ok: false,
      status: 404,
      message: "proxy.request_timing log not found for request"
    };
  }

  const fields = timingEntry?.fields && typeof timingEntry.fields === "object" ? timingEntry.fields : {};
  return {
    ok: true,
    status: timingEntry.status,
    errorCode: timingEntry.errorCode || "",
    outcome: typeof fields.outcome === "string" ? fields.outcome : "",
    preAuthMs: numericOrNull(fields.preAuthMs),
    authPrepareMs: numericOrNull(fields.authPrepareMs),
    requestPrepareMs: numericOrNull(fields.requestPrepareMs),
    governanceAcquireMs: numericOrNull(fields.governanceAcquireMs),
    preUpstreamMs: numericOrNull(fields.preUpstreamMs),
    upstreamHeadersMs: numericOrNull(fields.upstreamHeadersMs),
    upstreamFirstChunkMs: numericOrNull(fields.upstreamFirstChunkMs),
    firstChunkLatencyMs: numericOrNull(fields.firstChunkLatencyMs),
    totalDurationMs: numericOrNull(fields.totalDurationMs),
    upstreamAttempts: numericOrNull(fields.upstreamAttempts)
  };
}

function buildDiagnosis(result) {
  const proxy = result.proxyTiming;
  if (!proxy?.ok) {
    return "Proxy internal timing unavailable; only client-side timing was collected.";
  }

  const headersToFirstChunkMs = Number.isFinite(proxy.upstreamFirstChunkMs) && Number.isFinite(proxy.upstreamHeadersMs)
    ? Math.max(0, proxy.upstreamFirstChunkMs - proxy.upstreamHeadersMs)
    : null;

  const ranked = [
    ["AAD 鉴权准备", proxy.authPrepareMs],
    ["治理/持久化回填", proxy.governanceAcquireMs],
    ["上游到响应头", proxy.upstreamHeadersMs],
    ["响应头到首 chunk", headersToFirstChunkMs]
  ]
    .filter(([, value]) => Number.isFinite(value))
    .sort((a, b) => b[1] - a[1]);

  if (!ranked.length) {
    return "Proxy timing was captured, but no dominant phase could be derived.";
  }

  const [phase, value] = ranked[0];
  return `Dominant phase: ${phase} (${formatMs(value)}).`;
}

function printIteration(result, index, total) {
  process.stdout.write(`\n[run ${index + 1}/${total}] requestId=${result.requestId} route=${result.routeKey} model=${result.model}\n`);
  process.stdout.write(`client  status=${result.status} headers=${formatMs(result.headersMs)} firstChunk=${formatMs(result.firstChunkMs)} firstToken=${formatMs(result.firstTokenMs)} completed=${formatMs(result.streamCompletedMs)} chunks=${result.chunkCount} bytes=${result.bytes}\n`);
  if (result.firstTokenPreview) {
    process.stdout.write(`token   preview=${JSON.stringify(result.firstTokenPreview)}\n`);
  }
  if (result.proxyTiming?.ok) {
    const proxy = result.proxyTiming;
    const headersToFirstChunkMs = Number.isFinite(proxy.upstreamFirstChunkMs) && Number.isFinite(proxy.upstreamHeadersMs)
      ? Math.max(0, proxy.upstreamFirstChunkMs - proxy.upstreamHeadersMs)
      : null;
    process.stdout.write(`proxy   preAuth=${formatMs(proxy.preAuthMs)} auth=${formatMs(proxy.authPrepareMs)} prepare=${formatMs(proxy.requestPrepareMs)} governance=${formatMs(proxy.governanceAcquireMs)} upstreamHeaders=${formatMs(proxy.upstreamHeadersMs)} headersToFirstChunk=${formatMs(headersToFirstChunkMs)} total=${formatMs(proxy.totalDurationMs)} attempts=${proxy.upstreamAttempts ?? "n/a"} outcome=${proxy.outcome || "n/a"}\n`);
  } else if (result.proxyTiming) {
    process.stdout.write(`proxy   unavailable status=${result.proxyTiming.status} message=${result.proxyTiming.message}\n`);
  }
  process.stdout.write(`hint    ${buildDiagnosis(result)}\n`);
}

function buildSummary(results) {
  return {
    client: {
      headersMs: collectMetric(results, (item) => item.headersMs),
      firstChunkMs: collectMetric(results, (item) => item.firstChunkMs),
      firstTokenMs: collectMetric(results, (item) => item.firstTokenMs),
      completedMs: collectMetric(results, (item) => item.streamCompletedMs)
    },
    proxy: {
      authPrepareMs: collectMetric(results, (item) => item.proxyTiming?.authPrepareMs),
      governanceAcquireMs: collectMetric(results, (item) => item.proxyTiming?.governanceAcquireMs),
      upstreamHeadersMs: collectMetric(results, (item) => item.proxyTiming?.upstreamHeadersMs),
      upstreamFirstChunkMs: collectMetric(results, (item) => item.proxyTiming?.upstreamFirstChunkMs),
      totalDurationMs: collectMetric(results, (item) => item.proxyTiming?.totalDurationMs)
    }
  };
}

async function writeReport(config, results, summary) {
  await fs.mkdir(config.outputDir, { recursive: true });
  const reportPath = path.join(config.outputDir, `latency-report-${Date.now()}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    config: {
      baseUrl: config.baseUrl,
      routeKey: config.routeKey,
      model: config.model,
      iterations: config.iterations,
      timeoutMs: config.timeoutMs,
      delayMs: config.delayMs,
      fetchProxyLogs: config.fetchProxyLogs,
      adminLogsPath: config.adminLogsPath
    },
    summary,
    runs: results
  };
  await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

async function runOneIteration(config, index) {
  const requestId = `latency-${Date.now()}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`;
  const payload = buildPayload(config);
  const controller = new AbortController();
  const startedAt = performance.now();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}${config.routePath}`, {
      method: "POST",
      headers: createProxyHeaders(config, requestId),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const headersAt = performance.now();

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Unexpected status ${response.status}: ${errorText}`);
    }

    const streamMetrics = await collectStreamMetrics(response, startedAt);
    const proxyTiming = await fetchProxyTiming(config, requestId).catch((error) => ({
      ok: false,
      status: 500,
      message: error?.message || String(error)
    }));

    return {
      requestId,
      routeKey: config.routeKey,
      model: config.model,
      status: response.status,
      headersMs: headersAt - startedAt,
      ...streamMetrics,
      proxyTiming
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const config = buildConfig();
  process.stdout.write(`Latency analysis target=${config.baseUrl}${config.routePath} model=${config.model} iterations=${config.iterations}\n`);

  const results = [];
  for (let index = 0; index < config.iterations; index += 1) {
    const result = await runOneIteration(config, index);
    results.push(result);
    printIteration(result, index, config.iterations);
    if (index < config.iterations - 1 && config.delayMs > 0) {
      await sleep(config.delayMs);
    }
  }

  const summary = buildSummary(results);
  process.stdout.write("\nSummary\n");
  process.stdout.write(`${formatMetricSummary("client.headers", summary.client.headersMs)}\n`);
  process.stdout.write(`${formatMetricSummary("client.firstChunk", summary.client.firstChunkMs)}\n`);
  process.stdout.write(`${formatMetricSummary("client.firstToken", summary.client.firstTokenMs)}\n`);
  process.stdout.write(`${formatMetricSummary("client.completed", summary.client.completedMs)}\n`);
  process.stdout.write(`${formatMetricSummary("proxy.auth", summary.proxy.authPrepareMs)}\n`);
  process.stdout.write(`${formatMetricSummary("proxy.governance", summary.proxy.governanceAcquireMs)}\n`);
  process.stdout.write(`${formatMetricSummary("proxy.upstreamHeaders", summary.proxy.upstreamHeadersMs)}\n`);
  process.stdout.write(`${formatMetricSummary("proxy.upstreamFirstChunk", summary.proxy.upstreamFirstChunkMs)}\n`);
  process.stdout.write(`${formatMetricSummary("proxy.total", summary.proxy.totalDurationMs)}\n`);

  const reportPath = await writeReport(config, results, summary);
  process.stdout.write(`\nSaved report: ${reportPath}\n`);
}

await main();