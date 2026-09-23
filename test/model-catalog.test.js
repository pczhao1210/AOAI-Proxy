import assert from "node:assert/strict";
import test from "node:test";
import {
  compileModelCatalog,
  createModelCatalogSyncTransaction,
  getDefaultProtocolProfile,
  getDescriptorProtocolProfile,
  installModelCatalogSnapshot,
  resolveModelDescriptor
} from "../src/model-catalog.js";
import { getConfiguredModelBindingIssues, validateConfiguredModels } from "../src/model-validation.js";
import { recordGovernanceUsage } from "../src/governance.js";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { prepareImageGenerationRequest } from "../src/proxy/image-adapter.js";
import { resolveEffectiveRouteKey, resolveRoutePlan } from "../src/proxy/routing.js";
import { chatToResponsesRequest, responsesToMessagesRequest } from "../src/proxy/shim.js";
import { buildModelFromPricingTemplate, buildUpstreamFromPricingTemplate } from "../admin-ui/src/utils.js";
import { resolveRealtimeBinding } from "../src/proxy/realtime-policy.js";

const config = {
  upstreams: [{
    name: "azure",
    provider: "azure-openai",
    baseUrl: "https://example.openai.azure.com/",
    routes: {
      "chat/completions": "/openai/v1/chat/completions",
      responses: "/openai/v1/responses"
    }
  }],
  models: [
    { id: "public-gpt", targetModel: "gpt-special", pricingRef: "gpt-special", upstream: "azure" },
    { id: "unknown-model", targetModel: "unknown-deployment", upstream: "azure" }
  ]
};

const definitions = [{
  id: "gpt-special",
  aliases: ["gpt-special-alias"],
  provider: "azure-openai",
  interfaces: ["chat/completions", "responses"],
  defaultInterface: "responses",
  contextWindow: 1050000,
  maxInputTokens: 922000,
  maxOutputTokens: 128000,
  capabilities: ["reasoning", "vision"],
  protocolProfiles: {
    responses: {
      reasoning: {
        parameter: "reasoning.effort",
        levels: ["low", "medium", "high", "xhigh"],
        default: "high",
        aliases: { max: "xhigh" },
        validation: "passthrough"
      }
    }
  },
  proxyTemplate: {}
}];

const perMillionToPerThousandPairs = [
  ["inputPer1mTokens", "inputPer1kTokens"],
  ["cachedInputPer1mTokens", "cachedInputPer1kTokens"],
  ["outputPer1mTokens", "outputPer1kTokens"]
];

function assertPricingConversions(value, fileName, path = "pricing") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [perMillionKey, perThousandKey] of perMillionToPerThousandPairs) {
    if (value[perMillionKey] == null || value[perThousandKey] == null) continue;
    assert.ok(
      Math.abs(value[perThousandKey] - value[perMillionKey] / 1000) < 1e-12,
      `${fileName}: ${path}.${perThousandKey} must equal ${path}.${perMillionKey} / 1000`
    );
  }
  for (const [key, child] of Object.entries(value)) {
    assertPricingConversions(child, fileName, `${path}.${key}`);
  }
}

test("bundled Model Catalog definitions satisfy metadata and protocol contracts", () => {
  const bundledDefinitions = listPricingDefinitions();
  const ids = new Set();

  assert.equal(bundledDefinitions.length, 81);
  for (const definition of bundledDefinitions) {
    assert.ok(definition.id, `${definition.fileName}: id is required`);
    assert.ok(!ids.has(definition.id.toLowerCase()), `${definition.fileName}: duplicate id ${definition.id}`);
    ids.add(definition.id.toLowerCase());
    assert.ok(definition.displayName, `${definition.fileName}: displayName is required`);
    assert.ok(definition.provider, `${definition.fileName}: provider is required`);
    assert.ok(definition.family, `${definition.fileName}: family is required`);
    assert.ok(definition.interfaces.length > 0, `${definition.fileName}: interfaces are required`);
    assert.ok(definition.inputModalities.length > 0, `${definition.fileName}: inputModalities are required`);
    assert.ok(definition.outputModalities.length > 0, `${definition.fileName}: outputModalities are required`);
    assert.ok(definition.capabilities.length > 0, `${definition.fileName}: capabilities are required`);
    assert.ok(definition.sources.capabilities, `${definition.fileName}: sources.capabilities is required`);
    assert.ok(definition.sources.pricing, `${definition.fileName}: sources.pricing is required`);
    assertPricingConversions(definition.pricing, definition.fileName);
    for (const field of ["contextWindow", "maxInputTokens", "maxOutputTokens"]) {
      if (definition[field] != null) {
        assert.ok(
          Number.isSafeInteger(definition[field]) && definition[field] > 0,
          `${definition.fileName}: ${field} must be a positive safe integer`
        );
      }
    }
    if (definition.contextWindow != null) {
      for (const field of ["maxInputTokens", "maxOutputTokens"]) {
        if (definition[field] != null) {
          assert.ok(
            definition[field] <= definition.contextWindow,
            `${definition.fileName}: ${field} must not exceed contextWindow`
          );
        }
      }
    }
    if (["contextWindow", "maxInputTokens", "maxOutputTokens"].some((field) => definition[field] != null)) {
      assert.ok(definition.sources.limits, `${definition.fileName}: token limits require sources.limits`);
    }

    if (definition.pricing.tiers && definition.pricingCatalogEntry) {
      assert.equal(definition.pricingCatalogEntry.tiering.method, "whole-request");
      assert.equal(definition.pricingCatalogEntry.tiering.basis, "inputTokensIncludingCache");
      assert.deepEqual(
        definition.pricingCatalogEntry.tiers.map(({ promptTokensBelow, promptTokensAtLeast, inputPer1mTokens, cachedInputPer1mTokens, outputPer1mTokens }) =>
          ({ promptTokensBelow, promptTokensAtLeast, inputPer1mTokens, cachedInputPer1mTokens, outputPer1mTokens })),
        definition.pricing.tiers.map(({ promptTokensBelow, promptTokensAtLeast, inputPer1mTokens, cachedInputPer1mTokens, outputPer1mTokens }) =>
          ({ promptTokensBelow, promptTokensAtLeast, inputPer1mTokens, cachedInputPer1mTokens, outputPer1mTokens }))
      );
    } else if (definition.pricing.channels || definition.pricing.tiers) {
      assert.equal(
        definition.pricingCatalogEntry,
        null,
        `${definition.fileName}: reference-only channel or tier pricing requires pricingCatalogEntry: null`
      );
    }

    const hasRoutableInterface = definition.interfaces.some((protocol) => [
      "chat/completions",
      "responses",
      "messages",
      "images/generations",
      "images/edits",
      "audio/speech",
      "audio/transcriptions",
      "audio/translations",
      "realtime",
      "realtime/transcription_sessions",
      "realtime/translations"
    ].includes(protocol));
    assert.equal(
      definition.supportsProxyTemplate,
      !!(definition.proxyTemplate?.id && definition.proxyTemplate?.targetModel && hasRoutableInterface),
      `${definition.fileName}: supportsProxyTemplate must reflect the public proxy route surface`
    );

    if (definition.proxyTemplate) {
      assert.deepEqual(
        [...definition.proxyTemplate.capabilities].sort(),
        [...definition.capabilities].sort(),
        `${definition.fileName}: proxyTemplate capabilities must match root capabilities`
      );
    }
    if (definition.defaultInterface) {
      assert.ok(
        definition.interfaces.includes(definition.defaultInterface),
        `${definition.fileName}: defaultInterface must be declared in interfaces`
      );
    }
    for (const hostedInterfaces of Object.values(definition.interfacesByHostingMode)) {
      for (const protocol of hostedInterfaces) {
        assert.ok(definition.interfaces.includes(protocol), `${definition.fileName}: hosted interface ${protocol} is undeclared`);
      }
    }

    if (definition.capabilities.includes("reasoning")) {
      assert.ok(
        Object.values(definition.protocolProfiles).some(
          (profile) => profile.reasoning?.parameter
            || profile.reasoning?.configurable === false
            || profile.thinking?.parameter
        ),
        `${definition.fileName}: reasoning capability requires a protocol reasoning or thinking profile`
      );
    }
    if (definition.capabilities.includes("image-generation")) {
      assert.ok(
        definition.protocolProfiles["images/generations"]?.request,
        `${definition.fileName}: image-generation capability requires an images/generations request profile`
      );
    }
  }

  for (const id of [
    "glm-5.3", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "claude-fable-5-1", "claude-opus-5-5",
    "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "mai-image-2.6", "mai-image-2.6-flash",
    "deepseek-v4.1-flash", "glm-5.3-flash"
  ]) {
    assert.ok(ids.has(id), `missing bundled Model Catalog definition ${id}`);
  }
});

