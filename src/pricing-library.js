import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendStructuredLog } from "./logs.js";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLED_PRICING_DIR = path.resolve(MODULE_DIR, "..", "pricing");
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_GITHUB_OWNER = "pczhao1210";
const DEFAULT_GITHUB_REPO = "AOAI-Proxy";
const DEFAULT_GITHUB_PATH = "pricing";
const PRICING_SYNC_METADATA_FILE = ".pricing-sync-meta";
const LEGACY_ROUTE_CAPABILITIES = new Set(["chat", "responses", "messages", "stream", "images", "image"]);
const DEFAULT_UPSTREAM_ROUTES = {
  "chat/completions": "/openai/v1/chat/completions",
  responses: "/openai/v1/responses",
  messages: "/anthropic/v1/messages",
  "images/generations": "/openai/v1/images/generations"
};

let pricingDefinitionsCache = null;
let pricingLookupCache = null;
let pricingCacheDir = "";
let missingPricingDirLogged = false;

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getResolvedDataDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;
}

function getPersistedPricingDir() {
  return path.resolve(getResolvedDataDir(), "pricing");
}

function getBundledPricingDir() {
  return DEFAULT_BUNDLED_PRICING_DIR;
}

function getPricingSyncSettings(overrides = {}) {
  return {
    owner: String(overrides.owner ?? process.env.PRICING_SYNC_GITHUB_OWNER ?? DEFAULT_GITHUB_OWNER).trim() || DEFAULT_GITHUB_OWNER,
    repo: String(overrides.repo ?? process.env.PRICING_SYNC_GITHUB_REPO ?? DEFAULT_GITHUB_REPO).trim() || DEFAULT_GITHUB_REPO,
    path: String(overrides.path ?? process.env.PRICING_SYNC_GITHUB_PATH ?? DEFAULT_GITHUB_PATH).trim() || DEFAULT_GITHUB_PATH,
    ref: String(overrides.ref ?? process.env.PRICING_SYNC_GITHUB_REF ?? "").trim(),
    token: String(process.env.PRICING_SYNC_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim()
  };
}

function buildGitHubHeaders(token, accept = "application/vnd.github+json") {
  const headers = {
    accept,
    "user-agent": "aoai-proxy-pricing-sync"
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildGitHubPathFragment(pathValue) {
  return String(pathValue || "")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildGitHubRawUrl(owner, repo, ref, pathValue, fileName) {
  const encodedPath = buildGitHubPathFragment(pathValue);
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodedPath}/${encodeURIComponent(fileName)}`;
}

function sanitizePricingFileName(fileName) {
  const name = path.basename(String(fileName || "").trim());
  if (!name || !name.endsWith(".json")) {
    throw new Error(`Invalid pricing file name: ${fileName || "<empty>"}`);
  }
  return name;
}

function listPricingFileNames(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function resolveActivePricingLocation() {
  const customDir = String(process.env.PRICING_DIR || "").trim();
  if (customDir) {
    return {
      source: "custom",
      dir: path.resolve(customDir)
    };
  }

  const persistedDir = getPersistedPricingDir();
  if (listPricingFileNames(persistedDir).length > 0) {
    return {
      source: "persisted",
      dir: persistedDir
    };
  }

  return {
    source: "bundled",
    dir: getBundledPricingDir()
  };
}

function readSyncMetadata(dirPath = getPersistedPricingDir()) {
  const metadataPath = path.join(dirPath, PRICING_SYNC_METADATA_FILE);
  try {
    const text = fs.readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(text);
    return asPlainObject(parsed);
  } catch {
    return {};
  }
}

function emitPricingEvent(level, event, fields = {}) {
  appendStructuredLog(level, {
    ts: new Date().toISOString(),
    source: "pricing",
    event,
    ...fields
  });
}

function rememberLookup(lookup, key, definition) {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized || lookup.has(normalized)) return;
  lookup.set(normalized, definition);
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

  return {
    id: String(definition.id || ""),
    displayName: String(definition.displayName || definition.id || ""),
    provider: String(definition.provider || "azure-openai"),
    family: String(definition.family || ""),
    modelVersion: definition.modelVersion ?? null,
    status: String(definition.status || "unknown"),
    interfaces: normalizeStringArray(definition.interfaces),
    hostingModes: normalizeStringArray(definition.hostingModes).map((mode) => mode.toLowerCase()),
    defaultHostingMode: String(definition.defaultHostingMode || "").trim().toLowerCase(),
    interfacesByHostingMode,
    inputModalities: normalizeStringArray(definition.inputModalities),
    outputModalities: normalizeStringArray(definition.outputModalities),
    capabilities: normalizeStringArray(definition.capabilities),
    pricing: asPlainObject(definition.pricing),
    pricingCatalogEntry: definition.pricingCatalogEntry && typeof definition.pricingCatalogEntry === "object"
      ? asPlainObject(definition.pricingCatalogEntry)
      : null,
    proxyTemplate,
    sources: asPlainObject(definition.sources),
    notes: Array.isArray(definition.notes) ? definition.notes.filter((item) => typeof item === "string") : [],
    supportsProxyTemplate: !!(proxyTemplate?.id && proxyTemplate?.targetModel),
    upstreamTemplate: {
      provider: String(definition.provider || "azure-openai"),
      capabilities: normalizeStringArray(definition.capabilities),
      routes: cloneJson(DEFAULT_UPSTREAM_ROUTES)
    }
  };
}

function parsePricingDefinition(text, fileName) {
  const definition = normalizePricingDefinition(JSON.parse(text));
  if (!definition.id) {
    throw new Error(`Pricing definition ${fileName} is missing required id`);
  }
  definition.fileName = fileName;
  return definition;
}

function readPricingDefinitionsFromDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return listPricingFileNames(dirPath).map((fileName) => {
    const filePath = path.join(dirPath, fileName);
    return parsePricingDefinition(fs.readFileSync(filePath, "utf8"), fileName);
  });
}

function enrichWithBundledProtocolMetadata(definitions, activeSource) {
  if (activeSource === "bundled") return definitions;
  const bundledById = new Map(
    readPricingDefinitionsFromDir(getBundledPricingDir())
      .map((definition) => [definition.id.toLowerCase(), definition])
  );
  return definitions.map((definition) => {
    const bundled = bundledById.get(definition.id.toLowerCase());
    if (!bundled) return definition;
    return {
      ...definition,
      hostingModes: definition.hostingModes.length ? definition.hostingModes : bundled.hostingModes,
      defaultHostingMode: definition.defaultHostingMode || bundled.defaultHostingMode,
      interfacesByHostingMode: Object.keys(definition.interfacesByHostingMode).length
        ? definition.interfacesByHostingMode
        : bundled.interfacesByHostingMode
    };
  });
}

function resetPricingCaches() {
  pricingDefinitionsCache = null;
  pricingLookupCache = null;
  pricingCacheDir = "";
}

function loadPricingDefinitions() {
  const activeLocation = resolveActivePricingLocation();
  if (pricingDefinitionsCache !== null && pricingCacheDir === activeLocation.dir) {
    return pricingDefinitionsCache;
  }

  if (!fs.existsSync(activeLocation.dir)) {
    if (!missingPricingDirLogged) {
      missingPricingDirLogged = true;
      emitPricingEvent("warn", "pricing.directory_missing", {
        pricingDir: activeLocation.dir,
        activeSource: activeLocation.source
      });
    }
    pricingDefinitionsCache = [];
    pricingLookupCache = null;
    pricingCacheDir = activeLocation.dir;
    return pricingDefinitionsCache;
  }

  const entries = enrichWithBundledProtocolMetadata(
    readPricingDefinitionsFromDir(activeLocation.dir),
    activeLocation.source
  )
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  pricingDefinitionsCache = entries;
  pricingLookupCache = null;
  pricingCacheDir = activeLocation.dir;
  return pricingDefinitionsCache;
}

function getPricingLookup() {
  const definitions = loadPricingDefinitions();
  if (pricingLookupCache) return pricingLookupCache;

  pricingLookupCache = new Map();
  for (const definition of definitions) {
    rememberLookup(pricingLookupCache, definition.id, definition);
    rememberLookup(pricingLookupCache, definition.displayName, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.id, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.targetModel, definition);
    rememberLookup(pricingLookupCache, definition.proxyTemplate?.pricingRef, definition);
  }

  return pricingLookupCache;
}

function buildRouterAggregateCapabilities(model, models) {
  const union = new Set();
  for (const peer of Array.isArray(models) ? models : []) {
    if (!peer || peer === model) continue;
    if (model?.upstream && peer.upstream !== model.upstream) continue;
    const definition = findPricingDefinitionForModel(peer);
    const capabilities = definition?.capabilities?.length
      ? definition.capabilities
      : normalizeStringArray(peer.capabilities);
    for (const capability of capabilities) {
      if (!LEGACY_ROUTE_CAPABILITIES.has(capability)) {
        union.add(capability);
      }
    }
  }
  return [...union];
}

export function listPricingDefinitions() {
  return loadPricingDefinitions().map((definition) => cloneJson(definition));
}

export function getPricingLibraryStatus() {
  const activeLocation = resolveActivePricingLocation();
  const syncSettings = getPricingSyncSettings();
  const syncMetadata = readSyncMetadata(
    activeLocation.source === "custom" ? activeLocation.dir : getPersistedPricingDir()
  );
  const definitions = loadPricingDefinitions();

  return {
    activeSource: activeLocation.source,
    activeDir: activeLocation.dir,
    persistedDir: getPersistedPricingDir(),
    bundledDir: getBundledPricingDir(),
    definitionCount: definitions.length,
    githubOwner: String(syncMetadata.githubOwner || syncSettings.owner || DEFAULT_GITHUB_OWNER),
    githubRepo: String(syncMetadata.githubRepo || syncSettings.repo || DEFAULT_GITHUB_REPO),
    githubPath: String(syncMetadata.githubPath || syncSettings.path || DEFAULT_GITHUB_PATH),
    githubRef: String(syncMetadata.githubRef || syncSettings.ref || ""),
    lastSyncedAt: syncMetadata.lastSyncedAt || null,
    lastSyncFileCount: Number(syncMetadata.fileCount || 0) || 0
  };
}

async function fetchGitHubJson(url, token) {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(token)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchGitHubText(url, token) {
  const response = await fetch(url, {
    headers: buildGitHubHeaders(token, "application/vnd.github.raw")
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub file download failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return text;
}

async function resolveGitHubRef(syncSettings) {
  if (syncSettings.ref) return syncSettings.ref;
  const repoUrl = `https://api.github.com/repos/${encodeURIComponent(syncSettings.owner)}/${encodeURIComponent(syncSettings.repo)}`;
  let repoInfo;
  try {
    repoInfo = await fetchGitHubJson(repoUrl, syncSettings.token);
  } catch (error) {
    if (String(error?.message || "").includes("(404)")) {
      throw new Error(`GitHub repository not found: ${syncSettings.owner}/${syncSettings.repo}. Update the pricing sync source in /admin or set PRICING_SYNC_GITHUB_OWNER and PRICING_SYNC_GITHUB_REPO.`);
    }
    throw error;
  }
  return String(repoInfo?.default_branch || "main").trim() || "main";
}

async function replacePricingDirectory(targetDir, stagingDir) {
  const parentDir = path.dirname(targetDir);
  const backupDir = `${targetDir}.backup-${Date.now()}`;
  const targetExists = fs.existsSync(targetDir);

  await fsp.mkdir(parentDir, { recursive: true });

  if (targetExists) {
    await fsp.rename(targetDir, backupDir);
  }

  try {
    await fsp.rename(stagingDir, targetDir);
  } catch (error) {
    if (targetExists && fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      await fsp.rename(backupDir, targetDir).catch(() => {});
    }
    throw error;
  }

  if (targetExists && fs.existsSync(backupDir)) {
    await fsp.rm(backupDir, { recursive: true, force: true });
  }
}

export async function syncPricingDefinitionsFromGitHub(overrides = {}) {
  const syncSettings = getPricingSyncSettings(overrides);
  const githubRef = await resolveGitHubRef(syncSettings);
  const encodedPath = buildGitHubPathFragment(syncSettings.path);
  const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(syncSettings.owner)}/${encodeURIComponent(syncSettings.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(githubRef)}`;
  let contents;
  try {
    contents = await fetchGitHubJson(contentsUrl, syncSettings.token);
  } catch (error) {
    if (String(error?.message || "").includes("(404)")) {
      throw new Error(`GitHub pricing path not found: ${syncSettings.owner}/${syncSettings.repo}/${syncSettings.path}@${githubRef}. Check owner, repo, path, and ref in the Pricing Library panel.`);
    }
    throw error;
  }

  if (!Array.isArray(contents)) {
    throw new Error("GitHub pricing path did not return a file list.");
  }

  const files = contents.filter((entry) => entry?.type === "file" && String(entry.name || "").endsWith(".json"));
  if (!files.length) {
    throw new Error("No pricing JSON files were found in the configured GitHub source.");
  }

  const targetDir = String(process.env.PRICING_DIR || "").trim()
    ? path.resolve(process.env.PRICING_DIR)
    : getPersistedPricingDir();
  const stagingDir = path.join(path.dirname(targetDir), `.pricing-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  try {
    for (const file of files) {
      const fileName = sanitizePricingFileName(file.name);
      const downloadUrl = file.download_url || buildGitHubRawUrl(syncSettings.owner, syncSettings.repo, githubRef, syncSettings.path, fileName);
      const text = await fetchGitHubText(downloadUrl, syncSettings.token);
      const rawDefinition = JSON.parse(text);
      parsePricingDefinition(text, fileName);
      await fsp.writeFile(path.join(stagingDir, fileName), `${JSON.stringify(rawDefinition, null, 2)}\n`, "utf8");
    }

    const metadata = {
      lastSyncedAt: new Date().toISOString(),
      githubOwner: syncSettings.owner,
      githubRepo: syncSettings.repo,
      githubPath: syncSettings.path,
      githubRef,
      fileCount: files.length
    };
    await fsp.writeFile(path.join(stagingDir, PRICING_SYNC_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    await replacePricingDirectory(targetDir, stagingDir);
    resetPricingCaches();

    const status = getPricingLibraryStatus();
    const items = listPricingDefinitions();
    emitPricingEvent("info", "pricing.library_synced", {
      githubRepo: `${syncSettings.owner}/${syncSettings.repo}`,
      githubRef,
      pricingDir: targetDir,
      fileCount: files.length
    });

    return {
      items,
      status,
      syncedFiles: files.length
    };
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function getPricingDefinition(definitionId) {
  if (!definitionId) return null;
  return getPricingLookup().get(String(definitionId).trim().toLowerCase()) || null;
}

export function findPricingDefinitionForModel(model) {
  const candidates = [
    model?.pricingRef,
    model?.id,
    model?.targetModel,
    model?.displayName
  ];
  for (const candidate of candidates) {
    const definition = getPricingDefinition(candidate);
    if (definition) return definition;
  }
  return null;
}

export function hasLegacyRouteCapabilities(capabilities) {
  const normalized = normalizeStringArray(capabilities);
  return normalized.length > 0 && normalized.every((capability) => LEGACY_ROUTE_CAPABILITIES.has(capability));
}

export function resolveNativeModelCapabilities(model, models = []) {
  const currentCapabilities = normalizeStringArray(model?.capabilities);
  const definition = findPricingDefinitionForModel(model);

  if (definition?.capabilities?.length && (currentCapabilities.length === 0 || hasLegacyRouteCapabilities(currentCapabilities))) {
    return [...definition.capabilities];
  }

  if (currentCapabilities.length === 0 || !hasLegacyRouteCapabilities(currentCapabilities)) {
    return currentCapabilities;
  }

  const routerLike = `${model?.id || ""} ${model?.targetModel || ""}`.toLowerCase().includes("router");
  if (routerLike) {
    const aggregateCapabilities = buildRouterAggregateCapabilities(model, models);
    if (aggregateCapabilities.length) return aggregateCapabilities;
  }

  const fallbackCapabilities = [];
  if (currentCapabilities.includes("stream")) {
    fallbackCapabilities.push("streaming");
  }
  return fallbackCapabilities;
}