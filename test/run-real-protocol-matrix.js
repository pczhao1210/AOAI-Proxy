import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const PROTOCOLS = ["chat/completions", "responses", "messages"];
const SCENARIOS = ["basic", "stream", "tool", "reasoning"];
const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 300000;
const TOOL_NAME = "matrix_lookup_weather";

const MODEL_PROFILES = [
  {
    key: "claude-sonnet-5",
    env: "AOAI_PROXY_MATRIX_CLAUDE_SONNET_5",
    defaultModel: "claude-sonnet-5",
    capabilities: ["reasoning", "tools"],
    reasoningSources: PROTOCOLS,
    targetFor: () => "messages"
  },
  {
    key: "claude-sonnet-4.6",
    env: "AOAI_PROXY_MATRIX_CLAUDE_SONNET_46",
    defaultModel: "claude-sonnet-4-6",
    capabilities: ["reasoning", "tools"],
    reasoningSources: PROTOCOLS,
    targetFor: () => "messages"
  },
  {
    key: "gpt-5.6-terra",
    env: "AOAI_PROXY_MATRIX_GPT_56_TERRA",
    defaultModel: "gpt-5.6-terra",
    capabilities: ["reasoning", "tools"],
    reasoningSources: PROTOCOLS,
    requiredRoutes: { "chat/completions": "responses" },
    targetFor: () => "responses"
  },
  {
    key: "gpt-5.4",
    env: "AOAI_PROXY_MATRIX_GPT_54",
    defaultModel: "gpt-5.4",
    capabilities: ["reasoning", "tools"],
    reasoningSources: PROTOCOLS,
    targetFor: (source) => source === "chat/completions" ? "chat/completions" : "responses"
  },
  {
    key: "deepseek-v4",
    env: "AOAI_PROXY_MATRIX_DEEPSEEK_V4",
    defaultModel: "DeepSeek-V4-Pro",
    capabilities: ["reasoning"],
    reasoningSources: PROTOCOLS,
    targetFor: () => "chat/completions"
  },
  {
    key: "kimi-k2.6",
    env: "AOAI_PROXY_MATRIX_KIMI_K26",
    defaultModel: "Kimi-K2.6",
    capabilities: ["tools"],
    reasoningSources: [],
    targetFor: () => "chat/completions"
  },
  {
    key: "grok-4.6",
    env: "AOAI_PROXY_MATRIX_GROK_46",
    defaultModel: "grok-4.6",
    capabilities: ["reasoning", "tools"],
    reasoningSources: ["chat/completions"],
    targetFor: (source) => source === "chat/completions" ? "chat/completions" : "responses"
  }
];

const DEFAULT_PREFERRED_MODELS = {
  "chat/completions->chat/completions": "gpt-5.4",
  "chat/completions->responses": "gpt-5.6-terra",
  "chat/completions->messages": "claude-sonnet-5",
  "responses->chat/completions": "deepseek-v4",
  "responses->responses": "grok-4.6",
  "responses->messages": "claude-sonnet-4.6",
  "messages->chat/completions": "kimi-k2.6",
  "messages->responses": "gpt-5.4",
  "messages->messages": "claude-sonnet-5"
};

const TOOL_PREFERRED_MODELS = {
  ...DEFAULT_PREFERRED_MODELS,
  "responses->chat/completions": "kimi-k2.6"
};

const REASONING_PREFERRED_MODELS = {
  ...DEFAULT_PREFERRED_MODELS,
  "chat/completions->chat/completions": "grok-4.6",
  "responses->responses": "gpt-5.4",
  "messages->chat/completions": "deepseek-v4",
  "messages->responses": "gpt-5.6-terra"
};

const PREFERRED_MODELS = {
  basic: DEFAULT_PREFERRED_MODELS,
  stream: DEFAULT_PREFERRED_MODELS,
  tool: TOOL_PREFERRED_MODELS,
  reasoning: REASONING_PREFERRED_MODELS
};

const PROTOCOL_ALIASES = new Map([
  ["chat", "chat/completions"],
  ["chat/completions", "chat/completions"],
  ["response", "responses"],
  ["responses", "responses"],
  ["message", "messages"],
  ["messages", "messages"]
]);

