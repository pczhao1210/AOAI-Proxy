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

export default function WorkspaceTab({
  config,
  updateField,
  pricingCatalogText,
  updatePricingCatalog,
  pricingCatalogError,
  databaseConfigForm,
  setDatabaseConfigForm,
  databaseTestResult,
  diagnosticsBusy,
  onReloadDatabaseDefaults,
  onTestDatabaseConnection,
  formatDateTime,
  t
}) {
  const databaseResultText = databaseTestResult?.ok
    ? JSON.stringify(databaseTestResult.result || {}, null, 2)
    : (databaseTestResult?.error || "");

  return (
    <div className="stack-lg">
      <Section title={t("workspace.title", "Configuration Workspace")} desc={t("workspace.desc", "Bring persistence, Log Analytics, media, and routing domains into structured editing.")}>
        <div className="stack-lg">
          <AccordionSection id="workspace-core" title={t("workspace.core.title", "Core And Governance Defaults")} desc={t("workspace.core.desc", "Host, admin path, proxy timeouts, API key defaults, and budget defaults.")} defaultOpen group="workspace-sections">
            <div className="form-grid">
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
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "server.trustProxy") === true} onChange={(event) => updateField("server.trustProxy", event.target.checked)} /> {t("field.trustProxy", "Trust Proxy Headers")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "admin.auth.enabled") === true} onChange={(event) => updateField("admin.auth.enabled", event.target.checked)} /> {t("field.enableAdminAuth", "Enable Admin Basic Auth")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "access.defaults.requireApiKey") !== false} onChange={(event) => updateField("access.defaults.requireApiKey", event.target.checked)} /> {t("field.requireApiKey", "Require API Key")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "access.budgets.enabled") === true} onChange={(event) => updateField("access.budgets.enabled", event.target.checked)} /> {t("field.enableBudget", "Enable Budgets")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "admin.features.enableLegacyJsonEditor") !== false} onChange={(event) => updateField("admin.features.enableLegacyJsonEditor", event.target.checked)} /> {t("field.enableAdvancedJson", "Enable Advanced JSON Editor")}</label>
            </div>
            <Field label={t("field.pricingCatalog", "Pricing Catalog")} hint={t("field.pricingCatalogHint", "JSON object. Without pricing data, only tokens are counted and amount remains zero.")}>
              <textarea rows={8} value={pricingCatalogText} onChange={(event) => updatePricingCatalog(event.target.value)} />
            </Field>
            {pricingCatalogError ? <div className="inline-error">{pricingCatalogError}</div> : null}
          </AccordionSection>

          <AccordionSection id="workspace-persistence" title={t("workspace.persistence.title", "Persistence And Cache")} desc={t("workspace.persistence.desc", "Configure file, Azure Files, database, and database+Azure Files persistence modes plus PostgreSQL storage, cache, and compatibility export.")} defaultOpen group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.persistenceMode", "Persistence Mode")}>
                <select value={getValueByPath(config, "persistence.configStore.mode") || "file"} onChange={(event) => updateField("persistence.configStore.mode", event.target.value)}>
                  <option value="file">{t("option.file", "file")}</option>
                  <option value="azureFile">{t("option.azureFile", "azureFile")}</option>
                  <option value="database">{t("option.database", "database")}</option>
                  <option value="database+azureFile">{t("option.database+azureFile", "database+azureFile")}</option>
                </select>
              </Field>
              <Field label={t("field.configFilePath", "Config File Path")}>
                <input value={getValueByPath(config, "persistence.configStore.filePath") || ""} onChange={(event) => updateField("persistence.configStore.filePath", event.target.value)} />
              </Field>
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
              <Field label={t("field.cacheType", "Cache Type")}>
                <select value={getValueByPath(config, "persistence.cache.type") || "memory"} onChange={(event) => updateField("persistence.cache.type", event.target.value)}>
                  <option value="memory">{t("option.memory", "memory")}</option>
                </select>
              </Field>
              <Field label={t("field.cacheTtlMs", "Cache TTL ms")}>
                <input type="number" value={getValueByPath(config, "persistence.cache.ttlMs") || 0} onChange={(event) => updateField("persistence.cache.ttlMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.compatibilityExportPath", "Legacy Config Path")}>
                <input value={getValueByPath(config, "persistence.compatibilityExport.legacyConfigPath") || ""} onChange={(event) => updateField("persistence.compatibilityExport.legacyConfigPath", event.target.value)} />
              </Field>
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.configStore.database.enabled") === true} onChange={(event) => updateField("persistence.configStore.database.enabled", event.target.checked)} /> {t("field.databaseEnabled", "Enable Database Store")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.compatibilityExport.enabled") !== false} onChange={(event) => updateField("persistence.compatibilityExport.enabled", event.target.checked)} /> {t("field.compatibilityExportEnabled", "Enable compatibility export")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "persistence.compatibilityExport.exportLegacyConfigOnChange") !== false} onChange={(event) => updateField("persistence.compatibilityExport.exportLegacyConfigOnChange", event.target.checked)} /> {t("field.compatibilityExportLegacy", "Export legacy config on change")}</label>
            </div>

            <div className="detail-grid runtime-detail-grid">
              <div className="code-block">
                <div className="code-block-head">{t("workspace.databaseProbe.title", "Database Connection Test")}</div>
                <p className="muted">{t("workspace.databaseProbe.desc", "Load the current connection string from environment-backed runtime settings, edit it temporarily, and verify connectivity without saving secrets into config.json.")}</p>
                <div className="form-grid">
                  <Field label={t("field.databaseConnectionString", "Connection String")} hint={t("field.databaseConnectionStringHint", "Defaults come from CONFIG_DB_CONNECTION_STRING, DATABASE_URL, or a configured connectionRef when available.")}>
                    <textarea rows={4} value={databaseConfigForm?.connectionString || ""} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "connectionString", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseConnectionRefResolved", "Resolved Connection Ref") }>
                    <input value={databaseConfigForm?.connectionRef || ""} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "connectionRef", event.target.value)} />
                  </Field>
                  <Field label={t("field.databaseProvider", "Database Provider")}>
                    <input value={databaseConfigForm?.provider || "postgresql"} onChange={(event) => updateDatabaseForm(setDatabaseConfigForm, "provider", event.target.value)} />
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
                <div className="toolbar">
                  <button type="button" className="ghost" onClick={onReloadDatabaseDefaults} disabled={diagnosticsBusy?.databaseDefaults === true || diagnosticsBusy?.databaseTest === true}>
                    {diagnosticsBusy?.databaseDefaults === true ? t("common.loading", "Loading...") : t("workspace.databaseProbe.reload", "Load Runtime Defaults")}
                  </button>
                  <button type="button" onClick={onTestDatabaseConnection} disabled={diagnosticsBusy?.databaseTest === true}>
                    {diagnosticsBusy?.databaseTest === true ? t("workspace.databaseProbe.testing", "Testing...") : t("workspace.databaseProbe.test", "Test Connection")}
                  </button>
                </div>
                {databaseTestResult ? (
                  <div className="stack-sm" style={{ marginTop: "1rem" }}>
                    <div className={databaseTestResult.ok ? "muted" : "inline-error"}>
                      {databaseTestResult.ok
                        ? t("workspace.databaseProbe.ok", "Connection succeeded at {time}.", { time: formatDateTime(databaseTestResult.checkedAt) })
                        : t("workspace.databaseProbe.failed", "Connection failed at {time}.", { time: formatDateTime(databaseTestResult.checkedAt) })}
                    </div>
                    <pre>{databaseResultText}</pre>
                  </div>
                ) : null}
              </div>
            </div>
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
              <Field label={t("field.logMessageContentMode", "Message Content Mode")}>
                <select value={getValueByPath(config, "observability.logs.messageContentMode") || "summary"} onChange={(event) => updateField("observability.logs.messageContentMode", event.target.value)}>
                  <option value="summary">{t("option.summary", "summary")}</option>
                  <option value="full">{t("option.full", "full")}</option>
                </select>
              </Field>
              <Field label={t("field.logMaxPayloadBytes", "Max Payload Log Bytes")}>
                <input type="number" value={getValueByPath(config, "observability.logs.maxPayloadLogBytes") || 0} onChange={(event) => updateField("observability.logs.maxPayloadLogBytes", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.logMaxBase64Chars", "Max Base64 Log Chars")}>
                <input type="number" value={getValueByPath(config, "observability.logs.maxBase64LogChars") || 0} onChange={(event) => updateField("observability.logs.maxBase64LogChars", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.workspaceId", "Workspace ID")}>
                <input value={getValueByPath(config, "observability.logAnalytics.workspaceId") || ""} onChange={(event) => updateField("observability.logAnalytics.workspaceId", event.target.value)} />
              </Field>
              <Field label={t("field.endpoint", "Logs Ingestion Endpoint")}>
                <input value={getValueByPath(config, "observability.logAnalytics.endpoint") || ""} onChange={(event) => updateField("observability.logAnalytics.endpoint", event.target.value)} />
              </Field>
              <Field label={t("field.dcrImmutableId", "DCR Immutable ID")}>
                <input value={getValueByPath(config, "observability.logAnalytics.dcrImmutableId") || ""} onChange={(event) => updateField("observability.logAnalytics.dcrImmutableId", event.target.value)} />
              </Field>
              <Field label={t("field.streamName", "Stream Name")}>
                <input value={getValueByPath(config, "observability.logAnalytics.streamName") || ""} onChange={(event) => updateField("observability.logAnalytics.streamName", event.target.value)} />
              </Field>
              <Field label={t("field.audience", "Audience")}>
                <input value={getValueByPath(config, "observability.logAnalytics.audience") || ""} onChange={(event) => updateField("observability.logAnalytics.audience", event.target.value)} />
              </Field>
              <Field label={t("field.credentialRef", "Credential Ref")}>
                <input value={getValueByPath(config, "observability.logAnalytics.credentialRef") || ""} onChange={(event) => updateField("observability.logAnalytics.credentialRef", event.target.value)} />
              </Field>
              <Field label={t("field.tableName", "Table Name")}>
                <input value={getValueByPath(config, "observability.logAnalytics.tableName") || "AOAIProxyLogs"} onChange={(event) => updateField("observability.logAnalytics.tableName", event.target.value)} />
              </Field>
              <Field label={t("field.flushIntervalMs", "Flush Interval ms")}>
                <input type="number" value={getValueByPath(config, "observability.logAnalytics.flushIntervalMs") || 0} onChange={(event) => updateField("observability.logAnalytics.flushIntervalMs", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.batchSize", "Batch Size")}>
                <input type="number" value={getValueByPath(config, "observability.logAnalytics.batchSize") || 0} onChange={(event) => updateField("observability.logAnalytics.batchSize", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.samplingRatio", "Sampling Ratio")}>
                <input type="number" step="0.1" min="0" max="1" value={getValueByPath(config, "observability.logAnalytics.samplingRatio") || 0} onChange={(event) => updateField("observability.logAnalytics.samplingRatio", Number(event.target.value || 0))} />
              </Field>
              <Field label={t("field.maxConcurrency", "Max Concurrency")}>
                <input type="number" value={getValueByPath(config, "observability.logAnalytics.maxConcurrency") || 0} onChange={(event) => updateField("observability.logAnalytics.maxConcurrency", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.maxQueueSize", "Max Queue Size")}>
                <input type="number" value={getValueByPath(config, "observability.logAnalytics.maxQueueSize") || 0} onChange={(event) => updateField("observability.logAnalytics.maxQueueSize", asNumber(event.target.value))} />
              </Field>
            </div>
            <div className="checkbox-row">
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeClientIp") === true} onChange={(event) => updateField("observability.logs.includeClientIp", event.target.checked)} /> {t("field.includeClientIp", "Include Client IP")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeUsage") === true} onChange={(event) => updateField("observability.logs.includeUsage", event.target.checked)} /> {t("field.includeUsage", "Include Usage")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.includeHeaders") === true} onChange={(event) => updateField("observability.logs.includeHeaders", event.target.checked)} /> {t("field.includeHeaders", "Include Headers")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.redactSecrets") !== false} onChange={(event) => updateField("observability.logs.redactSecrets", event.target.checked)} /> {t("field.redactSecrets", "Redact Secrets")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logs.redactApiKeyInfo") !== false} onChange={(event) => updateField("observability.logs.redactApiKeyInfo", event.target.checked)} /> {t("field.redactApiKeyInfo", "Redact API Key Info")}</label>
              <label><input type="checkbox" checked={getValueByPath(config, "observability.logAnalytics.enabled") === true} onChange={(event) => updateField("observability.logAnalytics.enabled", event.target.checked)} /> {t("field.logAnalyticsEnabled", "Enable Log Analytics Sink")}</label>
            </div>
          </AccordionSection>

          <AccordionSection id="workspace-media" title={t("workspace.media.title", "Media Policy")} desc={t("workspace.media.desc", "Control input compression, remote images, inline images, and image generation defaults.") } group="workspace-sections">
            <div className="form-grid">
              <Field label={t("field.mediaMaxLongSide", "Max Long Side px")}>
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
              </Field>
              <Field label={t("field.remoteImagesMaxMb", "Remote Download Limit MB")}>
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
              </Field>
              <Field label={t("field.inlineImagesMaxBase64", "Inline Max Base64 Bytes")}>
                <input type="number" value={getValueByPath(config, "media.inlineImages.maxBase64Bytes") || 0} onChange={(event) => updateField("media.inlineImages.maxBase64Bytes", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.inlineImagesPreview", "Inline Log Preview Chars")}>
                <input type="number" value={getValueByPath(config, "media.inlineImages.logPreviewChars") || 0} onChange={(event) => updateField("media.inlineImages.logPreviewChars", asNumber(event.target.value))} />
              </Field>
              <Field label={t("field.mediaGenerationDefaultModel", "Default Generation Model")}>
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
              </Field>
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
              <label><input type="checkbox" checked={getValueByPath(config, "routing.routeProfiles.imageGenerations.enabled") !== false} onChange={(event) => updateField("routing.routeProfiles.imageGenerations.enabled", event.target.checked)} /> {t("field.routeImagesEnabled", "Enable image generations")}</label>
            </div>
          </AccordionSection>
        </div>
      </Section>
    </div>
  );
}