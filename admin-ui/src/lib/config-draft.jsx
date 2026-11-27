import { fetchLatestConfig, retryConfigurationApplication, rollbackConfiguration, saveConfig } from "../api.js";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cloneJson, computeConfigDiff, inspectConfigStructure, setValueByPath } from "../utils.js";

const Context = createContext(null);

export function ConfigDraftProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [lastLoadedText, setLastLoadedText] = useState("");
  const [entityDrafts, setEntityDrafts] = useState({});
  const loadedConfig = useMemo(() => lastLoadedText ? JSON.parse(lastLoadedText) : {}, [lastLoadedText]);
  const diff = useMemo(() => computeConfigDiff(loadedConfig, config || {}), [loadedConfig, config]);
  const updateConfig = useCallback(mutator => setConfig(current => {
    const next = cloneJson(current || {});
    mutator(next);
    return next;
  }), []);
  const updateField = useCallback((path, value) => updateConfig(next => setValueByPath(next, path, value)), [updateConfig]);
  const value = { config, setConfig, lastLoadedText, setLastLoadedText, loadedConfig, diff, updateConfig, updateField, entityDrafts, setEntityDrafts };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConfigDraft() {
  const context = useContext(Context);
  if (!context) throw new Error("ConfigDraftProvider is required");
  return context;
}

