import fs from "node:fs/promises";
import path from "node:path";
import { appendStructuredLog } from "./logs.js";
import { buildPostgresPoolOptions, getSharedPostgresPool, probePostgresConnection, quoteIdentifier } from "./postgres.js";
import { parsePersistenceMode } from "./persistence-mode.js";

const DEFAULT_PERSISTENCE_MODE = "file";
const DEFAULT_LOCAL_CONFIG_PATH = "./config/config.json";
const DEFAULT_DATABASE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_DATABASE_SCHEMA = "public";
const DEFAULT_DATABASE_TABLE_NAME = "proxy_configs";
const DEFAULT_DATABASE_CONFIG_KEY = "active";

let runtimeConfig = null;
let databaseRecoveryTimer = null;
let databaseRecoveryRunning = false;

const persistenceState = {
  configuredMode: DEFAULT_PERSISTENCE_MODE,
  activeMode: DEFAULT_PERSISTENCE_MODE,
  databaseAccessState: "disabled",
  pendingDatabaseSync: false,
  lastDatabaseError: null,
  nextDatabaseRecoveryAttemptAt: null
};

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  const database = asPlainObject(configStore.database);

  const requestedMode = parsePersistenceMode(
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
    mode: requestedMode.normalizedMode,
    configStoreMode: requestedMode.configStoreMode,
    usesAzureFile: requestedMode.usesAzureFile,
    configPath,
    compatibilityPath,
    compatibilityExportEnabled: compatibilityExport.enabled !== false && compatibilityExport.exportLegacyConfigOnChange !== false,
    database: {
      enabled: requestedMode.usesDatabase || database.enabled === true,
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

  if (settings.configStoreMode !== "database") {
    if (databaseRecoveryTimer) {
      clearTimeout(databaseRecoveryTimer);
      databaseRecoveryTimer = null;
    }
    patch.databaseAccessState = "disabled";
    patch.pendingDatabaseSync = false;
    patch.lastDatabaseError = null;
    patch.nextDatabaseRecoveryAttemptAt = null;
  }

  if (settings.configStoreMode === "file") {
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

function getDatabasePendingSyncMarkerPath(settings) {
  return `${settings.configPath}.database-pending-sync`;
}

async function hasDatabasePendingSyncMarker(settings) {
  try {
    await fs.access(getDatabasePendingSyncMarkerPath(settings));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeDatabasePendingSyncMarker(settings) {
  const markerPath = getDatabasePendingSyncMarkerPath(settings);
  await ensureLocalDirectory(markerPath);
  await fs.writeFile(markerPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    target: describeDatabaseTarget(settings)
  }, null, 2), "utf8");
}

async function clearDatabasePendingSyncMarker(settings) {
  try {
    await fs.unlink(getDatabasePendingSyncMarkerPath(settings));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
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
    lastDatabaseError: null,
    nextDatabaseRecoveryAttemptAt: null
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

function scheduleDatabaseRecovery(settings) {
  if (
    settings.configStoreMode !== "database"
    || (persistenceState.databaseAccessState === "ready" && !persistenceState.pendingDatabaseSync)
    || databaseRecoveryTimer
    || databaseRecoveryRunning
  ) {
    return;
  }

  const nextAttemptAt = new Date(Date.now() + DEFAULT_DATABASE_RECOVERY_INTERVAL_MS).toISOString();
  updatePersistenceState({ nextDatabaseRecoveryAttemptAt: nextAttemptAt });

  databaseRecoveryTimer = setTimeout(() => {
    databaseRecoveryTimer = null;
    updatePersistenceState({ nextDatabaseRecoveryAttemptAt: null });
    void recoverDatabaseAccess();
  }, DEFAULT_DATABASE_RECOVERY_INTERVAL_MS);
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

async function recoverDatabaseAccess() {
  const settings = resolvePersistenceSettings();
  if (
    settings.configStoreMode !== "database"
    || databaseRecoveryRunning
    || (persistenceState.databaseAccessState === "ready" && !persistenceState.pendingDatabaseSync)
  ) {
    return;
  }

  databaseRecoveryRunning = true;
  try {
    const hasPendingMarker = await hasDatabasePendingSyncMarker(settings);
    if (hasPendingMarker) {
      updatePersistenceState({ pendingDatabaseSync: true });
    }

    if (persistenceState.pendingDatabaseSync) {
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        await writeDatabaseConfigText(settings, localText);
        await clearDatabasePendingSyncMarker(settings);
        markDatabaseReady(settings, "synced");
        return;
      }
      await clearDatabasePendingSyncMarker(settings);
      updatePersistenceState({ pendingDatabaseSync: false });
    }

    await readDatabaseConfigText(settings);
    markDatabaseReady(settings, "probe");
  } catch (error) {
    const hasPendingMarker = await hasDatabasePendingSyncMarker(settings).catch(() => persistenceState.pendingDatabaseSync);
    markDatabaseDegraded(settings, error, { pendingDatabaseSync: hasPendingMarker || persistenceState.pendingDatabaseSync });
    emitPersistenceEvent("warn", "persistence.database_probe_failed", {
      target: describeDatabaseTarget(settings),
      activeMode: persistenceState.activeMode,
      pendingDatabaseSync: persistenceState.pendingDatabaseSync,
      error: persistenceState.lastDatabaseError
    });
  } finally {
    databaseRecoveryRunning = false;
    if (persistenceState.databaseAccessState !== "ready" || persistenceState.pendingDatabaseSync) {
      scheduleDatabaseRecovery(settings);
    }
  }
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

  if (settings.configStoreMode === "database") {
    const pendingDatabaseSync = await hasDatabasePendingSyncMarker(settings);
    if (pendingDatabaseSync) {
      updatePersistenceState({ pendingDatabaseSync: true });
      const localText = await readLocalCacheText(settings);
      if (localText != null) {
        markDatabaseDegraded(settings, null, { pendingDatabaseSync: true });
        emitPersistenceEvent("warn", "startup.persistence_database_sync_pending", {
          target: describeDatabaseTarget(settings),
          configPath: settings.configPath,
          message: "Database sync is pending from a previous failed write. Using local cached config until PostgreSQL is updated.",
          activeMode: persistenceState.activeMode,
          pendingDatabaseSync: persistenceState.pendingDatabaseSync
        });
        scheduleDatabaseRecovery(settings);
        return localText;
      }
      await clearDatabasePendingSyncMarker(settings);
      updatePersistenceState({ pendingDatabaseSync: false });
    }

    try {
      const databaseText = await readDatabaseConfigText(settings);
      markDatabaseReady(settings, "read");
      if (databaseText != null) {
        await writeLocalCacheText(settings, databaseText);
        await clearDatabasePendingSyncMarker(settings);
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
          scheduleDatabaseRecovery(settings);
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

  if (settings.configStoreMode === "database") {
    try {
      await writeDatabaseConfigText(settings, text);
      await clearDatabasePendingSyncMarker(settings);
      markDatabaseReady(settings, "write");
    } catch (error) {
      await writeDatabasePendingSyncMarker(settings);
      markDatabaseDegraded(settings, error, { pendingDatabaseSync: true });
      emitPersistenceEvent("warn", "persistence.database_write_deferred", {
        target: describeDatabaseTarget(settings),
        configPath: settings.configPath,
        message: "Database config write failed. Local config was updated and remains the last known good copy.",
        activeMode: persistenceState.activeMode,
        pendingDatabaseSync: persistenceState.pendingDatabaseSync,
        error: persistenceState.lastDatabaseError
      });
      scheduleDatabaseRecovery(settings);
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
    configStoreMode: settings.configStoreMode,
    dataDirMode: settings.usesAzureFile ? "azureFile" : "ephemeral",
    activeMode: persistenceState.activeMode,
    databaseAccessState: persistenceState.databaseAccessState,
    pendingDatabaseSync: persistenceState.pendingDatabaseSync,
    databaseRecoveryIntervalMs: DEFAULT_DATABASE_RECOVERY_INTERVAL_MS,
    nextDatabaseRecoveryAttemptAt: persistenceState.nextDatabaseRecoveryAttemptAt,
    lastDatabaseError: persistenceState.lastDatabaseError,
    configPath: settings.configPath,
    compatibilityPath: settings.compatibilityPath,
    databaseProvider: settings.database.provider,
    databaseSchema: settings.database.schemaName,
    databaseTableName: settings.database.tableName,
    databaseConfigKey: settings.database.configKey
  };
}

export async function syncPersistenceState(config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);

  if (databaseRecoveryTimer) {
    clearTimeout(databaseRecoveryTimer);
    databaseRecoveryTimer = null;
  }
  updatePersistenceState({ nextDatabaseRecoveryAttemptAt: null });

  if (settings.configStoreMode === "database") {
    await recoverDatabaseAccess();
  }

  return getPersistenceSummary(config);
}

export function getDatabaseConnectionDefaults(config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);
  return {
    mode: settings.mode,
    configStoreMode: settings.configStoreMode,
    provider: settings.database.provider,
    connectionRef: settings.database.connectionRef,
    connectionString: settings.database.connectionString,
    schemaName: settings.database.schemaName,
    tableName: settings.database.tableName,
    configKey: settings.database.configKey
  };
}

export async function testDatabaseConnection(input = {}, config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);
  const provider = String(input.provider || settings.database.provider || "postgresql").trim() || "postgresql";
  if (provider !== "postgresql") {
    throw new Error("Only postgresql database provider is supported");
  }

  const resolvedConnectionRef = String(input.connectionRef || settings.database.connectionRef || "").trim();
  const connectionString = String(input.connectionString || "").trim()
    || (resolvedConnectionRef ? getEnvOverride(resolvedConnectionRef) : "")
    || settings.database.connectionString;
  if (!connectionString) {
    throw new Error("connectionString is required");
  }

  const schemaName = String(input.schemaName || settings.database.schemaName || DEFAULT_DATABASE_SCHEMA).trim() || DEFAULT_DATABASE_SCHEMA;
  const tableName = String(input.tableName || settings.database.tableName || DEFAULT_DATABASE_TABLE_NAME).trim() || DEFAULT_DATABASE_TABLE_NAME;
  const configKey = String(input.configKey || settings.database.configKey || DEFAULT_DATABASE_CONFIG_KEY).trim() || DEFAULT_DATABASE_CONFIG_KEY;

  const result = await probePostgresConnection({
    connectionString,
    pool: settings.database.pool
  }, {
    schemaName,
    tableName,
    configKey
  });

  return {
    provider,
    connectionRef: resolvedConnectionRef,
    ...result
  };
}
