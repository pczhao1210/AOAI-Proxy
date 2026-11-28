import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic-file.js";
import path from "node:path";
import { appendStructuredLog } from "./logs.js";
import { operationFields, operationLimit } from "./channel-operation-fields.js";
import { buildPostgresPoolOptions, getSharedPostgresPool, quoteIdentifier } from "./postgres.js";
import { parsePersistenceMode } from "./persistence-mode.js";
import { beginModelStatsReset, getMemoryChannelStats } from "./stats.js";
import { accumulateChannelDetail, channelIdentity, channelMetric, channelTree, reconcileChannelHistory } from "./channel-statistics.js";
import { normalizeCacheWrite, summarizeCacheWrite, billingTierIdentity, billingTierKey, billingTierFromKey, reconcileBillingTiers } from "./statistics.js";

const DEFAULT_DATABASE_SCHEMA = "public";
const DEFAULT_RUNTIME_EVENTS_TABLE_NAME = "runtime_events";
const DEFAULT_RUNTIME_ROLLUPS_TABLE_NAME = "runtime_rollups";
const DEFAULT_RUNTIME_META_TABLE_NAME = "runtime_store_meta";
const DEFAULT_LOCAL_BUFFER_FILE_NAME = "runtime-store-pending.ndjson";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_MAX_PERSISTED_EVENTS = 50000;
const DEFAULT_DETAIL_RETENTION_DAYS = 30;
const DEFAULT_ROLLUP_RETENTION_DAYS = 365;
const DEFAULT_ROLLUP_BATCH_SIZE = 5000;
const LOCAL_BUFFER_COMPACT_BYTES = 1024 * 1024;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GLOBAL_SCOPE_KEY = "__all__";
const GLOBAL_SCOPE_SUBKEY = "";
const ROLLUP_GRAINS = ["hourly", "daily", "weekly"];
const META_LAST_ROLLED_EVENT_ID = "last_rolled_event_id";
const META_MODELS_RESET_AT = "models_reset_at";
const CACHE_WRITE_COLUMN_DEFINITIONS = [
  ["cache_write_tokens", "BIGINT"],
  ["cache_write_known_cost_amount", "DOUBLE PRECISION"],
  ["cache_write_estimated_cost_amount", "DOUBLE PRECISION"],
  ["cache_write_requests", "BIGINT NOT NULL DEFAULT 0"],
  ["cache_write_observed_requests", "BIGINT NOT NULL DEFAULT 0"],
  ["cache_write_priced_requests", "BIGINT NOT NULL DEFAULT 0"],
  ["cache_write_partial_cost_requests", "BIGINT NOT NULL DEFAULT 0"],
  ["cache_write_unreported_requests", "BIGINT"]
];
const CACHE_WRITE_COLUMNS = CACHE_WRITE_COLUMN_DEFINITIONS.map(([name]) => name);
const STATS_TIME_RANGES = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const runtimeEventQueue = [];
let runtimeStoreConfig = null;
let flushTimer = null;
let flushRunning = false;
let lastEnsureKey = "";
let cleanupAfterTs = 0;
let localBufferOperation = Promise.resolve();
let pendingLocalAppend = null;
let databaseOperation = Promise.resolve();
let modelEventClockFloor = 0;
let modelStatsGeneration = 0;
let localBufferCursor = { path: "", identity: "", offset: 0 };
let boundLocalBufferPath = "";
let runtimeConfigGeneration = 0;

function serializeDatabaseOperation(operation) {
  const next = databaseOperation.catch(() => undefined).then(operation);
  databaseOperation = next.catch(() => undefined);
  return next;
}

const runtimeStoreState = {
  enabled: false,
  configured: false,
  queueLength: 0,
  persistedEventCount: 0,
  flushFailures: 0,
  rollupFailures: 0,
  droppedEvents: 0,
  corruptedEvents: 0,
  lastSuccessTs: "",
  lastRollupTs: "",
  lastRolledEventId: 0,
  lastError: null,
  flushing: false,
  nextFlushAt: null,
  localBufferPath: "",
  maxPersistedEvents: DEFAULT_MAX_PERSISTED_EVENTS,
  spilloverActive: false
};

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function resolveInt(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= minimum) {
    return numeric;
  }
  return fallback;
}

function resolveFloat(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= minimum) {
    return numeric;
  }
  return fallback;
}

function toIsoString(value = Date.now()) {
  return new Date(value).toISOString();
}

function snapshotError(error) {
  if (!error) return null;
  return {
    code: error?.code || error?.name || "UnknownError",
    statusCode: error?.statusCode || null,
    message: error?.message || String(error)
  };
}

function updateRuntimeStoreState(patch) {
  Object.assign(runtimeStoreState, patch);
  runtimeStoreState.queueLength = runtimeEventQueue.length;
}

function resolveLocalBufferPath(configStore, runtimeStore) {
  const configuredPath = getEnvOverride("RUNTIME_STORE_LOCAL_BUFFER_PATH") || String(runtimeStore.localBufferPath || "").trim();
  if (configuredPath) {
    return path.resolve(process.cwd(), configuredPath);
  }
  const configFilePath = String(configStore.filePath || "./config/config.json").trim() || "./config/config.json";
  return path.resolve(path.dirname(path.resolve(process.cwd(), configFilePath)), DEFAULT_LOCAL_BUFFER_FILE_NAME);
}

function resolveRuntimeStoreSettings(config = runtimeStoreConfig) {
  const observability = asPlainObject(config?.observability);
  const runtimeStore = asPlainObject(observability.runtimeStore);
  const audit = asPlainObject(observability.audit);
  const persistence = asPlainObject(config?.persistence);
  const configStore = asPlainObject(persistence.configStore);
  const database = asPlainObject(configStore.database);
  const requestedMode = parsePersistenceMode(getEnvOverride("PERSISTENCE_MODE", "CONFIG_PERSISTENCE_MODE") || configStore.mode);
  const connectionRef = getEnvOverride("RUNTIME_DB_CONNECTION_REF") || String(runtimeStore.connectionRef || database.connectionRef || "").trim();
  const connectionString = getEnvOverride("RUNTIME_DB_CONNECTION_STRING", "CONFIG_DB_CONNECTION_STRING", "DATABASE_URL")
    || (connectionRef ? getEnvOverride(connectionRef) : "");
  const enabled = runtimeStore.enabled !== false && requestedMode.usesDatabase;
  const detailRetentionDays = resolveInt(runtimeStore.detailRetentionDays ?? runtimeStore.retentionDays ?? audit.retentionDays, DEFAULT_DETAIL_RETENTION_DAYS, 1);

  return {
    enabled,
    configured: enabled && !!connectionString,
    schemaName: String(runtimeStore.schema || database.schema || DEFAULT_DATABASE_SCHEMA).trim() || DEFAULT_DATABASE_SCHEMA,
    eventsTableName: String(runtimeStore.eventsTableName || DEFAULT_RUNTIME_EVENTS_TABLE_NAME).trim() || DEFAULT_RUNTIME_EVENTS_TABLE_NAME,
    rollupsTableName: String(runtimeStore.rollupsTableName || DEFAULT_RUNTIME_ROLLUPS_TABLE_NAME).trim() || DEFAULT_RUNTIME_ROLLUPS_TABLE_NAME,
    metaTableName: String(runtimeStore.metaTableName || DEFAULT_RUNTIME_META_TABLE_NAME).trim() || DEFAULT_RUNTIME_META_TABLE_NAME,
    detailRetentionDays,
    rollupRetentionDays: resolveInt(runtimeStore.rollupRetentionDays, DEFAULT_ROLLUP_RETENTION_DAYS, 7),
    rollupBatchSize: resolveInt(runtimeStore.rollupBatchSize, DEFAULT_ROLLUP_BATCH_SIZE, 100),
    flushIntervalMs: resolveInt(runtimeStore.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 100),
    batchSize: resolveInt(runtimeStore.batchSize, DEFAULT_BATCH_SIZE, 1),
    maxQueueSize: resolveInt(runtimeStore.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 100),
    localBufferPath: resolveLocalBufferPath(configStore, runtimeStore),
    maxPersistedEvents: resolveInt(runtimeStore.maxPersistedEvents, DEFAULT_MAX_PERSISTED_EVENTS, 100),
    poolOptions: buildPostgresPoolOptions({
      connectionString,
      pool: database.pool
    })
  };
}

function queueLocalBufferOperation(operation) {
  const nextOperation = localBufferOperation
    .catch(() => undefined)
    .then(operation);
  localBufferOperation = nextOperation.catch(() => undefined);
  return nextOperation;
}

async function ensureLocalBufferDirectory(settings) {
  await fs.mkdir(path.dirname(settings.localBufferPath), { recursive: true });
}

function normalizeBufferedEvent(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Runtime buffer record must be an object");
  }
  return buildEventRow(String(entry.eventType || entry.event_type || "warning").trim() || "warning", {
    eventUid: entry.eventUid ?? entry.event_uid,
    signalName: entry.signalName ?? entry.signal_name,
    requestId: entry.requestId ?? entry.request_id,
    occurredAt: entry.occurredAt ?? entry.occurred_at,
    keyId: entry.keyId ?? entry.key_id,
    modelId: entry.modelId ?? entry.model_id,
    actualModelName: entry.actualModelId ?? entry.actual_model_id,
    routeKey: entry.routeKey ?? entry.route_key,
    backendRouteKey: entry.backendRouteKey ?? entry.backend_route_key,
    blockedReason: entry.blockedReason ?? entry.blocked_reason,
    promptTokens: entry.promptTokens ?? entry.prompt_tokens,
    completionTokens: entry.completionTokens ?? entry.completion_tokens,
    totalTokens: entry.totalTokens ?? entry.total_tokens,
    cachedTokens: entry.cachedTokens ?? entry.cached_tokens,
    estimatedCostAmount: entry.estimatedCostAmount ?? entry.estimated_cost_amount,
    modelRouterCostAmount: entry.modelRouterCostAmount ?? entry.model_router_cost_amount,
    actualModelCostAmount: entry.actualModelCostAmount ?? entry.actual_model_cost_amount,
    currency: entry.currency,
    payload: { ...asPlainObject(entry.payload),
      modelStatsRecordedAt: entry.payload?.modelStatsRecordedAt || entry.occurredAt || entry.occurred_at }
  });
}