test("archived model cards stay outside the active Model Catalog", () => {
  const activeIds = new Set(listPricingDefinitions().map((definition) => definition.id.toLowerCase()));
  for (const archivedId of [
    "codex-mini",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "gpt-4o-mini",
    "gpt-4o-transcribe",
    "gpt-5-chat",
    "gpt-5.1-chat",
    "gpt-5.2-chat",
    "gpt-chat-latest",
    "gpt-image-1.5",
    "kimi-k2.7-code",
    "deepseek-v4-flash-0731",
    "deepseek-v4-pro-0813",
    "o1",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini"
  ]) {
    assert.equal(activeIds.has(archivedId), false, `${archivedId} must remain archived`);
  }
});

test("configured models can still resolve archived definitions at runtime", () => {
  const snapshot = compileModelCatalog({
    models: [{
      id: "legacy-model",
      pricingRef: "gpt-4o-mini"
    }]
  }, []);

  assert.equal(snapshot.descriptors[0].catalogId, "gpt-4o-mini");
  assert.equal(snapshot.descriptors[0].definition.status, "ga");
});

test("recent Fireworks profiles preserve catalog targets and serverless rates", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const expected = [
    ["DeepSeek-V4.1-Flash", "accounts/fireworks/models/deepseek-v4p1-flash", 0.3, 0.006, 1.2],
    ["glm-5.3-flash", "accounts/fireworks/models/glm-5p3-flash", 0.15, 0.03, 0.5]
  ];

  for (const [id, targetModel, input, cachedInput, output] of expected) {
    const definition = definitionsById.get(id);
    assert.equal(definition.provider, "fireworks-ai");
    assert.equal(definition.contextWindow, 1040000);
    assert.equal(definition.proxyTemplate.targetModel, targetModel);
    assert.equal(definition.pricing.sourceType, "fireworks-serverless");
    assert.equal(definition.pricing.inputPer1mTokens, input);
    assert.equal(definition.pricing.cachedInputPer1mTokens, cachedInput);
    assert.equal(definition.pricing.outputPer1mTokens, output);
  }
});

test("verified model cards preserve documented token limits without filling ambiguous cards", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const definitionsWithLimits = [...definitionsById.values()].filter((definition) => (
    ["contextWindow", "maxInputTokens", "maxOutputTokens"].some((field) => definition[field] != null)
  ));
  assert.equal(definitionsWithLimits.length, 62);

  for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol"]) {
    const definition = definitionsById.get(id);
    assert.equal(definition.contextWindow, 1050000);
    assert.equal(definition.maxInputTokens, 922000);
    assert.equal(definition.maxOutputTokens, 128000);
    assert.match(definition.sources.limits, /learn\.microsoft\.com/);
  }

  for (const id of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
    const definition = definitionsById.get(id);
    assert.equal(definition.contextWindow, 1047576);
    assert.equal(definition.maxOutputTokens, 32768);
    assert.equal(definition.maxInputTokens, null);
    assert.match(definition.sources.limits, /developers\.openai\.com/);
  }

  assert.equal(definitionsById.get("gpt-5-pro").contextWindow, 400000);
  assert.equal(definitionsById.get("gpt-5-pro").maxOutputTokens, 272000);
  assert.equal(definitionsById.get("grok-4.3").contextWindow, 1000000);
  assert.equal(definitionsById.get("grok-4.6").contextWindow, 500000);

  for (const id of [
    "DeepSeek-V4-Flash",
    "grok-4",
    "Kimi-K2.5"
  ]) {
    const definition = definitionsById.get(id);
    assert.deepEqual(
      [definition.contextWindow, definition.maxInputTokens, definition.maxOutputTokens],
      [null, null, null],
      `${id} must retain deployment-specific or ambiguous limits`
    );
  }
});

test("all active cards with unresolved token limits are explicitly reviewed", () => {
  const expectedUnresolvedIds = [
    "DeepSeek-V4-Flash",
    "flux-2-flex",
    "flux-2-pro",
    "gpt-4o-mini-transcribe",
    "gpt-4o-mini-tts",
    "gpt-4o-transcribe-diarize",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2",
    "gpt-realtime-translate",
    "gpt-realtime-whisper",
    "grok-4",
    "Kimi-K2.5",
    "mai-image-2.6-flash",
    "mai-image-2.6",
    "mai-transcribe-2",
    "mai-voice-2-flash",
    "mai-voice-2",
    "whisper-1"
  ].sort();
  const actualUnresolvedIds = listPricingDefinitions()
    .filter((definition) => (
      definition.contextWindow == null
      && definition.maxInputTokens == null
      && definition.maxOutputTokens == null
    ))
    .map((definition) => definition.id)
    .sort();

  assert.deepEqual(actualUnresolvedIds, expectedUnresolvedIds);
});

test("Claude cards preserve official release dates and token limits", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const expected = [
    ["claude-opus-4-6", "2026-02-05"],
    ["claude-opus-5", "2026-07-24"],
    ["claude-opus-5-5", "2026-09-22"],
    ["claude-sonnet-4-6", "2026-02-17"],
    ["claude-sonnet-5", "2026-06-30"]
  ];

  for (const [id, modelVersion] of expected) {
    const definition = definitionsById.get(id);
    assert.equal(definition.modelVersion, modelVersion);
    assert.equal(definition.contextWindow, 1000000);
    assert.equal(definition.maxOutputTokens, 128000);
  }
});

