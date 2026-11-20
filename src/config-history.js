import { createHash, randomUUID } from "node:crypto";
import { redactConfigSecrets } from "./admin-config.js";

export const CONFIG_HISTORY_LIMIT = 12;

export function configurationRevision(config) {
  const text = JSON.stringify(config, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value);
  return createHash("sha256").update(text).digest("hex");
}

export function createHistoryEntry(text, { actor = "system", action = "save", restoredFrom = null } = {}) {
  const config = JSON.parse(text);
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    actor: String(actor).slice(0, 128),
    action,
    restoredFrom,
    revision: configurationRevision(config),
    config: redactConfigSecrets(config),
    apply: null
  };
}

export function parseConfigHistory(value) {
  if (!Array.isArray(value) || value.some(entry => !entry?.id || !entry?.revision || !entry?.config || typeof entry.config !== "object")) {
    throw new Error("Configuration history is malformed");
  }
  return value.slice(-CONFIG_HISTORY_LIMIT);
}

export function appendHistory(entries, entry) {
  return [...entries.filter(previous => previous.id !== entry.id), entry].slice(-CONFIG_HISTORY_LIMIT);
}

export function includeCurrentHistory(entries, text) {
  if (text == null || entries.at(-1)?.revision === configurationRevision(JSON.parse(text))) return entries;
  return appendHistory(entries, createHistoryEntry(text, { action: "baseline" }));
}