async function getLocalBufferIdentity(settings) {
  try {
    const stat = await fs.stat(settings.localBufferPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function getLocalBufferOffsetPath(settings) {
  return `${settings.localBufferPath}.offset`;
}

function checkpointDigest(identity, offset) {
  return createHash("sha256").update(JSON.stringify([identity, offset])).digest("hex");
}

function parseBufferedEvent(line) {
  return normalizeBufferedEvent(JSON.parse(line));
}

async function readLocalBufferEventsUnsafe(settings) {
  try {
    const bytes = await fs.readFile(settings.localBufferPath);
    const identity = await getLocalBufferIdentity(settings);
    const offset = localBufferCursor.path === settings.localBufferPath && localBufferCursor.identity === identity
      ? localBufferCursor.offset
      : 0;
    const text = bytes.subarray(offset).toString("utf8");
    if (!text.trim()) {
      return [];
    }
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseBufferedEvent);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeLocalBufferEventsUnsafe(settings, events) {
  if (!events.length) {
    try {
      await fs.unlink(settings.localBufferPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    localBufferCursor = { path: settings.localBufferPath, identity: "", offset: 0 };
    return;
  }
  await ensureLocalBufferDirectory(settings);
  const payload = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  await writeFileAtomic(settings.localBufferPath, payload);
  localBufferCursor = { path: settings.localBufferPath, identity: await getLocalBufferIdentity(settings), offset: 0 };
}

function serializeLocalBufferEvents(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function updateLocalBufferState(settings, events) {
  updateRuntimeStoreState({
    localBufferPath: settings.localBufferPath,
    maxPersistedEvents: settings.maxPersistedEvents,
    persistedEventCount: events.length,
    spilloverActive: events.length > 0
  });
}

async function appendLocalBufferEvents(settings, events) {
  if (!events.length) {
    return { persistedEventCount: runtimeStoreState.persistedEventCount, dropped: 0 };
  }
  return queueLocalBufferOperation(async () => {
    if (pendingLocalAppend?.events === events) pendingLocalAppend = null;
    const existingCount = runtimeStoreState.localBufferPath === settings.localBufferPath
      ? runtimeStoreState.persistedEventCount
      : 0;
    let dropped = 0;
    let freeOperationSlots = Math.max(0, settings.maxPersistedEvents - existingCount);
    const accepted = events.length <= freeOperationSlots ? events : events.filter(event => {
      if (event.eventType === "operation" && freeOperationSlots <= 0) { dropped++; return false; }
      freeOperationSlots--;
      return true;
    });
    const newEvents = accepted.map(normalizeBufferedEvent);
    if (!newEvents.length) return { persistedEventCount: existingCount, dropped };
    const nextCount = existingCount + newEvents.length;
    let persistedEventCount = nextCount;
    if (nextCount > settings.maxPersistedEvents) {
      const existingEvents = await readLocalBufferEventsUnsafe(settings);
      let nextEvents = existingEvents.concat(newEvents);
      let overflow = Math.max(0, nextEvents.length - settings.maxPersistedEvents);
      dropped += overflow;
      if (overflow) nextEvents = nextEvents.filter(item => {
        if (item.eventType !== "operation" || overflow === 0) return true;
        overflow--;
        return false;
      });
      if (overflow) nextEvents.splice(0, overflow);
      await writeLocalBufferEventsUnsafe(settings, nextEvents);
      persistedEventCount = nextEvents.length;
      updateLocalBufferState(settings, nextEvents);
    } else {
      await ensureLocalBufferDirectory(settings);
      await fs.appendFile(settings.localBufferPath, serializeLocalBufferEvents(newEvents), { encoding: "utf8", mode: 0o600, flush: true });
      const identity = await getLocalBufferIdentity(settings);
      if (localBufferCursor.path !== settings.localBufferPath || localBufferCursor.identity !== identity) {
        localBufferCursor = { path: settings.localBufferPath, identity, offset: 0 };
      }
      updateRuntimeStoreState({
        localBufferPath: settings.localBufferPath,
        maxPersistedEvents: settings.maxPersistedEvents,
        persistedEventCount,
        spilloverActive: persistedEventCount > 0
      });
    }
    return { persistedEventCount, dropped };
  });
}

async function peekLocalBufferBatch(settings, limit) {
  return queueLocalBufferOperation(async () => {
    const identity = await getLocalBufferIdentity(settings);
    const offset = localBufferCursor.path === settings.localBufferPath && localBufferCursor.identity === identity
      ? localBufferCursor.offset
      : 0;
    const handle = await fs.open(settings.localBufferPath, "r");
    const items = [];
    let position = offset;
    let endOffset = offset;
    let fragments = [];
    let fragmentBytes = 0;
    try {
      while (items.length < limit) {
        const chunk = Buffer.allocUnsafe(65536);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        let start = 0;
        while (start < bytesRead && items.length < limit) {
          const newline = chunk.subarray(0, bytesRead).indexOf(10, start);
          if (newline === -1) {
            fragments.push(chunk.subarray(start, bytesRead));
            fragmentBytes += bytesRead - start;
            break;
          }
          const tail = chunk.subarray(start, newline);
          const line = (fragments.length ? Buffer.concat([...fragments, tail], fragmentBytes + tail.length) : tail).toString("utf8").trim();
          endOffset += fragmentBytes + tail.length + 1;
          fragments = [];
          fragmentBytes = 0;
          start = newline + 1;
          if (!line) continue;
          items.push(parseBufferedEvent(line));
        }
      }
    } finally {
      await handle.close();
    }
    return { items, identity, offset, endOffset };
  });
}

async function ackLocalBufferBatch(settings, batch) {
  if (!batch.items.length) {
    return { persistedEventCount: runtimeStoreState.persistedEventCount };
  }
  return queueLocalBufferOperation(async () => {
    const identity = await getLocalBufferIdentity(settings);
    if (identity === batch.identity && localBufferCursor.identity === identity && localBufferCursor.offset === batch.offset) {
      const offsetPath = getLocalBufferOffsetPath(settings);
      await writeFileAtomic(offsetPath, JSON.stringify({
        identity, offset: batch.endOffset, digest: checkpointDigest(identity, batch.endOffset)
      }));
      localBufferCursor.offset = batch.endOffset;
      const persistedEventCount = Math.max(0, runtimeStoreState.persistedEventCount - batch.items.length);
      updateRuntimeStoreState({ persistedEventCount, spilloverActive: persistedEventCount > 0 });
      try {
        if (!persistedEventCount) {
          await writeLocalBufferEventsUnsafe(settings, []);
          await fs.unlink(offsetPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        } else if (batch.endOffset >= LOCAL_BUFFER_COMPACT_BYTES) {
          const stat = await fs.stat(settings.localBufferPath);
          if (batch.endOffset * 2 >= stat.size) {
            await writeLocalBufferEventsUnsafe(settings, await readLocalBufferEventsUnsafe(settings));
          }
        }
      } catch (error) {
        appendStructuredLog("warn", {
          source: "runtime-store",
          event: "runtime_store.local_buffer_cleanup_failed",
          target: settings.localBufferPath,
          failureReason: error?.message || "Failed to compact the runtime buffer"
        });
      }
      return { persistedEventCount };
    }
    const existingEvents = await readLocalBufferEventsUnsafe(settings);
    const acknowledged = new Set(batch.items.map((event) => event.eventUid));
    const nextEvents = existingEvents.filter((event) => !acknowledged.has(event.eventUid));
    await writeLocalBufferEventsUnsafe(settings, nextEvents);
    updateLocalBufferState(settings, nextEvents);
    return { persistedEventCount: nextEvents.length };
  });
}

async function refreshLocalBufferState(settings) {
  return queueLocalBufferOperation(async () => {
    const identity = await getLocalBufferIdentity(settings);
    const bytes = identity ? await fs.readFile(settings.localBufferPath) : Buffer.alloc(0);
    let offset = 0;
    if (identity) {
      try {
        const checkpoint = JSON.parse(await fs.readFile(getLocalBufferOffsetPath(settings), "utf8"));
        if (checkpoint?.identity === identity && Number.isSafeInteger(checkpoint.offset)
          && checkpoint.offset >= 0 && checkpoint.offset <= bytes.length
          && (checkpoint.offset === 0 || bytes[checkpoint.offset - 1] === 10)
          && checkpoint.digest === checkpointDigest(identity, checkpoint.offset)) {
          offset = checkpoint.offset;
        } else if (!checkpoint || checkpoint.identity === identity || typeof checkpoint.identity !== "string") {
          throw new SyntaxError("Invalid runtime buffer checkpoint");
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          appendStructuredLog("warn", {
            source: "runtime-store",
            event: "runtime_store.local_buffer_checkpoint_invalid",
            target: getLocalBufferOffsetPath(settings),
            failureReason: "Invalid checkpoint; replaying buffered events"
          });
        } else if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    localBufferCursor = { path: settings.localBufferPath, identity, offset };
    const text = bytes.subarray(offset).toString("utf8");
    let needsRewrite = text.length > 0 && !text.endsWith("\n");
    const existingEvents = [];
    const malformed = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const normalized = normalizeBufferedEvent(event);
        if (!event.eventUid && !event.event_uid) needsRewrite = true;
        existingEvents.push(normalized);
      } catch {
        malformed.push(line);
      }
    }
    if (malformed.length) {
      await fs.appendFile(`${settings.localBufferPath}.corrupt`, `${malformed.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      updateRuntimeStoreState({ corruptedEvents: runtimeStoreState.corruptedEvents + malformed.length });
      appendStructuredLog("error", {
        source: "runtime-store", event: "runtime_store.local_buffer_corrupt",
        target: `${settings.localBufferPath}.corrupt`, corruptedEvents: malformed.length,
        failureReason: "Malformed records were quarantined; their usage could not be recovered"
      });
      needsRewrite = true;
    }
    // Legacy records need stable identities before an ambiguous database write.
    if (needsRewrite) await writeLocalBufferEventsUnsafe(settings, existingEvents);
    updateLocalBufferState(settings, existingEvents);
    return existingEvents.length;
  });
}

function getRuntimeStorePool(settings) {
  if (!settings.configured) {
    throw new Error("Runtime store requires PostgreSQL connection when database mode is enabled");
  }
  return getSharedPostgresPool(settings.poolOptions);
}

async function withRuntimeReadSnapshot(settings, read, { ensureTables = true } = {}) {
  if (ensureTables) await serializeDatabaseOperation(() => ensureRuntimeTables(settings));
  const pool = getSharedPostgresPool({
    ...settings.poolOptions, max: 2, min: 0, connectionTimeoutMillis: 3000
  }, "runtime-reader");
  const client = await pool.connect();
  let failure;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const result = await read(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure = error;
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      appendStructuredLog("warn", {
        source: "runtime-store", event: "runtime_store.snapshot_rollback_failed",
        failureReason: rollbackError.message
      });
    }
    throw error;
  } finally {
    client.release(failure);
  }
}

function describeRuntimeTarget(settings) {
  return `${settings.schemaName}.${settings.eventsTableName} + ${settings.schemaName}.${settings.rollupsTableName}`;
}

function getQualifiedTableNames(settings) {
  return {
    schemaName: quoteIdentifier(settings.schemaName, "observability.runtimeStore.schema"),
    eventsTableName: quoteIdentifier(settings.eventsTableName, "observability.runtimeStore.eventsTableName"),
    rollupsTableName: quoteIdentifier(settings.rollupsTableName, "observability.runtimeStore.rollupsTableName"),
    metaTableName: quoteIdentifier(settings.metaTableName, "observability.runtimeStore.metaTableName")
  };
}

async function ensureRuntimeTables(settings) {
  const ensureKey = JSON.stringify({
    connectionString: settings.poolOptions.connectionString,
    schemaName: settings.schemaName,
    eventsTableName: settings.eventsTableName,
    rollupsTableName: settings.rollupsTableName,
    metaTableName: settings.metaTableName
  });
  if (lastEnsureKey === ensureKey) {
    return;
  }

  const pool = getRuntimeStorePool(settings);
  const { schemaName, eventsTableName, rollupsTableName, metaTableName } = getQualifiedTableNames(settings);

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.${eventsTableName} (
      event_id BIGSERIAL PRIMARY KEY,
      event_uid UUID,
      event_type TEXT NOT NULL,
      signal_name TEXT NOT NULL DEFAULT '',
      request_id TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      key_id TEXT NOT NULL DEFAULT 'anonymous',
      model_id TEXT NOT NULL DEFAULT '',
      actual_model_id TEXT NOT NULL DEFAULT '',
      route_key TEXT NOT NULL DEFAULT '',
      backend_route_key TEXT NOT NULL DEFAULT '',
      blocked_reason TEXT NOT NULL DEFAULT '',
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      cached_tokens BIGINT NOT NULL DEFAULT 0,
      text_unknown_cost_requests BIGINT NOT NULL DEFAULT 0,
      ${CACHE_WRITE_COLUMN_DEFINITIONS.map(([name, type]) => `${name} ${type}`).join(",\n      ")},
      estimated_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      model_router_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      actual_model_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`ALTER TABLE ${schemaName}.${eventsTableName} ADD COLUMN IF NOT EXISTS event_uid UUID`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_event_uid_idx`, "runtime event identity index")}
    ON ${schemaName}.${eventsTableName} (event_uid)`);
  await pool.query(`ALTER TABLE ${schemaName}.${eventsTableName} ADD COLUMN IF NOT EXISTS signal_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE ${schemaName}.${eventsTableName} ADD COLUMN IF NOT EXISTS text_unknown_cost_requests BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ${schemaName}.${eventsTableName} ${CACHE_WRITE_COLUMN_DEFINITIONS.map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`).join(", ")}`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_event_type_occurred_at_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} (event_type, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_signal_name_occurred_at_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} (signal_name, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_key_id_occurred_at_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} (key_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_model_id_occurred_at_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} (model_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_blocked_reason_occurred_at_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} (blocked_reason, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.eventsTableName}_occurred_at_brin_idx`, "runtime events index")}
    ON ${schemaName}.${eventsTableName} USING BRIN (occurred_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.${rollupsTableName} (
      grain TEXT NOT NULL,
      bucket_start TIMESTAMPTZ NOT NULL,
      scope_type TEXT NOT NULL,
      scope_key TEXT NOT NULL DEFAULT '',
      scope_subkey TEXT NOT NULL DEFAULT '',
      requests BIGINT NOT NULL DEFAULT 0,
      errors BIGINT NOT NULL DEFAULT 0,
      blocked_count BIGINT NOT NULL DEFAULT 0,
      warning_count BIGINT NOT NULL DEFAULT 0,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      completion_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens BIGINT NOT NULL DEFAULT 0,
      cached_tokens BIGINT NOT NULL DEFAULT 0,
      text_unknown_cost_requests BIGINT NOT NULL DEFAULT 0,
      ${CACHE_WRITE_COLUMN_DEFINITIONS.map(([name, type]) => `${name} ${type}`).join(",\n      ")},
      estimated_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      model_router_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      actual_model_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      last_occurred_at TIMESTAMPTZ,
      PRIMARY KEY (grain, bucket_start, scope_type, scope_key, scope_subkey)
    )
  `);
  await pool.query(`ALTER TABLE ${schemaName}.${rollupsTableName} ADD COLUMN IF NOT EXISTS text_unknown_cost_requests BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE ${schemaName}.${rollupsTableName} ADD COLUMN IF NOT EXISTS channel_detail JSONB,
    ADD COLUMN IF NOT EXISTS channel_settlements BIGINT`);
  await pool.query(`ALTER TABLE ${schemaName}.${rollupsTableName} ${CACHE_WRITE_COLUMN_DEFINITIONS.map(([name, type]) => `ADD COLUMN IF NOT EXISTS ${name} ${type}`).join(", ")}`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.rollupsTableName}_grain_scope_bucket_idx`, "runtime rollups index")}
    ON ${schemaName}.${rollupsTableName} (grain, scope_type, bucket_start DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${settings.rollupsTableName}_scope_key_bucket_idx`, "runtime rollups index")}
    ON ${schemaName}.${rollupsTableName} (scope_type, scope_key, bucket_start DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.${metaTableName} (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  lastEnsureKey = ensureKey;
}

async function cleanupRuntimeData(settings) {
  if (Date.now() < cleanupAfterTs) {
    return;
  }
  cleanupAfterTs = Date.now() + CLEANUP_INTERVAL_MS;
  const pool = getRuntimeStorePool(settings);
  const { schemaName, eventsTableName, rollupsTableName } = getQualifiedTableNames(settings);
  await pool.query(
    `DELETE FROM ${schemaName}.${eventsTableName} WHERE occurred_at < NOW() - ($1::text || ' days')::interval`,
    [String(settings.detailRetentionDays)]
  );
  await pool.query(
    `DELETE FROM ${schemaName}.${rollupsTableName} WHERE bucket_start < NOW() - ($1::text || ' days')::interval`,
    [String(settings.rollupRetentionDays)]
  );
}

function scheduleFlush(settings, { retry = false } = {}) {
  if (!settings.configured || (runtimeEventQueue.length === 0 && runtimeStoreState.persistedEventCount === 0) || flushRunning || flushTimer) {
    return;
  }
  const delay = !retry && (runtimeStoreState.persistedEventCount > 0 || runtimeEventQueue.length >= settings.batchSize)
    ? 0
    : settings.flushIntervalMs;
  updateRuntimeStoreState({ nextFlushAt: toIsoString(Date.now() + delay) });
  flushTimer = setTimeout(() => {
    flushTimer = null;
    updateRuntimeStoreState({ nextFlushAt: null });
    void flushRuntimeEvents();
  }, delay);
}

function buildEventRow(eventType, fields = {}) {
  const textUsage = eventType === "usage" && fields.payload?.source !== "media";
  const cacheWrite = textUsage ? normalizeCacheWrite(fields.payload?.cacheWrite) : null;
  return {
    eventType,
    eventUid: fields.eventUid || randomUUID(),
    signalName: String(fields.signalName || fields.eventName || fields.event || "").trim(),
    requestId: String(fields.requestId || "").trim() || null,
    occurredAt: typeof fields.occurredAt === "string" && fields.occurredAt ? fields.occurredAt : toIsoString(),
    keyId: eventType === "operation" ? "" : String(fields.keyId || "anonymous").trim() || "anonymous",
    modelId: String(fields.modelId || "").trim(),
    actualModelId: String(fields.actualModelName || fields.actualModelId || "").trim(),
    routeKey: String(fields.routeKey || "").trim(),
    backendRouteKey: String(fields.backendRouteKey || "").trim(),
    blockedReason: String(fields.blockedReason || "").trim(),
    promptTokens: resolveInt(fields.promptTokens, 0, 0),
    completionTokens: resolveInt(fields.completionTokens, 0, 0),
    totalTokens: resolveInt(fields.totalTokens, 0, 0),
    cachedTokens: resolveInt(fields.cachedTokens, 0, 0),
    cacheWrite: summarizeCacheWrite({
      requests: cacheWrite ? 1 : 0,
      observedRequests: cacheWrite?.usageStatus === "observed" ? 1 : 0,
      pricedRequests: cacheWrite?.costStatus === "priced" ? 1 : 0,
      partialCostRequests: cacheWrite?.costStatus === "partial" ? 1 : 0,
      unreportedRequests: textUsage && !cacheWrite ? 1 : 0,
      observedTokens: cacheWrite?.tokens ?? null,
      knownCostAmount: cacheWrite?.knownCostAmount ?? null
    }),
    textUnknownCostRequests: eventType === "usage" && fields.payload?.textCost?.costStatus
      && fields.payload.textCost.costStatus !== "priced" ? 1 : 0,
    estimatedCostAmount: resolveFloat(fields.estimatedCostAmount, 0, 0),
    modelRouterCostAmount: resolveFloat(fields.modelRouterCostAmount, 0, 0),
    actualModelCostAmount: resolveFloat(fields.actualModelCostAmount, 0, 0),
    currency: String(fields.currency || "USD").trim() || "USD",
    payload: {
      ...(fields.payload && typeof fields.payload === "object" && !Array.isArray(fields.payload) ? fields.payload : {}),
      ...Object.fromEntries(["canonicalModelId", "channelId", "sourceModelId", "configRevision", "historyId", "reportedModelName"]
        .filter(key => typeof fields[key] === "string" && fields[key]).map(key => [key, fields[key]])),
      modelStatsRecordedAt: fields.payload?.modelStatsRecordedAt
        || toIsoString(Math.max(Date.now(), modelEventClockFloor)),
      ...(fields.conversationId ? { conversationId: String(fields.conversationId) } : {}),
      ...(fields.sessionId ? { sessionId: String(fields.sessionId) } : {})
    }
  };
}

function enqueueMemoryFallback(settings, event) {
  if (runtimeEventQueue.length >= settings.maxQueueSize) {
    updateRuntimeStoreState({ droppedEvents: runtimeStoreState.droppedEvents + 1 });
    if (event.eventType === "operation") return;
    const oldestOperation = runtimeEventQueue.findIndex(item => item.eventType === "operation");
    runtimeEventQueue.splice(Math.max(0, oldestOperation), 1);
  }
  runtimeEventQueue.push(event);
  updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured });
  scheduleFlush(settings);
}

function persistRuntimeEventLocally(settings, event) {
  if (pendingLocalAppend?.path === settings.localBufferPath && pendingLocalAppend.limit === settings.maxPersistedEvents) {
    if (event.eventType === "operation" && pendingLocalAppend.events.length >= settings.maxPersistedEvents) {
      updateRuntimeStoreState({ droppedEvents: runtimeStoreState.droppedEvents + 1 });
      return;
    }
    pendingLocalAppend.events.push(event);
    return;
  }
  const events = [event];
  pendingLocalAppend = { path: settings.localBufferPath, limit: settings.maxPersistedEvents, events };
  void appendLocalBufferEvents(settings, events)
    .then(({ dropped }) => {
      if (dropped > 0) {
        updateRuntimeStoreState({ droppedEvents: runtimeStoreState.droppedEvents + dropped });
      }
      scheduleFlush(settings);
    })
    .catch((error) => {
      appendStructuredLog("warn", {
        source: "runtime-store",
        event: "runtime_store.local_buffer_append_failed",
        failureReason: error?.message || "Failed to append runtime event to local buffer",
        target: settings.localBufferPath
      });
      for (const buffered of events) enqueueMemoryFallback(settings, buffered);
    });
}

function enqueueRuntimeEvent(settings, event) {
  if (!settings.enabled) {
    return;
  }
  if (runtimeStoreState.spilloverActive || !settings.configured) {
    persistRuntimeEventLocally(settings, event);
    return;
  }
  enqueueMemoryFallback(settings, event);
}

async function insertRuntimeEvents(settings, batchItems) {
  const pool = getRuntimeStorePool(settings);
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const columns = [
    "event_uid",
    "event_type",
    "signal_name",
    "request_id",
    "occurred_at",
    "key_id",
    "model_id",
    "actual_model_id",
    "route_key",
    "backend_route_key",
    "blocked_reason",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_tokens",
    "text_unknown_cost_requests",
    ...CACHE_WRITE_COLUMNS,
    "estimated_cost_amount",
    "model_router_cost_amount",
    "actual_model_cost_amount",
    "currency",
    "payload"
  ];

  const values = [];
  const rows = batchItems.map((item, index) => {
    const offset = index * columns.length;
    values.push(
      item.eventUid,
      item.eventType,
      item.signalName,
      item.requestId,
      item.occurredAt,
      item.keyId,
      item.modelId,
      item.actualModelId,
      item.routeKey,
      item.backendRouteKey,
      item.blockedReason,
      item.promptTokens,
      item.completionTokens,
      item.totalTokens,
      item.cachedTokens,
      item.textUnknownCostRequests,
      ...cacheWriteColumnValues(item.cacheWrite),
      item.estimatedCostAmount,
      item.modelRouterCostAmount,
      item.actualModelCostAmount,
      item.currency,
      JSON.stringify(item.payload || {})
    );
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });

  // The shared lock excludes an in-flight rollup batch, so event IDs never commit behind the rollup cursor.
  const client = await pool.connect();
  let transactionError;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [rollupLockKey(settings)]);
    await client.query(
      `INSERT INTO ${schemaName}.${eventsTableName} (${columns.join(", ")}) VALUES ${rows.join(", ")}
       ON CONFLICT (event_uid) DO NOTHING`,
      values
    );
    await client.query("COMMIT");
  } catch (error) {
    transactionError = error;
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(transactionError); }
}

function rollupLockKey(settings) {
  return `${settings.schemaName}.${settings.metaTableName}:rollup`;
}

function normalizeEventRecord(row) {
  return {
    eventId: resolveInt(row?.event_id, 0, 0),
    eventType: String(row?.event_type || "").trim(),
    signalName: String(row?.signal_name || "").trim(),
    requestId: row?.request_id ? String(row.request_id) : null,
    occurredAt: row?.occurred_at instanceof Date ? row.occurred_at.toISOString() : toIsoString(row?.occurred_at || Date.now()),
    keyId: String(row?.key_id || "anonymous").trim() || "anonymous",
    modelId: String(row?.model_id || "").trim(),
    actualModelId: String(row?.actual_model_id || "").trim(),
    routeKey: String(row?.route_key || "").trim(),
    backendRouteKey: String(row?.backend_route_key || "").trim(),
    blockedReason: String(row?.blocked_reason || "").trim(),
    promptTokens: resolveInt(row?.prompt_tokens, 0, 0),
    completionTokens: resolveInt(row?.completion_tokens, 0, 0),
    totalTokens: resolveInt(row?.total_tokens, 0, 0),
    cachedTokens: resolveInt(row?.cached_tokens, 0, 0),
    cacheWrite: cacheWriteFromRow(row),
    textUnknownCostRequests: resolveInt(row?.text_unknown_cost_requests, 0, 0),
    estimatedCostAmount: resolveFloat(row?.estimated_cost_amount, 0, 0),
    modelRouterCostAmount: resolveFloat(row?.model_router_cost_amount, 0, 0),
    actualModelCostAmount: resolveFloat(row?.actual_model_cost_amount, 0, 0),
    currency: String(row?.currency || "USD").trim() || "USD",
    payload: asPlainObject(row?.payload)
  };
}

function createMetricDelta(event) {
  return {
    requests: event.eventType === "request" ? 1 : 0,
    errors: event.eventType === "error" ? 1 : 0,
    blockedCount: event.eventType === "blocked" ? 1 : 0,
    warningCount: event.eventType === "warning" ? 1 : 0,
    promptTokens: event.eventType === "usage" ? event.promptTokens : 0,
    completionTokens: event.eventType === "usage" ? event.completionTokens : 0,
    totalTokens: event.eventType === "usage" ? event.totalTokens : 0,
    cachedTokens: event.eventType === "usage" ? event.cachedTokens : 0,
    cacheWrite: event.cacheWrite,
    textUnknownCostRequests: event.eventType === "usage" ? event.textUnknownCostRequests : 0,
    estimatedCostAmount: event.eventType === "usage" ? event.estimatedCostAmount : 0,
    modelRouterCostAmount: event.eventType === "usage" ? event.modelRouterCostAmount : 0,
    actualModelCostAmount: event.eventType === "usage" ? event.actualModelCostAmount : 0,
    currency: event.currency || "USD",
    lastOccurredAt: event.occurredAt
  };
}

function eventChannelIdentity(event) {
  const { payload } = event;
  return channelIdentity(event.modelId, { ...payload, routeKey: event.routeKey, backendRouteKey: event.backendRouteKey,
    actualModelName: event.actualModelId }, event.eventType, payload.textCost?.pricing?.actual,
  payload.media?.costStatus ?? payload.textCost?.costStatus, payload.media ? null : event.currency);
}

function getBucketStart(grain, occurredAt) {
  const source = new Date(occurredAt);
  const date = Number.isFinite(source.getTime()) ? source : new Date();
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  if (grain === "hourly") {
    return toIsoString(Date.UTC(year, month, day, hour));
  }
  if (grain === "daily") {
    return toIsoString(Date.UTC(year, month, day));
  }
  const dayOfWeek = date.getUTCDay() || 7;
  return toIsoString(Date.UTC(year, month, day - dayOfWeek + 1));
}

function getRollupKey(grain, bucketStart, scopeType, scopeKey = "", scopeSubkey = "") {
  return [grain, bucketStart, scopeType, scopeKey, scopeSubkey].join("\u0000");
}

function addRollupMetric(target, delta) {
  target.requests += delta.requests;
  target.settlements += delta.settlements || 0;
  target.errors += delta.errors;
  target.blockedCount += delta.blockedCount;
  target.warningCount += delta.warningCount;
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
  target.cachedTokens += delta.cachedTokens;
  const left = target.cacheWrite;
  const right = delta.cacheWrite;
  const nullableSum = (a, b) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  target.cacheWrite = summarizeCacheWrite({
    requests: left.requests + right.requests,
    observedRequests: left.observedRequests + right.observedRequests,
    pricedRequests: left.pricedRequests + right.pricedRequests,
    partialCostRequests: left.partialCostRequests + right.partialCostRequests,
    unreportedRequests: left.unreportedRequests === null || right.unreportedRequests === null ? null : left.unreportedRequests + right.unreportedRequests,
    observedTokens: nullableSum(left.observedTokens, right.observedTokens),
    knownCostAmount: nullableSum(left.knownCostAmount, right.knownCostAmount)
  });
  target.textUnknownCostRequests += delta.textUnknownCostRequests;
  target.estimatedCostAmount += delta.estimatedCostAmount;
  target.modelRouterCostAmount += delta.modelRouterCostAmount;
  target.actualModelCostAmount += delta.actualModelCostAmount;
  if (delta.currency) {
    target.currency = delta.currency;
  }
  if (!target.lastOccurredAt || Date.parse(delta.lastOccurredAt) > Date.parse(target.lastOccurredAt)) {
    target.lastOccurredAt = delta.lastOccurredAt;
  }
}

function addRollupRow(map, grain, bucketStart, scopeType, scopeKey, scopeSubkey, delta) {
  const key = getRollupKey(grain, bucketStart, scopeType, scopeKey, scopeSubkey);
  if (!map.has(key)) {
    map.set(key, {
      grain,
      bucketStart,
      scopeType,
      scopeKey,
      scopeSubkey,
      requests: 0,
      settlements: 0,
      errors: 0,
      blockedCount: 0,
      warningCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWrite: summarizeCacheWrite(),
      textUnknownCostRequests: 0,
      estimatedCostAmount: 0,
      modelRouterCostAmount: 0,
      actualModelCostAmount: 0,
      currency: delta.currency || "USD",
      lastOccurredAt: delta.lastOccurredAt || bucketStart
    });
  }
  addRollupMetric(map.get(key), delta);
}

function buildRollupRows(events, modelsResetAt) {
  const rows = new Map();
  for (const event of events) {
    if (event.eventType === "operation") continue;
    const delta = createMetricDelta(event);
    const includeModel = !modelsResetAt || Date.parse(event.payload.modelStatsRecordedAt || event.occurredAt) > Date.parse(modelsResetAt);
    for (const grain of ROLLUP_GRAINS) {
      const bucketStart = getBucketStart(grain, event.occurredAt);
      addRollupRow(rows, grain, bucketStart, "global", GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_SUBKEY, delta);

      if (event.keyId) {
        addRollupRow(rows, grain, bucketStart, "key", event.keyId, "", delta);
      }
      if (event.modelId && includeModel) {
        addRollupRow(rows, grain, bucketStart, "model", event.modelId, "", delta);
        if (grain === "daily" && ["request", "error", "usage"].includes(event.eventType)) {
          const identity = eventChannelIdentity(event);
          const key = JSON.stringify([event.eventType, identity]);
          addRollupRow(rows, grain, bucketStart, "channel_detail", event.modelId, key, { ...delta, settlements: event.eventType === "usage" ? 1 : 0 });
          for (const [currency, amount] of Object.entries(event.payload.media?.knownCostAmounts || {})) {
            if (Number.isFinite(amount) && amount >= 0) addRollupRow(rows, grain, bucketStart, "channel_currency",
              event.modelId, JSON.stringify(["media_cost", identity, currency]), {
                ...createMetricDelta({ occurredAt: event.occurredAt, cacheWrite: summarizeCacheWrite() }),
                currency, estimatedCostAmount: amount
              });
          }
        }
        if (event.eventType === "usage") {
          const identity = billingTierIdentity(event.modelId, event.actualModelId, event.payload.textCost?.pricing?.actual);
          addRollupRow(rows, grain, bucketStart, "billing_tier", event.modelId, billingTierKey(identity), { ...delta, requests: 1 });
        }
      }
      if (event.modelId && event.actualModelId && includeModel) {
        addRollupRow(rows, grain, bucketStart, "actual_model", event.modelId, event.actualModelId, delta);
      }
      if (event.eventType === "blocked" && event.blockedReason) {
        addRollupRow(rows, grain, bucketStart, "blocked_reason", event.blockedReason, "", delta);
      }
      if (event.eventType === "warning" && event.signalName) {
        addRollupRow(rows, grain, bucketStart, "warning_event", event.signalName, "", delta);
      }
    }
  }
  return Array.from(rows.values());
}

async function upsertRollupRows(settings, rollupRows, pool = getRuntimeStorePool(settings)) {
  if (!rollupRows.length) {
    return;
  }
  // Distinct detail identities can produce more rows than the event batch.
  if (rollupRows.length > 2000) {
    for (let i = 0; i < rollupRows.length; i += 2000) await upsertRollupRows(settings, rollupRows.slice(i, i + 2000), pool);
    return;
  }
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const columns = [
    "grain",
    "bucket_start",
    "scope_type",
    "scope_key",
    "scope_subkey",
    "requests",
    "errors",
    "blocked_count",
    "warning_count",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_tokens",
    "text_unknown_cost_requests",
    ...CACHE_WRITE_COLUMNS,
    "estimated_cost_amount",
    "model_router_cost_amount",
    "actual_model_cost_amount",
    "currency",
    "last_occurred_at",
    "channel_detail",
    "channel_settlements"
  ];
  const values = [];
  const rows = rollupRows.map((item, index) => {
    const offset = index * columns.length;
    const channelScope = item.scopeType === "channel_detail" || item.scopeType === "channel_currency";
    values.push(
      item.grain,
      item.bucketStart,
      item.scopeType,
      channelScope ? "" : item.scopeKey,
      // The composite identity can exceed PostgreSQL's btree tuple size. Keep it
      // in JSONB and index a digest, not a concatenation of arbitrary provider IDs.
      channelScope ? createHash("sha256").update(item.scopeSubkey).digest("hex") : item.scopeSubkey,
      item.requests,
      item.errors,
      item.blockedCount,
      item.warningCount,
      item.promptTokens,
      item.completionTokens,
      item.totalTokens,
      item.cachedTokens,
      item.textUnknownCostRequests,
      ...cacheWriteColumnValues(item.cacheWrite),
      item.estimatedCostAmount,
      item.modelRouterCostAmount,
      item.actualModelCostAmount,
      item.currency,
      item.lastOccurredAt,
      channelScope ? item.scopeSubkey : null,
      channelScope ? item.settlements : null
    );
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });

  await pool.query(
    `INSERT INTO ${schemaName}.${rollupsTableName} (${columns.join(", ")}) VALUES ${rows.join(", ")}
     ON CONFLICT (grain, bucket_start, scope_type, scope_key, scope_subkey)
     DO UPDATE SET
       requests = ${schemaName}.${rollupsTableName}.requests + EXCLUDED.requests,
       channel_settlements = ${schemaName}.${rollupsTableName}.channel_settlements + EXCLUDED.channel_settlements,
       errors = ${schemaName}.${rollupsTableName}.errors + EXCLUDED.errors,
       blocked_count = ${schemaName}.${rollupsTableName}.blocked_count + EXCLUDED.blocked_count,
       warning_count = ${schemaName}.${rollupsTableName}.warning_count + EXCLUDED.warning_count,
       prompt_tokens = ${schemaName}.${rollupsTableName}.prompt_tokens + EXCLUDED.prompt_tokens,
       completion_tokens = ${schemaName}.${rollupsTableName}.completion_tokens + EXCLUDED.completion_tokens,
       total_tokens = ${schemaName}.${rollupsTableName}.total_tokens + EXCLUDED.total_tokens,
       cached_tokens = ${schemaName}.${rollupsTableName}.cached_tokens + EXCLUDED.cached_tokens,
       text_unknown_cost_requests = ${schemaName}.${rollupsTableName}.text_unknown_cost_requests + EXCLUDED.text_unknown_cost_requests,
       ${CACHE_WRITE_COLUMNS.map(name => {
         const current = `${schemaName}.${rollupsTableName}.${name}`;
         if (name === "cache_write_estimated_cost_amount") {
           const table = `${schemaName}.${rollupsTableName}`;
           return `${name} = CASE WHEN ${table}.cache_write_unreported_requests + EXCLUDED.cache_write_unreported_requests = 0
             AND ${table}.cache_write_requests + EXCLUDED.cache_write_requests > 0
             AND ${table}.cache_write_priced_requests + EXCLUDED.cache_write_priced_requests = ${table}.cache_write_requests + EXCLUDED.cache_write_requests
             THEN COALESCE(${current}, 0) + COALESCE(EXCLUDED.${name}, 0) ELSE NULL END`;
         }
         if (["cache_write_tokens", "cache_write_known_cost_amount"].includes(name)) {
           return `${name} = CASE WHEN ${current} IS NULL AND EXCLUDED.${name} IS NULL THEN NULL ELSE COALESCE(${current}, 0) + COALESCE(EXCLUDED.${name}, 0) END`;
         }
         return `${name} = ${current} + EXCLUDED.${name}`;
       }).join(",\n       ")},
       estimated_cost_amount = ${schemaName}.${rollupsTableName}.estimated_cost_amount + EXCLUDED.estimated_cost_amount,
       model_router_cost_amount = ${schemaName}.${rollupsTableName}.model_router_cost_amount + EXCLUDED.model_router_cost_amount,
       actual_model_cost_amount = ${schemaName}.${rollupsTableName}.actual_model_cost_amount + EXCLUDED.actual_model_cost_amount,
       currency = CASE WHEN EXCLUDED.currency <> '' THEN EXCLUDED.currency ELSE ${schemaName}.${rollupsTableName}.currency END,
       last_occurred_at = GREATEST(${schemaName}.${rollupsTableName}.last_occurred_at, EXCLUDED.last_occurred_at)`,
    values
  );
}

async function getMetaValue(settings, metaKey, pool = getRuntimeStorePool(settings)) {
  const { schemaName, metaTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(
    `SELECT meta_value FROM ${schemaName}.${metaTableName} WHERE meta_key = $1`,
    [metaKey]
  );
  return result.rows[0]?.meta_value || "";
}

async function setMetaValue(settings, metaKey, metaValue, pool = getRuntimeStorePool(settings)) {
  const { schemaName, metaTableName } = getQualifiedTableNames(settings);
  await pool.query(
    `INSERT INTO ${schemaName}.${metaTableName} (meta_key, meta_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (meta_key)
     DO UPDATE SET meta_value = EXCLUDED.meta_value, updated_at = NOW()`,
    [metaKey, String(metaValue)]
  );
}

async function fetchUnrolledEvents(settings, afterEventId, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(
    `SELECT
       event_id,
       event_type,
       signal_name,
       request_id,
       occurred_at,
       key_id,
       model_id,
       actual_model_id,
       route_key,
       backend_route_key,
       blocked_reason,
       prompt_tokens,
       completion_tokens,
       total_tokens,
       cached_tokens,
       text_unknown_cost_requests,
       ${CACHE_WRITE_COLUMNS.join(", ")},
       estimated_cost_amount,
       model_router_cost_amount,
       actual_model_cost_amount,
       currency,
       payload
     FROM ${schemaName}.${eventsTableName}
     WHERE event_id > $1
     ORDER BY event_id ASC
     LIMIT $2`,
    [afterEventId, settings.rollupBatchSize]
  );
  return result.rows.map(normalizeEventRecord);
}

async function withRollupLock(settings, operation) {
  const client = await getRuntimeStorePool(settings).connect();
  let transactionError;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [rollupLockKey(settings)]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    transactionError = error;
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(transactionError); }
}

async function rollupRuntimeEvents(settings) {
  if (!settings.configured) {
    return { processed: 0 };
  }

  let processed = 0;
  let lastEventId = 0;
  try {
    while (true) {
      const batch = await withRollupLock(settings, async client => {
        lastEventId = resolveInt(await getMetaValue(settings, META_LAST_ROLLED_EVENT_ID, client), 0, 0);
        const modelsResetAt = await getMetaValue(settings, META_MODELS_RESET_AT, client);
        const batch = await fetchUnrolledEvents(settings, lastEventId, client);
        if (batch.length) {
          await upsertRollupRows(settings, buildRollupRows(batch, modelsResetAt), client);
          lastEventId = batch[batch.length - 1].eventId;
          await setMetaValue(settings, META_LAST_ROLLED_EVENT_ID, lastEventId, client);
        }
        return batch;
      });
      processed += batch.length;
      if (batch.length < settings.rollupBatchSize) break;
    }
    updateRuntimeStoreState({
      lastRolledEventId: lastEventId,
      lastRollupTs: processed > 0 ? toIsoString() : runtimeStoreState.lastRollupTs,
      lastError: null
    });
    return { processed };
  } catch (error) {
    updateRuntimeStoreState({
      rollupFailures: runtimeStoreState.rollupFailures + 1,
      lastError: snapshotError(error)
    });
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.rollup_failed",
      failureReason: error?.message || "Runtime store rollup failed",
      target: describeRuntimeTarget(settings)
    });
    throw error;
  }
}

export function flushRuntimeEvents() {
  return serializeDatabaseOperation(flushRuntimeEventsInternal);
}

export async function drainRuntimeEvents() {
  await databaseOperation;
  let flushed = 0;
  while (true) {
    await localBufferOperation;
    const state = getRuntimeStoreInfo();
    if (state.queueLength === 0 && state.persistedEventCount === 0) break;
    const result = await flushRuntimeEvents();
    flushed += result.flushed || 0;
    if (result.error || result.skipped || result.flushed === 0) break;
  }
  const state = getRuntimeStoreInfo();
  return {
    flushed,
    pendingMemoryEvents: state.queueLength,
    pendingPersistedEvents: state.persistedEventCount
  };
}

export async function resetRuntimeModelStats(config) {
  return serializeDatabaseOperation(async () => {
    const settings = resolveRuntimeStoreSettings(config);
    let memoryReset;
    try {
      if (settings.enabled && !settings.configured) {
        throw Object.assign(new Error("Model statistics reset requires a configured runtime database"), { code: "RUNTIME_STORE_CONFIG_INCOMPLETE" });
      }
      if (settings.configured) await ensureRuntimeTables(settings);
      const reset = async client => {
        const modelsResetAt = toIsoString(Math.max(Date.now(), modelEventClockFloor));
        modelEventClockFloor = Date.parse(modelsResetAt) + 1;
        memoryReset = beginModelStatsReset(modelsResetAt);
        if (!client) return modelsResetAt;
        const { schemaName, rollupsTableName, metaTableName } = getQualifiedTableNames(settings);
        await client.query(`
          WITH reset_models AS (
            DELETE FROM ${schemaName}.${rollupsTableName}
            WHERE scope_type IN ('model', 'actual_model', 'billing_tier', 'channel_detail', 'channel_currency')
          )
          INSERT INTO ${schemaName}.${metaTableName} (meta_key, meta_value, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (meta_key) DO UPDATE SET meta_value = EXCLUDED.meta_value, updated_at = NOW()
        `, [META_MODELS_RESET_AT, modelsResetAt]);
        return modelsResetAt;
      };
      const modelsResetAt = settings.configured ? await withRollupLock(settings, reset) : await reset(null);
      memoryReset.commit();
      modelStatsGeneration++;
      return { modelsResetAt };
    } catch (error) {
      memoryReset?.rollback();
      updateRuntimeStoreState({ lastError: snapshotError(error) });
      appendStructuredLog("warn", {
        source: "runtime-store", event: "runtime_store.model_stats_reset_failed",
        failureReason: error?.message || "Model statistics reset failed",
        target: describeRuntimeTarget(settings)
      });
      throw error;
    }
  });
}

async function flushRuntimeEventsInternal() {
  const settings = resolveRuntimeStoreSettings(runtimeStoreConfig);
  if (runtimeStoreState.localBufferPath !== settings.localBufferPath || runtimeStoreState.maxPersistedEvents !== settings.maxPersistedEvents) {
    await refreshLocalBufferState(settings);
  }
  if (!settings.configured || (runtimeEventQueue.length === 0 && runtimeStoreState.persistedEventCount === 0)) {
    updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured, flushing: false, nextFlushAt: null, localBufferPath: settings.localBufferPath, maxPersistedEvents: settings.maxPersistedEvents });
    return { flushed: 0 };
  }
  if (flushRunning) {
    return { flushed: 0, skipped: true };
  }

  flushRunning = true;
  updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured, flushing: true, nextFlushAt: null });
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  let batchItems = [];
  let localBatch = null;
  let batchSource = "memory";
  let retry = false;
  try {
    if (runtimeStoreState.persistedEventCount > 0) {
      batchSource = "local";
      localBatch = await peekLocalBufferBatch(settings, settings.batchSize);
      batchItems = localBatch.items;
    } else {
      batchItems = runtimeEventQueue.splice(0, settings.batchSize);
      updateRuntimeStoreState({});
    }
    if (!batchItems.length) return { flushed: 0 };

    await ensureRuntimeTables(settings);
    await insertRuntimeEvents(settings, batchItems);
    await rollupRuntimeEvents(settings);
    await cleanupRuntimeData(settings);
    if (batchSource === "local") {
      await ackLocalBufferBatch(settings, localBatch);
    }
    updateRuntimeStoreState({
      lastSuccessTs: toIsoString(),
      lastError: null,
      flushing: false,
      spilloverActive: runtimeStoreState.persistedEventCount > 0
    });
    return { flushed: batchItems.length };
  } catch (error) {
    retry = true;
    if (batchSource === "memory") {
      const backlog = batchItems.concat(runtimeEventQueue.splice(0, runtimeEventQueue.length));
      try {
        const { dropped } = await appendLocalBufferEvents(settings, backlog);
        updateRuntimeStoreState({
          droppedEvents: runtimeStoreState.droppedEvents + dropped,
          spilloverActive: true
        });
      } catch (persistError) {
        runtimeEventQueue.unshift(...backlog);
        if (runtimeEventQueue.length > settings.maxQueueSize) {
          const dropped = runtimeEventQueue.length - settings.maxQueueSize;
          runtimeEventQueue.splice(0, dropped);
          updateRuntimeStoreState({ droppedEvents: runtimeStoreState.droppedEvents + dropped });
        }
        appendStructuredLog("warn", {
          source: "runtime-store",
          event: "runtime_store.local_buffer_persist_failed",
          failureReason: persistError?.message || "Failed to persist runtime backlog locally",
          target: settings.localBufferPath
        });
      }
    }
    updateRuntimeStoreState({
      flushFailures: runtimeStoreState.flushFailures + 1,
      lastError: snapshotError(error),
      flushing: false
    });
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.flush_failed",
      failureReason: error?.message || "Runtime store flush failed",
      target: describeRuntimeTarget(settings)
    });
    return { flushed: 0, error };
  } finally {
    flushRunning = false;
    updateRuntimeStoreState({ flushing: false });
    // Scheduling while flushRunning is true is a no-op. Re-arm only after
    // releasing it, including retries and the remaining queued batches.
    scheduleFlush(resolveRuntimeStoreSettings(runtimeStoreConfig), { retry });
  }
}

