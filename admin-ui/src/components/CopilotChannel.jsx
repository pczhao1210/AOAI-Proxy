import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { fetchCopilotStatus, runCopilotAction } from "../api.js";
import { copilotIdentity, discoveredRoutes, discoveryDeadline, matchesDiscoveredRoutes, selectableModels } from "../copilot.js";
import { Field } from "./ui.jsx";

const verificationUri = "https://github.com/login/device";
const authStates = ["idle", "pending", "authorized", "cancelled", "expired", "failed", "disconnected", "reauth-required"];
const discoveryStates = ["not_loaded", "loading", "fresh", "stale", "failed"];

function publicStatus(value) {
  if (!authStates.includes(value?.state)) throw new Error();
  for (const id of [value.operationId, value.credentialRef]) {
    if (id != null && (typeof id !== "string" || !id || id.length > 256)) throw new Error();
  }
  const discovery = value.discovery || {};
  const timestamp = n => Number.isSafeInteger(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString() : "";
  return {
    state: value.state, operationId: value.operationId, credentialRef: value.credentialRef,
    expiresAt: timestamp(value.expiresAt), nextRetryAt: timestamp(value.nextRetryAt),
    renewable: typeof value.renewable === "boolean" ? value.renewable : null,
    errorCode: safeErrorCode(value.errorCode || discovery.errorCode),
    discovery: {
      state: discoveryStates.includes(discovery.state) ? discovery.state : "not_loaded",
      updatedAt: discovery.updatedAt,
      models: (Array.isArray(discovery.models) ? discovery.models : []).filter(model => typeof model?.id === "string")
        .map(model => ({ id: model.id, name: typeof model.name === "string" ? model.name : "", vendor: typeof model.vendor === "string" ? model.vendor : "",
          selectable: model.selectable, routes: discoveredRoutes(model) }))
    }
  };
}

function safeErrorCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z_0-9]{0,80}$/.test(value) ? value : "";
}

