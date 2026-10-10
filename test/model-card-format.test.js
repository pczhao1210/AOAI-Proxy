import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { expandModelCard, getModelCardPricing } from "../src/model-card.js";
import { compileDefinitionPricing, resolveConfiguredPricing } from "../src/pricing-policy.js";
import { calculateTokenCost } from "../src/token-pricing.js";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { applyModelCardTierPricing, buildModelFromPricingTemplate, getModelTierPricing, upsertPricingCatalogEntry } from "../admin-ui/src/utils.js";
import { canonicalizeModelCard, formatModelCard, validateModelCard } from "../scripts/model-cards.js";

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

const authoredCard = {
  id: "example", displayName: "Example", provider: "example", family: "example",
  interfaces: ["responses"], inputModalities: ["text"], outputModalities: ["text"],
  capabilities: ["reasoning"], contextWindow: 1000, maxInputTokens: 900, maxOutputTokens: 100,
  protocolProfiles: { responses: { reasoning: { parameter: "reasoning.effort", levels: ["low", "high"], default: "high" } } },
  pricing: { currency: "USD", billingUnit: "1M tokens", inputPer1mTokens: 1, outputPer1mTokens: 2 },
  sources: { capabilities: "https://example.test/model", limits: "https://example.test/limits", pricing: "https://example.test/pricing" },
  proxyTemplate: {}
};

test("raw card validation catches missing metadata before runtime defaults hide it", () => {
  assert.deepEqual(validateModelCard(authoredCard).errors, []);
  for (const field of ["id", "displayName", "provider", "family", "interfaces", "inputModalities", "outputModalities", "capabilities", "pricing", "sources"]) {
    const card = structuredClone(authoredCard);
    delete card[field];
    assert.ok(validateModelCard(card).errors.some(error => error.startsWith(field)), field);
  }
  const invalid = structuredClone(authoredCard);
  invalid.contextWindow = 0;
  invalid.sources.pricing = "not a URL";
  invalid.protocolProfiles.responses.reasoning.default = "max";
  assert.match(validateModelCard(invalid).errors.join("\n"), /contextWindow/);
  assert.match(validateModelCard(invalid).errors.join("\n"), /sources.pricing/);
  assert.match(validateModelCard(invalid).errors.join("\n"), /reasoning.default/);
});

test("card completeness reports unknown fields without inventing defaults or prices", () => {
  const card = structuredClone(authoredCard);
  delete card.contextWindow;
  delete card.maxOutputTokens;
  delete card.protocolProfiles.responses.reasoning.default;
  delete card.pricing.outputPer1mTokens;
  card.pricing.cachedInputPer1mTokens = 0;
  const original = structuredClone(card);
  const result = validateModelCard(card);
  assert.deepEqual(result.errors, []);
  for (const field of ["contextWindow", "maxOutputTokens", "reasoning.default", "outputPer1mTokens"]) {
    assert.ok(result.warnings.some(warning => warning.includes(field)), field);
  }
  assert.deepEqual(card, original);
  const fixed = structuredClone(authoredCard);
  fixed.protocolProfiles.responses.reasoning = { configurable: false };
  assert.deepEqual(validateModelCard(fixed), { errors: [], warnings: [] });
  const media = { ...authoredCard, interfaces: ["audio/speech"], capabilities: ["text-to-speech"],
    protocolProfiles: {}, contextWindow: undefined, maxOutputTokens: undefined,
    pricing: { currency: "USD", billingUnit: "minute" }, pricingCatalogEntry: null, proxyTemplate: null };
  assert.deepEqual(validateModelCard(media), { errors: [], warnings: [] });
});

test("authoring validation requires explicit tier IDs but preserves intentional price overrides", () => {
  const card = structuredClone(authoredCard);
  card.pricing = { currency: "USD", billingUnit: "1M tokens",
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [{ id: "standard", inputPer1mTokens: 0, outputPer1mTokens: 2 }] };
  assert.deepEqual(validateModelCard(card).errors, []);
  delete card.pricing.tiers[0].id;
  assert.match(validateModelCard(card).errors.join("\n"), /pricing.tiers\[0\].id/);
  card.pricingCatalogEntry = null;
  assert.match(validateModelCard(card).errors.join("\n"), /pricing.tiers\[0\].id/);
  card.pricing.tiers[0].id = "standard";
  card.pricingCatalogEntry = { inputPer1mTokens: 3 };
  assert.deepEqual(validateModelCard(card).errors, []);
});

