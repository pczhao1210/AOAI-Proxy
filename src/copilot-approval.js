import { createHmac } from "node:crypto";
import { COPILOT_ROUTES, copilotError } from "./copilot-provider.js";

function rowSignature(key, up, row, publicId) {
  const data = [1, up.channelId, up.copilot.authProfile, up.auth.credentialRef, row.sourceModelId,
    row.canonicalModelId, Object.keys(COPILOT_ROUTES).map(k => row.routes?.[k]), publicId ?? null];
  return createHmac("sha256", key).update(JSON.stringify(data)).digest("base64url");
}

export function verifyCopilotAdmission(key, up, model) {
  const row = up.modelMappings.find(r => r.enabled && r.sourceModelId === model?.selectedBinding?.sourceModelId);
  const proof = up.copilot.approval;
  if (!row || row.canonicalModelId !== model.canonicalModelId || model.selectedBinding.channelId !== up.channelId
    || proof?.rows?.[row.sourceModelId] !== rowSignature(key, up, row)
    || proof?.models?.[model.id] !== rowSignature(key, up, row, model.id)) throw copilotError("COPILOT_MODEL_NOT_ENABLED", 403);
}

export function approveCopilotSelection(key, up, models, previous, discovery, now = Date.now()) {
  const rows = new Map(up.modelMappings.filter(row => row.enabled).map(row => [row.sourceModelId, row]));
  const bySource = new Map((discovery?.models || []).map(model => [model.id, model]));
  const check = (row, old, publicId) => {
    const sig = rowSignature(key, up, row, publicId);
    if (sig === old) return sig;
    if (up.status === "disabled" || discovery?.state !== "fresh" || !(now - discovery.at < 900000)) {
      throw copilotError("COPILOT_DISCOVERY_STALE", 409);
    }
    const evidence = bySource.get(row.sourceModelId);
    if (!evidence?.selectable || Object.keys(COPILOT_ROUTES).some(k => row.routes?.[k] !== evidence.routes[k])) {
      throw copilotError("COPILOT_MODEL_NOT_ENABLED", 409);
    }
    return sig;
  };
  return {
    grant: grantSignature(key, up),
    rows: Object.fromEntries([...rows].map(([id, row]) => [id, check(row, previous?.rows?.[id])])),
    models: Object.fromEntries(models.filter(m => m.selectedBinding?.channelId === up.channelId).map(m => {
      const row = rows.get(m.selectedBinding.sourceModelId);
      if (!row || row.canonicalModelId !== m.canonicalModelId) throw copilotError("COPILOT_MODEL_NOT_ENABLED", 409);
      return [m.id, check(row, previous?.models?.[m.id], m.id)];
    }))
  };
}

export function grantSignature(key, up) {
  return createHmac("sha256", key).update(JSON.stringify(["connection-v1", up.channelId, up.auth.credentialRef, up.copilot.authProfile])).digest("base64url");
}

// Removing grants must still work when discovery or the credential store is offline.
export function retainedCopilotApproval(up, models, old, oldModels) {
  const proof = old?.copilot.approval;
  if (!proof?.grant || old.auth.credentialRef !== up.auth.credentialRef || old.copilot.authProfile !== up.copilot.authProfile
    || (old.status === "disabled" && up.status !== "disabled")) return null;
  const previous = new Map(old.modelMappings.filter(r => r.enabled).map(r => [r.sourceModelId, r]));
  const rows = new Map();
  for (const row of up.modelMappings.filter(r => r.enabled)) {
    const same = previous.get(row.sourceModelId);
    if (!same || row.canonicalModelId !== same.canonicalModelId || Object.keys(COPILOT_ROUTES).some(k => row.routes[k] !== same.routes[k])
      || typeof proof.rows?.[row.sourceModelId] !== "string") return null;
    rows.set(row.sourceModelId, proof.rows[row.sourceModelId]);
  }
  const before = new Map(oldModels.filter(m => m.selectedBinding?.channelId === up.channelId).map(m => [m.id, m]));
  const grants = new Map();
  for (const model of models.filter(m => m.selectedBinding?.channelId === up.channelId)) {
    const previousModel = before.get(model.id);
    if (previousModel?.selectedBinding.sourceModelId !== model.selectedBinding.sourceModelId || previousModel.canonicalModelId !== model.canonicalModelId
      || typeof proof.models?.[model.id] !== "string") return null;
    grants.set(model.id, proof.models[model.id]);
  }
  return { grant: proof.grant, rows: Object.fromEntries(rows), models: Object.fromEntries(grants) };
}
