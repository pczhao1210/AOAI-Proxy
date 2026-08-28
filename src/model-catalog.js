import crypto from "node:crypto";
import { listPricingDefinitions } from "./pricing-library.js";

const TEXT_PROTOCOLS = new Set(["chat/completions", "responses", "messages"]);
const DEFAULT_PROTOCOL_PROFILES = Object.freeze({
  "chat/completions": Object.freeze({
    reasoning: Object.freeze({
      parameter: "reasoning_effort",
      levels: Object.freeze(["low", "medium", "high"]),
      default: "medium",
      aliases: Object.freeze({}),
      validation: "passthrough"
    })
  }),
  responses: Object.freeze({
    reasoning: Object.freeze({
      parameter: "reasoning.effort",
      levels: Object.freeze(["low", "medium", "high"]),
      default: "medium",
      aliases: Object.freeze({}),
      validation: "passthrough"
    })
  }),
  messages: Object.freeze({
    reasoning: Object.freeze({
      parameter: "output_config.effort",
      levels: Object.freeze([]),
      default: "",
      aliases: Object.freeze({}),
      validation: "passthrough"
    }),
    thinking: Object.freeze({
      parameter: "thinking.type",
      types: Object.freeze([]),
      default: "adaptive",
      validation: "passthrough"
    })
  })
});

let installedSnapshot = null;
let catalogGeneration = 0;

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeJson(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeJson(child);
  return Object.freeze(value);
}

