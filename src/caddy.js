import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// Default Caddyfile path
const DEFAULT_CADDYFILE = "Caddyfile";
const DEFAULT_CADDY_BIN = "/usr/sbin/caddy";

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

// Render Caddyfile based on server.caddy
export function renderCaddyfile(config) {
  const caddy = config?.server?.caddy;
  if (!caddy?.enabled) return null;

  const domain = String(caddy.domain || "").trim();
  const email = String(caddy.email || "").trim();
  const httpsPort = Number(caddy.httpsPort ?? 3001);
  const upstreamHost = String(caddy.upstreamHost || "127.0.0.1").trim();
  const upstreamPort = Number(caddy.upstreamPort ?? 3000);

  const hostPort = `${domain}:${httpsPort}`;
  const upstream = `${upstreamHost}:${upstreamPort}`;

  return `{
  email ${email}
}

${hostPort} {
  log {
    output stdout
    level INFO
  }
  reverse_proxy ${upstream}
}
`;
}

// Write Caddyfile to disk
export function writeCaddyfile(config) {
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

// Reload Caddy if enabled and Caddyfile exists
export async function reloadCaddy(config) {
  const content = renderCaddyfile(config);
  if (!content) {
    setStatus({ enabled: false, state: "disabled", message: "disabled", lastError: null });
    return { reloaded: false, reason: "disabled" };
  }
  const targetPath = getCaddyfilePath();
  return new Promise((resolve) => {
    execFile(getCaddyBin(), ["reload", "--config", targetPath, "--adapter", "caddyfile"], (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message || "reload failed");
        const needsRestart = /connect|dial|refused|no such file|admin/i.test(message);
        setStatus({
          enabled: true,
          state: needsRestart ? "restart-needed" : "error",
          message,
          lastReloadAt: new Date().toISOString(),
          lastError: message
        });
        resolve({ reloaded: false, error: message });
        return;
      }
      const output = stdout?.trim() || "reloaded";
      setStatus({
        enabled: true,
        state: "running",
        message: output,
        lastReloadAt: new Date().toISOString(),
        lastError: null
      });
      resolve({ reloaded: true, output });
    });
  });
}
