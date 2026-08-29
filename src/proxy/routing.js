import { findPricingDefinitionForModel } from "../pricing-library.js";
import { getDescriptorRouteTargets } from "../model-catalog.js";

const upstreamIndexCache = new WeakMap();
const modelIndexCache = new WeakMap();
const IMAGE_ROUTE_KEY_ALIASES = new Set(["openai-image", "blackforest-image"]);
const KNOWN_BACKEND_ROUTE_KEYS = new Set([
  "chat/completions",
  "responses",
  "messages",
  "images/generations"
]);
const LEGACY_OPENAI_IMAGE_ROUTE = "/openai/v1/images/generations";
const DEFAULT_OPENAI_IMAGE_ROUTE = "/openai/deployments/{deployment}/images/generations?api-version=2025-04-01-preview";
const DEFAULT_BLACKFOREST_IMAGE_ROUTE = "/providers/blackforestlabs/v1/{deployment}?api-version=preview";
const AZURE_OPENAI_HOST_SUFFIX = ".openai.azure.com";
const AZURE_FOUNDRY_HOST_SUFFIX = ".services.ai.azure.com";
const TEXT_ROUTE_KEYS = new Set(["chat/completions", "responses", "messages"]);

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

function resolveModelDefinition(model, descriptor) {
  return descriptor?.definition || findPricingDefinitionForModel(model);
}

function resolveRouteDeploymentSegment(routeKey, deployment, model = null, descriptor = null) {
  if (routeKey !== "blackforest-image") {
    return deployment;
  }

  const definition = resolveModelDefinition(model, descriptor);
  const providerSlug = normalizeString(definition?.id)
    || normalizeString(model?.pricingRef)
    || normalizeString(model?.id)
    || normalizeString(deployment);

  return providerSlug.toLowerCase();
}

export function normalizeBackendRouteKey(routeKey) {
  return IMAGE_ROUTE_KEY_ALIASES.has(routeKey) ? "images/generations" : routeKey;
}

export function isPublicRouteEnabled(config, routeKey) {
  const profileKey = routeKey === "chat/completions"
    ? "chatCompletions"
    : routeKey === "images/generations"
      ? "imageGenerations"
      : routeKey;
  if (config?.routing?.routeProfiles?.[profileKey]?.enabled === false) return false;
  return routeKey !== "images/generations" || config?.media?.generation?.enabled !== false;
}

