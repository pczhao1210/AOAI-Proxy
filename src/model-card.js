function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function getModelCardPricing(definition) {
  if (Object.hasOwn(definition, "pricingCatalogEntry")) {
    const entry = definition.pricingCatalogEntry;
    if (entry !== null && !isObject(entry)) {
      throw new Error(`Model Catalog ${definition.id || ""}.pricingCatalogEntry must be an object or null`);
    }
    return entry;
  }
  return definition.pricing ?? null;
}

export function getModelCardTemplateDefaults(definition) {
  return {
    id: definition.id,
    displayName: definition.displayName || definition.id,
    targetModel: definition.id,
    pricingRef: definition.id,
    capabilities: definition.capabilities || []
  };
}

export function expandModelCard(definition) {
  return {
    ...definition,
    pricingCatalogEntry: getModelCardPricing(definition),
    proxyTemplate: isObject(definition.proxyTemplate)
      ? { ...getModelCardTemplateDefaults(definition), ...definition.proxyTemplate }
      : null
  };
}
