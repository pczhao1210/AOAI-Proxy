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
import { resolveEffectiveRouteKey, resolveRoutePlan } from "../src/proxy/routing.js";
import { chatToResponsesRequest, responsesToMessagesRequest } from "../src/proxy/shim.js";

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

  assert.equal(bundledDefinitions.length, 82);
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

    if (definition.pricing.channels || definition.pricing.tiers) {
      assert.equal(
        definition.pricingCatalogEntry,
        null,
        `${definition.fileName}: channel or tier pricing requires pricingCatalogEntry: null`
      );
    }

    const hasRoutableInterface = definition.interfaces.some((protocol) => [
      "chat/completions",
      "responses",
      "messages",
      "images/generations"
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

  for (const id of ["glm-5.3", "gpt-6-astra", "claude-fable-5-1"]) {
    assert.ok(ids.has(id), `missing bundled Model Catalog definition ${id}`);
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

  const expectedGlobalPricing = {
    "gpt-5.6-luna": [0.0002, 0.00002, 0.0012],
    "gpt-5.6-sol": [0.005, 0.0005, 0.03],
    "gpt-5.6-terra": [0.002, 0.0002, 0.012]
  };
  for (const [id, [inputPer1kTokens, cachedInputPer1kTokens, outputPer1kTokens]] of Object.entries(expectedGlobalPricing)) {
    const definition = definitionsById.get(id);
    assert.equal(definition.pricing.sourceType, "azure-openai-global", `${id}: Azure pricing source`);
    assert.deepEqual(definition.pricingCatalogEntry, {
      currency: "USD",
      inputPer1kTokens,
      cachedInputPer1kTokens,
      outputPer1kTokens
    }, `${id}: Azure Global Standard short-context pricing`);
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
  assert.deepEqual(getDescriptorProtocolProfile(matched, "responses").reasoning.levels, ["low", "medium", "high", "xhigh"]);
  assert.equal(resolveModelDescriptor("gpt-special-alias", snapshot), matched);

  const unknown = resolveModelDescriptor("unknown-model", snapshot);
  assert.equal(unknown.catalogMatched, false);
  assert.equal(getDescriptorProtocolProfile(unknown, "responses"), getDefaultProtocolProfile("responses"));
  assert.ok(snapshot.generation > 0);
  assert.equal(snapshot.modelCount, 2);
});

test("Model Catalog compiler rejects ambiguous aliases", () => {
  assert.throws(() => compileModelCatalog(config, [
    { ...definitions[0], id: "first", aliases: ["shared"] },
    { ...definitions[0], id: "second", aliases: ["shared"] }
  ]), /alias collision for shared/);
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