export function useConfigActions({
  t, dirty, pendingMappingJson, pricingCatalogError, jsonError, setError, setMessage,
  loadRequestRef, applyLoadedConfig, loadSecondaryData, loadAll, loadCaddyStatusAction, closeHistory
}) {
  const { config, setConfig, lastLoadedText, entityDrafts } = useConfigDraft();
  const hasEntityDrafts = Object.keys(entityDrafts).length > 0;
  const [configConflict, setConfigConflict] = useState(null);
  const [lastApplication, setLastApplication] = useState(null);
  const [applyingStage, setApplyingStage] = useState("");
  const [saving, setSaving] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const conflictRequestRef = useRef(0);

  function confirmConfigIssues(nextConfig) {
    const issues = inspectConfigStructure(nextConfig);
    if (!issues.length) return true;
    return window.confirm(`${t("config.validation.confirm", "The current configuration still has structural issues. Save anyway?")}\n- ${issues.slice(0, 5).join("\n- ")}`);
  }

  async function persistConfig(nextConfig, successMessage) {
    if (hasEntityDrafts) throw new Error(t("ui.unapplied"));
    if (pendingMappingJson) throw new Error(t("channel.pendingJson"));
    const result = await saveConfig(nextConfig);
    acceptPersistedResult(result, successMessage);
  }

  function acceptPersistedResult(result, successMessage) {
    const saved = result.config;
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    applyLoadedConfig(saved);
    void loadSecondaryData(requestId, { notifyOnError: true });
    reportApplication(result.apply, successMessage);
  }

  function reportApplication(apply, successMessage) {
    setLastApplication(apply || null);
    const warnings = [];
    if (apply?.proxy?.ok === false) {
      warnings.push(t("messages.savedButProxyFailed", "Configuration was saved, but proxy settings could not be fully applied: {error}", { error: apply.proxy.error }));
    }
    if (apply?.caddy?.ok === false) {
      warnings.push(t("messages.savedButCaddyFailed", "Configuration was saved, but Caddy could not apply it: {error}", {
        error: apply.caddy.error || "Caddy reload failed"
      }));
    }
    if (apply?.persistence?.pendingDatabaseSync) {
      warnings.push(t("messages.savedPendingDatabase", "Configuration was saved locally; database synchronization is pending."));
    }
    for (const failure of [apply?.persistence?.cacheError, apply?.persistence?.historyError]) {
      if (failure) warnings.push(t("messages.savedButCopyFailed", "Configuration was saved, but a cache/history copy failed: {error}", { error: failure.message }));
    }
    setError(warnings.join(" "));
    setMessage(warnings.length ? "" : successMessage);
  }

  function closeConfigConflict() {
    conflictRequestRef.current++;
    setConfigConflict(null);
  }

  async function retryApplication(stage) {
    setApplyingStage(stage);
    try {
      const result = await retryConfigurationApplication(stage);
      reportApplication(result.apply, t("config.apply.retried", "Configuration application retried."));
      await loadCaddyStatusAction();
    } catch (failure) {
      await reportConfigSaveError(failure, t("messages.saveFailed", "Save failed."));
    } finally {
      setApplyingStage("");
    }
  }

  async function restoreHistoricalConfig(id) {
    if (!confirmDiscardChanges()) return;
    setSaving(true);
    try {
      const result = await rollbackConfiguration(id);
      acceptPersistedResult(result, t("config.history.restored", "Historical configuration restored as a new revision."));
      closeHistory(true);
    } catch (failure) {
      if (failure.payload?.code !== "CONFIG_REVISION_CONFLICT") throw failure;
      closeHistory(false);
      await reportConfigSaveError(failure, t("messages.saveFailed", "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  async function showConfigConflict() {
    const requestId = ++conflictRequestRef.current;
    setConfigConflict({ loading: true, latest: null, error: "" });
    try {
      const latest = await fetchLatestConfig();
      if (requestId !== conflictRequestRef.current) return;
      setConfigConflict({ loading: false, latest: latest.config, activeRevision: latest.activeRevision, error: "" });
    } catch (loadError) {
      if (requestId !== conflictRequestRef.current) return;
      setConfigConflict({ loading: false, latest: null, error: loadError.message || t("messages.loadFailed", "Load failed.") });
    }
  }

  async function reportConfigSaveError(saveError, fallback, attemptedConfig = config) {
    if (saveError.payload?.code !== "CONFIG_REVISION_CONFLICT") {
      setError(saveError.message || fallback);
      return;
    }
    if (attemptedConfig !== config) setConfig(attemptedConfig);
    await showConfigConflict();
  }

  async function handleSave() {
    if (!config) return;
    if (hasEntityDrafts) {
      setError(t("ui.unapplied"));
      return;
    }
    if (pendingMappingJson) {
      setError(t("channel.pendingJson"));
      return;
    }
    if (pricingCatalogError || jsonError) {
      setError(t("messages.invalidJson", "JSON parse errors must be fixed before saving."));
      return;
    }
    if (!confirmConfigIssues(config)) {
      return;
    }
    setShowSaveModal(true);
  }

  async function proceedSave() {
    setShowSaveModal(false);
    setSaving(true);
    setError("");
    try {
      await persistConfig(config, t("messages.saved", "Configuration saved. React admin now covers configuration, governance, and baseline operations."));
    } catch (saveError) {
      await reportConfigSaveError(saveError, t("messages.saveFailed", "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  function confirmDiscardChanges() {
    return (!dirty && !hasEntityDrafts) || window.confirm(t("changes.discardConfirm", "Discard all unsaved changes?"));
  }

  function handleDiscardChanges() {
    if (!lastLoadedText || !confirmDiscardChanges()) return;
    try {
      applyLoadedConfig(JSON.parse(lastLoadedText));
      setMessage(t("messages.discarded", "Unsaved changes discarded."));
    } catch {
      setError(t("messages.loadFailed", "Load failed."));
    }
  }

  async function handleReload(mode = "load", { discardPendingDatabaseSync = false, expectedRevision } = {}) {
    if (discardPendingDatabaseSync && !window.confirm(t("config.conflict.discardPending", "Reloading may discard locally saved configuration awaiting database synchronization, as well as your draft. Continue?"))) return;
    if (!confirmDiscardChanges()) return;
    await loadAll(mode, { discardPendingDatabaseSync, expectedRevision });
  }
  return {
    configConflict, lastApplication, applyingStage, saving, setSaving, showSaveModal, setShowSaveModal,
    confirmConfigIssues, persistConfig, reportApplication, closeConfigConflict, retryApplication,
    restoreHistoricalConfig, showConfigConflict, reportConfigSaveError, handleSave, proceedSave,
    handleDiscardChanges, handleReload
  };
}
