import { lazy, startTransition, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import AppShell from "./app/AppShell.jsx";
import { resolvePage, settingsSections } from "./app/routes.js";
import { ConfigDraftProvider, useConfigDraft, useConfigActions } from "./lib/config-draft.jsx";
import { useUrlFilters } from "./lib/url-filters.js";
import { SettingsFieldsProvider } from "./lib/settings-fields.jsx";
import {
  fetchCaddyStatus,
  getAdminBasePath,
  fetchApiKeySecret,
  fetchConfig,
  fetchDatabaseConfig,
  fetchHarnessEligibility,
  fetchLogs,
  fetchPricingLibrary,
  fetchRuntime,
  fetchStats,
  initializeLogAnalytics,
  reloadConfig,
  resetModelStats,
  restartService,
  sendProxyRequest,
  syncRuntime,
  syncPricingLibrary,
  testDatabaseConnection,
  validateConfiguredModels,
  verifyAad
} from "./api.js";
import { StatCard, Modal, PageSections } from "./components/ui.jsx";
import { useI18n } from "./i18n.jsx";
import { createRuntimeLoader } from "./runtime-loader.js";
import toast from "react-hot-toast";
import {
  applyCompressionPresetToConfig,
  applyModelCardTierPricing,
  buildLogSummaryText,
  buildConfigDiffPreview,
  buildImagePlaceholderPayload,
  buildModelFromPricingTemplate,
  buildSuggestedUpstreamName,
  buildUpstreamFromPricingTemplate,
  computeConfigDiff,
  DEFAULT_LOG_FILTERS,
  DEFAULT_MODEL_TEMPLATE,
  TEST_ENDPOINTS,
  buildCaddyPreview,
  buildDefaultTestPayload,
  cloneJson,
  describeLoggingRuntime,
  describePersistenceRuntime,
  ensureUniqueName,
  formatDateTime,
  formatBytes,
  formatEstimatedCost,
  formatRuntimeNumber,
  getSuggestedModelRouteValues,
  getPayloadEditorNote,
  getLogDetails,
  getLocalizedLogEventLabel,
  getLogMessage,
  getLocalizedLogSourceLabel,
  getValueByPath,
  inspectConfigStructure,
  pickCompressionPreset,
  prepareProxyPayload,
  REDACTED_SECRET_VALUE,
  runtimeTokenHelp,
  supportsPricingTemplate,
  setValueByPath,
  upsertPricingCatalogEntry
} from "./utils.js";

const AdvancedTab = lazy(() => import("./components/AdvancedTab.jsx"));
const HarnessTab = lazy(() => import("./components/HarnessTab.jsx"));
const KeysTab = lazy(() => import("./components/KeysTab.jsx"));
const OpsTab = lazy(() => import("./components/OpsTab.jsx"));
const RoutingTab = lazy(() => import("./features/channels/RoutingPage.jsx"));
const RuntimeTab = lazy(() => import("./components/RuntimeTab.jsx"));
const WorkspaceTab = lazy(() => import("./components/WorkspaceTab.jsx"));
const ConfigHistoryModal = lazy(() => import("./components/ConfigHistoryModal.jsx"));
const LogExplorer = lazy(() => import("./features/logs/LogExplorer.jsx"));
const UsageChart = lazy(() => import("./features/overview/UsageChart.jsx"));
const ReviewChanges = lazy(() => import("./components/ReviewChanges.jsx"));
const OverviewLists = lazy(() => import("./features/overview/OverviewLists.jsx"));
let bundledPricingLibraryPromise = null;

function loadBundledPricingLibrary() {
  if (!bundledPricingLibraryPromise) {
    bundledPricingLibraryPromise = import("./pricing-library.js")
      .then((moduleValue) => moduleValue.bundledPricingLibrary);
  }
  return bundledPricingLibraryPromise;
}

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

function bindingLabel(config, model) {
  if (!model) return "—";
  const ref = model.selectedBinding;
  if (!ref) return `${model.upstream} / ${model.targetModel || model.id}`;
  const name = config.upstreams?.find(up => up.channelId === ref.channelId)?.name || ref.channelId;
  return `${name} [${ref.channelId}] / ${ref.sourceModelId}`;
}

export default function App() {
  return <BrowserRouter basename={getAdminBasePath()}><ConfigDraftProvider>
    <Routes><Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/config/json" element={<Navigate to="/settings/json" replace />} />
      <Route path="*" element={<AdminConsole />} /></Routes>
  </ConfigDraftProvider></BrowserRouter>;
}

function AdminConsole() {
  const { t } = useI18n();
  const { config, setConfig, lastLoadedText, setLastLoadedText, loadedConfig, updateConfig, updateField, entityDrafts, setEntityDrafts } = useConfigDraft();
  const location = useLocation();
  const navigate = useNavigate();
  const page = resolvePage(location.pathname);
  const subsection = location.pathname.split("/")[2];
  const activeTab = page?.id === "settings" && subsection === "gateway" ? "ops"
    : page?.id === "settings" && subsection === "json" ? "advanced" : page?.legacy;
  const sections = page?.id === "settings" ? [settingsSections[subsection] || settingsSections.service] : page?.sections;
  const [runtime, setRuntime] = useState(null);
  const [stats, setStats] = useState(null);
  const [statsUpdatedAt, setStatsUpdatedAt] = useState(null);
  const [pricingLibrary, setPricingLibrary] = useState([]);
  const [pricingLibraryStatus, setPricingLibraryStatus] = useState(null);
  const [modelValidationResult, setModelValidationResult] = useState(null);
  const [harnessEligibility, setHarnessEligibility] = useState(null);
  const [harnessEligibilityLoading, setHarnessEligibilityLoading] = useState(false);
  const [harnessEligibilityError, setHarnessEligibilityError] = useState("");
  const [harnessEligibilityRevision, setHarnessEligibilityRevision] = useState(0);
  const [pricingSyncSource, setPricingSyncSource] = useState({ owner: "", repo: "", path: "pricing", ref: "" });
  const [databaseConfigForm, setDatabaseConfigForm] = useState(() => normalizeDatabaseConfigForm());
  const [databaseTestResult, setDatabaseTestResult] = useState(null);
  const [logAnalyticsInitializationResult, setLogAnalyticsInitializationResult] = useState(null);
  const [logs, setLogs] = useState({ view: DEFAULT_LOG_FILTERS.view, total: 0, retainedEvents: 0, limit: 100, items: [] });
  const [caddyStatus, setCaddyStatus] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [showConfigHistory, setShowConfigHistory] = useState(false);

  const [advancedJson, setAdvancedJson] = useState("{}");
  const [pendingConfigJson, setPendingConfigJson] = useState(false);
  const [pricingCatalogText, setPricingCatalogText] = useState("{}");
  const [pricingCatalogError, setPricingCatalogError] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [mappingDrafts, setMappingDrafts] = useState({});
  const [routingGeneration, setRoutingGeneration] = useState(0);
  const copilotOperations = useRef(new Map());
  const pendingMappingJson = config?.upstreams?.some(up => up.channelId && Object.hasOwn(mappingDrafts, up.channelId));
  const [loading, setLoading] = useState(true);

  const [logsLoading, setLogsLoading] = useState(false);
  const [logFilters, setLogFilters] = useUrlFilters(DEFAULT_LOG_FILTERS, page?.id === "logs", { keyword: "q", modelId: "model", keyId: "key" });
  const [settingsFilters, setSettingsFilters] = useUrlFilters({ search: "", modifiedOnly: false }, page?.id === "settings", { search: "q", modifiedOnly: "modified" });
  const [aadStatus, setAadStatus] = useState(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState({ verify: false, restart: false, test: false, pricingSync: false, databaseTest: false, databaseDefaults: false, logAnalyticsInitialize: false, runtimeSync: false, modelValidation: false });
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

  const [showModelTemplateModal, setShowModelTemplateModal] = useState(false);
  const [runtimeFilters, setRuntimeFilters] = useUrlFilters(DEFAULT_RUNTIME_FILTERS, page?.id === "usage", { keyId: "key", timeRange: "range" });
  const [usageView, setUsageView] = useUrlFilters({ group: "public", tab: "models" }, page?.id === "usage");
  const usageTab = ["models", "keys", "analytics", "signals"].includes(usageView.tab) ? usageView.tab : "models";
  const [runtimeLoader] = useState(() => createRuntimeLoader({ fetchRuntime, fetchStats, initialFilters: runtimeFilters }));
  const runtimeQueryRef = useRef(JSON.stringify(runtimeFilters));
  const [modelTemplateSearch, setModelTemplateSearch] = useState("");
  const [selectedPricingTemplateId, setSelectedPricingTemplateId] = useState("");
  const [templateUpstreamMode, setTemplateUpstreamMode] = useState("existing");
  const [selectedTemplateUpstreamName, setSelectedTemplateUpstreamName] = useState("");
  const [templateNewUpstreamName, setTemplateNewUpstreamName] = useState("");
  const [templateRouteOverride, setTemplateRouteOverride] = useState("");
  const [templateImportPricing, setTemplateImportPricing] = useState(true);
  const loadRequestRef = useRef(0);

  const logsRequestRef = useRef(0);
  const harnessEligibilityRequestRef = useRef(0);
  const harnessEligibilityContextRef = useRef(null);
  const modelStatsResetRef = useRef(null);

  const dirty = useMemo(() => pendingConfigJson || !!pendingMappingJson || JSON.stringify(config ?? {}, null, 2) !== lastLoadedText, [config, lastLoadedText, pendingMappingJson, pendingConfigJson]);
  const hasEntityDrafts = Object.keys(entityDrafts).length > 0;
  const {
    configConflict, lastApplication, applyingStage, saving, setSaving, showSaveModal, setShowSaveModal,
    confirmConfigIssues, persistConfig, reportApplication, closeConfigConflict, retryApplication,
    restoreHistoricalConfig, showConfigConflict, reportConfigSaveError, handleSave, proceedSave, handleDiscardChanges, handleReload
  } = useConfigActions({
    t, dirty, pendingMappingJson, pendingConfigJson, pricingCatalogError, jsonError, setError, setMessage,
    loadRequestRef, applyLoadedConfig, loadSecondaryData, loadAll, loadCaddyStatusAction,
    closeHistory: success => { setShowConfigHistory(false); if (success && page?.id === "config") navigate("/config/sync"); }
  });
  const harnessEligibilityFresh = !harnessEligibilityLoading && !harnessEligibilityError
    && harnessEligibilityContextRef.current?.config === config
    && harnessEligibilityContextRef.current?.pricingLibrary === pricingLibrary
    && harnessEligibilityContextRef.current?.tab === activeTab
    && harnessEligibilityContextRef.current?.revision === harnessEligibilityRevision;
  const capabilityFallbackModels = harnessEligibilityContextRef.current?.pricingLibrary === pricingLibrary
    ? (harnessEligibility?.capabilities?.preview?.models || []).filter(model => {
      if (model.source === "catalog") return false;
      const before = harnessEligibilityContextRef.current.config.models?.find(item => item.id === model.modelId);
      const current = config?.models?.find(item => item.id === model.modelId);
      return before && current && ["pricingRef", "targetModel"].every(field => before[field] === current[field]);
    }).map(model => model.modelId)
    : [];
  const advancedJsonEnabled = getValueByPath(config, "admin.features.enableLegacyJsonEditor") !== false;
  const governanceKeys = stats?.governance?.keys || [];
  const modelStats = stats?.perModel || {};
  const perKeyStats = stats?.perKey || {};
  const overviewAwaitingGlobal = page?.id === "overview" && Boolean(stats?.filters?.keyId || (stats?.filters?.timeRange && stats.filters.timeRange !== "all"));
  const persistenceRuntime = runtime?.persistence || {};
  const loggingRuntime = runtime?.logging || {};
  const runtimeStore = runtime?.runtimeStore || {};
  const distributionCapabilities = runtime?.distribution?.capabilities || {};
  const configCleanupRequired = runtime?.configuration?.cleanupRequired === true;
  const application = lastApplication || runtime?.configuration?.application || {};
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
  const selectedTemplateRouteOptions = useMemo(
    () => getSuggestedModelRouteValues(selectedPricingTemplate),
    [selectedPricingTemplate]
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
      if (dirty || hasEntityDrafts) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty, hasEntityDrafts]);

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
    const requestId = ++logsRequestRef.current;
    setLogsLoading(true);
    try {
      const json = await fetchLogs({
        view: filters.view,
        outcome: filters.outcome,
        level: filters.level,
        event: filters.event,
        excludeEvent: filters.hideAuthRejected ? "http.auth_rejected" : "",
        modelId: filters.modelId,
        keyId: filters.keyId,
        requestId: filters.requestId,
        keyword: filters.view === "operations" ? "" : filters.keyword,
        connectionId: filters.connectionId,
        ...(filters.view === "operations" ? {
          recordSource: filters.recordSource, operationId: filters.operationId, configRevision: filters.configRevision
        } : {}),
        limit: filters.limit
      });
      if (requestId !== logsRequestRef.current) return;
      startTransition(() => {
        setLogs({
          keyId: filters.keyId || "",
          recordSource: json.recordSource,
          persistence: json.persistence,
          capturedAt: json.capturedAt,
          retainedSince: json.retainedSince,
          droppedEvents: json.droppedEvents,
          hasMore: json.hasMore,
          total: json.total || 0,
          limit: json.limit || filters.limit,
          view: json.view || filters.view,
          retainedEvents: json.retainedEvents || 0,
          items: Array.isArray(json.items) ? json.items : []
        });
      });
    } catch (loadError) {
      if (requestId !== logsRequestRef.current) return;
      setError(loadError.message || t("messages.logsLoadFailed", "Failed to load logs."));
    } finally {
      if (requestId === logsRequestRef.current) {
        setLogsLoading(false);
      }
    }
  }

  async function refreshRuntimeAndStats() {
    const request = runtimeLoader.start();
    try {
      const [runtimeJson, statsJson] = await Promise.all([request.runtime, request.stats]);
      if (!request.isCurrent()) return;
      startTransition(() => {
        setRuntime(runtimeJson.runtime || null);
        setStats(statsJson || null);
        setStatsUpdatedAt(new Date().toISOString());
      });
    } catch (loadError) {
      if (request.isCurrent()) throw loadError;
    }
  }

  function applyLoadedConfig(configJson) {
    const text = JSON.stringify(configJson, null, 2);
    setConfig(configJson);
    setAdvancedJson(text);
    setPendingConfigJson(false);
    setLastLoadedText(text);
    setPricingCatalogText(JSON.stringify(configJson?.access?.pricingCatalog || {}, null, 2));
    setPricingCatalogError("");
    setJsonError("");
    setMappingDrafts({});
    setEntityDrafts({});
    setRoutingGeneration(value => value + 1);
    copilotOperations.current.clear();
    setDatabaseTestResult(null);
    setLogAnalyticsInitializationResult(null);
    closeConfigConflict();
  }

  async function loadSecondaryData(requestId, options = {}) {
    const { notifyOnError = false } = options;
    const loadPricing = async () => {
      try {
        const pricingJson = await fetchPricingLibrary();
        if (Array.isArray(pricingJson.items) && pricingJson.items.length) return pricingJson;
        return { ...pricingJson, items: await loadBundledPricingLibrary() };
      } catch {
        return { items: await loadBundledPricingLibrary() };
      }
    };
    const runtimeRequest = runtimeLoader.start();
    const [runtimeResult, statsResult, caddyResult, pricingResult] = await Promise.allSettled([
      runtimeRequest.runtime,
      runtimeRequest.stats,
      fetchCaddyStatus(),
      loadPricing()
    ]);

    if (requestId !== loadRequestRef.current) {
      return;
    }

    const errors = [];
    startTransition(() => {
      if (runtimeRequest.isCurrent()) {
        if (runtimeResult.status === "fulfilled") {
          setRuntime(runtimeResult.value.runtime || null);
        } else {
          errors.push(runtimeResult.reason);
        }
        if (statsResult.status === "fulfilled") {
          setStats(statsResult.value || null);
          setStatsUpdatedAt(new Date().toISOString());
        } else {
          errors.push(statsResult.reason);
        }
      }

      if (caddyResult.status === "fulfilled") {
        setCaddyStatus(caddyResult.value.status || null);
      } else {
        errors.push(caddyResult.reason);
      }

      if (pricingResult.status === "fulfilled") {
        const pricingJson = pricingResult.value || {};
        const pricingItems = Array.isArray(pricingJson.items) && pricingJson.items.length
          ? pricingJson.items
          : [];
        setPricingLibrary(pricingItems);
        setPricingLibraryStatus(pricingJson.status || null);
        setPricingSyncSource(pricingSyncSourceFromStatus(pricingJson.status || null));
      } else {
        errors.push(pricingResult.reason);
      }
    });

    if (notifyOnError && errors.length) {
      const firstError = errors.find(Boolean);
      setError(firstError?.message || t("messages.loadFailed", "Load failed."));
    }
  }

  async function loadAll(mode = "load", { discardPendingDatabaseSync = false, expectedRevision } = {}) {
    setLoading(true);
    setError("");
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    try {
      const result = mode === "reload"
        ? await reloadConfig({ discardPendingDatabaseSync, expectedRevision })
        : { config: await fetchConfig() };
      if (requestId !== loadRequestRef.current) {
        return;
      }
      applyLoadedConfig(result.config);
      reportApplication(result.apply, mode === "reload" ? t("messages.reloaded", "Configuration reloaded from persistent store.") : t("messages.loaded", "Configuration loaded."));
      void loadSecondaryData(requestId, { notifyOnError: mode === "reload" });
    } catch (loadError) {
      if (requestId !== loadRequestRef.current) {
        return;
      }
      setError(loadError.message || t("messages.loadFailed", "Load failed."));
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
      }
    }
  }

  async function handleRuntimeFilterChange(patch) {
    const nextFilters = runtimeLoader.updateFilters(patch);
    runtimeQueryRef.current = JSON.stringify(nextFilters);
    setRuntimeFilters(nextFilters);
    try {
      await refreshRuntimeAndStats();
    } catch (loadError) {
      setError(loadError.message || t("messages.loadFailed", "Load failed."));
    }

  }

  useEffect(() => {
    const effectiveFilters = page?.id === "usage" ? runtimeFilters : DEFAULT_RUNTIME_FILTERS;
    const query = JSON.stringify(effectiveFilters);
    if (runtimeQueryRef.current === query) return;
    runtimeQueryRef.current = query;
    runtimeLoader.updateFilters(effectiveFilters);
    void refreshRuntimeAndStats().catch(error => setError(error.message));
  }, [page?.id, runtimeFilters.keyId, runtimeFilters.timeRange]);

  async function handleRuntimeSync() {
    setDiagnosticsBusy((current) => ({ ...current, runtimeSync: true }));
    try {
      const result = await syncRuntime();
      startTransition(() => {
        setRuntime(result.runtime || null);
      });
      await refreshRuntimeAndStats();
      setMessage(t("messages.runtimeSyncSuccess", "Runtime sync completed."));
    } catch (syncError) {
      setError(syncError.message || t("messages.runtimeSyncFailed", "Runtime sync failed."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, runtimeSync: false }));
    }
  }

  async function handleResetModelStats() {
    if (modelStatsResetRef.current) return modelStatsResetRef.current;
    setDiagnosticsBusy((current) => ({ ...current, modelStatsReset: true }));
    const pending = (async () => {
      const result = await resetModelStats();
      // Fence any pre-reset loads, including a slow initial load or filter change.
      runtimeLoader.updateFilters({});
      setStats((current) => current ? { ...current, perModel: {}, modelsResetAt: result.modelsResetAt } : current);
      try {
        await refreshRuntimeAndStats();
      } catch (loadError) {
        throw new Error(t("runtime.modelsResetRefreshFailed", "Model statistics were reset, but refreshing failed. Reload the view before continuing.") + ` ${loadError.message || ""}`);
      }
    })().finally(() => {
      modelStatsResetRef.current = null;
      setDiagnosticsBusy((current) => ({ ...current, modelStatsReset: false }));
    });
    modelStatsResetRef.current = pending;
    return pending;
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
    if (!config || pendingConfigJson) return;
    setAdvancedJson(JSON.stringify(config, null, 2));
  }, [config, pendingConfigJson]);

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
    if (page?.id !== "logs") return undefined;
    const timer = setTimeout(() => {
      void loadLogsAction(logFilters);
    }, 180);
    return () => clearTimeout(timer);
  }, [page?.id, logFilters.keyId, logFilters.view, logFilters.outcome, logLevelKey, logFilters.event, logFilters.modelId, logFilters.requestId, logFilters.keyword, logFilters.limit, logFilters.hideAuthRejected, logFilters.recordSource, logFilters.connectionId, logFilters.operationId, logFilters.configRevision]);

  useEffect(() => {
    if (page?.id !== "logs" || !logFilters.autoRefresh) return undefined;
    const interval = setInterval(() => {
      void loadLogsAction(logFilters);
    }, 5000);
    return () => clearInterval(interval);
  }, [page?.id, logFilters.keyId, logFilters.autoRefresh, logFilters.view, logFilters.outcome, logLevelKey, logFilters.event, logFilters.modelId, logFilters.requestId, logFilters.keyword, logFilters.limit, logFilters.hideAuthRejected, logFilters.recordSource, logFilters.connectionId, logFilters.operationId, logFilters.configRevision]);

  useEffect(() => {
    if (!["harness", "routing"].includes(activeTab) || !config) return undefined;
    const requestId = harnessEligibilityRequestRef.current + 1;
    harnessEligibilityRequestRef.current = requestId;
    let cancelled = false;
    const controller = new AbortController();
    setHarnessEligibilityLoading(true);
    setHarnessEligibilityError("");
    const timer = setTimeout(async () => {
      try {
        const result = await fetchHarnessEligibility(config, { signal: controller.signal });
        if (!cancelled && requestId === harnessEligibilityRequestRef.current) {
          harnessEligibilityContextRef.current = { config, pricingLibrary, tab: activeTab, revision: harnessEligibilityRevision };
          setHarnessEligibility(result);
        }
      } catch (requestError) {
        if (!cancelled && requestId === harnessEligibilityRequestRef.current) {
          setHarnessEligibilityError(requestError.message || t("harness.loadFailed", "Failed to check model eligibility."));
        }
      } finally {
        if (!cancelled && requestId === harnessEligibilityRequestRef.current) {
          setHarnessEligibilityLoading(false);
        }
      }
    }, 180);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeTab, config, pricingLibrary, t, harnessEligibilityRevision]);

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
    setPendingConfigJson(true);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("advanced.objectRequired"));
      setJsonError("");
    } catch (parseError) {
      setJsonError(parseError.message || t("messages.advancedJsonInvalid", "Invalid JSON."));
    }
  }

  async function saveAdvancedJson() {
    setSaving(true);
    setError("");
    try {
      const parsed = JSON.parse(advancedJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("advanced.objectRequired"));
      await persistConfig(parsed, t("messages.saved"), true);
    } catch (saveError) {
      await reportConfigSaveError(saveError, t("messages.saveFailed"));
    } finally {
      setSaving(false);
    }
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

  async function handleInitializeLogAnalytics() {
    const settings = config?.observability?.logAnalytics || {};
    setDiagnosticsBusy((current) => ({ ...current, logAnalyticsInitialize: true }));
    setError("");
    try {
      const result = await initializeLogAnalytics({
        workspaceResourceId: settings.workspaceResourceId,
        dataCollectionEndpointResourceId: settings.dataCollectionEndpointResourceId,
        dataCollectionRuleName: settings.dataCollectionRuleName,
        tableName: settings.tableName,
        streamName: settings.streamName,
        audience: settings.audience,
        credentialRef: settings.credentialRef
      });
      startTransition(() => {
        setLogAnalyticsInitializationResult(result);
        if (result.suggestedConfig) {
          updateConfig((next) => {
            next.observability ||= {};
            next.observability.logAnalytics = {
              ...(next.observability.logAnalytics || {}),
              ...result.suggestedConfig
            };
          });
        }
      });
      if (result.ok) {
        setMessage(t("messages.logAnalyticsInitializeSuccess", "Log Analytics resources initialized and the probe was uploaded. Save the configuration to enable the sink."));
      } else {
        setError(result.error?.message || t("messages.logAnalyticsInitializeFailed", "Log Analytics initialization needs attention."));
      }
    } catch (initializationError) {
      const result = initializationError.payload || {
        ok: false,
        status: "failed",
        phases: [],
        error: { message: initializationError.message }
      };
      startTransition(() => setLogAnalyticsInitializationResult(result));
      setError(result.error?.message || initializationError.message || t("messages.logAnalyticsInitializeFailed", "Log Analytics initialization failed."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, logAnalyticsInitialize: false }));
    }
  }

  function openNewModelDraft(next) {
    const index = next.models.length - 1;
    const id = next.models[index].id;
    const cacheKey = `models:${id}`;
    if (entityDrafts[cacheKey] && !window.confirm(t("ui.cancelDraft"))) return false;
    setEntityDrafts(previous => ({ ...previous, [cacheKey]: { base: config, value: next, index } }));
    navigate(`/models?edit=${encodeURIComponent(id)}&tab=basic`);
    return true;
  }

  function addBlankModel() {
    const next = cloneJson(config);
    next.models ||= [];
    next.models.push({
      ...cloneJson(DEFAULT_MODEL_TEMPLATE),
      id: ensureUniqueName("model", next.models.map(model => model.id)),
      upstream: next.upstreams?.find(up => !up.channelId)?.name || ""
    });
    openNewModelDraft(next);
  }

  function addModel() {
    if (!supportedPricingTemplates.length) {
      addBlankModel();
      return;
    }

    const defaultTemplate = supportedPricingTemplates[0];
    setModelTemplateSearch("");
    setSelectedPricingTemplateId(defaultTemplate.id);
    const firstLegacyUpstream = config?.upstreams?.find(up => !up.channelId);
    setTemplateUpstreamMode(firstLegacyUpstream ? "existing" : "new");
    setSelectedTemplateUpstreamName(firstLegacyUpstream?.name || "");
    setTemplateNewUpstreamName(buildSuggestedUpstreamName(defaultTemplate, config));
    setTemplateRouteOverride("");
    setTemplateImportPricing(true);
    setShowModelTemplateModal(true);
  }

  function applyPricingTemplateSelection() {
    if (!selectedPricingTemplate) return;

    const next = cloneJson(config);
    {
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
      if (templateRouteOverride) {
        modelEntry.routes = {
          ...(modelEntry.routes && typeof modelEntry.routes === "object" ? modelEntry.routes : {}),
          "*": templateRouteOverride
        };
      }
      next.models.push(modelEntry);

      if (templateImportPricing) upsertPricingCatalogEntry(next, selectedPricingTemplate);

      const upstream = next.upstreams.find((item) => item?.name === upstreamName);
      if (upstream && (!Array.isArray(upstream.capabilities) || upstream.capabilities.length === 0)) {
        upstream.capabilities = [...modelEntry.capabilities];
      }
    }
    if (openNewModelDraft(next)) setShowModelTemplateModal(false);
  }

  function toggleLogLevel(level) {
    setLogFilters((current) => {
      const exists = current.level.includes(level);
      if (exists && current.level.length === 1) return current;
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
    const nextFilters = logFilters.view === "operations"
      ? { ...logFilters, view: "requests", outcome: "all", event: "", modelId: "", connectionId: "", keyword: "", requestId }
      : { ...logFilters, requestId };
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

  async function handleCopyApiKey(item) {
    let secret = "";
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t("messages.clipboardUnavailable", "Clipboard access is unavailable in this browser."));
      }

      secret = typeof item?.key === "string" ? item.key : "";
      if (secret === REDACTED_SECRET_VALUE) {
        const keyId = typeof item?.id === "string" ? item.id.trim() : "";
        if (!keyId) {
          throw new Error(t("keys.copyMissingId", "Save a key ID before copying a stored key."));
        }
        const result = await fetchApiKeySecret(keyId);
        secret = typeof result?.key === "string" ? result.key : "";
      }
      if (!secret || secret === REDACTED_SECRET_VALUE) {
        throw new Error(t("keys.copyEmpty", "This key has no value to copy."));
      }

      await navigator.clipboard.writeText(secret);
      setError("");
      setMessage(t("keys.copySuccess", "API key copied to clipboard."));
    } catch (copyError) {
      setError(copyError.message || t("keys.copyFailed", "Failed to copy API key."));
    } finally {
      secret = "";
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
    if (!window.confirm(t("ops.restartConfirm", "Restart the proxy service now? Active requests may be interrupted."))) {
      return;
    }
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
      const syncedPricingItems = Array.isArray(result.items) && result.items.length
        ? result.items
        : await loadBundledPricingLibrary();
      startTransition(() => {
        setPricingLibrary(syncedPricingItems);
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

  async function handleValidateConfiguredModels() {
    setDiagnosticsBusy((current) => ({ ...current, modelValidation: true }));
    setError("");
    try {
      const result = await validateConfiguredModels({ probe: true });
      startTransition(() => {
        setModelValidationResult(result);
      });
      const summary = result?.summary || {};
      if ((summary.failed || 0) > 0) {
        setError(t("messages.modelValidationFailed", "Configured model validation found failures."));
      } else if ((summary.warning || 0) > 0) {
        setMessage(t("messages.modelValidationWarning", "Configured model validation completed with warnings."));
      } else {
        setMessage(t("messages.modelValidationSuccess", "Configured model validation succeeded."));
      }
    } catch (validationError) {
      setError(validationError.message || t("messages.modelValidationRequestFailed", "Configured model validation failed to run."));
    } finally {
      setDiagnosticsBusy((current) => ({ ...current, modelValidation: false }));
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
      await reportConfigSaveError(saveError, t("compress.apply.invalid", "Failed to apply compression preset."), nextConfig);
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
    const totals = overviewAwaitingGlobal ? {} : stats?.totals || {};
    return {
      requests: totals.requests,
      errors: totals.errors,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      errorRate: Number.isFinite(totals.errors) && Number.isFinite(totals.requests)
        ? totals.requests > 0 ? `${(totals.errors / totals.requests * 100).toFixed(1)}%` : totals.errors === 0 ? "0%" : t("ui.unknown")
        : t("ui.unknown"),
      cost: totals.estimatedCostAmount == null ? t("ui.unknown") : formatEstimatedCost(totals, t),
      persistence: runtime?.persistence?.activeMode || runtime?.persistence?.mode || "file",
      logging: statusLabel(
        runtime?.logging?.memoryEnabled || runtime?.logging?.consoleEnabled || runtime?.logging?.logAnalyticsConfigured,
        runtime?.logging?.logAnalyticsEnabled ?? runtime?.logging?.enabled
      ),
      caddy: caddyStatus?.state || (config?.server?.caddy?.enabled ? "unknown" : "disabled")
    };
  }, [runtime, stats, caddyStatus, config?.server?.caddy?.enabled, overviewAwaitingGlobal, t]);

  function handleHarnessNavigate({ type, id }) {
    if (type === "route" || type === "diagnostics") {
      navigate(type === "route" ? "/settings/routing" : "/diagnostics");
      return;
    }
    if (type === "advanced") {
      navigate("/settings/json");
      return;
    }
    const collection = type === "upstream" ? config.upstreams || [] : config.models || [];
    const field = type === "upstream" ? "name" : "id";
    const matches = collection.map((item, index) => ({ item, index })).filter(({ item }) => item?.[field] === id);
    if (matches.length !== 1) {
      setError(t("harness.targetMissing", "The target is missing or ambiguous. Edit its identity in Upstream / Model."));
      navigate(type === "upstream" ? "/channels" : "/models");
      return;
    }
    const target = matches[0].item;
    navigate(`/${type === "upstream" ? "channels" : "models"}?edit=${encodeURIComponent(type === "upstream" ? target.channelId || target.name : target.id)}`);
  }

  if (loading && !config) {
    return <div className="app-shell"><div className="loading">{t("common.loadingAdmin", "Loading React admin...")}</div></div>;
  }

  return (
    <AppShell page={page} runtime={runtime} dirty={dirty || hasEntityDrafts} application={application} entityDrafts={entityDrafts}
      onRefresh={() => loadSecondaryData(loadRequestRef.current, { notifyOnError: true })}
      onReload={() => handleReload("reload")}
      changedGroups={new Set([
        ...(JSON.stringify(config?.apiKeys) !== JSON.stringify(loadedConfig.apiKeys) ? ["keys"] : []),
        ...(JSON.stringify(config?.upstreams) !== JSON.stringify(loadedConfig.upstreams) ? ["channels"] : []),
        ...(JSON.stringify(config?.models) !== JSON.stringify(loadedConfig.models) ? ["models", "clients"] : []),
        ...(configDiffCount ? ["config"] : [])
      ])}
      saveDock={dirty || hasEntityDrafts || configCleanupRequired ? (
        <aside className="save-dock" role="status" aria-live="polite">
          <div className="save-dock-copy">
            <strong>{dirty || hasEntityDrafts ? t("changes.unsaved", "Unsaved changes") : t("config.flagCleanupPending", "Configuration cleanup pending")}</strong>
            <span>{hasEntityDrafts ? t("ui.unapplied") : dirty ? t("changes.count", "{count} changed paths", { count: configDiffCount })
              : t("config.flagCleanupCount", "{count} deprecated configuration entries", { count: runtime?.configuration?.deprecatedFlags?.length || 0 })}</span>
          </div>
          <div className="toolbar save-dock-actions">
            {dirty || hasEntityDrafts ? <button type="button" className="ghost" onClick={handleDiscardChanges}>{t("changes.discard", "Discard")}</button> : null}
            <button type="button" onClick={handleSave} disabled={saving || !config}>
              {saving ? t("hero.saving", "Saving...") : t("changes.reviewSave", "Review & Save")}
            </button>
          </div>
        </aside>
      ) : null}>
      {page?.id === "overview" ? <section className="summary-grid status-strip" aria-label={t("summary.title", "System status") }>
        <StatCard label={t("summary.requests", "Requests")} value={formatRuntimeNumber(summary.requests)} note={`${t("summary.errors", "Errors")} ${formatRuntimeNumber(summary.errors)}`} />
        <StatCard label={t("ui.errorRate")} value={summary.errorRate} />
        <StatCard label={t("ui.inputTokens")} value={formatRuntimeNumber(summary.promptTokens)} />
        <StatCard label={t("ui.outputTokens")} value={formatRuntimeNumber(summary.completionTokens)} />
        <StatCard label={t("summary.cost", "Reference Cost")} value={summary.cost} note={t("runtime.costHint", "Cost estimates may be incomplete.")} />
        <StatCard label={t("summary.persistence", "Persistence")} value={t(`option.${summary.persistence}`, summary.persistence)} note={`${t("summary.logging", "Logging")} ${t(`status.${summary.logging}`, summary.logging)}`} />
        <StatCard label={t("summary.caddy", "Caddy")} value={t(`caddy.state.${summary.caddy}`, summary.caddy)} note={dirty ? t("summary.dirty", "Unsaved changes") : configCleanupRequired ? t("config.flagCleanupPending", "Configuration cleanup pending") : t("summary.synced", "Synced")} />
      </section> : null}

      {persistenceRuntime.pendingDatabaseSync ? (
        <aside className="inline-error" role="status">
          {t("config.conflict.pending", "Local configuration is awaiting database synchronization. A conflict requires review; it will not overwrite the database.")}
          {" "}<button type="button" className="ghost" onClick={showConfigConflict}>{t("config.conflict.compare", "Compare latest configuration")}</button>
        </aside>
      ) : null}

      {["proxy", "caddy"].filter(stage => application[stage]?.ok === false).map(stage => (
        <aside className="inline-error" role="status" key={stage}>
          {t("config.apply.failed", "{stage} settings are not fully applied.", { stage })}
          {stage === "proxy" && runtime?.configuration?.appliedRevision && <p>
            {t("channel.appliedRevision")} <code>{runtime.configuration.appliedRevision}</code>
          </p>}
          {" "}<button type="button" className="ghost" disabled={Boolean(applyingStage) || saving || loading} onClick={() => retryApplication(stage)}>
            {t(`config.apply.retry.${stage}`, `Retry ${stage}`)}
          </button>
        </aside>
      ))}

      {showConfigHistory || (page?.id === "config" && subsection === "history") ? <Suspense fallback={<p>{t("common.loadingAdmin", "Loading...")}</p>}>
        <ConfigHistoryModal isOpen embedded={page?.id === "config" && subsection === "history"} config={config} saving={saving} t={t}
          onClose={() => { setShowConfigHistory(false); navigate("/config/sync"); }} onRestore={restoreHistoricalConfig} />
      </Suspense> : null}

      <Modal
        title={t("config.save.title", "Confirm Configuration Save")}
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onConfirm={proceedSave}
        confirmLabel={t("btn.save", "Save")}
        cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")}
        disabled={saving}
      >
        <p>{t("config.save.desc", "You are about to hit Save. Please review the configuration changes below:")}</p>
        {showSaveModal ? <Suspense fallback={<p>{t("common.loading")}</p>}><ReviewChanges before={loadedConfig} after={config || {}} t={t} /></Suspense> : null}
        {showSaveModal && [...new Set([...(loadedConfig.models || []), ...(config.models || [])]
          .filter(model => model.selectedBinding).map(model => model.id))].map(id => {
          const before = bindingLabel(loadedConfig, loadedConfig.models?.find(model => model.id === id));
          const after = bindingLabel(config, config.models?.find(model => model.id === id));
          return before !== after && <p key={id}><strong>{id}</strong>: {before} → {after}</p>;
        })}
        {configCleanupRequired ? (
          <div className="config-deprecations">
            <p>{t("config.flagCleanupSave", "Saving will persist the normalized flags and remove the deprecated fields listed below. Existing disabled states are retained.")}</p>
            <ul>{(runtime?.configuration?.deprecatedFlags || []).map(warning => (
              <li key={warning.path}><code>{warning.path}</code>{warning.replacement ? <> → <code>{warning.replacement}</code></> : null}</li>
            ))}</ul>
          </div>
        ) : null}
        <div style={{ marginTop: '16px', marginBottom: '16px' }}>
          <strong>{t("config.diff.summary", "Changed paths:")} {configDiffCount}</strong>
        </div>
        {configDiffCount > 0 ? (
          <details><summary>{t("ui.rawDiff")}</summary><pre className="muted">
            {buildConfigDiffPreview(configDiff, t, Infinity)}
          </pre></details>
        ) : (
          configCleanupRequired ? null : <p className="muted">{t("config.diff.none", "No local diff")}</p>
        )}
      </Modal>

      <Modal
        title={t("config.conflict.title", "Configuration changed")}
        isOpen={Boolean(configConflict)}
        onClose={closeConfigConflict}
        onConfirm={() => handleReload("reload", { discardPendingDatabaseSync: true, expectedRevision: configConflict.activeRevision })}
        confirmLabel={t("config.conflict.reload", "Reload from store")}
        cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")}
        disabled={loading || configConflict?.loading || !configConflict?.latest || !configConflict?.activeRevision}
      >
        <p>{t("config.conflict.description", "Another administrator changed the configuration. Your draft is unchanged. Review the differences below or reload from the store and discard your draft.")}</p>
        {configConflict?.loading ? <p>{t("config.conflict.loading", "Loading the latest configuration...")}</p> : null}
        {configConflict?.error ? <div role="alert" className="inline-error">{configConflict.error}</div> : null}
        {configConflict?.latest ? (
          <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: "300px", overflowY: "auto" }}>
            {buildConfigDiffPreview(computeConfigDiff(configConflict.latest, config || {}), t, Infinity)}
          </pre>
        ) : null}
      </Modal>

      <Modal
        title={t("routing.template.title", "Select Model Template")}
        isOpen={showModelTemplateModal}
        onClose={() => setShowModelTemplateModal(false)}
        onConfirm={applyPricingTemplateSelection}
        confirmLabel={t("routing.template.confirm", "Create Model")}
        cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")}
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
                  onClick={() => {
                    setSelectedPricingTemplateId(definition.id);
                    setTemplateRouteOverride("");
                  }}
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
                  {(config?.upstreams || []).filter(up => !up.channelId).map((upstream) => (
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

            <label className="field">
              <span className="field-label">{t("routing.template.defaultRoute", "Default Route")}</span>
              <select value={templateRouteOverride} onChange={(event) => setTemplateRouteOverride(event.target.value)}>
                <option value="">{t("routing.route.auto", "Use template default")}</option>
                {selectedTemplateRouteOptions.map((routeValue) => (
                  <option key={routeValue} value={routeValue}>{t(`routing.route.${routeValue}`, routeValue)}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="inline">
            <input type="checkbox" checked={templateImportPricing} onChange={(event) => setTemplateImportPricing(event.target.checked)} />
            <span>{t("routing.template.importPricing", "Import pricing catalog entry together")}</span>
          </label>
        </div>
      </Modal>

      {page?.id === "settings" && subsection !== "json" ? <div className="table-toolbar">
        <input type="search" value={settingsFilters.search} aria-label={t("ui.settingsSearch")} placeholder={t("ui.settingsSearch")}
          onChange={event => setSettingsFilters(current => ({ ...current, search: event.target.value }))} />
        <label className="inline"><input type="checkbox" checked={settingsFilters.modifiedOnly}
          onChange={event => setSettingsFilters(current => ({ ...current, modifiedOnly: event.target.checked }))} />{t("ui.modifiedOnly")}</label>
      </div> : null}
      {page?.id === "usage" ? <div className="table-toolbar">
        <nav className="section-tabs" aria-label={t("shell.page.usage")}>
          {["models", "keys", "analytics", "signals"].map(tab => <button key={tab} className="ghost" aria-pressed={usageTab === tab}
            onClick={() => setUsageView(current => ({ ...current, tab }))}>{t(`ui.usage.${tab}`)}</button>)}
        </nav>
        <select aria-label={t("ui.groupBy")} value={usageView.group} onChange={event => setUsageView(current => ({ ...current, group: event.target.value }))}>
          <option value="public">{t("routing.field.proxyModelId")}</option><option value="canonical">{t("channel.canonical")}</option>
        </select>
      </div> : null}
      <SettingsFieldsProvider value={page?.id === "settings" ? { ...settingsFilters, config, loadedConfig, metadata: runtime?.configuration?.fieldMetadata, t } : null}>
      <PageSections sections={page?.id === "usage"
        ? ["runtime-overview", `runtime-${usageTab}`] : sections}>
          <Suspense fallback={<div className="loading">{t("common.loading", "Loading...")}</div>}>
      {page?.id === "overview" ? !overviewAwaitingGlobal && stats?.analytics?.rollups?.hourly?.length
        ? <UsageChart rollups={stats.analytics.rollups.hourly} t={t} />
        : <p className="chart-empty">{t("ui.chartEmpty")} <Link to="/settings/persistence">{t("shell.settings.persistence")}</Link></p> : null}
      {page?.id === "overview" ? <OverviewLists models={overviewAwaitingGlobal ? {} : modelStats} keys={overviewAwaitingGlobal ? {} : perKeyStats} validation={modelValidationResult} t={t} /> : null}
      {page?.id === "health" ? <section className="panel">
        <StatCard label={t("summary.caddy")} value={caddyStatus?.state || t("ui.unknown")} note={formatDateTime(caddyStatus?.lastReloadAt)} />
        <Link to="/settings/gateway">{t("shell.settings.gateway")}</Link>
      </section> : null}

      {(activeTab === "workspace" || page?.id === "catalog") && config ? (
        <WorkspaceTab
          coreGroup={subsection}
          config={config}
          capabilities={distributionCapabilities}
          effectiveProfile={runtime?.distribution?.profile}
          configDeprecations={runtime?.configuration?.deprecatedFlags || []}
          configCleanupRequired={configCleanupRequired}
          updateField={updateField}
          pricingCatalogText={pricingCatalogText}
          updatePricingCatalog={updatePricingCatalog}
          pricingCatalogError={pricingCatalogError}
          databaseConfigForm={databaseConfigForm}
          setDatabaseConfigForm={setDatabaseConfigForm}
          databaseTestResult={databaseTestResult}
          logAnalyticsInitializationResult={logAnalyticsInitializationResult}
          diagnosticsBusy={diagnosticsBusy}
          onReloadDatabaseDefaults={handleReloadDatabaseDefaults}
          onTestDatabaseConnection={handleTestDatabaseConnection}
          onInitializeLogAnalytics={handleInitializeLogAnalytics}
          formatDateTime={formatDateTime}
          t={t}
        />
      ) : null}

      {activeTab === "keys" && config ? (
        <KeysTab
          config={config}
          loadedConfig={loadedConfig}
          updateConfig={updateConfig}
          onCopyApiKey={handleCopyApiKey}
          governanceKeys={governanceKeys}
          t={t}
        />
      ) : null}

      {activeTab === "routing" && config ? (
        <RoutingTab
          view={page?.id}
          key={routingGeneration}
          config={config}
          loadedConfig={loadedConfig}
          copilotOperations={copilotOperations.current}
          pricingLibrary={pricingLibrary}
          capabilityView={
            harnessEligibilityFresh
              ? harnessEligibility?.capabilities?.[dirty ? "preview" : "active"] || null
              : null
          }
          capabilitiesLoading={harnessEligibilityLoading}
          capabilitiesError={harnessEligibilityError}
          capabilityPreview={dirty}
          capabilityFallbackModels={capabilityFallbackModels}
          updateConfig={updateConfig}
          addModel={addModel}
          addBlankModel={addBlankModel}
          mappingDrafts={mappingDrafts}
          setMappingDrafts={setMappingDrafts}
          onEditKey={index => {
            navigate(`/keys?edit=${encodeURIComponent(config.apiKeys[index].id)}&tab=access`);
          }}
          t={t}
        />
      ) : null}

      {activeTab === "harness" && config ? (
        <HarnessTab
          config={config}
          loadedConfig={loadedConfig}
          dirty={dirty}
          eligibility={harnessEligibilityFresh ? harnessEligibility : null}
          eligibilityLoading={harnessEligibilityLoading}
          eligibilityError={harnessEligibilityError}
          onRetry={() => setHarnessEligibilityRevision(value => value + 1)}
          onNavigate={handleHarnessNavigate}
          updateConfig={updateConfig}
          t={t}
        />
      ) : null}

      {activeTab === "runtime" ? (
        <RuntimeTab
          grouping={page?.id === "usage" ? usageView.group === "canonical" ? "canonical" : "public" : undefined}
          usageTab={page?.id === "usage" ? usageTab : undefined}
          trendChart={page?.id === "usage" ? stats?.analytics?.rollups?.hourly?.length
            ? <UsageChart rollups={stats.analytics.rollups.hourly} t={t} />
            : <p className="chart-empty">{t("ui.chartEmpty")} <Link to="/settings/persistence">{t("shell.settings.persistence")}</Link></p> : null}
          config={config}
          pricingLibrary={pricingLibrary}
          onApplyCardPricing={modelIds => {
            const next = cloneJson(config);
            applyModelCardTierPricing(next, modelIds, pricingLibrary);
            setConfig(next);
          }}
          totals={stats?.totals}
          snapshotFilters={stats?.filters}
          statsUpdatedAt={statsUpdatedAt}
          statsSnapshot={stats?.snapshot}
          persistenceRuntime={persistenceRuntime}
          loggingRuntime={loggingRuntime}
          runtimeStore={runtimeStore}
          persistenceRuntimeText={persistenceRuntimeText}
          loggingRuntimeText={loggingRuntimeText}
          governanceKeys={governanceKeys}
          perKeyStats={perKeyStats}
          modelStats={modelStats}
          canonicalModels={stats?.canonicalModels}
          canonicalFilters={stats?.canonicalFilters}
          canonicalWindowTruncated={stats?.canonicalWindowTruncated}
          canonicalDetailRetentionDays={stats?.canonicalDetailRetentionDays}
          modelsResetAt={stats?.modelsResetAt}
          onResetModelStats={handleResetModelStats}
          modelStatsResetBusy={diagnosticsBusy.modelStatsReset === true}
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
          onEditModel={id => handleHarnessNavigate({ type: "model", id })}
          onEditChannel={id => handleHarnessNavigate({ type: "upstream", id })}
          LogComponent={LogExplorer}
          config={config}
          updateField={updateField}
          pricingLibraryStatus={pricingLibraryStatus}
          pricingSyncSource={pricingSyncSource}
          setPricingSyncSource={setPricingSyncSource}
          pricingLibraryCount={pricingLibrary.length}
          modelValidationResult={modelValidationResult}
          caddyStatus={caddyStatus}
          aadStatus={aadStatus}
          diagnosticsBusy={diagnosticsBusy}
          handleSyncPricingLibrary={handleSyncPricingLibrary}
          handleValidateConfiguredModels={handleValidateConfiguredModels}
          loadCaddyStatusAction={loadCaddyStatusAction}
          handleVerifyAad={handleVerifyAad}
          handleRestartService={handleRestartService}
          caddyPreview={caddyPreview}
          formatDateTime={formatDateTime}
          logs={logs}
          loggingRuntime={loggingRuntime}
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

      {page?.id === "settings" && subsection === "json" ? (
        <AdvancedTab
          advancedJsonEnabled={advancedJsonEnabled}
          advancedJson={advancedJson}
          config={config}
          updateAdvancedJson={updateAdvancedJson}
          onSaveJson={saveAdvancedJson}
          saving={saving}
          pending={pendingConfigJson}
          onResetJson={() => { setPendingConfigJson(false); setJsonError(""); }}
          jsonError={jsonError}
          dirty={dirty}
          configDiffCount={configDiffCount}
          configDiffPreview={configDiffPreview}
          t={t}
        />
      ) : null}
          </Suspense>
      </PageSections>
      </SettingsFieldsProvider>
      {page?.id === "config" && subsection === "sync" ? <section className="panel">
        <h2>{t("shell.sync")}</h2><p>{persistenceRuntimeText}</p>
        <button className="ghost" onClick={showConfigConflict}>{t("config.conflict.compare")}</button>
        <button className="ghost" onClick={() => handleReload("reload")}>{t("hero.reloadFromStore")}</button>
      </section> : null}
    </AppShell>
  );
}
