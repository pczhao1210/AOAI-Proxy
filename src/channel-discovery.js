import { readTextWithTimeout } from "./proxy/reliability.js";

export async function discoverOrdinaryChannel(config, id, fetchImpl = fetch) {
  const up = config.upstreams.find(item => item.channelId === id);
  if (!up || up.status === "disabled" || up.provider !== "openai" || up.auth?.mode !== "apiKey" || !up.auth.apiKey
    || !/^https:\/\/api\.openai\.com(?:\/v1)?\/?$/.test(up.baseUrl)) {
    throw Object.assign(new Error("Deployment discovery is unavailable for this channel; enter the exact deployment name."), {
      code: "CHANNEL_DISCOVERY_NOT_SUPPORTED", status: 400
    });
  }
  try {
    const response = await fetchImpl("https://api.openai.com/v1/models", { redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${up.auth.apiKey}`, accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body = JSON.parse(await readTextWithTimeout(response, 15000, 2 * 1024 * 1024));
    if (body.object !== "list" || !Array.isArray(body.data) || body.data.length > 2000 || body.has_more === true) throw new Error();
    const seen = new Set();
    const models = body.data.map(item => {
      if (item?.object !== "model" || typeof item.id !== "string" || !/^[^\s*\x00-\x1f\x7f]{1,256}$/.test(item.id) || seen.has(item.id)) throw new Error();
      seen.add(item.id);
      return { id: item.id };
    });
    return { channelId: id, models, updatedAt: new Date().toISOString() };
  } catch {
    throw Object.assign(new Error("Trusted model list could not be retrieved or validated."), { code: "CHANNEL_DISCOVERY_FAILED", status: 502 });
  }
}
