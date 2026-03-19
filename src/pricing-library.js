import fs from "node:fs";
import path from "node:path";

const PRICING_DIR = path.resolve(process.cwd(), "pricing");
const LEGACY_ROUTE_CAPABILITIES = new Set(["chat", "responses", "stream", "images", "image"]);
const DEFAULT_UPSTREAM_ROUTES = {
  "chat/completions": "/openai/v1/chat/completions",
  responses: "/openai/v1/responses",
  "images/generations": "/openai/v1/images/generations"
};

let pricingDefinitionsCache = null;
let pricingLookupCache = null;

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function rememberLookup(lookup, key, definition) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized || lookup.has(normalized)) return;
  lookup.set(normalized, definition);
}

function normalizePricingDefinition(rawDefinition) {
  const definition = asPlainObject(rawDefinition);
  const proxyTemplate = definition.proxyTemplate && typeof definition.proxyTemplate === "object"
    ? {
      ...asPlainObject(definition.proxyTemplate),
      capabilities: normalizeStringArray(definition.proxyTemplate.capabilities),
      routes: asPlainObject(definition.proxyTemplate.routes)
    }
    : null;

  return {
    id: String(definition.id || ""),
    displayName: String(definition.displayName || definition.id || ""),
    provider: String(definition.provider || "azure-openai"),
    family: String(definition.family || ""),
    modelVersion: definition.modelVersion ?? null,
    status: String(definition.status || "unknown"),
    interfaces: normalizeStringArray(definition.interfaces),
    inputModalities: normalizeStringArray(definition.inputModalities),
    outputModalities: normalizeStringArray(definition.outputModalities),
    capabilities: normalizeStringArray(definition.capabilities),
    pricing: asPlainObject(definition.pricing),
    pricingCatalogEntry: definition.pricingCatalogEntry && typeof definition.pricingCatalogEntry === "object"
      ? asPlainObject(definition.pricingCatalogEntry)
      : null,
    proxyTemplate,
    sources: asPlainObject(definition.sources),
    notes: Array.isArray(definition.notes) ? definition.notes.filter((item) => typeof item === "string") : [],
    supportsProxyTemplate: !!(proxyTemplate?.id && proxyTemplate?.targetModel),
    upstreamTemplate: {
      provider: String(definition.provider || "azure-openai"),
      capabilities: normalizeStringArray(definition.capabilities),
      routes: cloneJson(DEFAULT_UPSTREAM_ROUTES)
    }
  };
}

function loadPricingDefinitions() {
  if (pricingDefinitionsCache) return pricingDefinitionsCache;

  const entries = fs.readdirSync(PRICING_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const filePath = path.join(PRICING_DIR, entry.name);
      const text = fs.readFileSync(filePath, "utf8");
      const definition = normalizePricingDefinition(JSON.parse(text));
      definition.fileName = entry.name;
      return definition;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  pricingDefinitionsCache = entries;
  return pricingDefinitionsCache;
}

function getPricingLookup() {
  if (pricingLookupCache) return pricingLookupCache;

  pricingLookupCache = new Map();
  for (const definition of loadPricingDefinitions()) {
    rememberLookup(pricingLookupCache, definition.id, definition);
    rememberLookup(pricingLookupCache, definition.displayName, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.id, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.targetModel, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.pricingRef, definition);
  }

  return pricingLookupCache;
}

function buildRouterAggregateCapabilities(model, models) {
  const union = new Set();
  for (const peer of Array.isArray(models) ? models : []) {
    if (!peer || peer === model) continue;
    if (model?.upstream && peer.upstream !== model.upstream) continue;
    const definition = findPricingDefinitionForModel(peer);
    const capabilities = definition?.capabilities?.length
      ? definition.capabilities
      : normalizeStringArray(peer.capabilities);
    for (const capability of capabilities) {
      if (!LEGACY_ROUTE_CAPABILITIES.has(capability)) {
        union.add(capability);
      }
    }
  }
  return [...union];
}

export function listPricingDefinitions() {
  return loadPricingDefinitions().map((definition) => cloneJson(definition));
}

export function getPricingDefinition(definitionId) {
  if (!definitionId) return null;
  return getPricingLookup().get(String(definitionId).trim().toLowerCase()) || null;
}

export function findPricingDefinitionForModel(model) {
  const candidates = [
    model?.pricingRef,
    model?.id,
    model?.targetModel,
    model?.displayName
  ];
  for (const candidate of candidates) {
    const definition = getPricingDefinition(candidate);
    if (definition) return definition;
  }
  return null;
}

export function hasLegacyRouteCapabilities(capabilities) {
  const normalized = normalizeStringArray(capabilities);
  return normalized.length > 0 && normalized.every((capability) => LEGACY_ROUTE_CAPABILITIES.has(capability));
}

export function resolveNativeModelCapabilities(model, models = []) {
  const currentCapabilities = normalizeStringArray(model?.capabilities);
  const definition = findPricingDefinitionForModel(model);

  if (definition?.capabilities?.length && (currentCapabilities.length === 0 || hasLegacyRouteCapabilities(currentCapabilities))) {
    return [...definition.capabilities];
  }

  if (currentCapabilities.length === 0 || !hasLegacyRouteCapabilities(currentCapabilities)) {
    return currentCapabilities;
  }

  const routerLike = `${model?.id || ""} ${model?.targetModel || ""}`.toLowerCase().includes("router");
  if (routerLike) {
    const aggregateCapabilities = buildRouterAggregateCapabilities(model, models);
    if (aggregateCapabilities.length) return aggregateCapabilities;
  }

  const fallbackCapabilities = [];
  if (currentCapabilities.includes("stream")) {
    fallbackCapabilities.push("streaming");
  }
  return fallbackCapabilities;
}