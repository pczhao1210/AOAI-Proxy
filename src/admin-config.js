export const REDACTED_SECRET_VALUE = "__AOAI_PROXY_REDACTED__";

const DIRECT_SECRET_PATHS = [
  ["auth", "clientSecret"],
  ["auth", "apiKey"],
  ["admin", "auth", "password"],
  ["server", "adminAuth", "password"]
];

const SENSITIVE_HEADER_NAME = /authorization|api[-_]?key|subscription[-_]?key|secret|token/i;

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function readPath(source, path) {
  return path.reduce((value, key) => value?.[key], source);
}

function writePath(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function redactValue(value) {
  return typeof value === "string" && value ? REDACTED_SECRET_VALUE : value;
}

function findCurrentItem(currentItems, candidateItem, index, identityKey) {
  const identity = typeof candidateItem?.[identityKey] === "string" ? candidateItem[identityKey] : "";
  if (identity) {
    const matched = currentItems.find((item) => item?.[identityKey] === identity);
    if (matched) return matched;
  }
  return currentItems[index] || null;
}

function matchCurrentItems(candidateItems, currentItems, identityKey) {
  const matches = new Array(candidateItems.length).fill(null);
  const usedCurrentIndexes = new Set();

  for (const [candidateIndex, candidateItem] of candidateItems.entries()) {
    const identity = typeof candidateItem?.[identityKey] === "string" ? candidateItem[identityKey] : "";
    if (!identity) continue;
    const currentIndex = currentItems.findIndex((currentItem, index) => (
      !usedCurrentIndexes.has(index) && currentItem?.[identityKey] === identity
    ));
    if (currentIndex < 0) continue;
    matches[candidateIndex] = currentItems[currentIndex];
    usedCurrentIndexes.add(currentIndex);
  }

  for (let index = 0; index < candidateItems.length; index += 1) {
    if (matches[index] || !currentItems[index] || usedCurrentIndexes.has(index)) continue;
    matches[index] = currentItems[index];
    usedCurrentIndexes.add(index);
  }
  return matches;
}

function transformUpstreamSecrets(candidateUpstreams, currentUpstreams, transform) {
  const currentMatches = matchCurrentItems(candidateUpstreams, currentUpstreams, "name");
  for (const [index, upstream] of candidateUpstreams.entries()) {
    const current = currentMatches[index];
    if (upstream?.auth && typeof upstream.auth === "object" && !Array.isArray(upstream.auth)) {
      upstream.auth.apiKey = transform(upstream.auth.apiKey, current?.auth?.apiKey);
    }
    if (!upstream?.headersTemplate || typeof upstream.headersTemplate !== "object") continue;
    for (const [headerName, headerValue] of Object.entries(upstream.headersTemplate)) {
      if (!SENSITIVE_HEADER_NAME.test(headerName)) continue;
      upstream.headersTemplate[headerName] = transform(headerValue, current?.headersTemplate?.[headerName]);
    }
  }
}

export function redactConfigSecrets(config) {
  const redacted = cloneConfig(config);
  for (const path of DIRECT_SECRET_PATHS) {
    writePath(redacted, path, redactValue(readPath(redacted, path)));
  }
  for (const apiKey of Array.isArray(redacted.apiKeys) ? redacted.apiKeys : []) {
    apiKey.key = redactValue(apiKey.key);
  }
  transformUpstreamSecrets(
    Array.isArray(redacted.upstreams) ? redacted.upstreams : [],
    [],
    (value) => redactValue(value)
  );
  return redacted;
}

export function restoreConfigSecrets(candidateConfig, currentConfig) {
  const restored = cloneConfig(candidateConfig);
  const current = currentConfig || {};
  for (const path of DIRECT_SECRET_PATHS) {
    if (readPath(restored, path) === REDACTED_SECRET_VALUE) {
      writePath(restored, path, readPath(current, path) || "");
    }
  }

  const currentApiKeys = Array.isArray(current.apiKeys) ? current.apiKeys : [];
  for (const [index, apiKey] of (Array.isArray(restored.apiKeys) ? restored.apiKeys : []).entries()) {
    if (apiKey?.key !== REDACTED_SECRET_VALUE) continue;
    const currentApiKey = findCurrentItem(currentApiKeys, apiKey, index, "id");
    apiKey.key = currentApiKey?.key || "";
  }

  transformUpstreamSecrets(
    Array.isArray(restored.upstreams) ? restored.upstreams : [],
    Array.isArray(current.upstreams) ? current.upstreams : [],
    (value, currentValue) => value === REDACTED_SECRET_VALUE ? (currentValue || "") : value
  );
  return restored;
}