export function validateRuntimeStoreTransition(config) {
  if (boundLocalBufferPath && resolveRuntimeStoreSettings(config).localBufferPath !== boundLocalBufferPath) {
    throw Object.assign(new Error("The runtime buffer path cannot change while running. Drain or migrate the old buffer while stopped, then restart with the new path."), {
      code: "RUNTIME_STORE_RESTART_REQUIRED", status: 409
    });
  }
}

export function setRuntimeStoreConfig(config, { refreshLocalBuffer = true } = {}) {
  if (config) validateRuntimeStoreTransition(config);
  runtimeStoreConfig = config || null;
  const generation = ++runtimeConfigGeneration;
  if (!config) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    boundLocalBufferPath = "";
    return;
  }
  const settings = resolveRuntimeStoreSettings(runtimeStoreConfig);
  if (settings.enabled) boundLocalBufferPath = settings.localBufferPath;
  updateRuntimeStoreState({
    enabled: settings.enabled,
    configured: settings.configured,
    localBufferPath: settings.localBufferPath,
    maxPersistedEvents: settings.maxPersistedEvents,
    lastError: settings.enabled && !settings.configured
      ? {
          code: "RUNTIME_STORE_CONFIG_INCOMPLETE",
          statusCode: null,
          message: "Runtime store requires PostgreSQL connection when database mode is enabled"
        }
      : null
  });
  if (!settings.configured && flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const refresh = refreshLocalBuffer || localBufferCursor.path !== settings.localBufferPath
    ? serializeDatabaseOperation(() => generation === runtimeConfigGeneration ? refreshLocalBufferState(settings) : undefined)
    : Promise.resolve();
  void refresh
    .then(() => {
      if (generation === runtimeConfigGeneration && settings.configured && (runtimeEventQueue.length > 0 || runtimeStoreState.persistedEventCount > 0)) {
        scheduleFlush(settings);
      }
    })
    .catch((error) => {
      appendStructuredLog("warn", {
        source: "runtime-store",
        event: "runtime_store.local_buffer_state_failed",
        failureReason: error?.message || "Failed to refresh runtime local buffer state",
        target: settings.localBufferPath
      });
    });
}

