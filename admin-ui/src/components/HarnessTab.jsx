import { useMemo, useState } from "react";
import { EntityCard, Field, Modal, Section } from "./ui.jsx";

const CLIENTS = [
  { id: "claudeCode", name: "Claude Code", routeKey: "messages", sectionId: "harness-claude-code" },
  { id: "codex", name: "Codex", routeKey: "responses", sectionId: "harness-codex" }
];

function setClientSelection(next, modelIndex, clientName, selected) {
  const model = next.models?.[modelIndex];
  if (!model) return;
  model.clientCompatibility = {
    ...(model.clientCompatibility && typeof model.clientCompatibility === "object"
      ? model.clientCompatibility
      : {}),
    [clientName]: selected
  };
}

function setCatalogEnabled(next, clientName, enabled) {
  next.compatibility = next.compatibility || {};
  next.compatibility[clientName] = {
    ...(next.compatibility[clientName] || {}),
    enabled
  };
}

export default function HarnessTab({ config, eligibility, eligibilityLoading, eligibilityError, updateConfig, t }) {
  const [activeClient, setActiveClient] = useState("");
  const [selectedModelIndex, setSelectedModelIndex] = useState("");
  const models = Array.isArray(config?.models) ? config.models : [];
  const eligibilityItems = Array.isArray(eligibility?.items) ? eligibility.items : [];
  const modelRows = useMemo(() => models.map((model, index) => ({
    model,
    index,
    eligibility: eligibilityItems[index]
  })), [models, eligibilityItems]);

  function availableModels(clientName) {
    return modelRows.filter(({ model, eligibility: item }) => (
      model?.clientCompatibility?.[clientName] !== true
      && item?.clients?.[clientName]?.eligible === true
    ));
  }

  function openAddModel(clientName) {
    const candidates = availableModels(clientName);
    setActiveClient(clientName);
    setSelectedModelIndex(candidates.length ? String(candidates[0].index) : "");
  }

  function closeAddModel() {
    setActiveClient("");
    setSelectedModelIndex("");
  }

  function confirmAddModel() {
    const modelIndex = Number(selectedModelIndex);
    if (!activeClient || !Number.isInteger(modelIndex)) return;
    const candidate = availableModels(activeClient).find((item) => item.index === modelIndex);
    if (!candidate) return;
    updateConfig((next) => setClientSelection(next, modelIndex, activeClient, true));
    closeAddModel();
  }

  const modalClient = CLIENTS.find((client) => client.id === activeClient);
  const modalCandidates = activeClient ? availableModels(activeClient) : [];

  return (
    <div className="stack-lg">
      {eligibilityError ? <div className="inline-error">{eligibilityError}</div> : null}
      {CLIENTS.map((client) => {
        const catalogEnabled = config?.compatibility?.[client.id]?.enabled !== false;
        const selectedModels = modelRows.filter(({ model }) => model?.clientCompatibility?.[client.id] === true);
        const candidates = availableModels(client.id);
        return (
          <Section
            id={client.sectionId}
            key={client.id}
            title={client.name}
            desc={t(
              `harness.${client.id}.desc`,
              `Publish a model catalog for ${client.name}. Models must route natively through ${client.routeKey}.`
            )}
            actions={(
              <div className="toolbar-cluster">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={catalogEnabled}
                    onChange={(event) => updateConfig((next) => {
                      setCatalogEnabled(next, client.id, event.target.checked);
                    })}
                  />
                  {t("harness.catalogEnabled", "Publish catalog")}
                </label>
                <button
                  type="button"
                  onClick={() => openAddModel(client.id)}
                  disabled={eligibilityLoading || candidates.length === 0}
                >
                  {t("harness.addModel", "Add Model")}
                </button>
              </div>
            )}
          >
            {!catalogEnabled ? (
              <div className="empty-state">{t("harness.catalogDisabled", "This catalog is disabled. Saved members are retained but are not published.")}</div>
            ) : null}
            {eligibilityLoading && !eligibility ? (
              <div className="empty-state">{t("harness.loading", "Checking model eligibility...")}</div>
            ) : selectedModels.length === 0 ? (
              <div className="empty-state">{t("harness.empty", "No models are published in this catalog.")}</div>
            ) : (
              <div className="entity-grid">
                {selectedModels.map(({ model, index, eligibility: item }) => {
                  const clientEligibility = item?.clients?.[client.id];
                  const eligible = clientEligibility?.eligible === true;
                  const reason = clientEligibility?.reasons?.[0]?.message || "";
                  return (
                    <EntityCard
                      id={`${client.sectionId}-model-${index}`}
                      key={`${client.id}-${index}`}
                      title={model.displayName || model.id || t("harness.unnamedModel", "Unnamed model")}
                      subtitle={`${model.id || "-"} · ${model.upstream || t("status.modelSubtitleFallback", "Upstream not bound")}`}
                      removeLabel={t("harness.removeModel", "Remove")}
                      onRemove={() => updateConfig((next) => setClientSelection(next, index, client.id, false))}
                    >
                      <div className="badge-row">
                        <span className={`badge ${eligible ? "level-info" : "level-error"}`}>
                          {eligible
                            ? t("harness.eligible", "Eligible")
                            : t("harness.ineligible", "Not eligible")}
                        </span>
                        <span className="badge">{client.routeKey}</span>
                      </div>
                      {reason ? <div className="entity-meta">{reason}</div> : null}
                    </EntityCard>
                  );
                })}
              </div>
            )}
            {!eligibilityLoading && candidates.length === 0 ? (
              <div className="entity-meta">{t("harness.noEligible", "No additional eligible models are available.")}</div>
            ) : null}
          </Section>
        );
      })}

      <Modal
        title={t("harness.addModal.title", "Add model to {client}").replace("{client}", modalClient?.name || "")}
        isOpen={Boolean(activeClient)}
        onClose={closeAddModel}
        onConfirm={confirmAddModel}
        confirmLabel={t("harness.addModel", "Add Model")}
        cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")}
        disabled={!selectedModelIndex}
      >
        {modalCandidates.length ? (
          <Field label={t("harness.addModal.model", "Eligible model")}>
            <select value={selectedModelIndex} onChange={(event) => setSelectedModelIndex(event.target.value)}>
              {modalCandidates.map(({ model, index }) => (
                <option key={index} value={index}>
                  {model.displayName || model.id || t("harness.unnamedModel", "Unnamed model")} ({model.id || "-"})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="empty-state">{t("harness.noEligible", "No additional eligible models are available.")}</div>
        )}
      </Modal>
    </div>
  );
}