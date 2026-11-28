import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { newCopilotChannel } from "../admin-ui/src/copilot.js";
import { resolveChannelModels } from "../src/channel-bindings.js";
import { discoveryModels } from "../src/copilot-provider.js";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { compileModelCatalog, getDescriptorProtocolProfile, installModelCatalogSnapshot, resolveModelDescriptor } from "../src/model-catalog.js";
import { buildModelFromPricingTemplate, buildUpstreamFromPricingTemplate, upsertPricingCatalogEntry } from "../admin-ui/src/utils.js";
import { resolveRealtimeBinding } from "../src/proxy/realtime-policy.js";
import { resolveMediaPricing } from "../src/proxy/media-accounting.js";
import { validateModelCard } from "../scripts/model-cards.js";

const retailUrl = "https://prices.azure.com/api/retail/prices";
const gptSourceUpgrades = [
  "gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.4",
  "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6.1-terra"
];
const azureMedia = [
  "gpt-4o-audio-preview", "gpt-4o-mini-audio-preview", "gpt-4o-mini-realtime-preview",
  "gpt-4o-mini-transcribe", "gpt-4o-mini-tts", "gpt-4o-realtime-preview", "gpt-4o-transcribe-diarize",
  "gpt-realtime-2.1", "gpt-realtime-2.1-mini"
];

async function rawCard(file) {
  return JSON.parse(await fs.readFile(new URL(`../pricing/${file}.json`, import.meta.url), "utf8"));
}

test("Gemini and MAI Copilot discoveries bind exact Catalog IDs without inheriting Azure routes or prices", async () => {
  const chat = "chat/completions";
  const threeLevels = ["low", "medium", "high"];
  const maiLevels = [...threeLevels, "xhigh", "max"];
  const visionTools = ["code-optimized", "reasoning", "vision", "function-calling"];
  const geminiTools = [...visionTools, "parallel-tool-calling", "streaming"];
  const toolUse = ["code-optimized", "function-calling"];
  const cases = [
    ["gemini-3.8-flash", [0.75, 0.075, 3.75], threeLevels, geminiTools],
    ["gemini-4-argon", [2, 0.1, 10], undefined, ["code-optimized", "reasoning"]],
    ["gemini-4-carbon", [2, 0.1, 10], threeLevels, geminiTools],
    ["gemini-4-hydrogen", [1.5, 0.075, 7.5], undefined, toolUse],
    ["gemini-4-neon", [3, 0.15, 15], undefined, toolUse],
    ["mai-code-2", [0.5, 0.025, 2.5], maiLevels, [...visionTools, "structured-outputs"]],
    ["mai-code-2-flash", [0.05, 0.005, 0.25], maiLevels, visionTools]
  ];
  const definitions = listPricingDefinitions();
  const up = newCopilotChannel("copilot", "Copilot");
  up.auth.credentialRef = "test-ref";
  const discovered = discoveryModels({ data: cases.map(([id]) => ({ id, supported_endpoints: ["/chat/completions"] })) });
  up.modelMappings = discovered.map(({ id, routes }) => ({ sourceModelId: id, canonicalModelId: id, routes, enabled: true }));
  const config = { upstreams: [up], models: cases.map(([id]) => ({
    id, canonicalModelId: id, selectedBinding: { channelId: up.channelId, sourceModelId: id }
  })) };
  config.models = resolveChannelModels(config, new Set(definitions.map(card => card.id)));
  const snapshot = compileModelCatalog(config, definitions);
  for (const [id, rates, levels, capabilities] of cases) {
    const raw = await rawCard(id);
    const descriptor = resolveModelDescriptor(id, snapshot);
    assert.equal(descriptor.catalogId, id);
    assert.deepEqual(descriptor.interfaces, [chat], id);
    assert.equal(descriptor.defaultInterface, chat, id);
    assert.deepEqual(raw.capabilities, capabilities, id);
    assert.deepEqual(descriptor.capabilities, capabilities, id);
    assert.deepEqual(raw.protocolProfiles[chat].reasoning, {
      parameter: "reasoning_effort", ...(levels ? { levels } : {}), validation: "passthrough"
    }, id);
    const profile = getDescriptorProtocolProfile(descriptor, chat).reasoning;
    assert.deepEqual(profile.levels, levels ?? [], id);
    assert.equal(profile.default, "", id);
    assert.deepEqual([raw.pricing.inputPer1mTokens, raw.pricing.cachedInputPer1mTokens, raw.pricing.outputPer1mTokens], rates, id);
    assert.equal(descriptor.model.pricing, undefined, id);
    assert.equal(descriptor.definition.pricingCatalogEntry, null, id);
    if (id !== "mai-code-2-flash") {
      assert.equal(raw.pricing.sourceType, "github-copilot-official", id);
      assert.equal(new URL(raw.sources.pricing).hostname, "docs.github.com", id);
      assert.equal(descriptor.definition.supportsProxyTemplate, false, id);
    }
  }
});

