export async function getConfigApi() {
  const res = await fetch("/admin/api/config");
  return res.json();
}

export async function saveConfigApi(nextConfig) {
  const res = await fetch("/admin/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextConfig)
  });
  return res.json();
}

export async function reloadConfigApi() {
  const res = await fetch("/admin/api/reload", { method: "POST" });
  return res.json();
}

export async function verifyAadApi() {
  const res = await fetch("/admin/api/verify-aad", { method: "POST" });
  return res.json();
}

export async function getStatsApi() {
  const res = await fetch("/admin/api/stats");
  return res.json();
}

export async function getCaddyStatusApi() {
  const res = await fetch("/admin/api/caddy/status");
  return res.json();
}

export async function restartServiceApi() {
  await fetch("/admin/api/restart", { method: "POST" });
}

export async function sendProxyRequestApi(endpoint, payload, apiKey) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : ""
    },
    body: JSON.stringify(payload)
  });
}