function DiscoveryPicker({ up, definitions, snapshot, allowed, edit, t }) {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [choices, setChoices] = useState(new Map());
  const catalogIds = new Set(definitions.map(card => card.id));
  const mappings = Array.isArray(up.modelMappings) ? up.modelMappings : [];
  const rows = new Map(mappings.filter(row => typeof row?.sourceModelId === "string").map(row => [row.sourceModelId, row]));
  const models = new Map(snapshot?.discovery.models.map(model => [model.id, model]));
  const ids = new Set([...models.keys(), ...rows.keys()]);
  const filter = search.trim().toLowerCase();
  return <fieldset className="mapping-editor"><legend>{t("channel.mappings")}</legend>
    <p>{t("copilot.mappingHint")}</p>
    <p>{t("copilot.discovery")}: {t(`copilot.state.${snapshot?.discovery.state || "not_loaded"}`)}
      {snapshot?.discovery.updatedAt && <> · <time>{snapshot.discovery.updatedAt}</time></>}
      {" · "}{t("copilot.discovered")}: {models.size} · {t("copilot.selected")}: {[...rows.values()].filter(row => row.enabled).length}</p>
    <div className="toolbar-cluster">
      <Field label={t("copilot.search")}><input type="search" value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <label><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} /> {t("copilot.selectedOnly")}</label>
    </div>
    {!ids.size ? <p className="empty-state">{t("ui.copilotModelsEmpty")}</p> : <div className="table-scroll"><table className="mapping-table">
      <thead><tr><th>{t("channel.source")}</th><th>{t("channel.canonical")}</th><th>{t("field.status")}</th><th>{t("ui.actions")}</th></tr></thead>
      <tbody>{[...ids].map(id => {
      const model = models.get(id);
      const row = rows.get(id);
      const checked = row?.enabled === true;
      if (selectedOnly && !checked || !`${id} ${model?.name || ""}`.toLowerCase().includes(filter)) return null;
      const canonical = choices.get(id) ?? row?.canonicalModelId ?? (catalogIds.has(id) ? id : "");
      const routes = allowed.get(id);
      return <tr key={id}>
        <td><label className="inline"><input type="checkbox" checked={checked} disabled={!Array.isArray(up.modelMappings) || (!checked && !(routes && catalogIds.has(canonical)))}
          onChange={event => {
            const enabled = event.target.checked;
            if (enabled && (!routes || !catalogIds.has(canonical))) return;
            edit(channel => {
              const current = channel.modelMappings?.find(entry => entry?.sourceModelId === id);
              if (!enabled) { if (current) current.enabled = false; return; }
              const mapping = { sourceModelId: id, canonicalModelId: canonical, routes: { ...routes }, enabled: true };
              if (current) Object.assign(current, mapping);
              else channel.modelMappings.push(mapping);
            });
          }} /> <code>{id}</code>{model?.name && model.name !== id && ` · ${model.name}`}</label></td>
        <td><select aria-label={`${t("channel.canonical")} · ${id}`} value={canonical}
          disabled={checked || !routes} onChange={e => {
            const value = e.target.value;
            setChoices(prev => new Map(prev).set(id, value));
          }}><option value="">—</option>{canonical && !catalogIds.has(canonical) ? <option value={canonical}>{canonical}</option> : null}
          {definitions.map(card => <option key={card.id}>{card.id}</option>)}</select></td>
        <td><small>{!routes ? t("copilot.unavailable") : !catalogIds.has(canonical) ? t("copilot.needCatalog")
          : checked && !matchesDiscoveredRoutes(row, routes) ? t("copilot.routesChanged") : null}
          {model?.vendor && <> {model.vendor} ·</>}
          {model?.routes && <> {Object.entries(model.routes).map(([key, target]) => `${key} → ${target}`).join(" · ")}</>}</small></td>
        <td>{row && !checked && <button type="button" className="ghost" onClick={() => edit(channel => {
          channel.modelMappings = channel.modelMappings.filter(entry => entry?.sourceModelId !== id);
        })}>{t("entity.delete")}</button>}</td>
      </tr>;
    })}</tbody></table></div>}
  </fieldset>;
}

