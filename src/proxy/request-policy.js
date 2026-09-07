export function normalizeRouteProfileKey(routeKey) {
  if (routeKey === "chat/completions") return "chatCompletions";
  if (routeKey === "images/generations") return "imageGenerations";
  return routeKey;
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function isAllowedByAllNonEmptyLists(fieldName, lists) {
  for (const list of lists) {
    if (list.size > 0 && !list.has(fieldName)) return false;
  }
  return true;
}

export function applyConfiguredRequestPolicy(body, { config, routeKey, model, upstream }) {
  if (!body || typeof body !== "object") return null;
  const routeProfile = config?.routing?.routeProfiles?.[normalizeRouteProfileKey(routeKey)] || {};
  const routeAllowed = new Set(normalizeStringList(routeProfile.allowedRequestFields));
  const modelPolicy = model?.requestPolicy || {};
  const modelAllowed = new Set(normalizeStringList(modelPolicy.allowedParams));
  const modelBlocked = new Set(normalizeStringList(modelPolicy.blockedParams));
  const upstreamPolicy = upstream?.requestPolicy || {};
  const upstreamAllowed = new Set(normalizeStringList(upstreamPolicy.allowedParams));
  const upstreamBlocked = new Set(normalizeStringList(upstreamPolicy.blockedParams));
  const dropUnsupported = modelPolicy.dropUnsupportedParams === true
    || upstreamPolicy.dropUnsupportedParams === true
    || config?.proxy?.guards?.dropUnsupportedOpenAiParams === true;
  const rejectedFields = [];

  for (const fieldName of Object.keys(body)) {
    if (fieldName === "model") continue;
    const blocked = modelBlocked.has(fieldName) || upstreamBlocked.has(fieldName);
    const allowed = isAllowedByAllNonEmptyLists(fieldName, [routeAllowed, modelAllowed, upstreamAllowed]);
    if (!blocked && allowed) continue;
    if (dropUnsupported) {
      delete body[fieldName];
      continue;
    }
    rejectedFields.push(fieldName);
  }

  if (!rejectedFields.length) return null;
  return {
    param: rejectedFields[0],
    fields: rejectedFields,
    message: `Unsupported request field${rejectedFields.length > 1 ? "s" : ""}: ${rejectedFields.join(", ")}`
  };
}

export function sanitizeToolControlsWithoutTools(body) {
  if (!body || typeof body !== "object") return;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasLegacyFunctions = Array.isArray(body.functions) && body.functions.length > 0;
  if (hasTools || hasLegacyFunctions) return;
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.function_call;
}

export function validateImageGenerationPolicy(body, config) {
  const generation = config?.media?.generation || {};
  const maxImages = Number.isInteger(generation.maxImages) && generation.maxImages > 0
    ? generation.maxImages
    : 4;
  const imageCount = body?.n == null ? 1 : Number(body.n);
  if (!Number.isInteger(imageCount) || imageCount <= 0 || imageCount > maxImages) {
    return { param: "n", message: `n must be an integer between 1 and ${maxImages}` };
  }
  const allowedSizes = normalizeStringList(generation.allowedSizes);
  if (allowedSizes.length && body?.size != null && !allowedSizes.includes(String(body.size))) {
    return { param: "size", message: `size must be one of: ${allowedSizes.join(", ")}` };
  }
  const allowedQualityModes = normalizeStringList(generation.allowedQualityModes);
  if (allowedQualityModes.length && body?.quality != null && !allowedQualityModes.includes(String(body.quality))) {
    return { param: "quality", message: `quality must be one of: ${allowedQualityModes.join(", ")}` };
  }
  return null;
}