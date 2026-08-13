import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestContext } from "../lib/harness.js";
import { runProcess } from "./run-process.js";

const EXPECTED_VERSION = process.env.CODEX_EXPECTED_VERSION || "0.147.0";
const PROCESS_TIMEOUT_MS = 30000;

function parseJsonLines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const versionResult = await runProcess("codex", ["--version"], { timeoutMs: PROCESS_TIMEOUT_MS });
assert.equal(versionResult.code, 0, versionResult.stderr);
assert.match(versionResult.stdout, new RegExp(`\\b${EXPECTED_VERSION.replaceAll(".", "\\.")}\\b`));

const ctx = await createTestContext();
let codexHome;
try {
  codexHome = await fs.mkdtemp(path.join(process.cwd(), ".codex-smoke-"));
  const codexEnv = {
    ...process.env,
    AOAI_PROXY_API_KEY: "test-client-key",
    CODEX_HOME: codexHome
  };
  const providerBaseConfigArgs = [
    "-c", "model_provider=\"aoai_proxy\"",
    "-c", "model_providers.aoai_proxy.name=\"AOAI Proxy\"",
    "-c", `model_providers.aoai_proxy.base_url=\"${ctx.baseUrl}/v1\"`,
    "-c", "model_providers.aoai_proxy.wire_api=\"responses\"",
    "-c", "model_providers.aoai_proxy.requires_openai_auth=false",
    "-c", "model_providers.aoai_proxy.supports_websockets=false",
    "-c", "model_providers.aoai_proxy.request_max_retries=0",
    "-c", "model_providers.aoai_proxy.stream_max_retries=0"
  ];
  const catalogProviderConfigArgs = [
    ...providerBaseConfigArgs,
    "-c", `model_providers.aoai_proxy.auth.command=${JSON.stringify(process.execPath)}`,
    "-c", `model_providers.aoai_proxy.auth.args=${JSON.stringify([
      "-e",
      "process.stdout.write(process.env.AOAI_PROXY_API_KEY || '')"
    ])}`,
    "-c", `model_providers.aoai_proxy.auth.cwd=${JSON.stringify(process.cwd())}`,
    "-c", "model_providers.aoai_proxy.auth.timeout_ms=5000",
    "-c", "model_providers.aoai_proxy.auth.refresh_interval_ms=0"
  ];
  const execProviderConfigArgs = [
    ...providerBaseConfigArgs,
    "-c", "model_providers.aoai_proxy.env_key=\"AOAI_PROXY_API_KEY\""
  ];
  const catalogResult = await runProcess("codex", [
    "debug", "models",
    ...catalogProviderConfigArgs
  ], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    cwd: process.cwd(),
    env: codexEnv
  });
  assert.equal(
    catalogResult.code,
    0,
    `Codex model catalog failed:\n${catalogResult.stdout}\n${catalogResult.stderr}`
  );
  const catalog = JSON.parse(catalogResult.stdout);
  const catalogModels = Array.isArray(catalog) ? catalog : catalog.models;
  assert.ok(Array.isArray(catalogModels), "Codex did not render a model catalog array");
  assert.ok(catalogModels.some((model) => model.slug === "gpt-5.6-luna"));
  assert.equal(catalogModels.some((model) => model.slug === "gpt-5-mini"), false);

  const result = await runProcess("codex", [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--color", "never",
    "--json",
    "-m", "gpt-5.6-luna",
    ...execProviderConfigArgs,
    "Respond with one short sentence. Do not use tools."
  ], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    cwd: process.cwd(),
    env: codexEnv
  });

  const events = parseJsonLines(result.stdout);
  const agentMessage = events.find((event) => (
    event.type === "item.completed" && event.item?.type === "agent_message"
  ));
  const responseRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
  const accessLogs = await ctx.adminRequest("/admin/api/logs?event=http.request_completed&limit=100");
  const modelCatalogRequest = accessLogs.json?.items?.find((item) => (
    item.fields?.method === "GET"
    && String(item.fields?.url || "").split("?")[0] === "/v1/models"
  ));
  const requestDiagnostics = (accessLogs.json?.items || []).map((item) => ({
    method: item.fields?.method,
    url: item.fields?.url,
    status: item.status
  }));

  assert.equal(
    result.code,
    0,
    `Codex exited with signal ${result.signal || "none"}\n`
      + `Responses upstream reached: ${Boolean(responseRequest)}\n`
      + `Proxy requests: ${JSON.stringify(requestDiagnostics)}\n`
      + `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
  );
  assert.ok(agentMessage, `Codex did not emit an agent_message:\n${result.stdout}`);
  assert.equal(agentMessage.item.text, "ok from mock responses stream");
  assert.ok(responseRequest, "Codex request did not reach the Responses upstream");
  assert.equal(responseRequest.body?.model, "gpt-5.6-luna");
  assert.equal(responseRequest.body?.stream, true);
  assert.equal(responseRequest.headers?.authorization, undefined);
  assert.equal(responseRequest.headers?.["api-key"], "test-upstream-key");
  assert.equal(accessLogs.status, 200, accessLogs.text);
  assert.ok(modelCatalogRequest, "Codex did not request the proxy model catalog");
  assert.doesNotMatch(
    result.stderr,
    /missing field models|OutputTextDelta without active item|stream closed before response\.completed/i
  );

  process.stdout.write(`${JSON.stringify({
    codexVersion: EXPECTED_VERSION,
    agentMessage: agentMessage.item.text,
    modelCatalogParsed: catalogModels.some((model) => model.slug === "gpt-5.6-luna"),
    responsesLifecycleParsed: true,
    upstreamCredentialIsolation: true
  }, null, 2)}\n`);
} finally {
  try {
    await ctx.cleanup();
  } finally {
    if (codexHome) await fs.rm(codexHome, { recursive: true, force: true });
  }
}