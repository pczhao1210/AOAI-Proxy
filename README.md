# AOAI Foundry Proxy

> OpenAI-compatible reverse proxy for Azure AI Foundry / Azure OpenAI with SSE streaming, configurable Caddy TLS, and deployment-selectable persistence.

[English](README.md) | [简体中文](docs/README.zh-CN.md) | [Docs Index](docs/README.md) | [Git Workflow（中文）](GIT_WORKFLOW.zh-CN.md)

## Branch Guidance

> **Need only the core proxy features?** This default branch tracks the nextgen experience with richer admin/runtime features and expanded deployment options. For a smaller, stable core-function build, jump to the [`aoai-minimum` branch](https://github.com/pczhao1210/AOAI-Proxy/tree/aoai-minimum) or read [`aoai-minimum/README.md`](https://github.com/pczhao1210/AOAI-Proxy/blob/aoai-minimum/README.md).

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Faoai-nextgen%2Finfra%2Fazuredeploy.json)

## Overview

- OpenAI-compatible proxy for `chat/completions`, `responses`, `images/generations`, and `models`
- Client -> Proxy uses API key auth via `Authorization: Bearer` or `x-api-key`
- Proxy -> Azure AI Foundry / Azure OpenAI uses AAD tokens or `api-key`, based on `auth.mode`
- Static admin page for config editing, AAD verification, model usage stats, and recent log inspection
- Model-level route overrides via `models[].routes` and upstream route maps via `upstreams[].routes`

## Deployment Assets

- Bicep template: [infra/main.bicep](infra/main.bicep)
- ARM template for portal deployment: [infra/azuredeploy.json](infra/azuredeploy.json)
- Portal UI definition for managed app / custom portal packaging: [infra/createUiDefinition.json](infra/createUiDefinition.json)
- Azure Managed Application package source: [infra/azure_deployment_with_UI](infra/azure_deployment_with_UI)
- Example parameters: [infra/parameters/dev.json](infra/parameters/dev.json), [infra/parameters/prod.json](infra/parameters/prod.json)

The Deploy to Azure button targets the ARM JSON template because the portal button flow does not deploy remote Bicep files directly.
The standard raw-template Deploy to Azure button does not automatically use `createUiDefinition.json`; that file is intended for portal packaging flows that support a custom create experience.
The deployment templates now distinguish between `new` and `existing` storage/database resources so policy-restricted environments can reuse pre-provisioned Azure Files or PostgreSQL resources instead of forcing resource creation.

## Persistence Modes

This repo now supports deployment-time persistence selection, and the Azure deployment templates default to `database+azureFile`.

### `database+azureFile`

- Default mode for the Bicep, ARM, and portal UI flows
- Stores proxy configuration in Azure Database for PostgreSQL while also mounting `/app/data` from Azure Files
- Keeps generated Caddyfile, ACME certificates, pricing sync output, and other `/app/data` artifacts durable across container replacement
- The deployment flow can create or reuse both PostgreSQL and storage resources
- Best fit for ACI deployments that need durable config plus durable filesystem state

### `database`

- Keeps PostgreSQL-backed config persistence without creating or mounting Azure Files
- Creates Azure Database for PostgreSQL Flexible Server and injects the connection string as a secure environment variable
- The deployment flow can create new PostgreSQL resources or point to an existing server/database
- If `databaseName` is empty in the Azure templates, the deployment auto-creates `aoaiproxy`
- The application auto-creates the schema, table, and config row inside that database on first use
- Persists proxy configuration, but does not turn `/app/data` into a persistent volume
- In pure `database` mode, local cache files, generated Caddyfile, ACME certificates, and Caddy state remain container-local and are therefore ephemeral across container replacement

### `azureFile`