test("Claude Opus 5.5 card preserves native hosting, adaptive thinking, and published rates", () => {
  const definition = listPricingDefinitions().find((entry) => entry.id === "claude-opus-5-5");
  assert.ok(definition, "Claude Opus 5.5 must have a bundled model card");
  assert.equal(definition.provider, "anthropic");
  assert.equal(definition.status, "ga");
  assert.deepEqual(definition.hostingModes, ["azure", "anthropic"]);
  assert.equal(definition.defaultHostingMode, "azure");
  assert.deepEqual(definition.interfaces, ["messages"]);
  assert.deepEqual(definition.interfacesByHostingMode, {
    azure: ["messages"],
    anthropic: ["messages"]
  });
  assert.deepEqual(definition.inputModalities, ["text", "image"]);
  assert.deepEqual(definition.outputModalities, ["text"]);
  assert.deepEqual(definition.protocolProfiles.messages.thinking.types, ["adaptive"]);
  assert.equal(definition.protocolProfiles.messages.thinking.default, "adaptive");
  assert.deepEqual(definition.protocolProfiles.messages.reasoning.levels,
    ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(definition.protocolProfiles.messages.reasoning.default, "medium");
  assert.equal(definition.pricingCatalogEntry.currency, "USD");
  assert.deepEqual([
    definition.pricingCatalogEntry.inputPer1mTokens,
    definition.pricingCatalogEntry.cachedInputPer1mTokens,
    definition.pricingCatalogEntry.outputPer1mTokens
  ], [4, 0.2, 20]);
  assert.equal(definition.pricing.sourceType, "anthropic-official");
  assert.equal(definition.pricing.status, "published");
  assert.equal(definition.proxyTemplate.targetModel, "claude-opus-5-5");
  assert.equal(definition.proxyTemplate.pricingRef, "claude-opus-5-5");
  assert.deepEqual(definition.proxyTemplate.routes, {});

  const upstream = buildUpstreamFromPricingTemplate(definition, "claude");
  upstream.baseUrl = "https://example.openai.azure.com";
  for (const hostingMode of definition.hostingModes) {
    const model = {
      ...buildModelFromPricingTemplate(definition, upstream.name, { models: [] }),
      hostingMode
    };
    const snapshot = compileModelCatalog({ upstreams: [upstream], models: [model] }, [definition]);
    const descriptor = resolveModelDescriptor(model.id, snapshot);
    const plan = resolveRoutePlan({ routeKey: "messages", model, upstream, descriptor });
    assert.equal(plan.backendRouteKey, "messages");
    assert.equal(plan.targetUrl, "https://example.services.ai.azure.com/anthropic/v1/messages");
  }
});

test("new image model cards preserve deployment identities and native request parameters", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const expectedModels = [
    ["gpt-image-2.5-flare", "gpt-image-2.5-flare", "2026-09-09", "ga"],
    ["gpt-image-2.5-sunburst", "gpt-image-2.5-sunburst", "2026-09-09", "ga"],
    ["mai-image-2.6", "MAI-Image-2.6", "2026-07-31", "preview"],
    ["mai-image-2.6-flash", "MAI-Image-2.6-Flash", "2026-07-31", "preview"]
  ];
  for (const [id, targetModel, modelVersion, status] of expectedModels) {
    const definition = definitionsById.get(id);
    const isMai = id.startsWith("mai-");
    assert.equal(definition.proxyTemplate.targetModel, targetModel);
    assert.equal(definition.proxyTemplate.pricingRef, id);
    assert.deepEqual(definition.proxyTemplate.routes, isMai
      ? { "*": "mai-image", "images/edits": "mai-image-edits" } : { "*": "openai-image" });
    assert.equal(definition.modelVersion, modelVersion);
    assert.equal(definition.status, status);
    assert.equal(definition.pricing.status, "unavailable");
    assert.equal(definition.pricingCatalogEntry, null);
    assert.deepEqual(definition.capabilities, ["vision", "image-generation", "image-editing"]);
    const body = {
      model: targetModel,
      prompt: "A geometric poster",
      size: "1024x1024",
      ...(isMai ? { auto_aspect_ratio: true, web_grounding: true } : { quality: "max" })
    };
    const originalBody = structuredClone(body);
    const prepared = prepareImageGenerationRequest({
      body,
      model: definition.proxyTemplate,
      routeKey: "images/generations",
      backendRouteKey: "images/generations",
      targetUrl: isMai
        ? "https://example.services.ai.azure.com/mai/v1/images/generations"
        : `https://example.openai.azure.com/openai/deployments/${targetModel}/images/generations`
    });
    const expectedBody = { ...body };
    if (isMai) {
      delete expectedBody.size;
      expectedBody.width = 1024;
      expectedBody.height = 1024;
    } else {
      delete expectedBody.model;
    }
    assert.deepEqual(prepared, expectedBody, id);
    assert.deepEqual(body, originalBody, `${id}: caller body must not be mutated`);
  }
});

test("MAI image route plans use the Foundry provider endpoint", () => {
  const bundledDefinitions = listPricingDefinitions();
  for (const pricingRef of ["mai-image-2.6", "mai-image-2.6-flash"]) {
    const definition = bundledDefinitions.find((entry) => entry.id === pricingRef);
    const model = {
      ...definition.proxyTemplate,
      id: `public-${pricingRef}`,
      targetModel: "my-image-deployment",
      upstream: "azure"
    };
    const upstream = {
      ...config.upstreams[0],
      routes: {
        ...config.upstreams[0].routes,
        "openai-image": "/openai/deployments/{deployment}/images/generations?api-version=2025-04-01-preview"
      }
    };
    const snapshot = compileModelCatalog({ upstreams: [upstream], models: [model] }, bundledDefinitions);
    const descriptor = resolveModelDescriptor(model.id, snapshot);
    const plan = resolveRoutePlan({ routeKey: "images/generations", model, upstream, descriptor });
    assert.equal(plan.backendRouteKey, "images/generations");
    assert.equal(plan.targetUrl, "https://example.services.ai.azure.com/mai/v1/images/generations");
    assert.deepEqual(prepareImageGenerationRequest({
      body: { model: model.targetModel, prompt: "A poster", size: "1024x1024", web_grounding: true },
      model,
      descriptor,
      ...plan
    }), { model: model.targetModel, prompt: "A poster", width: 1024, height: 1024, web_grounding: true });
  }
});

test("Azure Foundry model profiles preserve deployment IDs and pricing sources", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const glm = definitionsById.get("glm-5.3");
  const gpt6 = definitionsById.get("gpt-6-astra");
  const fable = definitionsById.get("claude-fable-5-1");

  assert.equal(glm.proxyTemplate.targetModel, "FW-GLM-5.3");
  assert.deepEqual(glm.hostingModes, ["azure"]);
  assert.equal(glm.pricing.sourceType, "fireworks-serverless");
  assert.match(glm.sources.capabilities, /learn\.microsoft\.com\/azure\/foundry\/how-to\/fireworks/);
  assert.equal(glm.sources.azurePricing, "https://prices.azure.com/api/retail/prices");

  assert.equal(gpt6.modelVersion, "2026-09-03");
  assert.equal(gpt6.pricing.sourceType, "azure-openai-global");
  assert.ok(gpt6.protocolProfiles.responses.reasoning.levels.includes("none"));
  assert.match(gpt6.sources.capabilities, /learn\.microsoft\.com\/azure\/foundry/);

  assert.deepEqual(fable.hostingModes, ["anthropic"]);
  assert.match(fable.sources.capabilities, /learn\.microsoft\.com\/azure\/foundry/);
  assert.ok(fable.notes.some((note) => note.includes("Microsoft Foundry")));

  const expectedStandardPricing = {
    "gpt-5.6-luna": [0.2, 0.02, 1.2],
    "gpt-5.6-sol": [4, 0.4, 20],
    "gpt-5.6-terra": [2, 0.2, 12]
  };
  for (const [id, expected] of Object.entries(expectedStandardPricing)) {
    const definition = definitionsById.get(id);
    assert.equal(definition.pricing.sourceType, "openai-official", `${id}: Standard pricing source`);
    assert.equal(definition.sources.pricing, "https://developers.openai.com/api/docs/pricing");
    assert.deepEqual([
      definition.pricing.tiers[0].inputPer1mTokens,
      definition.pricing.tiers[0].cachedInputPer1mTokens,
      definition.pricing.tiers[0].outputPer1mTokens
    ], expected, `${id}: Standard short-context pricing`);
  }
});

