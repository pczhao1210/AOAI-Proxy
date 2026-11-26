import { useState } from "react";
import { EntityCard, Field, Modal, Section } from "./ui.jsx";
import HarnessSetup from "./HarnessSetup.jsx";
import CodexModelSettings from "./CodexModelSettings.jsx";

const CLIENTS = [
  { id: "claudeCode", name: "Claude Code", routeKey: "messages", sectionId: "harness-claude-code" },
  { id: "codex", name: "Codex", routeKey: "responses", sectionId: "harness-codex" }
];

const REASONS = {
  MODEL_DISABLED: "The model is disabled.",
  MODEL_CATALOG_NOT_FOUND: "No matching Model Catalog definition.",
  UPSTREAM_NOT_FOUND: "The upstream binding is missing.",
  UPSTREAM_DISABLED: "The upstream is disabled.",
  PUBLIC_ROUTE_DISABLED: "The public client route is disabled.",
  NON_TEXT_MODEL: "Not a text-generation model (image, video, speech, transcription, realtime or embedding models cannot be used by Claude Code or Codex).",
  NON_NATIVE_PROTOCOL: "The final upstream route uses a different protocol, and neither a native route nor protocol conversion is selected.",
  ROUTE_UNAVAILABLE: "No usable native route could be resolved.",
  CONVERSION_BLOCKED_BY_POLICY: "Lossy shim requests are rejected (compatibility.protocolShim.rejectLossyRequests), so protocol conversion cannot be used."
};

const CONVERSION_LIMITS = {
  claudeCode: "thinking, cache_control and metadata are not forwarded, messages/count_tokens is unavailable, and dropped fields log a proxy.protocol_shim_lossy_conversion warning.",
  codex: "Responses-only features (freeform apply_patch, hosted web search, reasoning summaries, prompt_cache_key, previous_response_id) are not forwarded, responses/compact is unavailable, and dropped fields log a proxy.protocol_shim_lossy_conversion warning."
};

// Native routing is preferred; a converted route is the fallback when the upstream lacks the client's native endpoint.
const ROUTE_MODES = { native: "native", conversion: "conversion" };

function setClientSelection(next, modelId, clientName, selected, routeMode = "") {
  const matches = (next.models || []).filter(model => model?.id === modelId);
  if (!modelId || matches.length !== 1) throw new Error("Harness selection requires a unique model ID");
  const model = matches[0];
  model.clientCompatibility = { ...(model.clientCompatibility || {}), [clientName]: selected };
  // The route rule belongs to the membership: removing a model restores its configured routes.
  for (const [field, mode] of [["clientNativeRoute", ROUTE_MODES.native], ["clientConversion", ROUTE_MODES.conversion]]) {
    const flags = { ...(model[field] || {}) };
    if (selected && routeMode === mode) flags[clientName] = true;
    else delete flags[clientName];
    if (Object.keys(flags).length) model[field] = flags;
    else delete model[field];
  }
}

