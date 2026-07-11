import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_CONNECTIONS = 32;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 30000;
const DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS = 120000;
const DEFAULT_HEADERS_TIMEOUT_MS = 60000;
const DEFAULT_BODY_TIMEOUT_MS = 120000;
const DEFAULT_PIPLINING = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

let currentAgent = null;

function readPositiveIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

function readNonNegativeIntEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= 0 ? raw : fallback;
}

function resolvePoolValue(configValue, envName, fallback, readFn) {
  if (Number.isInteger(configValue) && configValue >= 0) {
    return configValue;
  }
  return readFn(envName, fallback);
}

export function configureUpstreamHttp(config) {
  const pool = config?.proxy?.httpClient || config?.server?.upstream?.pool || {};
  const configuredConnectTimeout = config?.proxy?.timeouts?.connectMs ?? config?.server?.upstream?.connectTimeoutMs;
  const resolvedConfig = {
    connectTimeout: resolvePoolValue(configuredConnectTimeout, "UPSTREAM_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS, readPositiveIntEnv),
    connections: resolvePoolValue(pool.connections, "UPSTREAM_MAX_CONNECTIONS", DEFAULT_CONNECTIONS, readPositiveIntEnv),
    keepAliveTimeout: resolvePoolValue(pool.keepAliveTimeoutMs, "UPSTREAM_KEEPALIVE_TIMEOUT_MS", DEFAULT_KEEPALIVE_TIMEOUT_MS, readPositiveIntEnv),
    keepAliveMaxTimeout: resolvePoolValue(pool.keepAliveMaxTimeoutMs, "UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS", DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS, readPositiveIntEnv),
    headersTimeout: resolvePoolValue(pool.headersTimeoutMs, "UPSTREAM_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS, readPositiveIntEnv),
    bodyTimeout: resolvePoolValue(pool.bodyTimeoutMs, "UPSTREAM_BODY_TIMEOUT_MS", DEFAULT_BODY_TIMEOUT_MS, readNonNegativeIntEnv),
    pipelining: resolvePoolValue(pool.pipelining, "UPSTREAM_PIPELINING", DEFAULT_PIPLINING, readPositiveIntEnv)
  };
  if (pool.forceIpv4 === true) {
    resolvedConfig.connect = { family: 4 };
  }
  const nextAgent = new Agent(resolvedConfig);

  setGlobalDispatcher(nextAgent);
  const previousAgent = currentAgent;
  currentAgent = nextAgent;
  if (previousAgent) {
    previousAgent.close().catch(() => {});
  }

  return resolvedConfig;
}