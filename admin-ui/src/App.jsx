import { startTransition, useEffect, useMemo, useState } from "react";
import {
  fetchCaddyStatus,
  fetchConfig,
  fetchDatabaseConfig,
  fetchLogs,
  fetchPricingLibrary,
  fetchRuntime,
  fetchStats,
  reloadConfig,
  restartService,
  saveConfig,
  sendProxyRequest,
  syncRuntime,
  syncPricingLibrary,
  testDatabaseConnection,
  verifyAad
} from "./api.js";
import AdvancedTab from "./components/AdvancedTab.jsx";
import KeysTab from "./components/KeysTab.jsx";
import OpsTab from "./components/OpsTab.jsx";
import { bundledPricingLibrary } from "./pricing-library.js";
import RoutingTab from "./components/RoutingTab.jsx";
import RuntimeTab from "./components/RuntimeTab.jsx";
import WorkspaceTab from "./components/WorkspaceTab.jsx";
import { StatCard, TabButton, Modal } from "./components/ui.jsx";
import { useI18n } from "./i18n.jsx";
import toast from "react-hot-toast";
import {
  applyCompressionPresetToConfig,
  buildLogSummaryText,
  buildConfigDiffPreview,
  buildImagePlaceholderPayload,
  buildModelFromPricingTemplate,
  buildSuggestedUpstreamName,
  buildUpstreamFromPricingTemplate,
  computeConfigDiff,
  DEFAULT_KEY_TEMPLATE,
  DEFAULT_LOG_FILTERS,
  DEFAULT_MODEL_TEMPLATE,
  DEFAULT_UPSTREAM_TEMPLATE,
  TEST_ENDPOINTS,
  buildCaddyPreview,
  buildDefaultTestPayload,
  cloneJson,
  describeLoggingRuntime,
  describePersistenceRuntime,
  ensureUniqueName,
  formatDateTime,
  formatBytes,
  getPayloadEditorNote,
  getLogDetails,
  getLocalizedLogEventLabel,
  getLogMessage,
  getLocalizedLogSourceLabel,
  getValueByPath,
  inspectConfigStructure,
  pickCompressionPreset,
  prepareProxyPayload,
  supportsPricingTemplate,
  setValueByPath
} from "./utils.js";

function statusLabel(configured, enabled) {
  if (configured) return "configured";
  if (enabled) return "incomplete";
  return "disabled";
}

const DEFAULT_RUNTIME_FILTERS = {
  keyId: "",
  timeRange: "all"
};

function pricingSyncSourceFromStatus(status) {
  return {
    owner: String(status?.githubOwner || ""),
    repo: String(status?.githubRepo || ""),
    path: String(status?.githubPath || "pricing"),
    ref: String(status?.githubRef || "")
  };
}

function normalizeDatabaseConfigForm(value = {}) {
  return {
    provider: String(value.provider || "postgresql").trim() || "postgresql",
    connectionRef: String(value.connectionRef || "").trim(),
    connectionString: String(value.connectionString || "").trim(),
    schemaName: String(value.schemaName || "public").trim() || "public",
    tableName: String(value.tableName || "proxy_configs").trim() || "proxy_configs",
    configKey: String(value.configKey || "active").trim() || "active"
  };
}

