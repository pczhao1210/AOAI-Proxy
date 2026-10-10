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

export function getConfiguredPricingEntry(config, model) {
  if (model?.pricing && Object.keys(model.pricing).length) {
    return { entry: model.pricing, source: "model.pricing" };
  }
  const ref = String(model?.pricingRef || "").trim();
  const entry = config?.access?.pricingCatalog?.[ref];
  return entry && Object.keys(entry).length
    ? { entry, source: `access.pricingCatalog.${ref}` }
    : null;
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
