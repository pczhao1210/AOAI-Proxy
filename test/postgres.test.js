import assert from "node:assert/strict";
import test from "node:test";
import { closeSharedPostgresPools, getSharedPostgresPool } from "../src/postgres.js";

test("shared PostgreSQL pools handle idle client errors without exposing credentials", async (context) => {
  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...args) => {
    captured.push(args.map(String).join(" "));
  };
  context.after(async () => {
    console.error = originalConsoleError;
    await closeSharedPostgresPools();
  });

  const pool = getSharedPostgresPool({
    connectionString: "postgresql://test-user:test-password@db.example.test:5432/proxy"
  });
  const error = Object.assign(new Error("read ETIMEDOUT for postgresql://test-user:test-password@db.example.test:5432/proxy using test-password"), {
    code: "ETIMEDOUT",
    syscall: "read"
  });

  assert.ok(pool.listenerCount("error") > 0);
  assert.doesNotThrow(() => pool.emit("error", error));

  const output = captured.join("\n");
  assert.match(output, /"event":"postgres\.pool_error"/);
  assert.match(output, /"errorCode":"ETIMEDOUT"/);
  assert.match(output, /"host":"db\.example\.test"/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /test-password/);
  assert.doesNotMatch(output, /postgresql:\/\//);
});
