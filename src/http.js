import { Agent, setGlobalDispatcher } from "undici";

const DEFAULT_CONNECTIONS = 32;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 30000;
const DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS = 120000;
const DEFAULT_HEADERS_TIMEOUT_MS = 60000;
const DEFAULT_BODY_TIMEOUT_MS = 0;
const DEFAULT_PIPLINING = 1;

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
  const pool = config?.server?.upstream?.pool || {};
  const resolvedConfig = {
    connections: resolvePoolValue(pool.connections, "UPSTREAM_MAX_CONNECTIONS", DEFAULT_CONNECTIONS, readPositiveIntEnv),
    keepAliveTimeout: resolvePoolValue(pool.keepAliveTimeoutMs, "UPSTREAM_KEEPALIVE_TIMEOUT_MS", DEFAULT_KEEPALIVE_TIMEOUT_MS, readPositiveIntEnv),
    keepAliveMaxTimeout: resolvePoolValue(pool.keepAliveMaxTimeoutMs, "UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS", DEFAULT_KEEPALIVE_MAX_TIMEOUT_MS, readPositiveIntEnv),
    headersTimeout: resolvePoolValue(pool.headersTimeoutMs, "UPSTREAM_HEADERS_TIMEOUT_MS", DEFAULT_HEADERS_TIMEOUT_MS, readPositiveIntEnv),
    bodyTimeout: resolvePoolValue(pool.bodyTimeoutMs, "UPSTREAM_BODY_TIMEOUT_MS", DEFAULT_BODY_TIMEOUT_MS, readNonNegativeIntEnv),
    pipelining: resolvePoolValue(pool.pipelining, "UPSTREAM_PIPELINING", DEFAULT_PIPLINING, readPositiveIntEnv)
  };
  const nextAgent = new Agent(resolvedConfig);

  setGlobalDispatcher(nextAgent);
  const previousAgent = currentAgent;
  currentAgent = nextAgent;
  if (previousAgent) {
    previousAgent.close().catch(() => {});
  }

  return resolvedConfig;
}