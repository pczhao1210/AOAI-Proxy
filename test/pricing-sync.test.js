import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileModelCatalog,
  createModelCatalogSyncTransaction,
  getModelCatalogSnapshot,
  installModelCatalogSnapshot,
  resolveModelDescriptor
} from "../src/model-catalog.js";
import { syncPricingDefinitionsFromGitHub } from "../src/pricing-library.js";

function definition(id, aliases = []) {
  return {
    id,
    aliases,
    displayName: id,
    provider: "azure-openai",
    interfaces: ["responses"],
    capabilities: ["reasoning"]
  };
}

test("remote Model Catalog sync swaps directory and snapshot only after candidate compilation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-pricing-sync-"));
  const pricingDir = path.join(tempDir, "pricing");
  const previousPricingDir = process.env.PRICING_DIR;
  const previousFetch = globalThis.fetch;
  let syncMode = "collision";
  let currentConfig = {
    upstreams: [{ name: "azure", provider: "azure-openai" }],
    models: [{ id: "old-public", pricingRef: "old-model", upstream: "azure" }]
  };

  await fs.mkdir(pricingDir, { recursive: true });
  await fs.writeFile(path.join(pricingDir, "old-model.json"), `${JSON.stringify(definition("old-model"), null, 2)}\n`);
  process.env.PRICING_DIR = pricingDir;

  const oldSnapshot = installModelCatalogSnapshot(compileModelCatalog(currentConfig, [definition("old-model")]));
  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.includes("/contents/")) {
      const names = syncMode === "collision" ? ["first.json", "second.json"] : ["new-model.json"];
      return new Response(JSON.stringify(names.map((name) => ({
        type: "file",
        name,
        download_url: `https://download.test/${name}`
      }))));
    }
    const fileName = urlText.split("/").at(-1);
    const rawDefinition = syncMode === "collision"
      ? definition(fileName === "first.json" ? "first" : "second", ["shared-alias"])
      : definition("new-model");
    return new Response(JSON.stringify(rawDefinition));
  };

  try {
    const transaction = createModelCatalogSyncTransaction(() => currentConfig);
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /alias collision for shared-alias/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assert.equal(getModelCatalogSnapshot(), oldSnapshot);

    syncMode = "success";
    currentConfig = {
      ...currentConfig,
      models: [{ id: "new-public", pricingRef: "new-model", upstream: "azure" }]
    };
    const result = await syncPricingDefinitionsFromGitHub(
      { owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" },
      transaction
    );

    assert.equal(result.syncedFiles, 1);
    assert.deepEqual((await fs.readdir(pricingDir)).sort(), [".pricing-sync-meta", "new-model.json"]);
    assert.equal(resolveModelDescriptor("new-public")?.catalogId, "new-model");
    assert.ok(getModelCatalogSnapshot().generation > oldSnapshot.generation);

    let releaseFirstSync;
    let markFirstSyncStarted;
    let contentsCalls = 0;
    const firstSyncStarted = new Promise((resolve) => {
      markFirstSyncStarted = resolve;
    });
    const firstSyncRelease = new Promise((resolve) => {
      releaseFirstSync = resolve;
    });
    globalThis.fetch = async (url) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.pathname.includes("/contents/")) {
        contentsCalls += 1;
        const ref = parsedUrl.searchParams.get("ref");
        if (ref === "first") {
          markFirstSyncStarted();
          await firstSyncRelease;
        }
        return new Response(JSON.stringify([{
          type: "file",
          name: `${ref}.json`,
          download_url: `https://download.test/${ref}.json`
        }]));
      }
      const id = parsedUrl.pathname.split("/").at(-1).replace(/\.json$/, "");
      return new Response(JSON.stringify(definition(id)));
    };
    currentConfig = { ...currentConfig, models: [] };

    const firstSync = syncPricingDefinitionsFromGitHub(
      { owner: "test", repo: "catalog", path: "pricing", ref: "first" },
      transaction
    );
    await firstSyncStarted;
    const secondSync = syncPricingDefinitionsFromGitHub(
      { owner: "test", repo: "catalog", path: "pricing", ref: "second" },
      transaction
    );
    await new Promise((resolve) => setImmediate(resolve));
    const callsBeforeFirstCommit = contentsCalls;
    releaseFirstSync();
    await Promise.all([firstSync, secondSync]);

    assert.equal(callsBeforeFirstCommit, 1);
    assert.deepEqual((await fs.readdir(pricingDir)).sort(), [".pricing-sync-meta", "second.json"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPricingDir == null) delete process.env.PRICING_DIR;
    else process.env.PRICING_DIR = previousPricingDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});