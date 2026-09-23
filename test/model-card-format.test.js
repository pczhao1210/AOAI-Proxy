import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { expandModelCard, getModelCardPricing } from "../src/model-card.js";
import { compileDefinitionPricing } from "../src/pricing-policy.js";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { buildModelFromPricingTemplate, upsertPricingCatalogEntry } from "../admin-ui/src/utils.js";
import { canonicalizeModelCard, formatModelCard } from "../scripts/model-cards.js";

const legacy = {
  id: "example", displayName: "Example", provider: "openai", family: "example",
  interfaces: ["responses"], capabilities: ["reasoning"],
  pricing: {
    currency: "USD", billingUnit: "1M tokens", sourceType: "official",
    inputPer1mTokens: 2, inputPer1kTokens: 0.002,
    cachedInputPer1mTokens: 0, cachedInputPer1kTokens: 0,
    outputPer1mTokens: 10, outputPer1kTokens: 0.01
  },
  pricingCatalogEntry: { currency: "USD", inputPer1kTokens: 0.002, cachedInputPer1kTokens: 0, outputPer1kTokens: 0.01 },
  proxyTemplate: { id: "example", displayName: "Example", targetModel: "example", pricingRef: "example", capabilities: ["reasoning"] }
};

test("compact cards preserve prices, generated models, explicit zero and independent input objects", () => {
  const original = structuredClone(legacy);
  const compact = canonicalizeModelCard(original);
  assert.deepEqual(original, legacy);
  assert.equal(Object.hasOwn(compact, "pricingCatalogEntry"), false);
  assert.equal(Object.hasOwn(compact.pricing, "inputPer1kTokens"), false);
  assert.equal(compact.pricing.cachedInputPer1mTokens, 0);
  assert.deepEqual(compact.proxyTemplate, {});
  assert.deepEqual(compileDefinitionPricing(compact).pricing, compileDefinitionPricing(legacy).pricing);
  assert.deepEqual(buildModelFromPricingTemplate(expandModelCard(compact), "upstream", {}),
    buildModelFromPricingTemplate(legacy, "upstream", {}));
  const config = {};
  upsertPricingCatalogEntry(config, compact);
  assert.deepEqual(config.access.pricingCatalog.example, compact.pricing);
  config.access.pricingCatalog.example.inputPer1mTokens = 99;
  assert.equal(compact.pricing.inputPer1mTokens, 2);
});

test("card defaults preserve opt-outs, deliberate overrides, absent templates and invalid price errors", () => {
  for (const template of [undefined, null]) {
    assert.equal(expandModelCard({ ...legacy, proxyTemplate: template }).proxyTemplate, null);
  }
  const card = { ...legacy, pricingCatalogEntry: null, proxyTemplate: { targetModel: "deployment", capabilities: [], routes: { "*": "responses" } } };
  const compact = canonicalizeModelCard(card);
  assert.equal(compact.pricingCatalogEntry, null);
  assert.equal(getModelCardPricing(compact), null);
  assert.equal(compileDefinitionPricing(compact).pricing, null);
  assert.deepEqual(expandModelCard(compact).proxyTemplate, {
    id: "example", displayName: "Example", targetModel: "deployment", pricingRef: "example",
    capabilities: [], routes: { "*": "responses" }
  });
  const config = {};
  upsertPricingCatalogEntry(config, compact);
  assert.deepEqual(config, {});
  const override = canonicalizeModelCard({ ...legacy, pricingCatalogEntry: { inputPer1kTokens: 0.003 } });
  assert.deepEqual(override.pricingCatalogEntry, { inputPer1mTokens: 3 });
  assert.equal(compileDefinitionPricing(override).pricing.rates.inputPer1mTokens, 3);
  const extension = canonicalizeModelCard({ ...legacy, pricingCatalogEntry: { ...legacy.pricingCatalogEntry, sourceType: "custom" } });
  assert.equal(extension.pricingCatalogEntry.sourceType, "custom");
  assert.throws(() => expandModelCard({ ...legacy, pricingCatalogEntry: [] }), /pricingCatalogEntry must be an object or null/);
  assert.throws(() => canonicalizeModelCard({ ...legacy, pricing: { inputPer1mTokens: 2, inputPer1kTokens: 0.003 } }), /conflict/i);
  assert.throws(() => canonicalizeModelCard({ ...legacy, pricingCatalogEntry: null, pricing: { inputPer1mTokens: -1 } }), /Invalid/);
});

