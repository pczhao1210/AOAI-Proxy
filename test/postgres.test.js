import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { closeSharedPostgresPools, getSharedPostgresPool, withPooledClient } from "../src/postgres.js";

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

test("checked-out PostgreSQL clients absorb backend termination and are discarded", async () => {
  const released = [];
  const checkout = () => Object.assign(new EventEmitter(), { release: error => released.push(error) });
  let client;
  const pool = { connect: async () => (client = checkout()) };
  const terminated = new Error("Connection terminated unexpectedly");

  const result = await withPooledClient(pool, async active => {
    await new Promise(resolve => setImmediate(() => { active.emit("error", terminated); resolve(); }));
    return "settled";
  });
  assert.equal(result, "settled");
  assert.deepEqual(released, [terminated]);
  assert.doesNotThrow(() => client.emit("error", new Error("late socket close")), "a discarded client stays guarded while it closes");

  assert.equal(await withPooledClient(pool, async () => "clean"), "clean");
  assert.equal(released[1], undefined);
  assert.equal(client.listenerCount("error"), 0, "a healthy client returns to the pool without the checkout listener");

  const failure = new Error("logical failure");
  await assert.rejects(withPooledClient(pool, async () => { throw failure; }), failure);
  await assert.rejects(withPooledClient(pool, async () => { throw failure; }, { discard: () => false }), failure);
  assert.deepEqual(released.slice(2), [failure, undefined]);
});
