import { AccordionSection, Field, Section } from "./ui.jsx";
import { getValueByPath, parseList, formatList } from "../utils.js";

function asNumber(value) {
  return Number(value || 0);
}

function updateDatabaseForm(setDatabaseConfigForm, path, value) {
  setDatabaseConfigForm((current) => ({
    ...(current || {}),
    [path]: value
  }));
}

function formatBool(value, t) {
  return value ? t("common.yes", "Yes") : t("common.no", "No");
}

export default function WorkspaceTab({
  config,
  capabilities,
  updateField,
  pricingCatalogText,
  updatePricingCatalog,
  pricingCatalogError,
  databaseConfigForm,
  setDatabaseConfigForm,
  databaseTestResult,
  logAnalyticsInitializationResult,
  diagnosticsBusy,
  onReloadDatabaseDefaults,
  onTestDatabaseConnection,
  onInitializeLogAnalytics,
  formatDateTime,
  t
}) {
  const databaseResultText = databaseTestResult?.ok
    ? JSON.stringify(databaseTestResult.result || {}, null, 2)
    : (databaseTestResult?.error || "");
  const databaseProbeFacts = databaseTestResult?.ok
    ? [
        { label: t("workspace.databaseProbe.host", "Host"), value: databaseTestResult?.result?.connection?.host || "-" },
        { label: t("workspace.databaseProbe.database", "Database"), value: databaseTestResult?.result?.server?.currentDatabase || "-" },
        { label: t("workspace.databaseProbe.user", "User"), value: databaseTestResult?.result?.server?.currentUser || "-" },
        { label: t("workspace.databaseProbe.sslMode", "SSL Mode"), value: databaseTestResult?.result?.connection?.sslMode || "-" },
        { label: t("workspace.databaseProbe.schemaUsage", "Schema Usage"), value: formatBool(databaseTestResult?.result?.privileges?.schemaUsage, t) },
        { label: t("workspace.databaseProbe.schemaCreate", "Schema Create"), value: formatBool(databaseTestResult?.result?.privileges?.schemaCreate, t) },
        { label: t("workspace.databaseProbe.tableExists", "Table Exists"), value: formatBool(databaseTestResult?.result?.objects?.tableExists, t) },
        { label: t("workspace.databaseProbe.configExists", "Config Row Exists"), value: formatBool(databaseTestResult?.result?.objects?.configRowExists, t) }
      ]
    : [];
  const logAnalyticsResultText = logAnalyticsInitializationResult
    ? JSON.stringify(logAnalyticsInitializationResult, null, 2)
    : "";
  const budgetsAvailable = capabilities?.budgets !== false;
  const databaseAdminAvailable = capabilities?.databaseAdmin !== false;
  const logAnalyticsAvailable = capabilities?.logAnalytics !== false;
  const budgetsEnabled = budgetsAvailable && getValueByPath(config, "access.budgets.enabled") === true;
  const persistenceMode = getValueByPath(config, "persistence.configStore.mode") || "file";
  const fileSettingsVisible = persistenceMode !== "database";
  const databaseSettingsVisible = persistenceMode.includes("database")
    || getValueByPath(config, "persistence.configStore.database.enabled") === true;
  const compatibilityExportEnabled = getValueByPath(config, "persistence.compatibilityExport.enabled") !== false;
  const logAnalyticsEnabled = getValueByPath(config, "observability.logAnalytics.enabled") === true;
  const compressionEnabled = getValueByPath(config, "media.inputCompression.enabled") === true;
  const remoteImagesEnabled = getValueByPath(config, "media.remoteImages.allow") === true;
  const generationEnabled = getValueByPath(config, "media.generation.enabled") === true;
  const contentMode = getValueByPath(config, "observability.logs.messageContentMode") || "summary";
  const updateContentMode = (value) => {
    if (
      value === "full"
      && contentMode !== "full"
      && !window.confirm(t("workspace.logging.fullConfirm", "Full mode records redacted prompts and model output. Secrets and binary payloads remain omitted. Continue?"))
    ) {
      return;
    }
    updateField("observability.logs.messageContentMode", value);
    updateField("observability.logAnalytics.contentMode", value);
  };

  return (
    <div className="stack-lg">
      <Section title={t("workspace.title", "Configuration Workspace")} desc={t("workspace.desc", "Bring persistence, Log Analytics, media, and routing domains into structured editing.")}>
        <div className="stack-lg">
          <AccordionSection id="workspace-core" title={t("workspace.core.title", "Core And Governance Defaults")} desc={t("workspace.core.desc", "Host, admin path, proxy timeouts, API key defaults, and budget defaults.")} defaultOpen group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.distributionProfile", "Distribution Profile")}>
                <select value={getValueByPath(config, "distribution.profile") || "nextgen"} onChange={(event) => updateField("distribution.profile", event.target.value)}>
                  <option value="nextgen">nextgen</option>
                  <option value="minimum">minimum</option>
                </select>
              </Field>
              <Field label={t("field.serverHost", "Server Host")}>
                <input value={getValueByPath(config, "server.host") || ""} onChange={(event) => updateField("server.host", event.target.value)} />
              </Field>
              <Field label={t("field.serverPort", "Server Port")}>
                <input type="number" value={getValueByPath(config, "server.port") || 0} onChange={(event) => updateField("server.port", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.adminBasePath", "Admin Base Path")}>
                <input value={getValueByPath(config, "admin.basePath") || ""} onChange={(event) => updateField("admin.basePath", event.target.value)} />
              </Field>
              <Field label={t("field.keyHeaderNames", "Key Header Names")} hint={t("field.keyHeaderNamesHint", "Comma-separated and matched in order.")}>
                <input value={formatList(getValueByPath(config, "access.defaults.keyHeaderNames"))} onChange={(event) => updateField("access.defaults.keyHeaderNames", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.connectMs", "Connect ms")}>
                <input type="number" value={getValueByPath(config, "proxy.timeouts.connectMs") || 0} onChange={(event) => updateField("proxy.timeouts.connectMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.requestMs", "Request ms")}>
                <input type="number" value={getValueByPath(config, "proxy.timeouts.requestMs") || 0} onChange={(event) => updateField("proxy.timeouts.requestMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.firstByteMs", "First Byte ms")}>
                <input type="number" value={getValueByPath(config, "proxy.timeouts.firstByteMs") || 0} onChange={(event) => updateField("proxy.timeouts.firstByteMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.idleMs", "Idle ms")}>
                <input type="number" value={getValueByPath(config, "proxy.timeouts.idleMs") || 0} onChange={(event) => updateField("proxy.timeouts.idleMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.defaultRpm", "Default RPM")}>
                <input type="number" value={getValueByPath(config, "access.rateLimits.defaultRpm") || 0} onChange={(event) => updateField("access.rateLimits.defaultRpm", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.defaultTpm", "Default TPM")}>
                <input type="number" value={getValueByPath(config, "access.rateLimits.defaultTpm") || 0} onChange={(event) => updateField("access.rateLimits.defaultTpm", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.defaultConcurrency", "Default Concurrency")}>
                <input type="number" value={getValueByPath(config, "access.rateLimits.defaultConcurrency") || 0} onChange={(event) => updateField("access.rateLimits.defaultConcurrency", asNumber(event.target.value))} />
              </Field>
              {budgetsEnabled ? (
                <>
                  <Field label={t("field.budgetCurrency", "Budget Currency")}>
                    <input value={getValueByPath(config, "access.budgets.defaultCurrency") || "USD"} onChange={(event) => updateField("access.budgets.defaultCurrency", event.target.value)} />
                  </Field>
                  <Field label={t("field.softLimitRatio", "Soft Limit Ratio")}>
                    <input type="number" step="0.05" min="0" max="1" value={getValueByPath(config, "access.budgets.softLimitRatio") || 0} onChange={(event) => updateField("access.budgets.softLimitRatio", Number(event.target.value || 0))} />
                  </Field>
                  <Field label={t("field.hardLimitAction", "Hard Limit Action")}>
                    <select value={getValueByPath(config, "access.budgets.hardLimitAction") || "block"} onChange={(event) => updateField("access.budgets.hardLimitAction", event.target.value)}>
                      <option value="block">{t("option.block", "block")}</option>
                      <option value="warn">{t("option.warn", "warn")}</option>
                    </select>
                  </Field>
                </>
              ) : null}
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "server.trustProxy") === true} onChange={(event) => updateField("server.trustProxy", event.target.checked)} /> {t("field.trustProxy", "Trust Proxy Headers")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "admin.auth.enabled") === true} onChange={(event) => updateField("admin.auth.enabled", event.target.checked)} /> {t("field.enableAdminAuth", "Enable Admin Basic Auth")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "access.defaults.requireApiKey") !== false} onChange={(event) => updateField("access.defaults.requireApiKey", event.target.checked)} /> {t("field.requireApiKey", "Require API Key")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "access.budgets.enabled") === true} disabled={!budgetsAvailable} onChange={(event) => updateField("access.budgets.enabled", event.target.checked)} /> {t("field.enableBudget", "Enable Budgets")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "admin.features.enableLegacyJsonEditor") !== false} onChange={(event) => updateField("admin.features.enableLegacyJsonEditor", event.target.checked)} /> {t("field.enableAdvancedJson", "Enable Advanced JSON Editor")}</label>
            </div>
            <Field label={t("field.pricingCatalog", "Pricing Catalog")} hint={t("field.pricingCatalogHint", "JSON object. Without pricing data, only tokens are counted and amount remains zero.")}>
              <textarea rows={8} value={pricingCatalogText} onChange={(event) => updatePricingCatalog(event.target.value)} />
            </Field>
            {pricingCatalogError ? <div className="inline-error">{pricingCatalogError}</div> : null}
          </AccordionSection>

          <AccordionSection id="workspace-persistence" title={t("workspace.persistence.title", "Persistence And Cache")} desc={t("workspace.persistence.desc", "Configure file, Azure Files, database, and database+Azure Files persistence modes plus PostgreSQL storage, cache, and compatibility export.")} group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.persistenceMode", "Persistence Mode")}>
                <select value={persistenceMode} onChange={(event) => updateField("persistence.configStore.mode", event.target.value)}>
                  <option value="file">{t("option.file", "file")}</option>
                  <option value="azureFile">{t("option.azureFile", "azureFile")}</option>
                  <option value="database">{t("option.database", "database")}</option>
                  <option value="database+azureFile">{t("option.database+azureFile", "database+azureFile")}</option>
                </select>
              </Field>
              {fileSettingsVisible ? (
                <Field label={t("field.configFilePath", "Config File Path")}>
                  <input value={getValueByPath(config, "persistence.configStore.filePath") || ""} onChange={(event) => updateField("persistence.configStore.filePath", event.target.value)} />
                </Field>
              ) : null}
              {databaseSettingsVisible ? (
                <>
                  <Field label={t("field.databaseProvider", "Database Provider")}>
                    <input value={getValueByPath(config, "persistence.configStore.database.provider") || "postgresql"} onChange={(event) => updateField("persistence.configStore.database.provider", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseConnectionRef", "Connection Ref")}>
                    <input value={getValueByPath(config, "persistence.configStore.database.connectionRef") || ""} onChange={(event) => updateField("persistence.configStore.database.connectionRef", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseSchema", "Schema")}>
                    <input value={getValueByPath(config, "persistence.configStore.database.schema") || "public"} onChange={(event) => updateField("persistence.configStore.database.schema", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseTable", "Table Name")}>
                    <input value={getValueByPath(config, "persistence.configStore.database.tableName") || "proxy_configs"} onChange={(event) => updateField("persistence.configStore.database.tableName", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseConfigKey", "Config Key")}>
                    <input value={getValueByPath(config, "persistence.configStore.database.configKey") || "active"} onChange={(event) => updateField("persistence.configStore.database.configKey", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseFallback", "Read Fallback")}>
                    <select value={getValueByPath(config, "persistence.configStore.database.readFallbackMode") || "lastKnownGood"} onChange={(event) => updateField("persistence.configStore.database.readFallbackMode", event.target.value)}>
                      <option value="lastKnownGood">{t("option.lastKnownGood", "lastKnownGood")}</option>
                      <option value="none">{t("option.none", "none")}</option>
                    </select>
                  </Field>
                </>
              ) : null}
              <Field label={t("field.cacheType", "Cache Type")}>
                <select value={getValueByPath(config, "persistence.cache.type") || "memory"} onChange={(event) => updateField("persistence.cache.type", event.target.value)}>
                  <option value="memory">{t("option.memory", "memory")}</option>
                </select>
              </Field>
              <Field label={t("field.cacheTtlMs", "Cache TTL ms")}>
                <input type="number" value={getValueByPath(config, "persistence.cache.ttlMs") || 0} onChange={(event) => updateField("persistence.cache.ttlMs", asNumber(event.target.value))} />
              </Field>
              {compatibilityExportEnabled ? (
                <Field label={t("field.compatibilityExportPath", "Legacy Config Path")}>
                  <input value={getValueByPath(config, "persistence.compatibilityExport.legacyConfigPath") || ""} onChange={(event) => updateField("persistence.compatibilityExport.legacyConfigPath", event.target.value)} />
                </Field>
              ) : null}
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.configStore.database.enabled") === true} onChange={(event) => updateField("persistence.configStore.database.enabled", event.target.checked)} /> {t("field.databaseEnabled", "Enable Database Store")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.compatibilityExport.enabled") !== false} onChange={(event) => updateField("persistence.compatibilityExport.enabled", event.target.checked)} /> {t("field.compatibilityExportEnabled", "Enable compatibility export")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.compatibilityExport.exportLegacyConfigOnChange") !== false} onChange={(event) => updateField("persistence.compatibilityExport.exportLegacyConfigOnChange", event.target.checked)} /> {t("field.compatibilityExportLegacy", "Export legacy config on change")}</label>
            </div>

            {databaseSettingsVisible && databaseAdminAvailable ? <div className="database-probe-panel">
              <div className="database-probe-header">
                <div className="code-block-head">{t("workspace.databaseProbe.title", "Database Connection Test")}</div>
                <p className="muted database-probe-desc">{t("workspace.databaseProbe.desc", "Load the current connection string from environment-backed runtime settings, edit it temporarily, and verify connectivity without saving secrets into config.json.")}</p>
                <p className="field-hint database-probe-note">{t("workspace.databaseProbe.note", "This panel is for diagnostics only. Testing uses the temporary value here and does not write secrets back into persistence config.")}</p>
              </div>

              <div className="database-probe-form">
                <div className="database-probe-span-full">
                  <Field label={t("field.databaseConnectionString", "Connection String")} hint={t("field.databaseConnectionStringHint", "Defaults come from CONFIG_DB_CONNECTION_STRING, DATABASE_URL, or a configured connectionRef when available.")}>
                    <textarea className="database-probe-connection-string" rows={5} autoComplete="off" value={databaseConfigForm?.connectionString || ""} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "connectionString", event.target.value)} />
                  </Field>
                </div>
                <Field label={t("field.databaseConnectionRefResolved", "Resolved Connection Ref")} hint={t("field.databaseConnectionRefResolvedHint", "If Connection String is empty, the test will try to resolve this environment variable on the server.")}>
                    <input value={databaseConfigForm?.connectionRef || ""} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "connectionRef", event.target.value)} />
                </Field>
                <Field label={t("field.databaseProvider", "Database Provider")}>
                  <select value={databaseConfigForm?.provider || "postgresql"} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "provider", event.target.value)}>
                    <option value="postgresql">postgresql</option>
                  </select>
                </Field>
                <Field label={t("field.databaseSchema", "Schema")}>
                  <input value={databaseConfigForm?.schemaName || "public"} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "schemaName", event.target.value)} />
                </Field>
                <Field label={t("field.databaseTable", "Table Name")}>
                  <input value={databaseConfigForm?.tableName || "proxy_configs"} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "tableName", event.target.value)} />
                </Field>
                <Field label={t("field.databaseConfigKey", "Config Key")}>
                  <input value={databaseConfigForm?.configKey || "active"} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "configKey", event.target.value)} />
                </Field>
              </div>

              <div className="toolbar database-probe-actions">
                  <button type="button" className="ghost" onClick={onReloadDatabaseDefaults} disabled={diagnosticsBusy?.databaseDefaults === true || diagnosticsBusy?.databaseTest === true}>
                    {diagnosticsBusy?.databaseDefaults === true ? t("common.loading", "Loading...") : t("workspace.databaseProbe.reload", "Load Runtime Defaults")}
                  </button>
                  <button type="button" onClick={onTestDatabaseConnection} disabled={diagnosticsBusy?.databaseTest === true}>
                    {diagnosticsBusy?.databaseTest === true ? t("workspace.databaseProbe.testing", "Testing...") : t("workspace.databaseProbe.test", "Test Connection")}
                  </button>
              </div>

              {databaseTestResult ? (
                <div className="database-probe-result">
                  <div className={databaseTestResult.ok ? "database-probe-status success" : "database-probe-status error"}>
                      {databaseTestResult.ok
                        ? t("workspace.databaseProbe.ok", "Connection succeeded at {time}.", { time: formatDateTime(databaseTestResult.checkedAt) })
                        : t("workspace.databaseProbe.failed", "Connection failed at {time}.", { time: formatDateTime(databaseTestResult.checkedAt) })}
                  </div>

                  {databaseProbeFacts.length ? (
                    <div className="database-probe-summary-grid">
                      {databaseProbeFacts.map((item) => (
                        <div key={item.label} className="database-probe-summary-item">
                          <div className="database-probe-summary-label">{item.label}</div>
                          <div className="database-probe-summary-value">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <details className="database-probe-raw" open={!databaseTestResult.ok}>
                    <summary>{t("workspace.databaseProbe.raw", "Raw Result")}</summary>
                    <pre>{databaseResultText}</pre>
                  </details>
                </div>
              ) : null}
            </div> : null}
          </AccordionSection>

          <AccordionSection id="workspace-logging" title={t("workspace.logging.title", "Logging And Log Analytics")} desc={t("workspace.logging.desc", "Control log level, content policy, and the Azure Monitor Logs Ingestion sink.") } group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.logLevel", "Log Level")}>
                <select value={getValueByPath(config, "observability.logs.level") || "warn"} onChange={(event) => updateField("observability.logs.level", event.target.value)}>
                  <option value="trace">{t("option.trace", "trace")}</option>
                  <option value="debug">{t("option.debug", "debug")}</option>
                  <option value="info">{t("option.info", "info")}</option>
                  <option value="warn">{t("option.warn", "warn")}</option>
                  <option value="error">{t("option.error", "error")}</option>
                </select>
              </Field>
              <Field label={t("field.logSinks", "Log Sinks")}>
                <input value={formatList(getValueByPath(config, "observability.logs.sinks"))} onChange={(event) => updateField("observability.logs.sinks", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.logBufferSize", "Log Buffer Size")}>
                <input type="number" value={getValueByPath(config, "observability.logs.bufferSize") || 0} onChange={(event) => updateField("observability.logs.bufferSize", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.logBufferMaxBytes", "Log Buffer Max Bytes")}>
                <input type="number" value={getValueByPath(config, "observability.logs.maxBufferBytes") || 0} onChange={(event) => updateField("observability.logs.maxBufferBytes", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.logMessageContentMode", "Message Content Mode")}>
                <select value={contentMode} onChange={(event) => updateContentMode(event.target.value)}>
                  <option value="summary">{t("option.partial", "Partial")}</option>
                  <option value="full">{t("option.full", "Full")}</option>
                </select>
              </Field>
              <Field label={t("field.logMaxPayloadBytes", "Max Payload Log Bytes")}>
                <input type="number" value={getValueByPath(config, "observability.logs.maxPayloadLogBytes") || 0} onChange={(event) => updateField("observability.logs.maxPayloadLogBytes", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.workspaceResourceId", "Workspace Resource ID")}>
                <input value={getValueByPath(config, "observability.logAnalytics.workspaceResourceId") || ""} onChange={(event) => updateField("observability.logAnalytics.workspaceResourceId", event.target.value)} />
              </Field>
              <Field label={t("field.dataCollectionEndpointResourceId", "DCE Resource ID")}>
                <input value={getValueByPath(config, "observability.logAnalytics.dataCollectionEndpointResourceId") || ""} onChange={(event) => updateField("observability.logAnalytics.dataCollectionEndpointResourceId", event.target.value)} />
              </Field>
              <Field label={t("field.dataCollectionRuleName", "DCR Name")}>
                <input value={getValueByPath(config, "observability.logAnalytics.dataCollectionRuleName") || "aoai-proxy-logs"} onChange={(event) => updateField("observability.logAnalytics.dataCollectionRuleName", event.target.value)} />
              </Field>
              <Field label={t("field.tableName", "Table Name")}>
                <input value={getValueByPath(config, "observability.logAnalytics.tableName") || "AOAIProxyLogs_CL"} onChange={(event) => updateField("observability.logAnalytics.tableName", event.target.value)} />
              </Field>
              <Field label={t("field.streamName", "Stream Name")}>
                <input value={getValueByPath(config, "observability.logAnalytics.streamName") || "Custom-AOAIProxyLogs"} onChange={(event) => updateField("observability.logAnalytics.streamName", event.target.value)} />
              </Field>
              <Field label={t("field.credentialRef", "Credential Ref")}>
                <input value={getValueByPath(config, "observability.logAnalytics.credentialRef") || ""} onChange={(event) => updateField("observability.logAnalytics.credentialRef", event.target.value)} />
              </Field>
              <Field label={t("field.audience", "Audience")}>
                <input value={getValueByPath(config, "observability.logAnalytics.audience") || ""} onChange={(event) => updateField("observability.logAnalytics.audience", event.target.value)} />
              </Field>
              {logAnalyticsEnabled ? (
                <>
                  <Field label={t("field.workspaceId", "Workspace ID")}><input value={getValueByPath(config, "observability.logAnalytics.workspaceId") || ""} onChange={(event) => updateField("observability.logAnalytics.workspaceId", event.target.value)} /></Field>
                  <Field label={t("field.endpoint", "Logs Ingestion Endpoint")}><input value={getValueByPath(config, "observability.logAnalytics.endpoint") || ""} onChange={(event) => updateField("observability.logAnalytics.endpoint", event.target.value)} /></Field>
                  <Field label={t("field.dataCollectionRuleResourceId", "DCR Resource ID")}><input value={getValueByPath(config, "observability.logAnalytics.dataCollectionRuleResourceId") || ""} onChange={(event) => updateField("observability.logAnalytics.dataCollectionRuleResourceId", event.target.value)} /></Field>
                  <Field label={t("field.dcrImmutableId", "DCR Immutable ID")}><input value={getValueByPath(config, "observability.logAnalytics.dcrImmutableId") || ""} onChange={(event) => updateField("observability.logAnalytics.dcrImmutableId", event.target.value)} /></Field>
                  <Field label={t("field.flushIntervalMs", "Flush Interval ms")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.flushIntervalMs") || 0} onChange={(event) => updateField("observability.logAnalytics.flushIntervalMs", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.batchSize", "Batch Size")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.batchSize") || 0} onChange={(event) => updateField("observability.logAnalytics.batchSize", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.samplingRatio", "Sampling Ratio")}><input type="number" step="0.1" min="0" max="1" value={getValueByPath(config, "observability.logAnalytics.samplingRatio") || 0} onChange={(event) => updateField("observability.logAnalytics.samplingRatio", Number(event.target.value || 0))} /></Field>
                  <Field label={t("field.maxConcurrency", "Max Concurrency")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.maxConcurrency") || 0} onChange={(event) => updateField("observability.logAnalytics.maxConcurrency", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.maxQueueSize", "Max Queue Size")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.maxQueueSize") || 0} onChange={(event) => updateField("observability.logAnalytics.maxQueueSize", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.maxQueueBytes", "Max Queue Bytes")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.maxQueueBytes") || 0} onChange={(event) => updateField("observability.logAnalytics.maxQueueBytes", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.uploadTimeoutMs", "Upload Timeout ms")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.uploadTimeoutMs") || 0} onChange={(event) => updateField("observability.logAnalytics.uploadTimeoutMs", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.maxUploadRetries", "Max Upload Retries")}><input type="number" min="0" value={getValueByPath(config, "observability.logAnalytics.maxUploadRetries") ?? 0} onChange={(event) => updateField("observability.logAnalytics.maxUploadRetries", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.retryBaseDelayMs", "Retry Base Delay ms")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.retryBaseDelayMs") || 0} onChange={(event) => updateField("observability.logAnalytics.retryBaseDelayMs", asNumber(event.target.value))} /></Field>
                  <Field label={t("field.retryMaxDelayMs", "Retry Max Delay ms")}><input type="number" value={getValueByPath(config, "observability.logAnalytics.retryMaxDelayMs") || 0} onChange={(event) => updateField("observability.logAnalytics.retryMaxDelayMs", asNumber(event.target.value))} /></Field>
                </>
              ) : null}
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeClientIp") === true} onChange={(event) => updateField("observability.logs.includeClientIp", event.target.checked)} /> {t("field.includeClientIp", "Include Client IP")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeUsage") === true} onChange={(event) => updateField("observability.logs.includeUsage", event.target.checked)} /> {t("field.includeUsage", "Include Usage")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeHeaders") === true} onChange={(event) => updateField("observability.logs.includeHeaders", event.target.checked)} /> {t("field.includeHeaders", "Include Headers")}</label>
              <label title={t("field.redactSecretsEnforced", "Sensitive values are always redacted and this protection cannot be disabled.")}><input type="checkbox" checked disabled /> {t("field.redactSecrets", "Redact Secrets")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.redactApiKeyInfo") !== false} onChange={(event) => updateField("observability.logs.redactApiKeyInfo", event.target.checked)} /> {t("field.redactApiKeyInfo", "Redact API Key Info")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logAnalytics.enabled") === true} disabled={!logAnalyticsAvailable} onChange={(event) => updateField("observability.logAnalytics.enabled", event.target.checked)} /> {t("field.logAnalyticsEnabled", "Enable Log Analytics Sink")}</label>
            </div>
            {logAnalyticsAvailable ? <div className="database-probe-panel log-analytics-init-panel">
              <div className="database-probe-header">
                <strong>{t("workspace.logAnalyticsInit.title", "Log Analytics Initialization")}</strong>
                <p className="muted database-probe-desc">{t("workspace.logAnalyticsInit.desc", "Validate the existing workspace and public DCE, reconcile the custom table and Direct DCR, then upload a probe record.")}</p>
              </div>
              <div className="toolbar database-probe-actions">
                <button type="button" onClick={onInitializeLogAnalytics} disabled={diagnosticsBusy?.logAnalyticsInitialize === true}>
                  {diagnosticsBusy?.logAnalyticsInitialize === true
                    ? t("workspace.logAnalyticsInit.running", "Initializing...")
                    : t("workspace.logAnalyticsInit.action", "Initialize And Test")}
                </button>
              </div>
              {logAnalyticsInitializationResult ? (
                <div className="database-probe-result">
                  <div className={logAnalyticsInitializationResult.ok ? "database-probe-status success" : "database-probe-status error"}>
                    {logAnalyticsInitializationResult.ok
                      ? t("workspace.logAnalyticsInit.ok", "Initialization and probe upload succeeded. Save the configuration to enable logging.")
                      : t("workspace.logAnalyticsInit.failed", "Initialization needs attention. Successful resource stages are retained for retry.")}
                  </div>
                  <div className="database-probe-summary-grid log-analytics-phase-grid">
                    {(logAnalyticsInitializationResult.phases || []).map((phase) => (
                      <div key={phase.name} className="database-probe-summary-item">
                        <div className="database-probe-summary-label">{phase.name.replaceAll("_", " ")}</div>
                        <div className={`database-probe-summary-value phase-${phase.status}`}>{phase.status}</div>
                      </div>
                    ))}
                  </div>
                  {logAnalyticsInitializationResult.requiredRole ? (
                    <div className="database-probe-status error">
                      <strong>{logAnalyticsInitializationResult.requiredRole.name}</strong>
                      <div className="resource-id-value">{logAnalyticsInitializationResult.requiredRole.scope}</div>
                    </div>
                  ) : null}
                  <details className="database-probe-raw" open={!logAnalyticsInitializationResult.ok}>
                    <summary>{t("workspace.logAnalyticsInit.raw", "Initialization Details")}</summary>
                    <pre>{logAnalyticsResultText}</pre>
                  </details>
                </div>
              ) : null}
            </div> : null}
          </AccordionSection>

          <AccordionSection id="workspace-media" title={t("workspace.media.title", "Media Policy")} desc={t("workspace.media.desc", "Control input compression, remote images, inline images, and image generation defaults.") } group="workspace-sections">
            <div className="form-grid">
              {compressionEnabled ? <><Field label={t("field.mediaMaxLongSide", "Max Long Side px")}>
                <input type="number" value={getValueByPath(config, "media.inputCompression.maxLongSidePx") || 0} onChange={(event) => updateField("media.inputCompression.maxLongSidePx", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaQuality", "Quality")}>
                <input type="number" step="0.05" min="0" max="1" value={getValueByPath(config, "media.inputCompression.quality") || 0} onChange={(event) => updateField("media.inputCompression.quality", Number(event.target.value || 0))} />
              </Field>
              <Field label={t("field.mediaMinQuality", "Min Quality")}>
                <input type="number" step="0.05" min="0" max="1" value={getValueByPath(config, "media.inputCompression.minQuality") || 0} onChange={(event) => updateField("media.inputCompression.minQuality", Number(event.target.value || 0))} />
              </Field>
              <Field label={t("field.mediaOutputFormat", "Output Format")}>
                <select value={getValueByPath(config, "media.inputCompression.outputFormat") || "jpeg"} onChange={(event) => updateField("media.inputCompression.outputFormat", event.target.value)}>
                  <option value="jpeg">{t("option.jpeg", "jpeg")}</option>
                  <option value="webp">{t("option.webp", "webp")}</option>
                </select>
              </Field></> : null}
              {remoteImagesEnabled ? <><Field label={t("field.remoteImagesMaxMb", "Remote Download Limit MB")}>
                <input type="number" value={getValueByPath(config, "media.remoteImages.maxDownloadSizeMb") || 0} onChange={(event) => updateField("media.remoteImages.maxDownloadSizeMb", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.remoteImagesTimeoutMs", "Remote Timeout ms")}>
                <input type="number" value={getValueByPath(config, "media.remoteImages.timeoutMs") || 0} onChange={(event) => updateField("media.remoteImages.timeoutMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.remoteImagesMimeTypes", "Remote Allowed MIME Types")}>
                <input value={formatList(getValueByPath(config, "media.remoteImages.allowedMimeTypes"))} onChange={(event) => updateField("media.remoteImages.allowedMimeTypes", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.remoteImagesHosts", "Remote Allowed Hosts")}>
                <input value={formatList(getValueByPath(config, "media.remoteImages.allowedHosts"))} onChange={(event) => updateField("media.remoteImages.allowedHosts", parseList(event.target.value))} />
              </Field></> : null}
              <Field label={t("field.inlineImagesMaxBase64", "Inline Max Base64 Bytes")}>
                <input type="number" value={getValueByPath(config, "media.inlineImages.maxBase64Bytes") || 0} onChange={(event) => updateField("media.inlineImages.maxBase64Bytes", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.inlineImagesPreview", "Inline Log Preview Chars")}>
                <input type="number" value={getValueByPath(config, "media.inlineImages.logPreviewChars") || 0} onChange={(event) => updateField("media.inlineImages.logPreviewChars", asNumber(event.target.value))} />
              </Field>
              {generationEnabled ? <><Field label={t("field.mediaGenerationDefaultModel", "Default Generation Model")}>
                <input value={getValueByPath(config, "media.generation.defaultModel") || ""} onChange={(event) => updateField("media.generation.defaultModel", event.target.value)} />
              </Field>
              <Field label={t("field.mediaGenerationRequestTimeout", "Generation Request Timeout ms")}>
                <input type="number" value={getValueByPath(config, "media.generation.requestTimeoutMs") || 0} onChange={(event) => updateField("media.generation.requestTimeoutMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationPollInterval", "Generation Poll Interval ms")}>
                <input type="number" value={getValueByPath(config, "media.generation.pollIntervalMs") || 0} onChange={(event) => updateField("media.generation.pollIntervalMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationPollTimeout", "Generation Poll Timeout ms")}>
                <input type="number" value={getValueByPath(config, "media.generation.pollTimeoutMs") || 0} onChange={(event) => updateField("media.generation.pollTimeoutMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationMaxImages", "Max Images")}>
                <input type="number" value={getValueByPath(config, "media.generation.maxImages") || 0} onChange={(event) => updateField("media.generation.maxImages", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationAllowedSizes", "Allowed Sizes")}>
                <input value={formatList(getValueByPath(config, "media.generation.allowedSizes"))} onChange={(event) => updateField("media.generation.allowedSizes", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationAllowedQualityModes", "Allowed Quality Modes")}>
                <input value={formatList(getValueByPath(config, "media.generation.allowedQualityModes"))} onChange={(event) => updateField("media.generation.allowedQualityModes", parseList(event.target.value))} />
              </Field></> : null}
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.enabled") === true} onChange={(event) => updateField("media.inputCompression.enabled", event.target.checked)} /> {t("field.mediaCompressionEnabled", "Enable Input Compression")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.progressive") === true} onChange={(event) => updateField("media.inputCompression.progressive", event.target.checked)} /> {t("field.mediaProgressive", "Progressive")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "media.inputCompression.useMozJpeg") === true} onChange={(event) => updateField("media.inputCompression.useMozJpeg", event.target.checked)} /> {t("field.mediaMozJpeg", "Prefer mozjpeg")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "media.remoteImages.allow") === true} onChange={(event) => updateField("media.remoteImages.allow", event.target.checked)} /> {t("field.remoteImagesAllow", "Allow Remote Images")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "media.inlineImages.redactInLogs") === true} onChange={(event) => updateField("media.inlineImages.redactInLogs", event.target.checked)} /> {t("field.inlineImagesRedact", "Redact Inline Image Logs")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "media.generation.enabled") === true} onChange={(event) => updateField("media.generation.enabled", event.target.checked)} /> {t("field.mediaGenerationEnabled", "Enable Image Generation Route")}</label>
            </div>
          </AccordionSection>

          <AccordionSection id="workspace-routing" title={t("workspace.routing.title", "Routing Domain")} desc={t("workspace.routing.desc", "Manage enablement, allowed fields, and image polling behavior.") } group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.routeChatAllowedFields", "Chat Allowed Fields")}>
                <input value={formatList(getValueByPath(config, "routing.routeProfiles.chatCompletions.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.chatCompletions.allowedRequestFields", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.routeResponsesAllowedFields", "Responses Allowed Fields")}>
                <input value={formatList(getValueByPath(config, "routing.routeProfiles.responses.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.responses.allowedRequestFields", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.routeMessagesAllowedFields", "Messages Allowed Fields")}>
                <input value={formatList(getValueByPath(config, "routing.routeProfiles.messages.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.messages.allowedRequestFields", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.anthropicBetaAllowlist", "Anthropic Beta Allowlist")}>
                <input value={formatList(getValueByPath(config, "compatibility.anthropic.betaAllowlist"))} onChange={(event) => updateField("compatibility.anthropic.betaAllowlist", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.routeImagesAllowedFields", "Image Allowed Fields")}>
                <input value={formatList(getValueByPath(config, "routing.routeProfiles.imageGenerations.allowedRequestFields"))} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.allowedRequestFields", parseList(event.target.value))} />
              </Field>
              <Field label={t("field.routeImagesPollInterval", "Image Poll Interval ms")}>
                <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.intervalMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.intervalMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.routeImagesPollTimeout", "Image Poll Timeout ms")}>
                <input type="number" value={getValueByPath(config, "routing.routeProfiles.imageGenerations.polling.timeoutMs") || 0} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.polling.timeoutMs", asNumber(event.target.value))} />
              </Field>
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.chatCompletions.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.chatCompletions.enabled", event.target.checked)} /> {t("field.routeChatEnabled", "Enable chat/completions")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.responses.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.responses.enabled", event.target.checked)} /> {t("field.routeResponsesEnabled", "Enable responses")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.messages.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.messages.enabled", event.target.checked)} /> {t("field.routeMessagesEnabled", "Enable messages")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.claudeCode.enabled") !== false} onChange={(event) => updateField("compatibility.claudeCode.enabled", event.target.checked)} /> {t("field.claudeCodeCompatibilityEnabled", "Enable Claude Code compatibility")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.codex.enabled") !== false} onChange={(event) => updateField("compatibility.codex.enabled", event.target.checked)} /> {t("field.codexCompatibilityEnabled", "Enable Codex compatibility")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyRequests") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyRequests", event.target.checked)} /> {t("field.protocolShimRejectLossyRequests", "Reject lossy shim requests")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.protocolShim.rejectLossyResponses") === true} onChange={(event) => updateField("compatibility.protocolShim.rejectLossyResponses", event.target.checked)} /> {t("field.protocolShimRejectLossyResponses", "Reject lossy shim responses")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.betaAllowlistEnabled") !== false} onChange={(event) => updateField("compatibility.anthropic.betaAllowlistEnabled", event.target.checked)} /> {t("field.anthropicBetaAllowlistEnabled", "Filter Anthropic beta headers")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.normalizeManualThinkingToolChoice") !== false} onChange={(event) => updateField("compatibility.anthropic.normalizeManualThinkingToolChoice", event.target.checked)} /> {t("field.anthropicThinkingToolChoice", "Normalize manual thinking tool choice")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.sanitizeCacheControl") !== false} onChange={(event) => updateField("compatibility.anthropic.sanitizeCacheControl", event.target.checked)} /> {t("field.anthropicCacheControl", "Sanitize Anthropic cache controls")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "compatibility.anthropic.validateThinkingByModel") !== false} onChange={(event) => updateField("compatibility.anthropic.validateThinkingByModel", event.target.checked)} /> {t("field.anthropicThinkingByModel", "Validate thinking mode by model")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.imageGenerations.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.enabled", event.target.checked)} /> {t("field.routeImagesEnabled", "Enable image generations")}</label>
            </div>
          </AccordionSection>
        </div>
      </Section>
    </div>
  );
}