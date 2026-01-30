import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const DEFAULT_CADDYFILE = "Caddyfile";

export function getCaddyfilePath() {
  const envPath = process.env.CADDYFILE_PATH || DEFAULT_CADDYFILE;
  return path.resolve(process.cwd(), envPath);
}

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
  reverse_proxy ${upstream}
}
`;
}

export function writeCaddyfile(config) {
  const content = renderCaddyfile(config);
  if (!content) {
    return { written: false, reason: "disabled" };
  }
  const targetPath = getCaddyfilePath();
  fs.writeFileSync(targetPath, content, "utf8");
  return { written: true, path: targetPath };
}

export async function reloadCaddy(config) {
  const content = renderCaddyfile(config);
  if (!content) {
    return { reloaded: false, reason: "disabled" };
  }
  const targetPath = getCaddyfilePath();
  return new Promise((resolve) => {
    execFile("caddy", ["reload", "--config", targetPath, "--adapter", "caddyfile"], (error, stdout, stderr) => {
      if (error) {
        resolve({ reloaded: false, error: stderr || error.message });
        return;
      }
      resolve({ reloaded: true, output: stdout?.trim() });
    });
  });
}
