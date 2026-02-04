# AOAI Foundry Proxy

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

## Caddy TLS (Port 443)
Use “Domain & TLS (Caddy)” in the admin UI to configure domain/email/port. Saving generates the Caddyfile and attempts reload.

1. Configure and save in the admin UI (writes `server.caddy` and generates Caddyfile).
2. Run Caddy:
   - `caddy run --config /app/data/Caddyfile --adapter caddyfile`

Note: ACME validation typically needs 80/443 reachable (HTTP-01/TLS-ALPN-01). If only 3001 is available, use DNS-01.

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