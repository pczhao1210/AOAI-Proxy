import { realtimeError } from "./realtime-policy.js";
import { createMediaUsageTracker } from "./media-usage.js";
import { recordRequest } from "../stats.js";
import { recordRuntimeRequest } from "../runtime-store.js";
import { resolveMediaPricing, settleMediaUsage } from "./media-accounting.js";

export const DEFAULT_WEBRTC = Object.freeze({
  enabled: false,
  allowClientSecrets: false,
  maxCalls: 100,
  maxSetupBytes: 256 * 1024,
  maxResponseBytes: 256 * 1024,
  setupTimeoutMs: 15000,
  callTtlMs: 3600000,
  clientSecretTtlSeconds: 60
});

export function createRealtimeCallRegistry({ log }) {
  const calls = new Map();
  let pending = 0;
  let draining = false;
  const finish = record => {
    if (calls.get(record.callId) !== record) return;
    calls.delete(record.callId);
    clearTimeout(record.timer);
    for (const close of record.observers) close("WEBRTC_CALL_ENDED", 200, 1000);
    try {
      settleMediaUsage({ config: record.config, consumer: record.consumer || { keyId: record.keyId }, model: record.binding.model,
        usage: record.usageTracker.snapshot(), requestContext: record.context, routeKey: `${record.publicRouteKey}/calls`,
        backendRouteKey: record.binding.routeKey, completed: record.terminalObserved === true });
    } finally { record.lease.release(); }
  };
  return {
    reserve(maxCalls) {
      if (draining || calls.size + pending >= maxCalls) throw realtimeError(429, "WEBRTC_CAPACITY", "WebRTC capacity exceeded");
      pending += 1;
      let active = true;
      const release = () => { if (active) { active = false; pending -= 1; } };
      return {
        release,
        commit(record, ttlMs) {
          if (!active || draining || !record.keyId || calls.has(record.callId)) throw realtimeError(502, "INVALID_WEBRTC_CALL_ID", "Upstream call ID or owner is invalid");
          release();
          record.expiresAt = Date.now() + ttlMs;
          record.observers = new Set();
          record.pricing = resolveMediaPricing(record.config, record.binding.model, record.binding.upstream, null,
            record.binding.targetUrl?.replace(/^ws/, "http"));
          record.usageTracker = createMediaUsageTracker({ pricing: record.pricing });
          recordRequest(record.binding.model.id, { keyId: record.keyId });
          recordRuntimeRequest(record.config, { ...record.context, keyId: record.keyId, modelId: record.binding.model.id,
            routeKey: `${record.publicRouteKey}/calls`, stream: true });
          record.timer = setTimeout(async () => {
            for (const close of record.observers) close("WEBRTC_CALL_EXPIRED", 408, 1000);
            try {
              await record.terminate();
              finish(record);
            } catch {
              log.warn({ event: "proxy.webrtc_expiry_unconfirmed", modelId: record.binding.model.id }, "WebRTC termination could not be confirmed");
            }
          }, ttlMs);
          record.timer.unref();
          calls.set(record.callId, record);
          return record;
        }
      };
    },
    get(callId, consumer, routeKey, { allowExpired = false } = {}) {
      const record = calls.get(callId);
      if (!record || !consumer?.keyId || (!allowExpired && record.expiresAt <= Date.now()) || record.keyId !== consumer.keyId || record.publicRouteKey !== routeKey) {
        throw realtimeError(404, "WEBRTC_CALL_NOT_FOUND", "Call not found");
      }
      return record;
    },
    finish,
    async close() {
      draining = true;
      await Promise.allSettled([...calls.values()].map(async record => {
        try { await record.terminate(); } catch {
          log.warn({ event: "proxy.webrtc_shutdown_unconfirmed", modelId: record.binding.model.id }, "WebRTC termination could not be confirmed during shutdown");
        } finally { finish(record); }
      }));
    }
  };
}