const DEFAULT_PERSISTENCE_MODE = "file";

const CONFIG_BACKENDS = new Set(["file", "database"]);
const MODE_ALIASES = new Map([
  ["", "file"],
  ["file", "file"],
  ["local", "file"],
  ["database", "database"],
  ["db", "database"],
  ["postgres", "database"],
  ["postgresql", "database"],
  ["azurefile", "azurefile"],
  ["azurefiles", "azurefile"],
  ["fileshare", "azurefile"]
]);

export const SUPPORTED_PERSISTENCE_MODES = [
  "file",
  "azureFile",
  "database",
  "database+azureFile"
];

function normalizeToken(token) {
  const simplified = String(token || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return MODE_ALIASES.get(simplified) || "";
}

function canonicalizeMode(configStoreMode, usesAzureFile) {
  if (usesAzureFile) {
    return configStoreMode === "file" ? "azureFile" : `${configStoreMode}+azureFile`;
  }
  return configStoreMode;
}

export function parsePersistenceMode(mode) {
  const input = String(mode || "").trim();
  if (!input) {
    return {
      input,
      normalizedMode: DEFAULT_PERSISTENCE_MODE,
      configStoreMode: DEFAULT_PERSISTENCE_MODE,
      usesAzureFile: false,
      usesDatabase: false,
      valid: true,
      unknownTokens: [],
      hasMultipleConfigBackends: false
    };
  }

  const rawTokens = input.split(/[+,]/).map((token) => token.trim()).filter(Boolean);
  const unknownTokens = [];
  const normalizedTokens = [];

  for (const rawToken of rawTokens) {
    const normalizedToken = normalizeToken(rawToken);
    if (!normalizedToken) {
      unknownTokens.push(rawToken);
      continue;
    }
    if (!normalizedTokens.includes(normalizedToken)) {
      normalizedTokens.push(normalizedToken);
    }
  }

  const configTokens = normalizedTokens.filter((token) => CONFIG_BACKENDS.has(token));
  const hasMultipleConfigBackends = configTokens.length > 1;
  const configStoreMode = hasMultipleConfigBackends
    ? DEFAULT_PERSISTENCE_MODE
    : (configTokens[0] || (normalizedTokens.includes("azurefile") ? "file" : DEFAULT_PERSISTENCE_MODE));
  const usesAzureFile = normalizedTokens.includes("azurefile");
  const normalizedMode = canonicalizeMode(configStoreMode, usesAzureFile);

  return {
    input,
    normalizedMode,
    configStoreMode,
    usesAzureFile,
    usesDatabase: configStoreMode === "database",
    valid: unknownTokens.length === 0 && !hasMultipleConfigBackends,
    unknownTokens,
    hasMultipleConfigBackends
  };
}

export function normalizePersistenceMode(mode) {
  return parsePersistenceMode(mode).normalizedMode;
}

export function isSupportedPersistenceMode(mode) {
  const parsed = parsePersistenceMode(mode);
  return parsed.valid && SUPPORTED_PERSISTENCE_MODES.includes(parsed.normalizedMode);
}
