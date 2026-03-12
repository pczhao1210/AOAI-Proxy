import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";

let credential = null;
let currentAuth = null;
const cachedTokens = new Map();
const inFlightTokens = new Map();
const injectedEnv = new Map();

const MIN_TOKEN_HEADROOM_MS = 2 * 60 * 1000;
const PREFETCH_REFRESH_MS = 10 * 60 * 1000;

function getCacheKey(scope) {
  return String(scope || "");
}

function hasUsableHeadroom(token, now = Date.now()) {
  return !!token && Number.isFinite(token.expiresOnTimestamp) && token.expiresOnTimestamp - now > MIN_TOKEN_HEADROOM_MS;
}

function shouldRefreshSoon(token, now = Date.now()) {
  return !!token && Number.isFinite(token.expiresOnTimestamp) && token.expiresOnTimestamp - now <= PREFETCH_REFRESH_MS;
}

function normalizeAuth(auth) {
  return {
    mode: typeof auth?.mode === "string" && auth.mode.trim() ? auth.mode.trim() : "servicePrincipal",
    tenantId: typeof auth?.tenantId === "string" ? auth.tenantId.trim() : "",
    clientId: typeof auth?.clientId === "string" ? auth.clientId.trim() : "",
    clientSecret: typeof auth?.clientSecret === "string" ? auth.clientSecret : "",
    managedIdentityClientId: typeof auth?.managedIdentityClientId === "string" ? auth.managedIdentityClientId.trim() : "",
    scope: typeof auth?.scope === "string" ? auth.scope.trim() : "",
    apiKey: typeof auth?.apiKey === "string" ? auth.apiKey : ""
  };
}

function getActiveAuth() {
  return currentAuth || normalizeAuth(null);
}

function isApiKeyMode(auth = getActiveAuth()) {
  return auth.mode === "apiKey";
}

function requireApiKey(auth = getActiveAuth()) {
  const apiKey = String(auth.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("auth.apiKey is required when auth.mode is apiKey");
  }
  return apiKey;
}

function resolveScope(scopeOverride, auth = getActiveAuth()) {
  const scope = String(scopeOverride || auth.scope || "").trim();
  if (!scope) {
    throw new Error("auth.scope is required when auth.mode uses AAD");
  }
  return scope;
}

function createCredential(auth) {
  if (isApiKeyMode(auth)) {
    return null;
  }
  if (auth.mode === "servicePrincipal" && auth.tenantId && auth.clientId && auth.clientSecret) {
    return new ClientSecretCredential(auth.tenantId, auth.clientId, auth.clientSecret);
  }
  return new DefaultAzureCredential({
    managedIdentityClientId: auth.managedIdentityClientId || undefined
  });
}

function buildPreview(secret, prefix = 4, suffix = 4) {
  if (!secret) return "";
  if (secret.length <= prefix + suffix) {
    return `${secret.slice(0, 1)}...`;
  }
  return `${secret.slice(0, prefix)}...${secret.slice(-suffix)}`;
}

function clearInjectedEnv(name) {
  if (!injectedEnv.has(name)) {
    return;
  }
  if (process.env[name] === injectedEnv.get(name)) {
    delete process.env[name];
  }
  injectedEnv.delete(name);
}

function setInjectedEnv(name, value) {
  if (!value) {
    clearInjectedEnv(name);
    return;
  }
  process.env[name] = value;
  injectedEnv.set(name, value);
}

function syncAzureIdentityEnv(auth) {
  clearInjectedEnv("AZURE_TENANT_ID");
  clearInjectedEnv("AZURE_CLIENT_ID");
  clearInjectedEnv("AZURE_CLIENT_SECRET");

  if (auth.mode === "servicePrincipal" && auth.tenantId && auth.clientId && auth.clientSecret) {
    setInjectedEnv("AZURE_TENANT_ID", auth.tenantId);
    setInjectedEnv("AZURE_CLIENT_ID", auth.clientId);
    setInjectedEnv("AZURE_CLIENT_SECRET", auth.clientSecret);
    return;
  }

  if (auth.managedIdentityClientId) {
    setInjectedEnv("AZURE_CLIENT_ID", auth.managedIdentityClientId);
  }
}

async function refreshBearerToken(scope) {
  if (!credential) {
    throw new Error("Credential not initialized");
  }
  const cacheKey = getCacheKey(scope);
  const existing = inFlightTokens.get(cacheKey);
  if (existing) {
    return existing;
  }

  const refreshPromise = credential.getToken(scope)
    .then((token) => {
      if (!token || !token.token) {
        throw new Error("Failed to acquire access token");
      }
      cachedTokens.set(cacheKey, token);
      return token;
    })
    .finally(() => {
      inFlightTokens.delete(cacheKey);
    });

  inFlightTokens.set(cacheKey, refreshPromise);
  return refreshPromise;
}

export function initAuth(config) {
  currentAuth = normalizeAuth(config?.auth);
  syncAzureIdentityEnv(currentAuth);
  credential = createCredential(currentAuth);
  cachedTokens.clear();
  inFlightTokens.clear();
}

export async function getBearerToken(scope) {
  if (isApiKeyMode()) {
    throw new Error("Bearer token is not used when auth.mode is apiKey");
  }
  if (!credential) {
    throw new Error("Credential not initialized");
  }
  const resolvedScope = resolveScope(scope);
  const cacheKey = getCacheKey(resolvedScope);
  const now = Date.now();
  const cachedToken = cachedTokens.get(cacheKey);
  if (hasUsableHeadroom(cachedToken, now)) {
    if (shouldRefreshSoon(cachedToken, now)) {
      refreshBearerToken(resolvedScope).catch(() => {});
    }
    return cachedToken.token;
  }

  const token = await refreshBearerToken(resolvedScope);
  return token.token;
}

export async function warmBearerToken(scope) {
  const token = await refreshBearerToken(resolveScope(scope));
  return token.token;
}

export async function getUpstreamAuthHeaders(scope) {
  const auth = getActiveAuth();
  if (isApiKeyMode(auth)) {
    return {
      "api-key": requireApiKey(auth)
    };
  }
  return {
    authorization: `Bearer ${await getBearerToken(scope)}`
  };
}

export async function verifyUpstreamAuth(scope) {
  const auth = getActiveAuth();
  if (isApiKeyMode(auth)) {
    return {
      mode: auth.mode,
      preview: buildPreview(requireApiKey(auth))
    };
  }
  const token = await warmBearerToken(scope);
  return {
    mode: auth.mode,
    preview: `${token.slice(0, 16)}...`
  };
}
