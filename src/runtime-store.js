import { appendStructuredLog } from "./logs.js";
import { buildPostgresPoolOptions, getSharedPostgresPool, quoteIdentifier } from "./postgres.js";

const DEFAULT_DATABASE_SCHEMA = "public";
const DEFAULT_RUNTIME_EVENTS_TABLE_NAME = "runtime_events";
const DEFAULT_RUNTIME_ROLLUPS_TABLE_NAME = "runtime_rollups";
const DEFAULT_RUNTIME_META_TABLE_NAME = "runtime_store_meta";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 5000;
const DEFAULT_DETAIL_RETENTION_DAYS = 30;
const DEFAULT_ROLLUP_RETENTION_DAYS = 365;
const DEFAULT_ROLLUP_BATCH_SIZE = 5000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const GLOBAL_SCOPE_KEY = "__all__";
const GLOBAL_SCOPE_SUBKEY = "";
const ROLLUP_GRAINS = ["hourly", "daily", "weekly"];
const META_LAST_ROLLED_EVENT_ID = "last_rolled_event_id";
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

const runtimeStoreState = {
  enabled: false,
  configured: false,
  queueLength: 0,
  flushFailures: 0,
  rollupFailures: 0,
  droppedEvents: 0,
  lastSuccessTs: "",
  lastRollupTs: "",
  lastRolledEventId: 0,
  lastError: null,
  flushing: false
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

function normalizeMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (["database", "db", "postgres", "postgresql"].includes(normalized)) return "database";
  if (["blob", "azureblob"].includes(normalized)) return "blob";
  return "file";
}

function resolveRuntimeStoreSettings(config = runtimeStoreConfig) {
  const observability = asPlainObject(config?.observability);
  const runtimeStore = asPlainObject(observability.runtimeStore);
  const audit = asPlainObject(observability.audit);
  const persistence = asPlainObject(config?.persistence);
  const configStore = asPlainObject(persistence.configStore);
  const database = asPlainObject(configStore.database);
  const requestedMode = normalizeMode(getEnvOverride("PERSISTENCE_MODE", "CONFIG_PERSISTENCE_MODE") || configStore.mode);
  const connectionRef = getEnvOverride("RUNTIME_DB_CONNECTION_REF") || String(runtimeStore.connectionRef || database.connectionRef || "").trim();
  const connectionString = getEnvOverride("RUNTIME_DB_CONNECTION_STRING", "CONFIG_DB_CONNECTION_STRING", "DATABASE_URL")
    || (connectionRef ? getEnvOverride(connectionRef) : "");
  const enabled = runtimeStore.enabled !== false && requestedMode === "database";
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
    poolOptions: buildPostgresPoolOptions({
      connectionString,
      pool: database.pool
    })
  };
}