test("GPT-6 cards preserve the published Global Standard short/long-context prices", () => {
  const definitionsById = new Map(listPricingDefinitions().map((definition) => [definition.id, definition]));
  const expectedPrices = {
    "gpt-6-astra": [
      ["global-standard", "short", 10, 1, 12.5, 50],
      ["global-standard", "long", 20, 2, 25, 75]
    ],
    "gpt-6-sol": [
      ["global-standard", "short", 2, 0.2, 2.5, 10],
      ["global-standard", "long", 4, 0.4, 5, 15]
    ],
    "gpt-6-luna": [
      ["global-standard", "short", 0.1, 0.01, 0.125, 0.5],
      ["global-standard", "long", 0.2, 0.02, 0.25, 0.75]
    ]
  };

  for (const [id, expected] of Object.entries(expectedPrices)) {
    const definition = definitionsById.get(id);
    assert.equal(definition.pricing.currency, "USD");
    assert.equal(definition.pricing.billingUnit, "1M tokens");
    assert.equal(definition.pricing.sourceType, "azure-openai-global");
    assert.equal(definition.pricing.status, "published");
    assert.deepEqual([
      definition.pricing.tiers[0].inputPer1mTokens,
      definition.pricing.tiers[0].cachedInputPer1mTokens,
      definition.pricing.tiers[0].cacheWritePer1mTokens,
      definition.pricing.tiers[0].outputPer1mTokens
    ], expected[0].slice(2), `${id}: Global Standard short-context rates`);
    assert.deepEqual(definition.pricing.tiers.map((tier) => [
      tier.deploymentType,
      tier.contextClass,
      tier.inputPer1mTokens,
      tier.cachedInputPer1mTokens,
      tier.cacheWritePer1mTokens,
      tier.outputPer1mTokens
    ]), expected, `${id}: all published per-million-token rates`);
    assert.deepEqual(definition.pricingCatalogEntry.tiering,
      { basis: "inputTokensIncludingCache", method: "whole-request" });
    assert.deepEqual(definition.pricingCatalogEntry.tiers.map((tier) => [
      tier.id, tier.promptTokensBelow ?? null, tier.promptTokensAtLeast ?? null,
      tier.inputPer1mTokens, tier.cachedInputPer1mTokens, tier.cacheWritePer1mTokens, tier.outputPer1mTokens
    ]), expected.map((row, index) => [index === 0 ? "short <=272K" : "long >272K", index === 0 ? 272001 : null, index === 1 ? 272001 : null, ...row.slice(2)]),
    `${id}: import the full whole-request policy, including cache-write rates`);
    assert.equal(
      definition.sources.pricing,
      "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    );
  }
});

test("active context-tier cards expose descriptive IDs with exact GPT and Grok boundaries", () => {
  const tiered = listPricingDefinitions().filter(definition => definition.pricing?.tiering);
  assert.equal(tiered.length, 11);
  for (const definition of tiered) {
    const grok = definition.id.startsWith("grok-");
    const threshold = grok ? 200000 : 272001;
    assert.deepEqual(definition.pricing.tiers.map(tier => tier.id),
      grok ? ["short <200K", "long >=200K"] : ["short <=272K", "long >272K"], definition.id);
    assert.equal(definition.pricing.tiers[0].promptTokensBelow, threshold, definition.id);
    assert.equal(definition.pricing.tiers[1].promptTokensAtLeast, threshold, definition.id);
  }
});

test("GPT-6 Luna and Sol cards retain native routes and verified model pricing", () => {
  const bundledDefinitions = listPricingDefinitions();
  for (const id of ["gpt-6-luna", "gpt-6-sol"]) {
    const definition = bundledDefinitions.find((entry) => entry.id === id);
    assert.ok(definition, `${id}: bundled card`);
    assert.equal(definition.modelVersion, "2026-09-22");
    assert.equal(definition.status, "ga");
    assert.deepEqual(definition.interfaces, ["chat/completions", "responses"]);
    assert.equal(definition.defaultInterface, "responses");
    assert.deepEqual(definition.inputModalities, ["text", "image"]);
    assert.deepEqual(definition.outputModalities, ["text"]);
    assert.deepEqual(definition.protocolProfiles["chat/completions"].reasoning.levels,
      ["none", "low", "medium", "high", "xhigh"]);
    assert.deepEqual(definition.protocolProfiles.responses.reasoning.levels,
      ["none", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(definition.proxyTemplate.targetModel, id);
    assert.equal(definition.proxyTemplate.pricingRef, id);
    assert.deepEqual(definition.proxyTemplate.routes, {});

    const model = { ...definition.proxyTemplate, upstream: "azure" };
    const snapshot = compileModelCatalog({ upstreams: config.upstreams, models: [model] }, bundledDefinitions);
    const descriptor = resolveModelDescriptor(id, snapshot);
    for (const routeKey of definition.interfaces) {
      const plan = resolveRoutePlan({ routeKey, model, upstream: config.upstreams[0], descriptor });
      assert.equal(plan.backendRouteKey, routeKey);
      assert.equal(plan.targetUrl, `https://example.openai.azure.com/openai/v1/${routeKey}`);
    }
  }
});

test("GPT-5.6 Standard cards match the supplied short/long cache-write price table", () => {
  const definitionsById = new Map(listPricingDefinitions().map((entry) => [entry.id, entry]));
  const priceFields = ["inputPer1mTokens", "cachedInputPer1mTokens", "cacheWritePer1mTokens", "outputPer1mTokens"];
  for (const [id, expected] of [
    ["gpt-5.6-sol", [[4, 0.4, 5, 20], [8, 0.8, 10, 30]]],
    ["gpt-5.6-terra", [[2, 0.2, 2.5, 12], [4, 0.4, 5, 18]]],
    ["gpt-5.6-luna", [[0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]]]
  ]) {
    const definition = definitionsById.get(id);
    assert.deepEqual(priceFields.map((field) => definition.pricing.tiers[0][field]), expected[0], id);
    for (const pricing of [definition.pricing, definition.pricingCatalogEntry]) {
      assert.deepEqual(pricing.tiering, { basis: "inputTokensIncludingCache", method: "whole-request" });
      assert.deepEqual(pricing.tiers.map((tier) => priceFields.map((field) => tier[field])), expected, id);
      assert.equal(pricing.tiers[0].promptTokensBelow, 272001);
      assert.equal(pricing.tiers[1].promptTokensAtLeast, 272001);
    }
  }
});

test("MAI routing preserves legacy bindings and explicit upstream overrides", () => {
  const bundledDefinitions = listPricingDefinitions();
  const definition = bundledDefinitions.find((entry) => entry.id === "mai-image-2.6");
  for (const scenario of [
    { routes: {}, expected: "https://example.services.ai.azure.com/mai/v1/images/generations" },
    { routes: { "openai-image": "/openai/v1/images/generations" }, expected: "https://example.services.ai.azure.com/mai/v1/images/generations" },
    { routes: { "openai-image": "/mai/v1/images/generations?custom=1" }, expected: "https://example.services.ai.azure.com/mai/v1/images/generations?custom=1" },
    { routes: { "mai-image": "/custom/images/generations" }, expected: "https://example.services.ai.azure.com/custom/images/generations" },
    { routes: {}, hostType: "openai", expected: "https://example.openai.azure.com/mai/v1/images/generations" },
    { routes: {}, baseUrl: "https://gateway.example/", expected: "https://gateway.example/mai/v1/images/generations" }
  ]) {
    const model = { ...definition.proxyTemplate, upstream: "azure", routes: { "*": "openai-image" } };
    const upstream = { ...config.upstreams[0], ...scenario };
    const snapshot = compileModelCatalog({ upstreams: [upstream], models: [model] }, bundledDefinitions);
    const descriptor = resolveModelDescriptor(model.id, snapshot);
    assert.equal(resolveRoutePlan({ routeKey: "images/generations", model, upstream, descriptor }).targetUrl, scenario.expected);
    assert.deepEqual(getConfiguredModelBindingIssues({ upstreams: [upstream], models: [model] }, snapshot), []);
  }
});

test("MAI pricing templates produce dedicated upstream and model routes", () => {
  for (const definition of listPricingDefinitions().filter((entry) => entry.id.startsWith("mai-image-"))) {
    const upstream = buildUpstreamFromPricingTemplate(definition, "mai");
    const model = buildModelFromPricingTemplate(definition, "mai", { models: [] });
    assert.equal(upstream.routes["mai-image"], "/mai/v1/images/generations");
    assert.equal(model.routes["*"], "mai-image");
    assert.equal(upstream.routes["chat/completions"], "/openai/v1/chat/completions");
  }
});

test("MAI Thinking templates and default route use the native Foundry Chat endpoint", () => {
  const bundledDefinitions = listPricingDefinitions();
  const definition = bundledDefinitions.find((entry) => entry.id === "mai-thinking-1");
  assert.ok(definition, "MAI Thinking must have a bundled model card");
  assert.deepEqual(definition.interfaces, ["chat/completions"]);
  const template = buildUpstreamFromPricingTemplate(definition, "mai");
  assert.equal(template.routes["mai-chat"], "/mai/v1/chat/completions");
  for (const routes of [definition.proxyTemplate.routes, {}]) {
    const model = { ...definition.proxyTemplate, upstream: "azure", targetModel: "reasoning-deployment", routes };
    const upstream = config.upstreams[0];
    const snapshot = compileModelCatalog({ upstreams: [upstream], models: [model] }, bundledDefinitions);
    const descriptor = resolveModelDescriptor(model.id, snapshot);
    const plan = resolveRoutePlan({ routeKey: "chat/completions", model, upstream, descriptor });
    assert.equal(plan.targetUrl, "https://example.services.ai.azure.com/mai/v1/chat/completions");
    assert.equal(plan.backendRouteKey, "chat/completions");
    const explicit = resolveRoutePlan({ routeKey: "chat/completions", model: { ...model, routes: { "*": "chat/completions" } }, upstream, descriptor });
    assert.equal(explicit.targetUrl, "https://example.openai.azure.com/openai/v1/chat/completions");
  }
});

test("MAI Speech templates select native paths without OpenAI deployment routing", () => {
  const bundledDefinitions = listPricingDefinitions();
  for (const id of ["mai-voice-2", "mai-voice-2-flash", "mai-transcribe-2"]) {
    const definition = bundledDefinitions.find(entry => entry.id === id);
    const routeKey = definition.interfaces[0];
    const expectedPath = routeKey === "audio/speech" ? "/cognitiveservices/v1"
      : "/speechtotext/transcriptions:transcribe?api-version=2025-10-15";
    const template = buildUpstreamFromPricingTemplate(definition, "speech");
    assert.equal(template.routes[definition.proxyTemplate.routes[routeKey]], expectedPath);
    for (const routes of [definition.proxyTemplate.routes, {}]) {
      const model = { ...definition.proxyTemplate, upstream: "speech", routes };
      const upstream = { ...template, name: "speech", baseUrl: "https://resource.cognitiveservices.azure.com", routes: {} };
      const snapshot = compileModelCatalog({ upstreams: [upstream], models: [model] }, bundledDefinitions);
      const descriptor = resolveModelDescriptor(model.id, snapshot);
      const plan = resolveRoutePlan({ routeKey, model, upstream, descriptor });
      assert.equal(plan.targetUrl, `https://resource.cognitiveservices.azure.com${expectedPath}`);
      assert.equal(plan.backendRouteKey, routeKey);
      assert.deepEqual(descriptor.proxyAdapters, { responses: routeKey === "audio/speech" ? "azure-speech-synthesize" : "azure-speech-transcribe" });
      assert.equal(descriptor.interfaces.includes("responses"), false);
      assert.equal(definition.pricingCatalogEntry, null);
    }
  }
});

test("Realtime templates bind OpenAI native paths and retain explicit Azure GA overrides", () => {
  const definitions = listPricingDefinitions();
  for (const [id, routeKey, pathname] of [
    ["gpt-realtime-2", "realtime", "/v1/realtime"],
    ["gpt-realtime-whisper", "realtime/transcription_sessions", "/v1/realtime"],
    ["gpt-realtime-translate", "realtime/translations", "/v1/realtime/translations"]
  ]) {
    const definition = definitions.find(item => item.id === id);
    const upstream = buildUpstreamFromPricingTemplate(definition, "voice-provider");
    upstream.baseUrl = "https://api.openai.com";
    const model = buildModelFromPricingTemplate(definition, upstream.name, { models: [] });
    model.id = `public-${id}`;
    model.targetModel = "deployment";
    const config = { upstreams: [upstream], models: [model] };
    installModelCatalogSnapshot(compileModelCatalog(config, definitions));
    const transcription = routeKey === "realtime/transcription_sessions";
    const binding = resolveRealtimeBinding(config, {}, model.id, routeKey, transcription);
    assert.equal(binding.targetUrl.toString(), `wss://api.openai.com${pathname}?${transcription ? "intent=transcription" : "model=deployment"}`);
    upstream.provider = "azure-openai";
    upstream.baseUrl = "https://example.openai.azure.com";
    upstream.routes[routeKey] = `/openai${pathname}${transcription ? "?intent=transcription" : ""}`;
    const azure = resolveRealtimeBinding(config, {}, model.id, routeKey, transcription);
    assert.equal(azure.targetUrl.toString(), `wss://example.openai.azure.com/openai${pathname}?${transcription ? "intent=transcription" : "model=deployment"}`);
  }
});

test("Model Catalog compiler resolves exact model facts and protocol defaults", () => {
  const snapshot = compileModelCatalog(config, definitions);
  installModelCatalogSnapshot(snapshot);

  const matched = resolveModelDescriptor("public-gpt", snapshot);
  assert.equal(matched.catalogMatched, true);
  assert.equal(matched.catalogId, "gpt-special");
  assert.equal(matched.defaultInterface, "responses");
  assert.deepEqual(matched.capabilities, ["reasoning", "vision"]);
  assert.deepEqual(matched.tokenLimits, {
    contextWindow: 1050000,
    maxInputTokens: 922000,
    maxOutputTokens: 128000
  });
  assert.deepEqual(getDescriptorProtocolProfile(matched, "responses").reasoning.levels, ["low", "medium", "high", "xhigh"]);
  assert.equal(resolveModelDescriptor("gpt-special-alias", snapshot), matched);

  const unknown = resolveModelDescriptor("unknown-model", snapshot);
  assert.equal(unknown.catalogMatched, false);
  assert.deepEqual(unknown.tokenLimits, {
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null
  });
  assert.equal(getDescriptorProtocolProfile(unknown, "responses"), getDefaultProtocolProfile("responses"));
  assert.ok(snapshot.generation > 0);
  assert.equal(snapshot.modelCount, 2);
});

test("invalid proxy adapters cannot activate a catalog or masquerade as native interfaces", () => {
  const snapshot = installModelCatalogSnapshot(compileModelCatalog(config, definitions));
  const transaction = createModelCatalogSyncTransaction(() => config, getConfiguredModelBindingIssues);
  for (const proxyAdapters of [[], "speech", { responses: "https://external.example" }, { messages: "azure-speech-transcribe" },
    { responses: "azure-speech-transcribe" }, { responses: "azure-speech-synthesize" }]) {
    assert.throws(() => transaction.prepare([{ ...definitions[0], proxyAdapters }]), /proxyAdapters/);
    assert.equal(resolveModelDescriptor("public-gpt"), resolveModelDescriptor("public-gpt", snapshot));
  }
});

test("Model Catalog compiler rejects ambiguous aliases", () => {
  assert.throws(() => compileModelCatalog(config, [
    { ...definitions[0], id: "first", aliases: ["shared"] },
    { ...definitions[0], id: "second", aliases: ["shared"] }
  ]), /alias collision for shared/);
});

test("Model Catalog compiler rejects inconsistent token limits", () => {
  assert.throws(
    () => compileModelCatalog(config, [{
      ...definitions[0],
      contextWindow: 128000,
      maxInputTokens: 256000
    }]),
    /maxInputTokens must not exceed contextWindow/
  );
});

test("Model Catalog digest is deterministic across definition order", () => {
  const first = { ...definitions[0], id: "first", aliases: [] };
  const second = { ...definitions[0], id: "second", aliases: [] };
  const left = compileModelCatalog(config, [first, second]);
  const right = compileModelCatalog(config, [second, first]);
  assert.equal(left.sourceDigest, right.sourceDigest);
});

test("Model Catalog sync validates candidates and commits against the latest config", () => {
  let currentConfig = {
    ...config,
    models: [config.models[0]]
  };
  const transaction = createModelCatalogSyncTransaction(
    () => currentConfig,
    getConfiguredModelBindingIssues
  );
  const prepared = transaction.prepare(definitions);

  currentConfig = {
    ...config,
    models: [{ id: "latest-public-gpt", targetModel: "gpt-special", pricingRef: "gpt-special", upstream: "azure" }]
  };
  const snapshot = transaction.commit(prepared);

  assert.equal(resolveModelDescriptor("public-gpt", snapshot), null);
  assert.equal(resolveModelDescriptor("latest-public-gpt", snapshot)?.catalogId, "gpt-special");
});

test("model binding validation uses the candidate catalog snapshot", () => {
  const candidateConfig = {
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
  const candidateSnapshot = compileModelCatalog(candidateConfig, [{
    id: "candidate-image",
    provider: "black-forest-labs",
    interfaces: ["images/generations"],
    capabilities: ["image-generation"]
  }]);

  assert.match(
    getConfiguredModelBindingIssues(candidateConfig, candidateSnapshot)[0]?.message || "",
    /route target "openai-image".*candidate-image/
  );
});

test("model route bindings are constrained by their Catalog definition", () => {
  const routeConfig = {
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        responses: "/openai/v1/responses",
        messages: "/openai/v1/messages",
        "images/generations": "/openai/v1/images/generations",
        "openai-image": "/openai/deployments/{deployment}/images/generations",
        "audio/transcriptions": "/openai/v1/audio/transcriptions"
      }
    }],
    models: [
      {
        id: "unknown-public",
        pricingRef: "missing-catalog-model",
        upstream: "azure",
        routes: {}
      },
      {
        id: "text-public",
        pricingRef: "catalog-text",
        upstream: "azure",
        routes: { "chat/completions": "messages" }
      },
      {
        id: "typo-source-public",
        pricingRef: "catalog-text",
        upstream: "azure",
        routes: { responsez: "responses" }
      },
      {
        id: "direct-path-public",
        pricingRef: "catalog-text",
        upstream: "azure",
        routes: { responses: "/openai/v1/responses" }
      },
      {
        id: "image-public",
        pricingRef: "catalog-image",
        upstream: "azure",
        routes: { "images/generations": "openai-image" }
      },
      {
        id: "audio-public",
        pricingRef: "catalog-audio",
        upstream: "azure",
        routes: { "audio/transcriptions": "audio/transcriptions" }
      },
      {
        id: "hosted-audio-public",
        pricingRef: "catalog-hosted-audio",
        hostingMode: "azure",
        upstream: "azure",
        routes: { "audio/transcriptions": "audio/transcriptions" }
      },
      {
        id: "mixed-public",
        pricingRef: "catalog-mixed",
        upstream: "azure",
        routes: { "images/generations": "responses" }
      }
    ]
  };
  const routeDefinitions = [
    {
      id: "catalog-text",
      provider: "azure-openai",
      interfaces: ["chat/completions", "responses"],
      defaultInterface: "responses",
      capabilities: ["reasoning"]
    },
    {
      id: "catalog-image",
      provider: "azure-openai",
      interfaces: ["images/generations"],
      capabilities: ["image-generation"],
      proxyTemplate: { routes: { "*": "openai-image" } }
    },
    {
      id: "catalog-audio",
      provider: "azure-openai",
      interfaces: ["audio/transcriptions"],
      capabilities: ["transcription"]
    },
    {
      id: "catalog-hosted-audio",
      provider: "custom",
      interfaces: ["realtime"],
      interfacesByHostingMode: { azure: ["audio/transcriptions"] },
      capabilities: ["transcription"]
    },
    {
      id: "catalog-mixed",
      provider: "azure-openai",
      interfaces: ["images/generations", "responses"],
      capabilities: ["image-generation", "reasoning"]
    }
  ];
  const snapshot = compileModelCatalog(routeConfig, routeDefinitions);
  const issues = getConfiguredModelBindingIssues(routeConfig, snapshot);

  assert.match(
    issues.find((issue) => issue.modelId === "unknown-public")?.message || "",
    /missing-catalog-model.*Model Catalog/
  );
  assert.match(
    issues.find((issue) => issue.modelId === "text-public")?.message || "",
    /route target "messages".*catalog-text.*chat\/completions.*responses/
  );
  assert.match(
    issues.find((issue) => issue.modelId === "typo-source-public")?.message || "",
    /route source "responsez".*Model Catalog/
  );
  assert.match(
    issues.find((issue) => issue.modelId === "direct-path-public")?.message || "",
    /route target "\/openai\/v1\/responses".*catalog-text/
  );
  assert.equal(issues.some((issue) => issue.modelId === "image-public"), false);
  assert.equal(issues.some((issue) => issue.modelId === "audio-public"), false);
  assert.equal(issues.some((issue) => issue.modelId === "hosted-audio-public"), false);
  assert.match(
    issues.find((issue) => issue.modelId === "mixed-public")?.message || "",
    /does not support route conversion from images\/generations to responses/
  );

  const upstream = routeConfig.upstreams[0];
  assert.throws(() => resolveRoutePlan({
    routeKey: "chat/completions",
    model: routeConfig.models.find((model) => model.id === "text-public"),
    upstream,
    descriptor: resolveModelDescriptor("text-public", snapshot)
  }), /does not allow route target messages/);
  assert.throws(() => resolveRoutePlan({
    routeKey: "responses",
    model: routeConfig.models.find((model) => model.id === "direct-path-public"),
    upstream,
    descriptor: resolveModelDescriptor("direct-path-public", snapshot)
  }), /Direct model route paths are not supported/);
  assert.throws(() => resolveRoutePlan({
    routeKey: "images/generations",
    model: routeConfig.models.find((model) => model.id === "mixed-public"),
    upstream,
    descriptor: resolveModelDescriptor("mixed-public", snapshot)
  }), /does not support route conversion from images\/generations to responses/);
});

test("model validation skips probes for Catalog interfaces without a probe payload", async () => {
  const audioConfig = {
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: { "audio/transcriptions": "/openai/v1/audio/transcriptions" }
    }],
    models: [{
      id: "audio-public",
      pricingRef: "catalog-audio",
      upstream: "azure"
    }]
  };
  installModelCatalogSnapshot(compileModelCatalog(audioConfig, [{
    id: "catalog-audio",
    provider: "azure-openai",
    interfaces: ["audio/transcriptions"],
    capabilities: ["transcription"]
  }]));
  const previousFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(null, { status: 200 });
  };

  try {
    const result = await validateConfiguredModels(audioConfig, { probe: true });
    assert.equal(result.items[0]?.state, "skipped");
    assert.equal(result.items[0]?.probe?.errorCode, "MODEL_VALIDATION_PROBE_UNSUPPORTED");
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("final upstream URLs cannot resolve outside the model Catalog interfaces", () => {
  const mismatchConfig = {
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: { responses: "/openai/v1/chat/completions" }
    }],
    models: [{
      id: "responses-only-public",
      pricingRef: "responses-only",
      upstream: "azure"
    }]
  };
  const snapshot = compileModelCatalog(mismatchConfig, [
    {
      id: "responses-only",
      provider: "azure-openai",
      interfaces: ["responses"],
      capabilities: ["reasoning"]
    },
    {
      id: "foreign-nested-interface",
      provider: "custom",
      interfaces: ["vendor/responses"],
      capabilities: []
    }
  ]);

  assert.match(
    getConfiguredModelBindingIssues(mismatchConfig, snapshot)[0]?.message || "",
    /responses-only.*final backend route chat\/completions.*allowed interfaces: responses/
  );

  const foreignSuffixConfig = structuredClone(mismatchConfig);
  foreignSuffixConfig.upstreams[0].routes.responses = "/v1/vendor/responses";
  const foreignSuffixSnapshot = compileModelCatalog(foreignSuffixConfig, [
    {
      id: "responses-only",
      provider: "azure-openai",
      interfaces: ["responses"],
      capabilities: ["reasoning"]
    },
    {
      id: "foreign-nested-interface",
      provider: "custom",
      interfaces: ["vendor/responses"],
      capabilities: []
    }
  ]);
  assert.match(
    getConfiguredModelBindingIssues(foreignSuffixConfig, foreignSuffixSnapshot)[0]?.message || "",
    /responses-only.*final backend route vendor\/responses.*allowed interfaces: responses/
  );

  const partialMismatchConfig = {
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: {
        "chat/completions": "/openai/v1/unknown-chat",
        responses: "/openai/v1/responses"
      }
    }],
    models: [{
      id: "dual-public",
      pricingRef: "dual-model",
      upstream: "azure"
    }]
  };
  const partialSnapshot = compileModelCatalog(partialMismatchConfig, [{
    id: "dual-model",
    provider: "azure-openai",
    interfaces: ["chat/completions", "responses"],
    defaultInterface: "responses",
    capabilities: ["reasoning"]
  }]);

  assert.match(
    getConfiguredModelBindingIssues(partialMismatchConfig, partialSnapshot)[0]?.message || "",
    /chat\/completions.*final backend route unknown/
  );

  const nestedInterfaceConfig = {
    upstreams: [{
      name: "custom",
      provider: "custom",
      baseUrl: "https://example.test/",
      routes: { "vendor/responses": "/v1/vendor/responses" }
    }],
    models: [{
      id: "nested-interface-public",
      pricingRef: "nested-interface",
      upstream: "custom"
    }]
  };
  const nestedInterfaceSnapshot = compileModelCatalog(nestedInterfaceConfig, [{
    id: "nested-interface",
    provider: "custom",
    interfaces: ["vendor/responses"],
    capabilities: []
  }]);
  const nestedDescriptor = resolveModelDescriptor("nested-interface-public", nestedInterfaceSnapshot);

  assert.equal(getConfiguredModelBindingIssues(nestedInterfaceConfig, nestedInterfaceSnapshot).length, 0);
  assert.equal(resolveRoutePlan({
    routeKey: "vendor/responses",
    model: nestedInterfaceConfig.models[0],
    upstream: nestedInterfaceConfig.upstreams[0],
    descriptor: nestedDescriptor
  }).backendRouteKey, "vendor/responses");
});