- Keeps the ACI + Azure Files mount at `/app/data`
- Best fit when filesystem-style persistence is needed for config, Caddyfile, and Caddy state
- The deployment flow can create new storage/share resources or reuse existing ones
- The deployment UI accepts an optional Azure Files storage account key; supplying it skips the deployment-time `listKeys` call
- If no key is supplied, the template falls back to `listKeys` for the ACI mount

How the Azure Files credential path works:

- Bicep/ARM parameter name: `azureFileStorageAccountKey`
- Portal managed-app UI: optional password field `Azure Files storage account key`
- A supplied value is passed directly into the ACI Azure Files volume definition
- Without a supplied value, the deployment identity must be able to call `listKeys`
- Supplying a key does not remove ACI's shared-key requirement at mount time
- When an existing share is selected, `fileShareName` must already exist

### Deployment Constraint

ACI native Azure Files mounting still depends on shared key authentication. Managed identity for app-level Azure access does not convert Azure Files volume mounting into an AAD-only flow. If you must disable key-based auth and still need `/app/data` mount semantics, move to another platform such as ACA, AKS, or a VM-based deployment.

Practical implication:

- Manual key input avoids a deployment-time `listKeys` dependency
- It does not eliminate the storage-account-key dependency of the ACI mount itself
- If shared-key access is disabled, neither the manual-key path nor automatic `listKeys` is suitable for ACI Azure Files mounting

## Timeout Model

The proxy now uses a more conservative long-response baseline that is better suited for tool-calling and MCP-style workflows.

```json
{
"server": {
  "gracefulShutdownMs": 30000,
  "caddy": {
    "transport": {
      "dialTimeoutMs": 5000,
      "responseHeaderTimeoutMs": 1260000,
      "keepAliveTimeoutMs": 120000
    }
  }
},
"proxy": {
  "timeouts": {
    "connectMs": 10000,
    "requestMs": 900000,
    "firstByteMs": 300000,
    "idleMs": 300000,
    "maxStreamDurationMs": 3600000
  },
  "retries": {
    "maxRetries": 0,
    "baseDelayMs": 800,
    "maxDelayMs": 8000
  },
  "httpClient": {
    "connections": 32,
    "keepAliveTimeoutMs": 60000,
    "keepAliveMaxTimeoutMs": 300000,
    "headersTimeoutMs": 330000,
    "bodyTimeoutMs": 0,
    "pipelining": 1
  }
},
"access": {
  "rateLimits": {
    "windowSeconds": 60,
    "defaultRpm": 60,
    "defaultTpm": 0,
    "defaultConcurrency": 8
  }
}
}
```

Guidance:

- `connectMs` limits upstream TCP/TLS connection establishment; Caddy `dialTimeoutMs` covers only the local Caddy-to-Node hop.
- `firstByteMs` bounds upstream response headers and the initial stream chunk. `headersTimeoutMs` includes a small margin above it.
- `requestMs` bounds reading/parsing a non-stream response body after upstream headers arrive. `idleMs` bounds the gap between streaming chunks.
- `bodyTimeoutMs` is `0` so Undici does not preempt the proxy's route-aware request and idle timers.
- Caddy waits for Node to produce downstream headers. Its `responseHeaderTimeoutMs` covers `firstByteMs + requestMs` plus margin.
- `maxStreamDurationMs` is a hard one-hour ceiling. Set it to `0` only when deliberately allowing unbounded streams.
- Keep `maxRetries` at `0` for tool-calling or other potentially side-effecting requests.
- Per-key rate-limit values of `0` inherit `access.rateLimits` defaults. A global value of `0` means unlimited for that dimension.

## Local Run

1. Copy the sample config:
   - `cp config/sample_config.json config/config.json`
2. Edit `config/config.json`:
   - Replace `upstreams[].baseUrl` with your Foundry or Azure OpenAI endpoint
   - Set `models[].targetModel` to the deployment identifier
  - Choose upstream auth:
    - `auth.mode = "servicePrincipal"` with `scope`, plus service principal fields or managed identity
    - `auth.mode = "apiKey"` with `auth.apiKey`
   - Replace the default API key and admin credentials
