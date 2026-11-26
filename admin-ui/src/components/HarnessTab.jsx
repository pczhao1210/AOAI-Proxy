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
  UNSUPPORTED_MODEL_CAPABILITY: "Codex catalogs cannot include image generation or editing models.",
  NON_NATIVE_PROTOCOL: "The final upstream route uses a different protocol. A native route is required.",
  ROUTE_UNAVAILABLE: "No usable native route could be resolved."
};

function setClientSelection(next, modelId, clientName, selected, nativeRoute = false) {
  const matches = (next.models || []).filter(model => model?.id === modelId);
  if (!modelId || matches.length !== 1) throw new Error("Harness selection requires a unique model ID");
  const model = matches[0];
  model.clientCompatibility = { ...(model.clientCompatibility || {}), [clientName]: selected };
  // The native-route rule belongs to the membership: removing a model restores its configured routes.
  const nativeRoutes = { ...(model.clientNativeRoute || {}) };
  if (selected && nativeRoute) nativeRoutes[clientName] = true;
  else delete nativeRoutes[clientName];
  if (Object.keys(nativeRoutes).length) model.clientNativeRoute = nativeRoutes;
  else delete model.clientNativeRoute;
}

export default function HarnessTab({
  config, loadedConfig = {}, dirty = false, eligibility, eligibilityLoading, eligibilityError,
  onRetry, onNavigate, updateConfig, t
}) {
  const [activeClient, setActiveClient] = useState("");
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("selectable");
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
  const viaNativeRoute = (row, clientName) => row.unique && row.item?.clients?.[clientName]?.eligible !== true
    && nativeCandidate(row, clientName)?.eligible === true;
  const selectable = (row, clientName) => row.unique
    && (row.item?.clients?.[clientName]?.eligible === true || viaNativeRoute(row, clientName));
  const isChecked = row => row.unique ? pendingIds.has(row.model.id) : isMember(row, activeClient);
  const canToggle = row => row.unique && (isChecked(row) || selectable(row, activeClient));
  const additions = rows.filter(row => row.unique && pendingIds.has(row.model.id) && !isMember(row, activeClient));
  const removals = rows.filter(row => row.unique && !pendingIds.has(row.model.id) && isMember(row, activeClient));
  const changed = additions.length + removals.length > 0;

  function openModal(clientName) {
    setPendingIds(new Set(rows.filter(row => row.unique && isMember(row, clientName)).map(row => row.model.id)));
    setActiveClient(clientName);
    setSearch("");
    setFilter("selectable");
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
      for (const row of additions) setClientSelection(next, row.model.id, activeClient, true, viaNativeRoute(row, activeClient));
    });
    setActionError("");
    closeModal();
  }

  function changeSelection(row, clientName, selected, nativeRoute = false) {
    if (!row?.unique || (selected && !selectable(row, clientName))) {
      setActionError(t("harness.selectionChanged", "The selection is no longer valid. Refresh eligibility or fix the model ID."));
      return;
    }
    updateConfig(next => setClientSelection(next, row.model.id, clientName, selected, nativeRoute));
    setActionError("");
  }

  function renderEligibility(row, client, { repairOnlyWhenBlocked = false } = {}) {
    const info = row.item?.clients?.[client.id];
    const candidate = nativeCandidate(row, client.id);
    const member = isMember(row, client.id);
    const viaNative = !member && viaNativeRoute(row, client.id);
    const canEnable = member && viaNativeRoute(row, client.id);
    const nativePath = (candidate?.routePath || info?.nativeRoute?.routePath) || "-";
    const withRoute = text => text.replaceAll("{route}", client.routeKey).replaceAll("{path}", nativePath);
    const reasons = viaNative ? [] : [
      ...(info?.reasons || []),
      ...(candidate?.reasons || []).filter(reason => !(info?.reasons || []).some(known => known.code === reason.code))
    ];
    const showRepair = onNavigate && !(repairOnlyWhenBlocked && (info?.eligible || viaNative));
    return (
      <div className="harness-stack">
        <span className={`badge ${info ? info.eligible || viaNative ? "level-info" : "level-error" : ""}`}>
          {!row.unique ? t("harness.invalidId", "A unique, non-empty model ID is required.")
            : !info ? t("harness.unknown", "Eligibility not confirmed")
              : info.eligible ? t("harness.eligible", "Configuration matches native routing")
                : viaNative ? t("harness.nativeRoute.eligible", "Selectable with native route override")
                  : t("harness.ineligible", "Not eligible")}
        </span>
        {info?.nativeRoute?.active ? (
          <p className="entity-meta">
            {withRoute(t("harness.nativeRoute.active", "Native route override: {route} requests use {path}, ahead of the configured routes. Removing the model restores them."))}
          </p>
        ) : null}
        {viaNative ? (
          <p className="entity-meta">
            {withRoute(t("harness.nativeRoute.notice", "The Model Catalog does not declare native {route} for this model. Selecting it enables a native route override: {route} requests use {path}, ahead of the configured routes. Removing the model restores them."))}
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
            {withRoute(t("harness.nativeRoute.enableHint", "Enable the native route override: {route} requests use {path}, ahead of the configured routes."))}
          </p>
        ) : null}
        {candidate && !candidate.eligible && candidate.reasons?.some(reason => reason.code === "ROUTE_UNAVAILABLE") ? (
          <p className="entity-meta">
            {withRoute(t("harness.nativeRoute.needsUpstreamRoute", "Add a native {route} route to the upstream; the model can then be selected with a native route override."))}
          </p>
        ) : null}
        {canEnable && !repairOnlyWhenBlocked ? (
          <button type="button" onClick={() => changeSelection(row, client.id, true, true)}>{t("harness.nativeRoute.enable", "Enable native route override")}</button>
        ) : null}
        {showRepair ? (
          <div className="toolbar-cluster">
            <button type="button" className="ghost" onClick={() => onNavigate({ type: "model", id: row.model.id })}>{t("harness.editModel", "Edit model")}</button>
            {[...(info?.reasons || []), ...(candidate?.reasons || [])].some(reason => reason.code.startsWith("UPSTREAM_") || reason.code === "ROUTE_UNAVAILABLE") ? (
              <button type="button" className="ghost" onClick={() => onNavigate({ type: "upstream", id: row.model.upstream })}>{t("harness.editUpstream", "Edit upstream")}</button>
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
  const candidateRank = row => selectable(row, activeClient) ? 0 : 1;
  const visibleRows = rows.filter(row => {
    const matchesSearch = [row.model.id, row.model.displayName, row.model.upstream]
      .some(value => String(value || "").toLowerCase().includes(search.trim().toLowerCase()));
    return matchesSearch && (filter === "all"
      || (filter === "selectable" && selectable(row, activeClient))
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
            desc={t(`harness.${client.id}.desc`, `Publish a model catalog for ${client.name}. Models must route natively through ${client.routeKey}.`)}
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
              <option value="selectable">{t("harness.selectable", "Selectable")}</option>
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
