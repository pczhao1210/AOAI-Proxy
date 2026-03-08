# AOAI Foundry Proxy

> OpenAI-compatible reverse proxy for Azure AI Foundry / Azure OpenAI with SSE streaming, configurable Caddy TLS, and deployment-selectable persistence.

[English](README.md) | [简体中文](docs/README.zh-CN.md) | [Docs Index](docs/README.md)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Fazure-deploy%2Finfra%2Fazuredeploy.json)

## Overview

- OpenAI-compatible proxy for `chat/completions`, `responses`, `images/generations`, and `models`
- Client -> Proxy uses API key auth via `Authorization: Bearer` or `x-api-key`
- Proxy -> Azure AI Foundry / Azure OpenAI uses AAD tokens from `DefaultAzureCredential`
- Static admin page for config editing, AAD verification, and model usage stats
- Model-level route overrides via `models[].routes` and upstream route maps via `upstreams[].routes`

## Deployment Assets

- Bicep template: [infra/main.bicep](infra/main.bicep)
- ARM template for portal deployment: [infra/azuredeploy.json](infra/azuredeploy.json)
- Portal UI definition for managed app / custom portal packaging: [infra/createUiDefinition.json](infra/createUiDefinition.json)
- Example parameters: [infra/parameters/dev.json](infra/parameters/dev.json), [infra/parameters/prod.json](infra/parameters/prod.json)

The Deploy to Azure button targets the ARM JSON template because the portal button flow does not deploy remote Bicep files directly.
The standard raw-template Deploy to Azure button does not automatically use `createUiDefinition.json`; that file is intended for portal packaging flows that support a custom create experience.

## Persistence Modes

This repo now supports deployment-time persistence selection.

### `azureFile`

- Keeps the current ACI + Azure Files mount to `/app/data`
- Best fit when you need filesystem-style persistence for config, Caddyfile, and Caddy state
- Still requires storage account key for the ACI mount itself

### `blob`

- Keeps config persistence at the application layer through Blob SDK
- Uses `DefaultAzureCredential` and managed identity to read and write the config blob
- Does not replace Azure Files mount semantics for `/app/data`

### Deployment Constraint

ACI native Azure Files mounting still depends on shared key authentication. Managed identity can be used for Blob SDK operations, but it does not convert Azure Files volume mounting into an AAD-only flow. If you must disable key-based auth and still need `/app/data` mount semantics, move to another platform such as ACA, AKS, or a VM-based deployment.

## Timeout Model

The proxy now uses a more conservative long-response baseline that is better suited for tool-calling and MCP-style workflows.

```json
"server": {
  "upstream": {
    "connectTimeoutMs": 5000,
    "requestTimeoutMs": 600000,
    "firstByteTimeoutMs": 90000,
    "idleTimeoutMs": 600000,
    "maxRetries": 1,
    "retryBaseMs": 800,
    "retryMaxMs": 8000,
    "pool": {
      "connections": 32,
      "keepAliveTimeoutMs": 30000,
      "keepAliveMaxTimeoutMs": 120000,
      "headersTimeoutMs": 60000,
      "bodyTimeoutMs": 0,
      "pipelining": 1
    }
  },
  "caddy": {
    "transport": {
      "dialTimeoutMs": 5000,
      "responseHeaderTimeoutMs": 45000,
      "keepAliveTimeoutMs": 120000
    }
  }
}
```

Guidance:

- Keep `server.caddy.transport.dialTimeoutMs` aligned with `server.upstream.connectTimeoutMs`
- Keep `server.caddy.transport.responseHeaderTimeoutMs` greater than or equal to `server.upstream.firstByteTimeoutMs`
- Keep `server.upstream.idleTimeoutMs` long enough for SSE streams that pause between events
- Tune `server.upstream.pool` first for latency-sensitive, low-concurrency deployments before changing retry budgets
- For MCP or tool-calling flows, prefer longer `firstByteTimeoutMs` and `idleTimeoutMs`, but keep `maxRetries` low to avoid replaying side-effecting tool calls

## Local Run

1. Copy the sample config:
   - `cp config/sample_config.json config/config.json`