test("fallback routing honors the catalog default interface", () => {
  const routeConfig = {
    upstreams: [{ name: "azure", provider: "azure-openai" }],
    models: [{ id: "dual-protocol", pricingRef: "dual-protocol", upstream: "azure" }]
  };
  const snapshot = compileModelCatalog(routeConfig, [{
    id: "dual-protocol",
    provider: "azure-openai",
    interfaces: ["chat/completions", "responses"],
    defaultInterface: "chat/completions",
    capabilities: ["reasoning"]
  }]);
  const descriptor = resolveModelDescriptor("dual-protocol", snapshot);

  assert.equal(
    resolveEffectiveRouteKey("messages", routeConfig.models[0], routeConfig.upstreams[0], null, descriptor),
    "chat/completions"
  );

  const hostedConfig = {
    upstreams: [{ name: "azure", provider: "azure-openai" }],
    models: [{ id: "hosted-model", pricingRef: "hosted-model", upstream: "azure" }]
  };
  const hostedSnapshot = compileModelCatalog(hostedConfig, [{
    id: "hosted-model",
    provider: "custom",
    defaultHostingMode: "azure",
    interfaces: ["chat/completions", "messages"],
    interfacesByHostingMode: { azure: ["messages"] },
    defaultInterface: "messages",
    capabilities: ["reasoning"]
  }]);
  const hostedDescriptor = resolveModelDescriptor("hosted-model", hostedSnapshot);
  assert.equal(hostedDescriptor.hostingMode, "azure");
  assert.deepEqual(hostedDescriptor.interfaces, ["messages"]);
  assert.equal(
    resolveEffectiveRouteKey("chat/completions", hostedConfig.models[0], hostedConfig.upstreams[0], null, hostedDescriptor),
    "messages"
  );
});