export function getRuntimeStoreInfo(config = runtimeStoreConfig) {
  const settings = resolveRuntimeStoreSettings(config);
  return {
    enabled: settings.enabled,
    configured: settings.configured,
    schemaName: settings.schemaName,
    eventsTableName: settings.eventsTableName,
    rollupsTableName: settings.rollupsTableName,
    metaTableName: settings.metaTableName,
    detailRetentionDays: settings.detailRetentionDays,
    rollupRetentionDays: settings.rollupRetentionDays,
    rollupBatchSize: settings.rollupBatchSize,
    flushIntervalMs: settings.flushIntervalMs,
    batchSize: settings.batchSize,
    maxQueueSize: settings.maxQueueSize,
    localBufferPath: settings.localBufferPath,
    maxPersistedEvents: settings.maxPersistedEvents,
    queueLength: runtimeEventQueue.length,
    persistedEventCount: runtimeStoreState.persistedEventCount,
    corruptedEvents: runtimeStoreState.corruptedEvents,
    droppedEvents: runtimeStoreState.droppedEvents,
    flushFailures: runtimeStoreState.flushFailures,
    rollupFailures: runtimeStoreState.rollupFailures,
    lastSuccessTs: runtimeStoreState.lastSuccessTs,
    lastRollupTs: runtimeStoreState.lastRollupTs,
    lastRolledEventId: runtimeStoreState.lastRolledEventId,
    lastError: runtimeStoreState.lastError,
    flushing: runtimeStoreState.flushing,
    nextFlushAt: runtimeStoreState.nextFlushAt,
    spilloverActive: runtimeStoreState.spilloverActive
  };
}

