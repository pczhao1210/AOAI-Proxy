# Finding channel changes and failures

Open **Operations → Runtime Logs → Channel operations**. Filter by exact connection/channel ID (a binding switch matches both sides), operation ID, public model, request ID, event, or configuration revision. Expand a row for its safe fields. A request-triggered operation can link to the request timeline; a scheduled job has no consumer request ID. `actor: admin` identifies an administrator action, not an individual using shared credentials.

**Instance memory** shows the existing bounded log buffer. **Runtime database** shows only committed `operation` detail rows from the configured PostgreSQL runtime store and retention window. Sources are deliberately separate: the same event has the same `eventUid` in both; do not add their counts. Reads never drain the queue, touch the spool, initialize tables, refresh credentials, or discover models. Check the capture time, cutoff, source and drops. An unavailable database, uninitialized table, delayed write, evicted row or disabled store is not evidence that an action never happened. In `minimum` or file-only mode, no separate audit file is created; use memory and enabled external sinks. Neither logs nor the 12 recoverable configuration versions are permanent audit records.

### Diagnose a change

1. Filter `admin.channel_mappings_changed` to see which deployment and canonical ID changed. `admin.model_exposure_changed` records changes to public models; `admin.key_model_access_changed` records mode, status and grant counts without secrets. At most 16 details per event type per phase are emitted, plus an omitted-count summary. Grant samples contain at most eight IDs per side. Compare the retained history snapshots for the full redacted configuration.
2. For `admin.model_channel_changed`, compare **persisted** (or **loaded** on reload) with **applied**. **apply_failed** describes a candidate, *not* installed routing. Follow the revision and, when available, history ID to configuration history. Resolve the proxy-stage failure and retry the stage; do not save over another draft. Retrying only Caddy cannot change a binding.
3. Use connection ID in the request view for actual traffic. Follow the request ID, actual upstream status, and applied revision rather than assigning a past request to today's selected binding. A successful authorization, refresh, or discovery is not usage and is never a budget event.
4. For authorization failure or revocation, inspect the safe error code, state, expiry if known, and retry time. Reauthorize only the affected connection for a credential failure; investigate entitlement on `403`, honor `Retry-After` on `429`, and do not rotate accounts. For stale discovery, refresh explicitly and review model selections before publishing. Do not copy tokens, device/user codes, full provider errors, or encrypted credentials into tickets.
5. Alert on entry into `proxy.copilot_auth_required`, repeated refresh failures, stale discovery, expired credentials, and credential persistence/lease/CAS failures. Inspect spool/queue drops and sink upload failures in existing runtime diagnostics. Repeated same-class failures may be combined within a one-minute per-connection/profile window; summaries and recoveries report `suppressedFailures` when available. Resolve storage or delivery problems before relying on history; do not edit the live spool.

### API and external logs

`GET <admin-path>/api/logs?view=operations&recordSource=database&connectionId=blue&limit=50` uses the ordinary protected logs API. Use `recordSource=memory` (default) for local records. The database response is a read-only snapshot with `persistence` (`available`, `disabled`, or `unavailable`), `capturedAt`, `retainedSince`, at most 100 newest items, and `hasMore`; it does not scan for a historical total. `droppedEvents` is the sink's cumulative drop count for this instance, not a per-connection count. Older records cannot be reconstructed from current configuration or rollups.

Existing [Log Analytics export](log-analytics-dce.en.md) puts operation context in `FieldsJson`; no new DCR or table is required. For example:

```kusto
AOAIProxyLogs_CL
| where TimeGenerated > ago(24h)
| extend f = parse_json(FieldsJson)
| where tostring(f.connectionId) == "blue" or tostring(f.previousChannelId) == "blue"
| project TimeGenerated, Event, Level, RequestId, ErrorCode,
          operationId=tostring(f.operationId), revision=tostring(f.configRevision),
          outcome=tostring(f.outcome), state=tostring(f.stateAfter)
| order by TimeGenerated asc
```