test("raw validation rejects malformed controls, limits and executable tiers without provider heuristics", () => {
  for (const [field, value] of [["capabilities", 1], ["interfaces", "responses"], ["protocolProfiles", []], ["pricingCatalogEntry", []]]) {
    const result = validateModelCard({ ...authoredCard, [field]: value });
    assert.ok(result.errors.some(error => error.startsWith(field)), field);
  }
  const card = structuredClone(authoredCard);
  card.maxOutputTokens = card.contextWindow + 1;
  card.protocolProfiles.responses.reasoning.levels = ["low", 1];
  assert.match(validateModelCard(card).errors.join("\n"), /maxOutputTokens/);
  assert.match(validateModelCard(card).errors.join("\n"), /reasoning.levels/);
  card.pricing = { currency: "USD", billingUnit: "1M tokens",
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [
      { id: "short", promptTokensBelow: 100, inputPer1mTokens: 1 },
      { id: "long", promptTokensAtLeast: 99, inputPer1mTokens: 2 }
    ] };
  card.pricingCatalogEntry = null;
  assert.match(validateModelCard(card).errors.join("\n"), /contiguous/);
  const unavailable = { ...authoredCard, pricing: { currency: "USD", status: "unavailable" }, pricingCatalogEntry: null };
  assert.deepEqual(validateModelCard(unavailable).errors, []);
  assert.ok(validateModelCard(unavailable).warnings.some(warning => warning.startsWith("pricing.billingUnit")));
  for (const provider of ["deepseek", "fireworks-ai", "future-provider"]) {
    assert.deepEqual(validateModelCard({ ...authoredCard, provider }).errors, []);
  }
});

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

test("every executable tiered card survives import, override review and explicit scoped price repair", () => {
  const definitions = listPricingDefinitions();
  const tiered = definitions.filter(card => compileDefinitionPricing(card).pricing?.tiering);
  assert.ok(tiered.some(card => card.id === "gpt-6-astra"));
  assert.ok(tiered.some(card => card.id === "gpt-5.6-sol"));
  const config = {
    models: tiered.map(card => ({
      id: `public-${card.id}`, targetModel: card.id, pricingRef: `custom-${card.id}`,
      routes: { "*": "responses" }, pricing: { inputPer1mTokens: 1, outputPer1mTokens: 2 }
    })),
    access: { pricingCatalog: { shared: { inputPer1mTokens: 99 } } }
  };
  const original = structuredClone(config);
  const reviews = getModelTierPricing(config, definitions);
  assert.equal(reviews.length, tiered.length);
  assert.ok(reviews.every(review => review.needsUpdate && review.source === "model.pricing"));
  assert.deepEqual(config, original);
  const first = reviews[0];
  applyModelCardTierPricing(config, [first.modelId], definitions);
  assert.deepEqual(config.models.slice(1), original.models.slice(1));
  assert.deepEqual(config.access, original.access);
  assert.deepEqual(config.models[0].routes, original.models[0].routes);
  applyModelCardTierPricing(config, reviews.map(review => review.modelId), definitions);
  assert.ok(getModelTierPricing(config, definitions).every(review => !review.needsUpdate));
  for (const [index, card] of tiered.entries()) {
    const imported = {};
    upsertPricingCatalogEntry(imported, card);
    assert.deepEqual(imported.access.pricingCatalog[card.proxyTemplate?.pricingRef || card.id], getModelCardPricing(card));
    const policy = resolveConfiguredPricing(config, config.models[index], () => compileDefinitionPricing(card)).pricing;
    for (const tier of policy.tiers) {
      const input = tier.promptTokensAtLeast;
      for (const prompt of [input, ...(tier.promptTokensBelow === null ? [] : [tier.promptTokensBelow - 1])]) {
        const cost = calculateTokenCost(policy, {
          input_tokens: prompt, output_tokens: 0,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }
        }, { backendProtocol: "responses" });
        assert.equal(cost.tier.id, tier.id, card.id);
        assert.equal(cost.costStatus, "priced", card.id);
      }
    }
  }
  assert.deepEqual(config.access, original.access);
  assert.throws(() => applyModelCardTierPricing(config, ["missing"], definitions), /unavailable/);
});

test("tier review uses runtime override precedence and never enables card pricing opt-outs", () => {
  const definition = { id: "example", pricing: {
    tiering: { basis: "inputTokensIncludingCache", method: "whole-request" },
    tiers: [{ id: "short", promptTokensBelow: 100, inputPer1mTokens: 1 },
      { id: "long", promptTokensAtLeast: 100, inputPer1mTokens: 2 }]
  } };
  const config = { models: [{ id: "alias", targetModel: "example", pricingRef: "custom" }],
    access: { pricingCatalog: { custom: { inputPer1mTokens: 0 } } } };
  assert.equal(getModelTierPricing(config, [definition])[0].source, "access.pricingCatalog.custom");
  config.models[0].pricing = structuredClone(definition.pricing);
  config.models[0].pricing.tiers[0].inputPer1mTokens = 0;
  assert.equal(getModelTierPricing(config, [definition])[0].needsUpdate, false);
  assert.deepEqual(getModelTierPricing(config, [{ ...definition, pricingCatalogEntry: null }]), []);
  assert.throws(() => resolveConfiguredPricing({}, { pricing: "invalid" }, () => null), /token pricing must be an object/);
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
  assert.ok(names.length > 0);
  const ids = new Set();
  for (const name of names) {
    const text = await fs.readFile(new URL(name, directory), "utf8");
    const card = JSON.parse(text);
    assert.deepEqual(validateModelCard(card).errors, [], name);
    assert.ok(!ids.has(card.id.toLowerCase()), `${name}: duplicate id`);
    ids.add(card.id.toLowerCase());
    assert.equal(text, formatModelCard(card), name);
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
