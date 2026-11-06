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

function setClientSelection(next, modelId, clientName, selected) {
  const matches = (next.models || []).filter(model => model?.id === modelId);
  if (!modelId || matches.length !== 1) throw new Error("Harness selection requires a unique model ID");
  const model = matches[0];
  model.clientCompatibility = { ...(model.clientCompatibility || {}), [clientName]: selected };
}

export default function HarnessTab({
  config, loadedConfig = {}, dirty = false, eligibility, eligibilityLoading, eligibilityError,
  onRetry, onNavigate, updateConfig, t
}) {
  const [activeClient, setActiveClient] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
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
  const available = (row, clientName) => row.unique && row.item?.clients?.[clientName]?.eligible === true
    && row.model.clientCompatibility?.[clientName] !== true;
  const selectedRow = rows.find(row => row.model.id === selectedModelId && available(row, activeClient));

  function closeModal() {
    setActiveClient("");
    setSelectedModelId("");
  }

  function changeSelection(row, clientName, selected) {
    if (!row?.unique || (selected && !available(row, clientName))) {
      setActionError(t("harness.selectionChanged", "The selection is no longer valid. Refresh eligibility or fix the model ID."));
      return;
    }
    updateConfig(next => setClientSelection(next, row.model.id, clientName, selected));
    setActionError("");
  }

  function renderEligibility(row, client) {
    const info = row.item?.clients?.[client.id];
    return (
      <div className="harness-stack">
        <span className={`badge ${info ? info.eligible ? "level-info" : "level-error" : ""}`}>
          {!row.unique ? t("harness.invalidId", "A unique, non-empty model ID is required.")
            : !info ? t("harness.unknown", "Eligibility not confirmed")
              : info.eligible ? t("harness.eligible", "Configuration matches native routing")
                : t("harness.ineligible", "Not eligible")}
        </span>
        {info?.reasons?.length > 0 ? (
          <ul className="harness-reasons">
            {info.reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`}>
                {REASONS[reason.code] ? t(`harness.reason.${reason.code}`, REASONS[reason.code]) : reason.message || t("harness.unknown", "Eligibility not confirmed")}
                <small className="entity-meta">{reason.code}</small>
              </li>
            ))}
          </ul>
        ) : null}
        {onNavigate ? (
          <div className="toolbar-cluster">
            <button type="button" className="ghost" onClick={() => onNavigate({ type: "model", id: row.model.id })}>{t("harness.editModel", "Edit model")}</button>
            {info?.reasons?.some(reason => reason.code.startsWith("UPSTREAM_")) ? (
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
  const visibleRows = rows.filter(row => {
    const matchesSearch = [row.model.id, row.model.displayName, row.model.upstream]
      .some(value => String(value || "").toLowerCase().includes(search.trim().toLowerCase()));
    const selected = row.model.clientCompatibility?.[activeClient] === true;
    return matchesSearch && (filter === "all"
      || (filter === "available" && available(row, activeClient))
      || (filter === "selected" && selected)
      || (filter === "ineligible" && row.item?.clients?.[activeClient]?.eligible === false));
  });

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
                <button type="button" disabled={!fresh} onClick={() => {
                  setActiveClient(client.id);
                  setSelectedModelId("");
                  setSearch("");
                  setFilter("all");
                }}>{t("harness.addModel", "Add Model")}</button>
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
        title={t("harness.addModal.title", "Add model to {client}").replace("{client}", modalClient?.name || "")}
        isOpen={Boolean(activeClient)} onClose={closeModal}
        onConfirm={() => {
          if (!selectedRow) {
            setActionError(t("harness.selectionChanged", "The selection is no longer valid. Refresh eligibility or fix the model ID."));
            return;
          }
          changeSelection(selectedRow, activeClient, true);
          closeModal();
        }}
        confirmLabel={t("harness.addModel", "Add Model")} cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")} disabled={!selectedRow}
      >
        <div className="form-grid">
          <Field label={t("harness.search", "Search name, ID or upstream")}><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label={t("harness.filter", "Model status")}>
            <select value={filter} onChange={event => setFilter(event.target.value)}>
              <option value="all">{t("harness.all", "All models")}</option>
              <option value="available">{t("harness.available", "Available to add")}</option>
              <option value="selected">{t("harness.selected", "Already selected")}</option>
              <option value="ineligible">{t("harness.ineligible", "Not eligible")}</option>
            </select>
          </Field>
        </div>
        {!fresh ? <p role="status">{t("harness.unknown", "Eligibility not confirmed")}</p> : null}
        <div className="harness-stack">
          {modalClient && visibleRows.map(row => (
            <div key={`${row.model.id}-${row.index}`} className="harness-candidate">
              <label className="inline">
                <input type="radio" name="harness-model" checked={selectedModelId === row.model.id && row.unique}
                  disabled={!available(row, activeClient)} onChange={() => setSelectedModelId(row.model.id)} />
                {row.model.displayName || row.model.id || t("harness.unnamedModel", "Unnamed model")} ({row.model.id || "-"})
              </label>
              <p className="entity-meta">{row.model.upstream || "-"}</p>
              {row.model.clientCompatibility?.[activeClient] === true ? <span className="badge">{t("harness.selected", "Already selected")}</span> : null}
              {renderEligibility(row, modalClient)}
            </div>
          ))}
        </div>
        {!visibleRows.length ? <p className="empty-state">{models.length ? t("harness.noMatches", "No models match these filters.") : t("harness.noModels", "Configure a model in Upstream / Model first.")}</p> : null}
      </Modal>
    </div>
  );
}
