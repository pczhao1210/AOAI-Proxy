import { recordGovernanceMediaUsage } from "../governance.js";
import { findPricingDefinitionForModel } from "../pricing-library.js";
import { recordRuntimeMediaUsage } from "../runtime-store.js";
import { recordMediaUsage, recordUsage } from "../stats.js";

export function resolveMediaPricing(config, model, upstream, descriptor, targetUrl) {
  const overrides = [[model?.pricing, "model.pricing"],
    [config?.access?.pricingCatalog?.[model?.pricingRef], `access.pricingCatalog.${model?.pricingRef}`]];
  for (const [pricing, source] of overrides) {
    if (pricing && Object.keys(pricing).length) return pricing.billingUnit ? structuredClone({ ...pricing, source }) : null;
  }
  const definition = descriptor?.definition || findPricingDefinitionForModel(model);
  const pricing = definition?.pricing;
  let azureEndpoint = true;
  try {
    const target = new URL(targetUrl);
    azureEndpoint = target.pathname.startsWith("/openai/") || /\.(azure\.com|microsoft\.com)$/.test(target.hostname);
  } catch {}
  if (azureEndpoint || model?.hostingMode === "azure" || !["openai", "openai-api"].includes(upstream?.provider)
    || pricing?.sourceType !== "openai-official" || pricing.status !== "published") return null;
  return structuredClone({ ...pricing, source: `pricing-library.${definition.id}` });
}

export function settleMediaUsage({ config, consumer, model, usage, requestContext = {}, routeKey = "", backendRouteKey = "", completed = true }) {
  const snapshot = { ...usage };
  if (!completed) {
    snapshot.usageStatus = "partial";
    snapshot.costStatus = Object.keys(snapshot.knownCostAmounts || {}).length ? "partial" : "unknown";
    snapshot.estimatedCostAmount = null;
  }
  const cost = recordGovernanceMediaUsage(config, consumer, snapshot);
  recordMediaUsage(model.id, snapshot, consumer);
  recordUsage(model.id, { prompt_tokens: cost.promptTokens, completion_tokens: cost.completionTokens,
    total_tokens: cost.totalTokens, cached_tokens: cost.cachedTokens }, { ...consumer, cost });
  recordRuntimeMediaUsage(config, { ...requestContext, keyId: consumer?.keyId, modelId: model.id,
    routeKey, backendRouteKey, ...cost, estimatedCostAmount: cost.amount, mediaUsage: snapshot });
  return snapshot;
}