import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { closeSharedPostgresPools, quoteIdentifier } from "../src/postgres.js";
import * as store from "../src/runtime-store.js";
import { getGovernanceSnapshot } from "../src/governance.js";
import { createTestContext } from "./lib/harness.js";

const baseline = JSON.parse(await fs.readFile(new URL("./runtime-performance-baseline.json", import.meta.url), "utf8"));
const databaseUrl = process.env.RUNTIME_MEDIA_TEST_DATABASE_URL;
assert.ok(databaseUrl, "Supply a disposable RUNTIME_MEDIA_TEST_DATABASE_URL; no production or provider endpoints are used.");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname), "Only loopback test PostgreSQL is allowed");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-runtime-benchmark-"));
const schema = `benchmark_${process.pid}_${Date.now()}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
const envNames = ["RUNTIME_DB_CONNECTION_STRING", "CONFIG_DB_CONNECTION_STRING", "DATABASE_URL"];
const previousEnvironment = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const originalAppend = fs.appendFile;
const originalRename = fs.rename;
const report = { node: process.version, platform: `${os.platform()} ${os.arch()}`, settings: baseline };
const percentile = (values, rank) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * rank / 100) - 1].toFixed(2));
let ctx;

try {
  const probeFile = path.join(dir, "event-loop.json");
  const text = "x".repeat(baseline.frameTextBytes);
  const frame = `data: ${JSON.stringify({ id: "benchmark", object: "chat.completion.chunk", model: "gpt-5-mini", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
  ctx = await createTestContext({
    proxyArgs: ["--import", "./test/lib/runtime-benchmark-probe.js", "src/server.js"],
    proxyEnv: { RUNTIME_BENCHMARK_PROBE: probeFile, PERSISTENCE_MODE: "file", CONFIG_PERSISTENCE_MODE: "file" },
    upstreamHandler: async ({ res, body }) => {
      if (!body.stream) return false;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (let index = 0; index < baseline.streamFrames; index++) {
        if (!res.write(frame)) await once(res, "drain");
        if (index % 64 === 0) await yieldTurn();
      }
      res.end(`data: ${JSON.stringify({ id: "benchmark", object: "chat.completion.chunk", model: "gpt-5-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
      return true;
    }
  });
  const config = await ctx.readConfigFile();
  async function streamRequest() {
    const start = performance.now();
    const response = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKeys[0].key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", stream: true, messages: [{ role: "user", content: "benchmark" }] })
    });
    assert.equal(response.status, 200);
    let firstTokenMs;
    let bytes = 0;
    let pending = "";
    let tail = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      const decoded = decoder.decode(chunk, { stream: true });
      tail = (tail + decoded).slice(-128);
      if (firstTokenMs !== undefined) continue;
      pending += decoded;
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data && data !== "[DONE]" && JSON.parse(data).choices?.some(choice => choice.delta?.content)) {
          firstTokenMs = performance.now() - start;
          break;
        }
      }
    }
    assert.ok(Number.isFinite(firstTokenMs));
    assert.ok(bytes >= baseline.streamFrames * baseline.frameTextBytes, "The benchmark must consume long streams, not just headers");
    assert.match(tail, /data: \[DONE\]/);
    return { firstTokenMs, bytes };
  }
  await streamRequest();
  await streamRequest();
  process.kill(ctx.pid, "SIGUSR2");
  await delay(30);
  let next = 0;
  const streams = [];
  await Promise.all(Array.from({ length: baseline.concurrency }, async () => {
    while (next < baseline.samples) {
      next++;
      streams.push(await streamRequest());
    }
  }));
  await ctx.stopProxy();
  const probe = JSON.parse(await fs.readFile(probeFile, "utf8"));
  assert.ok(probe.resetAt, "Event-loop probe must exclude startup/warmup");
  report.streaming = {
    samples: streams.length,
    bytes: streams.reduce((sum, sample) => sum + sample.bytes, 0),
    firstTokenP95Ms: percentile(streams.map(sample => sample.firstTokenMs), 95),
    firstTokenP99Ms: percentile(streams.map(sample => sample.firstTokenMs), 99),
    eventLoop: probe
  };
  await ctx.cleanup();
  ctx = null;

  for (const name of envNames) delete process.env[name];
  const spool = path.join(dir, "pending.ndjson");
  const runtimeConfig = {
    persistence: { configStore: { mode: "database", filePath: path.join(dir, "config.json") } },
    observability: { runtimeStore: { schema, localBufferPath: spool, batchSize: 100, flushIntervalMs: 60000 } },
    apiKeys: Array.from({ length: 100 }, (_, index) => ({ id: `key-${index}` }))
  };
  let appendBytes = 0;
  let compactionBytes = 0;
  let checkpointBytes = 0;
  fs.appendFile = async function (file, data, ...args) {
    if (file === spool) appendBytes += Buffer.byteLength(data);
    return originalAppend.call(this, file, data, ...args);
  };
  fs.rename = async function (source, destination) {
    if (destination === spool) compactionBytes += (await fs.stat(source)).size;
    if (destination === `${spool}.offset`) checkpointBytes += (await fs.stat(source)).size;
    return originalRename.call(this, source, destination);
  };
  store.setRuntimeStoreConfig(runtimeConfig);
  const appendStart = performance.now();
  for (let offset = 0; offset < baseline.bufferedEvents; offset += 25) {
    for (let index = offset; index < Math.min(offset + 25, baseline.bufferedEvents); index++) {
      store.recordRuntimeUsage(runtimeConfig, {
        keyId: `key-${index % 100}`, modelId: `model-${index % 10}`, totalTokens: 3, estimatedCostAmount: 0.01,
        usageEstimationReason: `benchmark-${"x".repeat(1024)}`
      });
    }
    const expected = Math.min(offset + 25, baseline.bufferedEvents);
    const deadline = performance.now() + 5000;
    while (store.getRuntimeStoreInfo().persistedEventCount < expected && performance.now() < deadline) await yieldTurn();
    assert.equal(store.getRuntimeStoreInfo().persistedEventCount, expected);
  }
  const appendMs = performance.now() - appendStart;
  const initialBytes = (await fs.stat(spool)).size;
  process.env.RUNTIME_DB_CONNECTION_STRING = databaseUrl;
  const drainStart = performance.now();
  store.setRuntimeStoreConfig(runtimeConfig, { refreshLocalBuffer: false });
  const drained = await store.drainRuntimeEvents();
  const drainMs = performance.now() - drainStart;
  assert.equal(drained.pendingMemoryEvents, 0);
  assert.equal(drained.pendingPersistedEvents, 0);
  const ledger = await admin.query(`SELECT COUNT(*) AS count, SUM(total_tokens) AS tokens FROM ${quoteIdentifier(schema, "test schema")}.runtime_events`);
  assert.equal(Number(ledger.rows[0].count), baseline.bufferedEvents);
  assert.equal(Number(ledger.rows[0].tokens), baseline.bufferedEvents * 3);
  report.spool = {
    events: baseline.bufferedEvents, initialBytes, appendBytes, compactionBytes, checkpointBytes,
    writeAmplification: Number(((appendBytes + compactionBytes) / initialBytes).toFixed(3)),
    appendMs: Number(appendMs.toFixed(2)), drainMs: Number(drainMs.toFixed(2))
  };
  const queries = [];
  for (let index = 0; index < baseline.coldQuerySamples; index++) {
    await closeSharedPostgresPools();
    const start = performance.now();
    const [snapshot, governance] = await Promise.all([
      store.getRuntimeStatsSnapshot(runtimeConfig, {}, { readOnly: true }),
      getGovernanceSnapshot(runtimeConfig, { readOnly: true })
    ]);
    queries.push(performance.now() - start);
    assert.equal(snapshot.snapshot.source, "database");
    assert.equal(snapshot.totals.totalTokens, baseline.bufferedEvents * 3);
    assert.equal(governance.keys.length, 100);
    assert.ok(governance.keys.every(key => key.runtime.known));
  }
  report.coldStatistics = { samples: queries.length, p95Ms: percentile(queries, 95), p99Ms: percentile(queries, 99) };
  report.limitations = "Synthetic loopback load, cold client connections (not cold PostgreSQL disk cache), and shared-host timing. No live-provider, deployment capacity or billing acceptance.";
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes("--check")) {
    const measured = {
      firstTokenP99Ms: report.streaming.firstTokenP99Ms,
      eventLoopP99Ms: report.streaming.eventLoop.p99Ms,
      coldStatsP95Ms: report.coldStatistics.p95Ms,
      spoolWriteAmplification: report.spool.writeAmplification,
      spoolDrainMs: report.spool.drainMs
    };
    for (const [metric, value] of Object.entries(measured)) assert.ok(value <= baseline.limits[metric], `${metric}: ${value} exceeds ${baseline.limits[metric]}`);
  }
} finally {
  fs.appendFile = originalAppend;
  fs.rename = originalRename;
  await ctx?.cleanup();
  store.setRuntimeStoreConfig(null);
  await closeSharedPostgresPools();
  await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema, "test schema")} CASCADE`);
  await admin.end();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
}
