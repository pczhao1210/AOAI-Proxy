import { DefaultAzureCredential } from "@azure/identity";

let credential = null;
let cachedToken = null;

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
  cachedToken = null;
}

export async function getBearerToken(scope) {
  if (!credential) {
    throw new Error("Credential not initialized");
  }
  const now = Date.now();
  if (cachedToken && cachedToken.expiresOnTimestamp - now > 2 * 60 * 1000) {
    return cachedToken.token;
  }
  const token = await credential.getToken(scope);
  if (!token || !token.token) {
    throw new Error("Failed to acquire access token");
  }
  cachedToken = token;
  return token.token;
}
