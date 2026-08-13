import assert from "node:assert/strict";
import path from "node:path";
import { createTestContext } from "../lib/harness.js";
import { runProcess } from "./run-process.js";

const EXPECTED_VERSION = process.env.CLAUDE_CODE_EXPECTED_VERSION || "2.1.226";
const PROCESS_TIMEOUT_MS = 60000;

const packageSpec = `@anthropic-ai/claude-code@${EXPECTED_VERSION}`;
const versionResult = await runProcess("npx", ["--yes", packageSpec, "--version"], {
  timeoutMs: PROCESS_TIMEOUT_MS
});
assert.equal(versionResult.code, 0, versionResult.stderr);
assert.match(versionResult.stdout, new RegExp(`^${EXPECTED_VERSION.replaceAll(".", "\\.")}\\b`));

const ctx = await createTestContext();
try {
  const result = await runProcess("npx", [
    "--yes", packageSpec,
    "-p", "Respond with one short sentence. Do not use tools.",
    "--output-format", "json",
    "--model", "claude-native",
    "--tools", "",
    "--max-turns", "1",
    "--no-session-persistence",
    "--bare"
  ], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: ctx.baseUrl,
      ANTHROPIC_AUTH_TOKEN: "test-client-key",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: path.join(ctx.tempDir, "claude-config"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1"
    }
  });

  const output = JSON.parse(result.stdout.trim());
  const messagesRequest = ctx.getUpstreamRequest((item) => item.url.includes("/anthropic/v1/messages"));

  assert.equal(result.code, 0, result.stderr || `Claude Code exited with signal ${result.signal}`);
  assert.equal(output.subtype, "success", result.stdout);
  assert.equal(output.result, "ok from mock messages stream");
  assert.ok(messagesRequest, "Claude Code request did not reach the native Messages upstream");
  assert.equal(messagesRequest.body?.model, "claude-native-deployment");
  assert.equal(messagesRequest.body?.stream, true);
  assert.equal(messagesRequest.headers?.authorization, undefined);
  assert.equal(messagesRequest.headers?.["x-api-key"], "test-upstream-key");

  const betas = String(messagesRequest.headers?.["anthropic-beta"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  assert.ok(betas.includes("effort-2025-11-24"), "Claude Code effort beta was not preserved");
  assert.ok(betas.includes("thinking-token-count-2026-05-13"), "Unknown Claude Code beta was not preserved");
  const metadataHeaders = Object.keys(messagesRequest.headers || {})
    .filter((headerName) => headerName.startsWith("x-stainless-") || headerName.startsWith("x-claude-"));
  assert.ok(metadataHeaders.length > 0, "Claude Code SDK metadata headers were not preserved");

  process.stdout.write(`${JSON.stringify({
    claudeCodeVersion: EXPECTED_VERSION,
    result: output.result,
    nativeMessagesLifecycleParsed: true,
    betaForwardCompatibility: true,
    metadataHeadersPreserved: metadataHeaders,
    upstreamCredentialIsolation: true
  }, null, 2)}\n`);
} finally {
  await ctx.cleanup();
}