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