3. Install dependencies and start:
   - `npm install`
  - Set `AOAI_PROXY_ADMIN_PASSWORD` and `AOAI_PROXY_API_KEY` to strong, unique secrets when `server.host` is not loopback
   - `npm run start`

Non-loopback listeners fail closed when admin authentication is disabled or known placeholder credentials are active. `ALLOW_INSECURE_PUBLIC_ADMIN=true` is an explicit compatibility escape hatch and is not recommended for normal deployments.

## Environment Variables

### General

- `CONFIG_PATH`: local cached config path, default `./config/config.json`
- `BODY_LIMIT`: request body limit in bytes, default `52428800`
- `CADDY_BIN`: optional Caddy binary path override
- `SHUTDOWN_TIMEOUT_MS`: optional graceful-shutdown deadline override; otherwise `server.gracefulShutdownMs` is used
- `ADMIN_LOG_BUFFER_SIZE`: in-memory admin log ring buffer size, default and hard maximum `100`
- `PRICING_DIR`: optional pricing library directory override. By default the app reads from `/app/data/pricing` when synced files exist, otherwise it falls back to the bundled `pricing/` directory inside the image.
- `AOAI_PROXY_ADMIN_USERNAME`: admin Basic Auth username, defaulting to the configured username
- `AOAI_PROXY_ADMIN_PASSWORD`: admin Basic Auth password; setting it also enables admin authentication unless explicitly disabled
- `AOAI_PROXY_API_KEY`: replaces the configured default client API key
- `AOAI_PROXY_UPSTREAM_API_KEY`: overrides `auth.apiKey` for upstream API-key authentication
- `AOAI_PROXY_CADDY_ENABLED`, `AOAI_PROXY_CADDY_DOMAIN`, `AOAI_PROXY_CADDY_EMAIL`: Caddy HTTPS overrides
- `AOAI_PROXY_TRUST_PROXY`: trust proxy-appended forwarding headers; enable only when Node is reachable exclusively through the trusted reverse proxy
- `ALLOW_INSECURE_PUBLIC_ADMIN`: explicit opt-out from non-loopback credential checks; avoid in production

### Pricing Sync

- `PRICING_SYNC_GITHUB_OWNER`: GitHub owner for pricing sync, default `pczhao1210`
- `PRICING_SYNC_GITHUB_REPO`: GitHub repository for pricing sync, default `AOAI-Proxy`
- `PRICING_SYNC_GITHUB_PATH`: repository path containing pricing JSON files, default `pricing`
- `PRICING_SYNC_GITHUB_REF`: optional branch, tag, or commit. When omitted, the proxy resolves the repository default branch through the GitHub API.
- `PRICING_SYNC_GITHUB_TOKEN`: optional GitHub token for higher API limits or private repositories

The admin Operations page can override owner, repo, path, and ref per sync request. Successful syncs persist the selected GitHub source into pricing sync metadata so the same source shows up on the next load.

When you trigger `Sync From GitHub` from `/admin`, the proxy downloads pricing JSON files into the persistent pricing directory first. In Azure Files-style deployments, this means updated prices survive container replacement without rebuilding the image.

### Optional Upstream Pool Overrides

Config file values under `server.upstream.pool` are primary. These environment variables can still override them when needed:

- `UPSTREAM_MAX_CONNECTIONS`
- `UPSTREAM_KEEPALIVE_TIMEOUT_MS`
- `UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS`
- `UPSTREAM_HEADERS_TIMEOUT_MS`
- `UPSTREAM_BODY_TIMEOUT_MS`
- `UPSTREAM_PIPELINING`

### Persistence Selection

- `PERSISTENCE_MODE=database|database+azureFile|azureFile`
- `CONFIG_DB_CONNECTION_STRING` or `DATABASE_URL` for `database` and `database+azureFile` modes

