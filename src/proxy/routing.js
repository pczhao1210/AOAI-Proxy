import { findPricingDefinitionForModel } from "../pricing-library.js";

const upstreamIndexCache = new WeakMap();
const modelIndexCache = new WeakMap();
const IMAGE_ROUTE_KEY_ALIASES = new Set(["openai-image", "blackforest-image"]);
const LEGACY_OPENAI_IMAGE_ROUTE = "/openai/v1/images/generations";
const DEFAULT_OPENAI_IMAGE_ROUTE = "/openai/deployments/{deployment}/images/generations?api-version=2025-04-01-preview";
const DEFAULT_BLACKFOREST_IMAGE_ROUTE = "/providers/blackforestlabs/v1/{deployment}?api-version=preview";
const AZURE_OPENAI_HOST_SUFFIX = ".openai.azure.com";
const AZURE_FOUNDRY_HOST_SUFFIX = ".services.ai.azure.com";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function getUpstreamIndex(config) {
  const cached = upstreamIndexCache.get(config);
  if (cached) return cached;
  const index = new Map();
  for (const upstream of config.upstreams || []) {
    if (upstream?.name) index.set(upstream.name, upstream);
  }
  upstreamIndexCache.set(config, index);
  return index;
}

function getModelIndex(config) {
  const cached = modelIndexCache.get(config);
  if (cached) return cached;
  const index = new Map();
  for (const model of config.models || []) {
    if (model?.id) index.set(model.id, model);
  }
  modelIndexCache.set(config, index);
  return index;
}

export function findUpstream(config, name) {
  return getUpstreamIndex(config).get(name);
}

export function findModel(config, modelId) {
  return getModelIndex(config).get(modelId) || null;
}

function isGptImageModel(model, definition = findPricingDefinitionForModel(model)) {
  const candidates = [
    definition?.id,
    model?.pricingRef,
    model?.targetModel,
    model?.id
  ];
  return candidates.some((value) => normalizeLower(value).startsWith("gpt-image-"));
}

function isBlackForestLabsImageModel(model, definition = findPricingDefinitionForModel(model)) {
  return normalizeLower(definition?.provider) === "black-forest-labs";
}

export function normalizeBackendRouteKey(routeKey) {
  return IMAGE_ROUTE_KEY_ALIASES.has(routeKey) ? "images/generations" : routeKey;
}

export function resolveEffectiveRouteKey(routeKey, model, upstream, override = null) {
  const requestedRouteKey = override?.type === "routeKey" ? override.value : routeKey;
  if (requestedRouteKey !== "images/generations") {
    return requestedRouteKey;
  }

  const definition = findPricingDefinitionForModel(model);
  if (isBlackForestLabsImageModel(model, definition)) {
    return "blackforest-image";
  }
  if (isGptImageModel(model, definition)) {
    return "openai-image";
  }
  return requestedRouteKey;
}

function rewriteAzureSiblingBaseUrl(baseUrl, useServicesHost) {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    const currentSuffix = hostname.endsWith(AZURE_OPENAI_HOST_SUFFIX)
      ? AZURE_OPENAI_HOST_SUFFIX
      : hostname.endsWith(AZURE_FOUNDRY_HOST_SUFFIX)
        ? AZURE_FOUNDRY_HOST_SUFFIX
        : "";

    if (!currentSuffix) {
      return baseUrl;
    }

    const resourceName = hostname.slice(0, -currentSuffix.length);
    const targetSuffix = useServicesHost ? AZURE_FOUNDRY_HOST_SUFFIX : AZURE_OPENAI_HOST_SUFFIX;
    return `${parsed.protocol}//${resourceName}${targetSuffix}/`;
  } catch {
    return baseUrl;
  }
}

function shouldUseFoundryServicesHost({ upstream, routeKey = "", routePath = "", model = null }) {
  const explicitHostType = normalizeLower(upstream?.hostType);
  if (explicitHostType === "services") return true;
  if (explicitHostType === "openai") return false;
  if (routeKey === "blackforest-image") return true;
  if (routeKey === "openai-image") return false;

  const routeText = normalizeLower(routePath || upstream?.routes?.[routeKey]);
  if (routeText.includes("/providers/")) {
    return true;
  }

  const definition = findPricingDefinitionForModel(model);
  const definitionProvider = normalizeLower(definition?.provider);
  return definitionProvider === "black-forest-labs";
}

