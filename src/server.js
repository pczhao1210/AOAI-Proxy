import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig, reloadConfig, saveConfig, getConfigPath } from "./config.js";
import { initAuth, getBearerToken } from "./auth.js";
import { proxyRequest } from "./proxy.js";
import { getStats } from "./stats.js";

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info"
  }
});

function isAdminRoute(url, adminPath) {
  if (!url) return false;
  const normalized = (adminPath || "/admin").replace(/\/+$/, "");
  const pathOnly = url.split("?")[0];
  const normalizedUrl = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  return normalizedUrl === normalized || normalizedUrl.startsWith(`${normalized}/`);
}

function extractApiKey(headers) {
  const auth = headers.authorization || headers.Authorization;
  if (auth && typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xApiKey = headers["x-api-key"] || headers["X-API-Key"]; 
  if (xApiKey && typeof xApiKey === "string") {
    return xApiKey.trim();
  }
  return null;
}

function verifyApiKey(config, key) {
  if (!key) return false;
  const activeKeys = config.apiKeys.filter((k) => k.status !== "disabled");
  return activeKeys.some((k) => k.key === key);
}

function secureEqual(a, b) {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBasicAuthHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  if (!headerValue.toLowerCase().startsWith("basic ")) return null;
  const b64 = headerValue.slice(6).trim();
  if (!b64) return null;
  let decoded;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1)
  };
}

function verifyAdminBasicAuth(config, headers) {
  const authCfg = config?.server?.adminAuth;
  if (!authCfg?.enabled) return true;
  const username = authCfg.username;
  const password = authCfg.password;
  if (!username || !password) return false;

  const header = headers.authorization || headers.Authorization;
  const parsed = parseBasicAuthHeader(header);
  if (!parsed) return false;
  return secureEqual(parsed.username, username) && secureEqual(parsed.password, password);
}

function buildModelList(config) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: config.models.map((m) => ({
      id: m.id,
      object: "model",
      created,
      owned_by: "proxy"
    }))
  };
}

function attachAuth(config) {
  initAuth(config);
}

app.addHook("preHandler", async (req, reply) => {
  const config = getConfig();
  const rawUrl = req.raw?.url || req.url;
  const pathOnly = (rawUrl || "").split("?")[0];
  if (pathOnly === "/favicon.ico") {
    return reply.code(204).send();
  }
  if (isAdminRoute(rawUrl, config.server.adminPath)) {
    if (!verifyAdminBasicAuth(config, req.headers)) {
      reply.header("WWW-Authenticate", 'Basic realm="AOAI Proxy Admin"');
      return reply.code(401).send({ error: "AdminUnauthorized" });
    }
    return;
  }
  const key = extractApiKey(req.headers);
  if (!verifyApiKey(config, key)) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/healthz", async () => ({ status: "ok" }));

app.get("/v1/models", async () => {
  const config = getConfig();
  return buildModelList(config);
});

app.post("/v1/chat/completions", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "chat/completions", req, reply });
});

app.post("/v1/responses", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "responses", req, reply });
});

app.post("/v1/images/generations", async (req, reply) => {
  const config = getConfig();
  await proxyRequest({ config, routeKey: "images/generations", req, reply });
});

app.get("/admin/api/config", async () => {
  const config = getConfig();
  return config;
});

app.put("/admin/api/config", async (req, reply) => {
  const nextConfig = req.body;
  try {
    const saved = saveConfig(nextConfig);
    attachAuth(saved);
    reply.send({ ok: true, config: saved });
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.post("/admin/api/reload", async (req, reply) => {
  try {
    const config = reloadConfig();
    attachAuth(config);
    reply.send({ ok: true, config });
  } catch (error) {
    reply.code(400).send({ error: error.message });
  }
});

app.post("/admin/api/verify-aad", async (req, reply) => {
  const config = getConfig();
  try {
    const token = await getBearerToken(config.auth.scope);
    reply.send({ ok: true, tokenPreview: token.slice(0, 16) + "..." });
  } catch (error) {
    reply.code(400).send({ ok: false, error: error.message });
  }
});

app.get("/admin/api/stats", async () => {
  return getStats();
});

const publicRoot = path.resolve(process.cwd(), "public");
app.register(fastifyStatic, {
  root: publicRoot,
  prefix: "/admin/",
  index: "index.html"
});

app.get("/admin", async (req, reply) => {
  reply.redirect("/admin/");
});

async function start() {
  const config = reloadConfig();
  attachAuth(config);
  const { host, port } = config.server;
  await app.listen({ host, port });
  app.log.info({ configPath: getConfigPath() }, "config loaded");
}

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
