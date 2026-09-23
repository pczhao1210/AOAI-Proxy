import { Fragment, useEffect, useRef, useState } from "react";
import { AccordionSection, Modal, Section, StatCard } from "./ui.jsx";
import { formatBillingTier, formatBudgetCost, formatCacheHitRatio, formatCacheWriteTokens, formatEstimatedCost, formatTokenSummary, getModelBillingRows, runtimeTokenHelp } from "../utils.js";

function TokenHeaders({ t }) {
  const help = runtimeTokenHelp(t);
  return (
    <>
      <th title={help}>{t("table.inputTokensIncludingCache", "Input Total (Including Cache)")}</th>
      <th>{t("table.cacheReadTokens", "Cache Read Tokens")}</th>
      <th>{t("table.cacheWriteTokens", "Cache Write Tokens")}</th>
      <th>{t("table.outputTokens", "Output Tokens")}</th>
      <th title={help}>{t("table.cacheHitRatio", "Cache Hit Ratio")}</th>
    </>
  );
}

function TokenCells({ stats, t }) {
  return (
    <>
      <td>{stats.promptTokens ?? "—"}</td>
      <td>{stats.cachedTokens ?? "—"}</td>
      <td>{formatCacheWriteTokens(stats.cacheWrite, t)}</td>
      <td>{stats.completionTokens ?? "—"}</td>
      <td>{formatCacheHitRatio(stats)}</td>
    </>
  );
}

function getWarningSignalLabel(signalName, t) {
  const mapping = {
    "governance.budget_unmetered_usage": t("runtime.signal.unmetered", "Unmetered Pricing"),
    "governance.budget_soft_limit_reached": t("runtime.signal.softLimit", "Soft Limit Reached"),
    "governance.budget_hard_limit_warning": t("runtime.signal.hardWarn", "Hard Limit Warning")
  };
  return mapping[signalName] || signalName || "-";
}

function getBlockedReasonLabel(reason, t) {
  const mapping = {
    concurrency_limit_exceeded: t("runtime.blocked.concurrency", "Concurrency Limit"),
    rpm_limit_exceeded: t("runtime.blocked.rpm", "RPM Limit"),
    tpm_limit_exceeded: t("runtime.blocked.tpm", "TPM Limit"),
    budget_limit_exceeded: t("runtime.blocked.budget", "Budget Limit")
  };
  return mapping[reason] || reason || "-";
}

function getBudgetSignalBadges(runtimeEntry, t) {
  const budgetWindow = runtimeEntry?.budgetWindow || {};
  const badges = [];
  if (budgetWindow.unmeteredWarningAt) {
    badges.push({ label: t("runtime.signal.unmetered", "Unmetered Pricing"), level: "warn" });
  }
  if (budgetWindow.softLimitReached) {
    badges.push({ label: t("runtime.signal.softLimit", "Soft Limit Reached"), level: "warn" });
  }
  if (budgetWindow.hardLimitWarningAt) {
    badges.push({ label: t("runtime.signal.hardWarn", "Hard Limit Warning"), level: "warn" });
  }
  return badges;
}

function getWarningDetail(entry) {
  const payload = entry?.payload || {};
  const amount = Number(payload.amount);
  const limitAmount = Number(payload.limitAmount);
  const parts = [];
  if (Number.isFinite(amount)) {
    const currency = entry?.currency || "USD";
    if (Number.isFinite(limitAmount) && limitAmount > 0) {
      parts.push(`${amount.toFixed(4)} / ${limitAmount.toFixed(2)} ${currency}`);
    } else {
      parts.push(`${amount.toFixed(4)} ${currency}`);
    }
  }
  if (payload.failureReason) {
    parts.push(String(payload.failureReason));
  }
  return parts.filter(Boolean).join(" · ") || "-";
}

