// Never pass provider payloads, errors, secrets or whole config rows to a sink.
const events = new Map([
  ["admin.copilot_auth_started", "info"],
  ["admin.copilot_auth_completed", "info"],
  ["admin.copilot_auth_failed", "warn"],
  ["admin.copilot_auth_cancelled", "info"],
  ["admin.copilot_disconnected", "info"],
  ["proxy.copilot_token_refresh_succeeded", "info"],
  ["proxy.copilot_token_refresh_failed", "warn"],
  ["proxy.copilot_auth_required", "warn"],
  ["proxy.copilot_auth_recovered", "info"],
  ["proxy.copilot_models_refreshed", "info"],
  ["proxy.copilot_models_refresh_failed", "warn"],
  ["admin.channel_mappings_changed", "info"],
  ["admin.model_exposure_changed", "info"],
  ["admin.key_model_access_changed", "info"],
  ["admin.model_channel_changed", "info"]
]);

const states = ["idle", "pending", "authorized", "expires_soon", "expired", "failed", "cancelled", "disconnected",
  "reauth-required", "auth_required", "recovered", "refreshing", "ready", "prepared", "active", "revoked",
  "loading", "fresh", "stale", "not_loaded", "unavailable"];
const enums = {
  actor: ["admin", "system"],
  authProfile: ["vscode", "opencode"],
  trigger: ["manual", "scheduled", "request"],
  outcome: ["started", "succeeded", "failed", "cancelled", "persisted", "loaded", "applied", "apply_failed"],
  change: ["added", "removed", "updated", "summary"],
  modeBefore: ["all", "selected", "legacy"],
  modeAfter: ["all", "selected", "legacy"],
  stateBefore: states,
  stateAfter: states
};
const identifiers = [
  "operationId", "connectionId", "channelId", "requestId", "canonicalModelId", "sourceModelId", "modelId",
  "previousChannelId", "previousSourceModelId", "previousCanonicalModelId", "provider", "upstream",
  "previousUpstream", "historyId", "discoveryGeneration"
];
const integers = [
  "latencyMs", "credentialVersion", "authGeneration", "discoveryGeneration", "count", "addedCount",
  "missingCount", "modelCount", "removedCount", "omittedCount", "suppressedFailures", "failureCount"
];
const times = ["expiresAt", "nextRetryAt", "lastSuccessAt", "firstFailureAt"];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const secretPrefix = /^(?:gh[pousr]_|github_pat_|sk-|eyJ[A-Za-z0-9_-]+\.)/i;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/.test(value)
  && !value.includes("://") && !secretPrefix.test(value);

export const isChannelOperation = event => events.has(event);

export function operationFields(input, config) {
  if (!input || !events.has(input.event)) return null;
  const event = input.event;
  const source = event.split(".")[0];
  const result = { event, source, level: events.get(event), recordType: "operation", actor: source === "admin" ? "admin" : "system" };
  for (const [field, values] of Object.entries(enums)) {
    if (values.includes(input[field])) result[field] = input[field];
  }
  for (const field of identifiers) if (safeId(input[field])) result[field] = input[field];
  if (!result.connectionId && result.channelId) result.connectionId = result.channelId;
  if (typeof input.eventUid === "string" && uuid.test(input.eventUid)) result.eventUid = input.eventUid;
  if (typeof input.configRevision === "string" && /^[a-f0-9]{64}$/.test(input.configRevision)) result.configRevision = input.configRevision;
  if (typeof input.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(input.errorCode)) result.errorCode = input.errorCode;
  for (const field of integers) if (Number.isSafeInteger(input[field]) && input[field] >= 0) result[field] = input[field];
  for (const field of times) {
    if (typeof input[field] === "string" && input[field].length <= 35 && Number.isFinite(Date.parse(input[field]))) {
      result[field] = new Date(input[field]).toISOString();
    }
  }
  for (const field of ["pendingPublication", "usableToken", "stale", "enabledBefore", "enabledAfter"]) {
    if (typeof input[field] === "boolean") result[field] = input[field];
  }
  for (const field of ["addedModels", "removedModels"]) {
    if (Array.isArray(input[field])) result[field] = input[field].slice(0, 8).filter(safeId);
  }
  if (Array.isArray(input.changedFields)) {
    result.changedFields = ["canonicalModelId", "enabled", "routes", "pricing", "hostingMode"].filter(field => input.changedFields.includes(field));
  }
  if (config?.observability?.logs?.redactApiKeyInfo === false && safeId(input.keyRecordId)) result.keyRecordId = input.keyRecordId;
  return result;
}

export function operationLimit(value) {
  return Math.max(1, Math.min(100, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 50));
}