test("tier tables are stored once without inventing missing rates or flattening their intervals", () => {
  const entry = { currency: "USD", billingUnit: "1M tokens",
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [
      { id: "short", promptTokensBelow: 272001, inputPer1mTokens: 2, outputPer1mTokens: 10 },
      { id: "long", promptTokensAtLeast: 272001, inputPer1mTokens: 4, outputPer1mTokens: 15 }
    ] };
  const card = { ...legacy, pricing: { ...entry, inputPer1mTokens: 2, outputPer1mTokens: 10 }, pricingCatalogEntry: entry };
  const compact = canonicalizeModelCard(card);
  assert.equal(Object.hasOwn(compact.pricing, "inputPer1mTokens"), false);
  assert.equal(Object.hasOwn(compact, "pricingCatalogEntry"), false);
  assert.deepEqual(compact.pricing, entry);
  assert.deepEqual(compileDefinitionPricing(compact).pricing, compileDefinitionPricing(card).pricing);
  const config = {};
  upsertPricingCatalogEntry(config, compact);
  assert.deepEqual(config.access.pricingCatalog.example, entry);
  const reference = canonicalizeModelCard({ ...card, pricingCatalogEntry: null });
  assert.equal(reference.pricingCatalogEntry, null);
  const unnamedTiers = structuredClone(card);
  unnamedTiers.pricing.tiers = structuredClone(unnamedTiers.pricing.tiers);
  for (const row of unnamedTiers.pricing.tiers) delete row.id;
  const named = canonicalizeModelCard(unnamedTiers);
  assert.equal(Object.hasOwn(named, "pricingCatalogEntry"), false);
  assert.deepEqual(named.pricing.tiers.map(row => row.id), ["short", "long"]);
  assert.deepEqual(compileDefinitionPricing(named).pricing, compileDefinitionPricing(card).pricing);
  assert.throws(() => canonicalizeModelCard({ ...card, pricing: { ...card.pricing, inputPer1mTokens: 99 } }), /Conflicting whole-request/);
});

test("model-card formatter is deterministic, idempotent and preserves media and evidence", () => {
  const card = { ...legacy, pricingCatalogEntry: null,
    pricing: { ...legacy.pricing, channels: { audio: { inputPer1mTokens: 32, inputPer1kTokens: 0.032 } },
      byHostingMode: { azure: { perMinute: 0.003 } } },
    sources: { capabilities: "https://example.test/model", limits: "https://example.test/model" },
    notes: ["Provider-specific exception."] };
  const formatted = formatModelCard(card);
  assert.equal(formatModelCard(JSON.parse(formatted)), formatted);
  assert.match(formatted, /"interfaces": \["responses"\]/);
  const compact = JSON.parse(formatted);
  assert.deepEqual(compact.sources, card.sources);
  assert.deepEqual(compact.notes, card.notes);
  assert.deepEqual(compact.pricing.channels.audio, { inputPer1mTokens: 32 });
  assert.deepEqual(compact.pricing.byHostingMode, card.pricing.byHostingMode);
  assert.equal(compact.pricingCatalogEntry, null);
  const override = canonicalizeModelCard({ ...card, pricingCatalogEntry: {
    ...legacy.pricingCatalogEntry, channels: { audio: { inputPer1mTokens: 64 } }
  } });
  assert.deepEqual(override.pricingCatalogEntry.channels, { audio: { inputPer1mTokens: 64 } });
});

test("all active model cards use canonical self-contained formatting", async () => {
  const directory = new URL("../pricing/", import.meta.url);
  const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
  assert.equal(names.length, 81);
  for (const name of names) {
    const text = await fs.readFile(new URL(name, directory), "utf8");
    assert.equal(text, formatModelCard(JSON.parse(text)), name);
  }
});

test("bundled admin and backend loaders expand the same compact model-card contracts", async () => {
  const vite = await createServer({
    configFile: fileURLToPath(new URL("../admin-ui/vite.config.js", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true, watch: null, ws: false }, appType: "custom"
  });
  try {
    const { bundledPricingLibrary } = await vite.ssrLoadModule("/admin-ui/src/pricing-library.js");
    const backend = new Map(listPricingDefinitions().map(card => [card.id, card]));
    assert.equal(bundledPricingLibrary.length, backend.size);
    for (const card of bundledPricingLibrary) {
      const match = backend.get(card.id);
      for (const field of ["pricing", "pricingCatalogEntry", "proxyTemplate", "supportsProxyTemplate", "upstreamTemplate"]) {
        assert.deepEqual(card[field], match[field], `${card.id}.${field}`);
      }
    }
  } finally {
    await vite.close();
  }
});
