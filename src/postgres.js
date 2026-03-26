import { Pool } from "pg";

const sharedPools = new Map();
const WEAK_SSL_MODES = new Set(["prefer", "require", "verify-ca"]);
let sslModeRewriteLogged = false;

function resolveInt(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= minimum) {
    return numeric;
  }
  return fallback;
}

function normalizeConnectionString(connectionString) {
  const normalized = String(connectionString || "").trim();
  if (!normalized) return normalized;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return normalized;
  }

  const protocol = String(parsed.protocol || "").toLowerCase();
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    return normalized;
  }

  const sslMode = String(parsed.searchParams.get("sslmode") || "").trim().toLowerCase();
  const useLibpqCompat = String(parsed.searchParams.get("uselibpqcompat") || "").trim().toLowerCase() === "true";
  if (!WEAK_SSL_MODES.has(sslMode) || useLibpqCompat) {
    return normalized;
  }

  parsed.searchParams.set("sslmode", "verify-full");
  if (!sslModeRewriteLogged) {
    sslModeRewriteLogged = true;
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      source: "proxy",
      event: "postgres.sslmode_normalized",
      previousSslMode: sslMode,
      nextSslMode: "verify-full"
    }));
  }
  return parsed.toString();
}

export function quoteIdentifier(identifier, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`${label} must match ^[A-Za-z_][A-Za-z0-9_]*$`);
  }
  return `"${identifier}"`;
}

export function buildPostgresPoolOptions(databaseSettings = {}) {
  return {
    connectionString: normalizeConnectionString(databaseSettings.connectionString),
    max: resolveInt(databaseSettings.pool?.max, 10, 1),
    min: resolveInt(databaseSettings.pool?.min, 0, 0),
    idleTimeoutMillis: resolveInt(databaseSettings.pool?.idleTimeoutMs, 30000, 0),
    connectionTimeoutMillis: resolveInt(databaseSettings.pool?.connectionTimeoutMs, 10000, 0)
  };
}

function getConnectionMetadata(connectionString) {
  const normalized = normalizeConnectionString(connectionString);
  try {
    const parsed = new URL(normalized);
    return {
      host: parsed.hostname || "",
      port: parsed.port ? Number(parsed.port) : null,
      databaseName: decodeURIComponent(String(parsed.pathname || "").replace(/^\//, "")) || "",
      sslMode: String(parsed.searchParams.get("sslmode") || "").trim() || ""
    };
  } catch {
    return {
      host: "",
      port: null,
      databaseName: "",
      sslMode: ""
    };
  }
}

export async function probePostgresConnection(databaseSettings = {}, options = {}) {
  const normalizedOptions = buildPostgresPoolOptions(databaseSettings);
  const pool = new Pool(normalizedOptions);
  const schemaName = String(options.schemaName || "").trim();
  const tableName = String(options.tableName || "").trim();
  const configKey = String(options.configKey || "").trim();
  const relationName = schemaName && tableName ? `${schemaName}.${tableName}` : "";

  try {
    const serverResult = await pool.query(`
      SELECT
        current_database() AS current_database,
        current_user AS current_user,
        NOW() AS server_time,
        version() AS server_version
    `);
    const serverRow = serverResult.rows[0] || {};
    let privilegeRow = {};
    let relationRow = {};
    let configRow = {};

    if (schemaName) {
      const privilegeResult = await pool.query(`
        SELECT
          has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
          has_schema_privilege(current_user, $1, 'CREATE') AS schema_create
      `, [schemaName]);
      privilegeRow = privilegeResult.rows[0] || {};
    }

    if (relationName) {
      const relationResult = await pool.query(`
        SELECT
          to_regclass($1) AS relation_name,
          EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = $2 AND table_name = $3
          ) AS table_exists
      `, [relationName, schemaName || "public", tableName]);
      relationRow = relationResult.rows[0] || {};
    }

    if (schemaName && tableName && configKey && relationRow.table_exists === true) {
      const schemaIdentifier = quoteIdentifier(schemaName, "database schema");
      const tableIdentifier = quoteIdentifier(tableName, "database table");
      const configResult = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM ${schemaIdentifier}.${tableIdentifier} WHERE config_key = $1) AS config_exists`,
        [configKey]
      );
      configRow = configResult.rows[0] || {};
    }

    return {
      connected: true,
      connection: {
        ...getConnectionMetadata(normalizedOptions.connectionString),
        timeoutMs: normalizedOptions.connectionTimeoutMillis
      },
      server: {
        currentDatabase: String(serverRow.current_database || "").trim(),
        currentUser: String(serverRow.current_user || "").trim(),
        serverTime: serverRow.server_time instanceof Date ? serverRow.server_time.toISOString() : String(serverRow.server_time || ""),
        serverVersion: String(serverRow.server_version || "").trim()
      },
      privileges: {
        schemaUsage: privilegeRow.schema_usage === true,
        schemaCreate: privilegeRow.schema_create === true
      },
      objects: {
        schemaName,
        tableName,
        relationName: relationRow.relation_name ? String(relationRow.relation_name) : null,
        tableExists: relationRow.table_exists === true,
        configKey: configKey || "",
        configRowExists: configRow.config_exists === true
      }
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

export function getSharedPostgresPool(poolOptions) {
  const normalizedOptions = {
    connectionString: String(poolOptions?.connectionString || "").trim(),
    max: resolveInt(poolOptions?.max, 10, 1),
    min: resolveInt(poolOptions?.min, 0, 0),
    idleTimeoutMillis: resolveInt(poolOptions?.idleTimeoutMillis, 30000, 0),
    connectionTimeoutMillis: resolveInt(poolOptions?.connectionTimeoutMillis, 10000, 0)
  };

  if (!normalizedOptions.connectionString) {
    throw new Error("PostgreSQL connection string is required");
  }

  const poolKey = JSON.stringify(normalizedOptions);
  if (!sharedPools.has(poolKey)) {
    sharedPools.set(poolKey, new Pool(normalizedOptions));
  }

  return sharedPools.get(poolKey);
}