function getRuntimeStorePool(settings) {
  if (!settings.configured) {
    throw new Error("Runtime store requires PostgreSQL connection when database mode is enabled");
  }
  return getSharedPostgresPool(settings.poolOptions);
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
      estimated_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      model_router_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      actual_model_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`ALTER TABLE ${schemaName}.${eventsTableName} ADD COLUMN IF NOT EXISTS signal_name TEXT NOT NULL DEFAULT ''`);
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
      estimated_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      model_router_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      actual_model_cost_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      last_occurred_at TIMESTAMPTZ,
      PRIMARY KEY (grain, bucket_start, scope_type, scope_key, scope_subkey)
    )
  `);
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

function scheduleFlush(settings) {
  if (!settings.configured || runtimeEventQueue.length === 0 || flushRunning || flushTimer) {
    return;
  }
  const delay = runtimeEventQueue.length >= settings.batchSize ? 0 : settings.flushIntervalMs;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushRuntimeEvents();
  }, delay);
}

function buildEventRow(eventType, fields = {}) {
  return {
    eventType,
    signalName: String(fields.signalName || fields.eventName || fields.event || "").trim(),
    requestId: String(fields.requestId || "").trim() || null,
    occurredAt: typeof fields.occurredAt === "string" && fields.occurredAt ? fields.occurredAt : toIsoString(),
    keyId: String(fields.keyId || "anonymous").trim() || "anonymous",
    modelId: String(fields.modelId || "").trim(),
    actualModelId: String(fields.actualModelName || fields.actualModelId || "").trim(),
    routeKey: String(fields.routeKey || "").trim(),
    backendRouteKey: String(fields.backendRouteKey || "").trim(),
    blockedReason: String(fields.blockedReason || "").trim(),
    promptTokens: resolveInt(fields.promptTokens, 0, 0),
    completionTokens: resolveInt(fields.completionTokens, 0, 0),
    totalTokens: resolveInt(fields.totalTokens, 0, 0),
    cachedTokens: resolveInt(fields.cachedTokens, 0, 0),
    estimatedCostAmount: resolveFloat(fields.estimatedCostAmount, 0, 0),
    modelRouterCostAmount: resolveFloat(fields.modelRouterCostAmount, 0, 0),
    actualModelCostAmount: resolveFloat(fields.actualModelCostAmount, 0, 0),
    currency: String(fields.currency || "USD").trim() || "USD",
    payload: fields.payload && typeof fields.payload === "object" && !Array.isArray(fields.payload)
      ? fields.payload
      : {}
  };
}

function enqueueRuntimeEvent(settings, event) {
  if (!settings.configured) {
    return;
  }
  if (runtimeEventQueue.length >= settings.maxQueueSize) {
    runtimeEventQueue.shift();
    updateRuntimeStoreState({ droppedEvents: runtimeStoreState.droppedEvents + 1 });
  }
  runtimeEventQueue.push(event);
  updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured });
  scheduleFlush(settings);
}

async function insertRuntimeEvents(settings, batchItems) {
  const pool = getRuntimeStorePool(settings);
  const { schemaName, eventsTableName } = getQualifiedTableNames(settings);
  const columns = [
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
      item.estimatedCostAmount,
      item.modelRouterCostAmount,
      item.actualModelCostAmount,
      item.currency,
      JSON.stringify(item.payload || {})
    );
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });

  await pool.query(
    `INSERT INTO ${schemaName}.${eventsTableName} (${columns.join(", ")}) VALUES ${rows.join(", ")}`,
    values
  );
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
    estimatedCostAmount: event.eventType === "usage" ? event.estimatedCostAmount : 0,
    modelRouterCostAmount: event.eventType === "usage" ? event.modelRouterCostAmount : 0,
    actualModelCostAmount: event.eventType === "usage" ? event.actualModelCostAmount : 0,
    currency: event.currency || "USD",
    lastOccurredAt: event.occurredAt
  };
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
  target.errors += delta.errors;
  target.blockedCount += delta.blockedCount;
  target.warningCount += delta.warningCount;
  target.promptTokens += delta.promptTokens;
  target.completionTokens += delta.completionTokens;
  target.totalTokens += delta.totalTokens;
  target.cachedTokens += delta.cachedTokens;
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
      errors: 0,
      blockedCount: 0,
      warningCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      estimatedCostAmount: 0,
      modelRouterCostAmount: 0,
      actualModelCostAmount: 0,
      currency: delta.currency || "USD",
      lastOccurredAt: delta.lastOccurredAt || bucketStart
    });
  }
  addRollupMetric(map.get(key), delta);
}

function buildRollupRows(events) {
  const rows = new Map();
  for (const event of events) {
    const delta = createMetricDelta(event);
    for (const grain of ROLLUP_GRAINS) {
      const bucketStart = getBucketStart(grain, event.occurredAt);
      addRollupRow(rows, grain, bucketStart, "global", GLOBAL_SCOPE_KEY, GLOBAL_SCOPE_SUBKEY, delta);

      if (event.keyId) {
        addRollupRow(rows, grain, bucketStart, "key", event.keyId, "", delta);
      }
      if (event.modelId) {
        addRollupRow(rows, grain, bucketStart, "model", event.modelId, "", delta);
      }
      if (event.modelId && event.actualModelId) {
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

async function upsertRollupRows(settings, rollupRows) {
  if (!rollupRows.length) {
    return;
  }
  const pool = getRuntimeStorePool(settings);
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
    "estimated_cost_amount",
    "model_router_cost_amount",
    "actual_model_cost_amount",
    "currency",
    "last_occurred_at"
  ];
  const values = [];
  const rows = rollupRows.map((item, index) => {
    const offset = index * columns.length;
    values.push(
      item.grain,
      item.bucketStart,
      item.scopeType,
      item.scopeKey,
      item.scopeSubkey,
      item.requests,
      item.errors,
      item.blockedCount,
      item.warningCount,
      item.promptTokens,
      item.completionTokens,
      item.totalTokens,
      item.cachedTokens,
      item.estimatedCostAmount,
      item.modelRouterCostAmount,
      item.actualModelCostAmount,
      item.currency,
      item.lastOccurredAt
    );
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });

  await pool.query(
    `INSERT INTO ${schemaName}.${rollupsTableName} (${columns.join(", ")}) VALUES ${rows.join(", ")}
     ON CONFLICT (grain, bucket_start, scope_type, scope_key, scope_subkey)
     DO UPDATE SET
       requests = ${schemaName}.${rollupsTableName}.requests + EXCLUDED.requests,
       errors = ${schemaName}.${rollupsTableName}.errors + EXCLUDED.errors,
       blocked_count = ${schemaName}.${rollupsTableName}.blocked_count + EXCLUDED.blocked_count,
       warning_count = ${schemaName}.${rollupsTableName}.warning_count + EXCLUDED.warning_count,
       prompt_tokens = ${schemaName}.${rollupsTableName}.prompt_tokens + EXCLUDED.prompt_tokens,
       completion_tokens = ${schemaName}.${rollupsTableName}.completion_tokens + EXCLUDED.completion_tokens,
       total_tokens = ${schemaName}.${rollupsTableName}.total_tokens + EXCLUDED.total_tokens,
       cached_tokens = ${schemaName}.${rollupsTableName}.cached_tokens + EXCLUDED.cached_tokens,
       estimated_cost_amount = ${schemaName}.${rollupsTableName}.estimated_cost_amount + EXCLUDED.estimated_cost_amount,
       model_router_cost_amount = ${schemaName}.${rollupsTableName}.model_router_cost_amount + EXCLUDED.model_router_cost_amount,
       actual_model_cost_amount = ${schemaName}.${rollupsTableName}.actual_model_cost_amount + EXCLUDED.actual_model_cost_amount,
       currency = CASE WHEN EXCLUDED.currency <> '' THEN EXCLUDED.currency ELSE ${schemaName}.${rollupsTableName}.currency END,
       last_occurred_at = GREATEST(${schemaName}.${rollupsTableName}.last_occurred_at, EXCLUDED.last_occurred_at)`,
    values
  );
}

async function getMetaValue(settings, metaKey) {
  const pool = getRuntimeStorePool(settings);
  const { schemaName, metaTableName } = getQualifiedTableNames(settings);
  const result = await pool.query(
    `SELECT meta_value FROM ${schemaName}.${metaTableName} WHERE meta_key = $1`,
    [metaKey]
  );
  return result.rows[0]?.meta_value || "";
}

async function setMetaValue(settings, metaKey, metaValue) {
  const pool = getRuntimeStorePool(settings);
  const { schemaName, metaTableName } = getQualifiedTableNames(settings);
  await pool.query(
    `INSERT INTO ${schemaName}.${metaTableName} (meta_key, meta_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (meta_key)
     DO UPDATE SET meta_value = EXCLUDED.meta_value, updated_at = NOW()`,
    [metaKey, String(metaValue)]
  );
}

async function fetchUnrolledEvents(settings, afterEventId) {
  const pool = getRuntimeStorePool(settings);
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

async function rollupRuntimeEvents(settings) {
  if (!settings.configured) {
    return { processed: 0 };
  }

  let processed = 0;
  let lastEventId = resolveInt(await getMetaValue(settings, META_LAST_ROLLED_EVENT_ID), 0, 0);
  try {
    while (true) {
      const batch = await fetchUnrolledEvents(settings, lastEventId);
      if (!batch.length) {
        break;
      }
      const rollupRows = buildRollupRows(batch);
      await upsertRollupRows(settings, rollupRows);
      lastEventId = batch[batch.length - 1].eventId;
      await setMetaValue(settings, META_LAST_ROLLED_EVENT_ID, lastEventId);
      processed += batch.length;
      if (batch.length < settings.rollupBatchSize) {
        break;
      }
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
    return { processed, error };
  }
}

export async function flushRuntimeEvents() {
  const settings = resolveRuntimeStoreSettings(runtimeStoreConfig);
  if (!settings.configured || runtimeEventQueue.length === 0) {
    updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured, flushing: false });
    return { flushed: 0 };
  }
  if (flushRunning) {
    return { flushed: 0, skipped: true };
  }

  flushRunning = true;
  updateRuntimeStoreState({ enabled: settings.enabled, configured: settings.configured, flushing: true });
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batchItems = runtimeEventQueue.splice(0, settings.batchSize);
  updateRuntimeStoreState({});

  try {
    await ensureRuntimeTables(settings);
    await insertRuntimeEvents(settings, batchItems);
    await rollupRuntimeEvents(settings);
    await cleanupRuntimeData(settings);
    updateRuntimeStoreState({
      lastSuccessTs: toIsoString(),
      lastError: null,
      flushing: false
    });
    if (runtimeEventQueue.length > 0) {
      scheduleFlush(settings);
    }
    return { flushed: batchItems.length };
  } catch (error) {
    runtimeEventQueue.unshift(...batchItems);
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
    scheduleFlush(settings);
    return { flushed: 0, error };
  } finally {
    flushRunning = false;
    updateRuntimeStoreState({ flushing: false });
  }
}

export function setRuntimeStoreConfig(config) {
  runtimeStoreConfig = config || null;
  const settings = resolveRuntimeStoreSettings(runtimeStoreConfig);
  updateRuntimeStoreState({
    enabled: settings.enabled,
    configured: settings.configured,
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
  if (settings.configured && runtimeEventQueue.length > 0) {
    scheduleFlush(settings);
  }
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
    queueLength: runtimeEventQueue.length,
    droppedEvents: runtimeStoreState.droppedEvents,
    flushFailures: runtimeStoreState.flushFailures,
    rollupFailures: runtimeStoreState.rollupFailures,
    lastSuccessTs: runtimeStoreState.lastSuccessTs,
    lastRollupTs: runtimeStoreState.lastRollupTs,
    lastRolledEventId: runtimeStoreState.lastRolledEventId,
    lastError: runtimeStoreState.lastError,
    flushing: runtimeStoreState.flushing
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
  enqueueRuntimeEvent(settings, buildEventRow("usage", {
    ...fields,
    payload: {
      source: fields.source || ""
    }
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
  const clauses = [];
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

async function queryTotals(settings) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredTotals(settings, filters) {
  const pool = getRuntimeStorePool(settings);
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

async function queryPerModel(settings) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredPerModel(settings, filters) {
  const pool = getRuntimeStorePool(settings);
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

async function queryPerActualModel(settings) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredPerActualModel(settings, filters) {
  const pool = getRuntimeStorePool(settings);
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

async function queryPerKey(settings) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredPerKey(settings, filters) {
  const pool = getRuntimeStorePool(settings);
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

async function queryRollupSeries(settings, grain, limit) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredRollupSeries(settings, filters, grain, limit) {
  const pool = getRuntimeStorePool(settings);
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

async function queryTopSignalScopes(settings, scopeType, countColumn, limit = 8) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredTopSignalScopes(settings, filters, eventType, valueColumn, limit = 8) {
  const pool = getRuntimeStorePool(settings);
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

async function queryRecentSignals(settings, eventType, limit = 12) {
  const pool = getRuntimeStorePool(settings);
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

async function queryFilteredRecentSignals(settings, filters, eventType, limit = 12) {
  const pool = getRuntimeStorePool(settings);
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

export async function getRuntimeStatsSnapshot(config, fallbackStats = null, options = {}) {
  const settings = resolveRuntimeStoreSettings(config);
  if (!settings.configured) {
    return fallbackStats;
  }

  try {
    await flushRuntimeEvents();
    await ensureRuntimeTables(settings);
    await rollupRuntimeEvents(settings);
    await cleanupRuntimeData(settings);

    const filters = normalizeStatsFilters(options);
    const useFilteredQueryPath = !!filters.keyId || !!filters.since;

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
      recentWarnings
    ] = await Promise.all([
      useFilteredQueryPath ? queryFilteredTotals(settings, filters) : queryTotals(settings),
      useFilteredQueryPath ? queryFilteredPerModel(settings, filters) : queryPerModel(settings),
      useFilteredQueryPath ? queryFilteredPerActualModel(settings, filters) : queryPerActualModel(settings),
      useFilteredQueryPath ? queryFilteredPerKey(settings, filters) : queryPerKey(settings),
      useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "hourly", 24) : queryRollupSeries(settings, "hourly", 24),
      useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "daily", 30) : queryRollupSeries(settings, "daily", 30),
      useFilteredQueryPath ? queryFilteredRollupSeries(settings, filters, "weekly", 12) : queryRollupSeries(settings, "weekly", 12),
      useFilteredQueryPath ? queryFilteredTopSignalScopes(settings, filters, "blocked", "blocked_reason", 10) : queryTopSignalScopes(settings, "blocked_reason", "blocked_count", 10),
      useFilteredQueryPath ? queryFilteredTopSignalScopes(settings, filters, "warning", "signal_name", 10) : queryTopSignalScopes(settings, "warning_event", "warning_count", 10),
      useFilteredQueryPath ? queryFilteredRecentSignals(settings, filters, "blocked", 12) : queryRecentSignals(settings, "blocked", 12),
      useFilteredQueryPath ? queryFilteredRecentSignals(settings, filters, "warning", 12) : queryRecentSignals(settings, "warning", 12)
    ]);

    const snapshot = {
      startedAt: totalsRow?.started_at ? new Date(totalsRow.started_at).toISOString() : (fallbackStats?.startedAt || toIsoString()),
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
        actualModels: {}
      };
    }

    for (const row of perActualModelRows) {
      if (!snapshot.perModel[row.model_id]) {
        snapshot.perModel[row.model_id] = {
          ...buildAggregateNode({}),
          actualModels: {}
        };
      }
      snapshot.perModel[row.model_id].actualModels[row.actual_model_id] = buildAggregateNode(row);
    }

    for (const row of perKeyRows) {
      snapshot.perKey[row.key_id] = buildAggregateNode(row);
    }

    return snapshot;
  } catch (error) {
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.stats_query_failed",
      failureReason: error?.message || "Runtime stats query failed"
    });
    return fallbackStats;
  }
}

export async function hydrateGovernanceRuntime(config, keyId, rateWindowStartedAt, budgetWindowStartedAt) {
  const settings = resolveRuntimeStoreSettings(config);
  if (!settings.configured || !keyId) {
    return null;
  }

  try {
    await flushRuntimeEvents();
    await ensureRuntimeTables(settings);
    const pool = getRuntimeStorePool(settings);
    const { schemaName, eventsTableName, rollupsTableName } = getQualifiedTableNames(settings);
    const result = await pool.query(`
      WITH latest_block AS (
        SELECT occurred_at, blocked_reason
        FROM ${schemaName}.${eventsTableName}
        WHERE key_id = $1 AND event_type = 'blocked'
        ORDER BY occurred_at DESC
        LIMIT 1
      ),
      rate_window AS (
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'request') AS rate_requests,
          COALESCE(SUM(prompt_tokens) FILTER (WHERE event_type = 'usage'), 0) AS rate_prompt_tokens,
          COALESCE(SUM(completion_tokens) FILTER (WHERE event_type = 'usage'), 0) AS rate_completion_tokens,
          COALESCE(SUM(total_tokens) FILTER (WHERE event_type = 'usage'), 0) AS rate_total_tokens,
          COALESCE(SUM(cached_tokens) FILTER (WHERE event_type = 'usage'), 0) AS rate_cached_tokens,
          COUNT(*) FILTER (WHERE event_type = 'blocked') AS rate_blocked_requests
        FROM ${schemaName}.${eventsTableName}
        WHERE key_id = $1 AND occurred_at >= $2::timestamptz
      ),
      key_totals AS (
        SELECT
          MAX(last_occurred_at) AS last_seen_at,
          COALESCE(SUM(requests), 0) AS total_requests,
          COALESCE(SUM(errors), 0) AS total_errors,
          COALESCE(SUM(blocked_count), 0) AS total_blocked_requests
        FROM ${schemaName}.${rollupsTableName}
        WHERE grain = 'daily' AND scope_type = 'key' AND scope_key = $1
      ),
      budget_window AS (
        SELECT
          COALESCE(SUM(prompt_tokens), 0) AS budget_prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS budget_completion_tokens,
          COALESCE(SUM(total_tokens), 0) AS budget_total_tokens,
          COALESCE(SUM(cached_tokens), 0) AS budget_cached_tokens,
          COALESCE(SUM(estimated_cost_amount), 0) AS budget_spent_amount,
          COALESCE(SUM(blocked_count), 0) AS budget_blocked_requests
        FROM ${schemaName}.${rollupsTableName}
        WHERE grain = 'daily' AND scope_type = 'key' AND scope_key = $1 AND bucket_start >= $3::timestamptz
      ),
      budget_requests AS (
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'usage') AS budget_requests
        FROM ${schemaName}.${eventsTableName}
        WHERE key_id = $1 AND occurred_at >= $3::timestamptz
      )
      SELECT
        key_totals.last_seen_at,
        key_totals.total_requests,
        key_totals.total_errors,
        key_totals.total_blocked_requests,
        (SELECT occurred_at FROM latest_block) AS last_blocked_at,
        (SELECT blocked_reason FROM latest_block) AS last_blocked_reason,
        rate_window.rate_requests,
        rate_window.rate_prompt_tokens,
        rate_window.rate_completion_tokens,
        rate_window.rate_total_tokens,
        rate_window.rate_cached_tokens,
        rate_window.rate_blocked_requests,
        budget_requests.budget_requests,
        budget_window.budget_prompt_tokens,
        budget_window.budget_completion_tokens,
        budget_window.budget_total_tokens,
        budget_window.budget_cached_tokens,
        budget_window.budget_spent_amount,
        budget_window.budget_blocked_requests
      FROM key_totals, rate_window, budget_window, budget_requests
    `, [keyId, rateWindowStartedAt, budgetWindowStartedAt]);

    return result.rows[0] || null;
  } catch (error) {
    appendStructuredLog("warn", {
      source: "runtime-store",
      event: "runtime_store.governance_hydrate_failed",
      keyId,
      failureReason: error?.message || "Runtime governance hydrate failed"
    });
    return null;
  }
}
