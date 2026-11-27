import { copilotError } from "./copilot-provider.js";

export function registerCopilotAdmin(app, runtime, { getConfig, getPersistedConfig, mutateConfiguration }) {
  for (const action of ["status", "login", "cancel", "discover", "disconnect"]) {
    const handler = async (req, reply) => {
      reply.header("Cache-Control", "no-store, private");
      const { channelId } = req.params;
      const input = (action === "status" ? req.query : req.body) || {};
      const { profile, credentialRef, operationId } = input;
      try {
        if (!getConfig().server.adminAuth?.enabled) throw copilotError("COPILOT_ADMIN_AUTH_REQUIRED", 403);
        if (action !== "status" && req.headers["x-aoai-admin-csrf"] !== "1") throw copilotError("COPILOT_CSRF_REQUIRED", 403);
        if (!/^[\w.-]{1,128}$/.test(channelId) || !["vscode", "opencode"].includes(profile)
          || Object.keys(input).some(k => !["profile", "credentialRef", "operationId"].includes(k))
          || [credentialRef, operationId].some(v => v != null && (typeof v !== "string" || v.length > 256))) {
          throw copilotError("COPILOT_INPUT_INVALID");
        }
        const ref = { channelId, profile, credentialRef };
        if (action === "status") return await runtime.status(ref, operationId);
        if (action === "login") return await runtime.login(channelId, profile, credentialRef);
        if (action === "cancel") runtime.cancel(ref, operationId);
        if (action === "discover") await runtime.discover(ref);
        if (action === "disconnect") await runtime.disconnect(ref, getPersistedConfig());
        return { ok: true };
      } catch (error) {
        const code = /^COPILOT_[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "COPILOT_STATE_UNAVAILABLE";
        return reply.code(error?.status || 503).send({ error: code, code });
      }
    };
    app[action === "status" ? "get" : "post"](`/admin/api/copilot/:channelId/${action}`,
      action === "disconnect" ? (req, reply) => mutateConfiguration(req, reply, () => handler(req, reply)) : handler);
  }
}
