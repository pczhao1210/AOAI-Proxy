import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileModelCatalog,
  createModelCatalogSyncTransaction,
  getModelCatalogRuntimeInfo,
  installModelCatalogSnapshot,
  resolveModelDescriptor
} from "../src/model-catalog.js";
import { getConfiguredModelBindingIssues } from "../src/model-validation.js";
import {
  findPricingDefinitionForModel,
  syncPricingDefinitionsFromGitHub
} from "../src/pricing-library.js";

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
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        responses: "/openai/v1/responses"
      }
    }],
    models: [{ id: "old-public", pricingRef: "old-model", upstream: "azure" }]
  };

  await fs.mkdir(pricingDir, { recursive: true });
  await fs.writeFile(path.join(pricingDir, "old-model.json"), `${JSON.stringify(definition("old-model"), null, 2)}\n`);
  process.env.PRICING_DIR = pricingDir;

  const oldSnapshot = installModelCatalogSnapshot(compileModelCatalog(currentConfig, [definition("old-model")]));
  const oldRuntimeInfo = getModelCatalogRuntimeInfo();
  const assertOldCatalogStillActive = () => {
    assert.deepEqual(getModelCatalogRuntimeInfo(), oldRuntimeInfo);
    assert.equal(resolveModelDescriptor("old-public")?.catalogId, "old-model");
  };
  globalThis.fetch = async (url) => {
    const urlText = String(url);
    if (urlText.includes("/contents/")) {
      const names = syncMode === "collision"
        ? ["first.json", "second.json"]
        : syncMode === "invalid-binding"
          ? ["candidate-image.json"]
          : syncMode === "invalid-template-route"
            ? ["invalid-template-route.json"]
            : syncMode === "invalid-template-routes-shape"
              ? ["invalid-template-routes-shape.json"]
            : syncMode === "invalid-hosting" || syncMode === "invalid-hosting-empty"
              ? ["hosted-model.json"]
          : ["new-model.json"];
      return new Response(JSON.stringify(names.map((name) => ({
        type: "file",
        name,
        download_url: `https://download.test/${name}`
      }))));
    }
    const fileName = urlText.split("/").at(-1);
    const rawDefinition = syncMode === "collision"
      ? definition(fileName === "first.json" ? "first" : "second", ["shared-alias"])
      : syncMode === "invalid-binding"
        ? {
          ...definition("candidate-image"),
          provider: "black-forest-labs",
          interfaces: ["images/generations"],
          capabilities: ["image-generation"]
        }
        : syncMode === "invalid-template-route"
          ? {
            ...definition("invalid-template-route"),
            proxyTemplate: {
              id: "invalid-template-route",
              targetModel: "invalid-template-route",
              routes: { "*": "/openai/v1/responses" }
            }
          }
        : syncMode === "invalid-template-routes-shape"
          ? {
            ...definition("invalid-template-routes-shape"),
            proxyTemplate: {
              id: "invalid-template-routes-shape",
              targetModel: "invalid-template-routes-shape",
              routes: []
            }
          }
        : syncMode === "invalid-hosting"
          ? {
            ...definition("hosted-model"),
            hostingModes: ["azure"],
            defaultHostingMode: "azure",
            interfacesByHostingMode: { azure: ["responses"] }
          }
        : syncMode === "invalid-hosting-empty"
          ? definition("hosted-model")
        : {
          ...definition("new-model", ["new-model-alias"]),
          interfaces: ["audio/transcriptions"],
          protocolProfiles: {
            "audio/transcriptions": { request: {} }
          }
        };
    return new Response(JSON.stringify(rawDefinition));
  };

  try {
    const transaction = createModelCatalogSyncTransaction(
      () => currentConfig,
      getConfiguredModelBindingIssues
    );
    const runExclusive = transaction.runExclusive;
    let exclusiveActivations = 0;
    transaction.runExclusive = (operation) => {
      exclusiveActivations += 1;
      return runExclusive(operation);
    };
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /alias collision for shared-alias/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-binding";
    currentConfig = {
      upstreams: [{
        name: "azure",
        provider: "azure-openai",
        baseUrl: "https://example.openai.azure.com/",
        routes: { "images/generations": "/openai/v1/images/generations" }
      }],
      models: [{
        id: "image-model",
        pricingRef: "candidate-image",
        upstream: "azure",
        routes: { "images/generations": "openai-image" }
      }],
      routing: { routeProfiles: { imageGenerations: { enabled: true } } },
      media: { generation: { enabled: true } }
    };
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /route target "openai-image".*candidate-image/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-template-route";
    currentConfig = { ...currentConfig, models: [] };
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /proxyTemplate\.routes\.\* must be a route identifier/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-template-routes-shape";
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /proxyTemplate\.routes must be an object/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-hosting";
    currentConfig = {
      upstreams: [{
        name: "azure",
        provider: "azure-openai",
        baseUrl: "https://example.openai.azure.com/",
        routes: { responses: "/openai/v1/responses" }
      }],
      models: [{
        id: "hosted-public",
        pricingRef: "hosted-model",
        hostingMode: "anthropic",
        upstream: "azure"
      }]
    };
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /hostingMode "anthropic".*hosted-model.*supported modes: azure/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-hosting-empty";
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /hostingMode "anthropic".*hosted-model.*supported modes: none/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "success";
    currentConfig = {
      upstreams: [{
        name: "azure",
        provider: "azure-openai",
        baseUrl: "https://example.openai.azure.com/",
        routes: {
          "audio/transcriptions": "/openai/v1/audio/transcriptions"
        }
      }],
      models: [{ id: "new-public", pricingRef: "new-model", upstream: "azure" }]
    };
    const result = await syncPricingDefinitionsFromGitHub(
      { owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" },
      transaction
    );

    assert.equal(result.syncedFiles, 1);
    assert.equal(exclusiveActivations, 1);
    assert.deepEqual((await fs.readdir(pricingDir)).sort(), [".pricing-sync-meta", "new-model.json"]);
    assert.equal(resolveModelDescriptor("new-public")?.catalogId, "new-model");
    assert.equal(findPricingDefinitionForModel({ pricingRef: "new-model-alias" })?.id, "new-model");
    assert.ok(getModelCatalogRuntimeInfo().generation > oldSnapshot.generation);

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
    assert.equal(exclusiveActivations, 3);
    assert.deepEqual((await fs.readdir(pricingDir)).sort(), [".pricing-sync-meta", "second.json"]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPricingDir == null) delete process.env.PRICING_DIR;
    else process.env.PRICING_DIR = previousPricingDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});