import fs from "node:fs/promises";
import path from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { appendStructuredLog } from "./logs.js";
import { buildPostgresPoolOptions, getSharedPostgresPool, quoteIdentifier } from "./postgres.js";

const DEFAULT_PERSISTENCE_MODE = "file";
const DEFAULT_LOCAL_CONFIG_PATH = "./config/config.json";
const DEFAULT_CONFIG_BLOB_NAME = "config/config.json";
const DEFAULT_BLOB_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_DATABASE_SCHEMA = "public";
const DEFAULT_DATABASE_TABLE_NAME = "proxy_configs";
const DEFAULT_DATABASE_CONFIG_KEY = "active";

let runtimeConfig = null;
let blobServiceClient = null;
let blobServiceKey = "";
let blobCredential = null;
let blobRecoveryTimer = null;
let blobRecoveryRunning = false;

const persistenceState = {
  configuredMode: DEFAULT_PERSISTENCE_MODE,
  activeMode: DEFAULT_PERSISTENCE_MODE,
  blobAccessState: "disabled",
  pendingBlobSync: false,
  lastBlobError: null,
  databaseAccessState: "disabled",
  pendingDatabaseSync: false,
  lastDatabaseError: null
};

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (["blob", "azureblob"].includes(normalized)) return "blob";
  if (["database", "db", "postgres", "postgresql"].includes(normalized)) return "database";
  if (["file", "local", "azurefile", ""].includes(normalized)) return "file";
  return DEFAULT_PERSISTENCE_MODE;
}

function resolveInt(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= minimum) {
    return numeric;
  }
  return fallback;
}

function ensureResolvedPath(filePath) {
  return path.resolve(process.cwd(), String(filePath || DEFAULT_LOCAL_CONFIG_PATH));
}

function safeParseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getEnvOverride(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function updatePersistenceState(patch) {
  Object.assign(persistenceState, patch);
}

function emitPersistenceEvent(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...fields
  };
  appendStructuredLog(level, payload);
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logger(JSON.stringify(payload));
}

function snapshotError(error) {
  if (!error) return null;
  return {
    code: error?.details?.errorCode || error?.code || "UnknownError",
    statusCode: error?.statusCode || null,
    message: error?.message || String(error)
  };
}

function resolvePersistenceSettings(config = runtimeConfig) {
  const persistence = asPlainObject(config?.persistence);
  const configStore = asPlainObject(persistence.configStore);
  const compatibilityExport = asPlainObject(persistence.compatibilityExport);
  const blob = asPlainObject(configStore.blob);
  const database = asPlainObject(configStore.database);

  const requestedMode = normalizeMode(
    getEnvOverride("PERSISTENCE_MODE", "CONFIG_PERSISTENCE_MODE")
      || configStore.mode
      || (database.enabled === true ? "database" : DEFAULT_PERSISTENCE_MODE)
  );

  const configPath = ensureResolvedPath(getEnvOverride("CONFIG_PATH") || configStore.filePath || DEFAULT_LOCAL_CONFIG_PATH);
  const compatibilityPath = ensureResolvedPath(
    getEnvOverride("LEGACY_CONFIG_PATH")
      || compatibilityExport.legacyConfigPath
      || configPath
  );

  const connectionRef = getEnvOverride("CONFIG_DB_CONNECTION_REF", "POSTGRES_CONNECTION_REF") || String(database.connectionRef || "").trim();
  const connectionString = getEnvOverride("CONFIG_DB_CONNECTION_STRING", "DATABASE_URL")
    || (connectionRef ? getEnvOverride(connectionRef) : "");

  return {
    mode: requestedMode,
    configPath,
    compatibilityPath,
    compatibilityExportEnabled: compatibilityExport.enabled !== false && compatibilityExport.exportLegacyConfigOnChange !== false,
    blob: {
      accountUrl: getEnvOverride("BLOB_ACCOUNT_URL", "AZURE_STORAGE_ACCOUNT_URL") || String(blob.accountUrl || "").trim(),
      containerName: getEnvOverride("CONFIG_BLOB_CONTAINER", "BLOB_CONTAINER_NAME") || String(blob.container || "").trim(),
      blobName: getEnvOverride("CONFIG_BLOB_NAME") || String(blob.path || DEFAULT_CONFIG_BLOB_NAME).trim(),
      healthProbeIntervalMs: resolveInt(getEnvOverride("BLOB_RECOVERY_INTERVAL_MS") || blob.healthProbeIntervalMs, DEFAULT_BLOB_RECOVERY_INTERVAL_MS, 1000)
    },
    database: {
      enabled: requestedMode === "database" || database.enabled === true,
      provider: String(database.provider || "postgresql").trim() || "postgresql",
      connectionRef,
      connectionString,
      schemaName: String(database.schema || DEFAULT_DATABASE_SCHEMA).trim() || DEFAULT_DATABASE_SCHEMA,
      tableName: String(database.tableName || DEFAULT_DATABASE_TABLE_NAME).trim() || DEFAULT_DATABASE_TABLE_NAME,
      configKey: String(database.configKey || DEFAULT_DATABASE_CONFIG_KEY).trim() || DEFAULT_DATABASE_CONFIG_KEY,
      readFallbackMode: database.readFallbackMode === "none" ? "none" : "lastKnownGood",
      pool: {
        max: resolveInt(database.pool?.max, 10, 1),
        min: resolveInt(database.pool?.min, 0, 0),
        idleTimeoutMs: resolveInt(database.pool?.idleTimeoutMs, 30000, 0),
        connectionTimeoutMs: resolveInt(database.pool?.connectionTimeoutMs, 10000, 0)
      }
    }
  };
}

