async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.error || json?.message || response.statusText || "Request failed";
    throw new Error(message);
  }
  return json;
}

export async function fetchConfig() {
  return readJson(await fetch("/admin/api/config"));
}

export async function saveConfig(config) {
  return readJson(await fetch("/admin/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  }));
}

export async function reloadConfig() {
  return readJson(await fetch("/admin/api/reload", { method: "POST" }));
}

export async function fetchRuntime() {
  return readJson(await fetch("/admin/api/runtime"));
}

export async function syncRuntime() {
  return readJson(await fetch("/admin/api/runtime/sync", { method: "POST" }));
}

export async function fetchDatabaseConfig() {
  return readJson(await fetch("/admin/api/database/config"));
}

export async function testDatabaseConnection(payload = {}) {
  return readJson(await fetch("/admin/api/database/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export async function fetchPricingLibrary() {
  return readJson(await fetch("/admin/api/pricing-library"));
}

export async function validateConfiguredModels(payload = {}) {
  return readJson(await fetch("/admin/api/models/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
}

export async function syncPricingLibrary(source = {}) {
  return readJson(await fetch("/admin/api/pricing-library/sync", {
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
  return readJson(await fetch(query ? `/admin/api/stats?${query}` : "/admin/api/stats"));
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
  return readJson(await fetch(query ? `/admin/api/logs?${query}` : "/admin/api/logs"));
}

export async function fetchCaddyStatus() {
  return readJson(await fetch("/admin/api/caddy/status"));
}

export async function verifyAad() {
  return readJson(await fetch("/admin/api/verify-aad", { method: "POST" }));
}

export async function restartService() {
  return readJson(await fetch("/admin/api/restart", { method: "POST" }));
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