export default function HarnessTab({
  config, loadedConfig = {}, dirty = false, eligibility, eligibilityLoading, eligibilityError,
  onRetry, onNavigate, updateConfig, t
}) {
  const [activeClient, setActiveClient] = useState("");
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(ROUTE_MODES.native);
  const [actionError, setActionError] = useState("");
  const models = Array.isArray(config?.models) ? config.models : [];
  const items = Array.isArray(eligibility?.items) ? eligibility.items : [];
  const fresh = Boolean(eligibility) && !eligibilityLoading && !eligibilityError;
  const counts = new Map();
  for (const model of models) counts.set(model?.id, (counts.get(model?.id) || 0) + 1);
  const eligibilityById = new Map();
  for (const item of items) eligibilityById.set(item.modelId, eligibilityById.has(item.modelId) ? null : item);
  const rows = models.map((entry, index) => {
    const model = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const unique = typeof model.id === "string" && Boolean(model.id.trim())
      && counts.get(model.id) === 1;
    return { model, index, unique, item: fresh && unique ? eligibilityById.get(model.id) || null : null };
  });
  const isMember = (row, clientName) => row.model.clientCompatibility?.[clientName] === true;
  const nativeCandidate = (row, clientName) => row.item?.clients?.[clientName]?.nativeRoute?.candidate;
  const conversionCandidate = (row, clientName) => row.item?.clients?.[clientName]?.conversion?.candidate;
  const unresolved = (row, clientName) => row.unique && row.item?.clients?.[clientName]?.eligible !== true;
  // An upstream that declares the native route is not evidence that the Catalog model supports it, so the
  // override is only a category of its own when conversion is unavailable; otherwise it is an explicit switch.
  const nativeAvailable = (row, clientName) => unresolved(row, clientName) && nativeCandidate(row, clientName)?.eligible === true;
  const viaConversion = (row, clientName) => unresolved(row, clientName) && conversionCandidate(row, clientName)?.eligible === true;
  const viaNativeRoute = (row, clientName) => nativeAvailable(row, clientName) && !viaConversion(row, clientName);
  // Category of a model for one client: configuration-verified native, then conversion, then override-only.
  const categoryOf = (row, clientName) => {
    if (!row.unique) return "";
    const info = row.item?.clients?.[clientName];
    if (info?.eligible === true) return info.mode === "conversion" ? ROUTE_MODES.conversion : ROUTE_MODES.native;
    if (viaConversion(row, clientName)) return ROUTE_MODES.conversion;
    return viaNativeRoute(row, clientName) ? ROUTE_MODES.native : "";
  };
  const selectable = (row, clientName) => Boolean(categoryOf(row, clientName));
  // Flag the selection writes: only models that need it (override or conversion) get one.
  const routeModeFor = (row, clientName) => viaConversion(row, clientName) ? ROUTE_MODES.conversion
    : viaNativeRoute(row, clientName) ? ROUTE_MODES.native : "";
  const isChecked = row => row.unique ? pendingIds.has(row.model.id) : isMember(row, activeClient);
  const canToggle = row => row.unique && (isChecked(row) || selectable(row, activeClient));
  const additions = rows.filter(row => row.unique && pendingIds.has(row.model.id) && !isMember(row, activeClient));
  const removals = rows.filter(row => row.unique && !pendingIds.has(row.model.id) && isMember(row, activeClient));
  const changed = additions.length + removals.length > 0;

  function openModal(clientName) {
    setPendingIds(new Set(rows.filter(row => row.unique && isMember(row, clientName)).map(row => row.model.id)));
    setActiveClient(clientName);
    setSearch("");
    setFilter(ROUTE_MODES.native);
  }

  function closeModal() {
    setActiveClient("");
    setPendingIds(new Set());
  }

  function togglePending(row) {
    if (!canToggle(row)) return;
    setPendingIds(previous => {
      const next = new Set(previous);
      if (next.has(row.model.id)) next.delete(row.model.id);
      else next.add(row.model.id);
      return next;
    });
  }

  function applyPendingSelection() {
    if (!fresh || !changed || !additions.every(row => selectable(row, activeClient))) {
      setActionError(t("harness.selectionChanged", "The selection is no longer valid. Refresh eligibility or fix the model ID."));
      return;
    }
    updateConfig(next => {
      for (const row of removals) setClientSelection(next, row.model.id, activeClient, false);
      for (const row of additions) setClientSelection(next, row.model.id, activeClient, true, routeModeFor(row, activeClient));
    });
    setActionError("");
    closeModal();
  }

  function changeSelection(row, clientName, selected, routeMode = "") {
    const candidateFor = { [ROUTE_MODES.native]: nativeCandidate, [ROUTE_MODES.conversion]: conversionCandidate }[routeMode];
    const valid = row?.unique && (!selected || (
      candidateFor ? candidateFor(row, clientName)?.eligible === true : selectable(row, clientName)
    ));
    if (!valid) {
      setActionError(t("harness.selectionChanged", "The selection is no longer valid. Refresh eligibility or fix the model ID."));
      return;
    }
    updateConfig(next => setClientSelection(next, row.model.id, clientName, selected, routeMode));
    setActionError("");
  }

  function renderEligibility(row, client, { repairOnlyWhenBlocked = false } = {}) {
    const info = row.item?.clients?.[client.id];
    const candidate = nativeCandidate(row, client.id);
    const convCandidate = conversionCandidate(row, client.id);
    const member = isMember(row, client.id);
    const category = categoryOf(row, client.id);
    const viaNative = !member && viaNativeRoute(row, client.id);
    const viaConv = !member && viaConversion(row, client.id);
    const converted = info?.eligible === true && info.mode === ROUTE_MODES.conversion;
    const canEnable = member && nativeAvailable(row, client.id);
    const canConvert = member && viaConversion(row, client.id);
    const alsoNative = viaConv && candidate?.eligible === true;
    const canSwitch = member && info?.conversion?.active === true && candidate?.eligible === true;
    const conversion = info?.conversion?.active ? info.conversion : convCandidate;
    const nativePath = (candidate?.routePath || info?.nativeRoute?.routePath) || "-";
    const limits = t(`harness.conversion.limits.${client.id}`, CONVERSION_LIMITS[client.id]);
    const fill = (text, path = nativePath) => text
      .replaceAll("{route}", client.routeKey).replaceAll("{path}", path)
      .replaceAll("{target}", conversion?.to || "-").replaceAll("{limits}", limits);
    const knownCodes = (info?.reasons || []).map(reason => reason.code);
    const reasons = viaNative || viaConv || converted ? [] : [
      ...(info?.reasons || []),
      ...[...(candidate?.reasons || []), ...(convCandidate?.reasons || [])]
        .filter((reason, index, all) => !knownCodes.includes(reason.code) && all.findIndex(other => other.code === reason.code) === index)
    ];
    const routeUnavailable = candidate && !candidate.eligible && candidate.reasons?.some(reason => reason.code === "ROUTE_UNAVAILABLE");
    const showRepair = onNavigate && !(repairOnlyWhenBlocked && category);
    return (
      <div className="harness-stack">
        <span className={`badge ${info ? category === ROUTE_MODES.conversion ? "level-warn" : category ? "level-info" : "level-error" : ""}`}>
          {!row.unique ? t("harness.invalidId", "A unique, non-empty model ID is required.")
            : !info ? t("harness.unknown", "Eligibility not confirmed")
              : converted ? t("harness.conversion.eligible", "Selectable with protocol conversion")
                : info.eligible ? t("harness.eligible", "Configuration matches native routing")
                  : viaNative ? t("harness.nativeRoute.eligible", "Selectable with native route override")
                    : viaConv ? t("harness.conversion.eligible", "Selectable with protocol conversion")
                      : t("harness.ineligible", "Not eligible")}
        </span>
        {info?.nativeRoute?.active ? (
          <p className="entity-meta">
            {fill(t("harness.nativeRoute.active", "Native route override: {route} requests use {path}, ahead of the configured routes. Removing the model restores them."))}
          </p>
        ) : null}
        {viaNative ? (
          <p className="entity-meta">
            {fill(t("harness.nativeRoute.notice", "The Model Catalog does not declare native {route} for this model. Selecting it enables a native route override: {route} requests use {path}, ahead of the configured routes. Removing the model restores them."))}
          </p>
        ) : null}
        {converted ? (
          <p className="entity-meta">
            {fill(t("harness.conversion.active", "Protocol conversion: {route} requests are converted to {target} ({path}). {limits} Removing the model restores the configured routes."), conversion?.routePath || "-")}
          </p>
        ) : null}
        {viaConv ? (
          <p className="entity-meta">
            {fill(t("harness.conversion.notice", "The upstream has no native {route} route for this model. Selecting it converts {route} requests to {target} ({path}). {limits} Removing the model restores the configured routes."), conversion?.routePath || "-")}
          </p>
        ) : null}
        {alsoNative ? (
          <p className="entity-meta">
            {fill(t("harness.conversion.alsoNative", "This upstream declares a native {route} route ({path}), but the Model Catalog does not declare it for this model. After adding the model you can switch to the native route if you know the provider supports it."))}
          </p>
        ) : null}
        {reasons.length > 0 ? (
          <ul className="harness-reasons">
            {reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`}>
                {REASONS[reason.code] ? t(`harness.reason.${reason.code}`, REASONS[reason.code]) : reason.message || t("harness.unknown", "Eligibility not confirmed")}
                <small className="entity-meta">{reason.code}</small>
              </li>
            ))}
          </ul>
        ) : null}
        {canEnable ? (
          <p className="entity-meta">
            {fill(t("harness.nativeRoute.enableHint", "Enable the native route override: {route} requests use {path}, ahead of the configured routes."))}
          </p>
        ) : null}
        {canConvert ? (
          <p className="entity-meta">
            {fill(t("harness.conversion.enableHint", "Enable protocol conversion: {route} requests are converted to {target} ({path}). {limits}"), conversion?.routePath || "-")}
          </p>
        ) : null}
        {canSwitch ? (
          <p className="entity-meta">
            {fill(t("harness.conversion.switchHint", "The upstream declares a native {route} route ({path}). If the provider supports it, switch to the native route override to avoid conversion."))}
          </p>
        ) : null}
        {routeUnavailable ? (
          <p className="entity-meta">
            {fill(t("harness.nativeRoute.needsUpstreamRoute", "To use native {route}, add a {route} entry to this upstream's routes in the JSON editor (upstreams[].routes); the structured form does not edit upstream routes."))}
          </p>
        ) : null}
        {canEnable && !repairOnlyWhenBlocked ? (
          <button type="button" onClick={() => changeSelection(row, client.id, true, ROUTE_MODES.native)}>{t("harness.nativeRoute.enable", "Enable native route override")}</button>
        ) : null}
        {canConvert && !repairOnlyWhenBlocked ? (
          <button type="button" onClick={() => changeSelection(row, client.id, true, ROUTE_MODES.conversion)}>{t("harness.conversion.enable", "Enable protocol conversion")}</button>
        ) : null}
        {canSwitch && !repairOnlyWhenBlocked ? (
          <button type="button" onClick={() => changeSelection(row, client.id, true, ROUTE_MODES.native)}>{t("harness.conversion.switch", "Switch to native route")}</button>
        ) : null}
        {showRepair ? (
          <div className="toolbar-cluster">
            <button type="button" className="ghost" onClick={() => onNavigate({ type: "model", id: row.model.id })}>{t("harness.editModel", "Edit model")}</button>
            {info?.reasons?.some(reason => reason.code.startsWith("UPSTREAM_")) ? (
              <button type="button" className="ghost" onClick={() => onNavigate({ type: "upstream", id: row.model.upstream })}>{t("harness.editUpstream", "Edit upstream")}</button>
            ) : null}
            {routeUnavailable ? (
              <button type="button" className="ghost" onClick={() => onNavigate({ type: "advanced" })}>{t("harness.editJson", "Open JSON editor")}</button>
            ) : null}
            {info?.reasons?.some(reason => reason.code === "PUBLIC_ROUTE_DISABLED") ? (
              <button type="button" className="ghost" onClick={() => onNavigate({ type: "route" })}>{t("harness.editRoutes", "Edit public routes")}</button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const modalClient = CLIENTS.find(client => client.id === activeClient);
  const candidateRank = row => categoryOf(row, activeClient) === ROUTE_MODES.native ? 0
    : categoryOf(row, activeClient) === ROUTE_MODES.conversion ? 1 : 2;
  const visibleRows = rows.filter(row => {
    const matchesSearch = [row.model.id, row.model.displayName, row.model.upstream]
      .some(value => String(value || "").toLowerCase().includes(search.trim().toLowerCase()));
    return matchesSearch && (filter === "all"
      || (filter === ROUTE_MODES.native && categoryOf(row, activeClient) === ROUTE_MODES.native)
      || (filter === ROUTE_MODES.conversion && categoryOf(row, activeClient) === ROUTE_MODES.conversion)
      || (filter === "unselectable" && !selectable(row, activeClient)));
  }).sort((left, right) => candidateRank(left) - candidateRank(right));

  return (
    <div className="stack-lg">
      <div className="toolbar-cluster">
        <span role="status">{dirty ? t("harness.draft", "Draft changes: review and save to apply.") : t("harness.saved", "Saved configuration")}</span>
        {onRetry ? <button type="button" className="ghost" onClick={onRetry} disabled={eligibilityLoading}>{t("harness.retry", "Refresh eligibility")}</button> : null}
      </div>
      {eligibilityError || actionError ? <div role="alert" className="inline-error">{eligibilityError || actionError}</div> : null}
      {!fresh ? <p role="status">{eligibilityLoading ? t("harness.loading", "Checking model eligibility...") : t("harness.unknown", "Eligibility not confirmed")}</p> : null}
      <p className="muted">{t("harness.unverified", "Client connectivity has not been verified. Static eligibility does not test the upstream, CLI or tools.")}</p>
      {onNavigate ? <button type="button" className="ghost" onClick={() => onNavigate({ type: "diagnostics" })}>{t("harness.diagnostics", "Open diagnostics for active configuration")}</button> : null}
      {CLIENTS.map(client => {
        const enabled = config?.compatibility?.[client.id]?.enabled !== false;
        const selected = rows.filter(row => row.model.clientCompatibility?.[client.id] === true);
        const savedModels = (loadedConfig.models || []).filter(model => model.clientCompatibility?.[client.id] === true);
        const removed = savedModels.filter(model => !selected.some(row => row.model.id === model.id));
        const active = fresh ? eligibility.active : null;
        const activeIds = active?.catalogs?.[client.id]?.enabled
          ? (active.items || []).filter(item => item.selected?.[client.id] && item.clients?.[client.id]?.eligible).map(item => item.modelId)
          : [];
        return (
          <Section
            id={client.sectionId} key={client.id} title={client.name}
            desc={t(`harness.${client.id}.desc`, `Publish a model catalog for ${client.name}. Native ${client.routeKey} routing is recommended; models without it can be selected with protocol conversion.`)}
            actions={(
              <div className="toolbar-cluster">
                <label className="inline">
                  <input type="checkbox" checked={enabled} onChange={event => {
                    const checked = event.target.checked;
                    updateConfig(next => {
                      next.compatibility ||= {};
                      next.compatibility[client.id] = { ...(next.compatibility[client.id] || {}), enabled: checked };
                    });
                  }} />
                  {t("harness.catalogEnabled", "Publish catalog")}
                </label>
                <button type="button" disabled={!fresh} onClick={() => openModal(client.id)}>{t("harness.selectModels", "Select models")}</button>
              </div>
            )}
          >
            <p className="entity-meta">
              {t("harness.activeCatalog", "Active catalog")}{" · "}
              {!active ? t("harness.unknown", "Eligibility not confirmed")
                : active.catalogs?.[client.id]?.enabled ? `${t("harness.publishing", "Publication enabled")}: ${activeIds.join(", ") || t("harness.emptyCatalog", "Empty catalog")}`
                  : t("harness.notPublished", "Publication disabled")}
            </p>
            <p className="entity-meta">{t("harness.accessHint", "Actual client visibility also depends on API key permissions.")}</p>
            {!enabled ? <div className="empty-state">{t("harness.catalogDisabled", "This catalog is disabled. Saved members are retained but are not published.")}</div> : null}
            {selected.length ? (
              <div className="entity-grid">
                {selected.map(row => (
                  <EntityCard
                    id={`${client.sectionId}-model-${row.index}`} key={row.unique ? row.model.id : `invalid-${row.index}`}
                    title={row.model.displayName || row.model.id || t("harness.unnamedModel", "Unnamed model")}
                    subtitle={`${row.model.id || "-"} · ${row.model.upstream || "-"}`}
                    removeLabel={t("harness.removeModel", "Remove")}
                    onRemove={() => changeSelection(row, client.id, false)}
                  >
                    <span className="badge">{savedModels.some(model => model.id === row.model.id) ? t("harness.savedMember", "Saved member") : t("harness.pendingAdd", "Pending addition")}</span>
                    {renderEligibility(row, client)}
                    {client.id === "codex" ? <CodexModelSettings
                      model={row.model} metadata={row.item?.codex}
                      activeMetadata={active?.items?.find(item => item.modelId === row.model.id)?.codex}
                      unique={row.unique} updateConfig={updateConfig} t={t}
                    /> : null}
                  </EntityCard>
                ))}
              </div>
            ) : <div className="empty-state">{t("harness.empty", "No models selected in this draft.")}</div>}
            {removed.map(model => (
              <p key={model.id} className="entity-meta">{t("harness.pendingRemove", "Pending removal")}: {model.id}</p>
            ))}
            <HarnessSetup client={client}
              models={selected.filter(row => row.item?.clients?.[client.id]?.eligible).map(row => row.model)}
              adminPath={config?.admin?.basePath || config?.server?.adminPath} t={t} />
          </Section>
        );
      })}
      <Modal
        title={t("harness.selectModal.title", "Select models for {client}").replace("{client}", modalClient?.name || "")}
        isOpen={Boolean(activeClient)} onClose={closeModal}
        onConfirm={applyPendingSelection}
        confirmLabel={t("harness.confirmSelection", "Confirm")} cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")} disabled={!fresh || !changed}
      >
        <div className="form-grid compact">
          <Field label={t("harness.search", "Search name, ID or upstream")}><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label={t("harness.filter", "Model status")}>
            <select value={filter} onChange={event => setFilter(event.target.value)}>
              <option value="all">{t("harness.all", "All models")}</option>
              <option value="native">{t("harness.selectableNative", "Selectable - native protocol")}</option>
              <option value="conversion">{t("harness.selectableConversion", "Selectable - needs conversion")}</option>
              <option value="unselectable">{t("harness.unselectable", "Not selectable")}</option>
            </select>
          </Field>
        </div>
        {!fresh ? <p role="status">{t("harness.unknown", "Eligibility not confirmed")}</p> : null}
        <div className="harness-candidate-grid">
          {modalClient && visibleRows.map(row => {
            const checked = isChecked(row);
            const enabled = canToggle(row);
            return (
              <div
                key={`${row.model.id}-${row.index}`}
                className={`harness-candidate${checked ? " is-selected" : ""}${enabled ? "" : " is-unavailable"}`}
                onClick={event => {
                  if (!event.target.closest("label, input, button")) togglePending(row);
                }}
              >
                <label className="harness-candidate-option">
                  <input type="checkbox" checked={checked} disabled={!enabled} onChange={() => togglePending(row)} />
                  <span>{row.model.displayName || row.model.id || t("harness.unnamedModel", "Unnamed model")} ({row.model.id || "-"})</span>
                </label>
                <p className="entity-meta">{row.model.upstream || "-"}</p>
                {renderEligibility(row, modalClient, { repairOnlyWhenBlocked: true })}
              </div>
            );
          })}
        </div>
        {!visibleRows.length ? <p className="empty-state">{models.length ? t("harness.noMatches", "No models match these filters.") : t("harness.noModels", "Configure a model in Upstream / Model first.")}</p> : null}
      </Modal>
    </div>
  );
}
