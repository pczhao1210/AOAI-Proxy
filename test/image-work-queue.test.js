import assert from "node:assert/strict";
import test from "node:test";
import { createImageWorkQueue } from "../src/proxy/image-work-queue.js";

test("image queue retains active slots after cancellation until the codec settles", async () => {
  const queue = createImageWorkQueue();
  let finish;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const controller = new AbortController();
  const running = queue.run(() => new Promise(resolve => { finish = resolve; signalStarted(); }), {
    signal: controller.signal, maxConcurrent: 1, maxQueue: 0
  });
  await started;
  const cancelled = assert.rejects(running, /cancelled/);
  controller.abort(new Error("cancelled"));
  await cancelled;
  await assert.rejects(queue.run(() => {}, { maxConcurrent: 1, maxQueue: 0 }), { code: "IMAGE_QUEUE_FULL" });
  const next = queue.run(() => "next", { maxConcurrent: 1, maxQueue: 1 });
  finish();
  assert.equal(await next, "next");
});

test("image queue removes aborted pending work without running it", async () => {
  const queue = createImageWorkQueue();
  let finish;
  const running = queue.run(() => new Promise(resolve => { finish = resolve; }), { maxConcurrent: 1 });
  await Promise.resolve();
  let called = false;
  const controller = new AbortController();
  const pending = queue.run(() => { called = true; }, { maxConcurrent: 1, maxQueue: 1, signal: controller.signal });
  const cancelled = assert.rejects(pending, /cancelled/);
  controller.abort(new Error("cancelled"));
  await cancelled;
  const next = queue.run(() => "next", { maxConcurrent: 1, maxQueue: 1 });
  finish();
  await running;
  assert.equal(await next, "next");
  assert.equal(called, false);
});

test("image queue capacity remains bounded while concurrency settings change", async () => {
  const queue = createImageWorkQueue();
  let finish;
  const running = queue.run(() => new Promise(resolve => { finish = resolve; }), { maxConcurrent: 1 });
  await Promise.resolve();
  const pending = queue.run(() => "pending", { maxConcurrent: 1, maxQueue: 1 });
  const controller = new AbortController();
  const overflow = queue.run(() => "overflow", { maxConcurrent: 2, maxQueue: 1, signal: controller.signal });
  const rejected = assert.rejects(overflow, { code: "IMAGE_QUEUE_FULL" });
  controller.abort(Object.assign(new Error("Queue limit was bypassed"), { code: "TEST_ABORT" }));
  finish();
  await running;
  assert.equal(await pending, "pending");
  await rejected;
});