function TrendTable({ title, rows, formatDateTime, t }) {
  return (
    <div className="code-block runtime-mini-panel">
      <div className="code-block-head">{title}</div>
      <div className="table-scroll runtime-compact-table">
        <table>
          <thead>
            <tr>
              <th>{t("table.bucket", "Bucket")}</th>
              <th>{t("table.requests", "Requests")}</th>
              <th>{t("table.errors", "Errors")}</th>
              <th>{t("table.blockedCount", "Blocked")}</th>
              <th>{t("table.warningCount", "Warnings")}</th>
              <TokenHeaders t={t} />
              <th>{t("table.cost", "Estimated Cost")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr key={row.bucketStart}>
                <td>{formatDateTime(row.bucketStart)}</td>
                <td>{row.requests || 0}</td>
                <td>{row.errors || 0}</td>
                <td>{row.blockedCount || 0}</td>
                <td>{row.warningCount || 0}</td>
                <TokenCells stats={row} t={t} />
                <td>{formatEstimatedCost(row, t, row.estimatedCostCurrency)}</td>
              </tr>
            )) : <tr><td colSpan="11">{t("table.noData", "No data yet")}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatDurationMs(ms, t) {
  const numeric = Number(ms);
  if (!Number.isFinite(numeric) || numeric < 0) return "-";
  if (numeric < 1000) return `${numeric}${t("runtime.time.ms", "ms")}`;
  const totalSeconds = Math.ceil(numeric / 1000);
  if (totalSeconds < 60) return `${totalSeconds}${t("runtime.time.sec", "s")}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0
    ? `${minutes}${t("runtime.time.min", "m")} ${seconds}${t("runtime.time.sec", "s")}`
    : `${minutes}${t("runtime.time.min", "m")}`;
}

function formatCountdown(targetValue, nowTs, t) {
  const targetTs = Date.parse(targetValue || "");
  if (Number.isNaN(targetTs)) return t("runtime.countdown.none", "not scheduled");
  const diff = targetTs - nowTs;
  if (diff <= 0) return t("runtime.countdown.now", "now");
  return formatDurationMs(diff, t);
}

export default function RuntimeTab({
  persistenceRuntime,
  loggingRuntime,
  runtimeStore,
  persistenceRuntimeText,
  loggingRuntimeText,
  governanceKeys,
  perKeyStats,
  modelStats,
  analytics,
  recentSignals,
  runtimeFilters,
  runtimeKeyOptions,
  onRuntimeFilterChange,
  onSyncRuntime,
  runtimeSyncBusy,
  onResetModelStats,
  modelStatsResetBusy = false,
  modelsResetAt,
  formatDateTime,
  t
}) {
  const [expandedModels, setExpandedModels] = useState({});
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetFeedback, setResetFeedback] = useState(null);
  const resetPending = useRef(false);
  const isResetBusy = resetBusy || modelStatsResetBusy;
  const [nowTs, setNowTs] = useState(() => Date.now());
  const visibleGovernanceKeys = runtimeFilters?.keyId
    ? governanceKeys.filter((entry) => entry?.keyId === runtimeFilters.keyId)
    : governanceKeys;
  const modelCount = Object.keys(modelStats).length;
  const observedKeyCount = visibleGovernanceKeys.length;
  const persistenceMode = persistenceRuntime.activeMode || persistenceRuntime.mode || "file";
  const syncState = persistenceRuntime.pendingDatabaseSync ? "pending" : "clean";
  const logAnalyticsEnabled = loggingRuntime.logAnalyticsEnabled ?? loggingRuntime.enabled;
  const logAnalyticsConfigured = loggingRuntime.logAnalyticsConfigured ?? loggingRuntime.configured;
  const logSinkState = logAnalyticsConfigured ? "configured" : (logAnalyticsEnabled ? "incomplete" : "disabled");
  const hourlyRollups = Array.isArray(analytics?.rollups?.hourly) ? analytics.rollups.hourly : [];
  const dailyRollups = Array.isArray(analytics?.rollups?.daily) ? analytics.rollups.daily : [];
  const weeklyRollups = Array.isArray(analytics?.rollups?.weekly) ? analytics.rollups.weekly : [];
  const blockedReasons = Array.isArray(analytics?.blockedReasons) ? analytics.blockedReasons : [];
  const warningEvents = Array.isArray(analytics?.warningEvents) ? analytics.warningEvents : [];
  const recentWarnings = Array.isArray(recentSignals?.warnings) ? recentSignals.warnings : [];
  const recentBlocked = Array.isArray(recentSignals?.blocked) ? recentSignals.blocked : [];
  const latestHourly = hourlyRollups[hourlyRollups.length - 1] || {};
  const latestDaily = dailyRollups[dailyRollups.length - 1] || {};
  const latestWeekly = weeklyRollups[weeklyRollups.length - 1] || {};
  const recoveryIntervalText = formatDurationMs(persistenceRuntime.databaseRecoveryIntervalMs, t);
  const runtimeFlushIntervalText = formatDurationMs(runtimeStore.flushIntervalMs, t);
  const nextRecoveryCountdown = formatCountdown(persistenceRuntime.nextDatabaseRecoveryAttemptAt, nowTs, t);
  const nextFlushCountdown = formatCountdown(runtimeStore.nextFlushAt, nowTs, t);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowTs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  function toggleModelBreakdown(modelId) {
    setExpandedModels((current) => ({
      ...current,
      [modelId]: !current[modelId]
    }));
  }

  async function confirmModelStatsReset() {
    if (resetPending.current) return;
    resetPending.current = true;
    setResetBusy(true);
    setResetFeedback(null);
    try {
      await onResetModelStats();
      setExpandedModels({});
      setResetDialogOpen(false);
      setResetFeedback({ success: true, message: t("runtime.modelsResetSuccess", "All model statistics have been reset. Request logs, Key statistics, governance quotas, and global totals were retained.") });
    } catch (error) {
      setResetDialogOpen(false);
      setResetFeedback({ success: false, message: `${t("runtime.modelsResetFailed", "Could not reset model statistics and refresh the view.")} ${error.message || ""}`.trim() });
    } finally {
      resetPending.current = false;
      setResetBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <Section
        id="runtime-overview"
        title={t("runtime.overview", "Runtime Overview")}
        desc={t("runtime.overviewDesc", "Watch persistence health, logging state, active governance activity, and model traffic from one place.")}
        actions={(
          <div className="toolbar-cluster runtime-filter-toolbar">
            <button type="button" className="ghost" onClick={onSyncRuntime} disabled={runtimeSyncBusy}>
              {runtimeSyncBusy
                ? t("runtime.syncNowRunning", "Syncing...")
                : t("runtime.syncNow", "Sync Now")}
            </button>
            <label className="field runtime-filter-field">
              <span className="field-label">{t("runtime.filterKey", "Key")}</span>
              <select value={runtimeFilters?.keyId || ""} onChange={(event) => onRuntimeFilterChange?.({ keyId: event.target.value })}>
                <option value="">{t("option.all", "All")}</option>
                {Array.isArray(runtimeKeyOptions) ? runtimeKeyOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                )) : null}
              </select>
            </label>
            <label className="field runtime-filter-field">
              <span className="field-label">{t("runtime.filterRange", "Time Range")}</span>
              <select value={runtimeFilters?.timeRange || "all"} onChange={(event) => onRuntimeFilterChange?.({ timeRange: event.target.value })}>
                <option value="all">{t("option.all", "All")}</option>
                <option value="24h">{t("option.last24h", "Last 24h")}</option>
                <option value="7d">{t("option.last7d", "Last 7d")}</option>
                <option value="30d">{t("option.last30d", "Last 30d")}</option>
              </select>
            </label>
          </div>
        )}
      >
        <div className="code-block runtime-mini-panel">
          <div className="code-block-head">{t("runtime.syncPlan", "Recovery & Sync")}</div>
          <p className="muted">
            {t("runtime.syncPlanRecovery", "Database recovery probes run every {interval}. Next attempt: {countdown}.", {
              interval: recoveryIntervalText,
              countdown: nextRecoveryCountdown
            })}
          </p>
          <p className="field-hint">
            {t("runtime.syncPlanFlush", "Runtime event flush runs every {interval} while the queue is non-empty. Next flush: {countdown}.", {
              interval: runtimeFlushIntervalText,
              countdown: nextFlushCountdown
            })}
          </p>
          <p className="field-hint">
            {t("runtime.syncPlanManual", "Manual sync triggers an immediate database recovery probe and a runtime queue flush, then the page refreshes the latest stats.")}
          </p>
        </div>
        <div className="panel-summary-grid">
          <StatCard
            label={t("runtime.persistence", "Persistence")}
            value={t(`option.${persistenceMode}`, persistenceMode)}
            note={`${t("runtime.configured", "Configured")} ${t(`option.${persistenceRuntime.mode || "file"}`, persistenceRuntime.mode || "file")}`}
          />
          <StatCard
            label={t("runtime.sync", "Sync")}
            value={t(`status.${syncState}`, syncState)}
            note={t("runtime.nextRecoveryShort", "Next recovery: {countdown}", { countdown: nextRecoveryCountdown })}
          />
          <StatCard
            label={t("runtime.database", "Database")}
            value={persistenceRuntime.databaseAccessState || "disabled"}
            note={`${persistenceRuntime.databaseProvider || "postgresql"} · ${t("runtime.recoveryEvery", "probe every {interval}", { interval: recoveryIntervalText })}`}
          />
          <StatCard
            label={t("runtime.logSink", "Log Sink")}
            value={t(`status.${logSinkState}`, logSinkState)}
            note={t("runtime.logSinkNote", "Queue {count} / {bytes} B · Drops {drops} · Failures {failures}", {
              count: loggingRuntime.queueLength ?? 0,
              bytes: loggingRuntime.queueBytes ?? 0,
              drops: loggingRuntime.droppedEntries ?? 0,
              failures: loggingRuntime.flushFailures ?? 0
            })}
          />
          <StatCard
            label={t("runtime.observedKeys", "Observed Keys")}
            value={observedKeyCount}
            note={t("runtime.observedKeysNote", "Keys with governance runtime data")}
          />
          <StatCard
            label={t("runtime.modelsObserved", "Observed Models")}
            value={modelCount}
            note={t("runtime.modelsObservedNote", "Models with traffic in current stats snapshot")}
          />
          <StatCard
            label={t("runtime.rollupHourly", "Latest Hour")}
            value={latestHourly.requests || 0}
            note={<span title={runtimeTokenHelp(t)}>{`${t("table.errors", "Errors")} ${latestHourly.errors || 0} · ${t("runtime.nextFlushShort", "Next flush: {countdown}", { countdown: nextFlushCountdown })} · ${formatTokenSummary(latestHourly, t)}`}</span>}
          />
          <StatCard
            label={t("runtime.rollupDaily", "Latest Day")}
            value={formatEstimatedCost(latestDaily, t, latestDaily.estimatedCostCurrency)}
            note={<span title={runtimeTokenHelp(t)}>{`${t("table.warningCount", "Warnings")} ${latestDaily.warningCount || 0} · ${formatTokenSummary(latestDaily, t)}`}</span>}
          />
          <StatCard
            label={t("runtime.rollupWeekly", "Latest Week")}
            value={latestWeekly.requests || 0}
            note={<span title={runtimeTokenHelp(t)}>{`${t("table.cost", "Estimated Cost")} ${formatEstimatedCost(latestWeekly, t, latestWeekly.estimatedCostCurrency)} · ${formatTokenSummary(latestWeekly, t)}`}</span>}
          />
        </div>
      </Section>

      <AccordionSection id="runtime-persistence" group="runtime-sections" defaultOpen title={t("runtime.title", "Persistence / Logging Runtime")} desc={t("runtime.desc", "Read runtime API directly to inspect file, Azure Files, and database state plus Log Analytics sink health.")}>
        <div className="detail-grid runtime-detail-grid">
          <div className="code-block">
            <div className="code-block-head">{t("runtime.persistenceDetail", "Persistence Runtime")}</div>
            <pre>{persistenceRuntimeText}</pre>
          </div>
          <div className="code-block">
            <div className="code-block-head">{t("runtime.loggingDetail", "Logging Runtime")}</div>
            <pre>{loggingRuntimeText}</pre>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection id="runtime-analytics" group="runtime-sections" title={t("runtime.analytics", "Historical Rollups")} desc={t("runtime.analyticsDesc", "Database rollups keep hourly, daily, and weekly runtime trends queryable without scanning the full detailed event table.")}>
        <div className="detail-grid runtime-detail-grid runtime-trend-grid">
          <TrendTable title={t("runtime.rollupHourly", "Latest Hour")} rows={hourlyRollups} formatDateTime={formatDateTime} t={t} />
          <TrendTable title={t("runtime.rollupDaily", "Latest Day")} rows={dailyRollups} formatDateTime={formatDateTime} t={t} />
          <TrendTable title={t("runtime.rollupWeekly", "Latest Week")} rows={weeklyRollups} formatDateTime={formatDateTime} t={t} />
        </div>
      </AccordionSection>

      <AccordionSection id="runtime-signals" group="runtime-sections" title={t("runtime.signals", "Budget Warnings & Blocked Reasons")} desc={t("runtime.signalsDesc", "See what is being rejected, what crossed budget thresholds, and the most recent governance signals without opening raw logs.")}>
        <div className="detail-grid runtime-detail-grid">
          <div className="code-block runtime-mini-panel">
            <div className="code-block-head">{t("runtime.blockedReasons", "Blocked Reasons")}</div>
            <div className="table-scroll runtime-compact-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("table.reason", "Reason")}</th>
                    <th>{t("table.blockedCount", "Blocked")}</th>
                    <th>{t("table.lastSeen", "Last Seen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {blockedReasons.length ? blockedReasons.map((item) => (
                    <tr key={item.name}>
                      <td>{getBlockedReasonLabel(item.name, t)}</td>
                      <td>{item.count || 0}</td>
                      <td>{formatDateTime(item.lastOccurredAt)}</td>
                    </tr>
                  )) : <tr><td colSpan="3">{t("table.noData", "No data yet")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="code-block runtime-mini-panel">
            <div className="code-block-head">{t("runtime.warningEvents", "Budget Warning Events")}</div>
            <div className="table-scroll runtime-compact-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("table.signal", "Signal")}</th>
                    <th>{t("table.warningCount", "Warnings")}</th>
                    <th>{t("table.lastSeen", "Last Seen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {warningEvents.length ? warningEvents.map((item) => (
                    <tr key={item.name}>
                      <td>{getWarningSignalLabel(item.name, t)}</td>
                      <td>{item.count || 0}</td>
                      <td>{formatDateTime(item.lastOccurredAt)}</td>
                    </tr>
                  )) : <tr><td colSpan="3">{t("table.noData", "No data yet")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="code-block runtime-mini-panel">
            <div className="code-block-head">{t("runtime.recentWarnings", "Recent Budget Warnings")}</div>
            <div className="table-scroll runtime-compact-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("table.lastSeen", "Last Seen")}</th>
                    <th>{t("table.key", "Key")}</th>
                    <th>{t("table.signal", "Signal")}</th>
                    <th>{t("table.budget", "Budget")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentWarnings.length ? recentWarnings.map((entry) => (
                    <tr key={`${entry.occurredAt}-${entry.requestId}-${entry.signalName}`}>
                      <td>{formatDateTime(entry.occurredAt)}</td>
                      <td>{entry.keyId || "-"}</td>
                      <td>{getWarningSignalLabel(entry.signalName, t)}</td>
                      <td>{getWarningDetail(entry)}</td>
                    </tr>
                  )) : <tr><td colSpan="4">{t("table.noData", "No data yet")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="code-block runtime-mini-panel">
            <div className="code-block-head">{t("runtime.recentBlocked", "Recent Blocked Requests")}</div>
            <div className="table-scroll runtime-compact-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("table.lastSeen", "Last Seen")}</th>
                    <th>{t("table.key", "Key")}</th>
                    <th>{t("table.reason", "Reason")}</th>
                    <th>{t("field.requestId", "Request ID")}</th>
                  </tr>
                </thead>
                <tbody>
                  {recentBlocked.length ? recentBlocked.map((entry) => (
                    <tr key={`${entry.occurredAt}-${entry.requestId}-${entry.blockedReason}`}>
                      <td>{formatDateTime(entry.occurredAt)}</td>
                      <td>{entry.keyId || "-"}</td>
                      <td>{getBlockedReasonLabel(entry.blockedReason, t)}</td>
                      <td>{entry.requestId || "-"}</td>
                    </tr>
                  )) : <tr><td colSpan="4">{t("table.noData", "No data yet")}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection id="runtime-keys" group="runtime-sections" title={t("runtime.keyGovernance", "Key Governance Runtime")} desc={t("runtime.keyGovernanceDesc", "Powered directly by the new governance execution chain.")}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("table.key", "Key")}</th>
                <th>{t("table.owner", "Owner")}</th>
                <th>{t("table.requests", "Requests")}</th>
                <th>{t("table.errors", "Errors")}</th>
                <TokenHeaders t={t} />
                <th>{t("table.cost", "Estimated Cost")}</th>
                <th>{t("table.concurrent", "Concurrency")}</th>
                <th>{t("table.limits", "Limits")}</th>
                <th>{t("table.budget", "Budget")}</th>
                <th>{t("runtime.budgetSignals", "Budget Signals")}</th>
                <th>{t("table.blocked", "Latest Block")}</th>
                <th>{t("table.lastSeen", "Last Seen")}</th>
              </tr>
            </thead>
            <tbody>
              {visibleGovernanceKeys.length ? visibleGovernanceKeys.map((entry) => {
                const runtimeEntry = entry.runtime || {};
                const perKey = perKeyStats[entry.keyId] || {};
                const budgetWindow = runtimeEntry.budgetWindow || {};
                const signalBadges = getBudgetSignalBadges(runtimeEntry, t);
                const budgetText = formatBudgetCost(budgetWindow, entry.budget, t);
                return (
                  <tr key={entry.keyId}>
                    <td>{entry.displayName || entry.keyId}</td>
                    <td>{entry.owner || "-"}</td>
                    <td>{perKey.requests || runtimeEntry.totalRequests || 0}</td>
                    <td>{perKey.errors || runtimeEntry.totalErrors || 0}</td>
                    <TokenCells stats={perKey} t={t} />
                    <td>{formatEstimatedCost({ ...perKey, estimatedCostAmount: perKey.estimatedCostAmount ?? budgetWindow.spentAmount ?? 0, textUnknownCostRequests: perKey.textUnknownCostRequests ?? budgetWindow.textUnknownCostRequests ?? 0 }, t)}</td>
                    <td>{runtimeEntry.currentConcurrent || 0}</td>
                    <td>{`rpm ${entry.rateLimit?.rpm || "-"} / tpm ${entry.rateLimit?.tpm || "-"} / con ${entry.rateLimit?.concurrency || "-"}`}</td>
                    <td>{budgetText}</td>
                    <td>
                      {signalBadges.length ? (
                        <div className="badge-row">
                          {signalBadges.map((badge) => (
                            <span key={badge.label} className={`badge level-${badge.level}`}>{badge.label}</span>
                          ))}
                        </div>
                      ) : "-"}
                    </td>
                    <td>
                      <div className="runtime-cell-stack">
                        <span>{runtimeEntry.lastBlockedReason ? getBlockedReasonLabel(runtimeEntry.lastBlockedReason, t) : "-"}</span>
                        <span className="runtime-cell-note">{runtimeEntry.totalBlockedRequests || 0}</span>
                      </div>
                    </td>
                    <td>{runtimeEntry.lastSeenAt ? formatDateTime(runtimeEntry.lastSeenAt) : "-"}</td>
                  </tr>
                );
              }) : <tr><td colSpan="16">{t("table.noData", "No data yet")}</td></tr>}
            </tbody>
          </table>
        </div>
      </AccordionSection>

      <AccordionSection id="runtime-models" group="runtime-sections" title={t("runtime.modelStats", "Model Stats")} desc={t("runtime.modelStatsDesc", "Continue consuming the existing stats API in React.")}>
        <div className="toolbar">
          <button type="button" className="ghost danger" disabled={isResetBusy || !onResetModelStats} onClick={() => setResetDialogOpen(true)}>
            {isResetBusy ? t("runtime.modelsResetPending", "Resetting model stats…") : t("runtime.modelsReset", "Reset all model stats")}
          </button>
          {modelsResetAt ? <span className="muted">{t("runtime.modelsResetAt", "Model stats reset at")}: {formatDateTime(modelsResetAt)}</span> : null}
        </div>
        {resetFeedback ? <p role={resetFeedback.success ? "status" : "alert"}>{resetFeedback.message}</p> : null}
        <p className="field-hint">{runtimeTokenHelp(t)}</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("table.model", "Model")}</th>
                <th>{t("table.requests", "Requests")}</th>
                <th>{t("table.errors", "Errors")}</th>
                <TokenHeaders t={t} />
                <th>{t("table.cost", "Estimated Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(modelStats).length ? Object.entries(modelStats).map(([modelId, modelStat]) => {
                const billingRows = getModelBillingRows(modelId, modelStat);
                const expanded = !!expandedModels[modelId];

                return (
                  <Fragment key={modelId}>
                    <tr>
                      <td>
                        <div className="model-cell">
                          <span>{modelId}</span>
                          {billingRows.length ? (
                            <button
                              type="button"
                              className="table-expander"
                              onClick={() => toggleModelBreakdown(modelId)}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? t("runtime.collapseBreakdown", "Collapse") : t("runtime.expandBreakdown", "Expand")} ${modelId}`}
                            >
                              {expanded ? t("runtime.collapseBreakdown", "Collapse") : t("runtime.expandBreakdown", "Expand")}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td>{modelStat.requests || 0}</td>
                      <td>{modelStat.errors || 0}</td>
                      <TokenCells stats={modelStat} t={t} />
                      <td>{formatEstimatedCost(modelStat, t, modelStat.estimatedCostCurrency)}</td>
                    </tr>
                    {expanded && billingRows.length ? (
                      <tr className="model-breakdown-row">
                        <td colSpan="9">
                          <div className="model-breakdown">
                            <div className="model-breakdown-title">{t("runtime.actualModelBreakdown", "Actual Model Breakdown")}</div>
                            <p className="field-hint">{t("runtime.billingTierHelp", "Tiers use recorded per-request billing context, not aggregate tokens or current model cards. Settled requests exclude errors; unavailable historical counts are shown as —.")}</p>
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>{t("table.actualModel", "Actual Model")}</th>
                                    <th>{t("table.billingTier", "Billing Tier")}</th>
                                    <th>{t("table.settledRequests", "Settled Requests")}</th>
                                    <TokenHeaders t={t} />
                                    <th>{t("table.cost", "Estimated Cost")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {billingRows.map((actualStat, index) => (
                                    <tr key={`${actualStat.actualModelId}-${actualStat.tier?.id || actualStat.tier?.kind}-${index}`}>
                                      <td>{actualStat.actualModelId}</td>
                                      <td>{formatBillingTier(actualStat.tier, t)}</td>
                                      <td>{Number.isSafeInteger(actualStat.requests) && actualStat.requests >= 0 ? actualStat.requests : "—"}</td>
                                      <TokenCells stats={actualStat} t={t} />
                                      <td>{formatEstimatedCost(actualStat, t, actualStat.estimatedCostCurrency)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              }) : <tr><td colSpan="9">{t("table.noData", "No data yet")}</td></tr>}
            </tbody>
          </table>
        </div>
      </AccordionSection>
      <Modal
        title={t("runtime.modelsReset", "Reset all model stats")}
        isOpen={resetDialogOpen}
        onClose={() => { if (!resetPending.current) setResetDialogOpen(false); }}
        onConfirm={confirmModelStatsReset}
        confirmLabel={isResetBusy ? t("runtime.modelsResetPending", "Resetting model stats…") : t("runtime.modelsResetConfirm", "Reset all models")}
        cancelLabel={t("common.cancel", "Cancel")}
        closeLabel={t("common.close", "Close")}
        disabled={isResetBusy}
      >
        <p>{t("runtime.modelsResetWarning", "Reset statistics for ALL models, including actual-model and billing-tier counts, tokens, and estimated costs? Active Key and time filters do not scope this reset: it always affects all models.")}</p>
        <p>{t("runtime.modelsResetRetained", "Request logs, Key statistics, governance quotas, and global totals are retained. In database mode this reset is persisted. This cannot be undone.")}</p>
      </Modal>
    </div>
  );
}