export function recordRuntimeRequest(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  enqueueRuntimeEvent(settings, buildEventRow("request", {
    ...fields,
    payload: {
      stream: fields.stream === true,
      targetUrl: fields.targetUrl || ""
    }
  }));
}

export function recordRuntimeOperation(config, fields) {
  const payload = operationFields(fields, config);
  if (!payload?.eventUid) return;
  const settings = resolveRuntimeStoreSettings(config);
  enqueueRuntimeEvent(settings, buildEventRow("operation", {
    eventUid: payload.eventUid, occurredAt: fields.ts, event: payload.event, requestId: payload.requestId, payload
  }));
}

export async function readRuntimeOperations(config, filters = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  const generation = runtimeConfigGeneration;
  const limit = operationLimit(filters.limit);
  const capturedAt = toIsoString();
  const retainedSince = toIsoString(Math.max(0, Date.parse(capturedAt) - settings.detailRetentionDays * 86400000));
  const base = {
    ok: true, view: "operations", recordSource: "database", capturedAt, retainedSince,
    detailRetentionDays: settings.detailRetentionDays, droppedEvents: runtimeStoreState.droppedEvents,
    limit, total: 0, items: [], hasMore: false
  };
  if (!settings.configured) return { ...base, retainedSince: null, persistence: settings.enabled ? "unavailable" : "disabled" };
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const values = [retainedSince];
  const clauses = ["event_type = 'operation'", "occurred_at >= $1::timestamptz"];
  for (const [field, column] of Object.entries({
    operationId: "payload->>'operationId'", configRevision: "payload->>'configRevision'",
    modelId: "payload->>'modelId'", event: "signal_name", requestId: "request_id"
  })) {
    if (filters[field]) clauses.push(`${column} = $${values.push(String(filters[field]).slice(0, 256))}`);
  }
  if (filters.connectionId) {
    const ref = `$${values.push(String(filters.connectionId).slice(0, 256))}`;
    clauses.push(`(${ref} IN (payload->>'connectionId', payload->>'channelId', payload->>'previousChannelId'))`);
  }
  if (filters.level) {
    const levels = String(filters.level).split(",").filter(value => ["trace", "debug", "info", "warn", "error", "fatal"].includes(value));
    clauses.push(`payload->>'level' = ANY($${values.push(levels)}::text[])`);
  }
  if (filters.since && Number.isFinite(Date.parse(filters.since))) {
    clauses.push(`occurred_at >= $${values.push(toIsoString(Date.parse(filters.since)))}::timestamptz`);
  }
  try {
    const { rows } = await withRuntimeReadSnapshot(settings, client => client.query(
      `SELECT event_uid, occurred_at, signal_name, payload FROM ${schemaName}.${eventsTableName}
       WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC, event_id DESC LIMIT $${values.push(limit + 1)}`, values
    ), { ensureTables: false });
    if (generation !== runtimeConfigGeneration) return { ...base, persistence: "unavailable" };
    const items = rows.slice(0, limit).flatMap(row => {
      const payload = operationFields({ ...row.payload, event: row.signal_name, eventUid: row.event_uid }, config);
      if (!payload?.eventUid) return [];
      const { source, level, event, modelId, errorCode, requestId, latencyMs, ...fields } = payload;
      return [{ id: row.event_uid, ts: toIsoString(row.occurred_at), source, level, event, modelId, errorCode, requestId, latencyMs, fields }];
    });
    return { ...base, persistence: "available", total: items.length, hasMore: rows.length > limit, items };
  } catch {
    // Missing tables, offline database and read timeouts are not an empty, successful history.
    return { ...base, persistence: "unavailable" };
  }
}

export function recordRuntimeBlocked(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  enqueueRuntimeEvent(settings, buildEventRow("blocked", fields));
}

export function recordRuntimeWarning(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  enqueueRuntimeEvent(settings, buildEventRow("warning", {
    ...fields,
    payload: {
      source: fields.source || "governance",
      ...asPlainObject(fields.payload),
      ...(typeof fields.amount === "number" ? { amount: fields.amount } : {}),
      ...(typeof fields.limitAmount === "number" ? { limitAmount: fields.limitAmount } : {}),
      ...(typeof fields.softLimitAmount === "number" ? { softLimitAmount: fields.softLimitAmount } : {}),
      ...(fields.failureReason ? { failureReason: fields.failureReason } : {})
    }
  }));
}

export function recordRuntimeError(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  enqueueRuntimeEvent(settings, buildEventRow("error", {
    ...fields,
    payload: {
      status: fields.status ?? null,
      errorCode: fields.errorCode || "",
      failureReason: fields.failureReason || ""
    }
  }));
}

export function recordRuntimeUsage(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  const knownCostAmount = resolveFloat(fields.costStatus ? fields.amount ?? fields.estimatedCostAmount : fields.estimatedCostAmount, 0, 0);
  enqueueRuntimeEvent(settings, buildEventRow("usage", {
    ...fields,
    estimatedCostAmount: knownCostAmount,
    payload: {
      source: fields.source || "",
      usageSource: fields.usageSource || "",
      usageEstimated: fields.usageEstimated === true,
      usageEstimationReason: fields.usageEstimationReason || "",
      ...(fields.cacheWrite ? { cacheWrite: normalizeCacheWrite(fields.cacheWrite) } : {}),
      ...(fields.costStatus ? {
        textCost: {
          costStatus: fields.costStatus,
          costReason: fields.costReason || "",
          estimatedCostAmount: fields.costStatus === "priced" ? knownCostAmount : null,
          knownCostAmount,
          pricing: {
            actual: snapshotPricingAudit(fields.pricing?.actual),
            router: snapshotPricingAudit(fields.pricing?.router)
          }
        }
      } : {})
    }
  }));
}

function snapshotPricingAudit(value) {
  if (!value || typeof value !== "object") return null;
  let tier = null;
  if (typeof value.tier === "string") tier = value.tier;
  else if (value.tier && typeof value.tier === "object") {
    const rates = asPlainObject(value.tier.rates);
    tier = {
      id: value.tier.id,
      promptTokensAtLeast: value.tier.promptTokensAtLeast,
      promptTokensBelow: value.tier.promptTokensBelow,
      rates: Object.fromEntries([
        "inputPer1mTokens", "outputPer1mTokens", "cachedInputPer1mTokens",
        "cacheWritePer1mTokens", "cacheWrite5mPer1mTokens", "cacheWrite1hPer1mTokens"
      ].filter(name => typeof rates[name] === "number" && Number.isFinite(rates[name]) && rates[name] >= 0)
        .map(name => [name, rates[name]]))
    };
  }
  return {
    source: value.source || "",
    policyDigest: value.policyDigest || "",
    ...(["tier", "flat", "unknown"].includes(value.tieringState) ? { tieringState: value.tieringState } : {}),
    tier
  };
}

export function recordRuntimeMediaUsage(config, fields = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  const media = fields.mediaUsage || {};
  enqueueRuntimeEvent(settings, buildEventRow("usage", {
    ...fields,
    payload: { source: "media", usageSource: "upstream", media: {
      counters: media.counters || {}, usageStatus: media.usageStatus || "unknown", costStatus: media.costStatus || "unknown",
      estimatedCostAmount: media.estimatedCostAmount ?? null, currency: media.currency || null,
      knownCostAmounts: media.knownCostAmounts || {}, unknownCostItems: media.unknownCostItems || 0,
      unknownUsageItems: media.unknownUsageItems || 0, pricingSources: media.pricingSources || []
    } }
  }));
}

function numeric(value) {
  return Number(value) || 0;
}

function integer(value) {
  return Math.trunc(Number(value) || 0);
}

function currencyValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "USD";
}

