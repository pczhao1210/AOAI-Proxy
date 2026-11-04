import { Fragment, useState } from "react";
import { AccordionSection, Field, Section, StatCard } from "./ui.jsx";

export default function OpsTab({
  config,
  updateField,
  pricingLibraryStatus,
  pricingSyncSource,
  setPricingSyncSource,
  pricingLibraryCount,
  modelValidationResult,
  caddyStatus,
  aadStatus,
  diagnosticsBusy,
  handleSyncPricingLibrary,
  handleValidateConfiguredModels,
  loadCaddyStatusAction,
  handleVerifyAad,
  handleRestartService,
  caddyPreview,
  formatDateTime,
  logs,
  loggingRuntime,
  logFilters,
  setLogFilters,
  toggleLogLevel,
  loadLogsAction,
  logsLoading,
  getLogDetails,
  getLogMessage,
  getLogEventLabel,
  getLogSourceLabel,
  onApplyRequestIdFilter,
  onCopyLogSummary,
  testEndpoint,
  setTestEndpoint,
  testApiKey,
  setTestApiKey,
  testPayloadText,
  setTestPayloadText,
  handleSendTestRequest,
  resetTestPayload,
  testResponseText,
  compressionEnabled,
  setCompressionEnabled,
  compressionPreset,
  setCompressionPreset,
  imageFileInfo,
  payloadNote,
  compressionStats,
  onImageFileChange,
  onInsertDataUrlPlaceholder,
  onInsertBase64Placeholder,
  onApplyCompressionConfig,
  testEndpoints,
  getValueByPath,
  t
}) {
  const [expandedLogRequest, setExpandedLogRequest] = useState("");
  const levelOptions = [
    { key: "fatal", label: t("logs.level.fatal", "Fatal") },
    { key: "error", label: t("logs.level.error", "Error") },
    { key: "warn", label: t("logs.level.warn", "Warn") },
    { key: "info", label: t("logs.level.info", "Info") },
    { key: "debug", label: t("logs.level.debug", "Debug") },
    { key: "trace", label: t("logs.level.trace", "Trace") }
  ];
  const memoryBufferSize = Math.max(1, Number(loggingRuntime?.memoryBufferSize) || 100);
  const requestView = logFilters.view !== "events" && logFilters.view !== "access";
  const logsMatchView = logs.view === (requestView ? "requests" : logFilters.view);
  const logItems = logsMatchView ? logs.items : [];
  const logTotal = logsMatchView ? logs.total : 0;
  const emptyLogsMessage = logsLoading
    ? t("ops.loadingLogs", "Loading...")
    : !logsMatchView
      ? t("logs.viewNotLoaded", "This log view has not loaded. Refresh to retry.")
      : t("ops.noLogs", "No logs yet. Adjust filters and refresh.");
  const advancedFiltersOpen = Boolean(logFilters.event || logFilters.modelId || logFilters.requestId || logFilters.keyword || Number(logFilters.limit || 100) !== 100);
  const pricingRepoLabel = pricingLibraryStatus?.githubOwner && pricingLibraryStatus?.githubRepo
    ? `${pricingLibraryStatus.githubOwner}/${pricingLibraryStatus.githubRepo}`
    : "-";
  const pricingRefLabel = pricingLibraryStatus?.githubRef
    ? `${pricingLibraryStatus.githubPath || "pricing"}@${pricingLibraryStatus.githubRef}`
    : pricingLibraryStatus?.githubPath || "pricing";
  const activeLevelSummary = logFilters.level.length ? logFilters.level.join(" / ") : t("status.disabled", "disabled");
  const latestResponseNote = testResponseText
    ? String(testResponseText).split("\n")[0].slice(0, 96)
    : t("ops.noRequestYet", "No request sent yet.");
  const validationSummary = modelValidationResult?.summary || {};
  const validationValue = modelValidationResult
    ? `${validationSummary.ok || 0} / ${validationSummary.total || 0}`
    : t("status.idle", "idle");
  const validationNote = modelValidationResult
    ? `${t("ops.validationFailed", "Failed")}: ${validationSummary.failed || 0} · ${t("ops.validationWarning", "Warnings")}: ${validationSummary.warning || 0}`
    : t("ops.validationIdle", "No validation run yet.");
  const caddyEnabled = config?.server?.caddy?.enabled === true;

  return (
    <div className="stack-lg">
      <Section
        id="ops-overview"
        title={t("ops.overview", "Operations Overview")}
        desc={t("ops.overviewDesc", "Monitor the active pricing source, service state, log pipeline, and request diagnostics from one place.")}
      >
        <div className="panel-summary-grid">
          <StatCard
            label={t("ops.pricingSource", "Active Source")}
            value={t(`pricing.source.${pricingLibraryStatus?.activeSource || "bundled"}`, pricingLibraryStatus?.activeSource || "bundled")}
            note={pricingLibraryStatus?.definitionCount != null ? `${pricingLibraryStatus.definitionCount} ${t("ops.pricingDefinitionsNote", "Loaded pricing entries")}` : "-"}
          />
          <StatCard
            label={t("status.caddyState", "Caddy State")}
            value={caddyStatus?.state ? t(`caddy.state.${caddyStatus.state}`, caddyStatus.state) : t("status.disabled", "disabled")}
            note={formatDateTime(caddyStatus?.lastReloadAt)}
          />
          <StatCard
            label={t("status.aad", "AAD")}
            value={aadStatus?.state ? t(`status.aad.${aadStatus.state}`, aadStatus.state) : t("status.idle", "idle")}
            note={aadStatus?.detail || formatDateTime(aadStatus?.checkedAt)}
          />
          <StatCard
            label={t("ops.logsTitle", "Runtime Logs")}
            value={logTotal || 0}
            note={`${t("logs.level.info", "Info")}/${t("logs.level.warn", "Warn")}/${t("logs.level.error", "Error")}: ${activeLevelSummary}`}
          />
          <StatCard
            label={t("ops.testTitle", "Proxy Test")}
            value={testEndpoint}
            note={latestResponseNote}
          />
          <StatCard
            label={t("ops.validationTitle", "Configured Models")}
            value={validationValue}
            note={validationNote}
          />
        </div>
      </Section>

      <AccordionSection
        id="ops-model-validation"
        title={t("ops.validationTitle", "Configured Model Validation")}
        desc={t("ops.validationDesc", "Run static and live checks for every configured model so route mismatches, auth issues, 404s, and connect timeouts are visible before client traffic hits them.")}
        defaultOpen
        group="ops-sections"
      >
        <div className="toolbar" style={{ marginBottom: "1rem" }}>
          <button type="button" onClick={handleValidateConfiguredModels} disabled={diagnosticsBusy.modelValidation === true}>
            {diagnosticsBusy.modelValidation === true ? t("ops.validationRunning", "Validating...") : t("ops.validationRun", "Validate Configured Models")}
          </button>
        </div>
        <div className="status-grid">
          <StatCard label={t("ops.validationTotal", "Total")} value={validationSummary.total ?? 0} note={t("ops.validationCheckedAt", "Last Check") + ": " + formatDateTime(modelValidationResult?.checkedAt)} />
          <StatCard label={t("ops.validationOk", "Healthy")} value={validationSummary.ok ?? 0} note={t("ops.validationStaticProbe", "Static + probe checks")} />
          <StatCard label={t("ops.validationWarning", "Warnings")} value={validationSummary.warning ?? 0} note={t("ops.validationWarningDesc", "Reachable but not fully clean")} />
          <StatCard label={t("ops.validationFailed", "Failed")} value={validationSummary.failed ?? 0} note={t("ops.validationFailedDesc", "Needs config or network fix")} />
        </div>
        <div className="code-block" style={{ marginTop: "1rem" }}>
          <div className="code-block-head">{t("ops.validationResult", "Validation Result")}</div>
          <pre>{modelValidationResult ? JSON.stringify(modelValidationResult, null, 2) : t("ops.validationIdle", "No validation run yet.")}</pre>
        </div>
      </AccordionSection>

      <AccordionSection
        id="ops-pricing"
        title={t("ops.pricingTitle", "Pricing Library")}
        desc={t("ops.pricingDesc", "Sync pricing JSON files from GitHub into the persistent pricing directory so the admin and runtime use updated prices without rebuilding the container.")}
        defaultOpen
        group="ops-sections"
      >
        <div className="toolbar" style={{ marginBottom: "1rem" }}>
          <button type="button" onClick={handleSyncPricingLibrary} disabled={diagnosticsBusy.pricingSync}>
            {diagnosticsBusy.pricingSync ? t("ops.syncingPricing", "Syncing...") : t("ops.syncPricing", "Sync From GitHub")}
          </button>
        </div>
        <div className="form-grid" style={{ marginBottom: "1rem" }}>
          <Field label={t("ops.pricingRepoOwner", "GitHub Owner")}>
            <input
              value={pricingSyncSource?.owner || ""}
              onChange={(event) => setPricingSyncSource((current) => ({ ...current, owner: event.target.value }))}
              placeholder="pczhao1210"
            />
          </Field>
          <Field label={t("ops.pricingRepoName", "GitHub Repo")}>
            <input
              value={pricingSyncSource?.repo || ""}
              onChange={(event) => setPricingSyncSource((current) => ({ ...current, repo: event.target.value }))}
              placeholder="AOAI-Proxy"
            />
          </Field>
          <Field label={t("ops.pricingRepoPath", "Repo Path")}>
            <input
              value={pricingSyncSource?.path || "pricing"}
              onChange={(event) => setPricingSyncSource((current) => ({ ...current, path: event.target.value }))}
              placeholder="pricing"
            />
          </Field>
          <Field label={t("ops.pricingRepoRef", "Branch / Tag / Commit")}>
            <input
              value={pricingSyncSource?.ref || ""}
              onChange={(event) => setPricingSyncSource((current) => ({ ...current, ref: event.target.value }))}
              placeholder={t("ops.pricingRepoRefAuto", "Leave blank to use the default branch")}
            />
          </Field>
        </div>
        <div className="status-grid">
          <StatCard
            label={t("ops.pricingSource", "Active Source")}
            value={t(`pricing.source.${pricingLibraryStatus?.activeSource || "bundled"}`, pricingLibraryStatus?.activeSource || "bundled")}
            note={pricingLibraryStatus?.activeDir || "-"}
          />
          <StatCard
            label={t("ops.pricingDefinitions", "Definitions")}
            value={pricingLibraryStatus?.definitionCount ?? pricingLibraryCount ?? 0}
            note={t("ops.pricingDefinitionsNote", "Loaded pricing entries")}
          />
          <StatCard
            label={t("ops.pricingRepo", "GitHub Source")}
            value={pricingRepoLabel}
            note={pricingRefLabel || "-"}
          />
          <StatCard
            label={t("ops.pricingLastSync", "Last Sync")}
            value={formatDateTime(pricingLibraryStatus?.lastSyncedAt)}
            note={pricingLibraryStatus?.lastSyncFileCount
              ? t("ops.pricingLastSyncNote", "{count} files synced", { count: pricingLibraryStatus.lastSyncFileCount })
              : t("ops.pricingNoSyncYet", "Not synced yet")}
          />
        </div>
        <div className="muted" style={{ marginTop: "0.75rem" }}>
          {t("ops.pricingPersistDesc", "Successful sync writes pricing files into the data volume first, so Azure Files deployments keep the updated prices across container restarts.")}
        </div>
        <div className="muted" style={{ marginTop: "0.35rem" }}>
          {t("ops.pricingSourceHint", "If you published this project to your own GitHub repository, update owner/repo/path here before syncing.")}
        </div>
      </AccordionSection>

      <AccordionSection
        id="ops-caddy"
        title={t("ops.caddyTitle", "Caddy / Operations")}
        desc={t("ops.caddyDesc", "Inspect Caddy state, edit reverse-proxy parameters, and run AAD verification or service restart from React.")}
        group="ops-sections"
      >
        <div className="toolbar" style={{ marginBottom: "1rem" }}>
          <button type="button" className="ghost" onClick={() => loadCaddyStatusAction()}>{t("ops.refreshStatus", "Refresh Status")}</button>
          <button type="button" className="ghost" onClick={handleVerifyAad} disabled={diagnosticsBusy.verify}>{diagnosticsBusy.verify ? t("ops.verifyingAad", "Verifying...") : t("ops.verifyAad", "Verify AAD")}</button>
          <button type="button" className="ghost danger" onClick={handleRestartService} disabled={diagnosticsBusy.restart}>{diagnosticsBusy.restart ? t("ops.restarting", "Restarting...") : t("ops.restart", "Restart")}</button>
        </div>
        <div className="status-grid">
          <StatCard label={t("status.caddyState", "Caddy State")} value={caddyStatus?.state ? t(`caddy.state.${caddyStatus.state}`, caddyStatus.state) : t("status.disabled", "disabled")} note={caddyStatus?.message || "-"} />
          <StatCard label={t("status.lastWrite", "Last Write")} value={formatDateTime(caddyStatus?.lastWriteAt)} note={t("status.caddyWriteNote", "Caddyfile write time")} />
          <StatCard label={t("status.lastReload", "Last Reload")} value={formatDateTime(caddyStatus?.lastReloadAt)} note={t("status.caddyReloadNote", "Most recent reload")} />
          <StatCard label={t("status.aad", "AAD")} value={aadStatus?.state ? t(`status.aad.${aadStatus.state}`, aadStatus.state) : t("status.idle", "idle")} note={aadStatus?.detail || formatDateTime(aadStatus?.checkedAt)} />
        </div>
        <div className="checkbox-row">
          <label><input type="checkbox" checked={caddyEnabled} onChange={(event) => updateField("server.caddy.enabled", event.target.checked)} /> {t("field.enableCaddy", "Enable Caddy")}</label>
        </div>
        {caddyEnabled ? (
          <>
            <div className="form-grid" style={{ marginTop: "1rem" }}>
              <Field label={t("field.domain", "Domain")}><input value={getValueByPath(config, "server.caddy.domain") || ""} onChange={(event) => updateField("server.caddy.domain", event.target.value)} /></Field>
              <Field label={t("field.email", "Email")}><input value={getValueByPath(config, "server.caddy.email") || ""} onChange={(event) => updateField("server.caddy.email", event.target.value)} /></Field>
              <Field label={t("field.httpsPort", "HTTPS Port")}><input type="number" value={getValueByPath(config, "server.caddy.httpsPort") || 443} onChange={(event) => updateField("server.caddy.httpsPort", Number(event.target.value || 0))} /></Field>
              <Field label={t("field.upstreamHost", "Upstream Host")}><input value={getValueByPath(config, "server.caddy.upstreamHost") || "127.0.0.1"} onChange={(event) => updateField("server.caddy.upstreamHost", event.target.value)} /></Field>
              <Field label={t("field.upstreamPort", "Upstream Port")}><input type="number" value={getValueByPath(config, "server.caddy.upstreamPort") || 3000} onChange={(event) => updateField("server.caddy.upstreamPort", Number(event.target.value || 0))} /></Field>
              <Field label={t("field.dialTimeoutMs", "Dial Timeout ms")}><input type="number" value={getValueByPath(config, "server.caddy.transport.dialTimeoutMs") || 5000} onChange={(event) => updateField("server.caddy.transport.dialTimeoutMs", Number(event.target.value || 0))} /></Field>
              <Field label={t("field.responseHeaderTimeoutMs", "Response Header Timeout ms")}><input type="number" value={getValueByPath(config, "server.caddy.transport.responseHeaderTimeoutMs") || 300000} onChange={(event) => updateField("server.caddy.transport.responseHeaderTimeoutMs", Number(event.target.value || 0))} /></Field>
              <Field label={t("field.keepAliveTimeoutMs", "KeepAlive Timeout ms")}><input type="number" value={getValueByPath(config, "server.caddy.transport.keepAliveTimeoutMs") || 120000} onChange={(event) => updateField("server.caddy.transport.keepAliveTimeoutMs", Number(event.target.value || 0))} /></Field>
            </div>
            <div className="code-block" style={{ marginTop: "1rem" }}>
              <div className="code-block-head">{t("ops.caddyPreview", "Caddy Preview")}</div>
              <pre>{caddyPreview}</pre>
            </div>
          </>
        ) : null}
        {caddyStatus?.lastError ? <div className="inline-error" style={{ marginTop: "1rem" }}>{caddyStatus.lastError}</div> : null}
      </AccordionSection>

      <AccordionSection
        id="ops-logs"
        title={t("ops.logsTitle", "Runtime Logs")}
        desc={t("ops.logsDesc", "Filter admin / proxy / upstream logs to diagnose governance rejections, timeouts, auth, and upload issues.")}
        group="ops-sections"
      >
        <div className="toolbar" style={{ marginBottom: "1rem" }}>
          <button type="button" onClick={() => loadLogsAction()} disabled={logsLoading}>{logsLoading ? t("ops.loadingLogs", "Loading...") : t("ops.refreshLogs", "Refresh Logs")}</button>
        </div>
        <div className="log-controls-react">
          <div className="toolbar">
            <div className="log-view-tabs" role="tablist" aria-label={t("logs.viewLabel", "Log view")}>
              <button type="button" role="tab" aria-selected={requestView} className={requestView ? "selected" : "ghost"}
                onClick={() => setLogFilters((current) => ({ ...current, view: "requests" }))}>
                {t("logs.view.requests", "Requests")}
              </button>
              <button type="button" role="tab" aria-selected={logFilters.view === "events"} className={logFilters.view === "events" ? "selected" : "ghost"}
                onClick={() => setLogFilters((current) => ({ ...current, view: "events" }))}>
                {t("logs.view.events", "System & Cost Events")}
              </button>
              <button type="button" role="tab" aria-selected={logFilters.view === "access"} className={logFilters.view === "access" ? "selected" : "ghost"}
                onClick={() => setLogFilters((current) => ({ ...current, view: "access" }))}>
                {t("logs.view.access", "Access & Auth")}
              </button>
            </div>
            {requestView ? (
              <div className="log-view-tabs" role="group" aria-label={t("logs.outcomeLabel", "Request outcome")}>
                {["all", "failed", "warning", "success", "unknown"].map((outcome) => (
                  <button type="button" key={outcome} className={logFilters.outcome === outcome ? "selected" : "ghost"}
                    aria-pressed={logFilters.outcome === outcome}
                    onClick={() => setLogFilters((current) => ({ ...current, outcome }))}>
                    {t(`logs.outcome.${outcome}`, outcome === "unknown" ? "Pending / Unknown" : outcome)}
                  </button>
                ))}
              </div>
            ) : levelOptions.map((item) => (
              <label key={item.key} className="inline">
                <input type="checkbox" checked={logFilters.level.includes(item.key)} onChange={() => toggleLogLevel(item.key)} />
                <span>{item.label}</span>
              </label>
            ))}
            <label className="inline">
              <input type="checkbox" checked={logFilters.autoRefresh} onChange={(event) => setLogFilters((current) => ({ ...current, autoRefresh: event.target.checked }))} />
              <span>{t("ops.autoRefresh", "Auto Refresh")}</span>
            </label>
            {logFilters.view !== "events" ? (
              <label className="inline">
                <input type="checkbox" checked={logFilters.hideAuthRejected !== false} onChange={(event) => setLogFilters((current) => ({ ...current, hideAuthRejected: event.target.checked }))} />
                <span>{t("ops.hideAuthRejected", "Hide auth rejections")}</span>
              </label>
            ) : null}
          </div>
          {loggingRuntime?.includeAuthRejected === false ? (
            <div className="muted">{t("ops.authRejectedSuppressed", "Requests rejected by authentication are not logged ({count} suppressed since start). Enable them in Workspace log settings.", { count: Number(loggingRuntime?.authRejectedSuppressed) || 0 })}</div>
          ) : null}
          <div className="muted">{logFilters.autoRefresh ? t("logs.autoRefreshHint.on", "Auto refresh is enabled. The log list updates every 5 seconds.") : t("logs.autoRefreshHint.off", "Auto refresh is disabled. Use Refresh Logs to fetch the latest entries.")}</div>
          <div className="muted">{t("field.logLevel", "Log Level")}: {t(`logs.level.${loggingRuntime?.level || "info"}`, loggingRuntime?.level || "info")}</div>
          <details className="log-advanced-react" open={advancedFiltersOpen}>
            <summary>{t("logs.advancedFilters", "More Filters")}</summary>
            <div className="log-advanced-body-react">
              <div className="form-grid compact">
                <Field label={t("field.event", "Event")}><input value={logFilters.event} onChange={(event) => setLogFilters((current) => ({ ...current, event: event.target.value }))} placeholder={t("field.eventPlaceholder", "proxy.request_rejected")} /></Field>
                <Field label={t("field.model", "Model")}><input value={logFilters.modelId} onChange={(event) => setLogFilters((current) => ({ ...current, modelId: event.target.value }))} placeholder={t("field.modelPlaceholder", "gpt-5.4")} /></Field>
                <Field label={t("field.requestId", "Request ID")}><input value={logFilters.requestId} onChange={(event) => setLogFilters((current) => ({ ...current, requestId: event.target.value }))} placeholder={t("field.requestIdPlaceholder", "req-123")} /></Field>
                <Field label={t("field.keyword", "Keyword")}><input value={logFilters.keyword} onChange={(event) => setLogFilters((current) => ({ ...current, keyword: event.target.value }))} placeholder={t("field.keywordPlaceholder", "timeout")} /></Field>
                <Field label={t("field.limit", "Limit")}>
                  <select value={logFilters.limit} onChange={(event) => setLogFilters((current) => ({ ...current, limit: Number(event.target.value || 100) }))}>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                    <option value={200} disabled={memoryBufferSize < 200}>200</option>
                    <option value={500} disabled={memoryBufferSize < 500}>500</option>
                  </select>
                </Field>
              </div>
            </div>
          </details>
          <div className="muted">{t("field.logBufferSize", "Log Buffer Size")}: {memoryBufferSize}</div>
          <div className="muted">
            {t(requestView ? "logs.requestCount" : "ops.logCount", requestView ? "Showing {count} requests from the retained event buffer." : "Matched {count} log entries.", { count: logTotal || 0 })}
            {" "}{t("logs.retainedEvents", "Retained events: {count}", { count: logs.retainedEvents ?? 0 })}
            {logFilters.autoRefresh ? t("ops.logAutoRefreshSuffix", ", auto refresh enabled") : ""}
          </div>
        </div>

        {requestView ? (
          <div className="log-table-scroll">
            <table className="log-request-table">
              <thead>
                <tr>
                  <th>{t("logs.meta.time", "Time")}</th>
                  <th>{t("logs.meta.outcome", "Outcome")}</th>
                  <th>{t("logs.meta.model", "Model / Request")}</th>
                  <th>{t("logs.meta.route", "Route")}</th>
                  <th>{t("logs.meta.status", "Status")}</th>
                  <th>{t("logs.meta.latency", "Latency")}</th>
                  <th>{t("logs.meta.usageCost", "Tokens / Cost")}</th>
                  <th>{t("logs.meta.error", "Error")}</th>
                  <th aria-label={t("logs.details", "Details")} />
                </tr>
              </thead>
              <tbody>
                {logItems.length ? logItems.map((entry) => {
                  const isExpanded = expandedLogRequest === entry.id;
                  const outcome = entry.outcome || "unknown";
                  return (
                    <Fragment key={entry.id}>
                      <tr key={entry.id}>
                        <td title={entry.ts || ""}>{formatDateTime(entry.ts)}</td>
                        <td><span className={`badge ${outcome === "failed" ? "level-error" : outcome === "warning" ? "level-warn" : outcome === "success" ? "level-info" : ""}`}>
                          {t(`logs.outcome.${outcome}`, outcome === "unknown" ? "Pending / Unknown" : outcome)}
                        </span></td>
                        <td>
                          <strong>{entry.modelId || "-"}</strong>
                          <button type="button" className="log-request-id" onClick={() => onApplyRequestIdFilter(entry.requestId)}>{entry.requestId}</button>
                        </td>
                        <td>{entry.backendRouteKey && entry.backendRouteKey !== entry.routeKey
                          ? `${entry.routeKey || "-"} → ${entry.backendRouteKey}`
                          : entry.routeKey || entry.url || "-"}</td>
                        <td>{entry.status ?? "-"}</td>
                        <td>{entry.latencyMs == null ? "-" : `${entry.latencyMs} ms`}</td>
                        <td>{entry.totalTokens == null ? "—" : Number(entry.totalTokens).toLocaleString()}<br />
                          {entry.estimatedCostAmount == null ? "—" : `${Number(entry.estimatedCostAmount).toFixed(4)} ${entry.currency || ""}`}</td>
                        <td className={entry.outcome === "failed" ? "log-request-error" : ""}>
                          {entry.source ? <><span className="badge">{getLogSourceLabel(entry.source)}</span><br /></> : null}
                          {entry.errorCode ? <><strong>{entry.errorCode}</strong><br /></> : null}
                          {entry.retryCount > 0 ? <><span className="badge">{t("logs.retryCount", "{count} retries", { count: entry.retryCount })}</span><br /></> : null}
                          {entry.message || "-"}
                        </td>
                        <td>
                          <button type="button" className="ghost" aria-expanded={isExpanded}
                            onClick={() => setExpandedLogRequest(isExpanded ? "" : entry.id)}>
                            {isExpanded ? t("logs.closeDetails", "Close") : t("logs.details", "Details")}
                          </button>
                          <button type="button" className="ghost" onClick={() => onCopyLogSummary(entry)}>{t("logs.copySummary", "Copy Summary")}</button>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr key={`${entry.id}-details`} className="log-request-expanded">
                          <td colSpan={9}>
                            <div className="log-request-detail">
                              <div className="log-request-detail-summary">
                                <strong>{entry.failureReason || entry.message || t("logs.failureReasonMissing", "Failure reason not recorded.")}</strong>
                                {entry.method || entry.url ? <span>{entry.method} {entry.url}</span> : null}
                                {entry.requestId ? <span>{t("logs.meta.requestId", "Request ID")}: {entry.requestId}</span> : null}
                              </div>
                              <h4>{t("logs.timeline", "Request timeline ({count} events)", { count: entry.events.length })}</h4>
                              <div className="log-timeline">
                                {entry.events.map((event) => (
                                  <details className="log-timeline-event" key={event.id}>
                                    <summary>
                                      <span className={`badge level-${event.level || "info"}`}>{getLogEventLabel(event.event) || event.level}</span>
                                      <span>{getLogMessage(event)}</span>
                                      <time>{formatDateTime(event.ts)}</time>
                                    </summary>
                                    <pre>{JSON.stringify({
                                      source: event.source,
                                      status: event.status,
                                      errorCode: event.errorCode,
                                      failureReason: event.failureReason,
                                      ...getLogDetails(event)
                                    }, null, 2)}</pre>
                                  </details>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                }) : <tr><td colSpan={9}><div className="empty-state">{emptyLogsMessage}</div></td></tr>}
              </tbody>
            </table>
          </div>
        ) : <div className="log-list">
          {logItems.length ? logItems.map((entry, index) => {
            const details = getLogDetails(entry);
            const isExpanded = entry.level === "error" || entry.level === "fatal";
            return (
              <article key={entry.id ?? `${entry.ts || "log"}-${entry.event || "event"}-${index}`} className={`log-entry level-${entry.level || "info"}`}>
                <div className="log-header-react">
                  <div className="badge-row">
                    <span className={`badge level-${entry.level || "info"}`}>{t(`logs.level.${entry.level || "info"}`, entry.level || "info")}</span>
                    {entry.occurrences > 1 ? <span className="badge">{t("logs.occurrences", "{count} occurrences", { count: entry.occurrences })}</span> : null}
                    {entry.event ? <span className="badge">{getLogEventLabel(entry.event)}</span> : null}
                    {entry.source ? <span className="badge">{getLogSourceLabel(entry.source)}</span> : null}
                    {entry.status != null ? <span className="badge">{t("logs.meta.status", "Status")} {entry.status}</span> : null}
                    {entry.errorCode ? <span className="badge">{entry.errorCode}</span> : null}
                  </div>
                  <div className="muted" title={entry.ts || ""}>{formatDateTime(entry.ts)}</div>
                </div>
                {entry.event ? <div className="log-topline-react"><span className="event-label-react">{getLogEventLabel(entry.event)}</span></div> : null}
                <div className="log-message">{getLogMessage(entry)}</div>
                <div className="log-meta-react">
                  {entry.requestId ? <span>{t("logs.meta.requestId", "Request ID")}: {entry.requestId}</span> : null}
                  {entry.azureRequestId ? <span>{t("logs.meta.azureRequestId", "Azure Request ID")}: {entry.azureRequestId}</span> : null}
                  {entry.modelId ? <span>{t("logs.meta.model", "Model")}: {entry.modelId}</span> : null}
                  {entry.routeKey || entry.backendRouteKey ? <span>{t("logs.meta.route", "Route")}: {entry.backendRouteKey && entry.backendRouteKey !== entry.routeKey ? `${entry.routeKey || "-"} -> ${entry.backendRouteKey}` : entry.routeKey || entry.backendRouteKey}</span> : null}
                  {entry.latencyMs != null ? <span>{t("logs.meta.latency", "Latency")}: {entry.latencyMs} ms</span> : null}
                </div>
                <div className="toolbar" style={{ marginTop: "0.85rem" }}>
                  {entry.requestId ? <button type="button" className="ghost" onClick={() => onApplyRequestIdFilter(entry.requestId)}>{t("logs.filterByRequest", "Filter By Request")}</button> : null}
                  <button type="button" className="ghost" onClick={() => onCopyLogSummary(entry)}>{t("logs.copySummary", "Copy Summary")}</button>
                </div>
                {Object.keys(details).length || entry.events?.length > 1 ? (
                  <details className="log-details-react" open={isExpanded}>
                    <summary>{t("logs.details", "Details")}</summary>
                    <pre>{JSON.stringify(entry.events
                      ? entry.events.map((event) => ({
                        ts: event.ts,
                        event: event.event,
                        requestId: event.requestId,
                        status: event.status,
                        errorCode: event.errorCode,
                        source: event.source,
                        failureReason: event.failureReason,
                        message: getLogMessage(event),
                        ...getLogDetails(event)
                      }))
                      : details, null, 2)}</pre>
                  </details>
                ) : null}
              </article>
            );
          }) : <div className="empty-state">{emptyLogsMessage}</div>}
        </div>}
      </AccordionSection>

      <AccordionSection
        id="ops-test"
        title={t("ops.testTitle", "Proxy Test")}
        desc={t("ops.testDesc", "Send requests to proxy endpoints from the admin UI to verify routing, auth, and streaming.")}
        group="ops-sections"
      >
        <div className="toolbar" style={{ marginBottom: "1rem" }}>
          <button type="button" className="ghost" onClick={resetTestPayload}>{t("ops.resetExample", "Reset Example")}</button>
        </div>
        <div className="form-grid compact">
          <Field label={t("field.endpointLabel", "Endpoint")}>
            <select className="endpoint-select" value={testEndpoint} onChange={(event) => setTestEndpoint(event.target.value)}>
              {testEndpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpoint}</option>)}
            </select>
          </Field>
          <Field label={t("field.apiKey", "API Key")} hint={t("field.apiKeyHint", "Leave blank to follow the current access default policy.")}>
            <input type="password" autoComplete="off" value={testApiKey} onChange={(event) => setTestApiKey(event.target.value)} placeholder={t("field.apiKeyPlaceholder", "proxy API key")} />
          </Field>
        </div>
        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <label className="inline">
            <input type="checkbox" checked={compressionEnabled} onChange={(event) => setCompressionEnabled(event.target.checked)} />
            <span>{t("compress.enable", "Enable image compression")}</span>
          </label>
          <div className="field" style={{ minWidth: "240px", flex: "0 0 260px" }}>
            <span>{t("compress.preset", "Compression Preset")}</span>
            <select value={compressionPreset} onChange={(event) => setCompressionPreset(event.target.value)}>
              <option value="light">{t("compress.preset.light", "Light (1600px / 0.85)")}</option>
              <option value="standard">{t("compress.preset.standard", "Standard (1280px / 0.8)")}</option>
              <option value="strong">{t("compress.preset.strong", "Strong (1024px / 0.7)")}</option>
            </select>
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <div className="field" style={{ minWidth: "260px", flex: "0 0 320px" }}>
            <span>{t("compress.file.label", "Image File")}</span>
            <input type="file" accept="image/*" onChange={(event) => onImageFileChange(event.target.files?.[0] || null)} />
          </div>
          <button type="button" className="ghost" onClick={onInsertDataUrlPlaceholder}>{t("compress.placeholder.dataUrl", "Insert __IMAGE_DATA_URL__")}</button>
          <button type="button" className="ghost" onClick={onInsertBase64Placeholder}>{t("compress.placeholder.base64", "Insert __IMAGE_BASE64__")}</button>
          <button type="button" className="ghost" onClick={onApplyCompressionConfig}>{t("compress.apply", "Apply To Config And Save")}</button>
        </div>
        <div className="muted" style={{ marginTop: "0.6rem" }}>{imageFileInfo}</div>
        <div className="muted" style={{ marginTop: "0.35rem" }}>{t("compress.placeholder.note", "Use the placeholder buttons to insert image markers into the payload before selecting a file.")}</div>
        <div className="muted" style={{ marginTop: "0.35rem" }}>{t("compress.note", "When no file is selected, inline image data inside the payload can still be recompressed before the request is sent.")}</div>
        <div className="muted" style={{ marginTop: "0.35rem" }}>{compressionStats}</div>
        <div className="muted" style={{ marginTop: "0.35rem" }}>{payloadNote}</div>
        <Field label={t("field.payload", "Payload")} hint={t("ops.payloadHint", "Set stream to true to test streaming responses.")}>
          <textarea className="json-editor small" rows={14} value={testPayloadText} onChange={(event) => setTestPayloadText(event.target.value)} />
        </Field>
        <div className="toolbar" style={{ marginTop: "1rem" }}>
          <button type="button" onClick={handleSendTestRequest} disabled={diagnosticsBusy.test}>{diagnosticsBusy.test ? t("ops.sending", "Sending...") : t("ops.send", "Send Request")}</button>
        </div>
        <div className="code-block" style={{ marginTop: "1rem" }}>
          <div className="code-block-head">{t("ops.response", "Response")}</div>
          <pre>{testResponseText || t("ops.noRequestYet", "No request sent yet.")}</pre>
        </div>
      </AccordionSection>
    </div>
  );
}