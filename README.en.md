# AOAI Foundry Proxy

> OpenAI-compatible reverse proxy for Azure AI Foundry / Azure OpenAI with SSE streaming, Caddy TLS, and ACI-friendly persistence.

## Keywords
OpenAI proxy, Azure AI Foundry, Azure OpenAI, SSE streaming, Caddy TLS, ACME, ACI, Fastify

## Suggested Topics (add in GitHub repository settings)
`openai` `azure` `azure-openai` `azure-ai` `proxy` `caddy` `acme` `sse` `fastify` `aci`

## Overview
- OpenAI-compatible reverse proxy (chat/completions, responses, images)
- Client → Proxy uses API Key
- Proxy → Foundry uses AAD Bearer Token (DefaultAzureCredential)
- Static admin UI for configuration and stats

## Endpoints
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `GET /v1/models`

## Local Run
1. Copy sample config:
   - `cp config/sample_config.json config/config.json`
2. Edit `config/config.json`:
   - Replace `upstreams[].baseUrl` with your Foundry/AOAI endpoint
   - Set `models[].targetModel` to deployment identifier
   - Update `apiKeys`, `server.adminAuth` if needed
3. Start:
   - `npm install`
   - `npm run start`

## Admin Page
- Open `/admin` to edit and save config

### Admin Login (HTTP Basic)
Controlled by `server.adminAuth`. When enabled, protects `/admin` and `/admin/api/*`.

## Stats Notes
- Stats are in-memory only; restart resets counters.
- `usage` is taken from upstream responses: non-stream JSON `usage`, and stream `data:` events that carry `usage` or `response.usage`.
- If upstream returns `prompt_tokens_details.cached_tokens` or `input_tokens_details.cached_tokens`, they are tracked as Cached Tokens.
- The proxy strips `stream_options` to avoid Foundry v1 `unknown_parameter` errors.

## Docker
The image copies `config/sample_config.json` to `/app/config/config.json` and enables admin login by default (`admin/admin`).
On startup, the default config is copied to `/app/data/config.json` (mount this path to persist).
The image includes Caddy and will start TLS if `/app/data/Caddyfile` exists.
Certificates and ACME state are stored in `/app/data/caddy` and must be persisted.

Build:
- `docker build -t aoai-proxy:latest .`

Run (ports + persistent volume):
- `docker run --rm -p 3000:3000 -p 443:443 -v $(pwd)/data:/app/data aoai-proxy:latest`

Note: The container uses `DefaultAzureCredential`. Provide AAD credentials via env or managed identity.

For large image payloads, adjust body limit (bytes):
- `BODY_LIMIT=52428800` (default 50MB)

## Image Compression (All Traffic)
The server compresses image data before forwarding (only `data:image/*` or `image_base64` fields). Configure via:

```json
"imageCompression": {
  "enabled": true,
  "maxSize": 1600,
  "quality": 0.85,
  "format": "jpeg"
}
```

## Caddy TLS (Port 443)
Use “Domain & TLS (Caddy)” in the admin UI to configure domain/email/port. Saving generates the Caddyfile and attempts reload.

1. Configure and save in the admin UI (writes `server.caddy` and generates Caddyfile).
2. Run Caddy:
   - `caddy run --config /app/data/Caddyfile --adapter caddyfile`

Note: ACME validation typically needs 80/443 reachable (HTTP-01/TLS-ALPN-01). If only 3001 is available, use DNS-01.

### Caddy Active Health Check + Auth (401/503 Troubleshooting)
If `reverse_proxy` active health checks are enabled (for example `health_uri /healthz`), and `/healthz` is protected by proxy auth, you may see:
- `status code out of tolerances`, `status_code: 401`, `host: 127.0.0.1:3000`
- `no upstreams available`

Why this happens:
- Caddy health checks do not include your proxy API key by default.
- If `/healthz` requires API key auth, health checks return 401, and Caddy marks the upstream unhealthy, resulting in 503 to clients.

Workarounds (pick one):
1. Add auth header for health checks in Caddyfile (recommended):
```caddyfile
reverse_proxy 127.0.0.1:3000 {
  health_uri /healthz
  health_interval 30s
  health_headers {
    Authorization "Bearer <YOUR_PROXY_API_KEY>"
  }
}
```
2. Remove `health_uri` temporarily (disable active health checks) to avoid false unhealthy marking from 401.

Note:
- Saving config in admin regenerates Caddyfile. If you patch Caddyfile manually, verify your health-check settings again after the next save.

## Foundry v1 Notes
- Data plane path is `/openai/v1/*` (e.g., `POST {endpoint}/openai/v1/chat/completions`).
- `api-version` is optional; default is `v1`.
- Request `model` is deployment identifier; proxy uses `models[].targetModel`.

## Model Route Overrides (`models[].routes`)
If the client calls `POST /v1/chat/completions` but the backend only supports `responses`, use `routes` to override.

Two forms:
- **Map to another routeKey**: `responses` / `chat/completions` / `images/generations`
- **Use explicit path**: value starts with `/` (can include `{deployment}`)

Example (client calls chat, backend uses responses):

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

Note: This only changes upstream route selection; it does not convert request bodies.

### Recommended Upstream Config
- `upstreams[].baseUrl`:
  - `https://<your-resource-name>.openai.azure.com/`
  - or `https://<your-resource-name>.services.ai.azure.com/`
- `upstreams[].routes`:
  - `chat/completions`: `/openai/v1/chat/completions`
  - `responses`: `/openai/v1/responses`
  - `images/generations`: `/openai/v1/images/generations`

## curl Examples
List models:
- `curl -sS http://127.0.0.1:3000/v1/models -H 'authorization: Bearer CHANGEME' | jq .`

Call chat:
- `curl -sS http://127.0.0.1:3000/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer CHANGEME' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"ping"}]}' | jq .`

## ACI Persistence
See [aci_persist_vol.en.md](aci_persist_vol.en.md)

## ACI Image Update
Per the official guidance, update by re-running `az container create` with the same name. If `az container update` is unavailable, follow this approach:

1. Maintain your deployment parameters (YAML or script).
2. Update the image (prefer digest).
3. Re-run `az container create` with the same name to redeploy.

Example (replace placeholders):

```bash
az container create \
  -g <resource-group> \
  -n <container-name> \
  --image <registry>/<image>@sha256:<digest> \
  --registry-login-server <registry> \
  --registry-username <username> \
  --registry-password <password> \
  --cpu 1 --memory 2 \
  --ports 3000 443 \
  --dns-name-label <dns-label> \
  --azure-file-volume-account-name <storage-account> \
  --azure-file-volume-account-key <storage-key> \
  --azure-file-volume-share-name <share> \
  --azure-file-volume-mount-path /app/data \
  --os-type Linux
```

## Update History
- 2026-03-02: Caddy connection reuse/protocol tuning; added 401/503 troubleshooting for `health_uri + auth`
- 2026-02-25: Cached Tokens stats, Responses streaming usage capture, stream_options stripped by default
- 2026-02-10: Image compression for all traffic, admin placeholder injection, ACI update notes
- 2026-02-04: Caddy status panel and hot reload, ACME stdout logs, i18n support
