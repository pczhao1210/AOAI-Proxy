import { findPricingDefinitionForModel } from "../pricing-library.js";

const GPT_IMAGE_QUALITY_MAP = {
  standard: "medium",
  hd: "high"
};

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

function isGptImageModel(definition, model) {
  const candidates = [
    definition?.id,
    model?.pricingRef,
    model?.targetModel,
    model?.id
  ];
  return candidates.some((value) => normalizeLower(value).startsWith("gpt-image-"));
}

function adaptDeploymentImageRequest(body, definition, model) {
  const nextBody = body && typeof body === "object" ? { ...body } : {};
  delete nextBody.model;

  if (isGptImageModel(definition, model)) {
    const normalizedQuality = normalizeLower(nextBody.quality);
    if (normalizedQuality && GPT_IMAGE_QUALITY_MAP[normalizedQuality]) {
      nextBody.quality = GPT_IMAGE_QUALITY_MAP[normalizedQuality];
    }
    delete nextBody.style;
    delete nextBody.response_format;
  }

  return nextBody;
}

function adaptBflImageRequest(body) {
  const nextBody = body && typeof body === "object" ? { ...body } : {};
  const parsedSize = parseSize(nextBody.size);
  if (parsedSize) {
    nextBody.width = parsedSize.width;
    nextBody.height = parsedSize.height;
  }
  delete nextBody.size;
  delete nextBody.background;
  delete nextBody.input_fidelity;
  delete nextBody.moderation;
  delete nextBody.output_compression;
  delete nextBody.partial_images;
  delete nextBody.response_format;
  delete nextBody.stream;
  delete nextBody.style;
  delete nextBody.user;
  return nextBody;
}

export function prepareImageGenerationRequest({ body, model, routeKey, backendRouteKey, targetUrl }) {
  if (routeKey !== "images/generations" || backendRouteKey !== "images/generations") {
    return body;
  }
  const definition = findPricingDefinitionForModel(model);
  if (isBlackForestLabsProviderPath(targetUrl)) {
    return adaptBflImageRequest(body);
  }
  if (isDeploymentImageApi(targetUrl)) {
    return adaptDeploymentImageRequest(body, definition, model);
  }
  return body;
}