function resolveModel(profile) {
  return process.env[profile.env]?.trim() || profile.defaultModel;
}

function buildPlan() {
  return MODEL_PROFILES.flatMap((profile) => PROTOCOLS.map((source) => ({
    profile,
    model: resolveModel(profile),
    source,
    target: profile.targetFor(source)
  })));
}

function directionKey(source, target) {
  return `${source}->${target}`;
}

function assertMatrixCoverage(plan) {
  const covered = new Set(plan.map(({ source, target }) => `${source}->${target}`));
  const missing = PROTOCOLS.flatMap((source) => PROTOCOLS.map((target) => `${source}->${target}`))
    .filter((direction) => !covered.has(direction));
  assert.deepEqual(missing, [], `Missing protocol-matrix directions: ${missing.join(", ")}`);
}

function printPlan(plan) {
  process.stdout.write("Real protocol matrix plan\n");
  for (const source of PROTOCOLS) {
    for (const target of PROTOCOLS) {
      const models = plan
        .filter((entry) => entry.source === source && entry.target === target)
        .map((entry) => entry.model);
      process.stdout.write(`${source.padEnd(16)} -> ${target.padEnd(16)} ${models.join(", ")}\n`);
    }
  }
}

function printHelp() {
  process.stdout.write(`Usage: node test/run-real-protocol-matrix.js [options]

Options:
  --list                    Print the offline model-to-protocol plan
  --preflight               Check health, model visibility, and configured routes only
  --scenario=<names>        Comma-separated: basic,stream,tool,reasoning (default: all)
  --source=<protocol>       Filter source protocol: chat,responses,messages
  --target=<protocol>       Filter expected backend protocol
  --model=<key-or-id>       Run all eligible source protocols for one model
  --no-log-check            Do not verify backendRouteKey through admin logs
  --fail-fast               Stop on the first failed request
  --help                    Show this help

Required environment:
  AOAI_PROXY_MATRIX_API_KEY       Proxy API key (falls back to AOAI_PROXY_REAL_API_KEY)
  AOAI_PROXY_MATRIX_ADMIN_PASSWORD  Admin password for backend route verification

Optional model overrides:
${MODEL_PROFILES.map((profile) => `  ${profile.env}=${profile.defaultModel}`).join("\n")}
`);
}

function parseProtocol(value, optionName) {
  const normalized = PROTOCOL_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) {
    throw new Error(`${optionName} must be chat, responses, or messages`);
  }
  return normalized;
}

function parseScenarios(value) {
  const requested = String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!requested.length || requested.includes("all")) return [...SCENARIOS];
  const invalid = requested.filter((item) => !SCENARIOS.includes(item));
  if (invalid.length) {
    throw new Error(`Unknown scenario: ${invalid.join(", ")}`);
  }
  return [...new Set(requested)];
}