In `database` mode, the app reads configuration from PostgreSQL first and keeps a local cache for restart bootstrap and degraded-mode fallback.

In `database+azureFile` mode, the app still reads configuration from PostgreSQL first, but it also expects `/app/data` to be mounted from Azure Files so Caddy state and other filesystem artifacts survive container replacement.

## Admin Page

Open `/admin` to manage config.

The admin page now exposes:

- Top-level status cards for proxy health, AAD verification status, config state, and runtime state
- Config dirty-state badges, basic structure reminders, and a local diff preview before save
- A pricing library sync panel that can pull the latest pricing JSON files from GitHub into the persistent data volume
- Caddy dial timeout
- Caddy response header timeout
- Caddy keepalive timeout
- Runtime persistence summary so you can see which config mode and data directory mode are active
- Recent logs with level filters (`warn`, `error`, optional `info`), keyword search, request-id filtering, and copy-summary actions

The log panel uses a compact always-visible toolbar plus collapsible advanced filters instead of a sticky filter bar.

### Admin Login

Controlled by `server.adminAuth`. When enabled, it protects `/admin` and `/admin/api/*` with HTTP Basic auth.

## Stats Notes

- Stats are in-memory only; restart resets counters
- `usage` is collected from non-stream JSON responses and streaming SSE usage events
- Cached token fields from upstream are counted when present
- The proxy preserves `stream_options` for streaming `chat/completions` and `responses` requests, and strips it for other routes where Foundry v1 may reject it

## Log Notes

- Admin logs are stored in an in-memory ring buffer; restart clears them
- Default retention is the most recent `1000` entries and can be tuned with `ADMIN_LOG_BUFFER_SIZE`
- Log records are sanitized for common sensitive keys and large strings are truncated before entering the admin buffer
- The admin page is intended for recent troubleshooting, not long-term audit retention

## Testing And Latency Diagnostics

- `npm run test:unit` covers PostgreSQL pool errors, credential redaction, graceful SIGTERM handling, and startup failure cleanup
- Route smoke tests, real-model tests, and the latency analysis script are documented in [test/README.md](test/README.md)
- `npm run test:latency` sends real streaming requests and automatically adds `x-debug-latency: 1`
- The proxy only emits `proxy.request_timing` when that header is present, so normal traffic does not produce timing logs by default
- If you want the script to pull the matching timing entry from `/admin/api/logs`, also provide `AOAI_PROXY_LATENCY_ADMIN_USERNAME` and `AOAI_PROXY_LATENCY_ADMIN_PASSWORD` when admin auth is enabled

## Docker

Build:

- `./dockerbuild.sh aoai-proxy:latest`

The Dockerfile tracks the current stable major lines with `NODE_MAJOR=24` and `CADDY_MAJOR=2`, which resolve to `node:24-alpine` and `caddy:2-alpine`. The helper script runs `docker build --pull` so each build fetches the latest available patch/minor image in those major lines. Override them only when you intentionally need a different major line:

```bash
docker build --pull \
  --build-arg NODE_MAJOR=24 \
  --build-arg CADDY_MAJOR=2 \
  -t aoai-proxy:latest .
```

Run with Azure Files-style local persistence:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e AOAI_PROXY_ADMIN_PASSWORD="$AOAI_PROXY_ADMIN_PASSWORD" \
  -e AOAI_PROXY_API_KEY="$AOAI_PROXY_API_KEY" \
  -v "$(pwd)/data:/app/data" \
  aoai-proxy:latest
```

Run with PostgreSQL-backed config persistence:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e PERSISTENCE_MODE=database \
  -e AOAI_PROXY_ADMIN_PASSWORD="$AOAI_PROXY_ADMIN_PASSWORD" \
  -e AOAI_PROXY_API_KEY="$AOAI_PROXY_API_KEY" \
  -e CONFIG_DB_CONNECTION_STRING='postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<database>?sslmode=require' \
  aoai-proxy:latest
```

