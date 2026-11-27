import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { COPILOT_ORIGIN, COPILOT_ROUTES, copilotError, copilotIdentityHeaders, createCopilotTransport } from "./copilot-provider.js";
import { approveCopilotSelection, grantSignature, retainedCopilotApproval, verifyCopilotAdmission } from "./copilot-approval.js";
import { channelCredentialStore, closeChannelCredentials } from "./copilot-storage.js";
import { recordChannelOperation } from "./channel-operations.js";

const freshFor = 15 * 60 * 1000;
const receipt = Symbol("credential version");
const refOf = up => ({ channelId: up.channelId, profile: up.copilot.authProfile, credentialRef: up.auth.credentialRef });
const keyOf = ref => JSON.stringify([ref.channelId, ref.profile, ref.credentialRef]);
const due = (c, now, jitter = 0) => c?.expiresAt != null && (!Number.isFinite(c.expiresAt)
  || now >= Math.min(c.expiresAt - Math.min(120000, (c.expiresAt - c.issuedAt) * 0.2), c.refreshAt ?? Infinity)
    - Math.min(jitter, (c.expiresAt - c.issuedAt) * 0.02));
const usable = (c, now) => !!c?.token && (c.expiresAt == null || c.expiresAt > now + 5000);
const safeCode = error => /^COPILOT_[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "COPILOT_STATE_UNAVAILABLE";
const isAuthError = code => ["COPILOT_AUTH_REQUIRED", "COPILOT_HTTP_401", "COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED"].includes(code);

export class CopilotRuntime {
  constructor({ storage, transport = createCopilotTransport(), emit, reclaim, now = Date.now, wait = sleep }) {
    Object.assign(this, { storage, transport, emit, reclaim, now, wait });
    this.sessions = new Map();
    this.entries = new Map();
    this.work = new Set();
    this.controller = new AbortController();
    this.unverified = new WeakSet();
  }
  event(ref, event, fields = {}) {
    this.emit?.(this.config, { event, channelId: ref.channelId, authProfile: ref.profile,
      ...(event.startsWith("admin.") ? { trigger: "manual" } : {}), ...fields });
  }
  tracked(promise) {
    this.work.add(promise);
    promise.then(() => this.work.delete(promise), () => this.work.delete(promise));
    return promise;
  }
  entry(ref) {
    const key = keyOf(ref);
    let e = this.entries.get(key);
    if (!e) {
      if (this.entries.size >= 256) throw copilotError("COPILOT_CONNECTION_LIMIT", 429);
      e = { ref, controller: new AbortController(), lastUsed: this.now(), jitter: randomInt(0, 1001) };
      this.entries.set(key, e);
    }
    e.lastUsed = this.now();
    return e;
  }
  apply(config) {
    const formerlyActive = this.active;
    this.config = config;
    this.active = new Map(config.upstreams.filter(up => up.provider === "github-copilot" && up.status !== "disabled" && !this.unverified.has(up))
      .map(up => { const ref = refOf(up); return [keyOf(ref), ref]; }));
    for (const [k, e] of this.entries) if (!this.active.has(k) && (formerlyActive?.has(k) || !this.sessionOwns(e.ref))) {
      e.controller.abort();
      this.entries.delete(k);
    }
    this.schedule();
  }
  sessionOwns(ref) {
    const s = this.sessions.get(ref.channelId);
    return s?.credentialRef === ref.credentialRef && s.profile === ref.profile;
  }
  schedule() {
    if (this.timer || this.controller.signal.aborted || (!this.active?.size && !this.sessions.size)) return;
    this.timer = setInterval(() => {
      if (!this.ticking) this.ticking = this.tracked(this.tick()).finally(() => { this.ticking = null; });
    }, 30000);
    this.timer.unref();
  }
  async tick() {
    for (const [id, s] of this.sessions) {
      if (s.state !== "pending" && this.now() - s.touched > 30 * 60000) {
        if (s.prepared && this.reclaim) {
          try { await this.reclaim(s.prepared); }
          catch (error) {
            this.event(s, "admin.copilot_auth_failed", { operationId: s.operationId, errorCode: safeCode(error), stateAfter: "unavailable" });
            s.touched = this.now();
            continue;
          }
        }
        if (this.sessions.get(id) === s) this.sessions.delete(id);
      }
    }
    for (const [k, e] of this.entries) if (!this.active?.has(k) && !this.sessionOwns(e.ref) && this.now() - e.lastUsed > freshFor) {
      e.controller.abort();
      this.entries.delete(k);
    }
    // Bound background fan-out; requests share these same refresh/discovery promises.
    const refs = [...(this.active?.values() || [])];
    for (let i = 0; i < refs.length && !this.controller.signal.aborted; i += 4) {
      await Promise.all(refs.slice(i, i + 4).map(async ref => {
        try {
          const entry = this.entry(ref);
          await this.credential(ref, false, { trigger: "scheduled" });
          if ((!entry.discovery?.at || this.now() - entry.discovery.at >= freshFor || entry.discovery.state === "failed")
            && !(entry.discoverRetry > this.now())) await this.discover(ref, { trigger: "scheduled" });
        } catch (error) {
          this.setError(ref, safeCode(error), { trigger: "scheduled" });
        }
      }));
    }
    if (!this.active?.size && !this.sessions.size) { clearInterval(this.timer); this.timer = null; }
  }
  setError(ref, code, context) {
    const e = this.entries.get(keyOf(ref));
    if (e && e.errorCode !== code) {
      e.errorCode = code;
      this.event(ref, isAuthError(code) ? "proxy.copilot_auth_required" : "proxy.copilot_token_refresh_failed",
        { errorCode: code, operationId: randomUUID(), ...context,
          stateAfter: isAuthError(code) ? "reauth-required" : "failed" });
    }
  }
  async login(channelId, profile, credentialRef) {
    this.transport.application(profile);
    const ref = { channelId, profile, credentialRef };
    const store = await this.storage(this.config);
    const configured = this.config?.upstreams.find(up => up.channelId === channelId);
    if (configured && (configured.provider !== "github-copilot" || configured.copilot.authProfile !== profile
      || configured.auth.credentialRef !== credentialRef)) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
    // The store permanently binds the channel ID to its first subject/profile, even after revocation.
    const previous = credentialRef && !configured ? await store.identity(ref) : null;
    if (this.sessions.get(channelId)?.state === "pending") throw copilotError("COPILOT_LOGIN_IN_PROGRESS", 409);
    if (!this.sessions.has(channelId) && this.sessions.size >= 64) throw copilotError("COPILOT_LOGIN_LIMIT", 429);
    const session = { channelId, profile, operationId: randomUUID(), state: "pending",
      touched: this.now(), controller: new AbortController() };
    this.sessions.set(channelId, session);
    this.schedule();
    try {
      const device = await this.transport.start(profile, session.controller.signal);
      session.controller.signal.throwIfAborted();
      session.expiresAt = device.expiresAt;
      this.event(ref, "admin.copilot_auth_started", { operationId: session.operationId });
      this.tracked(this.poll(store, session, previous, device));
      return { operationId: session.operationId, expiresAt: new Date(device.expiresAt).toISOString(),
        verificationUri: device.verificationUri, userCode: device.userCode };
    } catch (error) {
      if (!session.controller.signal.aborted) this.failLogin(session, error);
      throw error;
    }
  }
  failLogin(s, error) {
    s.errorCode = safeCode(error);
    s.state = s.errorCode === "COPILOT_DEVICE_EXPIRED" ? "expired" : "failed";
    s.touched = this.now();
    this.event(s, "admin.copilot_auth_failed", { operationId: s.operationId, errorCode: s.errorCode, stateAfter: s.state });
  }
  async poll(store, s, previous, device) {
    const signal = s.controller.signal;
    let interval = device.interval;
    const live = () => {
      signal.throwIfAborted();
      if (this.now() >= device.expiresAt) throw copilotError("COPILOT_DEVICE_EXPIRED");
    };
    try {
      for (;;) {
        await this.wait(Math.min(interval, Math.max(0, device.expiresAt - this.now())), undefined, { signal });
        live();
        const oauth = await this.transport.poll(s.profile, device.deviceCode, signal);
        live();
        if (oauth.pending) {
          if (oauth.pending === "slow_down") interval += 5000;
          continue;
        }
        const subject = await this.transport.subject(s.profile, oauth, signal);
        if (previous && subject !== previous.subject) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
        const inference = await this.transport.inferenceCredential(s.profile, oauth, signal);
        live();
        const prepared = await store.prepare({ channelId: s.channelId, profile: s.profile, subject },
          { oauth, inference, applicationId: this.transport.application(s.profile), approvalKey: randomBytes(32).toString("base64url") });
        if (signal.aborted || this.now() >= device.expiresAt) {
          await store.discard(prepared);
          live();
        }
        s.credentialRef = prepared.credentialRef;
        s.prepared = prepared;
        s.state = "authorized";
        s.touched = this.now();
        this.event(s, "admin.copilot_auth_completed", { operationId: s.operationId, stateAfter: s.state });
        try { await this.discover(s, { trigger: "manual", operationId: s.operationId }); } catch { /* discovery failure is recorded separately */ }
        return;
      }
    } catch (error) {
      if (!signal.aborted) this.failLogin(s, error);
    }
  }
  cancel(ref, operationId) {
    const s = this.sessions.get(ref.channelId);
    if (!s || s.profile !== ref.profile || s.operationId !== operationId || s.state !== "pending") throw copilotError("COPILOT_OPERATION_MISMATCH", 409);
    s.controller.abort();
    s.state = "cancelled";
    this.event(ref, "admin.copilot_auth_cancelled", { operationId });
  }
  async activateChanges(config) {
    const changed = config.upstreams.filter(up => up.provider === "github-copilot" && up.status !== "disabled"
      && !this.unverified.has(up) && !this.active?.has(keyOf(refOf(up))));
    if (!changed.length) return;
    const store = await this.storage(config);
    const candidates = [];
    for (const up of changed) {
      const ref = refOf(up);
      const row = await store.read(ref, true);
      if (row.secrets.applicationId !== this.transport.application(ref.profile)
        || up.copilot.approval?.grant !== grantSignature(row.secrets.approvalKey, up)) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
      candidates.push({ ref, generation: row.generation });
    }
    await store.activateMany(candidates);
  }
  async credential(ref, management = false, context = {}) {
    const e = this.entry(ref);
    if (e.refresh) await e.refresh;
    const store = await this.storage(this.config);
    const row = await store.read(ref, management);
    if (row.secrets.applicationId !== this.transport.application(ref.profile)) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 403);
    let { oauth, inference } = row.secrets;
    if (e.rejectedVersion === row.credentialVersion) throw copilotError("COPILOT_AUTH_REQUIRED", 503);
    const oauthDue = due(oauth, this.now(), e.jitter) && (!!oauth.refreshToken || oauth.expiresAt <= this.now() + 5000);
    if (usable(inference, this.now()) && (!due(inference, this.now(), e.jitter) || (ref.profile === "opencode" && !oauth.refreshToken)) && !oauthDue) return row;
    if (row.state === "prepared") {
      if (usable(inference, this.now())) return row;
      throw copilotError("COPILOT_CANDIDATE_EXPIRED", 409);
    }
    if (e.retryAt > this.now()) {
      if (usable(inference, this.now()) && !isAuthError(e.errorCode)) return row;
      throw copilotError(e.errorCode || "COPILOT_REFRESH_BACKOFF", 503);
    }
    if (!e.refresh) e.refresh = this.tracked((async () => {
      const signal = e.controller.signal;
      try {
        const rotating = oauthDue && !!oauth.refreshToken;
        const refreshed = await store.refresh(ref, row, async leaseSignal => {
          const refreshSignal = AbortSignal.any([signal, leaseSignal]);
          if (oauthDue) oauth = await this.transport.refreshOAuth(ref.profile, oauth, refreshSignal);
          inference = await this.transport.inferenceCredential(ref.profile, oauth, refreshSignal);
          if (!usable(inference, this.now())) throw copilotError("COPILOT_AUTH_REQUIRED", 401);
          signal.throwIfAborted();
          return { ...row.secrets, oauth, inference };
        }, rotating);
        const fields = { operationId: randomUUID(), ...context, credentialVersion: refreshed.credentialVersion, stateAfter: "ready" };
        if (isAuthError(e.errorCode)) this.event(ref, "proxy.copilot_auth_recovered", fields);
        this.event(ref, "proxy.copilot_token_refresh_succeeded", fields);
        e.errorCode = null;
        e.failures = 0;
        e.retryAt = null;
        return refreshed;
      } catch (error) {
        const code = safeCode(error);
        e.failures = (e.failures || 0) + 1;
        e.retryAt = Math.max(this.now() + Math.min(300000, 5000 * 2 ** Math.min(6, e.failures - 1)) + e.jitter,
          Number.isFinite(error.retryAt) ? error.retryAt : 0);
        this.setError(ref, code, context);
        if (isAuthError(code)) await store.invalidate(ref, row, true);
        if (!isAuthError(code) && usable(row.secrets.inference, this.now())) return store.read(ref);
        throw error;
      }
    })()).finally(() => { e.refresh = null; });
    return e.refresh;
  }
  async discover(ref, context = { trigger: "manual" }) {
    const e = this.entry(ref);
    if (e.discovering) return e.discovering;
    const operation = { operationId: randomUUID(), ...context };
    const previous = e.discovery;
    e.discovery = { ...e.discovery, state: "loading" };
    e.discovering = this.tracked((async () => {
      try {
        const row = await this.credential(ref, true, operation);
        let models;
        try { models = await this.transport.discover(ref.profile, row.secrets.inference, e.controller.signal); }
        catch (error) {
          if (safeCode(error) === "COPILOT_HTTP_401" && row.state === "active") {
            e.rejectedVersion = row.credentialVersion;
            await (await this.storage(this.config)).invalidate(ref, row);
          }
          throw error;
        }
        e.controller.signal.throwIfAborted();
        const generation = (previous?.generation || 0) + 1;
        e.discovery = { state: "fresh", at: this.now(), models, generation };
        if (previous?.state !== "fresh" || JSON.stringify(previous.models) !== JSON.stringify(models)) {
          const before = new Set((previous?.models || []).map(m => m.id)), after = new Set(models.map(m => m.id));
          this.event(ref, "proxy.copilot_models_refreshed", { ...operation, stateAfter: "fresh", modelCount: models.length, discoveryGeneration: generation,
            addedCount: after.difference(before).size, missingCount: before.difference(after).size });
        }
      } catch (error) {
        e.discovery = { ...e.discovery, state: "failed", errorCode: safeCode(error) };
        e.discoverRetry = Math.max(this.now() + 60000, Number.isFinite(error.retryAt) ? error.retryAt : 0);
        this.event(ref, "proxy.copilot_models_refresh_failed", { ...operation, errorCode: safeCode(error), stateAfter: "failed" });
        throw error;
      }
    })()).finally(() => { e.discovering = null; });
    return e.discovering;
  }
  async status(ref, operationId) {
    const session = this.sessions.get(ref.channelId);
    const s = session?.profile === ref.profile && (operationId ? operationId === session.operationId
      : !ref.credentialRef || session.credentialRef === ref.credentialRef) ? session : null;
    if (operationId && !s) throw copilotError("COPILOT_OPERATION_MISMATCH", 409);
    if (s) s.touched = this.now();
    const credentialRef = s?.credentialRef || ref.credentialRef;
    const scoped = { ...ref, credentialRef };
    const e = this.entries.get(keyOf(scoped));
    let state = s?.state || "idle", errorCode = s?.errorCode || e?.errorCode;
    let expiresAt = null, renewable = null;
    if (credentialRef && (!s || s.state === "authorized")) {
      try {
        const row = await (await this.storage(this.config)).read(scoped, true);
        if (row.secrets.applicationId !== this.transport.application(scoped.profile)) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
        expiresAt = row.secrets.inference?.expiresAt ?? null;
        const oauth = row.secrets.oauth;
        renewable = !!oauth.refreshToken || (scoped.profile === "vscode" && (oauth.expiresAt == null || oauth.expiresAt > this.now()));
        if (e?.rejectedVersion === row.credentialVersion || (!renewable && !usable(row.secrets.inference, this.now()))) {
          errorCode = "COPILOT_AUTH_REQUIRED";
          state = "reauth-required";
        } else if (!usable(row.secrets.inference, this.now())) {
          state = "failed";
          errorCode ||= "COPILOT_TOKEN_UNAVAILABLE";
        } else {
          state = "authorized";
          if (isAuthError(errorCode)) errorCode = null;
        }
      } catch (error) { errorCode = safeCode(error); state = isAuthError(errorCode) ? "reauth-required" : "failed"; }
    }
    const d = e?.discovery;
    return { operationId: s?.operationId, state, credentialRef, errorCode, expiresAt, renewable, nextRetryAt: e?.retryAt,
      discovery: { generation: d?.generation, state: d?.state === "fresh" && this.now() - d.at >= freshFor ? "stale" : d?.state || "not_loaded",
        updatedAt: d?.at ? new Date(d.at).toISOString() : null, models: d?.models || [], errorCode: d?.errorCode } };
  }
  async prepare(config, previous, { rollback = false } = {}) {
    for (const up of config.upstreams.filter(up => up.provider === "github-copilot")) {
      const ref = refOf(up);
      const old = previous?.upstreams.find(item => item.channelId === ref.channelId && item.provider === up.provider);
      if (old && old.copilot.authProfile !== ref.profile) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
      const active = this.config?.upstreams.find(item => item.channelId === up.channelId);
      const retained = !rollback && !this.unverified.has(active) && retainedCopilotApproval(up, config.models, old, previous?.models);
      if (retained) { up.copilot.approval = retained; continue; }
      const store = await this.storage(this.config || config);
      const row = await store.read(ref, true);
      if (this.transport.application(ref.profile) !== row.secrets.applicationId) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
      const prior = old?.status === "disabled" && up.status !== "disabled" ? null : old?.copilot.approval;
      up.copilot.approval = approveCopilotSelection(row.secrets.approvalKey, up, config.models, prior, this.entries.get(keyOf(ref))?.discovery, this.now());
    }
  }
  async restore(config, cold) {
    let restricted = false;
    for (const up of config.upstreams.filter(up => up.provider === "github-copilot")) {
      const ref = refOf(up);
      let key;
      try {
        const row = await (await this.storage(this.config || config)).read(ref, true);
        if (row.secrets.applicationId !== this.transport.application(ref.profile)) throw copilotError("COPILOT_CREDENTIAL_MISMATCH", 409);
        key = row.secrets.approvalKey;
      } catch (error) {
        if (!cold) throw error;
        this.unverified.add(up);
        for (const model of config.models) if (model.selectedBinding?.channelId === up.channelId) model.status = "disabled";
        restricted = true;
        this.entry(ref).errorCode = safeCode(error);
        this.event(ref, "proxy.copilot_auth_required", { errorCode: safeCode(error), stateAfter: "unavailable" });
        continue;
      }
      const proof = up.copilot.approval;
      const verified = approveCopilotSelection(key, up, config.models, proof, null, this.now());
      if (!isDeepStrictEqual(proof, verified)) throw copilotError("COPILOT_GRANT_INVALID", 409);
    }
    return restricted;
  }
  async headers(up, targetUrl, model, requestId) {
    if (up?.provider !== "github-copilot" || !Object.values(COPILOT_ROUTES).some(path => targetUrl === COPILOT_ORIGIN + path
      && Object.values(model?.routes || {}).some(route => COPILOT_ROUTES[route] === path))) throw copilotError("COPILOT_ENDPOINT_INVALID", 403);
    const ref = refOf(up);
    const ongoing = this.entries.get(keyOf(ref))?.refresh;
    if (ongoing) await ongoing;
    if (!this.active?.has(keyOf(ref))) throw copilotError("COPILOT_AUTH_REQUIRED", 403);
    const current = await this.credential(ref, false, { trigger: "request", requestId });
    verifyCopilotAdmission(current.secrets.approvalKey, up, model);
    const headers = { ...copilotIdentityHeaders(ref.profile), authorization: `Bearer ${current.secrets.inference.token}` };
    Object.defineProperty(headers, receipt, { value: current.credentialVersion });
    return headers;
  }

  async rejected(up, headers, requestId) {
    const ref = refOf(up);
    const e = this.entry(ref);
    e.rejectedVersion = Math.max(e.rejectedVersion ?? 0, headers[receipt]);
    const store = await this.storage(this.config);
    const row = await store.read(ref);
    if (headers[receipt] !== row.credentialVersion || !row.secrets.inference || headers.authorization !== `Bearer ${row.secrets.inference.token}`) return;
    await store.invalidate(ref, row);
    this.setError(ref, "COPILOT_AUTH_REQUIRED", { trigger: "request", requestId });
  }
  async disconnect(ref, persisted) {
    for (const config of [this.config, persisted]) if (config?.models.some(model => model.selectedBinding?.channelId === ref.channelId)) {
      throw copilotError("COPILOT_MODEL_IN_USE", 409);
    }
    const store = await this.storage(this.config);
    await store.disconnect(ref);
    const s = this.sessions.get(ref.channelId);
    if (s?.profile === ref.profile) { s.controller.abort(); this.sessions.delete(ref.channelId); }
    const k = keyOf(ref);
    this.entries.get(k)?.controller.abort();
    this.entries.delete(k);
    this.event(ref, "admin.copilot_disconnected", { operationId: randomUUID() });
  }
  async close() {
    clearInterval(this.timer);
    this.controller.abort();
    for (const s of this.sessions.values()) s.controller.abort();
    for (const e of this.entries.values()) e.controller.abort();
    await Promise.allSettled([...this.work]);
  }
}

async function reclaimCandidate(ref) {
  const { getConfig, getPersistedConfig } = await import("./config.js");
  const { withModelCatalogUpdateLock } = await import("./model-catalog.js");
  const { getPersistenceSummary, readLatestPersistedConfigText } = await import("./persistence.js");
  await withModelCatalogUpdateLock(async () => {
    const config = getConfig(), persistence = getPersistenceSummary(config);
    if (persistence.configStoreMode !== "file" || persistence.pendingDatabaseSync) return;
    const inUse = cfg => cfg.upstreams.some(up => up.auth?.credentialRef === ref.credentialRef);
    if (inUse(config) || inUse(getPersistedConfig()) || inUse(JSON.parse(await readLatestPersistedConfigText()))) return;
    const store = await channelCredentialStore(config);
    try {
      const current = await store.read(ref, true);
      if (current.state === "prepared" && current.generation === ref.generation) await store.discard(ref);
    }
    catch (error) { if (!isAuthError(error.code)) throw error; }
  });
}

export const copilotRuntime = new CopilotRuntime({ storage: channelCredentialStore, emit: recordChannelOperation, reclaim: reclaimCandidate });
export { closeChannelCredentials };