export function resolveUpstreamBaseUrl(upstream, options = {}) {
  const baseUrl = normalizeString(upstream?.baseUrl);
  const useServicesHost = shouldUseFoundryServicesHost({
    upstream,
    routeKey: options.routeKey,
    routePath: options.routePath,
    model: options.model
  });
  if (baseUrl && !isPlaceholderBaseUrl(baseUrl)) {
    return rewriteAzureSiblingBaseUrl(baseUrl, useServicesHost);
  }

  const resourceName = normalizeString(upstream?.resourceName);
  if (!resourceName) {
    return baseUrl;
  }

  const hostname = useServicesHost
    ? `${resourceName}.services.ai.azure.com`
    : `${resourceName}.openai.azure.com`;

  return `https://${hostname}/`;
}

export function hasUsableUpstreamBaseUrl(upstream, options = {}) {
  const resolved = resolveUpstreamBaseUrl(upstream, options);
  if (!resolved) return false;
  try {
    const parsed = new URL(resolved);
    return /^https?:$/.test(parsed.protocol) && !isPlaceholderBaseUrl(resolved);
  } catch {
    return false;
  }
}

function resolveRouteTemplate(upstream, routeKey) {
  const route = upstream.routes?.[routeKey];
  if (!route && routeKey === "openai-image") {
    return DEFAULT_OPENAI_IMAGE_ROUTE;
  }
  if (!route && routeKey === "blackforest-image") {
    return DEFAULT_BLACKFOREST_IMAGE_ROUTE;
  }
  if (routeKey === "openai-image" && route === LEGACY_OPENAI_IMAGE_ROUTE) {
    return DEFAULT_OPENAI_IMAGE_ROUTE;
  }
  return route;
}

export function buildUpstreamUrl(upstream, routeKey, deployment, model = null) {
  const route = resolveRouteTemplate(upstream, routeKey);
  if (!route) {
    throw new Error(`No route configured for ${routeKey}`);
  }
  const renderedRoute = typeof route === "string" && deployment
    ? route.replaceAll("{deployment}", encodeURIComponent(deployment))
    : route;
  return new URL(renderedRoute, resolveUpstreamBaseUrl(upstream, { routeKey, routePath: renderedRoute, model })).toString();
}

export function buildDirectUpstreamUrl(upstream, routePath, deployment, model = null) {
  if (!routePath || typeof routePath !== "string") {
    throw new Error("routePath must be a string");
  }
  const renderedRoute = deployment
    ? routePath.replaceAll("{deployment}", encodeURIComponent(deployment))
    : routePath;
  return new URL(renderedRoute, resolveUpstreamBaseUrl(upstream, { routePath: renderedRoute, model })).toString();
}

export function resolveModelRoute(model, incomingRouteKey) {
  const routes = model?.routes;
  if (!routes || typeof routes !== "object") return null;
  const mapped = routes[incomingRouteKey] ?? routes["*"];
  if (!mapped || typeof mapped !== "string") return null;
  const trimmed = mapped.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) {
    return { type: "path", value: trimmed };
  }
  return { type: "routeKey", value: trimmed };
}

export function inferBackendRouteKey(routeKey, override) {
  if (override?.type === "routeKey") return normalizeBackendRouteKey(override.value);
  if (override?.type === "path") {
    const p = override.value.toLowerCase();
    if (p.endsWith("/responses")) return "responses";
    if (p.endsWith("/chat/completions")) return "chat/completions";
    if (p.endsWith("/images/generations")) return "images/generations";
    if (p.includes("/providers/blackforestlabs/")) return "images/generations";
  }
  return normalizeBackendRouteKey(routeKey);
}

export function isPlaceholderBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== "string") return true;
  try {
    const url = new URL(baseUrl);
    return url.hostname.toLowerCase().includes("your-resource-name");
  } catch {
    return true;
  }
}