function cacheWriteFromRow(row = {}) {
  const nonTextEvent = row.event_type && (row.event_type !== "usage" || row.payload?.source === "media");
  return summarizeCacheWrite({
    requests: integer(row.cache_write_requests),
    observedRequests: integer(row.cache_write_observed_requests),
    pricedRequests: integer(row.cache_write_priced_requests),
    partialCostRequests: integer(row.cache_write_partial_cost_requests),
    // NULL coverage marks historical data, not a measured zero.
    unreportedRequests: row.cache_write_unreported_requests == null ? nonTextEvent ? 0 : null : integer(row.cache_write_unreported_requests),
    observedTokens: row.cache_write_tokens == null ? null : integer(row.cache_write_tokens),
    knownCostAmount: row.cache_write_known_cost_amount == null ? null : numeric(row.cache_write_known_cost_amount)
  });
}

function cacheWriteColumnValues(cacheWrite) {
  return [
    cacheWrite.observedTokens, cacheWrite.knownCostAmount, cacheWrite.estimatedCostAmount, cacheWrite.requests,
    cacheWrite.observedRequests, cacheWrite.pricedRequests, cacheWrite.partialCostRequests,
    cacheWrite.unreportedRequests
  ];
}

function cacheWriteAggregateSql(fromEvents = false) {
  const unreported = fromEvents
    ? "cache_write_unreported_requests IS NULL AND event_type = 'usage' AND payload->>'source' IS DISTINCT FROM 'media'"
    : "cache_write_unreported_requests IS NULL";
  return CACHE_WRITE_COLUMNS.map(name => {
    if (name === "cache_write_unreported_requests") {
      return `CASE WHEN COUNT(*) FILTER (WHERE ${unreported}) > 0 THEN NULL ELSE COALESCE(SUM(${name}), 0) END AS ${name}`;
    }
    const sum = ["cache_write_tokens", "cache_write_known_cost_amount", "cache_write_estimated_cost_amount"].includes(name)
      ? `SUM(${name})` : `COALESCE(SUM(${name}), 0)`;
    return `${sum} AS ${name}`;
  }).join(",\n      ");
}

function buildAggregateNode(row) {
  return {
    requests: integer(row?.requests),
    errors: integer(row?.errors),
    blockedCount: integer(row?.blocked_count),
    warningCount: integer(row?.warning_count),
    promptTokens: integer(row?.prompt_tokens),
    completionTokens: integer(row?.completion_tokens),
    totalTokens: integer(row?.total_tokens),
    cachedTokens: integer(row?.cached_tokens),
    cacheWrite: cacheWriteFromRow(row || {}),
    textUnknownCostRequests: integer(row?.text_unknown_cost_requests),
    modelRouterCostAmount: numeric(row?.model_router_cost_amount),
    modelRouterCostCurrency: currencyValue(row?.model_router_cost_currency, row?.currency),
    actualModelCostAmount: numeric(row?.actual_model_cost_amount),
    actualModelCostCurrency: currencyValue(row?.actual_model_cost_currency, row?.currency),
    estimatedCostAmount: numeric(row?.estimated_cost_amount),
    estimatedCostCurrency: currencyValue(row?.estimated_cost_currency, row?.currency)
  };
}

function normalizeStatsFilters(options = {}) {
  const keyId = typeof options.keyId === "string" ? options.keyId.trim() : "";
  const requestedRange = typeof options.timeRange === "string" ? options.timeRange.trim().toLowerCase() : "all";
  const timeRange = Object.prototype.hasOwnProperty.call(STATS_TIME_RANGES, requestedRange) ? requestedRange : "all";
  return {
    keyId,
    timeRange,
    since: timeRange === "all" ? null : toIsoString(Date.now() - STATS_TIME_RANGES[timeRange])
  };
}

function buildEventFilterParts(filters, startIndex = 1, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const clauses = [`${prefix}event_type <> 'operation'`];
  const values = [];
  let paramIndex = startIndex;

  if (filters?.keyId) {
    clauses.push(`${prefix}key_id = $${paramIndex}`);
    values.push(filters.keyId);
    paramIndex += 1;
  }
  if (filters?.since) {
    clauses.push(`${prefix}occurred_at >= $${paramIndex}::timestamptz`);
    values.push(filters.since);
    paramIndex += 1;
  }
  if (filters?.modelsResetAt) {
    clauses.push(`COALESCE((${prefix}payload->>'modelStatsRecordedAt')::timestamptz, ${prefix}occurred_at) > $${paramIndex}::timestamptz`);
    values.push(filters.modelsResetAt);
    paramIndex += 1;
  }

  return {
    clauses,
    values,
    nextIndex: paramIndex
  };
}

function getDateTruncExpression(grain, columnName = "occurred_at") {
  const normalized = grain === "hourly" ? "hour" : grain === "weekly" ? "week" : "day";
  return `date_trunc('${normalized}', ${columnName} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

async function queryTotals(settings, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      MIN(bucket_start) AS started_at,
      COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(errors), 0) AS errors,
      COALESCE(SUM(blocked_count), 0) AS blocked_count,
      COALESCE(SUM(warning_count), 0) AS warning_count,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql()},
      COALESCE(SUM(model_router_cost_amount), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = 'daily' AND scope_type = 'global' AND scope_key = $1 AND scope_subkey = $2
  `, [GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_SUBKEY]);
  return result.rows[0] || null;
}

async function queryFilteredTotals(settings, filters, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters);
  const whereSql = filterParts.clauses.length ? `WHERE ${filterParts.clauses.join(" AND ")}` : "";
  const result = await pool.query(`
    SELECT
      MIN(occurred_at) FILTER (WHERE event_type = 'request') AS started_at,
      COUNT(*) FILTER (WHERE event_type = 'request') AS requests,
      COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
      COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocked_count,
      COUNT(*) FILTER (WHERE event_type = 'warning') AS warning_count,
      COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests) FILTER (WHERE event_type = 'usage'), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql(true)},
      COALESCE(SUM(model_router_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${eventsTableName}
    ${whereSql}
  `, filterParts.values);
  return result.rows[0] || null;
}

async function queryPerModel(settings, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      scope_key AS model_id,
      COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(errors), 0) AS errors,
      COALESCE(SUM(blocked_count), 0) AS blocked_count,
      COALESCE(SUM(warning_count), 0) AS warning_count,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql()},
      COALESCE(SUM(model_router_cost_amount), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = 'daily' AND scope_type = 'model' AND scope_key <> ''
    GROUP BY scope_key
    ORDER BY scope_key
  `);
  return result.rows;
}

async function queryFilteredPerModel(settings, filters, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters);
  const whereClauses = [...filterParts.clauses, "model_id <> ''"];
  const whereSql = `WHERE ${whereClauses.join(" AND ")}`;
  const result = await pool.query(`
    SELECT
      model_id,
      COUNT(*) FILTER (WHERE event_type = 'request') AS requests,
      COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
      COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocked_count,
      COUNT(*) FILTER (WHERE event_type = 'warning') AS warning_count,
      COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests) FILTER (WHERE event_type = 'usage'), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql(true)},
      COALESCE(SUM(model_router_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${eventsTableName}
    ${whereSql}
    GROUP BY model_id
    ORDER BY model_id
  `, filterParts.values);
  return result.rows;
}

async function queryPerActualModel(settings, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      scope_key AS model_id,
      scope_subkey AS actual_model_id,
      COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(errors), 0) AS errors,
      COALESCE(SUM(blocked_count), 0) AS blocked_count,
      COALESCE(SUM(warning_count), 0) AS warning_count,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql()},
      COALESCE(SUM(model_router_cost_amount), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = 'daily' AND scope_type = 'actual_model' AND scope_key <> '' AND scope_subkey <> ''
    GROUP BY scope_key, scope_subkey
    ORDER BY scope_key, scope_subkey
  `);
  return result.rows;
}

async function queryFilteredPerActualModel(settings, filters, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters);
  const whereClauses = [...filterParts.clauses, "model_id <> ''", "actual_model_id <> ''"];
  const whereSql = `WHERE ${whereClauses.join(" AND ")}`;
  const result = await pool.query(`
    SELECT
      model_id,
      actual_model_id,
      COUNT(*) FILTER (WHERE event_type = 'usage') AS requests,
      COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
      COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocked_count,
      COUNT(*) FILTER (WHERE event_type = 'warning') AS warning_count,
      COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests) FILTER (WHERE event_type = 'usage'), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql(true)},
      COALESCE(SUM(model_router_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${eventsTableName}
    ${whereSql}
    GROUP BY model_id, actual_model_id
    ORDER BY model_id, actual_model_id
  `, filterParts.values);
  return result.rows;
}

async function queryPerKey(settings, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      scope_key AS key_id,
      COALESCE(SUM(requests), 0) AS requests,
      COALESCE(SUM(errors), 0) AS errors,
      COALESCE(SUM(blocked_count), 0) AS blocked_count,
      COALESCE(SUM(warning_count), 0) AS warning_count,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql()},
      COALESCE(SUM(model_router_cost_amount), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = 'daily' AND scope_type = 'key' AND scope_key <> ''
    GROUP BY scope_key
    ORDER BY scope_key
  `);
  return result.rows;
}

async function queryBillingTiers(settings, filters, filtered, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName, rollupsTableName } = getQualifiedTableNames(settings);
  const filter = filtered ? buildEventFilterParts(filters) : { clauses: [], values: [] };
  const result = await pool.query(`
    SELECT ${filtered
    ? "model_id, actual_model_id, payload->'textCost'->'pricing'->'actual' AS pricing_audit, COUNT(*) AS requests"
    : "scope_key AS model_id, scope_subkey AS tier_key, SUM(requests) AS requests"},
      ${["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "text_unknown_cost_requests",
        "estimated_cost_amount", "model_router_cost_amount", "actual_model_cost_amount"].map(name => `COALESCE(SUM(${name}), 0) AS ${name}`).join(",\n      ")},
      ${cacheWriteAggregateSql(filtered)},
      MAX(currency) AS currency
    FROM ${schemaName}.${filtered ? eventsTableName : rollupsTableName}
    WHERE ${filtered ? "event_type = 'usage' AND model_id <> ''" : "grain = 'daily' AND scope_type = 'billing_tier'"}
      ${filter.clauses.length ? `AND ${filter.clauses.join(" AND ")}` : ""}
    GROUP BY ${filtered ? "model_id, actual_model_id, pricing_audit" : "scope_key, scope_subkey"}
  `, filter.values);
  return result.rows.map(row => ({
    ...row,
    identity: filtered ? billingTierIdentity(row.model_id, row.actual_model_id, row.pricing_audit) : billingTierFromKey(row.tier_key)
  })).filter(row => row.identity);
}

async function queryChannelDetails(settings, filters, filtered, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName, rollupsTableName } = getQualifiedTableNames(settings);
  const { clauses, values } = filtered ? buildEventFilterParts(filters) : { clauses: [], values: [] };
  const fields = filtered ? `model_id, event_type, route_key, backend_route_key, actual_model_id,
    payload->>'reportedModelName' AS reported_model,
    payload->>'canonicalModelId' AS canonical, payload->>'channelId' AS channel, payload->>'sourceModelId' AS source_model,
    payload->>'usageSource' AS usage_source, payload->'textCost'->'pricing'->'actual' AS audit,
    COALESCE(payload->'media'->>'costStatus', payload->'textCost'->>'costStatus') AS cost_status,
    payload->'media'->'knownCostAmounts' AS media_costs, payload ? 'media' AS is_media, currency`
    // Read-only dashboards may reach an old schema before the first writer migrates it.
    : "to_jsonb(r)->'channel_detail' AS binding_data";
  const result = await pool.query(`
    SELECT ${fields}, ${filtered ? "COUNT(*)" : "SUM(requests + errors + COALESCE((to_jsonb(r)->>'channel_settlements')::bigint, 0))"} AS event_count,
      ${["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "text_unknown_cost_requests",
        "estimated_cost_amount"].map(key => `SUM(${key}) AS ${key}`).join(", ")},
      ${cacheWriteAggregateSql(filtered)}
    FROM ${schemaName}.${filtered ? eventsTableName : rollupsTableName} AS r
    WHERE ${filtered ? "event_type IN ('request','error','usage') AND model_id <> ''" : "grain = 'daily' AND scope_type IN ('channel_detail','channel_currency')"}
      ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
    GROUP BY ${filtered ? `model_id, event_type, route_key, backend_route_key, actual_model_id, canonical, channel,
      source_model, reported_model, usage_source, audit, cost_status, media_costs, is_media, currency` : "binding_data"}
  `, values);
  const details = new Map();
  for (const row of result.rows) {
    const [phase, identity, mediaCurrency] = filtered
      ? [row.event_type, channelIdentity(row.model_id, {
        canonicalModelId: row.canonical, channelId: row.channel, sourceModelId: row.source_model,
        routeKey: row.route_key, backendRouteKey: row.backend_route_key, actualModelName: row.actual_model_id,
        usageSource: row.usage_source, reportedModelName: row.reported_model
      }, row.event_type, row.audit, row.cost_status, row.is_media ? null : row.currency)]
      : row.binding_data;
    if (phase === "media_cost") {
      accumulateChannelDetail(details, identity, { knownCostAmounts: { [mediaCurrency]: numeric(row.estimated_cost_amount) } });
      continue;
    }
    const count = integer(row.event_count);
    const metric = channelMetric(phase, count, buildAggregateNode(row), identity);
    if (row.is_media) metric.knownCostAmounts = Object.fromEntries(Object.entries(row.media_costs || {})
      .map(([currency, amount]) => [currency, numeric(amount) * count]));
    accumulateChannelDetail(details, identity, metric);
  }
  return [...details.values()];
}

async function queryFilteredPerKey(settings, filters, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters);
  const whereClauses = [...filterParts.clauses, "key_id <> ''"];
  const whereSql = `WHERE ${whereClauses.join(" AND ")}`;
  const result = await pool.query(`
    SELECT
      key_id,
      COUNT(*) FILTER (WHERE event_type = 'request') AS requests,
      COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
      COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocked_count,
      COUNT(*) FILTER (WHERE event_type = 'warning') AS warning_count,
      COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests) FILTER (WHERE event_type = 'usage'), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql(true)},
      COALESCE(SUM(model_router_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND model_router_cost_amount > 0) AS model_router_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND actual_model_cost_amount > 0) AS actual_model_cost_currency,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND estimated_cost_amount > 0) AS estimated_cost_currency
    FROM ${schemaName}.${eventsTableName}
    ${whereSql}
    GROUP BY key_id
    ORDER BY key_id
  `, filterParts.values);
  return result.rows;
}

async function queryRollupSeries(settings, grain, limit, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      bucket_start,
      requests,
      errors,
      blocked_count,
      warning_count,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      cached_tokens,
      text_unknown_cost_requests,
      ${CACHE_WRITE_COLUMNS.join(", ")},
      estimated_cost_amount,
      model_router_cost_amount,
      actual_model_cost_amount,
      currency
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = $1 AND scope_type = 'global' AND scope_key = $2 AND scope_subkey = $3
    ORDER BY bucket_start DESC
    LIMIT $4
  `, [grain, GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_SUBKEY, limit]);
  return result.rows.reverse().map((row) => ({
    bucketStart: row.bucket_start instanceof Date ? row.bucket_start.toISOString() : String(row.bucket_start || ""),
    ...buildAggregateNode(row)
  }));
}

