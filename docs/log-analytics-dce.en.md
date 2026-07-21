# Send Proxy Logs to Log Analytics Through a DCE

AOAI Proxy can use the Azure Monitor Logs Ingestion API to send proxy events, correlation IDs, redacted prompt/output content, token usage, and estimated cost to Log Analytics. The feature is disabled by default and does not create Azure Monitor resources for deployments that do not enable it.

## Resource boundary

Create these resources before initialization:

- A Log Analytics workspace.
- A Data Collection Endpoint (DCE) with public network access enabled.
- A proxy runtime identity that can obtain Azure tokens, such as an ACI system-assigned managed identity.

The workspace and DCE must be in the same Azure region. Initialization creates the following resources in the DCE subscription and resource group:

- A custom table, defaulting to `AOAIProxyLogs_CL`.
- A Direct DCR, defaulting to `aoai-proxy-logs`.

The application does not create the workspace, DCE, or role assignments. It also refuses to overwrite an existing DCR that does not carry the AOAI Proxy management tag.

## Permissions

Initialization uses two independent permission sets.

### Management plane

The runtime identity needs at least:

```text
Microsoft.OperationalInsights/workspaces/read
Microsoft.OperationalInsights/workspaces/tables/read
Microsoft.OperationalInsights/workspaces/tables/write
Microsoft.Insights/dataCollectionEndpoints/read
Microsoft.Insights/dataCollectionRules/read
Microsoft.Insights/dataCollectionRules/write
Microsoft.Authorization/permissions/read
```

For a quick setup, assign `Log Analytics Contributor` at workspace scope and `Monitoring Contributor` at the DCE resource-group scope. A production deployment can instead use custom roles containing only the actions above.

### Data ingestion

The runtime identity also needs:

```text
Microsoft.Insights/Telemetry/Write
```

Assign `Monitoring Metrics Publisher` to the identity at the DCE resource-group scope before initialization so the new DCR inherits it:

```bash
az role assignment create \
  --assignee-object-id <managed-identity-principal-id> \
  --assignee-principal-type ServicePrincipal \
  --role "Monitoring Metrics Publisher" \
  --scope <dce-resource-group-resource-id>
```

The built-in role definition ID is `3913510d-42f4-4e42-8a64-420c390055eb`. Alternatively, initialize first, wait for `needs_ingestion_permission`, assign the role directly at the returned DCR scope, and retry.

Management-plane contributor access does not grant `Telemetry/Write`. Azure RBAC changes can take several minutes to propagate.

## Initialize from the admin UI

1. Open **Configuration Workspace > Logging And Log Analytics**.
2. Enter the workspace resource ID and DCE resource ID.
3. Adjust the DCR, table, and input stream names if needed.
4. Select **Initialize And Test**.
5. Review the `resources`, `management_permissions`, `table`, `dcr`, `ingestion_permission`, and `probe` stages.
6. After a successful probe, the workspace ID, endpoint, DCR resource/immutable IDs, and stream are copied into the configuration draft.
7. Use the existing **Save Config** action to enable the sink.

Initialization is idempotent. Existing tables receive only missing columns; type conflicts stop the operation without deleting or rebuilding the table. An existing DCR is updated only when it has the AOAI Proxy management tag and targets the same workspace and DCE.

After upgrading from an earlier version, run **Initialize And Test** again. The current schema v2 incrementally adds `UsageSource`, `UsageEstimated`, and `UsageEstimationReason` and synchronizes the managed DCR; the table does not need to be rebuilt.

A successful Logs Ingestion API response can precede query visibility by a short ingestion delay.

## Content detail

- `Partial`: default. Stores the first 512 redacted characters of requests and outputs plus length, item counts, truncation state, and SHA-256.
- `Full`: stores redacted request and model-output JSON, bounded by `maxPayloadLogBytes`.

Both modes permanently omit authorization values, API keys, passwords, tokens, client secrets, sensitive URL parameters, Base64, data URLs, and image/audio binary data. Streaming responses use a bounded semantic-text collector and never retain raw SSE frames.