function parseArgs(argv) {
  const options = {
    mode: "run",
    scenarios: [...SCENARIOS],
    source: "",
    target: "",
    model: "",
    verifyLogs: true,
    failFast: false
  };

  for (const arg of argv) {
    if (arg === "--list") options.mode = "list";
    else if (arg === "--preflight") options.mode = "preflight";
    else if (arg === "--help" || arg === "-h") options.mode = "help";
    else if (arg === "--no-log-check") options.verifyLogs = false;
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg.startsWith("--scenario=")) options.scenarios = parseScenarios(arg.slice("--scenario=".length));
    else if (arg.startsWith("--scenarios=")) options.scenarios = parseScenarios(arg.slice("--scenarios=".length));
    else if (arg.startsWith("--source=")) options.source = parseProtocol(arg.slice("--source=".length), "--source");
    else if (arg.startsWith("--target=")) options.target = parseProtocol(arg.slice("--target=".length), "--target");
    else if (arg.startsWith("--model=")) options.model = arg.slice("--model=".length).trim();
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(optionalEnv(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function buildRuntimeConfig(options) {
  const apiKey = optionalEnv("AOAI_PROXY_MATRIX_API_KEY", "AOAI_PROXY_REAL_API_KEY");
  if (!apiKey) {
    throw new Error("Set AOAI_PROXY_MATRIX_API_KEY or AOAI_PROXY_REAL_API_KEY");
  }
  const adminPassword = optionalEnv("AOAI_PROXY_MATRIX_ADMIN_PASSWORD", "AOAI_PROXY_ADMIN_PASSWORD");
  if (options.mode === "run" && options.verifyLogs && !adminPassword) {
    throw new Error("Set AOAI_PROXY_MATRIX_ADMIN_PASSWORD for backend route verification, or pass --no-log-check");
  }
  return {
    baseUrl: (optionalEnv("AOAI_PROXY_MATRIX_BASE_URL", "AOAI_PROXY_REAL_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    adminUsername: optionalEnv("AOAI_PROXY_MATRIX_ADMIN_USERNAME", "AOAI_PROXY_ADMIN_USERNAME") || "admin",
    adminPassword,
    timeoutMs: positiveIntegerEnv("AOAI_PROXY_MATRIX_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    verifyLogs: options.verifyLogs
  };
}

function createProxyHeaders(config, requestId, source, stream) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    "x-request-id": requestId,
    ...(source === "messages" ? { "anthropic-version": "2023-06-01" } : {})
  };
}

function createAdminHeaders(config) {
  if (!config.adminPassword) return {};
  const token = Buffer.from(`${config.adminUsername}:${config.adminPassword}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

async function fetchWithTimeout(config, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { text, json };
}

function truncate(value, maxLength = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function requestJson(config, path, headers = {}) {
  const response = await fetchWithTimeout(config, `${config.baseUrl}${path}`, { headers });
  const body = await readResponse(response);
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${truncate(body.text)}`);
  }
  return body.json;
}

function findProfile(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MODEL_PROFILES.find((profile) => (
    profile.key.toLowerCase() === normalized
    || resolveModel(profile).toLowerCase() === normalized
    || profile.defaultModel.toLowerCase() === normalized
  ));
}

function scenarioSupports(profile, scenario, source) {
  if (scenario === "tool") return profile.capabilities.includes("tools");
  if (scenario === "reasoning") return profile.reasoningSources.includes(source);
  return true;
}

function selectMatrixCases(plan, options) {
  if (options.model) {
    const profile = findProfile(options.model);
    if (!profile) throw new Error(`Unknown matrix model key or configured ID: ${options.model}`);
    return options.scenarios.flatMap((scenario) => plan
      .filter((entry) => entry.profile === profile)
      .filter((entry) => !options.source || entry.source === options.source)
      .filter((entry) => !options.target || entry.target === options.target)
      .filter((entry) => scenarioSupports(entry.profile, scenario, entry.source))
      .map((entry) => ({ ...entry, scenario })));
  }

  const cases = [];
  for (const scenario of options.scenarios) {
    for (const source of PROTOCOLS) {
      if (options.source && source !== options.source) continue;
      for (const target of PROTOCOLS) {
        if (options.target && target !== options.target) continue;
        const candidates = plan
          .filter((entry) => entry.source === source && entry.target === target)
          .filter((entry) => scenarioSupports(entry.profile, scenario, source));
        const preferredKey = PREFERRED_MODELS[scenario][directionKey(source, target)];
        const selected = candidates.find((entry) => entry.profile.key === preferredKey) || candidates[0];
        assert.ok(selected, `No ${scenario} model covers ${directionKey(source, target)}`);
        cases.push({ ...selected, scenario });
      }
    }
  }
  return cases;
}

function getVisibleModelIds(payload) {
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  return new Set(entries.map((entry) => String(entry?.id || entry?.name || "").trim()).filter(Boolean));
}

async function fetchAdminConfig(config) {
  if (!config.adminPassword) return null;
  return requestJson(config, "/admin/api/config", createAdminHeaders(config));
}

function assertRequiredRoutes(adminConfig) {
  if (!adminConfig) return;
  for (const profile of MODEL_PROFILES) {
    const modelId = resolveModel(profile);
    const model = adminConfig.models?.find((entry) => entry?.id === modelId);
    assert.ok(model, `Admin config does not contain model ${modelId}`);
    for (const [source, target] of Object.entries(profile.requiredRoutes || {})) {
      const configuredTarget = model.routes?.[source] ?? model.routes?.["*"];
      assert.equal(
        configuredTarget,
        target,
        `${modelId} must configure models[].routes[${JSON.stringify(source)}]=${JSON.stringify(target)}`
      );
    }
  }
}

async function runPreflight(config) {
  const health = await requestJson(config, "/healthz");
  assert.equal(health?.status, "ok", "Proxy health check did not return status=ok");
  const modelsPayload = await requestJson(config, "/v1/models", {
    authorization: `Bearer ${config.apiKey}`
  });
  const visibleModels = getVisibleModelIds(modelsPayload);
  const missing = MODEL_PROFILES
    .map((profile) => ({ profile, model: resolveModel(profile) }))
    .filter(({ model }) => !visibleModels.has(model));
  if (missing.length) {
    const details = missing.map(({ profile, model }) => `${model} (override with ${profile.env})`).join(", ");
    throw new Error(`Models not visible to the matrix API key: ${details}`);
  }
  const adminConfig = await fetchAdminConfig(config);
  assertRequiredRoutes(adminConfig);
  process.stdout.write(`PASS preflight baseUrl=${config.baseUrl} models=${MODEL_PROFILES.length} adminConfig=${adminConfig ? "checked" : "skipped"}\n`);
}

function promptFor(testCase) {
  const direction = directionKey(testCase.source, testCase.target);
  if (testCase.scenario === "tool") {
    return `Call ${TOOL_NAME} exactly once with city set to Seattle. Do not answer without calling the tool. Matrix direction: ${direction}.`;
  }
  if (testCase.scenario === "reasoning") {
    return `Reason briefly, then reply with MATRIX_REASONING_OK. Matrix direction: ${direction}.`;
  }
  if (testCase.scenario === "stream") {
    return `Reply with MATRIX_STREAM_OK and nothing else. Matrix direction: ${direction}.`;
  }
  return `Reply with MATRIX_BASIC_OK and nothing else. Matrix direction: ${direction}.`;
}

function addTool(payload, source) {
  const description = "Look up the weather for one city";
  const parameters = {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false
  };
  if (source === "chat/completions") {
    payload.tools = [{ type: "function", function: { name: TOOL_NAME, description, parameters } }];
    payload.tool_choice = "required";
  } else if (source === "responses") {
    payload.tools = [{ type: "function", name: TOOL_NAME, description, parameters }];
    payload.tool_choice = "required";
  } else {
    payload.tools = [{ name: TOOL_NAME, description, input_schema: parameters }];
    payload.tool_choice = { type: "any" };
  }
}

function addReasoning(payload, testCase) {
  const level = "low";
  if (testCase.source === "chat/completions") {
    payload.reasoning_effort = level;
  } else if (testCase.source === "responses") {
    payload.reasoning = { effort: level };
  } else {
    payload.output_config = { effort: level };
    if (testCase.target === "messages") payload.thinking = { type: "adaptive" };
  }
}

function buildPayload(testCase) {
  const prompt = promptFor(testCase);
  let payload;
  if (testCase.source === "chat/completions") {
    payload = {
      model: testCase.model,
      messages: [
        { role: "system", content: "Follow the user's matrix-test instruction exactly." },
        { role: "user", content: prompt }
      ]
    };
  } else if (testCase.source === "responses") {
    payload = {
      model: testCase.model,
      instructions: "Follow the user's matrix-test instruction exactly.",
      input: prompt,
      max_output_tokens: 256
    };
  } else {
    payload = {
      model: testCase.model,
      system: "Follow the user's matrix-test instruction exactly.",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 256
    };
  }
  if (testCase.scenario === "stream") payload.stream = true;
  if (testCase.scenario === "tool") addTool(payload, testCase.source);
  if (testCase.scenario === "reasoning") addReasoning(payload, testCase);
  return payload;
}

function extractJsonText(source, payload) {
  if (source === "chat/completions") {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((part) => part?.text || "").join("").trim();
    return "";
  }
  if (source === "responses") {
    if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
    return (payload?.output || []).flatMap((item) => item?.content || [])
      .map((part) => part?.text || part?.output_text || "")
      .join("")
      .trim();
  }
  return (payload?.content || []).map((part) => part?.type === "text" ? part.text || "" : "").join("").trim();
}

function extractToolNames(source, payload) {
  if (source === "chat/completions") {
    return (payload?.choices?.[0]?.message?.tool_calls || []).map((call) => call?.function?.name).filter(Boolean);
  }
  if (source === "responses") {
    return (payload?.output || []).filter((item) => item?.type === "function_call").map((item) => item?.name).filter(Boolean);
  }
  return (payload?.content || []).filter((item) => item?.type === "tool_use").map((item) => item?.name).filter(Boolean);
}

function assertJsonEnvelope(testCase, payload) {
  assert.ok(payload && typeof payload === "object", "Expected a JSON response object");
  if (testCase.source === "chat/completions") {
    assert.ok(Array.isArray(payload.choices), "Expected Chat choices[]");
  } else if (testCase.source === "responses") {
    assert.equal(payload.object, "response", "Expected Responses object=response");
    assert.ok(Array.isArray(payload.output), "Expected Responses output[]");
  } else {
    assert.equal(payload.type, "message", "Expected Messages type=message");
    assert.ok(Array.isArray(payload.content), "Expected Messages content[]");
  }
}

function assertJsonResult(testCase, payload) {
  assertJsonEnvelope(testCase, payload);
  if (testCase.scenario === "tool") {
    const toolNames = extractToolNames(testCase.source, payload);
    assert.ok(toolNames.includes(TOOL_NAME), `Expected ${TOOL_NAME}; received tools: ${toolNames.join(", ") || "none"}`);
    return;
  }
  const text = extractJsonText(testCase.source, payload);
  assert.ok(text, `Expected text output for ${testCase.scenario}`);
}

function parseSse(text) {
  const frames = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/\n\n+/)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data && !event) continue;
    let json = null;
    if (data && data !== "[DONE]") {
      try {
        json = JSON.parse(data);
      } catch {
        json = null;
      }
    }
    frames.push({ event, data, json });
  }
  return frames;
}

