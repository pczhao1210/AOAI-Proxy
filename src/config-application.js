import { appendStructuredLog } from "./logs.js";

export async function applyConfigurationStages(config, revision, handlers, stages = ["proxy", "caddy"]) {
  const results = {};
  for (const stage of stages) {
    try {
      const details = await handlers[stage](config);
      results[stage] = { ...details, ok: true, revision, appliedAt: new Date().toISOString() };
    } catch (error) {
      results[stage] = { ok: false, revision, error: error.message || `${stage} application failed` };
      appendStructuredLog("error", {
        source: "admin", event: "admin.config_apply_failed", stage, revision,
        failureReason: results[stage].error
      });
    }
  }
  return results;
}
