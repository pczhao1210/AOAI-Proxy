import { Fragment, useState } from "react";

// [column, min width in px, optional max width in px] per view. Columns without a max stay fixed. Columns with a max
// equal their min up to the baseline viewport and then grow with it, so wide screens show fuller model/route text.
// The summary column has no width and takes the remaining space.
const VIEW_LAYOUTS = {
  requests: [["time", 142], ["outcome", 84], ["requestId", 90], ["model", 108, 200], ["route", 124, 220], ["status", 62], ["latency", 72], ["usage", 124], ["summary"], ["actions", 64]],
  events: [["time", 142], ["level", 70], ["event", 230, 300], ["requestId", 90], ["model", 150, 220], ["summary"], ["actions", 64]],
  access: [["time", 142], ["level", 70], ["event", 160, 220], ["requestId", 90], ["route", 196, 300], ["status", 62], ["latency", 72], ["summary"], ["actions", 64]]
};
const BASELINE_VIEWPORT = 1440;
const SUMMARY_MIN_WIDTH = 180;
const OUTCOME_BADGE = { failed: "level-error", warning: "level-warn", success: "level-info" };
const EMPTY_CELL = <span className="log-cell-empty">—</span>;

function columnWidth(min, max) {
  if (!max) return `${min}px`;
  return `clamp(${min}px, ${((min / BASELINE_VIEWPORT) * 100).toFixed(2)}vw, ${max}px)`;
}

// Drops the year so the time column stays narrow; the full value remains available in the tooltip.
function compactTime(value, formatDateTime) {
  const full = formatDateTime(value);
  const match = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(full);
  return match ? match[1] : full;
}

function rowSeverity(entry, requestView) {
  const value = requestView ? entry.outcome : entry.level;
  if (value === "failed" || value === "error" || value === "fatal") return "error";
  if (value === "warning" || value === "warn") return "warn";
  return "";
}

function methodAndUrl(entry) {
  const method = entry.method || entry.fields?.method || "";
  const url = entry.url || entry.fields?.url || "";
  return `${method} ${url}`.trim();
}

function routeText(entry) {
  if (entry.backendRouteKey && entry.backendRouteKey !== entry.routeKey) return `${entry.routeKey || "-"} → ${entry.backendRouteKey}`;
  return entry.routeKey || methodAndUrl(entry);
}

function usageText(entry) {
  const tokens = entry.totalTokens == null ? "" : Number(entry.totalTokens).toLocaleString();
  const cost = entry.estimatedCostAmount == null ? "" : `${Number(entry.estimatedCostAmount).toFixed(4)} ${entry.currency || ""}`.trim();
  return [tokens, cost].filter(Boolean).join(" · ");
}

function summaryMessage(entry, helpers) {
  const text = helpers.getLogMessage(entry);
  // The message helper falls back to the raw event name, which the Event column already shows.
  return text === "-" || text === entry.event ? "" : text;
}

function iconProps() {
  return { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false };
}

function ChevronIcon() {
  return (
    <svg {...iconProps()} className="log-chevron">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1" />
    </svg>
  );
}

const CELLS = {
  time: ({ entry, helpers }) => (
    <td className="log-cell-time" title={entry.ts || ""}>{compactTime(entry.ts, helpers.formatDateTime)}</td>
  ),
  outcome: ({ entry, helpers: { t } }) => {
    const outcome = entry.outcome || "unknown";
    const fullLabel = t(`logs.outcome.${outcome}`, outcome === "unknown" ? "Pending / Unknown" : outcome);
    const label = outcome === "unknown" ? t("logs.outcome.pending", "Pending") : fullLabel;
    return <td><span className={`badge ${OUTCOME_BADGE[outcome] || ""}`} title={fullLabel}>{label}</span></td>;
  },
  level: ({ entry, helpers: { t } }) => {
    const level = entry.level || "info";
    return <td><span className={`badge level-${level}`}>{t(`logs.level.${level}`, level)}</span></td>;
  },
  event: ({ entry, helpers }) => {
    const label = entry.event ? helpers.getLogEventLabel(entry.event) : "";
    return <td className="log-cell-event" title={entry.event || ""}>{label || EMPTY_CELL}</td>;
  },
  requestId: ({ entry, helpers: { t, onApplyRequestIdFilter } }) => (
    <td>
      {entry.requestId ? (
        <button type="button" className="log-request-id" title={`${t("logs.filterByRequest", "Filter By Request")}: ${entry.requestId}`}
          onClick={() => onApplyRequestIdFilter(entry.requestId)}>
          {entry.requestId}
        </button>
      ) : EMPTY_CELL}
    </td>
  ),
  model: ({ entry }) => <td className="log-cell-model" title={entry.modelId || ""}>{entry.modelId || EMPTY_CELL}</td>,
  route: ({ entry }) => {
    const route = routeText(entry);
    return <td title={route}>{route || EMPTY_CELL}</td>;
  },
  status: ({ entry }) => <td className="log-cell-num">{entry.status ?? EMPTY_CELL}</td>,
  latency: ({ entry }) => <td className="log-cell-num">{entry.latencyMs == null ? EMPTY_CELL : `${entry.latencyMs} ms`}</td>,
  usage: ({ entry }) => {
    const usage = usageText(entry);
    return <td className="log-cell-num" title={usage}>{usage || EMPTY_CELL}</td>;
  },
  summary: ({ entry, helpers }) => {
    const { t, getLogSourceLabel } = helpers;
    const message = summaryMessage(entry, helpers);
    const sourceLabel = entry.source ? getLogSourceLabel(entry.source) : "";
    const tooltip = [sourceLabel, entry.errorCode, message].filter(Boolean).join(" · ");
    return (
      <td className={`log-cell-summary${rowSeverity(entry, helpers.requestView) === "error" ? " is-error" : ""}`} title={tooltip}>
        <div className="log-summary-line">
          {sourceLabel ? <span className="badge">{sourceLabel}</span> : null}
          {entry.occurrences > 1 ? <span className="badge">{t("logs.occurrences", "{count} occurrences", { count: entry.occurrences })}</span> : null}
          {entry.retryCount > 0 ? <span className="badge">{t("logs.retryCount", "{count} retries", { count: entry.retryCount })}</span> : null}
          {entry.errorCode ? <strong className="log-error-code">{entry.errorCode}</strong> : null}
          {message ? <span className="log-summary-text">{message}</span> : null}
        </div>
      </td>
    );
  },
  actions: ({ entry, isExpanded, onToggle, helpers: { t, onCopyLogSummary } }) => {
    const toggleLabel = isExpanded ? t("logs.closeDetails", "Close") : t("logs.details", "Details");
    const copyLabel = t("logs.copySummary", "Copy Summary");
    return (
      <td>
        <div className="log-actions">
          <button type="button" className="ghost log-icon-button" aria-expanded={isExpanded} aria-label={toggleLabel} title={toggleLabel} onClick={onToggle}>
            <ChevronIcon />
          </button>
          <button type="button" className="ghost log-icon-button" aria-label={copyLabel} title={copyLabel} onClick={() => onCopyLogSummary(entry)}>
            <CopyIcon />
          </button>
        </div>
      </td>
    );
  }
};

