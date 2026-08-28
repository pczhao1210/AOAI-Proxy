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
import { getConfiguredModelBindingIssues } from "../src/model-validation.js";
import { recordGovernanceUsage } from "../src/governance.js";
import { listPricingDefinitions } from "../src/pricing-library.js";
import { resolveEffectiveRouteKey } from "../src/proxy/routing.js";
import { chatToResponsesRequest, responsesToMessagesRequest } from "../src/proxy/shim.js";

const config = {
  upstreams: [{ name: "azure", provider: "azure-openai" }],
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

  assert.equal(bundledDefinitions.length, 79);
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
});

test("Model Catalog compiler resolves exact model facts and protocol defaults", () => {
  const snapshot = compileModelCatalog(config, definitions, { generation: 7 });
  installModelCatalogSnapshot(snapshot);

  const matched = resolveModelDescriptor("public-gpt", snapshot);
  assert.equal(matched.catalogMatched, true);
  assert.equal(matched.catalogId, "gpt-special");
  assert.equal(matched.defaultInterface, "responses");
  assert.deepEqual(matched.capabilities, ["reasoning", "vision"]);
  assert.deepEqual(getDescriptorProtocolProfile(matched, "responses").reasoning.levels, ["low", "medium", "high", "xhigh"]);

  const unknown = resolveModelDescriptor("unknown-model", snapshot);
  assert.equal(unknown.catalogMatched, false);
  assert.equal(getDescriptorProtocolProfile(unknown, "responses"), getDefaultProtocolProfile("responses"));
  assert.equal(snapshot.generation, 7);
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
  const left = compileModelCatalog(config, [first, second], { generation: 1 });
  const right = compileModelCatalog(config, [second, first], { generation: 2 });
  assert.equal(left.sourceDigest, right.sourceDigest);
});

test("Model Catalog sync validates candidates and commits against the latest config", () => {
  let currentConfig = config;
  const transaction = createModelCatalogSyncTransaction(() => currentConfig);
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
    /requires a \/providers\/blackforestlabs/
  );
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