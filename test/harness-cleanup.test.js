import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { createTestContext } from "./lib/harness.js";

test("test context cleans partial setup after proxy startup failure", async () => {
  const tempPrefix = `aoai-proxy-failed-setup-${process.pid}-`;

  await assert.rejects(
    createTestContext({
      proxyArgs: ["-e", "process.exit(23)"],
      startupTimeoutMs: 1000,
      tempPrefix
    }),
    /Proxy process exited early with code 23/
  );

  const leftovers = (await fs.readdir(os.tmpdir()))
    .filter((entry) => entry.startsWith(tempPrefix));
  assert.deepEqual(leftovers, []);
});