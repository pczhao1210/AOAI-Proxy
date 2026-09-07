import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeLoader } from "../admin-ui/src/runtime-loader.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("runtime loader rejects stale results after a newer filter response", async () => {
  const older = deferred();
  const newer = deferred();
  const loader = createRuntimeLoader({
    initialFilters: { keyId: "key-A", timeRange: "all" },
    fetchRuntime: async () => ({}),
    fetchStats: (filters) => filters.keyId === "key-A" ? older.promise : newer.promise
  });
  const first = loader.start();
  loader.updateFilters({ keyId: "key-B" });
  const second = loader.start();
  let displayed;
  newer.resolve({ keyId: "key-B" });
  const latest = await second.stats;
  if (second.isCurrent()) displayed = latest;
  older.resolve({ keyId: "key-A" });
  const stale = await first.stats;
  if (first.isCurrent()) displayed = stale;
  assert.deepEqual(displayed, { keyId: "key-B" });
  assert.equal(first.isCurrent(), false);
});

test("runtime loader fences initial results that wait for slower secondary data", async () => {
  const loader = createRuntimeLoader({
    initialFilters: { keyId: "", timeRange: "all" },
    fetchRuntime: async () => ({}), fetchStats: async (filters) => filters
  });
  const initial = loader.start();
  await Promise.all([initial.runtime, initial.stats]);
  assert.equal(initial.isCurrent(), true);
  loader.updateFilters({ keyId: "key-B" });
  const refresh = loader.start();
  await refresh.stats;
  assert.equal(initial.isCurrent(), false);
  assert.equal(refresh.isCurrent(), true);
});

test("runtime loader merges rapid filter changes and late refreshes use the latest selection", async () => {
  const requestedFilters = [];
  const loader = createRuntimeLoader({
    initialFilters: { keyId: "", timeRange: "all" },
    fetchRuntime: async () => ({}),
    fetchStats: async (filters) => { requestedFilters.push(filters); return {}; }
  });
  const initial = loader.start();
  const returnedFilters = loader.updateFilters({ keyId: "key-B" });
  returnedFilters.keyId = "must-not-mutate-loader";
  loader.updateFilters({ timeRange: "24h" });
  assert.equal(initial.isCurrent(), false);
  const delayedRefresh = loader.start();
  await delayedRefresh.stats;
  assert.deepEqual(requestedFilters.at(-1), { keyId: "key-B", timeRange: "24h" });
});

test("runtime loader identifies obsolete failures without hiding current failures", async () => {
  const older = deferred();
  const newer = deferred();
  let calls = 0;
  const loader = createRuntimeLoader({
    initialFilters: {}, fetchRuntime: async () => ({}),
    fetchStats: () => ++calls === 1 ? older.promise : newer.promise
  });
  const first = loader.start();
  const second = loader.start();
  older.reject(new Error("old failure"));
  await assert.rejects(first.stats, /old failure/);
  assert.equal(first.isCurrent(), false);
  newer.reject(new Error("current failure"));
  await assert.rejects(second.stats, /current failure/);
  assert.equal(second.isCurrent(), true);
});