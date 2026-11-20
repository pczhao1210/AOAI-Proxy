import fs from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";

const target = process.env.RUNTIME_BENCHMARK_PROBE;
if (!target) throw new Error("RUNTIME_BENCHMARK_PROBE is required");
const monitor = monitorEventLoopDelay({ resolution: 10 });
let resetAt = null;
monitor.enable();
process.on("SIGUSR2", () => {
  monitor.reset();
  resetAt = new Date().toISOString();
});
process.once("exit", () => {
  monitor.disable();
  fs.writeFileSync(target, JSON.stringify({
    resetAt,
    p95Ms: monitor.percentile(95) / 1e6,
    p99Ms: monitor.percentile(99) / 1e6,
    maxMs: monitor.max / 1e6
  }));
});