async function queryFilteredRollupSeries(settings, filters, grain, limit, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters);
  const whereSql = filterParts.clauses.length ? `WHERE ${filterParts.clauses.join(" AND ")}` : "";
  const bucketExpr = getDateTruncExpression(grain, "occurred_at");
  const values = [...filterParts.values, limit];
  const result = await pool.query(`
    SELECT
      ${bucketExpr} AS bucket_start,
      COUNT(*) FILTER (WHERE event_type = 'request') AS requests,
      COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
      COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocked_count,
      COUNT(*) FILTER (WHERE event_type = 'warning') AS warning_count,
      COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS completion_tokens,
      COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS total_tokens,
      COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS cached_tokens,
      COALESCE(SUM(text_unknown_cost_requests) FILTER (WHERE event_type = 'usage'), 0) AS text_unknown_cost_requests,
      ${cacheWriteAggregateSql(true)},
      COALESCE(SUM(model_router_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS model_router_cost_amount,
      COALESCE(SUM(actual_model_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS actual_model_cost_amount,
      COALESCE(SUM(estimated_cost_amount) FILTER (WHERE event_type = 'usage'), 0) AS estimated_cost_amount,
      MAX(currency) FILTER (WHERE event_type = 'usage' AND estimated_cost_amount > 0) AS currency
    FROM ${schemaName}.${eventsTableName}
    ${whereSql}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT $${filterParts.nextIndex}
  `, values);
  return result.rows.reverse().map((row) => ({
    bucketStart: row.bucket_start instanceof Date ? row.bucket_start.toISOString() : String(row.bucket_start || ""),
    ...buildAggregateNode(row)
  }));
}

