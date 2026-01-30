import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  server: {
    host: "0.0.0.0",
    port: 3000,
    adminPath: "/admin",
    adminAuth: {
      enabled: false,
      username: "admin",
      password: "change-me"
    }
  },
  auth: {
    mode: "servicePrincipal",
    tenantId: "",
    clientId: "",
    clientSecret: "",
    managedIdentityClientId: "",
    scope: "https://cognitiveservices.azure.com/.default"
  },
  apiKeys: [],
  upstreams: [],
  models: []
};

let currentConfig = null;
let configPath = null;

function deepMerge(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override : base;
  }
  if (typeof base === "object" && base !== null) {
    const out = { ...base };
    for (const [k, v] of Object.entries(override || {})) {
      if (k in base) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return override ?? base;
}

function normalizeConfig(raw) {
  const merged = deepMerge(DEFAULTS, raw || {});
  merged.apiKeys = Array.isArray(merged.apiKeys) ? merged.apiKeys : [];
  merged.upstreams = Array.isArray(merged.upstreams) ? merged.upstreams : [];
  merged.models = Array.isArray(merged.models) ? merged.models : [];
  return merged;
}

function validateConfig(cfg) {
  if (!cfg.server || !cfg.server.port) {
    throw new Error("server.port is required");
  }
  if (!cfg.server.adminPath || typeof cfg.server.adminPath !== "string") {
    throw new Error("server.adminPath must be a string");
  }
  if (cfg.server.adminAuth != null) {
    if (typeof cfg.server.adminAuth !== "object") {
      throw new Error("server.adminAuth must be an object");
    }
    const { enabled, username, password } = cfg.server.adminAuth;
    if (enabled != null && typeof enabled !== "boolean") {
      throw new Error("server.adminAuth.enabled must be a boolean");
    }
    if (enabled) {
      if (!username || typeof username !== "string") {
        throw new Error("server.adminAuth.username must be a non-empty string when enabled");
      }
      if (!password || typeof password !== "string") {
        throw new Error("server.adminAuth.password must be a non-empty string when enabled");
      }
    }
  }
  if (!cfg.auth || !cfg.auth.scope) {
    throw new Error("auth.scope is required");
  }
  if (!Array.isArray(cfg.apiKeys)) {
    throw new Error("apiKeys must be an array");
  }
  if (!Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) {
    throw new Error("upstreams must be a non-empty array");
  }
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error("models must be a non-empty array");
  }

  for (const [idx, model] of cfg.models.entries()) {
    if (!model?.id || typeof model.id !== "string") {
      throw new Error(`models[${idx}].id is required`);
    }
    if (!model?.upstream || typeof model.upstream !== "string") {
      throw new Error(`models[${idx}].upstream is required`);
    }
    if (model.targetModel != null && typeof model.targetModel !== "string") {
      throw new Error(`models[${idx}].targetModel must be a string`);
    }
    if (model.routes != null) {
      if (typeof model.routes !== "object") {
        throw new Error(`models[${idx}].routes must be an object`);
      }
      for (const [k, v] of Object.entries(model.routes)) {
        if (typeof v !== "string") {
          throw new Error(`models[${idx}].routes[${k}] must be a string`);
        }
      }
    }
  }

  for (const [idx, upstream] of cfg.upstreams.entries()) {
    if (!upstream?.name) {
      throw new Error(`upstreams[${idx}].name is required`);
    }
    if (!upstream?.baseUrl || typeof upstream.baseUrl !== "string") {
      throw new Error(`upstreams[${idx}].baseUrl is required`);
    }
    let parsed;
    try {
      parsed = new URL(upstream.baseUrl);
    } catch {
      throw new Error(`upstreams[${idx}].baseUrl must be a valid URL`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error(`upstreams[${idx}].baseUrl must be http(s)`);
    }
    if (upstream.routes && typeof upstream.routes !== "object") {
      throw new Error(`upstreams[${idx}].routes must be an object`);
    }
  }
  return cfg;
}

export function getConfigPath() {
  if (configPath) return configPath;
  const envPath = process.env.CONFIG_PATH || "./config/config.json";
  configPath = path.resolve(process.cwd(), envPath);
  return configPath;
}

export function loadConfig() {
  const filePath = getConfigPath();
  const rawText = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(rawText);
  const cfg = validateConfig(normalizeConfig(raw));
  currentConfig = cfg;
  return cfg;
}

export function getConfig() {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

export function saveConfig(nextConfig) {
  const filePath = getConfigPath();
  const normalized = normalizeConfig(nextConfig);
  const validated = validateConfig(normalized);
  fs.writeFileSync(filePath, JSON.stringify(validated, null, 2), "utf8");
  currentConfig = validated;
  return validated;
}

export function reloadConfig() {
  return loadConfig();
}
