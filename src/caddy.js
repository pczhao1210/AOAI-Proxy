import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// Default Caddyfile path
const DEFAULT_CADDYFILE = "Caddyfile";
const DEFAULT_CADDY_BIN = "/usr/sbin/caddy";
const DEFAULT_STARTUP_PROBE_DELAY_MS = 1000;
const DEFAULT_STARTUP_PROBE_MAX_ATTEMPTS = 20;

let startupProbeTimer = null;

let caddyStatus = {
  enabled: false,
  state: "disabled",
  message: "",
  lastWriteAt: null,
  lastReloadAt: null,
  lastError: null
};

function setStatus(patch) {
  caddyStatus = { ...caddyStatus, ...patch };
}

export function getCaddyStatus() {
  return caddyStatus;
}

export function setCaddyStatus(patch) {
  setStatus(patch);
}

export function getCaddyfilePath() {
  const envPath = process.env.CADDYFILE_PATH || DEFAULT_CADDYFILE;
  return path.resolve(process.cwd(), envPath);
}

function getCaddyBin() {
  return process.env.CADDY_BIN || DEFAULT_CADDY_BIN;
}

function clearStartupProbe() {
  if (startupProbeTimer) {
    clearTimeout(startupProbeTimer);
    startupProbeTimer = null;
  }
}

function msToCaddyDuration(ms, fallbackMs) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
  return `${Math.max(1, Math.ceil(value / 1000))}s`;
}

// Render Caddyfile based on server.caddy
export function renderCaddyfile(config) {
  const caddy = config?.server?.caddy;
  if (!caddy?.enabled) return null;

  const domain = String(caddy.domain || "").trim();
  const email = String(caddy.email || "").trim();
  const httpsPort = Number(caddy.httpsPort ?? 3001);
  const upstreamHost = String(caddy.upstreamHost || "127.0.0.1").trim();
  const upstreamPort = Number(caddy.upstreamPort ?? 3000);
  const dialTimeout = msToCaddyDuration(caddy?.transport?.dialTimeoutMs, config?.server?.upstream?.connectTimeoutMs ?? 5000);
  const responseHeaderTimeout = msToCaddyDuration(
    caddy?.transport?.responseHeaderTimeoutMs,
    config?.server?.upstream?.firstByteTimeoutMs ?? 45000
  );
  const keepAliveTimeout = msToCaddyDuration(caddy?.transport?.keepAliveTimeoutMs, 120000);

  const hostPort = `${domain}:${httpsPort}`;
  const upstream = `${upstreamHost}:${upstreamPort}`;

  return `{
  email ${email}
  servers :80 {
    protocols h1
  }
  servers {
    protocols h1 h2 h3
  }
}

${hostPort} {
  log {
    output stdout
    level INFO
  }
  encode zstd gzip
  reverse_proxy ${upstream} {
    flush_interval -1
    health_uri /healthz
    health_interval 30s
    fail_duration 30s
    transport http {
      dial_timeout ${dialTimeout}
      response_header_timeout ${responseHeaderTimeout}
      keepalive ${keepAliveTimeout}
      keepalive_idle_conns 256
      keepalive_idle_conns_per_host 128
      versions 2 1.1
    }
  }
}
`;
}

// Write Caddyfile to disk
export function writeCaddyfile(config) {
  clearStartupProbe();
  const content = renderCaddyfile(config);
  if (!content) {
    setStatus({ enabled: false, state: "disabled", message: "disabled", lastError: null });
    return { written: false, reason: "disabled" };
  }
  const targetPath = getCaddyfilePath();
  fs.writeFileSync(targetPath, content, "utf8");
  setStatus({
    enabled: true,
    state: "configured",
    message: "caddyfile written",
    lastWriteAt: new Date().toISOString(),
    lastError: null
  });
  return { written: true, path: targetPath };
}

function isAdminUnavailable(message) {
  return /connect|dial|refused|no such file|admin/i.test(message);
}

function executeReload(targetPath) {
  return new Promise((resolve) => {
    execFile(getCaddyBin(), ["reload", "--config", targetPath, "--adapter", "caddyfile"], (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "reload failed");
        resolve({
          reloaded: false,
          error: message,
          transient: isAdminUnavailable(message)
        });
        return;
      }
      resolve({
        reloaded: true,
        output: stdout?.trim() || "reloaded",
        transient: false
      });
    });
  });
}

// Reload Caddy if enabled and Caddyfile exists
export async function reloadCaddy(config, options = {}) {
  clearStartupProbe();
  const content = renderCaddyfile(config);
  if (!content) {
    setStatus({ enabled: false, state: "disabled", message: "disabled", lastError: null });
    return { reloaded: false, reason: "disabled" };
  }
  const targetPath = getCaddyfilePath();
  const result = await executeReload(targetPath);
  const now = new Date().toISOString();
  if (!result.reloaded) {
    const transientState = options.transientState || "restart-needed";
    setStatus({
      enabled: true,
      state: result.transient ? transientState : "error",
      message: result.error,
      lastReloadAt: now,
      lastError: options.clearTransientError && result.transient ? null : result.error
    });
    return { reloaded: false, error: result.error, transient: result.transient };
  }
  setStatus({
    enabled: true,
    state: "running",
    message: result.output,
    lastReloadAt: now,
    lastError: null
  });
  return { reloaded: true, output: result.output, transient: false };
}

export function scheduleCaddyStartupProbe(config, options = {}) {
  clearStartupProbe();
  const content = renderCaddyfile(config);
  if (!content) {
    setStatus({ enabled: false, state: "disabled", message: "disabled", lastError: null });
    return { scheduled: false, reason: "disabled" };
  }

  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0
    ? options.maxAttempts
    : DEFAULT_STARTUP_PROBE_MAX_ATTEMPTS;
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs > 0
    ? options.delayMs
    : DEFAULT_STARTUP_PROBE_DELAY_MS;

  let attempts = 0;
  setStatus({
    enabled: true,
    state: "starting",
    message: "waiting for caddy process to become ready",
    lastError: null
  });

  const runProbe = async () => {
    attempts += 1;
    const result = await reloadCaddy(config, {
      transientState: attempts < maxAttempts ? "starting" : "restart-needed",
      clearTransientError: true
    });
    if (result.reloaded || !result.transient || attempts >= maxAttempts) {
      startupProbeTimer = null;
      return;
    }
    setStatus({
      enabled: true,
      state: "starting",
      message: `waiting for caddy process to become ready (${attempts}/${maxAttempts})`,
      lastError: null
    });
    startupProbeTimer = setTimeout(() => {
      void runProbe();
    }, delayMs);
  };

  startupProbeTimer = setTimeout(() => {
    void runProbe();
  }, delayMs);
  return { scheduled: true, attempts: maxAttempts, delayMs };
}
