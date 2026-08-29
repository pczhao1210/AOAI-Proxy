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
  const interfacesByHostingMode = Object.fromEntries(
    Object.entries(asPlainObject(definition.interfacesByHostingMode))
      .map(([mode, interfaces]) => [String(mode).trim().toLowerCase(), normalizeStringArray(interfaces)])
      .filter(([mode, interfaces]) => mode && interfaces.length > 0)
  );
  const proxyTemplate = definition.proxyTemplate && typeof definition.proxyTemplate === "object"
    ? {
      ...asPlainObject(definition.proxyTemplate),
      capabilities: normalizeStringArray(definition.proxyTemplate.capabilities),
      routes: asPlainObject(definition.proxyTemplate.routes)
    }
    : null;
  const interfaces = normalizeStringArray(definition.interfaces);

  return {
    id: String(definition.id || ""),
    aliases: normalizeStringArray(definition.aliases),
    displayName: String(definition.displayName || definition.id || ""),
    provider: String(definition.provider || "azure-openai"),
    family: String(definition.family || ""),
    interfaces,
    hostingModes: normalizeStringArray(definition.hostingModes).map((mode) => mode.toLowerCase()),
    defaultHostingMode: String(definition.defaultHostingMode || "").trim().toLowerCase(),
    interfacesByHostingMode,
    capabilities: normalizeStringArray(definition.capabilities),
    pricingCatalogEntry: definition.pricingCatalogEntry && typeof definition.pricingCatalogEntry === "object"
      ? asPlainObject(definition.pricingCatalogEntry)
      : null,
    proxyTemplate,
    supportsProxyTemplate: !!(
      proxyTemplate?.id
      && proxyTemplate?.targetModel
      && interfaces.length > 0
    ),
    upstreamTemplate: {
      provider: String(definition.provider || "azure-openai"),
      capabilities: normalizeStringArray(definition.capabilities),
      routes: {
        "chat/completions": "/openai/v1/chat/completions",
        responses: "/openai/v1/responses",
        messages: "/anthropic/v1/messages",
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