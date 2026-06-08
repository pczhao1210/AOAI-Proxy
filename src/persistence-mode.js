const DEFAULT_PERSISTENCE_MODE = "azureFile";

const MODE_ALIASES = new Map([
  ["", DEFAULT_PERSISTENCE_MODE],
  ["file", "file"],
  ["local", "file"],
  ["azurefile", "azureFile"],
  ["azurefiles", "azureFile"],
  ["fileshare", "azureFile"],
  ["blob", "blob"],
  ["storageblob", "blob"]
]);

export const SUPPORTED_PERSISTENCE_MODES = [
  "file",
  "azureFile",
  "blob"
];

function normalizeToken(token) {
  const simplified = String(token || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return MODE_ALIASES.get(simplified) || "";
}

export function parsePersistenceMode(mode) {
  const input = String(mode || "").trim();
  const normalizedMode = normalizeToken(input) || DEFAULT_PERSISTENCE_MODE;
  const valid = !input || SUPPORTED_PERSISTENCE_MODES.includes(normalizedMode);

  return {
    input,
    normalizedMode,
    valid,
    unknownTokens: valid ? [] : [input],
    usesBlob: normalizedMode === "blob",
    usesAzureFile: normalizedMode === "azureFile"
  };
}

export function normalizePersistenceMode(mode) {
  return parsePersistenceMode(mode).normalizedMode;
}

export function isSupportedPersistenceMode(mode) {
  return parsePersistenceMode(mode).valid;
}
