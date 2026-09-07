import assert from "node:assert/strict";
import os from "node:os";
import sharp from "sharp";
import { maybeCompressImages } from "../src/proxy/body.js";
import { createImageFixtures } from "./lib/image-fixtures.js";

const fixtures = await createImageFixtures();
const samples = 12;
const rows = [];
const startRssMiB = process.memoryUsage().rss / 1024 ** 2;
for (const [name, mime] of [
  ["photo", "image/jpeg"], ["rotated", "image/jpeg"], ["screenshot", "image/png"],
  ["transparent", "image/png"], ["animated", "image/gif"]
]) {
  for (const mode of ["preserve", "legacy", "adaptive"]) {
    const input = fixtures[name];
    const url = `data:${mime};base64,${input.toString("base64")}`;
    const durations = [];
    let output;
    const cpuBefore = process.cpuUsage();
    for (let sample = 0; sample < samples; sample += 1) {
      const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url, detail: "high" } }] }] };
      const startedAt = performance.now();
      await maybeCompressImages(body, { media: { inputCompression: {
        enabled: true, mode, maxLongSidePx: 320, minBytes: 1, quality: 0.8, minSavingsRatio: 0.1
      } } }, "chat/completions");
      durations.push(performance.now() - startedAt);
      output = Buffer.from(body.messages[0].content[0].image_url.url.split(",")[1], "base64");
    }
    const cpu = process.cpuUsage(cpuBefore);
    durations.sort((left, right) => left - right);
    const preserved = input.equals(output);
    if (mode === "preserve" || (mode === "adaptive" && mime !== "image/jpeg")) assert.ok(preserved);
    rows.push({
      fixture: name === "photo" ? "synthetic-jpeg" : name, mode, samples,
      inputBytes: input.length, outputBytes: output.length, byteIdentical: preserved,
      savingPercent: Number((100 * (input.length - output.length) / input.length).toFixed(2)),
      p50Ms: Number(durations[Math.floor(samples * 0.5)].toFixed(2)),
      p95Ms: Number(durations[Math.ceil(samples * 0.95) - 1].toFixed(2)),
      cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2))
    });
  }
}
console.log(JSON.stringify({
  node: process.version, sharp: sharp.versions.sharp, platform: `${os.platform()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model, settings: { maxLongSidePx: 320, quality: 0.8, minBytes: 1, minSavingsRatio: 0.1 },
  startRssMiB: Number(startRssMiB.toFixed(2)), peakRssMiB: Number((process.resourceUsage().maxRSS / 1024).toFixed(2)),
  limitations: "Sequential synthetic codec baseline, not production capacity or visual/OCR accuracy. RSS includes fixtures, Sharp caches and all modes.",
  results: rows
}, null, 2));