test("bundled Model Router preserves native Chat and Responses routes", () => {
  const definition = listPricingDefinitions().find((item) => item.id === "model-router");
  assert.ok(definition, "Expected bundled model-router definition");
  assert.deepEqual(definition.interfaces, ["chat/completions", "responses"]);
  assert.deepEqual(definition.proxyTemplate?.routes, { messages: "chat/completions" });

  const routeConfig = {
    upstreams: [{
      name: "azure",
      provider: "azure-openai",
      baseUrl: "https://example.openai.azure.com/",
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        responses: "/openai/v1/responses"
      }
    }],
    models: [{
      id: "model-router",
      targetModel: "model-router",
      pricingRef: "model-router",
      upstream: "azure",
      routes: { messages: "chat/completions" }
    }]
  };
  const snapshot = compileModelCatalog(routeConfig, [definition]);
  const descriptor = resolveModelDescriptor("model-router", snapshot);

  const chatPlan = resolveRoutePlan({
    routeKey: "chat/completions",
    model: routeConfig.models[0],
    upstream: routeConfig.upstreams[0],
    descriptor
  });
  assert.equal(chatPlan.backendRouteKey, "chat/completions");
  assert.equal(new URL(chatPlan.targetUrl).pathname, "/openai/v1/chat/completions");

  const responsesPlan = resolveRoutePlan({
    routeKey: "responses",
    model: routeConfig.models[0],
    upstream: routeConfig.upstreams[0],
    descriptor
  });
  assert.equal(responsesPlan.backendRouteKey, "responses");
  assert.equal(new URL(responsesPlan.targetUrl).pathname, "/openai/v1/responses");

  const messagesPlan = resolveRoutePlan({
    routeKey: "messages",
    model: routeConfig.models[0],
    upstream: routeConfig.upstreams[0],
    descriptor
  });
  assert.equal(messagesPlan.backendRouteKey, "chat/completions");

  routeConfig.models[0].routes = {};
  const nativeChatPlan = resolveRoutePlan({
    routeKey: "chat/completions",
    model: routeConfig.models[0],
    upstream: routeConfig.upstreams[0],
    descriptor
  });
  const nativeResponsesPlan = resolveRoutePlan({
    routeKey: "responses",
    model: routeConfig.models[0],
    upstream: routeConfig.upstreams[0],
    descriptor
  });
  assert.equal(nativeChatPlan.backendRouteKey, "chat/completions");
  assert.equal(nativeResponsesPlan.backendRouteKey, "responses");
});