function extractStreamText(source, frames) {
  if (source === "chat/completions") {
    return frames.map(({ json }) => {
      const content = json?.choices?.[0]?.delta?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
      return "";
    }).join("");
  }
  if (source === "responses") {
    return frames.map(({ json }) => json?.type === "response.output_text.delta" ? json.delta || "" : "").join("");
  }
  return frames.map(({ json }) => (
    json?.type === "content_block_delta" && json?.delta?.type === "text_delta" ? json.delta.text || "" : ""
  )).join("");
}

function assertStreamResult(testCase, contentType, text) {
  assert.match(contentType, /^text\/event-stream/i, "Expected text/event-stream response");
  const frames = parseSse(text);
  assert.ok(frames.length > 0, "Expected at least one SSE frame");
  const streamError = frames.find(({ event, json }) => event === "error" || json?.type === "error" || json?.error);
  assert.equal(streamError, undefined, `Stream contained an error event: ${truncate(streamError?.data)}`);
  if (testCase.source === "chat/completions") {
    const done = frames.some(({ data }) => data === "[DONE]");
    const finished = frames.some(({ json }) => json?.choices?.some((choice) => choice?.finish_reason));
    assert.ok(done || finished, "Chat stream is missing terminal evidence");
  } else if (testCase.source === "responses") {
    assert.ok(
      frames.some(({ json }) => json?.type === "response.completed" || json?.type === "response.incomplete"),
      "Responses stream is missing response.completed/response.incomplete"
    );
  } else {
    assert.ok(frames.some(({ event, json }) => event === "message_stop" || json?.type === "message_stop"), "Messages stream is missing message_stop");
    assert.ok(!frames.some(({ data }) => data === "[DONE]"), "Messages stream must not contain [DONE]");
  }
  assert.ok(extractStreamText(testCase.source, frames).trim(), "Expected streamed text output");
}