async function queryTopSignalScopes(settings, scopeType, countColumn, limit = 8, pool = getRuntimeStorePool(settings)) {
  const { schemaName, rollupsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      scope_key,
      COALESCE(SUM(${countColumn}), 0) AS count,
      MAX(last_occurred_at) AS last_occurred_at
    FROM ${schemaName}.${rollupsTableName}
    WHERE grain = 'daily' AND scope_type = $1 AND scope_key <> ''
    GROUP BY scope_key
    HAVING COALESCE(SUM(${countColumn}), 0) > 0
    ORDER BY count DESC, scope_key ASC
    LIMIT $2
  `, [scopeType, limit]);
  return result.rows.map((row) => ({
    name: String(row.scope_key || ""),
    count: integer(row.count),
    lastOccurredAt: row.last_occurred_at instanceof Date ? row.last_occurred_at.toISOString() : String(row.last_occurred_at || "")
  }));
}

async function queryFilteredTopSignalScopes(settings, filters, eventType, valueColumn, limit = 8, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters, 2);
  const whereClauses = [`event_type = $1`, `${valueColumn} <> ''`, ...filterParts.clauses];
  const result = await pool.query(`
    SELECT
      ${valueColumn} AS name,
      COUNT(*) AS count,
      MAX(occurred_at) AS last_occurred_at
    FROM ${schemaName}.${eventsTableName}
    WHERE ${whereClauses.join(" AND ")}
    GROUP BY ${valueColumn}
    ORDER BY count DESC, ${valueColumn} ASC
    LIMIT $${filterParts.nextIndex}
  `, [eventType, ...filterParts.values, limit]);
  return result.rows.map((row) => ({
    name: String(row.name || ""),
    count: integer(row.count),
    lastOccurredAt: row.last_occurred_at instanceof Date ? row.last_occurred_at.toISOString() : String(row.last_occurred_at || "")
  }));
}

async function queryRecentSignals(settings, eventType, limit = 12, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(`
    SELECT
      occurred_at,
      request_id,
      key_id,
      model_id,
      actual_model_id,
      route_key,
      backend_route_key,
      blocked_reason,
      signal_name,
      currency,
      payload
    FROM ${schemaName}.${eventsTableName}
    WHERE event_type = $1
    ORDER BY occurred_at DESC
    LIMIT $2
  `, [eventType, limit]);
  return result.rows.map((row) => ({
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at || ""),
    requestId: String(row.request_id || ""),
    keyId: String(row.key_id || ""),
    modelId: String(row.model_id || ""),
    actualModelId: String(row.actual_model_id || ""),
    routeKey: String(row.route_key || ""),
    backendRouteKey: String(row.backend_route_key || ""),
    blockedReason: String(row.blocked_reason || ""),
    signalName: String(row.signal_name || ""),
    currency: String(row.currency || "USD"),
    payload: asPlainObject(row.payload)
  }));
}

async function queryFilteredRecentSignals(settings, filters, eventType, limit = 12, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filterParts = buildEventFilterParts(filters, 2);
  const whereClauses = [`event_type = $1`, ...filterParts.clauses];
  const result = await pool.query(`
    SELECT
      occurred_at,
      request_id,
      key_id,
      model_id,
      actual_model_id,
      route_key,
      backend_route_key,
      blocked_reason,
      signal_name,
      currency,
      payload
    FROM ${schemaName}.${eventsTableName}
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY occurred_at DESC
    LIMIT $${filterParts.nextIndex}
  `, [eventType, ...filterParts.values, limit]);
  return result.rows.map((row) => ({
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at || ""),
    requestId: String(row.request_id || ""),
    keyId: String(row.key_id || ""),
    modelId: String(row.model_id || ""),
    actualModelId: String(row.actual_model_id || ""),
    routeKey: String(row.route_key || ""),
    backendRouteKey: String(row.backend_route_key || ""),
    blockedReason: String(row.blocked_reason || ""),
    signalName: String(row.signal_name || ""),
    currency: String(row.currency || "USD"),
    payload: asPlainObject(row.payload)
  }));
}

async function queryMediaAggregates(settings, filters, modelsResetAt, pool = getRuntimeStorePool(settings)) {
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const filter = buildEventFilterParts(filters);
  const resetCondition = modelsResetAt
    ? ` WHERE model_recorded_at > $${filter.values.push(modelsResetAt)}::timestamptz` : "";
  const result = await pool.query(`
    WITH media_events AS (
      SELECT model_id, key_id, payload->'media' AS media,
        COALESCE((payload->>'modelStatsRecordedAt')::timestamptz, occurred_at) AS model_recorded_at
      FROM ${schemaName}.${eventsTableName}
      WHERE event_type = 'usage' AND payload->>'source' = 'media'
      ${filter.clauses.length ? `AND ${filter.clauses.join(" AND ")}` : ""}
    ), scoped AS (
      SELECT 'total' AS scope_type, '' AS scope_key, media FROM media_events
      UNION ALL SELECT 'model', model_id, media FROM media_events${resetCondition}
      UNION ALL SELECT 'key', key_id, media FROM media_events
    ), counts AS (
      SELECT scope_type, scope_key, COUNT(*) AS requests,
        COUNT(*) FILTER (WHERE media->>'usageStatus' = 'observed') AS observed_requests,
        COUNT(*) FILTER (WHERE media->>'usageStatus' IS DISTINCT FROM 'observed') AS unknown_usage_requests,
        COUNT(*) FILTER (WHERE media->>'costStatus' IS DISTINCT FROM 'priced') AS unknown_cost_requests
      FROM scoped GROUP BY scope_type, scope_key
    ), counter_sums AS (
      SELECT scope_type, scope_key, counter.key, SUM(counter.value::numeric) AS value
      FROM scoped CROSS JOIN LATERAL jsonb_each_text(COALESCE(media->'counters', '{}'::jsonb)) counter
      GROUP BY scope_type, scope_key, counter.key
    ), counters AS (
      SELECT scope_type, scope_key, jsonb_object_agg(key, value) AS values
      FROM counter_sums GROUP BY scope_type, scope_key
    ), cost_sums AS (
      SELECT scope_type, scope_key, cost.key, SUM(cost.value::numeric) AS value
      FROM scoped CROSS JOIN LATERAL jsonb_each_text(COALESCE(media->'knownCostAmounts', '{}'::jsonb)) cost
      GROUP BY scope_type, scope_key, cost.key
    ), costs AS (
      SELECT scope_type, scope_key, jsonb_object_agg(key, value) AS values
      FROM cost_sums GROUP BY scope_type, scope_key
    )
    SELECT counts.*, counters.values AS counters, costs.values AS cost_amounts
    FROM counts LEFT JOIN counters USING (scope_type, scope_key) LEFT JOIN costs USING (scope_type, scope_key)
  `, filter.values);
  return result.rows;
}

export function getRuntimeStatsSnapshot(config, fallbackStats = null, options = {}) {
  if (options.readOnly) return readRuntimeStatsSnapshot(config, fallbackStats, options);
  return serializeDatabaseOperation(() => getRuntimeStatsSnapshotInternal(config, fallbackStats, options));
}

function memoryStatsFallback(fallbackStats, options, snapshot) {
  const { keyId, timeRange, since } = normalizeStatsFilters(options);
  return { ...fallbackStats, ...getMemoryChannelStats({ keyId, since }), canonicalFilters: { keyId, timeRange }, snapshot };
}

async function readRuntimeStatsSnapshot(config, fallbackStats, options) {
  const settings = resolveRuntimeStoreSettings(config);
  const generation = modelStatsGeneration;
  if (!settings.configured) return memoryStatsFallback(fallbackStats, options,
    { source: "memory", capturedAt: toIsoString(), partial: settings.enabled });
  try {
    const result = await withRuntimeReadSnapshot(settings, async client => {
      const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
      const metadata = await client.query(`SELECT transaction_timestamp() AS captured_at, MAX(event_id) AS last_event_id FROM ${schemaName}.${eventsTableName}`);
      const rolledEventId = Number(await getMetaValue(settings, META_LAST_ROLLED_EVENT_ID, client)) || 0;
      const pendingEvents = runtimeEventQueue.length + runtimeStoreState.persistedEventCount;
      const snapshot = {
        source: "database",
        capturedAt: toIsoString(metadata.rows[0].captured_at),
        pendingEvents,
        lastRolledEventId: rolledEventId,
        partial: pendingEvents > 0 || runtimeStoreState.flushing || Number(metadata.rows[0].last_event_id) > rolledEventId
      };
      return { ...await getRuntimeStatsSnapshotInternal(config, fallbackStats, { ...options, client }), snapshot };
    });
    if (generation !== modelStatsGeneration) {
      throw Object.assign(new Error("Model statistics changed during this snapshot; refresh again."), { code: "RUNTIME_STATS_SNAPSHOT_STALE" });
    }
    return result;
  } catch (error) {
    appendStructuredLog("warn", {
      source: "runtime-store", event: "runtime_store.stats_query_failed",
      failureReason: error.message
    });
    if (error.code === "RUNTIME_STATS_SNAPSHOT_STALE" || generation !== modelStatsGeneration) throw error;
    return memoryStatsFallback(fallbackStats, options,
      { source: "memory", capturedAt: toIsoString(), partial: true, error: snapshotError(error) });
  }
}

async function getRuntimeStatsSnapshotInternal(config, fallbackStats, options) {
  const settings = resolveRuntimeStoreSettings(config);
  if (!settings.configured) {
    return memoryStatsFallback(fallbackStats, options, { source: "memory", capturedAt: toIsoString(), partial: settings.enabled });
  }

  try {
    if (!options.readOnly) {
      await flushRuntimeEventsInternal();
      await ensureRuntimeTables(settings);
      await rollupRuntimeEvents(settings);
      await cleanupRuntimeData(settings);
    }

    const filters = normalizeStatsFilters(options);
    const client = options.client;
    const modelsResetAt = await getMetaValue(settings, META_MODELS_RESET_AT, client);
    const modelFilters = { ...filters, modelsResetAt };
    const useFilteredQueryPath = !!filters.keyId || !!filters.since;

    const queries = [
      () => useFilteredQueryPath ? queryFilteredTotals(settings, filters, client) : queryTotals(settings, client),
      () => useFilteredQueryPath ? queryFilteredPerModel(settings, modelFilters, client) : queryPerModel(settings, client),
      () => useFilteredQueryPath ? queryFilteredPerActualModel(settings, modelFilters, client) : queryPerActualModel(settings, client),
      () => useFilteredQueryPath ? queryFilteredPerKey(settings, filters, client) : queryPerKey(settings, client),
      () => useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "hourly", 24, client) : queryRollupSeries(settings, "hourly", 24, client),
      () => useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "daily", 30, client) : queryRollupSeries(settings, "daily", 30, client),
      () => useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "weekly", 12, client) : queryRollupSeries(settings, "weekly", 12, client),
      () => useFilteredQueryPath ? queryFilteredTopSignalScopes(settings, filters, "blocked", "blocked_reason", 10, client) : queryTopSignalScopes(settings, "blocked_reason", "blocked_count", 10, client),
      () => useFilteredQueryPath ? queryFilteredTopSignalScopes(settings, filters, "warning", "signal_name", 10, client) : queryTopSignalScopes(settings, "warning_event", "warning_count", 10, client),
      () => useFilteredQueryPath ? queryFilteredRecentSignals(settings, filters, "blocked", 12, client) : queryRecentSignals(settings, "blocked", 12, client),
      () => useFilteredQueryPath ? queryFilteredRecentSignals(settings, filters, "warning", 12, client) : queryRecentSignals(settings, "warning", 12, client),
      () => queryMediaAggregates(settings, filters, modelsResetAt, client),
      () => queryBillingTiers(settings, modelFilters, useFilteredQueryPath, client),
      () => queryChannelDetails(settings, modelFilters, useFilteredQueryPath, client)
    ];
    const rows = [];
    if (client) {
      for (const query of queries) rows.push(await query());
    } else {
      rows.push(...await Promise.all(queries.map(query => query())));
    }
    const [
      totalsRow,
      perModelRows,
      perActualModelRows,
      perKeyRows,
      hourlyRollups,
      dailyRollups,
      weeklyRollups,
      blockedReasons,
      warningEvents,
      recentBlocked,
      recentWarnings,
      mediaRows,
      billingTierRows,
      channelDetails
    ] = rows;

    const snapshot = {
      startedAt: totalsRow?.started_at ? new Date(totalsRow.started_at).toISOString() : (fallbackStats?.startedAt || toIsoString()),
      ...(modelsResetAt ? { modelsResetAt } : {}),
      totals: buildAggregateNode(totalsRow),
      perModel: {},
      perKey: {},
      analytics: {
        rollups: {
          hourly: hourlyRollups,
          daily: dailyRollups,
          weekly: weeklyRollups
        },
        blockedReasons,
        warningEvents
      },
      recent: {
        blocked: recentBlocked,
        warnings: recentWarnings
      },
      filters: {
        keyId: filters.keyId,
        timeRange: filters.timeRange
      }
    };

    for (const row of perModelRows) {
      snapshot.perModel[row.model_id] = {
        ...buildAggregateNode(row),
        actualModels: {},
        billingTiers: []
      };
    }

    for (const row of perActualModelRows) {
      if (!snapshot.perModel[row.model_id]) {
        snapshot.perModel[row.model_id] = {
          ...buildAggregateNode({}),
          actualModels: {},
          billingTiers: []
        };
      }
      snapshot.perModel[row.model_id].actualModels[row.actual_model_id] = buildAggregateNode(row);
    }
    for (const row of billingTierRows) {
      const model = snapshot.perModel[row.model_id];
      if (model) model.billingTiers.push({ ...buildAggregateNode(row), ...row.identity });
    }
    for (const [modelId, model] of Object.entries(snapshot.perModel)) reconcileBillingTiers(modelId, model);
    snapshot.canonicalModels = useFilteredQueryPath ? channelTree(channelDetails) : reconcileChannelHistory(channelDetails, snapshot.perModel);
    snapshot.canonicalFilters = snapshot.filters;
    if (useFilteredQueryPath) snapshot.canonicalDetailRetentionDays = settings.detailRetentionDays;

    for (const row of perKeyRows) {
      snapshot.perKey[row.key_id] = buildAggregateNode(row);
    }

    for (const row of mediaRows) {
      const costAmounts = asPlainObject(row.cost_amounts);
      const currencies = Object.keys(costAmounts);
      const bucket = row.scope_type === "total" ? snapshot.totals
        : row.scope_type === "model" ? (snapshot.perModel[row.scope_key] ||= { ...buildAggregateNode({}), actualModels: {}, billingTiers: [] })
          : (snapshot.perKey[row.scope_key] ||= buildAggregateNode({}));
      bucket.media = { requests: numeric(row.requests), observedRequests: numeric(row.observed_requests),
        unknownUsageRequests: numeric(row.unknown_usage_requests), unknownCostRequests: numeric(row.unknown_cost_requests),
        counters: asPlainObject(row.counters), costAmounts,
        estimatedCostAmount: numeric(row.unknown_cost_requests) === 0 && currencies.length === 1 ? costAmounts[currencies[0]] : null,
        currency: currencies.length === 1 ? currencies[0] : null, detailRetentionDays: settings.detailRetentionDays };
    }

    return snapshot;
  } catch (error) {
    if (options.readOnly) throw error;
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.stats_query_failed",
      failureReason: error?.message || "Runtime stats query failed"
    });
    return memoryStatsFallback(fallbackStats, options, { source: "memory", capturedAt: toIsoString(), partial: true, error: snapshotError(error) });
  }
}

export function hydrateGovernanceRuntime(config, keyId, rateWindowStartedAt, budgetWindowStartedAt, options = {}) {
  return hydrateGovernanceRuntimes(config, [{
    keyId,
    rateWindowStartedAt,
    budgetWindowStartedAt,
    onSnapshot: options.onSnapshot
  }]).then((persisted) => persisted.get(keyId) || null);
}

export function hydrateGovernanceRuntimes(config, keyWindows) {
  return serializeDatabaseOperation(() => hydrateGovernanceRuntimesInternal(config, keyWindows));
}

export async function readGovernanceRuntimes(config, keyWindows) {
  const settings = resolveRuntimeStoreSettings(config);
  if (!settings.enabled || keyWindows.length === 0) return new Map();
  try {
    if (!settings.configured) throw new Error("Runtime governance storage is not configured");
    return await withRuntimeReadSnapshot(settings, client => queryGovernanceRuntimes(settings, keyWindows, client));
  } catch (error) {
    appendStructuredLog("warn", {
      source: "runtime-store", event: "runtime_store.governance_snapshot_failed",
      failureReason: error.message
    });
    throw error;
  }
}

async function hydrateGovernanceRuntimesInternal(config, keyWindows) {
  const persistedByKey = new Map();
  if (!Array.isArray(keyWindows) || keyWindows.length === 0) return persistedByKey;
  const settings = resolveRuntimeStoreSettings(config);
  if (!settings.enabled) return persistedByKey;
  const targetsByKey = new Map();
  for (const item of keyWindows) {
    if (item?.keyId && !targetsByKey.has(item.keyId)) targetsByKey.set(item.keyId, item);
  }
  const targets = [...targetsByKey.values()];
  if (targets.length === 0) return persistedByKey;

  try {
    if (!settings.configured) throw new Error("Runtime governance storage is not configured");
    // Drain the backlog present at entry; do not wait indefinitely for new
    // traffic. If it keeps growing, defer admission instead of loading a partial
    // balance and marking it hydrated.
    await localBufferOperation;
    const pending = runtimeEventQueue.length + runtimeStoreState.persistedEventCount;
    for (let flushed = 0; flushed < pending;) {
      const result = await flushRuntimeEventsInternal();
      if (result.error) throw result.error;
      if (!result.flushed) break;
      flushed += result.flushed;
    }
    if (runtimeEventQueue.length || runtimeStoreState.persistedEventCount) {
      throw new Error("Runtime event backlog is not yet persisted");
    }
    await ensureRuntimeTables(settings);
    await rollupRuntimeEvents(settings);
    await localBufferOperation;
    if (runtimeEventQueue.length || runtimeStoreState.persistedEventCount) {
      throw new Error("Runtime event backlog changed during hydration");
    }
    for (const target of targets) target.onSnapshot?.();

    return await queryGovernanceRuntimes(settings, targets);
  } catch (error) {
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.governance_hydrate_failed",
      keyIds: targets.map((item) => item.keyId),
      failureReason: error?.message || "Runtime governance hydrate failed"
    });
    throw error;
  }
}

async function queryGovernanceRuntimes(settings, targets, pool = getRuntimeStorePool(settings)) {
    const { schemaName, eventsTableName, rollupsTableName } = getQualifiedTableNames(settings);
    const result = await pool.query(`
      WITH targets AS (
        SELECT key_id, rate_window_started_at, budget_window_started_at
        FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[])
          AS requested(key_id, rate_window_started_at, budget_window_started_at)
      ),
      latest_block AS (
        SELECT DISTINCT ON (events.key_id)
          events.key_id, events.occurred_at, events.blocked_reason
        FROM ${schemaName}.${eventsTableName} AS events
        JOIN targets ON targets.key_id = events.key_id
        WHERE events.event_type = 'blocked'
        ORDER BY events.key_id, events.occurred_at DESC
      ),
      rate_window AS (
        SELECT
          events.key_id,
          COUNT(*) FILTER (WHERE events.event_type = 'request') AS rate_requests,
          COALESCE(SUM(events.prompt_tokens) FILTER (WHERE events.event_type = 'usage'), 0) AS rate_prompt_tokens,
          COALESCE(SUM(events.completion_tokens) FILTER (WHERE events.event_type = 'usage'), 0) AS rate_completion_tokens,
          COALESCE(SUM(events.total_tokens) FILTER (WHERE events.event_type = 'usage'), 0) AS rate_total_tokens,
          COALESCE(SUM(events.cached_tokens) FILTER (WHERE events.event_type = 'usage'), 0) AS rate_cached_tokens,
          COUNT(*) FILTER (WHERE events.event_type = 'blocked') AS rate_blocked_requests
        FROM ${schemaName}.${eventsTableName} AS events
        JOIN targets ON targets.key_id = events.key_id
          AND events.occurred_at >= targets.rate_window_started_at
          AND events.event_type <> 'operation'
        GROUP BY events.key_id
      ),
      key_totals AS (
        SELECT
          rollups.scope_key AS key_id,
          MAX(rollups.last_occurred_at) AS last_seen_at,
          COALESCE(SUM(rollups.requests), 0) AS total_requests,
          COALESCE(SUM(rollups.errors), 0) AS total_errors,
          COALESCE(SUM(rollups.blocked_count), 0) AS total_blocked_requests
        FROM ${schemaName}.${rollupsTableName} AS rollups
        JOIN targets ON targets.key_id = rollups.scope_key
        WHERE rollups.grain = 'daily' AND rollups.scope_type = 'key'
        GROUP BY rollups.scope_key
      ),
      budget_window AS (
        SELECT
          rollups.scope_key AS key_id,
          COALESCE(SUM(rollups.prompt_tokens), 0) AS budget_prompt_tokens,
          COALESCE(SUM(rollups.completion_tokens), 0) AS budget_completion_tokens,
          COALESCE(SUM(rollups.total_tokens), 0) AS budget_total_tokens,
          COALESCE(SUM(rollups.cached_tokens), 0) AS budget_cached_tokens,
          COALESCE(SUM(rollups.text_unknown_cost_requests), 0) AS budget_text_unknown_cost_requests,
          COALESCE(SUM(rollups.estimated_cost_amount), 0) AS budget_spent_amount,
          COALESCE(SUM(rollups.blocked_count), 0) AS budget_blocked_requests
        FROM ${schemaName}.${rollupsTableName} AS rollups
        JOIN targets ON targets.key_id = rollups.scope_key
          AND rollups.bucket_start >= targets.budget_window_started_at
        WHERE rollups.grain = 'daily' AND rollups.scope_type = 'key'
        GROUP BY rollups.scope_key
      ),
      budget_requests AS (
        SELECT
          events.key_id,
          COUNT(*) FILTER (WHERE events.event_type = 'usage') AS budget_requests,
          COUNT(*) FILTER (WHERE events.event_type = 'usage' AND events.payload->>'source' = 'media'
            AND events.payload->'media'->>'costStatus' IS DISTINCT FROM 'priced') AS budget_media_unknown_cost_requests
        FROM ${schemaName}.${eventsTableName} AS events
        JOIN targets ON targets.key_id = events.key_id
          AND events.occurred_at >= targets.budget_window_started_at
          AND events.event_type = 'usage'
        GROUP BY events.key_id
      )
      SELECT
        targets.key_id,
        key_totals.last_seen_at,
        COALESCE(key_totals.total_requests, 0) AS total_requests,
        COALESCE(key_totals.total_errors, 0) AS total_errors,
        COALESCE(key_totals.total_blocked_requests, 0) AS total_blocked_requests,
        latest_block.occurred_at AS last_blocked_at,
        latest_block.blocked_reason AS last_blocked_reason,
        COALESCE(rate_window.rate_requests, 0) AS rate_requests,
        COALESCE(rate_window.rate_prompt_tokens, 0) AS rate_prompt_tokens,
        COALESCE(rate_window.rate_completion_tokens, 0) AS rate_completion_tokens,
        COALESCE(rate_window.rate_total_tokens, 0) AS rate_total_tokens,
        COALESCE(rate_window.rate_cached_tokens, 0) AS rate_cached_tokens,
        COALESCE(rate_window.rate_blocked_requests, 0) AS rate_blocked_requests,
        COALESCE(budget_requests.budget_requests, 0) AS budget_requests,
        COALESCE(budget_requests.budget_media_unknown_cost_requests, 0) AS budget_media_unknown_cost_requests,
        COALESCE(budget_window.budget_text_unknown_cost_requests, 0) AS budget_text_unknown_cost_requests,
        COALESCE(budget_window.budget_prompt_tokens, 0) AS budget_prompt_tokens,
        COALESCE(budget_window.budget_completion_tokens, 0) AS budget_completion_tokens,
        COALESCE(budget_window.budget_total_tokens, 0) AS budget_total_tokens,
        COALESCE(budget_window.budget_cached_tokens, 0) AS budget_cached_tokens,
        COALESCE(budget_window.budget_spent_amount, 0) AS budget_spent_amount,
        COALESCE(budget_window.budget_blocked_requests, 0) AS budget_blocked_requests
      FROM targets
      LEFT JOIN key_totals USING (key_id)
      LEFT JOIN latest_block USING (key_id)
      LEFT JOIN rate_window USING (key_id)
      LEFT JOIN budget_window USING (key_id)
      LEFT JOIN budget_requests USING (key_id)
    `, [
      targets.map((item) => item.keyId),
      targets.map((item) => item.rateWindowStartedAt),
      targets.map((item) => item.budgetWindowStartedAt)
    ]);

    const persisted = new Map(result.rows.map((row) => [row.key_id, row]));
    if (targets.some((target) => !persisted.has(target.keyId))) {
      throw new Error("Runtime governance hydration returned an incomplete snapshot");
    }
    return persisted;
}
