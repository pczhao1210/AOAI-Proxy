import { compilePricingPolicy } from "./token-pricing.js";
import { COPILOT_ORIGIN, COPILOT_ROUTES, copilotError } from "./copilot-provider.js";

// These fields belong to the deployment, not to the public model identity.
export const deploymentFields = ["routes", "hostingMode", "pricing"];
export const derivedBindingFields = ["upstream", "targetModel", "pricingRef", ...deploymentFields];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactId(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !value.includes("*");
}

function onlyFields(value, fields, path) {
  if (!object(value)) throw new Error(`${path} must be an object`);
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error(`${path}.${field} is not a supported field`);
  }
}

function validateDeploymentFields(row, path) {
  const protocol = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
  if ("routes" in row && (!object(row.routes) || Object.entries(row.routes).some(([key, target]) =>
    (key !== "*" && !protocol.test(key)) || typeof target !== "string" || !protocol.test(target)))) {
    throw new Error(`${path}.routes must map protocol names to protocol targets`);
  }
  if ("hostingMode" in row && !["azure", "anthropic"].includes(row.hostingMode)) throw new Error(`${path}.hostingMode is invalid`);
  if ("pricing" in row) {
    if (!object(row.pricing)) throw new Error(`${path}.pricing must be an object`);
    compilePricingPolicy(row.pricing, `${path}.pricing`);
  }
}

export function validateMappingRows(rows, path, catalogIds) {
  if (!Array.isArray(rows)) throw new Error(`${path} must be an array`);
  const bySource = new Map();
  for (const [i, row] of rows.entries()) {
    const label = `${path}[${i}]`;
    onlyFields(row, ["sourceModelId", "canonicalModelId", "enabled", ...deploymentFields], label);
    if (!exactId(row.sourceModelId)) throw new Error(`${label}.sourceModelId requires an exact deployment ID`);
    if (!exactId(row.canonicalModelId) || !catalogIds.has(row.canonicalModelId)) {
      throw new Error(`${label}.canonicalModelId requires an exact Model Catalog ID`);
    }
    if (typeof row.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
    if (bySource.has(row.sourceModelId)) throw new Error(`${label}.sourceModelId duplicates ${row.sourceModelId}`);
    validateDeploymentFields(row, label);
    bySource.set(row.sourceModelId, row);
  }
  for (const row of rows) {
    const chained = bySource.get(row.canonicalModelId);
    if (chained && chained.canonicalModelId !== row.canonicalModelId) {
      throw new Error(`${path}: mapping chain through ${row.canonicalModelId} is not allowed`);
    }
  }
  return bySource;
}

export function sameBinding(left, right) {
  return !!left && !!right && left.channelId === right.channelId && left.sourceModelId === right.sourceModelId;
}

export function hasHarnessRouteConfirmation(model) {
  return ["clientNativeRoute", "clientConversion"].some(field => Object.values(model[field] || {}).includes(true));
}

export function resolveChannelModels(config, catalogIds) {
  const channels = new Map();
  const managedNames = new Set();
  for (const [i, up] of config.upstreams.entries()) {
    if (up.provider === "github-copilot" || up.copilot != null || up.auth?.mode === "githubCopilot") {
      if (up.provider !== "github-copilot" || up.auth?.mode !== "githubCopilot" || !["vscode", "opencode"].includes(up.copilot?.authProfile)
        || !/^[a-zA-Z0-9._-]{1,128}$/.test(up.channelId ?? "") || !up.auth.credentialRef
        || up.auth.apiKey || Object.keys(up.auth).some(k => !["mode", "apiKey", "credentialRef"].includes(k))
        || Object.keys(up.copilot).some(k => !["authProfile", "approval"].includes(k))) throw copilotError("COPILOT_CREDENTIAL_MISMATCH");
      if (up.baseUrl !== COPILOT_ORIGIN || up.resourceName || up.apiVersion || Object.keys(up.headersTemplate || {}).length
        || !object(up.routes) || Object.entries(up.routes).some(([k, v]) => !Object.hasOwn(COPILOT_ROUTES, k) || v !== COPILOT_ROUTES[k])) {
        throw copilotError("COPILOT_ENDPOINT_INVALID");
      }
    }
    if (!("modelMappings" in up || "channelId" in up)) continue;
    if (!exactId(up.channelId) || channels.has(up.channelId)) throw new Error(`upstreams[${i}].channelId must be unique and nonempty`);
    const rows = validateMappingRows(up.modelMappings, `upstreams[${i}].modelMappings`, catalogIds);
    if (up.provider === "github-copilot" && [...rows.values()].some(row => row.hostingMode || (row.enabled &&
      (!object(row.routes) || Object.keys(row.routes).length !== 3 || Object.keys(COPILOT_ROUTES).some(key =>
        !Object.hasOwn(COPILOT_ROUTES, row.routes[key]) || !up.routes[row.routes[key]]))))) throw copilotError("COPILOT_ROUTE_NOT_APPROVED");
    channels.set(up.channelId, { up, rows });
    managedNames.add(up.name);
  }
  return config.models.map((model, i) => {
    if (!("selectedBinding" in model || "canonicalModelId" in model || "bindingOverride" in model)) {
      if (managedNames.has(model.upstream)) throw new Error(`model ${model.id} requires a selectedBinding for ${model.upstream}`);
      return model;
    }
    const ref = model.selectedBinding;
    onlyFields(ref, ["channelId", "sourceModelId"], `models[${i}].selectedBinding`);
    const channel = channels.get(ref.channelId);
    const row = channel?.rows.get(ref.sourceModelId);
    if (!row?.enabled || row.canonicalModelId !== model.canonicalModelId) {
      throw new Error(`model ${model.id}: selectedBinding must reference an enabled mapping for ${model.canonicalModelId}`);
    }
    if (hasHarnessRouteConfirmation(model) && !sameBinding(ref, model.confirmedRouteBinding)) {
      throw new Error(`model ${model.id}: confirm Harness routing for the selected binding`);
    }
    const override = model.bindingOverride;
    if (override !== undefined) {
      if (channel.up.provider === "github-copilot" && sameBinding(override, ref)) throw copilotError("COPILOT_ROUTE_NOT_APPROVED");
      onlyFields(override, ["channelId", "sourceModelId", "pricingRef", ...deploymentFields], `models[${i}].bindingOverride`);
      if (!exactId(override.channelId) || !exactId(override.sourceModelId)) throw new Error(`models[${i}].bindingOverride requires a binding identity`);
      if ("pricingRef" in override && typeof override.pricingRef !== "string") throw new Error(`models[${i}].bindingOverride.pricingRef is invalid`);
      validateDeploymentFields(override, `models[${i}].bindingOverride`);
    }
    return effectiveChannelModel(model, channel.up, row);
  });
}

export function effectiveChannelModel(model, upstream, row) {
  const effective = { ...model, upstream: upstream.name, targetModel: row.sourceModelId, pricingRef: row.canonicalModelId };
  for (const key of deploymentFields) {
    if (Object.hasOwn(row, key)) effective[key] = row[key];
  }
  if (sameBinding(model.bindingOverride, model.selectedBinding)) {
    for (const key of ["pricingRef", ...deploymentFields]) {
      if (Object.hasOwn(model.bindingOverride, key)) effective[key] = model.bindingOverride[key];
    }
  }
  return effective;
}
