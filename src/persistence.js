import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { appendStructuredLog } from "./logs.js";
import { buildPostgresPoolOptions, getSharedPostgresPool, probePostgresConnection, quoteIdentifier } from "./postgres.js";
import { parsePersistenceMode } from "./persistence-mode.js";
import { writeFileAtomic as writeLocalConfigText } from "./atomic-file.js";
import { appendHistory, createHistoryEntry, includeCurrentHistory, parseConfigHistory } from "./config-history.js";

const DEFAULT_PERSISTENCE_MODE = "file";
const DEFAULT_LOCAL_CONFIG_PATH = "./config/config.json";
const DEFAULT_DATABASE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_DATABASE_SCHEMA = "public";
const DEFAULT_DATABASE_TABLE_NAME = "proxy_configs";
const DEFAULT_DATABASE_CONFIG_KEY = "active";

let runtimeConfig = null;
let databaseRecoveryTimer = null;
let databaseRecoveryRunning = false;
let databaseBaseline = null;
let persistenceOperation = Promise.resolve();
const tableInitializations = new WeakMap();

function serializePersistenceOperation(operation) {
  const next = persistenceOperation.catch(() => undefined).then(operation);
  persistenceOperation = next.catch(() => undefined);
  return next;
}

const persistenceState = {
  configuredMode: DEFAULT_PERSISTENCE_MODE,
  activeMode: DEFAULT_PERSISTENCE_MODE,
  databaseAccessState: "disabled",
  pendingDatabaseSync: false,
  lastDatabaseError: null,
  lastCacheError: null,
  historyError: null,
  historyEntryId: null,
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

async function readLocalConfigText(filePath) {
  return fs.readFile(filePath, "utf8");
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
  await writeLocalConfigText(settings.configPath, text);
  if (settings.compatibilityExportEnabled && settings.compatibilityPath !== settings.configPath) {
    try {
      await writeLocalConfigText(settings.compatibilityPath, text);
    } catch (error) {
      reportCacheError(settings, error);
    }
  }
}

function reportCacheError(settings, error) {
  updatePersistenceState({ lastCacheError: snapshotError(error) });
  emitPersistenceEvent("warn", "persistence.cache_write_failed", {
    target: settings.configPath, failureReason: error.message
  });
}

function historyPath(settings) {
  return `${settings.configPath}.history.json`;
}

async function readLocalHistory(settings) {
  const text = await tryReadLocalConfigText(historyPath(settings));
  return text === null ? [] : parseConfigHistory(JSON.parse(text));
}

async function writeLocalHistory(settings, history) {
  await writeLocalConfigText(historyPath(settings), JSON.stringify(history, null, 2));
}

async function mirrorDatabaseConfig(settings, text, history) {
  try {
    await writeLocalCacheText(settings, text);
    await writeLocalHistory(settings, history);
  } catch (error) {
    reportCacheError(settings, error);
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

function databaseTargetId(settings) {
  return createHash("sha256").update(JSON.stringify([
    settings.database.connectionString,
    settings.database.schemaName,
    settings.database.tableName,
    settings.database.configKey
  ])).digest("hex");
}

async function readDatabasePendingSyncMarker(settings) {
  try {
    const marker = JSON.parse(await fs.readFile(getDatabasePendingSyncMarkerPath(settings), "utf8"));
    const baseline = marker?.baseline;
    const validBaseline = baseline?.target === databaseTargetId(settings) && baseline.known === true
      && (baseline.version === null || (Number.isSafeInteger(baseline.version) && baseline.version > 0));
    return {
      baseline: validBaseline ? baseline : { target: databaseTargetId(settings), known: false },
      text: typeof marker?.text === "string" ? marker.text : null,
      history: marker?.history == null ? null : parseConfigHistory(marker.history)
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (!(error instanceof SyntaxError)) throw error;
  }
  emitPersistenceEvent("warn", "persistence.pending_marker_invalid", { target: getDatabasePendingSyncMarkerPath(settings) });
  return { baseline: { target: databaseTargetId(settings), known: false }, text: null, history: null };
}

async function writeDatabasePendingSyncMarker(settings, baseline, text, history) {
  const markerPath = getDatabasePendingSyncMarkerPath(settings);
  await writeLocalConfigText(markerPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    target: describeDatabaseTarget(settings),
    baseline,
    text,
    history
  }, null, 2));
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
  let initialized = tableInitializations.get(pool);
  if (!initialized) tableInitializations.set(pool, initialized = new Map());
  const key = `${schemaName}.${tableName}`;
  if (!initialized.has(key)) {
    initialized.set(key, (async () => {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${key} (
          config_key TEXT PRIMARY KEY,
          config_json JSONB NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          history_json JSONB NOT NULL DEFAULT '[]'::jsonb
        )
      `);
      await pool.query(`ALTER TABLE ${key} ADD COLUMN IF NOT EXISTS history_json JSONB NOT NULL DEFAULT '[]'::jsonb`);
    })().catch(error => {
      initialized.delete(key);
      throw error;
    }));
  }
  await initialized.get(key);
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
  emitPersistenceEvent("info", "persistence.database_ready", {
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

async function readDatabaseConfigRecord(settings) {
  await ensureDatabaseTable(settings);
  const pool = getDatabasePool(settings);
  const schemaName = quoteIdentifier(settings.database.schemaName, "persistence.configStore.database.schema");
  const tableName = quoteIdentifier(settings.database.tableName, "persistence.configStore.database.tableName");
  const result = await pool.query(
    `SELECT config_json, version, history_json FROM ${schemaName}.${tableName} WHERE config_key = $1 LIMIT 1`,
    [settings.database.configKey]
  );
  return {
    text: result.rows.length ? JSON.stringify(result.rows[0].config_json, null, 2) : null,
    history: parseConfigHistory(result.rows[0]?.history_json || []),
    baseline: { target: databaseTargetId(settings), known: true, version: result.rows[0]?.version ?? null }
  };
}

async function readDatabaseConfigText(settings, { trackBaseline = true } = {}) {
  const record = await readDatabaseConfigRecord(settings);
  if (trackBaseline) databaseBaseline = record.baseline;
  return record.text;
}

async function writeDatabaseConfigText(settings, text, baseline, { entry = createHistoryEntry(text), history } = {}) {
  if (!baseline?.known || baseline.target !== databaseTargetId(settings)) {
    throw Object.assign(new Error("The database configuration revision is unknown; automatic synchronization is unsafe."), {
      code: "CONFIG_REVISION_UNKNOWN",
      status: 409
    });
  }
  const previous = await readDatabaseConfigRecord(settings);
  if (previous.baseline.version !== baseline.version) {
    throw Object.assign(new Error("Configuration changed in the database. Reload the latest version before saving."), {
      code: "CONFIG_REVISION_CONFLICT", status: 409
    });
  }
  const pool = getDatabasePool(settings);
  const schemaName = quoteIdentifier(settings.database.schemaName, "persistence.configStore.database.schema");
  const tableName = quoteIdentifier(settings.database.tableName, "persistence.configStore.database.tableName");
  const parsed = JSON.parse(text);
  const nextHistory = history || appendHistory(includeCurrentHistory(previous.history, previous.text), entry);
  const result = baseline.version === null
    ? await pool.query(
      `INSERT INTO ${schemaName}.${tableName} (config_key, config_json, version, updated_at, history_json)
       VALUES ($1, $2::jsonb, 1, NOW(), $3::jsonb) ON CONFLICT (config_key) DO NOTHING RETURNING version, history_json`,
      [settings.database.configKey, JSON.stringify(parsed), JSON.stringify(nextHistory)]
    )
    : await pool.query(
      `UPDATE ${schemaName}.${tableName} AS saved SET config_json = $2::jsonb, version = version + 1, updated_at = NOW(),
       history_json = (
         SELECT jsonb_agg(jsonb_set(candidate.item, '{apply}', COALESCE(
           NULLIF((SELECT stored.value->'apply' FROM jsonb_array_elements(saved.history_json) AS stored(value)
             WHERE stored.value->>'id' = candidate.item->>'id' LIMIT 1), 'null'::jsonb),
           candidate.item->'apply', 'null'::jsonb
         )) ORDER BY candidate.position)
         FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS candidate(item, position)
       )
       WHERE config_key = $1 AND version = $3 RETURNING version, history_json`,
      [settings.database.configKey, JSON.stringify(parsed), baseline.version, JSON.stringify(nextHistory)]
    );
  if (!result.rows.length) {
    throw Object.assign(new Error("Configuration changed in the database. Reload the latest version before saving."), {
      code: "CONFIG_REVISION_CONFLICT",
      status: 409
    });
  }
  const committedHistory = parseConfigHistory(result.rows[0].history_json);
  databaseBaseline = { target: databaseTargetId(settings), known: true, version: result.rows[0].version };
  updatePersistenceState({ historyEntryId: committedHistory.at(-1)?.id || null });
  return committedHistory;
}

function recoverDatabaseAccess() {
  return serializePersistenceOperation(recoverDatabaseAccessInternal);
}

async function recoverDatabaseAccessInternal() {
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
      const pending = await readDatabasePendingSyncMarker(settings);
      const localText = pending?.text ?? await readLocalCacheText(settings);
      if (localText != null) {
        let history;
        try {
          history = await writeDatabaseConfigText(settings, localText, pending?.baseline, { history: pending?.history || undefined });
        } catch (error) {
          if (error?.code !== "CONFIG_REVISION_CONFLICT") throw error;
          const current = await readDatabaseConfigRecord(settings);
          if (current.text == null || !isDeepStrictEqual(JSON.parse(current.text), JSON.parse(localText))) throw error;
          databaseBaseline = current.baseline;
          history = current.history;
        }
        await mirrorDatabaseConfig(settings, localText, history);
        await clearDatabasePendingSyncMarker(settings);
        markDatabaseReady(settings, "synced");
        return;
      }
      await clearDatabasePendingSyncMarker(settings);
      updatePersistenceState({ pendingDatabaseSync: false });
    }

    await readDatabaseConfigText(settings, { trackBaseline: false });
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

export function readPersistedConfigText(options = {}) {
  return serializePersistenceOperation(() => readPersistedConfigTextInternal(options));
}

async function readPersistedConfigTextInternal({ validate, discardPending = false } = {}) {
  const settings = await resolveBootstrapSettings();
  applyConfiguredMode(settings);

  if (settings.configStoreMode === "database") {
    const pendingDatabaseSync = await hasDatabasePendingSyncMarker(settings);
    if (pendingDatabaseSync && !discardPending) {
      updatePersistenceState({ pendingDatabaseSync: true });
      const pending = await readDatabasePendingSyncMarker(settings);
      const localText = pending?.text ?? await readLocalCacheText(settings);
      if (localText != null) {
        await validate?.(localText);
        databaseBaseline = pending.baseline;
        updatePersistenceState({ historyEntryId: pending.history?.at(-1)?.id || null });
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

    let record;
    try {
      record = await readDatabaseConfigRecord(settings);
    } catch (error) {
      if (!discardPending && settings.database.readFallbackMode === "lastKnownGood") {
        const localText = await readLocalCacheText(settings);
        if (localText != null) {
          await validate?.(localText);
          if (databaseBaseline?.target !== databaseTargetId(settings)) {
            databaseBaseline = { target: databaseTargetId(settings), known: false };
          }
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
    if (discardPending && record.text == null) {
      throw new Error("Cannot discard pending configuration: no configuration exists in the database.");
    }
    const text = record.text ?? await readPrimaryLocalConfigText(settings);
    await validate?.(text);
    if (record.text != null) {
      await writeLocalCacheText(settings, text);
      await writeLocalHistory(settings, record.history);
      await clearDatabasePendingSyncMarker(settings);
    }
    databaseBaseline = record.baseline;
    updatePersistenceState({ historyEntryId: record.history.at(-1)?.id || null });
    markDatabaseReady(settings, discardPending ? "discard_pending" : "read");
    return text;
  }

  const text = await readPrimaryLocalConfigText(settings);
  await validate?.(text);
  return text;
}

export async function readLatestPersistedConfigText() {
  const settings = await resolveBootstrapSettings();
  if (settings.configStoreMode === "database") {
    const text = await readDatabaseConfigText(settings, { trackBaseline: false });
    if (text != null) return text;
  }
  return readLocalConfigText(settings.configPath);
}

export function discardPendingDatabaseSync() {
  return readPersistedConfigText({ discardPending: true });
}

export function writePersistedConfigText(text, nextConfig = null, metadata = {}) {
  return serializePersistenceOperation(() => writePersistedConfigTextInternal(text, nextConfig, metadata));
}

async function writePersistedConfigTextInternal(text, nextConfig, metadata) {
  const parsedConfig = nextConfig || safeParseJson(text) || runtimeConfig;
  const settings = resolvePersistenceSettings(parsedConfig);
  const entry = createHistoryEntry(text, metadata);
  updatePersistenceState({ lastCacheError: null, historyError: null, historyEntryId: null });
  applyConfiguredMode(settings);

  if (settings.configStoreMode === "database") {
    const pending = await readDatabasePendingSyncMarker(settings);
    const defer = async (baseline, error) => {
      const history = appendHistory(includeCurrentHistory(
        pending?.history || await readLocalHistory(settings), pending?.text ?? await readLocalCacheText(settings)
      ), entry);
      await writeDatabasePendingSyncMarker(settings, baseline, text, history);
      await mirrorDatabaseConfig(settings, text, history);
      updatePersistenceState({ historyEntryId: entry.id });
      markDatabaseDegraded(settings, error, { pendingDatabaseSync: true });
      emitPersistenceEvent("warn", "persistence.database_write_deferred", {
        target: describeDatabaseTarget(settings),
        configPath: settings.configPath,
        message: "Configuration is durably pending locally; PostgreSQL synchronization requires the original revision.",
        error: persistenceState.lastDatabaseError
      });
      scheduleDatabaseRecovery(settings);
    };
    if (pending) {
      await defer(pending.baseline, persistenceState.lastDatabaseError);
      return;
    }
    if (databaseBaseline?.target !== databaseTargetId(settings)) {
      try {
        await readDatabaseConfigText(settings);
      } catch {
        databaseBaseline = { target: databaseTargetId(settings), known: false };
      }
    }
    let history;
    try {
      history = await writeDatabaseConfigText(settings, text, databaseBaseline, { entry });
    } catch (error) {
      if (error?.code === "CONFIG_REVISION_CONFLICT") throw error;
      const baseline = databaseBaseline || { target: databaseTargetId(settings), known: false };
      await defer(baseline, error);
      return;
    }
    await mirrorDatabaseConfig(settings, text, history);
    markDatabaseReady(settings, "write");
    return;
  }

  const previous = includeCurrentHistory(await readLocalHistory(settings), await readLocalCacheText(settings));
  await writeLocalHistory(settings, previous);
  await writeLocalCacheText(settings, text);
  try {
    await writeLocalHistory(settings, appendHistory(previous, entry));
    updatePersistenceState({ historyEntryId: entry.id });
  } catch (error) {
    updatePersistenceState({ historyError: snapshotError(error) });
    emitPersistenceEvent("warn", "persistence.history_write_failed", { target: historyPath(settings), failureReason: error.message });
  }
  updatePersistenceState({ activeMode: "file" });
}

export async function readConfigHistory() {
  const settings = await resolveBootstrapSettings();
  if (settings.configStoreMode === "database") {
    const pending = await readDatabasePendingSyncMarker(settings);
    if (pending?.history) return pending.history;
    if (!pending) return (await readDatabaseConfigRecord(settings)).history;
  }
  return readLocalHistory(settings);
}

export function recordConfigHistoryApply(id, apply) {
  return serializePersistenceOperation(async () => {
    if (!id) return;
    const settings = await resolveBootstrapSettings();
    const pending = settings.configStoreMode === "database" ? await readDatabasePendingSyncMarker(settings) : null;
    if (settings.configStoreMode === "database" && !pending) {
      const schema = quoteIdentifier(settings.database.schemaName, "schema");
      const table = quoteIdentifier(settings.database.tableName, "table");
      await getDatabasePool(settings).query(`
        UPDATE ${schema}.${table} SET history_json = (
          SELECT jsonb_agg(CASE WHEN item->>'id' = $2 THEN jsonb_set(item, '{apply}', $3::jsonb) ELSE item END ORDER BY position)
          FROM jsonb_array_elements(history_json) WITH ORDINALITY AS entries(item, position)
        ) WHERE config_key = $1 AND history_json @> $4::jsonb
      `, [settings.database.configKey, id, JSON.stringify(apply), JSON.stringify([{ id }])]);
      return;
    }
    const history = (pending?.history || await readLocalHistory(settings)).map(entry => entry.id === id ? { ...entry, apply } : entry);
    if (pending?.text) await writeDatabasePendingSyncMarker(settings, pending.baseline, pending.text, history);
    await writeLocalHistory(settings, history);
  });
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
    lastCacheError: persistenceState.lastCacheError,
    historyError: persistenceState.historyError,
    historyEntryId: persistenceState.historyEntryId,
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

export function getChannelCredentialStorage(config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);
  return settings.configStoreMode === "database" ? {
    pool: getSharedPostgresPool(buildPostgresPoolOptions(settings.database)),
    schema: settings.database.schemaName, namespace: settings.database.configKey
  } : { path: `${settings.configPath}.copilot-credentials` };
}

export function getDatabaseConnectionDefaults(config = runtimeConfig) {
  const settings = resolvePersistenceSettings(config);
  return {
    mode: settings.mode,
    configStoreMode: settings.configStoreMode,
    provider: settings.database.provider,
    connectionRef: settings.database.connectionRef,
    connectionString: "",
    connectionStringConfigured: !!settings.database.connectionString,
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
