import { Field, Section, StatCard } from "./ui.jsx";

export default function OpsTab({
  config,
  updateField,
  caddyStatus,
  aadStatus,
  diagnosticsBusy,
  loadCaddyStatusAction,
  handleVerifyAad,
  handleRestartService,
  caddyPreview,
  formatDateTime,
  logs,
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
  const levelOptions = [
    { key: "warn", label: t("logs.level.warn", "Warn") },
    { key: "error", label: t("logs.level.error", "Error") },
    { key: "info", label: t("logs.level.info", "Info") }
  ];
  const advancedFiltersOpen = Boolean(logFilters.event || logFilters.modelId || logFilters.requestId || logFilters.keyword || Number(logFilters.limit || 100) !== 100);

  return (
    <div className="stack-lg">
      <Section
        id="ops-caddy"
        title={t("ops.caddyTitle", "Caddy / Operations")}
        desc={t("ops.caddyDesc", "Inspect Caddy state, edit reverse-proxy parameters, and run AAD verification or service restart from React.")}
        actions={
          <>
            <button type="button" className="ghost" onClick={() => loadCaddyStatusAction()}>{t("ops.refreshStatus", "Refresh Status")}</button>
            <button type="button" className="ghost" onClick={handleVerifyAad} disabled={diagnosticsBusy.verify}>{diagnosticsBusy.verify ? t("ops.verifyingAad", "Verifying...") : t("ops.verifyAad", "Verify AAD")}</button>
            <button type="button" onClick={handleRestartService} disabled={diagnosticsBusy.restart}>{diagnosticsBusy.restart ? t("ops.restarting", "Restarting...") : t("ops.restart", "Restart")}</button>
          </>
        }
      >
        <div className="status-grid">
          <StatCard label={t("status.caddyState", "Caddy State")} value={caddyStatus?.state ? t(`caddy.state.${caddyStatus.state}`, caddyStatus.state) : t("status.disabled", "disabled")} note={caddyStatus?.message || "-"} />
          <StatCard label={t("status.lastWrite", "Last Write")} value={formatDateTime(caddyStatus?.lastWriteAt)} note={t("status.caddyWriteNote", "Caddyfile write time")} />
          <StatCard label={t("status.lastReload", "Last Reload")} value={formatDateTime(caddyStatus?.lastReloadAt)} note={t("status.caddyReloadNote", "Most recent reload")} />
          <StatCard label={t("status.aad", "AAD")} value={aadStatus?.state ? t(`status.aad.${aadStatus.state}`, aadStatus.state) : t("status.idle", "idle")} note={aadStatus?.detail || formatDateTime(aadStatus?.checkedAt)} />
        </div>
        <div className="form-grid" style={{ marginTop: "1rem" }}>
          <Field label={t("field.enableCaddy", "Enable Caddy")}>
            <select value={config?.server?.caddy?.enabled ? "true" : "false"} onChange={(event) => updateField("server.caddy.enabled", event.target.value === "true")}>
              <option value="true">{t("common.trueLiteral", "true")}</option>
              <option value="false">{t("common.falseLiteral", "false")}</option>
            </select>
          </Field>
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
        {caddyStatus?.lastError ? <div className="inline-error" style={{ marginTop: "1rem" }}>{caddyStatus.lastError}</div> : null}
      </Section>

      <Section
        id="ops-logs"
        title={t("ops.logsTitle", "Runtime Logs")}
        desc={t("ops.logsDesc", "Filter admin / proxy / upstream logs to diagnose governance rejections, timeouts, auth, and upload issues.")}
        actions={<button type="button" onClick={() => loadLogsAction()} disabled={logsLoading}>{logsLoading ? t("ops.loadingLogs", "Loading...") : t("ops.refreshLogs", "Refresh Logs")}</button>}
      >
        <div className="log-controls-react">
          <div className="toolbar">
            {levelOptions.map((item) => (
              <label key={item.key} className="inline">
                <input type="checkbox" checked={logFilters.level.includes(item.key)} onChange={() => toggleLogLevel(item.key)} />
                <span>{item.label}</span>
              </label>
            ))}
            <label className="inline">
              <input type="checkbox" checked={logFilters.autoRefresh} onChange={(event) => setLogFilters((current) => ({ ...current, autoRefresh: event.target.checked }))} />
              <span>{t("ops.autoRefresh", "Auto Refresh")}</span>
            </label>
          </div>
          <div className="muted">{logFilters.autoRefresh ? t("logs.autoRefreshHint.on", "Auto refresh is enabled. The log list updates every 5 seconds.") : t("logs.autoRefreshHint.off", "Auto refresh is disabled. Use Refresh Logs to fetch the latest entries.")}</div>
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
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                  </select>
                </Field>
              </div>
            </div>
          </details>
          <div className="muted">{t("ops.logCount", "Matched {count} log entries{suffix}.", { count: logs.total || 0, suffix: logFilters.autoRefresh ? t("ops.logAutoRefreshSuffix", ", auto refresh enabled") : "" })}</div>
        </div>

        <div className="log-list">
          {logs.items.length ? logs.items.map((entry, index) => {
            const details = getLogDetails(entry);
            const isExpanded = entry.level === "error" || entry.level === "fatal";
            return (
              <article key={`${entry.ts || "log"}-${entry.event || "event"}-${index}`} className={`log-entry level-${entry.level || "info"}`}>
                <div className="log-header-react">
                  <div className="badge-row">
                    <span className={`badge level-${entry.level || "info"}`}>{t(`logs.level.${entry.level || "info"}`, entry.level || "info")}</span>
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
                {Object.keys(details).length ? (
                  <details className="log-details-react" open={isExpanded}>
                    <summary>{t("logs.details", "Details")}</summary>
                    <pre>{JSON.stringify(details, null, 2)}</pre>
                  </details>
                ) : null}
              </article>
            );
          }) : <div className="empty-state">{t("ops.noLogs", "No logs yet. Adjust filters and refresh.")}</div>}
        </div>
      </Section>

      <Section
        id="ops-test"
        title={t("ops.testTitle", "Proxy Test")}
        desc={t("ops.testDesc", "Send requests to proxy endpoints from the admin UI to verify routing, auth, and streaming.")}
        actions={<button type="button" className="ghost" onClick={resetTestPayload}>{t("ops.resetExample", "Reset Example")}</button>}
      >
        <div className="form-grid compact">
          <Field label={t("field.endpointLabel", "Endpoint")}>
            <select value={testEndpoint} onChange={(event) => setTestEndpoint(event.target.value)}>
              {testEndpoints.map((endpoint) => <option key={endpoint} value={endpoint}>{endpoint}</option>)}
            </select>
          </Field>
          <Field label={t("field.apiKey", "API Key")} hint={t("field.apiKeyHint", "Leave blank to follow the current access default policy.")}>
            <input value={testApiKey} onChange={(event) => setTestApiKey(event.target.value)} placeholder={t("field.apiKeyPlaceholder", "proxy API key")} />
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
      </Section>
    </div>
  );
}