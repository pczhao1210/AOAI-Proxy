import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTestContext } from "./lib/harness.js";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("server drains cleanly on SIGTERM", async () => {
  const context = await createTestContext();
  try {
    await context.stopProxy();
    assert.equal(await context.waitForExit(), 0);

    const output = context.output.stdout.join("");
    assert.match(output, /"event":"startup\.shutdown_started"/);
    assert.match(output, /"event":"startup\.shutdown_complete"/);
  } finally {
    await context.cleanup();
  }
});

test("server exits nonzero when startup fails before listen", { timeout: 5000 }, async (context) => {
  const output = { stdout: [], stderr: [] };
  const childProcess = spawn(process.execPath, ["src/server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CONFIG_PATH: path.join(os.tmpdir(), `aoai-proxy-missing-${crypto.randomUUID()}.json`),
      LOG_LEVEL: "error"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => {
    if (childProcess.exitCode == null && childProcess.signalCode == null) {
      childProcess.kill("SIGKILL");
    }
  });
  childProcess.stdout.on("data", (chunk) => output.stdout.push(String(chunk)));
  childProcess.stderr.on("data", (chunk) => output.stderr.push(String(chunk)));

  const [exitCode] = await once(childProcess, "exit");
  assert.equal(exitCode, 1);

  const logs = `${output.stdout.join("")}\n${output.stderr.join("")}`;
  assert.match(logs, /"event":"startup\.fatal"/);
  assert.match(logs, /"event":"startup\.shutdown_complete"/);
});