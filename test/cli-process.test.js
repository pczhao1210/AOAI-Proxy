import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./cli/run-process.js";

function isProcessGroupRunning(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId) {
  const deadline = Date.now() + 1000;
  while (isProcessGroupRunning(processGroupId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isProcessGroupRunning(processGroupId);
}

test("CLI timeout escalates for descendants that ignore SIGTERM", {
  skip: process.platform === "win32"
}, async () => {
  const descendantScript = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const script = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
      stdio: "ignore"
    });
    setInterval(() => {}, 1000);
  `;
  const startedAt = Date.now();
  let timeoutError;

  try {
    await runProcess(process.execPath, ["-e", script], {
      timeoutMs: 100,
      killGraceMs: 100
    });
    assert.fail("expected CLI process to time out");
  } catch (error) {
    timeoutError = error;
  }

  assert.match(timeoutError?.message || "", /timed out after 100ms/);
  const processGroupId = timeoutError?.processGroupId;
  assert.ok(Number.isInteger(processGroupId) && processGroupId > 0, "expected process group ID");
  try {
    assert.equal(await waitForProcessGroupExit(processGroupId), true, "SIGKILL did not terminate the process group");
  } finally {
    if (isProcessGroupRunning(processGroupId)) process.kill(-processGroupId, "SIGKILL");
  }
  assert.ok(Date.now() - startedAt < 2000, "process group did not terminate promptly");
});