export function resolveEffectiveRouteKey(routeKey, model, upstream, override = null, descriptor = null) {
  const requestedRouteKey = override?.type === "routeKey" ? override.value : routeKey;
  if (requestedRouteKey !== "images/generations") {
    if (override || !TEXT_ROUTE_KEYS.has(requestedRouteKey)) return requestedRouteKey;
    const definition = resolveModelDefinition(model, descriptor);
    const descriptorInterfaces = Array.isArray(descriptor?.interfaces) ? descriptor.interfaces : [];
    const hostingMode = normalizeLower(model?.hostingMode || definition?.defaultHostingMode);
    const configuredInterfaces = descriptorInterfaces.length > 0
      ? descriptorInterfaces
      : hostingMode && Array.isArray(definition?.interfacesByHostingMode?.[hostingMode])
        ? definition.interfacesByHostingMode[hostingMode]
        : definition?.interfaces;
    const interfaces = Array.isArray(configuredInterfaces)
      ? configuredInterfaces.filter((item) => TEXT_ROUTE_KEYS.has(item))
      : [];
    if (interfaces.includes(requestedRouteKey)) return requestedRouteKey;
    const defaultInterface = normalizeLower(descriptor?.defaultInterface || definition?.defaultInterface);
    if (interfaces.includes(defaultInterface)) return defaultInterface;
    if (interfaces.length === 1) return interfaces[0];
    if (interfaces.includes("responses")) return "responses";
    if (interfaces.includes("messages")) return "messages";
    return requestedRouteKey;
  }

  const definition = resolveModelDefinition(model, descriptor);
  const requestTransport = normalizeLower(
    descriptor?.protocolProfiles?.["images/generations"]?.request?.transport
      || definition?.protocolProfiles?.["images/generations"]?.request?.transport
  );
  const catalogRoute = normalizeLower(
    definition?.proxyTemplate?.routes?.["images/generations"]
      || definition?.proxyTemplate?.routes?.["*"]
  );
  if (
    requestTransport === "blackforest-provider"
    || catalogRoute === "blackforest-image"
    || normalizeLower(descriptor?.provider || definition?.provider) === "black-forest-labs"
  ) {
    return "blackforest-image";
  }
  if (requestTransport === "azure-deployment" || catalogRoute === "openai-image") {
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

function shouldUseFoundryServicesHost({ upstream, routeKey = "", routePath = "", model = null, descriptor = null }) {
  const explicitHostType = normalizeLower(upstream?.hostType);
  if (explicitHostType === "services") return true;
  if (explicitHostType === "openai") return false;
  if (routeKey === "messages") return true;
  if (routeKey === "blackforest-image") return true;
  if (routeKey === "openai-image") return false;

  const routeText = normalizeLower(routePath || upstream?.routes?.[routeKey]);
  if (routeText.includes("/providers/") || routeText.includes("/anthropic/")) {
    return true;
  }

  const definition = resolveModelDefinition(model, descriptor);
  const definitionProvider = normalizeLower(definition?.provider);
  return definitionProvider === "black-forest-labs";
}

export function resolveUpstreamBaseUrl(upstream, options = {}) {
  const baseUrl = normalizeString(upstream?.baseUrl);
  const useServicesHost = shouldUseFoundryServicesHost({
    upstream,
    routeKey: options.routeKey,
    routePath: options.routePath,
    model: options.model,
    descriptor: options.descriptor
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

export function buildUpstreamUrl(upstream, routeKey, deployment, model = null, descriptor = null) {
  const definition = resolveModelDefinition(model, descriptor);
  const route = resolveRouteTemplate(upstream, routeKey)
    || (routeKey === "messages" && normalizeLower(definition?.provider) === "anthropic"
      ? "/anthropic/v1/messages"
      : "");
  if (!route) {
    throw new Error(`No route configured for ${routeKey}`);
  }
  const routeDeployment = resolveRouteDeploymentSegment(routeKey, deployment, model, descriptor);
  const renderedRoute = typeof route === "string" && routeDeployment
    ? route.replaceAll("{deployment}", encodeURIComponent(routeDeployment))
    : route;
  return new URL(renderedRoute, resolveUpstreamBaseUrl(upstream, { routeKey, routePath: renderedRoute, model, descriptor })).toString();
}

export function buildMessagesCountTokensUrl(upstream, messagesUrl, deployment, model = null, descriptor = null) {
  const configuredRoute = resolveRouteTemplate(upstream, "messages/count_tokens");
  if (configuredRoute) {
    const configuredUrl = buildUpstreamUrl(upstream, "messages/count_tokens", deployment, model, descriptor);
    const parsedConfiguredUrl = new URL(configuredUrl);
    if (!parsedConfiguredUrl.pathname.replace(/\/+$/, "").endsWith("/messages/count_tokens")) {
      throw new Error("messages/count_tokens route must end with /messages/count_tokens");
    }
    return configuredUrl;
  }

  const parsedMessagesUrl = new URL(messagesUrl);
  const messagesPath = parsedMessagesUrl.pathname.replace(/\/+$/, "");
  if (!messagesPath.endsWith("/messages")) {
    throw new Error("native messages route must end with /messages");
  }
  parsedMessagesUrl.pathname = `${messagesPath}/count_tokens`;
  return parsedMessagesUrl.toString();
}

export function buildResponsesCompactUrl(upstream, responsesUrl, deployment, model = null, descriptor = null) {
  const configuredRoute = resolveRouteTemplate(upstream, "responses/compact");
  if (configuredRoute) {
    const configuredUrl = buildUpstreamUrl(upstream, "responses/compact", deployment, model, descriptor);
    const parsedConfiguredUrl = new URL(configuredUrl);
    if (!parsedConfiguredUrl.pathname.replace(/\/+$/, "").endsWith("/responses/compact")) {
      throw new Error("responses/compact route must end with /responses/compact");
    }
    return configuredUrl;
  }

  const parsedResponsesUrl = new URL(responsesUrl);
  const responsesPath = parsedResponsesUrl.pathname.replace(/\/+$/, "");
  if (!responsesPath.endsWith("/responses")) {
    throw new Error("native responses route must end with /responses");
  }
  parsedResponsesUrl.pathname = `${responsesPath}/compact`;
  return parsedResponsesUrl.toString();
}

export function resolveModelRoute(model, incomingRouteKey) {
  const routes = model?.routes;
  if (!routes || typeof routes !== "object") return null;
  const mapped = routes[incomingRouteKey] ?? routes["*"];
  if (!mapped || typeof mapped !== "string") return null;
  const trimmed = mapped.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.includes("://")) {
    throw new Error("Direct model route paths are not supported");
  }
  return { type: "routeKey", value: trimmed };
}

export function inferBackendRouteKey(routeKey, override, routeInterfaces = []) {
  if (override?.type === "routeKey") return normalizeBackendRouteKey(override.value);
  if (override?.type === "path") {
    const p = override.value.toLowerCase().split(/[?#]/, 1)[0].replace(/\/+$/, "");
    const interfaceCandidates = [...new Set([
      ...routeInterfaces,
      normalizeBackendRouteKey(routeKey)
    ].map(normalizeLower).filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    for (const interfaceName of interfaceCandidates) {
      if (p.endsWith(`/${interfaceName}`)) return interfaceName;
    }
    if (p.endsWith("/responses")) return "responses";
    if (p.endsWith("/messages")) return "messages";
    if (p.endsWith("/chat/completions")) return "chat/completions";
    if (p.endsWith("/images/generations")) return "images/generations";
    if (p.includes("/providers/blackforestlabs/")) return "images/generations";
    return "unknown";
  }
  return normalizeBackendRouteKey(routeKey);
}

export function reconcileBackendRouteKey(configuredBackendRouteKey, targetUrl, routeInterfaces = []) {
  const normalizedRouteKey = normalizeBackendRouteKey(configuredBackendRouteKey);
  return inferBackendRouteKey(normalizedRouteKey, {
    type: "path",
    value: targetUrl
  }, routeInterfaces);
}

export function resolveRoutePlan({
  routeKey,
  model,
  upstream,
  override,
  descriptor = null
}) {
  const deployment = normalizeString(model?.targetModel) || normalizeString(model?.id);
  const resolvedOverride = override === undefined
    ? resolveModelRoute(model, routeKey)
    : override;
  const allowedRouteTargets = new Set(getDescriptorRouteTargets(descriptor));
  if (
    resolvedOverride
    && (
      resolvedOverride.type !== "routeKey"
      || !allowedRouteTargets.has(normalizeLower(resolvedOverride.value))
    )
  ) {
    throw new Error(`Model Catalog does not allow route target ${resolvedOverride.value || "unknown"}`);
  }
  const effectiveRouteKey = deployment.toLowerCase() === "model-router"
    ? "chat/completions"
    : resolveEffectiveRouteKey(routeKey, model, upstream, resolvedOverride, descriptor);
  if (
    descriptor?.catalogMatched
    && !allowedRouteTargets.has(normalizeLower(effectiveRouteKey))
  ) {
    throw new Error(`Model Catalog does not allow route target ${effectiveRouteKey}`);
  }
  const configuredBackendRouteKey = resolvedOverride
    ? inferBackendRouteKey(routeKey, resolvedOverride)
    : normalizeBackendRouteKey(effectiveRouteKey);
  const targetUrl = buildUpstreamUrl(upstream, effectiveRouteKey, deployment, model, descriptor);
  const backendRouteKey = reconcileBackendRouteKey(
    configuredBackendRouteKey,
    targetUrl,
    descriptor?.knownRouteInterfaces || descriptor?.interfaces || []
  );
  if (
    descriptor?.catalogMatched
    && !descriptor.interfaces.includes(backendRouteKey)
  ) {
    throw new Error(
      `Model Catalog model "${descriptor.catalogId}" does not allow final backend route ${backendRouteKey}; allowed interfaces: ${descriptor.interfaces.join(", ") || "none"}`
    );
  }
  const sourceRouteKey = normalizeBackendRouteKey(routeKey);
  if (
    sourceRouteKey !== backendRouteKey
    && !(TEXT_ROUTE_KEYS.has(sourceRouteKey) && TEXT_ROUTE_KEYS.has(backendRouteKey))
  ) {
    throw new Error(`Proxy does not support route conversion from ${sourceRouteKey} to ${backendRouteKey}`);
  }

  return {
    routeKey,
    deployment,
    override: resolvedOverride || null,
    effectiveRouteKey,
    configuredBackendRouteKey,
    backendRouteKey,
    targetUrl
  };
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
