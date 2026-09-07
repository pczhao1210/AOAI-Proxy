import assert from "node:assert/strict";
import test from "node:test";
import { withTestContext } from "./lib/harness.js";

test("image optimization configuration defaults, validation and persistence", async () => {
  await withTestContext(async ctx => {
    const config = await ctx.readConfigFile();
    const save = json => ctx.adminRequest("/admin/api/config", {
      method: "PUT", headers: { "x-aoai-admin-csrf": "1" }, json
    });
    let result = await save(config);
    assert.equal(result.status, 200, result.text);
    const defaults = (await ctx.readConfigFile()).media;
    assert.equal(defaults.inputCompression.mode, "legacy");
    assert.equal(defaults.inputCompression.enabled, false);
    assert.equal(defaults.inlineImages.maxImages, 0);
    assert.equal(defaults.inlineImages.maxTotalBytes, 0);

    config.media = defaults;
    for (const [field, value] of [
      ["mode", "unknown"], ["enabled", "true"], ["minBytes", -1], ["maxPixels", 0],
      ["maxConcurrent", 0], ["maxConcurrent", 33], ["maxQueue", -1], ["timeoutMs", 0],
      ["minSavingsRatio", 1.1], ["quality", "0.8"]
    ]) {
      const invalid = structuredClone(config);
      invalid.media.inputCompression[field] = value;
      result = await save(invalid);
      assert.equal(result.status, 400, `${field}: ${result.text}`);
    }
    for (const field of ["maxImages", "maxTotalBytes"]) {
      const invalid = structuredClone(config);
      invalid.media.inlineImages[field] = -1;
      assert.equal((await save(invalid)).status, 400, field);
    }
    config.media.inputCompression = { ...defaults.inputCompression, enabled: true, mode: "adaptive", maxQueue: 0, minBytes: 0 };
    result = await save(config);
    assert.equal(result.status, 200, result.text);
    const saved = (await ctx.readConfigFile()).media.inputCompression;
    assert.equal(saved.mode, "adaptive");
    assert.equal(saved.maxQueue, 0);
    assert.equal(saved.minBytes, 0);
  });
});