test("MAI Code 2 Flash's Foundry template keeps its own limits, reasoning profiles and price source", async () => {
  const definitions = listPricingDefinitions();
  const id = "mai-code-2-flash";
  const raw = await rawCard(id);
  const card = definitions.find(card => card.id === id);
  const up = buildUpstreamFromPricingTemplate(card, "foundry");
  const model = buildModelFromPricingTemplate(card, up.name, { models: [] });
  const descriptor = resolveModelDescriptor(id, compileModelCatalog({ upstreams: [up], models: [model] }, definitions));
  assert.equal(card.supportsProxyTemplate, true);
  assert.equal(model.targetModel, id);
  assert.equal(model.hostingMode, "azure");
  assert.deepEqual(model.capabilities, raw.capabilities);
  assert.deepEqual(descriptor.interfaces, ["chat/completions", "responses"]);
  assert.equal(descriptor.defaultInterface, "responses");
  assert.deepEqual(raw.protocolProfiles.responses.reasoning, {
    parameter: "reasoning.effort", levels: ["low", "medium", "high", "xhigh", "max"], validation: "passthrough"
  });
  assert.deepEqual(getDescriptorProtocolProfile(descriptor, "responses").reasoning.levels, raw.protocolProfiles.responses.reasoning.levels);
  assert.equal(getDescriptorProtocolProfile(descriptor, "responses").reasoning.default, "");
  assert.deepEqual([raw.modelVersion, raw.status, raw.contextWindow, raw.maxInputTokens, raw.maxOutputTokens],
    ["2026-11-17", "preview", 1000000, undefined, 128000]);
  const flagship = await rawCard("mai-code-2");
  assert.deepEqual([flagship.status, flagship.contextWindow, flagship.maxInputTokens, flagship.maxOutputTokens],
    ["ga", 1050000, 922000, 128000]);
  assert.equal(raw.pricing.sourceType, "azure-retail-prices-api");
  assert.equal(raw.sources.pricing, retailUrl);
});

