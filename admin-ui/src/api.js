async function readJson(response) {
  const text = await response.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
  }
  if (!response.ok) {
    const errorValue = json?.error;
    const message = (typeof errorValue === "string" ? errorValue : errorValue?.message)
      || json?.message
      || text?.slice(0, 500)
      || response.statusText
      || "Request failed";
    const error = new Error(message);
    error.payload = json;
    error.status = response.status;
    throw error;
  }
  return json;
}

function getAdminBasePath() {
  if (typeof window === "undefined") return "/admin";
  const pathname = window.location?.pathname || "/admin/";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "/admin";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/admin";
}

function adminApiUrl(path) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${getAdminBasePath()}/api${suffix}`;
}

function adminFetch(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    ...(method === "GET" || method === "HEAD" ? {} : { "x-aoai-admin-csrf": "1" }),
    ...(options.headers || {})
  };
  return fetch(adminApiUrl(path), {
    ...options,
    headers
  });
}

export async function fetchConfig() {
  return readJson(await fetch(adminApiUrl("/config")));
}

export async function fetchApiKeySecret(id) {
  return readJson(await adminFetch("/keys/reveal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  }));
}

export async function saveConfig(config) {
  return readJson(await adminFetch("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  }));
}

export async function reloadConfig() {
  return readJson(await adminFetch("/reload", { method: "POST" }));
}

export async function fetchRuntime() {
  return readJson(await fetch(adminApiUrl("/runtime")));
}

export async function syncRuntime() {
  return readJson(await adminFetch("/runtime/sync", { method: "POST" }));
}

export async function fetchDatabaseConfig() {
  return readJson(await fetch(adminApiUrl("/database/config")));
}

export async function testDatabaseConnection(payload = {}) {
  return readJson(await adminFetch("/database/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export async function initializeLogAnalytics(payload = {}) {
  return readJson(await adminFetch("/log-analytics/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export async function fetchPricingLibrary() {
  return readJson(await fetch(adminApiUrl("/pricing-library")));
}

export async function validateConfiguredModels(payload = {}) {
  return readJson(await adminFetch("/models/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export async function syncPricingLibrary(source = {}) {
  return readJson(await adminFetch("/pricing-library/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(source)
  }));
}

export async function fetchStats(params = {}) {
  const search = new URLSearchParams();
  ["keyId", "timeRange"].forEach((key) => {
    const value = params[key];
    if (value != null && value !== "") {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  const url = adminApiUrl("/stats");
  return readJson(await fetch(query ? `${url}?${query}` : url));
}

export async function fetchLogs(params = {}) {
  const search = new URLSearchParams();
  if (Array.isArray(params.level) && params.level.length > 0) {
    search.set("level", params.level.join(","));
  }
  ["event", "modelId", "requestId", "keyword", "since", "limit"].forEach((key) => {
    const value = params[key];
    if (value != null && value !== "") {
      search.set(key, String(value));
    }
  });
  const query = search.toString();
  const url = adminApiUrl("/logs");
  return readJson(await fetch(query ? `${url}?${query}` : url));
}

export async function fetchCaddyStatus() {
  return readJson(await fetch(adminApiUrl("/caddy/status")));
}

export async function verifyAad() {
  return readJson(await adminFetch("/verify-aad", { method: "POST" }));
}

export async function restartService() {
  return readJson(await adminFetch("/restart", { method: "POST" }));
}

export async function sendProxyRequest(endpoint, payload, apiKey) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : ""
    },
    body: JSON.stringify(payload)
  });
}