function readLogField(entry, name) {
  return entry?.[name] ?? entry?.fields?.[name];
}

async function verifyBackendRoute(config, testCase, requestId) {
  if (!config.verifyLogs) return false;
  const query = new URLSearchParams({ requestId, event: "proxy.request_started", limit: "10" });
  const payload = await requestJson(config, `/admin/api/logs?${query}`, createAdminHeaders(config));
  const entry = payload?.items?.find((item) => item?.event === "proxy.request_started");
  assert.ok(entry, `proxy.request_started log not found for ${requestId}`);
  assert.equal(readLogField(entry, "routeKey"), testCase.source, "Logged source route does not match the matrix cell");
  assert.equal(readLogField(entry, "backendRouteKey"), testCase.target, "Logged backend route does not match the matrix cell");
  assert.equal(readLogField(entry, "modelId"), testCase.model, "Logged model does not match the matrix case");
  return true;
}

async function runCase(config, testCase, index, total) {
  const requestId = `matrix-${Date.now()}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`;
  const payload = buildPayload(testCase);
  const routePath = `/v1/${testCase.source}`;
  const startedAt = performance.now();
  const response = await fetchWithTimeout(config, `${config.baseUrl}${routePath}`, {
    method: "POST",
    headers: createProxyHeaders(config, requestId, testCase.source, testCase.scenario === "stream"),
    body: JSON.stringify(payload)
  });
  const responseBody = await readResponse(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${truncate(responseBody.text)}`);
  }
  if (testCase.scenario === "stream") {
    assertStreamResult(testCase, response.headers.get("content-type") || "", responseBody.text);
  } else {
    assertJsonResult(testCase, responseBody.json);
  }
  const backendVerified = await verifyBackendRoute(config, testCase, requestId);
  const durationMs = Math.round(performance.now() - startedAt);
  const routeType = testCase.source === testCase.target ? "native" : "shim";
  process.stdout.write(
    `PASS ${String(index + 1).padStart(String(total).length)}/${total} ${testCase.scenario.padEnd(9)} ${directionKey(testCase.source, testCase.target).padEnd(31)} ${routeType.padEnd(6)} model=${testCase.model} ${durationMs}ms${backendVerified ? " backend=verified" : ""}\n`
  );
  return { ...testCase, requestId, durationMs, backendVerified, ok: true };
}

function formatFailure(testCase, error) {
  return `${testCase.scenario} ${directionKey(testCase.source, testCase.target)} model=${testCase.model}: ${truncate(error?.message || error)}`;
}

async function runMatrix(config, cases, options) {
  assert.ok(cases.length > 0, "No matrix cases matched the requested filters");
  process.stdout.write(`Running ${cases.length} real protocol matrix requests sequentially against ${config.baseUrl}\n`);
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    try {
      results.push(await runCase(config, testCase, index, cases.length));
    } catch (error) {
      const message = formatFailure(testCase, error);
      results.push({ ...testCase, ok: false, error: message });
      process.stderr.write(`FAIL ${String(index + 1).padStart(String(cases.length).length)}/${cases.length} ${message}\n`);
      if (options.failFast) break;
    }
  }
  const failures = results.filter((result) => !result.ok);
  const nativeCount = results.filter((result) => result.ok && result.source === result.target).length;
  const shimCount = results.filter((result) => result.ok && result.source !== result.target).length;
  process.stdout.write(`Summary: passed=${results.length - failures.length} failed=${failures.length} native=${nativeCount} shim=${shimCount}\n`);
  if (failures.length) {
    throw new Error(`${failures.length} matrix case(s) failed\n${failures.map((failure) => `- ${failure.error}`).join("\n")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = buildPlan();
  assertMatrixCoverage(plan);
  if (options.mode === "help") {
    printHelp();
    return;
  }
  if (options.mode === "list") {
    printPlan(plan);
    return;
  }
  const config = buildRuntimeConfig(options);
  await runPreflight(config);
  if (options.mode === "preflight") return;
  const cases = selectMatrixCases(plan, options);
  await runMatrix(config, cases, options);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});