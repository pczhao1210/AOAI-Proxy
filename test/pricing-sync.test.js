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
import { compileDefinitionPricing } from "../src/pricing-policy.js";
import { buildModelFromPricingTemplate, upsertPricingCatalogEntry } from "../admin-ui/src/utils.js";
import {
  findPricingDefinitionForModel,
  listPricingDefinitions,
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

test("remote compact cards preserve source form and activate complete template and pricing contracts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoai-compact-sync-"));
  const previousPricingDir = process.env.PRICING_DIR;
  const previousFetch = globalThis.fetch;
  const pricing = {
    currency: "USD", billingUnit: "1M tokens",
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [
      { id: "short", promptTokensBelow: 272001, inputPer1mTokens: 2, cachedInputPer1mTokens: 0, cacheWritePer1mTokens: 2.5, outputPer1mTokens: 10 },
      { id: "long", promptTokensAtLeast: 272001, inputPer1mTokens: 4, cachedInputPer1mTokens: 0, cacheWritePer1mTokens: 5, outputPer1mTokens: 15 }
    ]
  };
  const compact = {
    ...definition("compact-model"), pricing,
    proxyTemplate: { targetModel: "provider-deployment" }
  };
  const config = {
    upstreams: [{ name: "test", provider: "openai", baseUrl: "https://api.example.test", routes: { responses: "/v1/responses" } }],
    models: [{ id: "compact-public", pricingRef: "compact-model", targetModel: "provider-deployment", upstream: "test" }]
  };
  let remote = compact;
  process.env.PRICING_DIR = path.join(tempDir, "pricing");
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes("/contents/") ? [
    { type: "file", name: "compact-model.json", download_url: "https://download.test/compact-model.json" }
  ] : remote));
  try {
    const transaction = createModelCatalogSyncTransaction(() => config, getConfiguredModelBindingIssues);
    const sync = () => syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", ref: "compact" }, transaction);
    await sync();
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(process.env.PRICING_DIR, "compact-model.json"), "utf8")), compact);
    const card = findPricingDefinitionForModel({ pricingRef: "compact-model" });
    assert.equal(card.supportsProxyTemplate, true);
    assert.equal(card.proxyTemplate.targetModel, "provider-deployment");
    assert.deepEqual(card.proxyTemplate.capabilities, compact.capabilities);
    assert.deepEqual(card.pricingCatalogEntry, pricing);
    const generated = buildModelFromPricingTemplate(card, "test", {});
    assert.equal(generated.id, "compact-model");
    assert.equal(generated.pricingRef, "compact-model");
    assert.equal(generated.targetModel, "provider-deployment");
    const imported = {};
    upsertPricingCatalogEntry(imported, card);
    assert.deepEqual(imported.access.pricingCatalog["compact-model"], pricing);
    assert.equal(compileDefinitionPricing(card).pricing.tiers[0].rates.cachedInputPer1mTokens, 0);
    assert.equal(resolveModelDescriptor("compact-public").catalogId, "compact-model");
    const active = getModelCatalogRuntimeInfo();
    remote = structuredClone(compact);
    remote.pricing.tiers[1].promptTokensAtLeast = 272000;
    await assert.rejects(sync(), /tiers|pricing/i);
    assert.deepEqual(getModelCatalogRuntimeInfo(), active);
    assert.deepEqual(findPricingDefinitionForModel({ pricingRef: "compact-model" }).pricingCatalogEntry, pricing);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPricingDir == null) delete process.env.PRICING_DIR;
    else process.env.PRICING_DIR = previousPricingDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

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
              : syncMode === "invalid-token-limits"
                ? ["invalid-token-limits.json"]
                : syncMode === "invalid-hosting" || syncMode === "invalid-hosting-empty"
                  ? ["hosted-model.json"]
                  : ["new-model.json"];
      const entries = names.map((name) => ({
        type: "file",
        name,
        download_url: `https://download.test/${name}`
      }));
      if (syncMode === "success") {
        entries.unshift({ type: "dir", name: "archive" });
      }
      return new Response(JSON.stringify(entries));
    }
    const fileName = urlText.split("/").at(-1);
    const rawDefinition = syncMode === "invalid-pricing-shape"
      ? { ...definition("bad-pricing"), pricingCatalogEntry: [] }
      : syncMode === "invalid-pricing"
      ? {
        ...definition("bad-pricing"),
        pricingCatalogEntry: {
          tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
          tiers: [
            { promptTokensBelow: 200000, inputPer1mTokens: 2, outputPer1mTokens: 10 },
            { promptTokensAtLeast: 199999, inputPer1mTokens: 4, outputPer1mTokens: 15 }
          ]
        }
      }
      : syncMode === "collision"
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
        : syncMode === "invalid-token-limits"
          ? {
            ...definition("invalid-token-limits"),
            contextWindow: 128000,
            maxInputTokens: 256000
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

    syncMode = "invalid-pricing-shape";
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /pricingCatalogEntry must be an object or null/
    );
    assert.deepEqual(await fs.readdir(pricingDir), ["old-model.json"]);
    assertOldCatalogStillActive();

    syncMode = "invalid-pricing";
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /pricing|tiers/i
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

    syncMode = "invalid-token-limits";
    await assert.rejects(
      syncPricingDefinitionsFromGitHub({ owner: "test", repo: "catalog", path: "pricing", ref: "test-ref" }, transaction),
      /maxInputTokens must not exceed contextWindow/
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

    await fs.mkdir(path.join(pricingDir, "archive"), { recursive: true });
    await fs.writeFile(
      path.join(pricingDir, "archive", "archived-model.json"),
      `${JSON.stringify(definition("archived-model"), null, 2)}\n`
    );
    assert.equal(listPricingDefinitions().some((entry) => entry.id === "archived-model"), false);

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