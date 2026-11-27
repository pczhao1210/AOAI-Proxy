import { useEffect, useState } from "react";
import { fetchCopilotStatus } from "../../api.js";
import { copilotIdentity, discoveryDeadline, isCopilotChannel, selectableModels } from "../../copilot.js";

export function useCopilotEvidence(upstreams, enabled) {
  const [snapshot, setSnapshot] = useState({ signature: "", evidence: new Map(), error: "" });
  const channels = upstreams.filter(isCopilotChannel);
  const signature = JSON.stringify(channels.map(up => [copilotIdentity(up), up.status]));
  useEffect(() => {
    if (!enabled || !channels.length) return;
    const controller = new AbortController();
    let timer;
    async function refresh() {
      setSnapshot({ signature, evidence: new Map(), error: "" });
      const evidence = new Map();
      const errors = [];
      let nextRefresh = 30000;
      await Promise.all(channels.map(async up => {
        if (!up.auth?.credentialRef) return;
        try {
          const status = await fetchCopilotStatus(up.channelId, { profile: up.copilot?.authProfile, credentialRef: up.auth.credentialRef }, controller.signal);
          evidence.set(copilotIdentity(up), selectableModels(up, status));
          const remaining = discoveryDeadline(status) - Date.now();
          if (status.discovery?.state === "fresh" && remaining > 0) nextRefresh = Math.min(nextRefresh, remaining);
        } catch (error) {
          if (!controller.signal.aborted) errors.push(`${up.name}: ${error.message}`);
        }
      }));
      if (controller.signal.aborted) return;
      setSnapshot({ signature, evidence, error: errors.join("; ") });
      timer = setTimeout(refresh, nextRefresh);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [signature, enabled]);
  return snapshot.signature === signature && enabled ? snapshot : { evidence: new Map(), error: "" };
}