function applyConfiguredMode(settings) {
  const patch = {
    configuredMode: settings.mode
  };

  if (settings.mode !== "blob") {
    if (blobRecoveryTimer) {
      clearTimeout(blobRecoveryTimer);
      blobRecoveryTimer = null;
    }
    patch.blobAccessState = "disabled";
    patch.pendingBlobSync = false;
    patch.lastBlobError = null;
  }

  if (settings.mode !== "database") {
    patch.databaseAccessState = "disabled";
    patch.pendingDatabaseSync = false;
    patch.lastDatabaseError = null;
  }

  if (settings.mode === "file") {
    patch.activeMode = "file";
  }

  updatePersistenceState(patch);
}

function getLocalReadCandidates(settings) {
  return [...new Set([settings.configPath, settings.compatibilityPath].filter(Boolean))];
}

async function ensureLocalDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readLocalConfigText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function writeLocalConfigText(filePath, text) {
  await ensureLocalDirectory(filePath);
  await fs.writeFile(filePath, text, "utf8");
}

async function tryReadLocalConfigText(filePath) {
  try {
    return await readLocalConfigText(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readLocalCacheText(settings) {
  for (const filePath of getLocalReadCandidates(settings)) {
    const text = await tryReadLocalConfigText(filePath);
    if (text != null) {
      return text;
    }
  }
  return null;
}

async function readPrimaryLocalConfigText(settings) {
  const cached = await readLocalCacheText(settings);
  if (cached != null) {
    updatePersistenceState({ activeMode: "file" });
    return cached;
  }
  return readLocalConfigText(settings.configPath);
}

async function writeLocalCacheText(settings, text) {
  const targets = new Set([settings.configPath]);
  if (settings.compatibilityExportEnabled) {
    targets.add(settings.compatibilityPath);
  }
  for (const targetPath of targets) {
    await writeLocalConfigText(targetPath, text);
  }
}

function describeBlobTarget(settings) {
  const accountUrl = settings.blob.accountUrl || "<missing-account-url>";
  const containerName = settings.blob.containerName || "<missing-container>";
  const blobName = settings.blob.blobName || DEFAULT_CONFIG_BLOB_NAME;
  return `${accountUrl}/${containerName}/${blobName}`;
}

function getBlobCredential() {
  if (!blobCredential) {
    blobCredential = new DefaultAzureCredential({
      managedIdentityClientId: process.env.AZURE_CLIENT_ID || undefined
    });
  }
  return blobCredential;
}

function getBlobService(settings) {
  if (!settings.blob.accountUrl) {
    throw new Error("BLOB_ACCOUNT_URL or persistence.configStore.blob.accountUrl is required when persistence mode is blob");
  }

  if (!blobServiceClient || blobServiceKey !== settings.blob.accountUrl) {
    blobServiceClient = new BlobServiceClient(settings.blob.accountUrl, getBlobCredential());
    blobServiceKey = settings.blob.accountUrl;
  }

  return blobServiceClient;
}

function isBlobAuthorizationError(error) {
  return error?.statusCode === 403 || error?.details?.errorCode === "AuthorizationPermissionMismatch" || error?.code === "AuthorizationPermissionMismatch";
}

function markBlobReady(settings, reason) {
  updatePersistenceState({
    configuredMode: settings.mode,
    activeMode: "blob",
    blobAccessState: "ready",
    pendingBlobSync: false,
    lastBlobError: null
  });
  emitPersistenceEvent("log", "persistence.blob_ready", {
    reason,
    target: describeBlobTarget(settings),
    activeMode: persistenceState.activeMode
  });
}

function markBlobDegraded(settings, error, patch = {}) {
  updatePersistenceState({
    configuredMode: settings.mode,
    activeMode: "file",
    blobAccessState: "degraded",
    lastBlobError: snapshotError(error),
    ...patch
  });
}

function scheduleBlobRecovery(settings) {
  if (settings.mode !== "blob" || persistenceState.blobAccessState === "ready" || blobRecoveryTimer || blobRecoveryRunning) {
    return;
  }

  blobRecoveryTimer = setTimeout(() => {
    blobRecoveryTimer = null;
    void recoverBlobAccess();
  }, settings.blob.healthProbeIntervalMs);
}

async function readBlobConfigText(settings) {
  if (!settings.blob.containerName) {
    throw new Error("CONFIG_BLOB_CONTAINER or persistence.configStore.blob.container is required when persistence mode is blob");
  }

  const containerClient = getBlobService(settings).getContainerClient(settings.blob.containerName);
  const blobClient = containerClient.getBlockBlobClient(settings.blob.blobName);
  try {
    const response = await blobClient.download();
    const chunks = [];
    for await (const chunk of response.readableStreamBody) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error?.statusCode === 404 || error?.details?.errorCode === "BlobNotFound" || error?.code === "BlobNotFound") {
      return null;
    }
    throw error;
  }
}

async function writeBlobConfigText(settings, text) {
  if (!settings.blob.containerName) {
    throw new Error("CONFIG_BLOB_CONTAINER or persistence.configStore.blob.container is required when persistence mode is blob");
  }

  const containerClient = getBlobService(settings).getContainerClient(settings.blob.containerName);
  await containerClient.createIfNotExists();
  const blobClient = containerClient.getBlockBlobClient(settings.blob.blobName);
  await blobClient.upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: {
      blobContentType: "application/json; charset=utf-8"
    }
  });
}

