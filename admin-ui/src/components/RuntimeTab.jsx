import { Fragment, useState } from "react";
import { AccordionSection, Section, StatCard } from "./ui.jsx";

function formatMoney(amount, currency = "USD", digits = 4) {
  return `${Number(amount || 0).toFixed(digits)} ${currency || "USD"}`;
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
              <th>{t("table.totalTokens", "Total Tokens")}</th>
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
                <td>{row.totalTokens || 0}</td>
                <td>{formatMoney(row.estimatedCostAmount || 0, row.estimatedCostCurrency || "USD")}</td>
              </tr>
            )) : <tr><td colSpan="7">{t("table.noData", "No data yet")}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RuntimeTab({
  persistenceRuntime,
  loggingRuntime,
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
  formatDateTime,
  t
}) {
  const [expandedModels, setExpandedModels] = useState({});
  const visibleGovernanceKeys = runtimeFilters?.keyId
    ? governanceKeys.filter((entry) => entry?.keyId === runtimeFilters.keyId)
    : governanceKeys;
  const modelCount = Object.keys(modelStats).length;
  const observedKeyCount = visibleGovernanceKeys.length;
  const persistenceMode = persistenceRuntime.activeMode || persistenceRuntime.mode || "file";
  const syncState = persistenceRuntime.pendingBlobSync || persistenceRuntime.pendingDatabaseSync ? "pending" : "clean";
  const logSinkState = loggingRuntime.configured ? "configured" : (loggingRuntime.enabled ? "incomplete" : "disabled");
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

  function toggleModelBreakdown(modelId) {
    setExpandedModels((current) => ({
      ...current,
      [modelId]: !current[modelId]
    }));
  }

  return (
    <div className="stack-lg">
      <Section
        id="runtime-overview"
        title={t("runtime.overview", "Runtime Overview")}
        desc={t("runtime.overviewDesc", "Watch persistence health, logging state, active governance activity, and model traffic from one place.")}
        actions={(
          <div className="toolbar-cluster runtime-filter-toolbar">
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
        <div className="panel-summary-grid">
          <StatCard
            label={t("runtime.persistence", "Persistence")}
            value={t(`option.${persistenceMode}`, persistenceMode)}
            note={`${t("runtime.configured", "Configured")} ${t(`option.${persistenceRuntime.mode || "file"}`, persistenceRuntime.mode || "file")}`}
          />
          <StatCard
            label={t("runtime.sync", "Sync")}
            value={t(`status.${syncState}`, syncState)}
            note={persistenceRuntime.configPath || "-"}
          />
          <StatCard
            label={t("runtime.blobDb", "Blob / DB")}
            value={persistenceRuntime.blobAccessState || persistenceRuntime.databaseAccessState || "disabled"}
            note={`${persistenceRuntime.databaseAccessState || "disabled"} / ${persistenceRuntime.blobAccessState || "disabled"}`}
          />
          <StatCard
            label={t("runtime.logSink", "Log Sink")}
            value={t(`status.${logSinkState}`, logSinkState)}
            note={`queue ${loggingRuntime.queueLength ?? 0} / failures ${loggingRuntime.flushFailures ?? 0}`}
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
            note={`${t("table.errors", "Errors")} ${latestHourly.errors || 0} · ${t("table.blockedCount", "Blocked")} ${latestHourly.blockedCount || 0}`}
          />
          <StatCard
            label={t("runtime.rollupDaily", "Latest Day")}
            value={formatMoney(latestDaily.estimatedCostAmount || 0, latestDaily.estimatedCostCurrency || "USD")}
            note={`${t("table.warningCount", "Warnings")} ${latestDaily.warningCount || 0} · ${t("table.totalTokens", "Total Tokens")} ${latestDaily.totalTokens || 0}`}
          />
          <StatCard
            label={t("runtime.rollupWeekly", "Latest Week")}
            value={latestWeekly.requests || 0}
            note={`${t("table.cost", "Estimated Cost")} ${formatMoney(latestWeekly.estimatedCostAmount || 0, latestWeekly.estimatedCostCurrency || "USD")}`}
          />
        </div>
      </Section>

      <AccordionSection id="runtime-persistence" group="runtime-sections" defaultOpen title={t("runtime.title", "Persistence / Logging Runtime")} desc={t("runtime.desc", "Read runtime API directly to inspect file/blob/database state and Log Analytics sink health.")}>
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
                <th>{t("table.totalTokens", "Total Tokens")}</th>
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
                const budgetText = entry.budget?.limitAmount > 0
                  ? `${Number(budgetWindow.spentAmount || 0).toFixed(4)} / ${Number(entry.budget.limitAmount || 0).toFixed(2)} ${entry.budget.currency || "USD"}`
                  : `${Number(budgetWindow.spentAmount || 0).toFixed(4)} ${entry.budget?.currency || "USD"}`;
                return (
                  <tr key={entry.keyId}>
                    <td>{entry.displayName || entry.keyId}</td>
                    <td>{entry.owner || "-"}</td>
                    <td>{perKey.requests || runtimeEntry.totalRequests || 0}</td>
                    <td>{perKey.errors || runtimeEntry.totalErrors || 0}</td>
                    <td>{perKey.totalTokens || runtimeEntry.rateWindow?.totalTokens || 0}</td>
                    <td>{formatMoney(perKey.estimatedCostAmount || budgetWindow.spentAmount || 0, perKey.estimatedCostCurrency || entry.budget?.currency || "USD")}</td>
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
              }) : <tr><td colSpan="12">{t("table.noData", "No data yet")}</td></tr>}
            </tbody>
          </table>
        </div>
      </AccordionSection>

      <AccordionSection id="runtime-models" group="runtime-sections" title={t("runtime.modelStats", "Model Stats")} desc={t("runtime.modelStatsDesc", "Continue consuming the existing stats API in React.")}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("table.model", "Model")}</th>
                <th>{t("table.requests", "Requests")}</th>
                <th>{t("table.errors", "Errors")}</th>
                <th>{t("table.inputTokens", "Input Tokens")}</th>
                <th>{t("table.cachedTokens", "Cached Tokens")}</th>
                <th>{t("table.outputTokens", "Output Tokens")}</th>
                <th>{t("table.totalTokens", "Total Tokens")}</th>
                <th>{t("table.cost", "Estimated Cost")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(modelStats).length ? Object.entries(modelStats).map(([modelId, modelStat]) => {
                const actualModels = Object.entries(modelStat.actualModels || {})
                  .sort((left, right) => (right[1]?.requests || 0) - (left[1]?.requests || 0));
                const expanded = !!expandedModels[modelId];
                const isModelRouter = modelId === "model-router";

                return (
                  <Fragment key={modelId}>
                    <tr>
                      <td>
                        <div className="model-cell">
                          <span>{modelId}</span>
                          {actualModels.length ? (
                            <button
                              type="button"
                              className="table-expander"
                              onClick={() => toggleModelBreakdown(modelId)}
                              aria-expanded={expanded}
                            >
                              {expanded ? t("runtime.collapseBreakdown", "收起") : t("runtime.expandBreakdown", "展开")}
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td>{modelStat.requests || 0}</td>
                      <td>{modelStat.errors || 0}</td>
                      <td>{modelStat.promptTokens || 0}</td>
                      <td>{modelStat.cachedTokens || 0}</td>
                      <td>{modelStat.completionTokens || 0}</td>
                      <td>{modelStat.totalTokens || 0}</td>
                      <td>{formatMoney(modelStat.estimatedCostAmount || 0, modelStat.estimatedCostCurrency || "USD")}</td>
                    </tr>
                    {expanded && actualModels.length ? (
                      <tr className="model-breakdown-row">
                        <td colSpan="8">
                          <div className="model-breakdown">
                            <div className="model-breakdown-title">{t("runtime.actualModelBreakdown", "实际模型明细")}</div>
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>{t("table.actualModel", "实际模型")}</th>
                                    <th>{t("table.requests", "Requests")}</th>
                                    <th>{t("table.errors", "Errors")}</th>
                                    <th>{t("table.inputTokens", "Input Tokens")}</th>
                                    <th>{t("table.cachedTokens", "Cached Tokens")}</th>
                                    <th>{t("table.outputTokens", "Output Tokens")}</th>
                                    <th>{t("table.totalTokens", "Total Tokens")}</th>
                                    {isModelRouter ? <th>{t("table.modelRouterCost", "Model Router Cost")}</th> : null}
                                    {isModelRouter ? <th>{t("table.actualModelCost", "Actual Model Cost")}</th> : null}
                                    <th>{isModelRouter ? t("table.totalCost", "Total Cost") : t("table.cost", "Estimated Cost")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {actualModels.map(([actualModelId, actualStat]) => (
                                    <tr key={actualModelId}>
                                      <td>{actualModelId}</td>
                                      <td>{actualStat.requests || 0}</td>
                                      <td>{actualStat.errors || 0}</td>
                                      <td>{actualStat.promptTokens || 0}</td>
                                      <td>{actualStat.cachedTokens || 0}</td>
                                      <td>{actualStat.completionTokens || 0}</td>
                                      <td>{actualStat.totalTokens || 0}</td>
                                      {isModelRouter ? (
                                        <td>{formatMoney(actualStat.modelRouterCostAmount || 0, actualStat.modelRouterCostCurrency || "USD")}</td>
                                      ) : null}
                                      {isModelRouter ? (
                                        <td>{formatMoney(actualStat.actualModelCostAmount || 0, actualStat.actualModelCostCurrency || "USD")}</td>
                                      ) : null}
                                      <td>{formatMoney(actualStat.estimatedCostAmount || 0, actualStat.estimatedCostCurrency || "USD")}</td>
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
              }) : <tr><td colSpan="8">{t("table.noData", "No data yet")}</td></tr>}
            </tbody>
          </table>
        </div>
      </AccordionSection>
    </div>
  );
}
