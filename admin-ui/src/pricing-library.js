function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizePricingDefinition(rawDefinition) {
  const definition = asPlainObject(rawDefinition);
  const proxyTemplate = definition.proxyTemplate && typeof definition.proxyTemplate === "object"
    ? {
      ...asPlainObject(definition.proxyTemplate),
      capabilities: normalizeStringArray(definition.proxyTemplate.capabilities),
      routes: asPlainObject(definition.proxyTemplate.routes)
    }
    : null;

  return {
    id: String(definition.id || ""),
    displayName: String(definition.displayName || definition.id || ""),
    provider: String(definition.provider || "azure-openai"),
    family: String(definition.family || ""),
    interfaces: normalizeStringArray(definition.interfaces),
    capabilities: normalizeStringArray(definition.capabilities),
    pricingCatalogEntry: definition.pricingCatalogEntry && typeof definition.pricingCatalogEntry === "object"
      ? asPlainObject(definition.pricingCatalogEntry)
      : null,
    proxyTemplate,
    supportsProxyTemplate: !!(proxyTemplate?.id && proxyTemplate?.targetModel),
    upstreamTemplate: {
      provider: String(definition.provider || "azure-openai"),
      capabilities: normalizeStringArray(definition.capabilities),
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        responses: "/openai/v1/responses",
        "images/generations": "/openai/v1/images/generations"
      }
    }
  };
}

const pricingModules = import.meta.glob("../../pricing/*.json", { eager: true });

export const bundledPricingLibrary = Object.values(pricingModules)
  .map((moduleValue) => normalizePricingDefinition(moduleValue.default || moduleValue))
  .filter((definition) => definition.id)
  .sort((left, right) => left.displayName.localeCompare(right.displayName));