function digestDefinitions(definitions) {
  const canonical = [...definitions]
    .sort((left, right) => normalizeKey(left.id).localeCompare(normalizeKey(right.id)))
    .map((definition) => cloneJson(definition));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function rememberUnique(index, key, value, label) {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  const existing = index.get(normalized);
  if (existing && existing !== value) {
    throw new Error(`Model Catalog ${label} collision for ${key}`);
  }
  index.set(normalized, value);
}

function indexDefinitions(definitions) {
  const byId = new Map();
  const byAlias = new Map();
  for (const definition of definitions) {
    rememberUnique(byId, definition.id, definition, "ID");
    for (const alias of definition.aliases || []) rememberUnique(byAlias, alias, definition, "alias");
    for (const alias of [
      definition.proxyTemplate?.id,
      definition.proxyTemplate?.targetModel,
      definition.proxyTemplate?.pricingRef
    ]) {
      rememberUnique(byAlias, alias, definition, "template alias");
    }
  }
  return { byId, byAlias };
}

function findDefinition(model, indexes) {
  for (const candidate of [model?.pricingRef, model?.id, model?.targetModel]) {
    const key = normalizeKey(candidate);
    if (!key) continue;
    const definition = indexes.byId.get(key) || indexes.byAlias.get(key);
    if (definition) return definition;
  }
  return null;
}

function resolveInterfaces(model, definition) {
  const hostingMode = normalizeKey(model?.hostingMode || definition?.defaultHostingMode);
  const hostedInterfaces = hostingMode
    ? definition?.interfacesByHostingMode?.[hostingMode]
    : null;
  const interfaces = Array.isArray(hostedInterfaces) && hostedInterfaces.length > 0
    ? hostedInterfaces
    : definition?.interfaces;
  return [...new Set((Array.isArray(interfaces) ? interfaces : []).map(normalizeKey).filter(Boolean))];
}

function resolveDefaultInterface(definition, interfaces) {
  const configured = normalizeKey(definition?.defaultInterface);
  if (configured && interfaces.includes(configured)) return configured;
  if (interfaces.length === 1) return interfaces[0];
  if (interfaces.includes("responses")) return "responses";
  if (interfaces.includes("messages")) return "messages";
  return interfaces[0] || "";
}

function compileDescriptor(model, definition, upstream) {
  const interfaces = resolveInterfaces(model, definition);
  const capabilities = definition?.capabilities?.length
    ? definition.capabilities
    : (Array.isArray(model?.capabilities) ? model.capabilities : []);
  const protocolProfiles = freezeJson(cloneJson(definition?.protocolProfiles || {}));
  return Object.freeze({
    publicId: String(model.id),
    targetModel: String(model.targetModel || model.id),
    pricingRef: String(model.pricingRef || definition?.id || ""),
    catalogId: String(definition?.id || ""),
    catalogMatched: !!definition,
    provider: String(definition?.provider || upstream?.provider || ""),
    hostingMode: normalizeKey(model.hostingMode || definition?.defaultHostingMode),
    interfaces: Object.freeze(interfaces),
    defaultInterface: resolveDefaultInterface(definition, interfaces),
    capabilities: Object.freeze([...new Set(capabilities.map(normalizeKey).filter(Boolean))]),
    protocolProfiles,
    definition: definition || null,
    model
  });
}

export function getDefaultProtocolProfile(protocol) {
  return DEFAULT_PROTOCOL_PROFILES[normalizeKey(protocol)] || null;
}

export function getDescriptorProtocolProfile(descriptor, protocol) {
  const protocolKey = normalizeKey(protocol);
  const hostingMode = normalizeKey(descriptor?.hostingMode);
  const provider = normalizeKey(descriptor?.provider);
  const profiles = descriptor?.protocolProfiles || {};
  return profiles[`${hostingMode}:${protocolKey}`]
    || profiles[`${provider}:${protocolKey}`]
    || profiles[protocolKey]
    || getDefaultProtocolProfile(protocolKey);
}

export function compileModelCatalog(config, definitions = listPricingDefinitions(), options = {}) {
  const normalizedDefinitions = Array.isArray(definitions)
    ? definitions.map((definition) => freezeJson(cloneJson(definition)))
    : [];
  const indexes = indexDefinitions(normalizedDefinitions);
  const upstreamsByName = new Map(
    (config?.upstreams || []).filter((upstream) => upstream?.name).map((upstream) => [upstream.name, upstream])
  );
  const modelsByPublicId = new Map();
  const modelsByAlias = new Map();
  const descriptors = [];

  for (const model of config?.models || []) {
    if (!model?.id) continue;
    const definition = findDefinition(model, indexes);
    const descriptor = compileDescriptor(model, definition, upstreamsByName.get(model.upstream));
    rememberUnique(modelsByPublicId, model.id, descriptor, "configured model ID");
    for (const alias of definition?.aliases || []) rememberUnique(modelsByAlias, alias, descriptor, "configured model alias");
    descriptors.push(descriptor);
  }

  const generation = Number.isInteger(options.generation) && options.generation > 0
    ? options.generation
    : catalogGeneration + 1;
  return Object.freeze({
    generation,
    compiledAt: new Date().toISOString(),
    sourceDigest: digestDefinitions(normalizedDefinitions),
    definitionCount: normalizedDefinitions.length,
    modelCount: descriptors.length,
    modelsByPublicId,
    modelsByAlias,
    descriptors: Object.freeze(descriptors)
  });
}

export function installModelCatalogSnapshot(snapshot) {
  if (!snapshot || !(snapshot.modelsByPublicId instanceof Map)) {
    throw new Error("Invalid Model Catalog snapshot");
  }
  installedSnapshot = snapshot;
  catalogGeneration = snapshot.generation;
  return snapshot;
}

export function refreshModelCatalog(config, definitions) {
  return installModelCatalogSnapshot(compileModelCatalog(config, definitions));
}

export function createModelCatalogSyncTransaction(getConfig) {
  if (typeof getConfig !== "function") {
    throw new Error("Model Catalog sync requires a config provider");
  }
  return {
    prepare(definitions) {
      compileModelCatalog(getConfig(), definitions);
      return definitions;
    },
    commit(definitions) {
      return installModelCatalogSnapshot(compileModelCatalog(getConfig(), definitions));
    }
  };
}

export function getModelCatalogSnapshot() {
  return installedSnapshot;
}

export function resolveModelDescriptor(modelOrId, snapshot = installedSnapshot) {
  if (!snapshot) return null;
  const candidates = typeof modelOrId === "string"
    ? [modelOrId]
    : [modelOrId?.id, modelOrId?.pricingRef, modelOrId?.targetModel];
  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (!key) continue;
    const descriptor = snapshot.modelsByPublicId.get(key) || snapshot.modelsByAlias.get(key);
    if (descriptor) return descriptor;
  }
  return null;
}

export function getModelCatalogRuntimeInfo(snapshot = installedSnapshot) {
  if (!snapshot) return { ready: false, generation: 0, definitionCount: 0, modelCount: 0, sourceDigest: "" };
  return {
    ready: true,
    generation: snapshot.generation,
    compiledAt: snapshot.compiledAt,
    definitionCount: snapshot.definitionCount,
    modelCount: snapshot.modelCount,
    sourceDigest: snapshot.sourceDigest
  };
}

export function isTextProtocol(protocol) {
  return TEXT_PROTOCOLS.has(normalizeKey(protocol));
}