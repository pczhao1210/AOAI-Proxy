import { DefaultAzureCredential } from "@azure/identity";

let credential = null;
const cachedTokens = new Map();
const inFlightTokens = new Map();

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

function applyAuthEnv(auth) {
  if (auth?.mode === "servicePrincipal") {
    if (auth.tenantId) process.env.AZURE_TENANT_ID = auth.tenantId;
    if (auth.clientId) process.env.AZURE_CLIENT_ID = auth.clientId;
    if (auth.clientSecret) process.env.AZURE_CLIENT_SECRET = auth.clientSecret;
  }
}

export function initAuth(config) {
  applyAuthEnv(config.auth);
  credential = new DefaultAzureCredential({
    managedIdentityClientId: config.auth?.managedIdentityClientId || undefined
  });
  cachedTokens.clear();
  inFlightTokens.clear();
}

export async function getBearerToken(scope) {
  if (!credential) {
    throw new Error("Credential not initialized");
  }
  const cacheKey = getCacheKey(scope);
  const now = Date.now();
  const cachedToken = cachedTokens.get(cacheKey);
  if (hasUsableHeadroom(cachedToken, now)) {
    if (shouldRefreshSoon(cachedToken, now)) {
      refreshBearerToken(scope).catch(() => {});
    }
    return cachedToken.token;
  }

  const token = await refreshBearerToken(scope);
  return token.token;
}

export async function warmBearerToken(scope) {
  const token = await refreshBearerToken(scope);
  return token.token;
}
