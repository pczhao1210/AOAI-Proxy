import crypto from "node:crypto";
import { compilePricingPolicy } from "./token-pricing.js";
import { getModelCardPricing } from "./model-card.js";

export function compilePricingResolution(entry, source) {
  const pricing = compilePricingPolicy(entry, source);
  return Object.freeze({
    pricing,
    source,
    policyDigest: pricing ? crypto.createHash("sha256").update(JSON.stringify(pricing)).digest("hex") : ""
  });
}

export function compileDefinitionPricing(definition) {
  return compilePricingResolution(getModelCardPricing(definition), `pricing-library.${definition.id}`);
}

export function resolveConfiguredPricing(config, model, resolveDefinition) {
  if (model?.pricing && Object.keys(model.pricing).length) {
    return compilePricingResolution(model.pricing, "model.pricing");
  }
  const ref = String(model?.pricingRef || "").trim();
  const entry = config?.access?.pricingCatalog?.[ref];
  if (entry && Object.keys(entry).length) {
    return compilePricingResolution(entry, `access.pricingCatalog.${ref}`);
  }
  return resolveDefinition(model);
}

export function createPricingContext(config, definitions) {
  const pricingConfig = structuredClone({
    models: (config?.models || []).map(({ id, targetModel, pricingRef, displayName, pricing }) => ({
      id, targetModel, pricingRef, displayName, ...(pricing ? { pricing } : {})
    })),
    access: { pricingCatalog: config?.access?.pricingCatalog || {} }
  });
  const library = new Map();
  for (const definition of definitions) {
    const resolved = compileDefinitionPricing(definition);
    for (const key of [definition.id, ...(definition.aliases || []), definition.displayName, definition.proxyTemplate?.id,
      definition.proxyTemplate?.targetModel, definition.proxyTemplate?.pricingRef]) {
      const normalized = String(key || "").trim().toLowerCase();
      if (normalized && !library.has(normalized)) library.set(normalized, resolved);
    }
  }
  const resolveDefinition = (model) => {
    for (const key of [model?.pricingRef, model?.id, model?.targetModel, model?.displayName]) {
      const resolved = library.get(String(key || "").trim().toLowerCase());
      if (resolved) return resolved;
    }
    return { pricing: null, source: "", policyDigest: "" };
  };
  const configured = new Map();
  for (const model of pricingConfig.models) {
    configured.set(model, resolveConfiguredPricing(pricingConfig, model, resolveDefinition));
  }
  for (const [ref, entry] of Object.entries(pricingConfig.access.pricingCatalog)) {
    compilePricingResolution(entry, `access.pricingCatalog.${ref}`);
  }
  const freeze = (value) => {
    if (!value || typeof value !== "object") return value;
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  };
  freeze(pricingConfig);
  return Object.freeze({
    config: pricingConfig,
    resolve(model) {
      return configured.get(model) || resolveConfiguredPricing(pricingConfig, model, resolveDefinition);
    }
  });
}