async function recoverBlobAccess() {
  const settings = resolvePersistenceSettings();
  if (settings.mode !== "blob" || persistenceState.blobAccessState === "ready" || blobRecoveryRunning) {
    return;
  }

  blobRecoveryRunning = true;
  try {
    if (persistenceState.pendingBlobSync) {
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        await writeBlobConfigText(settings, localText);
        markBlobReady(settings, "synced");
        return;
      }
    }

    await readBlobConfigText(settings);
    markBlobReady(settings, "probe");
  } catch (error) {
    markBlobDegraded(settings, error);
    emitPersistenceEvent("warn", "persistence.blob_probe_failed", {
      target: describeBlobTarget(settings),
      activeMode: persistenceState.activeMode,
      pendingBlobSync: persistenceState.pendingBlobSync,
      error: persistenceState.lastBlobError
    });
  } finally {
    blobRecoveryRunning = false;
    if (persistenceState.blobAccessState !== "ready") {
      scheduleBlobRecovery(settings);
    }
  }
}

function describeDatabaseTarget(settings) {
  return `${settings.database.provider}:${settings.database.schemaName}.${settings.database.tableName}/${settings.database.configKey}`;
}

function getDatabasePool(settings) {
  if (!settings.database.connectionString) {
    throw new Error("CONFIG_DB_CONNECTION_STRING, DATABASE_URL, or persistence.configStore.database.connectionRef is required when persistence mode is database");
  }

  return getSharedPostgresPool(buildPostgresPoolOptions(settings.database));
}