## Usage fallback

When a Chat Completions or Responses request does not receive upstream usage, the proxy estimates locally from the semantic input and observed output at approximately 4 UTF-8 bytes/token. This covers a successful response without usage, a partially failed stream, and a client disconnect. Base64, data URLs, images, audio, and file content are excluded.

Estimated usage still reaches governance statistics, the runtime store, and Log Analytics, with explicit metadata:

- `UsageSource = "local_estimate"`
- `UsageEstimated = true`
- `UsageEstimationReason` identifies the trigger

Upstream usage uses `UsageSource = "upstream"`, and each request is recorded only once. Local estimates preserve operational continuity and are not provider billing values. Non-text routes such as image generation do not receive local token estimates.

## Performance and failure bounds

Log Analytics uploads run asynchronously through an in-memory queue; request and response delivery never waits for the DCE. Usage processing, response snapshots, and completion logs for successful responses run after response delivery. Streaming retains only bounded semantic output.

Default safeguards:

| Setting | Default | Behavior |
| --- | ---: | --- |
| `observability.logs.maxBufferBytes` | 16777216 | Admin memory-log byte cap, combined with `bufferSize` |
| `maxQueueSize` | 5000 | Maximum queued record count |
| `maxQueueBytes` | 67108864 | Maximum total queued record bytes |
| `uploadTimeoutMs` | 30000 | Per-SDK-upload deadline; expiration aborts the call |
| `maxUploadRetries` | 3 | Retry attempts for retryable failures, excluding the initial attempt |
| `retryBaseDelayMs` | 1000 | Initial exponential-backoff delay |
| `retryMaxDelayMs` | 30000 | Maximum exponential-backoff delay |

Reaching either queue bound evicts the oldest records; a record larger than the byte cap is dropped immediately. HTTP 408/409/429, 5xx, timeout, and common network failures retry with backoff. Permanent failures do not retry indefinitely. An exhausted batch is dropped without blocking proxy traffic. If the underlying SDK does not settle after abort, the proxy keeps one outstanding call and pauses new uploads while the bounded queue continues accepting logs; a late success removes the corresponding retry records. Runtime reports this as `uploadPendingAfterTimeout = true` and exposes queue bytes, drops, consecutive failures, the next retry, and the latest error. Admin memory logs also use entry and byte bounds so `Full` mode cannot grow the heap without limit.

## Correlation IDs

Supported request headers:

```text
x-request-id
x-conversation-id
x-session-id
x-correlation-id
```

`RequestId` uses `x-request-id`, then the Fastify request ID. `ConversationId` and `SessionId` fall back to each other, then `x-correlation-id`, and finally `RequestId`. All three are top-level Log Analytics columns.

## KQL examples

Trace one request:

```kusto
AOAIProxyLogs_CL
| where RequestId == "<request-id>"
| order by TimeGenerated asc
| project TimeGenerated, Event, Level, ModelId, ActualModelName,
          UsageSource, UsageEstimated, UsageEstimationReason,
          PromptTokens, CompletionTokens, TotalTokens, EstimatedCostAmount,
          RequestPreview, ResponsePreview
```

Aggregate usage and cost by conversation:

```kusto
AOAIProxyLogs_CL
| where Event == "proxy.usage_recorded"
| where ConversationId == "<conversation-id>" or SessionId == "<session-id>"
| summarize Requests=dcount(RequestId),
            EstimatedRequests=dcountif(RequestId, UsageEstimated),
            PromptTokens=sum(PromptTokens),
            CompletionTokens=sum(CompletionTokens),
            EstimatedCost=sum(EstimatedCostAmount)
```

Find the initialization probe:

```kusto
AOAIProxyLogs_CL
| where Event == "loganalytics.initialization_probe"
| where RequestId == "<probe-request-id>"
```

## Manual configuration

If a compatible table and DCR already exist, skip initialization and enter the Logs Ingestion endpoint, DCR immutable ID, stream name, and workspace ID directly. The DCR input schema must match the current Log Analytics column contract emitted by the application.