When the container needs AAD upstream access, it still uses `DefaultAzureCredential`, so provide service principal credentials for local development or a managed identity in Azure.

The container entrypoint treats both Node and Caddy as critical processes. If either exits unexpectedly, PID 1 terminates the container with a nonzero status so the platform restart policy can recover it. The ACI templates also probe Node directly at `http://127.0.0.1:3000/healthz`; this catches an unavailable application even if Caddy remains alive.

## Upstream Auth Modes

### `servicePrincipal`

- Default mode
- Uses a client secret when `tenantId`, `clientId`, and `clientSecret` are provided
- Otherwise falls back to `DefaultAzureCredential`, including managed identity when available
- Requires `auth.scope`

### `apiKey`

- Sends requests to Azure AI Foundry / Azure OpenAI with the `api-key` header
- Requires `auth.apiKey`
- Does not acquire AAD tokens or use `auth.scope`

## Azure Deployment

### Deploy with Bicep

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/main.bicep \
  --parameters @infra/parameters/dev.json \
  --parameters adminPassword="$AOAI_PROXY_ADMIN_PASSWORD" proxyApiKey="$AOAI_PROXY_API_KEY"
```

### Deploy with ARM JSON

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/azuredeploy.json \
  --parameters @infra/parameters/prod.json \
  --parameters adminPassword="$AOAI_PROXY_ADMIN_PASSWORD" proxyApiKey="$AOAI_PROXY_API_KEY"
```

The templates provision:

- A container group with system-assigned managed identity
- Azure Database for PostgreSQL Flexible Server and a database child resource when `persistenceMode=database` or `persistenceMode=database+azureFile`
- An optional PostgreSQL `0.0.0.0` Azure-services firewall rule only when `allowAzureServicesToDatabase=true`
- A new storage account only when `persistenceMode=azureFile` or `persistenceMode=database+azureFile`
- Azure Files share when `persistenceMode=azureFile` or `persistenceMode=database+azureFile`
- Secure `CONFIG_DB_CONNECTION_STRING` injection into the container when `persistenceMode=database` or `persistenceMode=database+azureFile`
- Secure admin password and client API-key injection; the checked-in parameter files intentionally omit these values
- Caddy automatic HTTPS configuration with only port `443` exposed publicly; Node port `3000` remains internal for health probes
- RBAC assignment for `Cognitive Services OpenAI User` on the target Azure OpenAI resource

The target Azure OpenAI / Foundry resource can live in a different resource group within the same subscription. Set `cognitiveServicesAccountResourceGroup` when it differs from the deployment resource group.
If `storageAccountName` is empty, the template auto-generates a valid name for storage-backed modes.
If `databaseServerName` is empty, the template auto-generates a valid PostgreSQL server name.
If `databaseName` is empty, the template creates `aoaiproxy`.
The PostgreSQL default is `Burstable` + `Standard_B1ms` + `32 GB`, which is the smallest documented development-oriented size in Microsoft Learn guidance.

Security defaults:

- `allowAzureServicesToDatabase` defaults to `false`. Set it to `true` only when this public ACI deployment cannot reach PostgreSQL through a private or pre-approved network path.
- `acrLoginServer`, `acrUsername`, and `acrPassword` default to empty. Fill them only when the image registry requires basic image-pull credentials from this template.
- The template creates a public ACI IP address, requires `dnsNameLabel` and `caddyEmail`, and exposes only Caddy HTTPS on port `443`.

Current limitation: this ACI-based deployment does not expose an ARM64 machine-family selector. The implemented default is therefore the smallest documented PostgreSQL development SKU, not a guaranteed ARM-series runtime.

### Deploy as Azure Managed Application With Custom UI