async function ensureDatabaseTable(settings) {
  const pool = getDatabasePool(settings);
  const schemaName = quoteIdentifier(settings.database.schemaName, "persistence.configStore.database.schema");
  const tableName = quoteIdentifier(settings.database.tableName, "persistence.configStore.database.tableName");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.${tableName} (
      config_key TEXT PRIMARY KEY,
      config_json JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function markDatabaseReady(settings, reason) {
  updatePersistenceState({
    configuredMode: settings.mode,
    activeMode: "database",
    databaseAccessState: "ready",
    pendingDatabaseSync: false,
    lastDatabaseError: null
  });
  emitPersistenceEvent("log", "persistence.database_ready", {
    reason,
    target: describeDatabaseTarget(settings),
    activeMode: persistenceState.activeMode
  });
}

function markDatabaseDegraded(settings, error, patch = {}) {
  updatePersistenceState({
    configuredMode: settings.mode,
    activeMode: "file",
    databaseAccessState: "degraded",
    lastDatabaseError: snapshotError(error),
    ...patch
  });
}

async function readDatabaseConfigText(settings) {
  await ensureDatabaseTable(settings);
  const pool = getDatabasePool(settings);
  const schemaName = quoteIdentifier(settings.database.schemaName, "persistence.configStore.database.schema");
  const tableName = quoteIdentifier(settings.database.tableName, "persistence.configStore.database.tableName");
  const result = await pool.query(
    `SELECT config_json FROM ${schemaName}.${tableName} WHERE config_key = $1 LIMIT 1`,
    [settings.database.configKey]
  );
  if (!result.rows.length) {
    return null;
  }
  return JSON.stringify(result.rows[0].config_json, null, 2);
}

async function writeDatabaseConfigText(settings, text) {
  await ensureDatabaseTable(settings);
  const pool = getDatabasePool(settings);
  const schemaName = quoteIdentifier(settings.database.schemaName, "persistence.configStore.database.schema");
  const tableName = quoteIdentifier(settings.database.tableName, "persistence.configStore.database.tableName");
  const parsed = JSON.parse(text);
  await pool.query(
    `
      INSERT INTO ${schemaName}.${tableName} (config_key, config_json, version, updated_at)
      VALUES ($1, $2::jsonb, 1, NOW())
      ON CONFLICT (config_key) DO UPDATE
      SET config_json = EXCLUDED.config_json,
          version = ${tableName}.version + 1,
          updated_at = NOW()
    `,
    [settings.database.configKey, JSON.stringify(parsed)]
  );
}

async function resolveBootstrapSettings() {
  if (runtimeConfig) {
    return resolvePersistenceSettings(runtimeConfig);
  }

  const fallbackSettings = resolvePersistenceSettings(null);
  const bootstrapText = await readLocalCacheText(fallbackSettings);
  const bootstrapConfig = safeParseJson(bootstrapText);
  return bootstrapConfig ? resolvePersistenceSettings(bootstrapConfig) : fallbackSettings;
}

export function setPersistenceConfig(config) {
  runtimeConfig = config || null;
  applyConfiguredMode(resolvePersistenceSettings(runtimeConfig));
}

export async function readPersistedConfigText() {
  const settings = await resolveBootstrapSettings();
  applyConfiguredMode(settings);

  if (settings.mode === "blob") {
    if (persistenceState.pendingBlobSync) {
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        scheduleBlobRecovery(settings);
        return localText;
      }
    }

    try {
      const blobText = await readBlobConfigText(settings);
      markBlobReady(settings, "read");
      if (blobText != null) {
        await writeLocalCacheText(settings, blobText);
        return blobText;
      }
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        return localText;
      }
      return readLocalConfigText(settings.configPath);
    } catch (error) {
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        markBlobDegraded(settings, error, { pendingBlobSync: isBlobAuthorizationError(error) });
        emitPersistenceEvent("warn", "startup.persistence_blob_fallback", {
          reason: error?.details?.errorCode || error?.code || "BlobReadFailed",
          target: describeBlobTarget(settings),
          configPath: settings.configPath,
          message: "Blob config read failed. Falling back to local cached config.",
          activeMode: persistenceState.activeMode,
          pendingBlobSync: persistenceState.pendingBlobSync,
          error: persistenceState.lastBlobError
        });
        scheduleBlobRecovery(settings);
        return localText;
      }
      throw error;
    }
  }

  if (settings.mode === "database") {
    try {
      const databaseText = await readDatabaseConfigText(settings);
      markDatabaseReady(settings, "read");
      if (databaseText != null) {
        await writeLocalCacheText(settings, databaseText);
        return databaseText;
      }
      if (settings.database.readFallbackMode === "lastKnownGood") {
        const localText = await readLocalCacheText(settings);
        if (localText != null) {
          return localText;
        }
      }
      return readLocalConfigText(settings.configPath);
    } catch (error) {
      if (settings.database.readFallbackMode === "lastKnownGood") {
        const localText = await readLocalCacheText(settings);
        if (localText != null) {
          markDatabaseDegraded(settings, error, { pendingDatabaseSync: false });
          emitPersistenceEvent("warn", "startup.persistence_database_fallback", {
            target: describeDatabaseTarget(settings),
            configPath: settings.configPath,
            message: "Database config read failed. Falling back to local cached config.",
            activeMode: persistenceState.activeMode,
            error: persistenceState.lastDatabaseError
          });
          return localText;
        }
      }
      throw error;
    }
  }

  return readPrimaryLocalConfigText(settings);
}

