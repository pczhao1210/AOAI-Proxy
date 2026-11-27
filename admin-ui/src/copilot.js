import { COPILOT_ORIGIN, COPILOT_ROUTES } from "../../src/copilot-provider.js";

const textRoutes = Object.keys(COPILOT_ROUTES);

export function discoveryDeadline(status) {
  return Date.parse(status?.discovery?.updatedAt) + 15 * 60 * 1000;
}

export function newCopilotChannel(channelId, name) {
  return {
    channelId, name, provider: "github-copilot", status: "active", priority: 100,
    auth: { mode: "githubCopilot" }, copilot: { authProfile: "vscode" },
    baseUrl: COPILOT_ORIGIN, routes: { ...COPILOT_ROUTES },
    modelMappings: []
  };
}

export function isCopilotChannel(up) {
  return (typeof up?.provider === "string" && up.provider.trim().toLowerCase() === "github-copilot")
    || up?.auth?.mode === "githubCopilot" || up?.copilot != null;
}

export function copilotIdentity(up) {
  return JSON.stringify([up.channelId, up.provider, up.copilot?.authProfile, up.auth?.mode,
    up.auth?.credentialRef, up.baseUrl, up.routes]);
}

export function discoveredRoutes(model) {
  const routes = model?.routes;
  if (!routes || !textRoutes.every(route => textRoutes.includes(routes[route]))) return null;
  return Object.fromEntries(textRoutes.map(route => [route, routes[route]]));
}

export function selectableModels(up, status) {
  const eligible = new Map();
  if (up.status === "disabled" || up.baseUrl !== COPILOT_ORIGIN || status?.state !== "authorized" || status.errorCode
    || status.discovery?.state !== "fresh" || !(discoveryDeadline(status) > Date.now())
    || !up.auth?.credentialRef || status.credentialRef !== up.auth.credentialRef) return eligible;
  const seen = new Set();
  for (const model of status.discovery.models || []) {
    const id = model?.id;
    if (typeof id !== "string" || !id || id !== id.trim() || id.includes("*")) continue;
    if (seen.has(id)) { eligible.delete(id); continue; }
    seen.add(id);
    const routes = discoveredRoutes(model);
    if (model.selectable === true && routes && Object.values(routes).every(route => up.routes?.[route] === COPILOT_ROUTES[route])) {
      eligible.set(id, routes);
    }
  }
  return eligible;
}

export function matchesDiscoveredRoutes(row, routes) {
  return !!routes && textRoutes.every(key => row.routes?.[key] === routes[key])
    && Object.keys(row.routes).length === textRoutes.length;
}