2. Edit `config/config.json`:
   - Replace `upstreams[].baseUrl` with your Foundry or Azure OpenAI endpoint
   - Set `models[].targetModel` to the deployment identifier
   - Replace the default API key and admin credentials
3. Install dependencies and start:
   - `npm install`
   - `npm run start`

## Environment Variables

### General

- `CONFIG_PATH`: local cached config path, default `./config/config.json`
- `BODY_LIMIT`: request body limit in bytes, default `52428800`
- `CADDY_BIN`: optional Caddy binary path override

### Optional Upstream Pool Overrides

Config file values under `server.upstream.pool` are primary. These environment variables can still override them when needed:

- `UPSTREAM_MAX_CONNECTIONS`
- `UPSTREAM_KEEPALIVE_TIMEOUT_MS`
- `UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS`
- `UPSTREAM_HEADERS_TIMEOUT_MS`
- `UPSTREAM_BODY_TIMEOUT_MS`
- `UPSTREAM_PIPELINING`

### Persistence Selection

- `PERSISTENCE_MODE=azureFile|blob`
- `AZURE_STORAGE_ACCOUNT_URL=https://<storage>.blob.core.windows.net`
- `CONFIG_BLOB_CONTAINER=<container-name>`
- `CONFIG_BLOB_NAME=config/config.json`

In `blob` mode, the app reads from Blob first and falls back to the local cached config if the blob is not present yet.

## Admin Page

Open `/admin` to manage config.

The admin page now exposes:

- Caddy dial timeout
- Caddy response header timeout
- Caddy keepalive timeout
- Runtime persistence summary so you can see whether the deployment is using `azureFile` or `blob`

### Admin Login

Controlled by `server.adminAuth`. When enabled, it protects `/admin` and `/admin/api/*` with HTTP Basic auth.

## Stats Notes

- Stats are in-memory only; restart resets counters
- `usage` is collected from non-stream JSON responses and streaming SSE usage events
- Cached token fields from upstream are counted when present
- The proxy strips `stream_options` to avoid Foundry v1 `unknown_parameter` errors

## Docker

Build:

- `docker build -t aoai-proxy:latest .`

Run with Azure Files-style local persistence:

- `docker run --rm -p 3000:3000 -p 443:443 -v $(pwd)/data:/app/data aoai-proxy:latest`

Run with Blob-backed config persistence:

```bash
docker run --rm -p 3000:3000 -p 443:443 \
  -e PERSISTENCE_MODE=blob \
  -e AZURE_STORAGE_ACCOUNT_URL=https://<storage>.blob.core.windows.net \
  -e CONFIG_BLOB_CONTAINER=aoai-proxy-config \
  -e CONFIG_BLOB_NAME=config/config.json \
  aoai-proxy:latest
```

The container still uses `DefaultAzureCredential`, so provide service principal credentials for local development or a managed identity in Azure.

## Azure Deployment

### Deploy with Bicep

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/main.bicep \
  --parameters @infra/parameters/dev.json
```

### Deploy with ARM JSON

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/azuredeploy.json \
  --parameters @infra/parameters/prod.json
```

The templates provision:

- A container group with system-assigned managed identity
- A storage account
- Azure Files share when `persistenceMode=azureFile`
- Blob container when `persistenceMode=blob`
- RBAC assignment for `Storage Blob Data Contributor` when blob mode is enabled
- RBAC assignment for `Cognitive Services OpenAI User` on the target Azure OpenAI resource

The target Azure OpenAI / Foundry resource can live in a different resource group within the same subscription. Set `cognitiveServicesAccountResourceGroup` when it differs from the deployment resource group.

## ACI Persistence and RBAC

- Azure Files walkthrough: [docs/aci_persist_vol.en.md](docs/aci_persist_vol.en.md)
- Chinese version: [docs/aci_persist_vol.md](docs/aci_persist_vol.md)

## Caddy TLS

Use the admin page to configure domain, email, upstream, and transport timeouts. Saving config regenerates the Caddyfile and attempts a hot reload.

If active health checks are enabled and `/healthz` is API-key protected, add a health header in Caddy or disable `health_uri` to avoid false 401/503 failures.

## Foundry v1 Notes

- Data plane path is `/openai/v1/*`
- `api-version` is optional; default behavior is v1
- Request `model` must be the deployment identifier

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