function LogDetail({ entry, requestView, helpers }) {
  const { t, formatDateTime, getLogDetails, getLogMessage, getLogEventLabel } = helpers;
  const headline = requestView
    ? entry.failureReason || entry.message || t("logs.failureReasonMissing", "Failure reason not recorded.")
    : getLogMessage(entry);
  const meta = [
    [t("logs.meta.time", "Time"), formatDateTime(entry.ts)],
    [null, methodAndUrl(entry)],
    [t("logs.meta.requestId", "Request ID"), entry.requestId],
    [t("logs.meta.azureRequestId", "Azure Request ID"), entry.azureRequestId],
    [t("logs.meta.model", "Model"), entry.modelId],
    [t("logs.meta.route", "Route"), routeText(entry)]
  ].filter(([, value]) => value);
  const payload = entry.events
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
    : getLogDetails(entry);

  return (
    <div className="log-detail">
      <div className="log-detail-headline">{headline}</div>
      <div className="log-detail-meta">
        {meta.map(([label, value]) => <span key={`${label}-${value}`}>{label ? `${label}: ${value}` : value}</span>)}
      </div>
      {requestView ? (
        <>
          <h4>{t("logs.timeline", "Request timeline ({count} events)", { count: (entry.events || []).length })}</h4>
          <div className="log-timeline">
            {(entry.events || []).map((event) => (
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
        </>
      ) : <pre className="log-json">{JSON.stringify(payload, null, 2)}</pre>}
    </div>
  );
}

export default function LogTable({
  view,
  items,
  emptyMessage,
  t,
  formatDateTime,
  getLogDetails,
  getLogMessage,
  getLogEventLabel,
  getLogSourceLabel,
  onApplyRequestIdFilter,
  onCopyLogSummary
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const activeView = VIEW_LAYOUTS[view] ? view : "requests";
  const requestView = activeView === "requests";
  const layout = VIEW_LAYOUTS[activeView];
  const columns = layout.map(([column]) => column);
  const minWidth = SUMMARY_MIN_WIDTH + layout.reduce((sum, [, min = 0]) => sum + min, 0);
  const helpers = { t, requestView, formatDateTime, getLogDetails, getLogMessage, getLogEventLabel, getLogSourceLabel, onApplyRequestIdFilter, onCopyLogSummary };
  const headers = {
    time: t("logs.meta.time", "Time"),
    outcome: t("logs.meta.outcome", "Outcome"),
    level: t("logs.meta.level", "Level"),
    event: t("logs.meta.event", "Event"),
    requestId: t("logs.meta.requestId", "Request ID"),
    model: t("logs.meta.model", "Model"),
    route: t("logs.meta.route", "Route"),
    status: t("logs.meta.status", "Status"),
    latency: t("logs.meta.latency", "Latency"),
    usage: t("logs.meta.usageCost", "Tokens / Cost"),
    summary: t("logs.meta.summary", "Summary")
  };

  function toggle(key) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <div className="log-table-scroll">
      <table className={`log-table log-table-${activeView}`} style={{ minWidth }}>
        <colgroup>
          {layout.map(([column, min, max]) => <col key={column} style={min ? { width: columnWidth(min, max) } : undefined} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              column === "actions"
                ? <th key={column} aria-label={t("logs.details", "Details")} />
                : <th key={column}>{headers[column]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length ? items.map((entry, index) => {
            const key = entry.id ?? `${entry.ts || "log"}-${entry.event || "event"}-${index}`;
            const isExpanded = expanded.has(key);
            const severity = rowSeverity(entry, requestView);
            const context = { entry, isExpanded, onToggle: () => toggle(key), helpers };
            return (
              <Fragment key={key}>
                <tr className={`log-row${severity ? ` severity-${severity}` : ""}${isExpanded ? " is-expanded" : ""}`}>
                  {columns.map((column) => <Fragment key={column}>{CELLS[column](context)}</Fragment>)}
                </tr>
                {isExpanded ? (
                  <tr className="log-row-expanded">
                    <td colSpan={columns.length}>
                      <LogDetail entry={entry} requestView={requestView} helpers={helpers} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          }) : <tr><td className="log-empty-cell" colSpan={columns.length}><div className="empty-state">{emptyMessage}</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}
