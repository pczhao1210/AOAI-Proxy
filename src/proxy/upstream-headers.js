import { sanitizeConfiguredUpstreamHeaders, sanitizeIncomingHeaders } from "./body.js";
import { buildCorrelationHeaders } from "../request-context.js";

const ANTHROPIC_REQUEST_HEADERS = new Set(["anthropic-version", "anthropic-beta"]);
const ANTHROPIC_SDK_METADATA_HEADER_PREFIXES = ["x-anthropic-", "x-claude-", "x-stainless-"];
const ANTHROPIC_HEADER_PREFIXES = ["anthropic-", ...ANTHROPIC_SDK_METADATA_HEADER_PREFIXES];

function isDirectAnthropicUpstream(upstream, targetUrl) {
  const provider = String(upstream?.provider || "").trim().toLowerCase();
  if (["anthropic", "anthropic-api"].includes(provider)) return true;
  try {
    const hostname = new URL(targetUrl).hostname.toLowerCase();
    return hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}

function applyAnthropicBetaPolicy(headers, config, { upstream, targetUrl }) {
  const policy = config?.compatibility?.anthropic || {};
  const allowUnknownBetas = policy.unknownBetaPolicy !== "allowlist"
    && isDirectAnthropicUpstream(upstream, targetUrl);
  const allowed = new Set(Array.isArray(policy.betaAllowlist)
    ? policy.betaAllowlist.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : []);
  const seen = new Set();
  const accepted = [];
  const filtered = [];
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() !== "anthropic-beta") continue;
    const values = String(headers[headerName] || "").split(",");
    delete headers[headerName];
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      if (!allowUnknownBetas && policy.betaAllowlistEnabled !== false && !allowed.has(value)) {
        filtered.push(value);
        continue;
      }
      accepted.push(value);
    }
  }
  if (accepted.length) headers["anthropic-beta"] = accepted.join(",");
  return filtered;
}

export function buildUpstreamHeaders({ incomingHeaders, config, backendRouteKey, upstream, targetUrl, upstreamAuthHeaders, requestContext }) {
  const forwardSdkMetadata = backendRouteKey === "messages"
    && config?.compatibility?.anthropic?.forwardSdkMetadataHeaders !== false;
  const headers = {
    ...sanitizeIncomingHeaders(incomingHeaders, config, {
      allowPrefixes: forwardSdkMetadata ? ANTHROPIC_HEADER_PREFIXES : [],
      denyPrefixes: backendRouteKey === "messages" && !forwardSdkMetadata
        ? ANTHROPIC_SDK_METADATA_HEADER_PREFIXES
        : []
    }),
    ...sanitizeConfiguredUpstreamHeaders(upstream.headersTemplate),
    "content-type": "application/json",
    ...(backendRouteKey === "messages"
      ? { "anthropic-version": String(incomingHeaders["anthropic-version"] || "2023-06-01").trim() || "2023-06-01" }
      : {}),
    ...upstreamAuthHeaders,
    ...(config?.proxy?.forwardHeaders?.addRequestIdHeader === false ? {} : buildCorrelationHeaders(requestContext))
  };
  if (backendRouteKey !== "messages") {
    for (const headerName of Object.keys(headers)) {
      if (ANTHROPIC_REQUEST_HEADERS.has(headerName.toLowerCase())) delete headers[headerName];
    }
    return { headers, filteredBetas: [] };
  }
  return { headers, filteredBetas: applyAnthropicBetaPolicy(headers, config, { upstream, targetUrl }) };
}