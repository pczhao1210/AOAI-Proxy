const upstreamIndexCache = new WeakMap();
const modelIndexCache = new WeakMap();

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

export function buildUpstreamUrl(upstream, routeKey, deployment) {
  const route = upstream.routes?.[routeKey];
  if (!route) {
    throw new Error(`No route configured for ${routeKey}`);
  }
  const renderedRoute = typeof route === "string" && deployment
    ? route.replaceAll("{deployment}", encodeURIComponent(deployment))
    : route;
  return new URL(renderedRoute, upstream.baseUrl).toString();
}

export function buildDirectUpstreamUrl(upstream, routePath, deployment) {
  if (!routePath || typeof routePath !== "string") {
    throw new Error("routePath must be a string");
  }
  const renderedRoute = deployment
    ? routePath.replaceAll("{deployment}", encodeURIComponent(deployment))
    : routePath;
  return new URL(renderedRoute, upstream.baseUrl).toString();
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
  if (override?.type === "routeKey") return override.value;
  if (override?.type === "path") {
    const p = override.value.toLowerCase();
    if (p.endsWith("/responses")) return "responses";
    if (p.endsWith("/chat/completions")) return "chat/completions";
    if (p.endsWith("/images/generations")) return "images/generations";
  }
  return routeKey;
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
