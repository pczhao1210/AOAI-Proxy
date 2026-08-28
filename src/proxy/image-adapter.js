import { getDescriptorProtocolProfile } from "../model-catalog.js";
import { findPricingDefinitionForModel } from "../pricing-library.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function parseSize(value) {
  const match = normalizeString(value).match(/^(\d+)x(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function isDeploymentImageApi(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.pathname.toLowerCase().includes("/openai/deployments/")
      && parsed.pathname.toLowerCase().endsWith("/images/generations");
  } catch {
    return false;
  }
}

export function isBlackForestLabsProviderPath(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.pathname.toLowerCase().includes("/providers/blackforestlabs/");
  } catch {
    return false;
  }
}

function matchesRequestTransport(transport, targetUrl) {
  if (!transport || transport === "any") return true;
  if (transport === "azure-deployment") return isDeploymentImageApi(targetUrl);
  if (transport === "blackforest-provider") return isBlackForestLabsProviderPath(targetUrl);
  return false;
}

function applyImageRequestProfile(body, requestProfile, targetUrl) {
  const nextBody = body && typeof body === "object" ? { ...body } : {};
  if (!requestProfile || !matchesRequestTransport(requestProfile.transport, targetUrl)) {
    return nextBody;
  }
  if (requestProfile.removeModel === true) delete nextBody.model;
  const normalizedQuality = normalizeLower(nextBody.quality);
  const mappedQuality = requestProfile.qualityAliases?.[normalizedQuality];
  if (mappedQuality) nextBody.quality = mappedQuality;
  const sizeExpansion = requestProfile.sizeExpansion;
  const parsedSize = sizeExpansion ? parseSize(nextBody[sizeExpansion.source]) : null;
  if (parsedSize) {
    nextBody[sizeExpansion.width] = parsedSize.width;
    nextBody[sizeExpansion.height] = parsedSize.height;
  }
  for (const parameter of requestProfile.dropParameters || []) {
    delete nextBody[parameter];
  }
  return nextBody;
}

export function prepareImageGenerationRequest({ body, model, descriptor, routeKey, backendRouteKey, targetUrl }) {
  if (routeKey !== "images/generations" || backendRouteKey !== "images/generations") {
    return body;
  }
  const definition = descriptor?.definition || findPricingDefinitionForModel(model);
  const requestProfile = descriptor
    ? getDescriptorProtocolProfile(descriptor, "images/generations")?.request
    : definition?.protocolProfiles?.["images/generations"]?.request;
  return applyImageRequestProfile(body, requestProfile, targetUrl);
}