Use [infra/azure_deployment_with_UI](infra/azure_deployment_with_UI) when you want the Azure Portal to use `createUiDefinition.json` and show the richer resource-selection UI.

That custom UI now defaults to PostgreSQL-backed config persistence, exposes database server/name/admin fields, and hides storage inputs unless you explicitly switch to Azure Files.

Package the files so that `mainTemplate.json` and `createUiDefinition.json` are at the root of the zip:

```bash
cd infra/azure_deployment_with_UI
zip -j app.zip mainTemplate.json createUiDefinition.json
```

Publish a service catalog definition with Azure CLI using either the local files or an uploaded package URI. Example with local files:

```bash
az managedapp definition create \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --location <location> \
  --display-name "AOAI Foundry Proxy" \
  --description "AOAI Foundry Proxy with custom UI for ACI deployment" \
  --lock-level ReadOnly \
  --authorizations <principalId>:<roleDefinitionId> \
  --create-ui-definition @infra/azure_deployment_with_UI/createUiDefinition.json \
  --main-template @infra/azure_deployment_with_UI/mainTemplate.json
```

Retrieve the definition ID:

```bash
az managedapp definition show \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --query id -o tsv
```

Deploy a service catalog instance:

```bash
az managedapp create \
  --resource-group <application-rg> \
  --name aoai-proxy-instance \
  --location <location> \
  --kind ServiceCatalog \
  --managed-rg-id /subscriptions/<subscription-id>/resourceGroups/<managed-rg-name> \
  --managedapp-definition-id <definition-id>
```

The portal UI in this package supports selecting an existing Foundry or Azure OpenAI resource by resource picker and passes the selected resource group to the deployment template.

## ACI Persistence, Database Notes, and RBAC

- Azure Files walkthrough: [docs/aci_persist_vol.en.md](docs/aci_persist_vol.en.md)
- Chinese version: [docs/aci_persist_vol.md](docs/aci_persist_vol.md)

## Caddy TLS

Use the admin page to configure domain, email, upstream, and transport timeouts. Saving config regenerates the Caddyfile and attempts a hot reload.

When Caddy is already enabled and the container restarts, the app now treats the early boot period as `starting` instead of an error and retries the local `caddy reload` probe in the background until the Caddy process is ready.

If active health checks are enabled and `/healthz` is API-key protected, add a health header in Caddy or disable `health_uri` to avoid false 401/503 failures.

## Foundry v1 Notes

- Data plane path is `/openai/v1/*`
- `api-version` is optional; default behavior is v1
- Request `model` must be the deployment identifier

### Modern Model Compatibility

For `gpt-5` and newer models, plus `o*` reasoning models, the proxy now applies a small set of request normalizations before forwarding to Foundry:

- `max_tokens` is upgraded to `max_completion_tokens` for `chat/completions`
- `top_logprobs` implies `logprobs: true` when the client omits it
- `reasoning_effort` and `reasoning.effort` accept `low`, `medium`, and `high`; `xhigh` is downgraded to `high`
- `service_tier`, `verbosity`, and `top_k` are stripped for modern models because they are common sources of `unknown_parameter` errors against Foundry
- `web_search_preview` tools are rejected early with a `400` because Azure Foundry does not currently support web search tools

The proxy also keeps `stream_options` for streaming `chat/completions` and `responses` requests, and strips it only for routes where Foundry v1 may reject it.

## Model Route Overrides

Use `models[].routes` when the client-facing route and backend-supported route differ.

```json
{
  "models": [
    {
      "id": "my-model",
      "upstream": "foundry",
      "targetModel": "my-deployment",
      "routes": {
        "chat/completions": "responses"
      }
    }
  ]
}
```

## curl Examples

List models:

- `curl -sS http://127.0.0.1:3000/v1/models -H 'authorization: Bearer CHANGEME' | jq .`

Chat request:

- `curl -sS http://127.0.0.1:3000/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer CHANGEME' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"ping"}]}' | jq .`