test("Azure source priority records exact direct and Fireworks Global rates without enabling opt-outs", async () => {
  const expected = [
    ["kimi-k2.5", [0.6, 0.1, 3]],
    ["kimi-k2.6", [0.95, 0.16, 4]],
    ["glm-5.3-flash", [0.188, 0.038, 0.625]],
    ["deepseek-v4.1-flash", [0.375, 0.008, 1.5]],
    ["kimi-k3", [3, 0.3, 15]],
    ["grok-4", [3, undefined, 15]],
    ["llama4-maverick-instruct", [0.25, undefined, 1]]
  ];
  for (const [file, rates] of expected) {
    const card = await rawCard(file);
    assert.equal(card.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(card.pricing.status, "published", file);
    assert.equal(card.pricing.deploymentType, "global-standard", file);
    assert.equal(card.sources.pricing, retailUrl, file);
    assert.deepEqual([card.pricing.inputPer1mTokens, card.pricing.cachedInputPer1mTokens, card.pricing.outputPer1mTokens],
      rates, file);
    assert.equal(card.pricingCatalogEntry, null, file);
    assert.deepEqual(validateModelCard(card).errors, [], file);
  }
});

test("GPT cards prefer verified Azure prices without changing their existing pricing opt-in state", async () => {
  const definitions = listPricingDefinitions();
  for (const file of gptSourceUpgrades) {
    const raw = await rawCard(file);
    assert.equal(raw.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(raw.pricing.status, "published", file);
    assert.equal(raw.sources.pricing, retailUrl, file);
    assert.equal(raw.sources.azurePricing, "https://azure.microsoft.com/en-us/pricing/details/azure-openai/", file);
    assert.equal(Object.hasOwn(raw, "pricingCatalogEntry"), file === "gpt-6.1-terra", file);
    const card = definitions.find(card => card.id === raw.id);
    const config = {};
    upsertPricingCatalogEntry(config, card);
    assert.deepEqual(config.access?.pricingCatalog?.[raw.id], file === "gpt-6.1-terra" ? undefined : card.pricing, file);
    const override = { access: { pricingCatalog: { [raw.id]: { inputPer1mTokens: 0 } } } };
    if (file === "gpt-6.1-terra") {
      upsertPricingCatalogEntry(override, card);
      assert.deepEqual(override.access.pricingCatalog[raw.id], { inputPer1mTokens: 0 });
    }
  }
});

test("Grok uses Azure meter rates but does not promote xAI tier boundaries to verified Azure policy", async () => {
  for (const file of ["grok-4.3", "grok-4.6", "grok-4.7"]) {
    const card = await rawCard(file);
    assert.equal(card.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(card.pricing.status, "reference", file);
    assert.equal(card.sources.pricing, retailUrl, file);
    assert.match(card.sources.tiering, /^https:\/\/docs\.x\.ai\//, file);
    assert.equal(card.pricingCatalogEntry, null, file);
    assert.deepEqual(card.pricing.tiers.map(tier => [tier.id, tier.promptTokensBelow ?? null, tier.promptTokensAtLeast ?? null]),
      [["short <200K", 200000, null], ["long >=200K", null, 200000]], file);
    assert.match(card.notes.join(" "), /boundary.*unverified|unverified.*boundary/i, file);
  }
});

test("Azure image prices preserve separate media channels, missing text output and disabled token billing", async () => {
  for (const [file, text, image, output, cachedText, cachedImage] of [
    ["gpt-image-2.5-flare", 5, 8, 30, 1.25, 2],
    ["gpt-image-2.5-sunburst", 5, 8, 30, 1.25, 2],
    ["gpt-image-2", 5, 8, 30, 1.25, 2],
    ["mai-image-2.6", 5, 8, 38, undefined, undefined],
    ["mai-image-2.6-flash", 1.75, 2.5, 19, undefined, undefined],
    ["mai-image-2.7", 5, 8, 34, undefined, undefined],
    ["mai-image-2.7-flash", 1.75, 2.5, 10, undefined, undefined]
  ]) {
    const card = await rawCard(file);
    assert.equal(card.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(card.pricing.status, "published", file);
    assert.equal(card.pricing.billingUnit, "1M tokens", file);
    assert.deepEqual([card.pricing.inputPer1mTokens, card.pricing.cachedInputPer1mTokens], [text, cachedText], file);
    assert.deepEqual(card.pricing.channels.image, {
      inputPer1mTokens: image,
      ...(cachedImage == null ? {} : { cachedInputPer1mTokens: cachedImage }),
      outputPer1mTokens: output
    }, file);
    assert.equal(Object.hasOwn(card.pricing, "outputPer1mTokens"), false, file);
    assert.equal(card.pricingCatalogEntry, null, file);
    if (file.startsWith("mai-image-2.7")) {
      assert.deepEqual([card.contextWindow, card.maxOutputTokens], [32000, 4096], file);
      assert.equal(Object.hasOwn(card, "maxInputTokens"), false, file);
      assert.match(card.sources.limits, /ai\.azure\.com\/catalog\/models\/MAI-Image-2\.7/, file);
    }
    assert.deepEqual(validateModelCard(card).errors, [], file);
  }
  for (const file of ["flux-2-pro", "flux-2-flex"]) {
    const card = await rawCard(file);
    assert.equal(card.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(card.pricing.status, "published", file);
    assert.equal(card.pricing.billingUnit, "megapixels", file);
    assert.equal(card.pricingCatalogEntry, null, file);
    assert.match(card.notes.join(" "), /pixelRules.*reference/);
  }
});

test("MAI Image 2.7 Azure media prices require an explicit override", () => {
  const definitions = listPricingDefinitions();
  for (const id of ["mai-image-2.7", "mai-image-2.7-flash"]) {
    const definition = definitions.find(card => card.id === id);
    const model = { id, pricingRef: id, hostingMode: "azure" };
    const upstream = { provider: "azure-openai" };
    const target = "https://example.services.ai.azure.com/mai/v1/images/generations";
    assert.equal(resolveMediaPricing({}, model, upstream, { definition }, target), null, id);
    assert.deepEqual(resolveMediaPricing({}, { ...model, pricing: definition.pricing }, upstream, { definition }, target),
      { ...definition.pricing, source: "model.pricing" }, id);
  }
});

test("verified Azure audio and realtime prices do not enable scalar token billing", async () => {
  for (const file of azureMedia) {
    const card = await rawCard(file);
    assert.equal(card.pricing.sourceType, "azure-retail-prices-api", file);
    assert.equal(card.pricing.status, "published", file);
    assert.equal(card.sources.pricing, retailUrl, file);
    assert.equal(card.pricingCatalogEntry, null, file);
    assert.doesNotMatch(card.notes.join(" "), /renders.*(?:no numeric|\$-)|rates.*remain references/i, file);
  }
});

test("Realtime cards default to exact Azure deployment facts and documented WebSocket routes", async () => {
  const definitions = listPricingDefinitions();
  for (const [id, routeKey, path, status, duration] of [
    ["gpt-realtime-2", "realtime", "/openai/v1/realtime", "preview", undefined],
    ["gpt-realtime-whisper", "realtime/transcription_sessions", "/openai/v1/realtime", "ga", 0.017],
    ["gpt-realtime-translate", "realtime/translations", "/openai/v1/realtime/translations", "ga", 0.034]
  ]) {
    const raw = await rawCard(id);
    const card = definitions.find(card => card.id === id);
    assert.equal(raw.provider, "azure-openai", id);
    assert.equal(raw.defaultHostingMode, "azure", id);
    assert.deepEqual(raw.hostingModes, ["azure"], id);
    assert.equal(raw.modelVersion, "2026-05-07", id);
    assert.equal(raw.status, status, id);
    assert.deepEqual([raw.contextWindow, raw.maxInputTokens, raw.maxOutputTokens], [128000, 32000, 4096], id);
    assert.equal(raw.pricing.sourceType, "azure-retail-prices-api", id);
    assert.equal(raw.pricingCatalogEntry, null, id);
    if (duration != null) {
      assert.equal(raw.pricing.realtimeAudioDurationPerMinute, duration, id);
      assert.equal(Object.hasOwn(raw.pricing, "realtimeAudioDurationPerSecond"), false, id);
    } else {
      assert.deepEqual(raw.protocolProfiles.realtime.reasoning, {
        parameter: "reasoning.effort", levels: ["minimal", "low", "medium", "high"], validation: "passthrough"
      });
    }
    const upstream = buildUpstreamFromPricingTemplate(card, "azure");
    upstream.baseUrl = "https://example.openai.azure.com";
    assert.equal(upstream.provider, "azure-openai", id);
    const model = buildModelFromPricingTemplate(card, upstream.name, { models: [] });
    model.targetModel = "deployment";
    assert.equal(model.hostingMode, "azure", id);
    const config = { upstreams: [upstream], models: [model] };
    const snapshot = installModelCatalogSnapshot(compileModelCatalog(config, definitions));
    const binding = resolveRealtimeBinding(config, {}, model.id, routeKey, routeKey === "realtime/transcription_sessions");
    assert.equal(binding.targetUrl.toString(),
      `wss://example.openai.azure.com${path}?${duration === 0.017 ? "intent=transcription" : "model=deployment"}`, id);
    if (id === "gpt-realtime-2") {
      const profile = getDescriptorProtocolProfile(resolveModelDescriptor(model.id, snapshot), "realtime").reasoning;
      assert.deepEqual(profile.levels, ["minimal", "low", "medium", "high"]);
      assert.equal(profile.default, "");
    }
    assert.deepEqual(validateModelCard(raw).errors, [], id);
  }
});

test("Azure-default Realtime prices remain host-isolated while explicit OpenAI prices stay authoritative", () => {
  const definitions = listPricingDefinitions();
  for (const id of ["gpt-realtime-2", "gpt-realtime-translate", "gpt-realtime-whisper"]) {
    const definition = definitions.find(card => card.id === id);
    const model = { id: `public-${id}`, pricingRef: id };
    const descriptor = { definition };
    const upstream = { provider: "openai" };
    assert.equal(resolveMediaPricing({}, model, upstream, descriptor, "https://api.openai.com/v1/realtime"), null, id);
    const pricing = { currency: "USD", billingUnit: definition.pricing.billingUnit,
      ...(id === "gpt-realtime-2" ? { channels: { audio: { inputPer1mTokens: 32 } } }
        : { realtimeAudioDurationPerMinute: id === "gpt-realtime-whisper" ? 0.017 : 0.034 }) };
    assert.deepEqual(resolveMediaPricing({}, { ...model, pricing }, upstream, descriptor, "https://api.openai.com/v1/realtime"),
      { ...pricing, source: "model.pricing" }, id);
    const config = { access: { pricingCatalog: { [id]: pricing } } };
    assert.deepEqual(resolveMediaPricing(config, model, upstream, descriptor, "https://api.openai.com/v1/realtime"),
      { ...pricing, source: `access.pricingCatalog.${id}` }, id);
  }
});

test("Claude price evidence follows Azure CCU delegation without relabeling the model publisher", () => {
  const cards = listPricingDefinitions().filter(card => card.provider === "anthropic");
  assert.equal(cards.length, 11);
  for (const card of cards) {
    assert.equal(card.pricing.sourceType, "anthropic-official", card.id);
    assert.equal(card.sources.azureBilling,
      "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-billing", card.id);
    assert.match(card.notes.join(" "), /CCU.*Anthropic|Anthropic.*CCU/, card.id);
  }
});