export default function App() {
  const { language, languages, setLanguage, t } = useI18n();
  const [config, setConfig] = useState(null);
  const [lastLoadedText, setLastLoadedText] = useState("");
  const [runtime, setRuntime] = useState(null);
  const [stats, setStats] = useState(null);
  const [pricingLibrary, setPricingLibrary] = useState([]);
  const [pricingLibraryStatus, setPricingLibraryStatus] = useState(null);
  const [pricingSyncSource, setPricingSyncSource] = useState({ owner: "", repo: "", path: "pricing", ref: "" });
  const [databaseConfigForm, setDatabaseConfigForm] = useState(() => normalizeDatabaseConfigForm());
  const [databaseTestResult, setDatabaseTestResult] = useState(null);
  const [logs, setLogs] = useState({ total: 0, limit: 100, items: [] });
  const [caddyStatus, setCaddyStatus] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("workspace");
  const [advancedJson, setAdvancedJson] = useState("{}");
  const [pricingCatalogText, setPricingCatalogText] = useState("{}");
  const [pricingCatalogError, setPricingCatalogError] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logFilters, setLogFilters] = useState(DEFAULT_LOG_FILTERS);
  const [aadStatus, setAadStatus] = useState(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState({ verify: false, restart: false, test: false, pricingSync: false, databaseTest: false, databaseDefaults: false, runtimeSync: false });
  const [testEndpoint, setTestEndpoint] = useState(TEST_ENDPOINTS[0]);
  const [testApiKey, setTestApiKey] = useState("");
  const [testPayloadText, setTestPayloadText] = useState(JSON.stringify(buildDefaultTestPayload(TEST_ENDPOINTS[0], null), null, 2));
  const [testResponseText, setTestResponseText] = useState("");
  const [compressionEnabled, setCompressionEnabled] = useState(true);
  const [compressionPreset, setCompressionPreset] = useState("light");
  const [imageFile, setImageFile] = useState(null);
  const [imageFileInfo, setImageFileInfo] = useState("");
  const [compressionStats, setCompressionStats] = useState("");
  const [payloadNote, setPayloadNote] = useState("");
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showModelTemplateModal, setShowModelTemplateModal] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState("");
  const [runtimeFilters, setRuntimeFilters] = useState(DEFAULT_RUNTIME_FILTERS);
  const [modelTemplateSearch, setModelTemplateSearch] = useState("");
  const [selectedPricingTemplateId, setSelectedPricingTemplateId] = useState("");
  const [templateUpstreamMode, setTemplateUpstreamMode] = useState("existing");
  const [selectedTemplateUpstreamName, setSelectedTemplateUpstreamName] = useState("");
  const [templateNewUpstreamName, setTemplateNewUpstreamName] = useState("");
  const [templateImportPricing, setTemplateImportPricing] = useState(true);

  const dirty = useMemo(() => JSON.stringify(config ?? {}, null, 2) !== lastLoadedText, [config, lastLoadedText]);
  const advancedJsonEnabled = getValueByPath(config, "admin.features.enableLegacyJsonEditor") !== false;
  const governanceKeys = stats?.governance?.keys || [];
  const modelStats = stats?.perModel || {};
  const perKeyStats = stats?.perKey || {};
  const persistenceRuntime = runtime?.persistence || {};
  const loggingRuntime = runtime?.logging || {};
  const runtimeStore = runtime?.runtimeStore || {};
  const logLevelKey = logFilters.level.join(",");
  const caddyPreview = useMemo(
    () => buildCaddyPreview(config?.server?.caddy || {}, config?.server?.port),
    [config?.server?.caddy, config?.server?.port]
  );
  const persistenceRuntimeText = useMemo(
    () => describePersistenceRuntime(persistenceRuntime, t),
    [persistenceRuntime, t]
  );
  const loggingRuntimeText = useMemo(
    () => describeLoggingRuntime(loggingRuntime, t),
    [loggingRuntime, t]
  );
  const loadedConfig = useMemo(() => {
    if (!lastLoadedText) return {};
    try {
      return JSON.parse(lastLoadedText);
    } catch {
      return {};
    }
  }, [lastLoadedText]);
  const supportedPricingTemplates = useMemo(
    () => (pricingLibrary || []).filter((definition) => supportsPricingTemplate(definition)),
    [pricingLibrary]
  );
  const filteredPricingTemplates = useMemo(() => {
    const keyword = modelTemplateSearch.trim().toLowerCase();
    return supportedPricingTemplates.filter((definition) => {
      if (!keyword) return true;
      return [
        definition.id,
        definition.displayName,
        definition.provider,
        definition.family,
        ...(definition.interfaces || [])
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    });
  }, [supportedPricingTemplates, modelTemplateSearch]);
  const selectedPricingTemplate = useMemo(
    () => supportedPricingTemplates.find((definition) => definition.id === selectedPricingTemplateId) || null,
    [supportedPricingTemplates, selectedPricingTemplateId]
  );
  const runtimeKeyOptions = useMemo(() => {
    const items = new Map();
    for (const apiKey of Array.isArray(config?.apiKeys) ? config.apiKeys : []) {
      const keyId = String(apiKey?.id || apiKey?.displayName || "").trim();
      if (!keyId) continue;
      const owner = String(apiKey?.owner || "").trim();
      const displayName = String(apiKey?.displayName || keyId).trim() || keyId;
      items.set(keyId, {
        value: keyId,
        label: owner ? `${displayName} · ${owner}` : displayName
      });
    }
    for (const entry of governanceKeys) {
      const keyId = String(entry?.keyId || "").trim();
      if (!keyId || items.has(keyId)) continue;
      items.set(keyId, {
        value: keyId,
        label: String(entry?.displayName || keyId).trim() || keyId
      });
    }
    return Array.from(items.values()).sort((left, right) => left.label.localeCompare(right.label));
  }, [config?.apiKeys, governanceKeys]);

  // Hook to warn the user if they try to close or refresh the tab with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  const configIssues = useMemo(() => inspectConfigStructure(config || {}), [config]);
  const configDiff = useMemo(() => computeConfigDiff(loadedConfig, config || {}), [loadedConfig, config]);
  const configDiffCount = useMemo(
    () => (configDiff.added.length + configDiff.removed.length + configDiff.changed.length),
    [configDiff]
  );
  const configDiffPreview = useMemo(() => buildConfigDiffPreview(configDiff, t), [configDiff, t]);

  async function loadCaddyStatusAction() {
    const json = await fetchCaddyStatus();
    startTransition(() => {
      setCaddyStatus(json.status || null);
    });
    return json.status || null;
  }

  async function loadLogsAction(filters = logFilters) {
    setLogsLoading(true);
    try {
      const json = await fetchLogs({
        level: filters.level,
        event: filters.event,
        modelId: filters.modelId,
        requestId: filters.requestId,
        keyword: filters.keyword,
        limit: filters.limit
      });
      startTransition(() => {
        setLogs({
          total: json.total || 0,
          limit: json.limit || filters.limit,
          items: Array.isArray(json.items) ? json.items : []
        });
      });
    } catch (loadError) {
      setError(loadError.message || t("messages.logsLoadFailed", "Failed to load logs."));
    } finally {
      setLogsLoading(false);
    }
  }

  async function refreshRuntimeAndStats(filters = runtimeFilters) {
    const [runtimeJson, statsJson] = await Promise.all([fetchRuntime(), fetchStats(filters)]);
    startTransition(() => {
      setRuntime(runtimeJson.runtime || null);
      setStats(statsJson || null);
    });
  }

  async function loadAll(mode = "load") {
    setLoading(true);
    setError("");
    try {
      const configJson = mode === "reload"
        ? await reloadConfig().then((result) => result.config)
        : await fetchConfig();
      const [runtimeJson, statsJson, caddyJson, pricingJson] = await Promise.all([
        fetchRuntime(),
        fetchStats(runtimeFilters),
        fetchCaddyStatus(),
        fetchPricingLibrary().catch(() => ({ items: bundledPricingLibrary }))
      ]);
      const databaseJson = await fetchDatabaseConfig().catch(() => ({ config: null }));
      const pricingItems = Array.isArray(pricingJson.items) && pricingJson.items.length
        ? pricingJson.items
        : bundledPricingLibrary;
      startTransition(() => {
        setConfig(configJson);
        const text = JSON.stringify(configJson, null, 2);
        setAdvancedJson(text);
        setLastLoadedText(text);
        setPricingCatalogText(JSON.stringify(configJson?.access?.pricingCatalog || {}, null, 2));
        setPricingCatalogError("");
        setJsonError("");
        setRuntime(runtimeJson.runtime || null);
        setStats(statsJson || null);
        setCaddyStatus(caddyJson.status || null);
        setPricingLibrary(pricingItems);
        setPricingLibraryStatus(pricingJson.status || null);
        setPricingSyncSource(pricingSyncSourceFromStatus(pricingJson.status || null));
        if (databaseJson?.config) {
          setDatabaseConfigForm(normalizeDatabaseConfigForm(databaseJson.config));
        }
        setDatabaseTestResult(null);
      });
      setMessage(mode === "reload" ? t("messages.reloaded", "Configuration reloaded from persistent store.") : t("messages.loaded", "Configuration loaded."));
    } catch (loadError) {
      setError(loadError.message || t("messages.loadFailed", "Load failed."));
    } finally {
      setLoading(false);
    }
  }

  async function handleRuntimeFilterChange(patch) {
    const nextFilters = {
      ...runtimeFilters,
      ...patch
    };
    setRuntimeFilters(nextFilters);
    try {
      await refreshRuntimeAndStats(nextFilters);
    } catch (loadError) {
      setError(loadError.message || t("messages.loadFailed", "Load failed."));
    }
  }

  async function handleRuntimeSync() {
    setDiagnosticsBusy((current) => ({ ...current, runtimeSync: true }));
    try {
      const result = await syncRuntime();
      startTransition(() => {
        setRuntime(result.runtime || null);
      });
      await refreshRuntimeAndStats(runtimeFilters);
      setMessage(t("messages.runtimeSyncSuccess", "Runtime sync completed."));
    } catch (syncError) {
      setError(syncError.message || t("messages.runtimeSyncFailed", "Runtime sync failed."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, runtimeSync: false }));
    }
  }

  useEffect(() => {
    if (message) {
      toast.success(message, { id: 'msg-success' });
      setMessage("");
    }
  }, [message]);

  useEffect(() => {
    if (error) {
      toast.error(error, { id: 'msg-error', duration: 5000 });
      setError("");
    }
  }, [error]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!config) return;
    setAdvancedJson(JSON.stringify(config, null, 2));
  }, [config]);

  useEffect(() => {
    if (!config) return;
    setPricingCatalogText(JSON.stringify(config?.access?.pricingCatalog || {}, null, 2));
  }, [config?.access?.pricingCatalog]);

  useEffect(() => {
    if (!config) return;
    const compressionConfig = getValueByPath(config, "media.inputCompression") || getValueByPath(config, "server.imageCompression") || {};
    setCompressionEnabled(compressionConfig.enabled !== false);
    setCompressionPreset(pickCompressionPreset(compressionConfig));
  }, [config]);

  useEffect(() => {
    if (activeTab !== "ops") return;
    if (!caddyStatus) {
      void loadCaddyStatusAction();
    }
  }, [activeTab, caddyStatus]);

  useEffect(() => {
    if (activeTab !== "ops") return undefined;
    const timer = setTimeout(() => {
      void loadLogsAction(logFilters);
    }, 180);
    return () => clearTimeout(timer);
  }, [activeTab, logLevelKey, logFilters.event, logFilters.modelId, logFilters.requestId, logFilters.keyword, logFilters.limit]);

  useEffect(() => {
    if (activeTab !== "ops" || !logFilters.autoRefresh) return undefined;
    const interval = setInterval(() => {
      void loadLogsAction(logFilters);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTab, logFilters.autoRefresh, logLevelKey, logFilters.event, logFilters.modelId, logFilters.requestId, logFilters.keyword, logFilters.limit]);

  function updateConfig(mutator) {
    setConfig((current) => {
      const next = cloneJson(current || {});
      mutator(next);
      return next;
    });
  }

  function updateField(path, value) {
    updateConfig((next) => {
      setValueByPath(next, path, value);
    });
  }

  function updatePricingCatalog(text) {
    setPricingCatalogText(text);
    try {
      const parsed = JSON.parse(text || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(t("messages.pricingCatalogObject", "pricingCatalog must be a JSON object."));
      }
      setPricingCatalogError("");
      updateField("access.pricingCatalog", parsed);
    } catch (parseError) {
      setPricingCatalogError(parseError.message || t("messages.pricingCatalogInvalid", "Invalid pricingCatalog JSON."));
    }
  }

  function updateAdvancedJson(text) {
    setAdvancedJson(text);
    try {
      const parsed = JSON.parse(text || "{}");
      setJsonError("");
      setConfig(parsed);
    } catch (parseError) {
      setJsonError(parseError.message || t("messages.advancedJsonInvalid", "Invalid JSON."));
    }
  }

  function confirmConfigIssues(nextConfig) {
    const issues = inspectConfigStructure(nextConfig);
    if (!issues.length) return true;
    return window.confirm(`${t("config.validation.confirm", "The current configuration still has structural issues. Save anyway?")}\n- ${issues.slice(0, 5).join("\n- ")}`);
  }

  async function persistConfig(nextConfig, successMessage) {
    const saved = await saveConfig(nextConfig).then((result) => result.config);
    const text = JSON.stringify(saved, null, 2);
    startTransition(() => {
      setConfig(saved);
      setAdvancedJson(text);
      setLastLoadedText(text);
    });
    const databaseJson = await fetchDatabaseConfig().catch(() => ({ config: null }));
    await Promise.all([refreshRuntimeAndStats(), loadCaddyStatusAction()]);
    if (databaseJson?.config) {
      startTransition(() => {
        setDatabaseConfigForm(normalizeDatabaseConfigForm(databaseJson.config));
      });
    }
    setMessage(successMessage);
  }

  async function handleReloadDatabaseDefaults() {
    setDiagnosticsBusy((current) => ({ ...current, databaseDefaults: true }));
    setError("");
    try {
      const json = await fetchDatabaseConfig();
      startTransition(() => {
        setDatabaseConfigForm(normalizeDatabaseConfigForm(json.config || {}));
        setDatabaseTestResult(null);
      });
      setMessage(t("messages.databaseDefaultsLoaded", "Database defaults loaded from the current environment."));
    } catch (loadError) {
      setError(loadError.message || t("messages.databaseDefaultsLoadFailed", "Failed to load database defaults."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, databaseDefaults: false }));
    }
  }

  async function handleTestDatabaseConnection() {
    setDiagnosticsBusy((current) => ({ ...current, databaseTest: true }));
    setError("");
    try {
      const json = await testDatabaseConnection(databaseConfigForm);
      startTransition(() => {
        setDatabaseTestResult({
          ok: true,
          checkedAt: new Date().toISOString(),
          result: json.result || null
        });
      });
      setMessage(t("messages.databaseTestSuccess", "Database connection test succeeded."));
    } catch (testError) {
      startTransition(() => {
        setDatabaseTestResult({
          ok: false,
          checkedAt: new Date().toISOString(),
          error: testError.message || t("messages.databaseTestFailed", "Database connection test failed.")
        });
      });
      setError(testError.message || t("messages.databaseTestFailed", "Database connection test failed."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, databaseTest: false }));
    }
  }

  async function handleSave() {
    if (!config) return;
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
      setError(saveError.message || t("messages.saveFailed", "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  function addApiKey() {
    updateConfig((next) => {
      next.apiKeys = Array.isArray(next.apiKeys) ? next.apiKeys : [];
      next.apiKeys.push({
        ...cloneJson(DEFAULT_KEY_TEMPLATE),
        id: `key_${next.apiKeys.length + 1}`,
        budget: {
          ...cloneJson(DEFAULT_KEY_TEMPLATE.budget),
          currency: next?.access?.budgets?.defaultCurrency || "USD",
          windowType: next?.access?.budgets?.defaultWindowType || "monthly",
          softLimitRatio: Number(next?.access?.budgets?.softLimitRatio || DEFAULT_KEY_TEMPLATE.budget.softLimitRatio),
          hardLimitAction: next?.access?.budgets?.hardLimitAction || DEFAULT_KEY_TEMPLATE.budget.hardLimitAction
        }
      });
    });
  }

  function addUpstream() {
    updateConfig((next) => {
      next.upstreams = Array.isArray(next.upstreams) ? next.upstreams : [];
      next.upstreams.push({
        ...cloneJson(DEFAULT_UPSTREAM_TEMPLATE),
        name: `upstream_${next.upstreams.length + 1}`
      });
    });
  }

  function addBlankModel() {
    updateConfig((next) => {
      next.models = Array.isArray(next.models) ? next.models : [];
      next.models.push({
        ...cloneJson(DEFAULT_MODEL_TEMPLATE),
        id: `model_${next.models.length + 1}`,
        upstream: next.upstreams?.[0]?.name || ""
      });
    });
  }

  function addModel() {
    if (!supportedPricingTemplates.length) {
      addBlankModel();
      return;
    }

    const defaultTemplate = supportedPricingTemplates[0];
    setModelTemplateSearch("");
    setSelectedPricingTemplateId(defaultTemplate.id);
    setTemplateUpstreamMode((config?.upstreams || []).length > 0 ? "existing" : "new");
    setSelectedTemplateUpstreamName(config?.upstreams?.[0]?.name || "");
    setTemplateNewUpstreamName(buildSuggestedUpstreamName(defaultTemplate, config));
    setTemplateImportPricing(true);
    setShowModelTemplateModal(true);
  }

  function applyPricingTemplateSelection() {
    if (!selectedPricingTemplate) return;

    updateConfig((next) => {
      next.upstreams = Array.isArray(next.upstreams) ? next.upstreams : [];
      next.models = Array.isArray(next.models) ? next.models : [];

      let upstreamName = selectedTemplateUpstreamName;
      const existingUpstreamNames = next.upstreams.map((item) => item?.name).filter(Boolean);
      const shouldCreateNewUpstream = templateUpstreamMode === "new" || !upstreamName;

      if (shouldCreateNewUpstream) {
        upstreamName = ensureUniqueName(
          templateNewUpstreamName || buildSuggestedUpstreamName(selectedPricingTemplate, next),
          existingUpstreamNames
        );
        next.upstreams.push(buildUpstreamFromPricingTemplate(selectedPricingTemplate, upstreamName));
      }

      const modelEntry = buildModelFromPricingTemplate(selectedPricingTemplate, upstreamName, next);
      next.models.push(modelEntry);

      if (templateImportPricing && selectedPricingTemplate.pricingCatalogEntry && modelEntry.pricingRef) {
        next.access = next.access && typeof next.access === "object" ? next.access : {};
        next.access.pricingCatalog = next.access.pricingCatalog && typeof next.access.pricingCatalog === "object"
          ? next.access.pricingCatalog
          : {};
        next.access.pricingCatalog[modelEntry.pricingRef] = cloneJson(selectedPricingTemplate.pricingCatalogEntry);
      }

      const upstream = next.upstreams.find((item) => item?.name === upstreamName);
      if (upstream && (!Array.isArray(upstream.capabilities) || upstream.capabilities.length === 0)) {
        upstream.capabilities = [...modelEntry.capabilities];
      }
    });

    setShowModelTemplateModal(false);
  }

  function toggleLogLevel(level) {
    setLogFilters((current) => {
      const exists = current.level.includes(level);
      const nextLevels = exists
        ? current.level.filter((item) => item !== level)
        : [...current.level, level];
      return {
        ...current,
        level: nextLevels
      };
    });
  }

  function handleApplyRequestIdFilter(requestId) {
    if (!requestId) return;
    const nextFilters = { ...logFilters, requestId };
    setLogFilters(nextFilters);
    setMessage(t("logs.filterApplied", "Filtered logs by request ID {requestId}.", { requestId }));
    void loadLogsAction(nextFilters);
  }

  async function handleCopyLogSummary(entry) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("messages.clipboardUnavailable", "Clipboard access is unavailable in this browser."));
      }
      await navigator.clipboard.writeText(buildLogSummaryText(entry, t, formatDateTime));
      setMessage(t("logs.copySuccess", "Log summary copied to clipboard."));
    } catch (copyError) {
      setError(copyError.message || t("logs.copyFailed", "Failed to copy log summary."));
    }
  }

  async function handleVerifyAad() {
    setDiagnosticsBusy((current) => ({ ...current, verify: true }));
    setError("");
    try {
      const json = await verifyAad();
      if (json.ok) {
        const detail = json.preview || json.tokenPreview || "";
        setAadStatus({
          state: "ok",
          detail,
          checkedAt: new Date().toISOString()
        });
        setMessage(`${t("messages.verifySuccess", "AAD verification succeeded")}${detail ? `: ${detail}` : "."}`);
      } else {
        setAadStatus({
          state: "failed",
          detail: json.error || t("common.unknown", "Unknown"),
          checkedAt: new Date().toISOString()
        });
        setError(`${t("messages.verifyFailed", "AAD verification failed")}: ${json.error || t("common.unknown", "Unknown")}`);
      }
    } catch (verifyError) {
      setError(verifyError.message || t("messages.verifyFailed", "AAD verification failed"));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, verify: false }));
    }
  }

  async function handleRestartService() {
    setDiagnosticsBusy((current) => ({ ...current, restart: true }));
    setError("");
    try {
      await restartService();
      setMessage(t("messages.restartRequested", "Restart request sent. Polling Caddy state."));
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const status = await loadCaddyStatusAction();
        if (["running", "error", "disabled"].includes(status?.state)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (restartError) {
      setError(restartError.message || t("messages.restartFailed", "Failed to request restart."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, restart: false }));
    }
  }

  async function handleSyncPricingLibrary() {
    setDiagnosticsBusy((current) => ({ ...current, pricingSync: true }));
    setError("");
    try {
      const result = await syncPricingLibrary({
        owner: String(pricingSyncSource.owner || "").trim(),
        repo: String(pricingSyncSource.repo || "").trim(),
        path: String(pricingSyncSource.path || "").trim(),
        ref: String(pricingSyncSource.ref || "").trim()
      });
      startTransition(() => {
        setPricingLibrary(Array.isArray(result.items) && result.items.length ? result.items : bundledPricingLibrary);
        setPricingLibraryStatus(result.status || null);
        setPricingSyncSource(pricingSyncSourceFromStatus(result.status || null));
      });
      setMessage(t("messages.pricingSyncSuccess", "Pricing library synced from GitHub ({count} files).", { count: result.syncedFiles || 0 }));
    } catch (syncError) {
      setError(syncError.message || t("messages.pricingSyncFailed", "Failed to sync pricing library from GitHub."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, pricingSync: false }));
    }
  }

  function resetTestPayload() {
    setTestPayloadText(JSON.stringify(buildDefaultTestPayload(testEndpoint, config), null, 2));
    setPayloadNote("");
    setCompressionStats("");
  }

  function handleInsertImagePlaceholder(kind) {
    setTestPayloadText(JSON.stringify(buildImagePlaceholderPayload(kind, t), null, 2));
    setPayloadNote("");
    setCompressionStats("");
  }

  function handleImageFileChange(file) {
    setImageFile(file || null);
    setImageFileInfo(file ? `${t("compress.file.selected", "Selected file")}: ${file.name} (${formatBytes(file.size)})` : t("compress.file.none", "No image file selected."));
  }

  async function handleApplyCompressionConfig() {
    if (!config) return;
    if (pricingCatalogError || jsonError) {
      setError(t("messages.invalidJson", "JSON parse errors must be fixed before saving."));
      return;
    }
    if (!window.confirm(t("compress.apply.confirm", "Apply the current image compression preset to configuration and save?"))) {
      return;
    }
    const nextConfig = cloneJson(config);
    applyCompressionPresetToConfig(nextConfig, compressionPreset, compressionEnabled);
    if (!confirmConfigIssues(nextConfig)) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await persistConfig(nextConfig, t("compress.apply.ok", "Compression preset applied to configuration and saved."));
    } catch (saveError) {
      setError(saveError.message || t("compress.apply.invalid", "Failed to apply compression preset."));
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTestRequest() {
    let payload;
    try {
      payload = JSON.parse(testPayloadText);
    } catch (parseError) {
      setError(parseError.message || t("messages.invalidRequestJson", "Invalid request JSON."));
      return;
    }
    setDiagnosticsBusy((current) => ({ ...current, test: true }));
    setError("");
    setTestResponseText(t("ops.requestPending", "Sending request..."));
    try {
      const prepared = await prepareProxyPayload(payload, {
        imageFile,
        compressionEnabled,
        presetKey: compressionPreset,
        t
      });
      payload = prepared.payload;
      setCompressionStats(prepared.statsText || "");
      const nextPayloadText = JSON.stringify(payload, null, 2);
      setPayloadNote(getPayloadEditorNote(nextPayloadText, t));
      if (nextPayloadText.length <= 200000) {
        setTestPayloadText(nextPayloadText);
      }
      const response = await sendProxyRequest(testEndpoint, payload, testApiKey);
      const statusLine = `HTTP ${response.status} ${response.statusText}`.trim();
      if (payload?.stream === true && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = `${statusLine}\n\n`;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          setTestResponseText(text);
        }
        return;
      }
      const text = await response.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        body = text || t("messages.emptyBody", "<empty body>");
      }
      setTestResponseText(`${statusLine}\n\n${body}`);
      await Promise.all([refreshRuntimeAndStats(), loadLogsAction(logFilters)]);
    } catch (requestError) {
      const requestMessage = requestError.message || t("messages.requestFailed", "Failed to send test request.");
      setError(requestMessage);
      setTestResponseText(requestMessage);
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, test: false }));
    }
  }

  const summary = useMemo(() => {
    const totals = stats?.totals || {};
    const blocked = governanceKeys.reduce((sum, item) => sum + Number(item?.runtime?.totalBlockedRequests || 0), 0);
    return {
      requests: totals.requests || 0,
      errors: totals.errors || 0,
      cost: `${Number(totals.estimatedCostAmount || 0).toFixed(4)} ${totals.estimatedCostCurrency || "USD"}`,
      blocked,
      persistence: runtime?.persistence?.activeMode || runtime?.persistence?.mode || "file",
      logging: statusLabel(runtime?.logging?.configured, runtime?.logging?.enabled),
      caddy: caddyStatus?.state || (config?.server?.caddy?.enabled ? "unknown" : "disabled")
    };
  }, [runtime, stats, governanceKeys, caddyStatus, config?.server?.caddy?.enabled]);

  const keySectionLinks = (config?.apiKeys || []).map((item, index) => ({
    id: `key-card-${index}`,
    label: item.displayName || item.id || t("keys.itemFallback", "Key {index}", { index: index + 1 })
  }));
  const upstreamSectionLinks = (config?.upstreams || []).map((item, index) => ({
    id: `upstream-card-${index}`,
    label: item.name || t("routing.upstreamFallback", "Upstream {index}", { index: index + 1 })
  }));
  const modelSectionLinks = (config?.models || []).map((item, index) => ({
    id: `model-card-${index}`,
    label: item.displayName || item.id || t("routing.itemFallback", "Model {index}", { index: index + 1 })
  }));

  const categories = [
    {
      id: "config",
      label: t("category.config", "配置控制台"),
      tabs: [
        { id: "workspace", label: t("tabs.workspace", "基础设置") },
        { id: "advanced", label: t("tabs.advanced", "JSON 编排") }
      ]
    },
    {
      id: "governance",
      label: t("category.governance", "策略与规则"),
      tabs: [
        { id: "keys", label: t("tabs.keys", "Key 治理") },
        { id: "routing", label: t("tabs.routing", "上游与模型") }
      ]
    },
    {
      id: "observability",
      label: t("category.observability", "监控与运维"),
      tabs: [
        { id: "runtime", label: t("tabs.runtime", "运行时统计") },
        { id: "ops", label: t("tabs.ops", "诊断与日志") }
      ]
    }
  ];

  const currentCategory = categories.find((c) => c.tabs.some((tab) => tab.id === activeTab)) || categories[0];
  const sectionLinksByTab = {
    workspace: [
      { id: "workspace-core", label: t("workspace.nav.core", "基础与默认值") },
      { id: "workspace-persistence", label: t("workspace.nav.persistence", "持久化与缓存") },
      { id: "workspace-logging", label: t("workspace.nav.logging", "日志与分析") },
      { id: "workspace-media", label: t("workspace.nav.media", "媒体策略") },
      { id: "workspace-routing", label: t("workspace.nav.routing", "路由域") }
    ],
    keys: [
      { id: "keys-overview", label: t("keys.nav.overview", "Key 概览") },
      ...keySectionLinks
    ],
    routing: [
      { id: "routing-upstreams", label: t("routing.nav.upstreams", "上游列表") },
      ...upstreamSectionLinks,
      { id: "routing-models", label: t("routing.nav.models", "模型配置") },
      ...modelSectionLinks
    ],
    ops: [
      { id: "ops-pricing", label: t("ops.nav.pricing", "Pricing 库") },
      { id: "ops-caddy", label: t("ops.nav.caddy", "Caddy 与服务") },
      { id: "ops-logs", label: t("ops.nav.logs", "运行日志") },
      { id: "ops-test", label: t("ops.nav.test", "代理测试") }
    ],
    runtime: [
      { id: "runtime-persistence", label: t("runtime.nav.persistence", "运行态") },
      { id: "runtime-keys", label: t("runtime.nav.keys", "Key 统计") },
      { id: "runtime-models", label: t("runtime.nav.models", "模型统计") }
    ]
  };
  const currentSectionLinks = sectionLinksByTab[activeTab] || [];
  const currentSectionIds = currentSectionLinks.map((link) => link.id).join("|");

  useEffect(() => {
    if (!currentSectionLinks.length) {
      setActiveSectionId("");
      return undefined;
    }

    const sectionElements = currentSectionLinks
      .map((link) => document.getElementById(link.id))
      .filter(Boolean);

    if (!sectionElements.length) {
      setActiveSectionId(currentSectionLinks[0]?.id || "");
      return undefined;
    }

    setActiveSectionId((current) => current || sectionElements[0].id);

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (visible[0]?.target?.id) {
          setActiveSectionId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-18% 0px -52% 0px",
        threshold: [0.2, 0.4, 0.7]
      }
    );

    sectionElements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [activeTab, currentSectionIds]);

  function handleSectionNavClick(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target) return;

    if (target instanceof HTMLDetailsElement) {
      const group = target.dataset.accordionGroup;
      if (group) {
        document.querySelectorAll(`details[data-accordion-group="${group}"]`).forEach((item) => {
          if (item instanceof HTMLDetailsElement) {
            item.open = item.id === sectionId;
          }
        });
      }
      target.open = true;
    }

    setActiveSectionId(sectionId);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (loading && !config) {
    return <div className="app-shell"><div className="loading">{t("common.loadingAdmin", "Loading React admin...")}</div></div>;
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <span className="eyebrow">{t("hero.eyebrow", "AOAI Proxy Admin")}</span>
          <h1>{t("hero.title", "AOAI Proxy Admin Console")}</h1>
          <p>{t("hero.subtitle", "面向 AOAI Proxy 的统一管理控制台，聚合配置治理、模型路由、运行监控与诊断操作。")}</p>
        </div>
        <div className="toolbar hero-actions">
          <label className="inline">
            <span>{t("common.language", "Language")}</span>
            <select value={language} onChange={(event) => setLanguage(event.target.value)}>
              {languages.map((code) => <option key={code} value={code}>{t(`lang.${code}`, code)}</option>)}
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => loadAll()}>{t("hero.reload", "Reload")}</button>
          <button type="button" className="ghost" onClick={() => loadAll("reload")}>{t("hero.reloadFromStore", "Reload From Store")}</button>
          <button type="button" onClick={handleSave} disabled={saving || !config}>{saving ? t("hero.saving", "Saving...") : t("hero.save", "Save Configuration")}</button>
        </div>
      </header>

      <section className="summary-grid">
        <StatCard label={t("summary.requests", "Requests")} value={summary.requests} note={`${t("summary.errors", "Errors")} ${summary.errors}`} />
        <StatCard label={t("summary.cost", "Estimated Cost")} value={summary.cost} note={`${t("summary.blocked", "Blocked")} ${summary.blocked}`} />
        <StatCard label={t("summary.persistence", "Persistence")} value={t(`option.${summary.persistence}`, summary.persistence)} note={`${t("summary.logging", "Logging")} ${t(`status.${summary.logging}`, summary.logging)}`} />
        <StatCard label={t("summary.caddy", "Caddy")} value={t(`caddy.state.${summary.caddy}`, summary.caddy)} note={dirty ? t("summary.dirty", "Unsaved changes") : t("summary.synced", "Synced")} />
      </section>

      <Modal 
        title={t("config.save.title", "Confirm Configuration Save")} 
        isOpen={showSaveModal} 
        onClose={() => setShowSaveModal(false)}
        onConfirm={proceedSave}
        confirmLabel={t("btn.save", "Save")}
        disabled={saving}
      >
        <p>{t("config.save.desc", "You are about to hit Save. Please review the configuration changes below:")}</p>
        <div style={{ marginTop: '16px', marginBottom: '16px' }}>
          <strong>{t("config.diff.summary", "Changed paths:")} {configDiffCount}</strong>
        </div>
        {configDiffCount > 0 ? (
          <pre className="muted" style={{ padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '6px', whiteSpace: 'pre-wrap', maxHeight: '300px', overflowY: 'auto' }}>
            {configDiffPreview}
          </pre>
        ) : (
          <p className="muted">{t("config.diff.none", "No local diff")}</p>
        )}
      </Modal>

      <Modal
        title={t("routing.template.title", "Select Model Template")}
        isOpen={showModelTemplateModal}
        onClose={() => setShowModelTemplateModal(false)}
        onConfirm={applyPricingTemplateSelection}
        confirmLabel={t("routing.template.confirm", "Create Model")}
        disabled={!selectedPricingTemplate}
      >
        <div className="stack-lg">
          <p className="muted">{t("routing.template.desc", "Choose a pricing library template to fill model capabilities, routes, pricingRef, and optional pricing catalog entries.")}</p>
          <input
            type="search"
            className="search-field"
            placeholder={t("routing.template.search", "Search templates...")}
            value={modelTemplateSearch}
            onChange={(event) => setModelTemplateSearch(event.target.value)}
          />

          <div className="template-list">
            {filteredPricingTemplates.length ? filteredPricingTemplates.map((definition) => {
              const selected = definition.id === selectedPricingTemplateId;
              return (
                <button
                  key={definition.id}
                  type="button"
                  className={selected ? "template-option selected" : "template-option"}
                  onClick={() => setSelectedPricingTemplateId(definition.id)}
                >
                  <div className="template-option-head">
                    <strong>{definition.displayName}</strong>
                    <span>{definition.id}</span>
                  </div>
                  <div className="template-option-meta">
                    <span>{t("routing.template.provider", "Provider")}: {definition.provider}</span>
                    <span>{t("routing.template.interfaces", "Interfaces")}: {(definition.interfaces || []).join(", ") || "-"}</span>
                    <span>{t("routing.template.capabilities", "Capabilities")}: {(definition.capabilities || []).join(", ") || "-"}</span>
                  </div>
                </button>
              );
            }) : <div className="empty-state">{t("routing.template.noResults", "No matching templates found.")}</div>}
          </div>

          <div className="form-grid compact">
            <label className="field">
              <span className="field-label">{t("routing.template.upstreamMode", "Upstream Target")}</span>
              <select value={templateUpstreamMode} onChange={(event) => setTemplateUpstreamMode(event.target.value)}>
                <option value="existing">{t("routing.template.useExistingUpstream", "Use Existing Upstream")}</option>
                <option value="new">{t("routing.template.createNewUpstream", "Create New Upstream")}</option>
              </select>
            </label>

            {templateUpstreamMode === "existing" ? (
              <label className="field">
                <span className="field-label">{t("routing.template.selectUpstream", "Existing Upstream")}</span>
                <select value={selectedTemplateUpstreamName} onChange={(event) => setSelectedTemplateUpstreamName(event.target.value)}>
                  {(config?.upstreams || []).map((upstream) => (
                    <option key={upstream.name} value={upstream.name}>{upstream.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                <span className="field-label">{t("routing.template.newUpstreamName", "New Upstream Name")}</span>
                <input value={templateNewUpstreamName} onChange={(event) => setTemplateNewUpstreamName(event.target.value)} />
              </label>
            )}
          </div>

          <label className="inline">
            <input type="checkbox" checked={templateImportPricing} onChange={(event) => setTemplateImportPricing(event.target.checked)} />
            <span>{t("routing.template.importPricing", "Import pricing catalog entry together")}</span>
          </label>
        </div>
      </Modal>

      <div className="tabs-header">
        {categories.map((cat) => (
          <TabButton 
            key={cat.id} 
            active={currentCategory.id === cat.id} 
            onClick={() => setActiveTab(cat.tabs[0].id)}
          >
            {cat.label}
          </TabButton>
        ))}
      </div>

      <div className="layout-main-split">
        <aside className="left-nav">
          <div className="left-nav-group">
            <div className="left-nav-title">{currentCategory.label}</div>
            {currentCategory.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`nav-item ${activeTab === tab.id ? "active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {currentSectionLinks.length ? (
            <div className="left-nav-group left-nav-subgroup">
              <div className="left-nav-title left-nav-title-sub">{t("nav.details", "小类导航")}</div>
              {currentSectionLinks.map((link) => (
                <a
                  key={link.id}
                  className={activeSectionId === link.id ? "sub-nav-link active" : "sub-nav-link"}
                  href={`#${link.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    handleSectionNavClick(link.id);
                  }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </aside>

        <main className="tab-content">

      {activeTab === "workspace" && config ? (
        <WorkspaceTab
          config={config}
          updateField={updateField}
          pricingCatalogText={pricingCatalogText}
          updatePricingCatalog={updatePricingCatalog}
          pricingCatalogError={pricingCatalogError}
          databaseConfigForm={databaseConfigForm}
          setDatabaseConfigForm={setDatabaseConfigForm}
          databaseTestResult={databaseTestResult}
          diagnosticsBusy={diagnosticsBusy}
          onReloadDatabaseDefaults={handleReloadDatabaseDefaults}
          onTestDatabaseConnection={handleTestDatabaseConnection}
          formatDateTime={formatDateTime}
          t={t}
        />
      ) : null}

      {activeTab === "keys" && config ? (
        <KeysTab
          config={config}
          updateConfig={updateConfig}
          addApiKey={addApiKey}
          t={t}
        />
      ) : null}

      {activeTab === "routing" && config ? (
        <RoutingTab
          config={config}
          pricingLibrary={pricingLibrary}
          updateConfig={updateConfig}
          addUpstream={addUpstream}
          addModel={addModel}
          addBlankModel={addBlankModel}
          t={t}
        />
      ) : null}

      {activeTab === "runtime" ? (
        <RuntimeTab
          persistenceRuntime={persistenceRuntime}
          loggingRuntime={loggingRuntime}
                runtimeStore={runtimeStore}
          persistenceRuntimeText={persistenceRuntimeText}
          loggingRuntimeText={loggingRuntimeText}
          governanceKeys={governanceKeys}
          perKeyStats={perKeyStats}
          modelStats={modelStats}
          analytics={stats?.analytics || {}}
          recentSignals={stats?.recent || {}}
          runtimeFilters={runtimeFilters}
          runtimeKeyOptions={runtimeKeyOptions}
          onRuntimeFilterChange={handleRuntimeFilterChange}
                onSyncRuntime={handleRuntimeSync}
                runtimeSyncBusy={diagnosticsBusy.runtimeSync === true}
          formatDateTime={formatDateTime}
          t={t}
        />
      ) : null}

      {activeTab === "ops" && config ? (
        <OpsTab
          config={config}
          updateField={updateField}
          pricingLibraryStatus={pricingLibraryStatus}
          pricingSyncSource={pricingSyncSource}
          setPricingSyncSource={setPricingSyncSource}
          pricingLibraryCount={pricingLibrary.length}
          caddyStatus={caddyStatus}
          aadStatus={aadStatus}
          diagnosticsBusy={diagnosticsBusy}
          handleSyncPricingLibrary={handleSyncPricingLibrary}
          loadCaddyStatusAction={loadCaddyStatusAction}
          handleVerifyAad={handleVerifyAad}
          handleRestartService={handleRestartService}
          caddyPreview={caddyPreview}
          formatDateTime={formatDateTime}
          logs={logs}
          logFilters={logFilters}
          setLogFilters={setLogFilters}
          toggleLogLevel={toggleLogLevel}
          loadLogsAction={loadLogsAction}
          logsLoading={logsLoading}
          getLogDetails={getLogDetails}
          getLogMessage={getLogMessage}
          getLogEventLabel={(eventName) => getLocalizedLogEventLabel(eventName, t)}
          getLogSourceLabel={(source) => getLocalizedLogSourceLabel(source, t)}
          onApplyRequestIdFilter={handleApplyRequestIdFilter}
          onCopyLogSummary={handleCopyLogSummary}
          testEndpoint={testEndpoint}
          setTestEndpoint={setTestEndpoint}
          testApiKey={testApiKey}
          setTestApiKey={setTestApiKey}
          testPayloadText={testPayloadText}
          setTestPayloadText={setTestPayloadText}
          handleSendTestRequest={handleSendTestRequest}
          resetTestPayload={resetTestPayload}
          testResponseText={testResponseText}
          compressionEnabled={compressionEnabled}
          setCompressionEnabled={setCompressionEnabled}
          compressionPreset={compressionPreset}
          setCompressionPreset={setCompressionPreset}
          imageFileInfo={imageFileInfo}
          payloadNote={payloadNote}
          compressionStats={compressionStats}
          onImageFileChange={handleImageFileChange}
          onInsertDataUrlPlaceholder={() => handleInsertImagePlaceholder("dataUrl")}
          onInsertBase64Placeholder={() => handleInsertImagePlaceholder("base64")}
          onApplyCompressionConfig={handleApplyCompressionConfig}
          testEndpoints={TEST_ENDPOINTS}
          getValueByPath={getValueByPath}
          t={t}
        />
      ) : null}

      {activeTab === "advanced" ? (
        <AdvancedTab
          advancedJsonEnabled={advancedJsonEnabled}
          advancedJson={advancedJson}
          updateAdvancedJson={updateAdvancedJson}
          jsonError={jsonError}
          dirty={dirty}
          configIssues={configIssues}
          configDiffCount={configDiffCount}
          configDiffPreview={configDiffPreview}
          t={t}
        />
      ) : null}
            </main>
      </div>
    </div>
  );
}