test("request converters honor catalog parameter paths, aliases, and thinking defaults", () => {
  const conversionConfig = {
    upstreams: [{ name: "provider", provider: "custom" }],
    models: [{ id: "custom-reasoning", pricingRef: "custom-reasoning", upstream: "provider" }]
  };
  const snapshot = compileModelCatalog(conversionConfig, [{
    id: "custom-reasoning",
    provider: "custom",
    interfaces: ["chat/completions", "responses", "messages"],
    capabilities: ["reasoning"],
    protocolProfiles: {
      "chat/completions": {
        reasoning: { parameter: "vendor.effort", aliases: { turbo: "xhigh" } }
      },
      responses: {
        reasoning: { parameter: "analysis.depth", aliases: { xhigh: "max" } }
      },
      messages: {
        reasoning: { parameter: "output_config.effort", aliases: { xhigh: "max" } },
        thinking: { parameter: "thinking.type", default: "adaptive" }
      }
    }
  }]);
  const descriptor = resolveModelDescriptor("custom-reasoning", snapshot);

  const responsesRequest = chatToResponsesRequest({
    messages: [{ role: "user", content: "hello" }],
    vendor: { effort: "TURBO" }
  }, "custom-deployment", descriptor);
  assert.equal(responsesRequest.analysis.depth, "max");
  assert.equal("vendor" in responsesRequest, false);

  const messagesRequest = responsesToMessagesRequest({
    input: "hello",
    analysis: { depth: "XHIGH" }
  }, "custom-deployment", descriptor);
  assert.deepEqual(messagesRequest.output_config, { effort: "max" });
  assert.deepEqual(messagesRequest.thinking, { type: "adaptive" });
  assert.equal("analysis" in messagesRequest, false);
});

