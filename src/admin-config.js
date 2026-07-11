export const REDACTED_SECRET_VALUE = "__AOAI_PROXY_REDACTED__";

const SECRET_PATHS = [
  ["auth", "clientSecret"],
  ["auth", "apiKey"],
  ["server", "adminAuth", "password"]
];

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

function findCurrentApiKey(currentApiKeys, candidateApiKey, index) {
  const id = typeof candidateApiKey?.id === "string" ? candidateApiKey.id : "";
  if (id) {
    const matched = currentApiKeys.find((apiKey) => apiKey?.id === id);
    if (matched) return matched;
  }
  return currentApiKeys[index] || null;
}

export function redactConfigSecrets(config) {
  const redacted = cloneConfig(config);
  for (const path of SECRET_PATHS) {
    writePath(redacted, path, redactValue(readPath(redacted, path)));
  }
  for (const apiKey of Array.isArray(redacted.apiKeys) ? redacted.apiKeys : []) {
    apiKey.key = redactValue(apiKey.key);
  }
  return redacted;
}

export function restoreConfigSecrets(candidateConfig, currentConfig) {
  const restored = cloneConfig(candidateConfig);
  const current = currentConfig || {};
  for (const path of SECRET_PATHS) {
    if (readPath(restored, path) === REDACTED_SECRET_VALUE) {
      writePath(restored, path, readPath(current, path) || "");
    }
  }

  const currentApiKeys = Array.isArray(current.apiKeys) ? current.apiKeys : [];
  for (const [index, apiKey] of (Array.isArray(restored.apiKeys) ? restored.apiKeys : []).entries()) {
    if (apiKey?.key !== REDACTED_SECRET_VALUE) continue;
    apiKey.key = findCurrentApiKey(currentApiKeys, apiKey, index)?.key || "";
  }
  return restored;
}