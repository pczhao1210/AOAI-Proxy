import assert from "node:assert/strict";
import test from "node:test";
import { resolveRestartTargetPid } from "../src/restart.js";
import { createTestContext } from "./lib/harness.js";

test("restart target is limited to the container or PID 1", () => {
  assert.equal(resolveRestartTargetPid(true, 123), 1);
  assert.equal(resolveRestartTargetPid(false, 1), 1);
  assert.equal(resolveRestartTargetPid(false, 123), null);
  assert.equal(resolveRestartTargetPid(false, 123, { supervisorPid: "7", parentPid: 7 }), 7);
  assert.equal(resolveRestartTargetPid(false, 123, { supervisorPid: "7", parentPid: 8 }), null);
});

for (const scenario of [
  { name: "container", container: "1", pid: "123", status: 200 },
  { name: "PID 1", container: "0", pid: "1", status: 200 },
  { name: "containerd supervisor without /.dockerenv", container: "0", pid: "123", ppid: "1", supervisor: "1", status: 200 },
  { name: "process manager", container: "0", pid: "123", ppid: "9", supervisor: "1", status: 501 }
]) {
  test(`restart route handles ${scenario.name} without signalling the test host`, async () => {
    const previousContainer = process.env.TEST_RESTART_CONTAINER;
    const previousPid = process.env.TEST_RESTART_PID;
    const previousPpid = process.env.TEST_RESTART_PPID;
    const previousSupervisor = process.env.AOAI_PROXY_SUPERVISOR_PID;
    process.env.TEST_RESTART_CONTAINER = scenario.container;
    process.env.TEST_RESTART_PID = scenario.pid;
    process.env.TEST_RESTART_PPID = scenario.ppid || "";
    if (scenario.supervisor) process.env.AOAI_PROXY_SUPERVISOR_PID = scenario.supervisor;
    else delete process.env.AOAI_PROXY_SUPERVISOR_PID;
    let context;
    try {
      context = await createTestContext({ proxyArgs: ["--import", "./test/lib/mock-restart-environment.js", "src/server.js"] });
    } finally {
      if (previousContainer === undefined) delete process.env.TEST_RESTART_CONTAINER;
      else process.env.TEST_RESTART_CONTAINER = previousContainer;
      if (previousPid === undefined) delete process.env.TEST_RESTART_PID;
      else process.env.TEST_RESTART_PID = previousPid;
      if (previousPpid === undefined) delete process.env.TEST_RESTART_PPID;
      else process.env.TEST_RESTART_PPID = previousPpid;
      if (previousSupervisor === undefined) delete process.env.AOAI_PROXY_SUPERVISOR_PID;
      else process.env.AOAI_PROXY_SUPERVISOR_PID = previousSupervisor;
    }
    try {
      const response = await context.adminRequest("/admin/api/restart", {
        method: "POST",
        headers: { "x-aoai-admin-csrf": "1" }
      });
      assert.equal(response.status, scenario.status, response.text);
      if (scenario.status === 200) {
        const deadline = Date.now() + 3000;
        while (!context.output.stdout.join("").includes("TEST_RESTART_SIGNAL") && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.match(context.output.stdout.join(""), /TEST_RESTART_SIGNAL 1 SIGTERM/);
      } else {
        assert.equal(response.json.error, "RESTART_UNSUPPORTED");
        assert.doesNotMatch(context.output.stdout.join(""), /TEST_RESTART_SIGNAL/);
      }
    } finally {
      await context.cleanup();
    }
  });
}