test("request converters omit effort for fixed non-configurable reasoning", () => {
  const conversionConfig = {
    upstreams: [{ name: "provider", provider: "custom" }],
    models: [{ id: "fixed-reasoning", pricingRef: "fixed-reasoning", upstream: "provider" }]
  };
  const snapshot = compileModelCatalog(conversionConfig, [{
    id: "fixed-reasoning",
    provider: "custom",
    interfaces: ["chat/completions", "responses"],
    capabilities: ["reasoning"],
    protocolProfiles: {
      "chat/completions": {
        reasoning: { configurable: false, default: "medium" }
      },
      responses: {
        reasoning: { configurable: false, default: "medium" }
      }
    }
  }]);
  const descriptor = resolveModelDescriptor("fixed-reasoning", snapshot);

  const request = chatToResponsesRequest({
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high"
  }, "fixed-deployment", descriptor);

  assert.equal("reasoning" in request, false);
  assert.equal("reasoning_effort" in request, false);
});

test("request converters do not inject an omitted thinking default", () => {
  const conversionConfig = {
    upstreams: [{ name: "provider", provider: "custom" }],
    models: [{ id: "manual-thinking", pricingRef: "manual-thinking", upstream: "provider" }]
  };
  const snapshot = compileModelCatalog(conversionConfig, [{
    id: "manual-thinking",
    provider: "custom",
    interfaces: ["responses", "messages"],
    capabilities: ["reasoning"],
    protocolProfiles: {
      responses: {
        reasoning: { parameter: "reasoning.effort" }
      },
      messages: {
        thinking: {
          parameter: "thinking.type",
          types: ["enabled", "disabled"],
          validation: "strict"
        }
      }
    }
  }]);
  const descriptor = resolveModelDescriptor("manual-thinking", snapshot);

  const request = responsesToMessagesRequest({
    input: "hello",
    reasoning: { effort: "high" }
  }, "manual-deployment", descriptor);

  assert.equal("thinking" in request, false);
});

test("governance respects explicit non-token pricing while retaining legacy token fallback", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 };
  const model = { id: "governance-model", targetModel: "governance-model", pricingRef: "governance-model" };
  const config = { access: { budgets: { defaultCurrency: "USD" } } };
  const explicitNonToken = recordGovernanceUsage(
    config,
    { keyId: "catalog-explicit-non-token", apiKey: {} },
    model,
    usage,
    Date.now(),
    "",
    {
      modelDescriptor: {
        definition: {
          id: "governance-model",
          pricingCatalogEntry: null,
          pricing: { inputPer1kTokens: 1, outputPer1kTokens: 2 }
        }
      }
    }
  );
  assert.equal(explicitNonToken.configured, false);
  assert.equal(explicitNonToken.amount, 0);

  const legacyToken = recordGovernanceUsage(
    config,
    { keyId: "catalog-legacy-token", apiKey: {} },
    model,
    usage,
    Date.now(),
    "",
    {
      modelDescriptor: {
        definition: {
          id: "governance-model",
          pricing: { inputPer1kTokens: 1, outputPer1kTokens: 2 }
        }
      }
    }
  );
  assert.equal(legacyToken.configured, true);
  assert.equal(legacyToken.amount, 3);
});