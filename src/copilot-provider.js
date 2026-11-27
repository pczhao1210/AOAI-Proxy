export const COPILOT_ORIGIN = "https://api.githubcopilot.com";
export const COPILOT_ROUTES = Object.freeze({
  "chat/completions": "/chat/completions", responses: "/v1/responses", messages: "/v1/messages"
});
export function isCopilotOrigin(value) {
  try {
    const host = new URL(value).hostname.replace(/\.$/, "");
    return host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
  } catch { return false; }
}
const LOGIN = "https://github.com/login";
const GH = "https://api.github.com";
const MAX_BYTES = 2 * 1024 * 1024;
const allowedProfile = profile => profile === "vscode" || profile === "opencode";
const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= 315360000;
const token = value => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value);

export function copilotError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}

export function discoveryModels(body) {
  if (!Array.isArray(body?.data) || body.data.length > 2000) throw copilotError("COPILOT_DISCOVERY_INVALID", 502);
  const seen = new Set();
  return body.data.map(item => {
    if (!token(item?.id) || item.id.length > 256 || seen.has(item.id) || item.id.includes("*")) {
      throw copilotError("COPILOT_DISCOVERY_INVALID", 502);
    }
    seen.add(item.id);
    const native = Object.entries(COPILOT_ROUTES).filter(([, path]) =>
      Array.isArray(item.supported_endpoints) && item.supported_endpoints.includes(path)).map(([key]) => key);
    const routes = native.length ? Object.fromEntries(Object.keys(COPILOT_ROUTES).map(key =>
      [key, native.includes(key) ? key : native[0]])) : {};
    return { id: item.id, name: typeof item.name === "string" ? item.name.slice(0, 256) : item.id,
      vendor: typeof item.vendor === "string" ? item.vendor.slice(0, 128) : "",
      selectable: (item.model_picker_enabled === undefined || item.model_picker_enabled === true) && native.length > 0, routes };
  });
}

async function boundedJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw copilotError("COPILOT_RESPONSE_TOO_LARGE", 502);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw copilotError("COPILOT_RESPONSE_INVALID", 502); }
}

export function createCopilotTransport({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  function application(profile) {
    if (!allowedProfile(profile)) throw copilotError("COPILOT_PROFILE_INVALID");
    const id = env[`COPILOT_${profile.toUpperCase()}_CLIENT_ID`];
    if (!token(id) || id === env[`COPILOT_${profile === "vscode" ? "OPENCODE" : "VSCODE"}_CLIENT_ID`]) {
      throw copilotError("COPILOT_APPLICATION_NOT_CONFIGURED", 503);
    }
    return id;
  }
  async function json(url, signal, { form, authorization } = {}) {
    const headers = { accept: "application/json", "user-agent": "AOAI-Proxy" };
    if (authorization) headers.authorization = authorization;
    const options = { method: form ? "POST" : "GET", headers, redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) };
    if (form) options.body = new URLSearchParams(form);
    try {
      const response = await fetchImpl(url, options);
      if (!response.ok) {
        await response.body?.cancel();
        const error = copilotError(`COPILOT_HTTP_${response.status}`, 502);
        const wait = response.headers.get("retry-after");
        if (wait) error.retryAt = /^\d+$/.test(wait) ? now() + Number(wait) * 1000 : Date.parse(wait);
        throw error;
      }
      return await boundedJson(response);
    } catch (error) {
      if (error?.code?.startsWith?.("COPILOT_")) throw error;
      throw copilotError("COPILOT_NETWORK_UNAVAILABLE", 503);
    }
  }
  function normalizeOAuth(data) {
    if (!token(data.access_token) || (data.token_type && data.token_type.toLowerCase() !== "bearer")
      || (data.expires_in != null && !seconds(data.expires_in))
      || (data.refresh_token != null && !token(data.refresh_token))) throw copilotError("COPILOT_TOKEN_METADATA_INVALID", 502);
    return { accessToken: data.access_token, issuedAt: now(), expiresAt: data.expires_in ? now() + data.expires_in * 1000 : null,
      refreshToken: data.refresh_token || null };
  }
  return {
    application,
    async start(profile, signal) {
      const data = await json(`${LOGIN}/device/code`, signal, { form: { client_id: application(profile), scope: "read:user" } });
      if (!token(data.device_code) || !token(data.user_code) || data.user_code.length > 64
        || data.verification_uri !== `${LOGIN}/device` || !seconds(data.expires_in)
        || (data.interval !== undefined && !seconds(data.interval))) throw copilotError("COPILOT_DEVICE_RESPONSE_INVALID", 502);
      return { deviceCode: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri,
        expiresAt: now() + Math.min(data.expires_in, 1800) * 1000, interval: (data.interval ?? 5) * 1000 };
    },
    async poll(profile, deviceCode, signal) {
      const data = await json(`${LOGIN}/oauth/access_token`, signal, { form: { client_id: application(profile),
        device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" } });
      if (data.error === "authorization_pending" || data.error === "slow_down") return { pending: data.error };
      if (data.error) throw copilotError(data.error === "expired_token" ? "COPILOT_DEVICE_EXPIRED" : "COPILOT_AUTH_DENIED", 403);
      return normalizeOAuth(data);
    },
    async refreshOAuth(profile, previous, signal) {
      if (!previous.refreshToken) throw copilotError("COPILOT_AUTH_REQUIRED", 401);
      const data = await json(`${LOGIN}/oauth/access_token`, signal, { form: { client_id: application(profile),
        grant_type: "refresh_token", refresh_token: previous.refreshToken } });
      if (data.error) throw copilotError("COPILOT_AUTH_REQUIRED", 401);
      return normalizeOAuth(data);
    },
    async subject(oauth, signal) {
      const data = await json(`${GH}/user`, signal, { authorization: `Bearer ${oauth.accessToken}` });
      if (!Number.isSafeInteger(data.id) || data.id <= 0) throw copilotError("COPILOT_SUBJECT_INVALID", 502);
      return String(data.id);
    },
    async inferenceCredential(profile, oauth, signal) {
      application(profile);
      if (profile === "opencode") return { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? null, issuedAt: oauth.issuedAt };
      const data = await json(`${GH}/copilot_internal/v2/token`, signal, { authorization: `token ${oauth.accessToken}` });
      const expiresAt = Number.isSafeInteger(data.expires_at) ? data.expires_at * 1000 :
        typeof data.expires_at === "string" && /^\d{4}-\d\d-\d\dT/.test(data.expires_at) ? Date.parse(data.expires_at) : NaN;
      if (!token(data.token) || !Number.isSafeInteger(expiresAt) || expiresAt <= now() + 10000 || expiresAt > now() + 31536000000
        || (data.refresh_in != null && !seconds(data.refresh_in))) throw copilotError("COPILOT_TOKEN_METADATA_INVALID", 502);
      return { token: data.token, issuedAt: now(), expiresAt, refreshAt: data.refresh_in ? now() + 1000 * data.refresh_in : null };
    },
    async discover(credential, signal) {
      return discoveryModels(await json(`${COPILOT_ORIGIN}/models`, signal, { authorization: `Bearer ${credential.token}` }));
    }
  };
}
