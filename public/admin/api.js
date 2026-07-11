function adminApiUrl(route) {
  return new URL(`./api/${route}`, window.location.href);
}

export async function getConfigApi() {
  const res = await fetch(adminApiUrl("config"));
  return res.json();
}

export async function saveConfigApi(nextConfig) {
  const res = await fetch(adminApiUrl("config"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextConfig)
  });
  return res.json();
}

export async function reloadConfigApi() {
  const res = await fetch(adminApiUrl("reload"), { method: "POST" });
  return res.json();
}

export async function getRuntimeApi() {
  const res = await fetch(adminApiUrl("runtime"));
  return res.json();
}

export async function verifyAadApi() {
  const res = await fetch(adminApiUrl("verify-aad"), { method: "POST" });
  return res.json();
}

export async function getStatsApi() {
  const res = await fetch(adminApiUrl("stats"));
  return res.json();
}

export async function getCaddyStatusApi() {
  const res = await fetch(adminApiUrl("caddy/status"));
  return res.json();
}

export async function restartServiceApi() {
  await fetch(adminApiUrl("restart"), { method: "POST" });
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