export async function writePersistedConfigText(text, nextConfig = null) {
  const parsedConfig = nextConfig || safeParseJson(text) || runtimeConfig;
  const settings = resolvePersistenceSettings(parsedConfig);
  applyConfiguredMode(settings);

  await writeLocalCacheText(settings, text);

  if (settings.mode === "blob") {
    try {
      await writeBlobConfigText(settings, text);
      markBlobReady(settings, "write");
    } catch (error) {
      markBlobDegraded(settings, error, { pendingBlobSync: true });
      emitPersistenceEvent("warn", "persistence.blob_write_deferred", {
        target: describeBlobTarget(settings),
        configPath: settings.configPath,
        message: "Blob config write failed. Local config was updated and blob sync will retry in the background.",
        activeMode: persistenceState.activeMode,
        pendingBlobSync: persistenceState.pendingBlobSync,
        error: persistenceState.lastBlobError
      });
      scheduleBlobRecovery(settings);
    }
    return;
  }

  if (settings.mode === "database") {
    try {
      await writeDatabaseConfigText(settings, text);
      markDatabaseReady(settings, "write");
    } catch (error) {
      markDatabaseDegraded(settings, error, { pendingDatabaseSync: true });
      emitPersistenceEvent("warn", "persistence.database_write_deferred", {
        target: describeDatabaseTarget(settings),
        configPath: settings.configPath,
        message: "Database config write failed. Local config was updated and remains the last known good copy.",
        activeMode: persistenceState.activeMode,
        pendingDatabaseSync: persistenceState.pendingDatabaseSync,
        error: persistenceState.lastDatabaseError
      });
    }
    return;
  }

  updatePersistenceState({ activeMode: "file" });
}

export function getPersistenceSummary(config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);
  applyConfiguredMode(settings);
  return {
    mode: settings.mode,
    activeMode: persistenceState.activeMode,
    blobAccessState: persistenceState.blobAccessState,
    pendingBlobSync: persistenceState.pendingBlobSync,
    lastBlobError: persistenceState.lastBlobError,
    databaseAccessState: persistenceState.databaseAccessState,
    pendingDatabaseSync: persistenceState.pendingDatabaseSync,
    lastDatabaseError: persistenceState.lastDatabaseError,
    configPath: settings.configPath,
    compatibilityPath: settings.compatibilityPath,
    blobAccountUrl: settings.blob.accountUrl,
    blobContainerName: settings.blob.containerName,
    configBlobName: settings.blob.blobName,
    databaseProvider: settings.database.provider,
    databaseSchema: settings.database.schemaName,
    databaseTableName: settings.database.tableName,
    databaseConfigKey: settings.database.configKey
  };
}