export default function CopilotChannel({ up, saved, tickets, definitions, referenced, updateConfig, onEvidence, section, t }) {
  const identity = copilotIdentity(up);
  const profile = up.copilot?.authProfile;
  const credentialRef = up.auth?.credentialRef;
  const valid = !!up.channelId && ["vscode", "opencode"].includes(profile)
    && up.provider === "github-copilot" && up.auth?.mode === "githubCopilot";
  const [snapshot, setSnapshot] = useState(null);
  const [device, setDevice] = useState(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const operation = useRef(tickets?.get(identity) || "");
  const remember = id => {
    operation.current = id;
    if (id) tickets?.set(identity, id);
    else tickets?.delete(identity);
  };
  const unboundApprovals = !credentialRef && Array.isArray(up.modelMappings) && up.modelMappings.some(row => row?.enabled);
  const request = useRef(null);
  const edit = change => updateConfig(next => {
    const channel = next.upstreams?.find(item => copilotIdentity(item) === identity);
    if (channel) change(channel);
  });

  async function run(action) {
    if (!valid) return;
    request.current?.abort();
    const controller = new AbortController();
    const { signal } = controller;
    request.current = controller;
    const current = () => !signal.aborted && request.current === controller;
    let expected = operation.current;
    const params = () => ({ profile, credentialRef, operationId: expected || undefined });
    onEvidence(identity, null);
    setBusy(action);
    setError("");
    try {
      if (action !== "status") {
        const result = await runCopilotAction(up.channelId, action, action === "login" ? { profile, credentialRef } : params(), signal);
        if (!current()) return;
        if (action === "login") {
          const expires = Date.parse(result.expiresAt);
          if (typeof result.operationId !== "string" || !result.operationId || typeof result.userCode !== "string"
            || !result.userCode || result.userCode.length > 64 || result.verificationUri !== verificationUri || !(expires > Date.now())) throw new Error();
          expected = result.operationId;
          remember(expected);
          setNow(Date.now());
          setDevice({ code: result.userCode, expires });
        } else {
          if (result.ok !== true) throw new Error();
          if (action === "cancel" || action === "disconnect") {
            expected = "";
            remember("");
            setDevice(null);
            setSnapshot(null);
          }
          if (action === "disconnect" && credentialRef !== saved?.auth?.credentialRef) {
            edit(channel => { delete channel.auth.credentialRef; });
            return;
          }
        }
        setBusy("status");
      }
      const status = publicStatus(await fetchCopilotStatus(up.channelId, params(), signal));
      if (!current()) return;
      if (status.discovery.state === "fresh" && !(discoveryDeadline(status) > Date.now())) status.discovery.state = "stale";
      if (expected && status.operationId !== expected) throw Object.assign(new Error(), { code: "COPILOT_OPERATION_MISMATCH" });
      if (status.state === "pending" && !status.operationId) throw new Error();
      if (credentialRef && status.credentialRef && status.credentialRef !== credentialRef
        && !(expected && status.state === "authorized")) throw new Error();
      if (status.state === "authorized" && expected && status.credentialRef && credentialRef !== status.credentialRef && !unboundApprovals) {
        edit(channel => { channel.auth.credentialRef = status.credentialRef; });
      }
      remember(status.state === "pending" ? status.operationId : "");
      if (status.state !== "pending") setDevice(null);
      setSnapshot(status);
      onEvidence(identity, selectableModels(up, status));
    } catch (failure) {
      if (current()) {
        const code = safeErrorCode(failure?.payload?.code || failure?.payload?.error?.code || failure?.code);
        if (code === "COPILOT_OPERATION_MISMATCH") {
          remember("");
          setDevice(null);
          setSnapshot(null);
        }
        setError(code || "unknown");
      }
    } finally {
      if (current()) setBusy("");
    }
  }

  useLayoutEffect(() => {
    void run("status");
    return () => {
      request.current?.abort();
      onEvidence(identity, null);
    };
  }, [identity]);
  useEffect(() => {
    if (busy || !valid || (!operation.current && !credentialRef)) return;
    const untilStale = !error && snapshot?.discovery.state === "fresh" ? Math.max(0, discoveryDeadline(snapshot) - Date.now()) : Infinity;
    const waiting = operation.current || snapshot?.discovery.state === "loading";
    const timer = setTimeout(() => { void run("status"); }, Math.min(untilStale, waiting ? 2500 : 30000));
    return () => clearTimeout(timer);
  }, [busy, snapshot, error, identity]);
  useEffect(() => {
    if (!device) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= device.expires) setDevice(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [device]);

  const allowed = busy || error ? new Map() : selectableModels(up, snapshot);
  const pending = operation.current || snapshot?.state === "pending";
  const adminAuthRequired = error === "COPILOT_ADMIN_AUTH_REQUIRED";
  return <fieldset className="copilot-setup"><legend>GitHub Copilot</legend>
    {adminAuthRequired ? <p role="alert">{t("copilot.adminAuthRequired")}{" "}
      <Link to="/settings/service">{t("shell.settings.service")}</Link> <code>{error}</code>
    </p> : null}
    <div className="connection-fields" hidden={section === "mappings"}>
    <p>{t("copilot.channel")}: <code>{up.channelId}</code></p>
    <Field label={t("copilot.profile")} hint={t("copilot.profileHint")}><select value={profile || ""}
      disabled={!!saved || !!credentialRef || !!pending || !!up.modelMappings?.length || (!!busy && busy !== "status")}
      onChange={e => { const authProfile = e.target.value; edit(channel => { channel.copilot = { authProfile }; }); }}>
      <option value="vscode">GitHub Copilot (VS Code)</option><option value="opencode">OpenCode</option>
    </select></Field>
    <p>{t("copilot.authStatus")}: {t(`copilot.state.${snapshot?.state || (device ? "pending" : "unknown")}`)}
      {busy && ` · ${t("copilot.working")}`}</p>
    {snapshot?.credentialRef && <p>
      {t("copilot.tokenExpiry")}: {snapshot.expiresAt ? <time>{snapshot.expiresAt}</time> : t("copilot.state.unknown")}
      {" · "}{t("copilot.renewal")}: {t(snapshot.renewable == null ? "copilot.state.unknown"
        : snapshot.renewable ? "copilot.canRenew" : "copilot.loginNeeded")}
      {snapshot.nextRetryAt && <>{" · "}{t("copilot.nextRetry")}: <time>{snapshot.nextRetryAt}</time></>}
    </p>}
    <p><code>{Object.entries(up.routes || {}).map(([route, path]) => `${route}: ${path}`).join(" · ")}</code></p>
    {!adminAuthRequired && (!valid || error || snapshot?.errorCode) && <p role="alert">{t("copilot.requestError")} {error === "unknown" ? "" : error || snapshot?.errorCode}</p>}
    {device && device.expires > now && <p>
      <a href={verificationUri} target="_blank" rel="noopener noreferrer">{t("copilot.verify")}</a>{" · "}
      {t("copilot.code")}: <code>{device.code}</code>{" · "}{t("copilot.secondsLeft")}: {Math.ceil((device.expires - now) / 1000)}
    </p>}
    <div className="toolbar-cluster">
      <button type="button" disabled={adminAuthRequired || !valid || !!busy || !!pending || unboundApprovals} onClick={() => void run("login")}>{t("copilot.login")}</button>
      <button type="button" className="ghost" disabled={!valid || !!busy} onClick={() => void run("status")}>{t("copilot.status")}</button>
      <button type="button" className="ghost" disabled={!valid || !pending || (!!busy && busy !== "status")} onClick={() => void run("cancel")}>{t("copilot.cancel")}</button>
      <button type="button" disabled={!valid || !!busy || !!pending || !credentialRef || snapshot?.state !== "authorized"}
        onClick={() => void run("discover")}>{t("copilot.discover")}</button>
      {!credentialRef && snapshot?.state === "authorized" && snapshot.credentialRef && !busy && !error &&
        <button type="button" disabled={unboundApprovals} onClick={() => edit(channel => { channel.auth.credentialRef = snapshot.credentialRef; })}>{t("copilot.useAuthorization")}</button>}
      <button type="button" className="ghost danger" disabled={!valid || !!busy || !!pending || !credentialRef || referenced.length > 0}
        onClick={() => { if (window.confirm(t("copilot.confirmDisconnect"))) void run("disconnect"); }}>{t("copilot.disconnect")}</button>
    </div>
    {unboundApprovals && <p>{t("copilot.clearApprovals")}</p>}
    {referenced.length > 0 && <p>{t("copilot.disconnectRefs")}: {referenced.join(", ")}</p>}
    <a href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer">{t("copilot.githubAuthorizations")}</a>
    </div>
    <div hidden={Boolean(section) && section !== "mappings"}>
    {section === "mappings" ? <div className="toolbar-cluster">
      <span>{t("copilot.authStatus")}: {t(`copilot.state.${snapshot?.state || "unknown"}`)}</span>
      <button type="button" className="ghost" disabled={!valid || !!busy} onClick={() => void run("status")}>{t("copilot.status")}</button>
      <button type="button" disabled={!valid || !!busy || !!pending || !credentialRef || snapshot?.state !== "authorized"}
        onClick={() => void run("discover")}>{t("copilot.discover")}</button>
      {error && !adminAuthRequired ? <p role="alert">{t("copilot.requestError")}</p> : null}
    </div> : null}
    <DiscoveryPicker up={up} definitions={definitions} snapshot={snapshot} allowed={allowed} edit={edit} t={t} />
    </div>
  </fieldset>;
}
