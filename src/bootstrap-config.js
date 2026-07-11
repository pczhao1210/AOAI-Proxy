import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSECURE_SECRET_VALUES = new Set(["", "admin", "password", "change-me", "changeme"]);

function getEnvironmentValue(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getEnvironmentBoolean(env, ...names) {
  const value = getEnvironmentValue(env, ...names).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function isPublicExposure(config) {
  const host = String(config?.server?.host || "").trim().toLowerCase();
  return !["127.0.0.1", "::1", "localhost"].includes(host)
    || config?.server?.caddy?.enabled === true;
}

function isInsecureSecret(value) {
  return INSECURE_SECRET_VALUES.has(String(value || "").trim().toLowerCase());
}

function generateSecret(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hardenBootstrapConfig(input, env = process.env) {
  const config = structuredClone(input || {});
  config.server ||= {};
  config.server.adminAuth ||= {};
  config.server.caddy ||= {};
  config.apiKeys = Array.isArray(config.apiKeys) ? config.apiKeys : [];
  const credentials = {};
  let changed = false;

  const adminUsername = getEnvironmentValue(env, "AOAI_PROXY_ADMIN_USERNAME", "ADMIN_USERNAME");
  const adminPassword = getEnvironmentValue(env, "AOAI_PROXY_ADMIN_PASSWORD", "ADMIN_PASSWORD");
  const adminAuthEnabled = getEnvironmentBoolean(env, "AOAI_PROXY_ADMIN_AUTH_ENABLED", "ADMIN_AUTH_ENABLED");
  const caddyEnabled = getEnvironmentBoolean(env, "AOAI_PROXY_CADDY_ENABLED", "CADDY_ENABLED");
  const caddyDomain = getEnvironmentValue(env, "AOAI_PROXY_CADDY_DOMAIN", "CADDY_DOMAIN");
  if (caddyDomain) {
    config.server.caddy.domain = caddyDomain;
    changed = true;
  }
  if (caddyEnabled !== null || caddyDomain) {
    config.server.caddy.enabled = caddyEnabled ?? true;
    changed = true;
  }
  if (adminUsername && config.server.adminAuth.username !== adminUsername) {
    config.server.adminAuth.username = adminUsername;
    changed = true;
  }
  if (adminPassword) {
    config.server.adminAuth.password = adminPassword;
    changed = true;
  }
  if (adminAuthEnabled !== null || adminPassword) {
    config.server.adminAuth.enabled = adminAuthEnabled ?? true;
    changed = true;
  }

  if (isPublicExposure(config) && config.server.adminAuth.enabled !== true) {
    config.server.adminAuth.enabled = true;
    changed = true;
  }
  if (config.server.adminAuth.enabled === true && isInsecureSecret(config.server.adminAuth.password)) {
    config.server.adminAuth.password = generateSecret(24);
    credentials.adminPassword = config.server.adminAuth.password;
    changed = true;
  }
  if (!config.server.adminAuth.username) {
    config.server.adminAuth.username = "admin";
    changed = true;
  }

  const proxyApiKey = getEnvironmentValue(env, "AOAI_PROXY_API_KEY", "PROXY_API_KEY");
  if (proxyApiKey) {
    const defaultKey = config.apiKeys.find((item) => item?.id === "default");
    if (defaultKey) {
      defaultKey.key = proxyApiKey;
      defaultKey.status = "active";
    } else {
      config.apiKeys.push({ id: "default", key: proxyApiKey, status: "active" });
    }
    changed = true;
  } else {
    const activeKeys = config.apiKeys.filter((item) => item?.status !== "disabled");
    const secureActiveKeys = activeKeys.filter((item) => !isInsecureSecret(item?.key));
    for (const item of activeKeys) {
      if (isInsecureSecret(item?.key)) {
        item.status = "disabled";
        changed = true;
      }
    }
    if (secureActiveKeys.length === 0) {
      const generatedKey = generateSecret(32);
      const defaultKey = config.apiKeys.find((item) => item?.id === "default");
      if (defaultKey) {
        defaultKey.key = generatedKey;
        defaultKey.status = "active";
      } else {
        config.apiKeys.push({ id: "default", key: generatedKey, status: "active" });
      }
      credentials.proxyApiKey = generatedKey;
      changed = true;
    }
  }

  return { config, credentials, changed };
}

async function writeAtomic(filePath, text, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", mode });
    await fs.rename(tempPath, filePath);
    try {
      await fs.chmod(filePath, mode);
    } catch (error) {
      if (!["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function hardenBootstrapConfigFile(configPath, credentialsPath, env = process.env) {
  const input = JSON.parse(await fs.readFile(configPath, "utf8"));
  const result = hardenBootstrapConfig(input, env);
  if (result.changed) {
    await writeAtomic(configPath, `${JSON.stringify(result.config, null, 2)}\n`);
  }
  if (Object.keys(result.credentials).length > 0) {
    await writeAtomic(credentialsPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      adminPath: result.config.server?.adminPath || "/admin",
      adminUsername: result.config.server?.adminAuth?.username || "admin",
      ...result.credentials
    }, null, 2)}\n`);
  }
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  const credentialsPath = process.argv[3];
  if (!configPath || !credentialsPath) {
    console.error("usage: node bootstrap-config.js <config-path> <credentials-path>");
    process.exit(2);
  }
  const result = await hardenBootstrapConfigFile(configPath, credentialsPath);
  if (Object.keys(result.credentials).length > 0) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "startup.bootstrap_credentials_generated",
      credentialsPath,
      generatedAdminPassword: !!result.credentials.adminPassword,
      generatedProxyApiKey: !!result.credentials.proxyApiKey
    }));
  }
}