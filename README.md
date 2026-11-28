# AOAI Foundry Proxy

> OpenAI-compatible reverse proxy for Azure AI Foundry / Azure OpenAI with SSE streaming, configurable Caddy TLS, and deployment-selectable persistence.

[English](README.md) | [简体中文](docs/README.zh-CN.md) | [Docs Index](docs/README.md) | [Git Workflow（中文）](docs/development/git-workflow.zh-CN.md)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Faoai-nextgen%2Finfra%2Fazuredeploy.json)

## Overview

- OpenAI- and Anthropic-compatible proxy for `chat/completions`, `responses`, `responses/compact`, `messages`, `messages/count_tokens`, `images/generations`, and `models`
- Opt-in HTTP audio/image edits, native MAI Speech, Realtime WebSocket, and WebRTC setup/control; MAI Image and Thinking use dedicated Foundry routes. See [protocol contracts](docs/protocols/protocol-support.md#25-mai音频与实时传输) and [configuration defaults](docs/configuration/feature-flags.zh-CN.md#音频与实时连接限额).
- Client -> Proxy uses API key auth via `Authorization: Bearer` or `x-api-key`
- Proxy -> Azure AI Foundry / Azure OpenAI uses AAD tokens or protocol-appropriate `api-key` / `x-api-key` headers, based on `auth.mode`
- Static admin page for config editing, AAD verification, model usage stats, and recent log inspection
- Runtime model tables show four token metrics, a derived cache-read ratio, final estimated cost, and request-time billing-tier breakdowns. Confirmed model-only resets preserve global/key usage and quotas; see [statistics semantics](docs/configuration/feature-flags.zh-CN.md#持久化与访问治理).
- Model-level route overrides via `models[].routes` and upstream route maps via `upstreams[].routes`
- Native protocol routes preserve modern Responses items and Anthropic content blocks; cross-protocol shims use best-effort conversion with structured loss warnings by default and expose strict request/response rejection switches
- Optional DCE-based Log Analytics export for correlated proxy events, usage, and redacted prompt/output content; see the [setup guide](docs/observability/log-analytics-dce.en.md)

## Deployment Assets

- Bicep template: [infra/main.bicep](infra/main.bicep)
- ARM template for portal deployment: [infra/azuredeploy.json](infra/azuredeploy.json)
- Portal UI definition for managed app / custom portal packaging: [infra/createUiDefinition.json](infra/createUiDefinition.json)
- Azure Managed Application package source: [infra/azure_deployment_with_UI/README.md](infra/azure_deployment_with_UI/README.md)
- Example parameters: [infra/parameters/dev.json](infra/parameters/dev.json), [infra/parameters/prod.json](infra/parameters/prod.json)

The Deploy to Azure button targets the ARM JSON template because the portal button flow does not deploy remote Bicep files directly.
The standard raw-template Deploy to Azure button does not automatically use `createUiDefinition.json`; that file is intended for portal packaging flows that support a custom create experience.
The deployment templates now distinguish between `new` and `existing` storage/database resources so policy-restricted environments can reuse pre-provisioned Azure Files or PostgreSQL resources instead of forcing resource creation.

## Repository Hygiene

- Keep long-lived designs and implementation records in [docs/development/](docs/development/), not the repository root.
- Commit source, tests, documentation, reusable [infra/](infra/) templates, CI workflows, [config/sample_config.json](config/sample_config.json), and [.env.example](.env.example). Keep bundled admin assets versioned with intentional admin changes.
- Keep real environment files, all other local configuration files, credential directories, runtime data, and local agents/editor settings out of Git and Docker build contexts. Custom configuration or credential paths outside the default ignored locations need their own ignore rules or should live outside this repository.
- The machine-specific ACI export is retained locally in the ignored temporary directory; reusable deployment assets remain in [infra/](infra/). Ignore rules do not remove files or secrets from existing Git history.

## Distribution Profiles

New media transports are disabled by default in both profiles. WebRTC media/data channels go directly to the provider; call ownership is in-process and requires a single instance or affinity. Client-secret export is a separate administrator opt-in. Complete observed media usage with supported rates is priced and recorded; missing usage/rates or incomplete sessions retain unknown/partial totals, not zero. See [media pricing](pricing/README.md#media-usage-pricing) for units, provider isolation and persistence limits. Post-hoc accounting is not a hard cap: TPM/budget-constrained keys remain rejected before upstream work. Local acceptance does not establish live provider, browser audio, billing or deployment acceptance.

`nextgen` and `minimum` are runtime scope profiles on the same source and container image, selected with `distribution.profile` or `AOAI_PROXY_PROFILE`. The default is `nextgen`.

- Both profiles keep Chat Completions, Responses, Messages, the complete $3 \times 3$ native/conversion matrix, protocol-native utility endpoints, images, routing, authentication, SSE, retries, and cancellation.
- Both profiles include the bundled Model Catalog, in-memory lookup, and remote atomic catalog updates, so model facts can be maintained without rebuilding the image.
- `minimum` disables budgets, the PostgreSQL runtime event store, Log Analytics ingestion/initialization, and database diagnostic APIs. Model Catalog and basic in-memory administration remain available.
- Profile limits apply only to the runtime clone. Persisted nextgen settings are retained, so switching back from `minimum` restores them.
- `/admin/api/runtime` exposes the effective profile and capability manifest. `/version` exposes the profile in `X-AOAI-Proxy-Profile` without changing its JSON contract.

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

Use Node.js 24.22.1 or a newer patched 24.x release. With nvm, run `nvm install`
and `nvm use` to select the baseline in [.nvmrc](.nvmrc). The proxy uses Node's
built-in `fetch()`, so updating the npm `undici` package alone does not patch it.

1. Copy the sample config:
   - `cp config/sample_config.json config/config.json`
2. Edit `config/config.json`:
   - Replace `upstreams[].baseUrl` with your Foundry or Azure OpenAI endpoint
   - Set `models[].targetModel` to the deployment identifier
  - Choose authentication for each upstream in the admin UI or with `upstreams[].auth`:
    - `mode = "managedIdentity"` uses the existing Azure credential and AAD token flow
    - `mode = "apiKey"` requires that upstream's `apiKey` and sends `api-key` or `x-api-key` as required by the route
    - Omitting the upstream mode preserves compatibility by inheriting the global `auth` configuration
   - Replace the default API key and admin credentials
3. Install dependencies and start:
   - `npm ci --engine-strict`
  - Set `AOAI_PROXY_ADMIN_PASSWORD` and `AOAI_PROXY_API_KEY` to strong, unique secrets when `server.host` is not loopback
   - `npm run start`

Non-loopback listeners fail closed when admin authentication is disabled or known placeholder credentials are active. `ALLOW_INSECURE_PUBLIC_ADMIN=true` is an explicit compatibility escape hatch and is not recommended for normal deployments.

Dependency maintenance note (2026-11-04): `@azure/identity` 4.14.1 declares
`@azure/msal-node` `^7.1.0`, and the `overrides` entry pins MSAL Node 7.1.2, which
is patched for [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5).
Change that pin only with authentication validation. `@fastify/static` still
declares `glob` `^13`, so `overrides` raises `glob` to `^14.0.3` (with minimatch 11)
for [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249); the
admin asset route keeps the default `wildcard: true` and does not invoke glob.
Remove that override once `@fastify/static` accepts a patched glob. Keep
`@fastify/multipart` at 10.1.7 or newer: earlier versions are affected by the
upload DoS advisories GHSA-62qx-hpj5-j6hc, GHSA-vmph-573x-85f6 and
GHSA-5849-5m6q-9632, which were published in the
[fastify-multipart repository](https://github.com/fastify/fastify-multipart/security/advisories)
but not yet in the global advisory database, so `npm audit` does not report them.
The CI audit gate (`npm audit --audit-level=moderate`) is expected to pass.

JSON feature flags require literal booleans, not strings such as `"false"` or
numbers such as `0`. Legacy export/image gates retain their effective AND
semantics when migrated to one canonical switch; disabled beta filtering becomes
`compatibility.anthropic.unknownBetaPolicy: "passthrough"`. Inactive flags are
removed from the editable configuration and reported in Workspace, runtime
`configuration.deprecatedFlags`, and `config.deprecated_flags` logs. Ordinary v3
reloads do not rewrite the file: review and save to persist cleanup. Environment
overrides and profile-disabled persisted settings remain protected. See the
[flag and migration guide](docs/configuration/feature-flags.zh-CN.md).

## Admin Console

The console uses task-based navigation under `/admin` (or `server.adminPath`):
overview, channels, exposed models, client access, Catalog, API Keys, usage,
logs, health, Playground, diagnostics, settings, and configuration history/sync.
Deep links such as `/admin/keys?edit=team-a&tab=access` and
`/admin/settings/persistence` survive refresh. The server supplies the effective
base path to both the router and API client; `/admin/...` compatibility links
redirect to the configured path. Unknown API paths still return API errors.

- Tables support sorting, column visibility, selection, and draft-only bulk
  enable/disable. Models default to canonical-model grouping. Narrow screens
  keep horizontal scrolling inside tables; complex editing is intended for a
  wider screen.
- **Channels → Add Upstream** is the single creation entry. Choose Azure,
  Azure Speech, GitHub Copilot, OpenAI Compatible, or Anthropic, then configure
  the channel. Azure Speech channels carry only the `audio/speech` and
  `audio/transcriptions` Speech routes and use the Speech resource key; MAI Voice
  (regional `https://REGION.tts.speech.microsoft.com`) and MAI Transcribe (the
  Speech resource endpoint) normally need one channel each.
  Copilot opens its device-login controls instead of API-key authentication;
  use **Models & mappings** to fetch and explicitly approve discovered models.
  The choices are UI templates, not a new backend provider allowlist, and do not
  rewrite existing channel routes or remove legacy provider values.
  GitHub uses Device Flow and server-local credential storage. Its admin APIs
  separately require authenticated admin access: `COPILOT_ADMIN_AUTH_REQUIRED`
  means configure the admin username/password and enable authentication under
  **Settings → Service & security**, not supply GitHub credentials to the proxy.
- Each channel row has a **Models & mappings** action. It shows the upstream
  deployment IDs, Catalog mappings, and links to already exposed models.
  Add **Channel model IDs** by typing exact Model Card IDs (comma-separated for
  multiple IDs) or selecting suggestions. When upstream and target model IDs
  match, mapping is optional; explicit same-name mappings are also accepted.
  For other deployment names, configure **deployment ID → Model Card
  ID**, then add all mapped IDs to the list in one action. Deployment names
  remain arbitrary; channel model IDs and mapping targets must match the Catalog.
  These controls use the existing `modelMappings`/`enabled` binding format.
  Legacy direct bindings use the same controls when the Catalog resolves them;
  the first edit migrates only the draft, retaining public identities/overrides.
  Mapping/enablement does not publish a model or grant Key access: publish under
  **Exposed models**, then grant permissions under **API Keys**.
- Key/channel/model Sheets edit complete local copies. **Apply to draft** merges
  the copy into the global configuration draft, not the running service, and
  closes the Sheet.
  **Cancel** discards that copy; closing or browser Back retains it in memory.
  Pending copies are accessible from the configuration status menu. Apply or
  cancel them before **Review & Save**.
- Navigation preserves drafts. Reloading/leaving the application prompts when
  changes would be lost; drafts are not stored in the browser or recovered after
  a full reload. Saves retain revision/CSRF protection and report proxy, Caddy,
  and persistence application separately. Stage retry does not replace the draft.
- Theme defaults to the system preference. Light/dark overrides and language
  selection are retained locally. Unknown budgets, usage, and application state
  are not displayed as successful zero values.
- Usage and log filters are URL-backed, for example
  `/admin/usage?key=team-a&group=canonical` and `/admin/logs?key=team-a`.
  Usage tabs show their selected content directly; the shared overview is
  expandable, filters stay visible, and target-model grouping stays within the
  Models tab. Charts and historical rollups appear under Trends.
  Key log filtering only covers retained records with an unredacted recorded
  identity; it cannot recover redacted identities or evicted history.
- Settings support path/label search, modified-only filtering, and read-only
  environment/profile source badges. Selected settings tabs display their form
  directly, without a second accordion that can remain collapsed on return.
  Configuration history is an inline list
  with grouped differences; restore creates a new revision and preserves current
  credentials and persistence settings.
- **Settings → Configuration JSON** is the only full-configuration fallback
  editor entry; old `/admin/config/json` links redirect there.
  Raw edits remain separate from forms
  until **Review & replace configuration → Confirm replacement and save**.
  This replaces the stored configuration, rather than merging individual
  properties. Invalid input and failed/conflicting saves retain the text.
  Other saves are blocked while JSON edits are pending. The editor exposes the
  complete editable, secret-masked configuration, not unredacted file bytes;
  server validation, revision checks, normalization, masked-secret restoration,
  environment-managed settings and restart requirements still apply.

See the [UI implementation status](docs/development/admin-ui-enhancement-plan.zh-CN.md#15-实施状态与验收记录)
for the progressive migration boundaries and remaining work.

## Environment Variables

### General

- `CONFIG_PATH`: local cached config path, default `./config/config.json`
- `BODY_LIMIT`: process-wide Fastify request-body hard ceiling in bytes, default `52428800`; read at startup and requires a restart to change
- `SERVER_BODY_LIMIT`: legacy alias for `BODY_LIMIT`, used when `BODY_LIMIT` is absent or not a positive integer
- `CADDY_BIN`: optional Caddy binary path override
- `SHUTDOWN_TIMEOUT_MS`: optional graceful-shutdown deadline override; otherwise `server.gracefulShutdownMs` is used
- `ADMIN_LOG_BUFFER_SIZE`: in-memory admin log ring buffer size, default and hard maximum `100`
- `PRICING_DIR`: optional pricing library directory override. By default the app reads from `/app/data/pricing` when synced files exist, otherwise it falls back to the bundled `pricing/` directory inside the image.
- `AOAI_PROXY_PROFILE`: runtime scope profile, either `nextgen` (default) or `minimum`
- `AOAI_PROXY_ADMIN_USERNAME`: admin Basic Auth username, defaulting to the configured username
- `AOAI_PROXY_ADMIN_PASSWORD`: admin Basic Auth password; setting it also enables admin authentication unless explicitly disabled
- `AOAI_PROXY_API_KEY`: replaces the configured default client API key
- `AOAI_PROXY_UPSTREAM_API_KEY`: overrides `auth.apiKey` for upstream API-key authentication
- `AOAI_PROXY_CADDY_ENABLED`, `AOAI_PROXY_CADDY_DOMAIN`, `AOAI_PROXY_CADDY_EMAIL`: Caddy HTTPS overrides
- `AOAI_PROXY_TRUST_PROXY`: trust proxy-appended forwarding headers; enable only when Node is reachable exclusively through the trusted reverse proxy

The effective limit for a public proxy request is the smaller of `BODY_LIMIT` and `proxy.guards.maxRequestBodyBytes`. The process limit applies to every parsed request, including admin APIs, and is fixed when Fastify starts. The config guard applies to public proxy routes, can be changed through config reload or the admin API without a restart, and counts the raw request stream before JSON normalization, including chunked bodies. Both values must be positive integers. `proxy.guards.maxResponseBodyBytes` bounds buffered upstream JSON responses; streaming SSE is instead bounded by per-event buffering and stream timeout policies, not by a total response-byte limit.
- `ALLOW_INSECURE_PUBLIC_ADMIN`: explicit opt-out from non-loopback credential checks; avoid in production

### Pricing Sync

- `PRICING_SYNC_GITHUB_OWNER`: GitHub owner for pricing sync, default `pczhao1210`
- `PRICING_SYNC_GITHUB_REPO`: GitHub repository for pricing sync, default `AOAI-Proxy`
- `PRICING_SYNC_GITHUB_PATH`: repository path containing pricing JSON files, default `pricing`
- `PRICING_SYNC_GITHUB_REF`: optional branch, tag, or commit. When omitted, the proxy resolves the repository default branch through the GitHub API.
- `PRICING_SYNC_GITHUB_TOKEN`: optional GitHub token for higher API limits or private repositories

The admin Operations page can override owner, repo, path, and ref per sync request. Successful syncs persist the selected GitHub source into pricing sync metadata so the same source shows up on the next load.

When you trigger `Sync From GitHub` from `/admin`, the proxy downloads pricing JSON files into a staging directory, normalizes every definition, and compiles a candidate Model Catalog before changing active state. It then swaps the persistent directory, in-memory pricing indexes, and immutable runtime snapshot as one generation. A failed parse or compile leaves the previous directory and snapshot active. In Azure Files-style deployments, successful updates survive container replacement without rebuilding the image.

Text billing supports [whole-request context tiers](pricing/README.md#whole-request-text-pricing).
JSON and SSE accounting use upstream usage (including cached input), not output
text deltas. Numeric tier boundaries must be verified; labels such as `short` and
`long` alone do not enable billing. Prices are frozen per request, and unknown
costs remain visibly incomplete rather than free. Installing this runtime
feature requires an updated container; later supported price-table updates can
use catalog sync.

Cache reads and cache writes are separate reporting dimensions. Runtime statistics
and PostgreSQL event/rollup storage retain reported write tokens and write costs;
missing write evidence or prices remain unknown instead of becoming zero. Writes
are already part of input usage and are not added to total tokens a second time.
For Chat/Responses, billed ordinary input excludes both reads and writes.

### Model Catalog Schema

Each `pricing/*.json` file is also a Model Catalog definition. Besides pricing, it can declare `aliases`, `defaultInterface`, and `protocolProfiles`. Text protocol profiles may define a reasoning parameter path, supported levels, default, aliases, validation mode, and Messages thinking types. An `images/generations` profile may define request transport matching, model removal, quality aliases, dropped parameters, and size expansion into width/height fields.

Cards follow the [canonical authoring format](pricing/README.md#canonical-authoring-format):
one per-million price table and a `proxyTemplate` containing only overrides.
Backend and admin loaders fill defaults while preserving explicit null opt-outs
and legacy full cards. Run `npm run cards:format` and `npm run cards:check` when
editing active cards; archives are excluded. Deploy this loader/admin upgrade
before syncing compact cards to older installations.

Catalog definitions are compiled when config is loaded or saved and after a successful remote update. Every active configured model must resolve a definition through its `pricingRef`, public ID, or target model before the candidate config or catalog can become active. Requests then reuse that immutable descriptor for routing, provider/interface selection, normalization, discovery, image adaptation, and governance pricing.

`models[].routes` is constrained by that descriptor. A route target must be one of its hosting-resolved `interfaces` or a transport target explicitly declared by its Catalog `proxyTemplate.routes`; arbitrary aliases and direct URL paths are rejected. Concrete paths belong in `upstreams[].routes`. Administrator policies may narrow behavior, but cannot route a model outside its Catalog definition.

Catalog levels are compatibility metadata, not a global upstream capability gate. Profiles default to `validation: "passthrough"`, so an unlisted future field or level is forwarded to the real upstream unless an explicit administrator policy rejects it.

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

Database configuration saves use a PostgreSQL version check across instances sharing the same database row. Each instance must use its own local config-cache path and pending-sync marker, including when Azure Files is mounted. A stale save returns `409 CONFIG_REVISION_CONFLICT`. When the database is unavailable, saves remain in the local cache and synchronization uses the last known database revision; if it changed or is unknown, the local copy remains pending and is not automatically written over the database. The admin page can compare changed paths and, after confirmation, discard the pending local copy and reload from the database. Back up the local copy first if it must be retained. File-mode revisions are process-local; they do not coordinate multiple writers or manual file edits. Switching persistence targets is not an atomic transaction across stores.

Offline saves first atomically replace a pending record containing the configuration, original database revision, and redacted history, then update the local cache. The pending record is authoritative after restart even if the cache write failed. Comparing the latest configuration never advances the active instance's save baseline. A failed reload validation keeps the active configuration and baseline unchanged.

The runtime-event spool uses an adjacent `.offset` checkpoint and periodically compacts acknowledged records. Invalid or older checkpoints without a digest trigger safe replay using event-identity deduplication. Malformed records are retained in an adjacent `.corrupt` file and reported through `corruptedEvents`; their usage is **not** considered recovered. Keep each instance's spool path and checkpoint private to that instance; sharing a path between processes is unsupported. Once runtime storage is activated, changing its effective spool path through save/reload is rejected with `RUNTIME_STORE_RESTART_REQUIRED`. Drain it first, or stop the process and migrate the pending file before restarting with the new path. A moved file can invalidate its identity checkpoint and will be safely replayed. Atomic file replacement/fsync is not a cross-file transaction or a guarantee against whole-machine power loss.

### Configuration History and Application

The admin page retains the latest **12 redacted configuration versions**, including an initial baseline when available. Database mode stores them in the configuration row's `history_json` column alongside CAS-protected saves; file mode uses an adjacent `.history.json` sidecar. History is bounded operational recovery, not an immutable audit log or a credential backup. Redaction covers the established secret fields and credential headers, not secrets embedded in arbitrary extension strings.

Use **Configuration history** to select a version, inspect changed paths, and restore it as a new revision. Rollback requires `If-Match`, preserves current credentials (matched by key ID/upstream name, never array position) and current persistence settings, and rejects missing credentials or expired versions. It still runs normal configuration/Catalog validation; restart-only changes cannot be activated by rollback.

Save, reload, rollback, and application retry are serialized per instance. Their responses distinguish persistence from `apply.proxy` and `apply.caddy`; a saved configuration can have a failed application stage. The UI reports failures, pending database sync, and failed cache/history copies. Retry only the failed stage without saving again or discarding a draft. Caddy reload commands have a 10-second timeout. Application outcomes describe this instance, not cluster-wide deployment acceptance.

Admin endpoints (under the configured admin path):

- `GET /api/config/history` and `GET /api/config/history/:id`: metadata list and redacted snapshot.
- `POST /api/config/history/:id/rollback`: restore with the current `If-Match`.
- `POST /api/config/apply`, body `{"stage":"proxy"}` or `{"stage":"caddy"}`: retry with the current `If-Match`.
- `POST /api/reload` accepts an optional `If-Match`; a supplied revision that is no longer current returns `409 CONFIG_REVISION_CONFLICT` without reloading. Without `If-Match`, reload is unconditional.
- Discarding pending database configuration on `/api/reload` requires the active revision returned by `X-AOAI-Active-Config-Revision` when comparing `/api/config/latest`.

These mutations retain the existing administrator authentication and CSRF requirements.

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
- Read-only statistics snapshots with capture time and partial/fallback status. At most two dedicated reader connections keep slow dashboards off the event-writer/admission queue; cold dashboard reads never mark live budgets hydrated. Request admission still performs strict recovery. Background writes/rollups can lag; **Sync Now** requests a flush. Event inserts take a shared PostgreSQL advisory lock that excludes an in-flight rollup batch, so instances sharing a schema cannot commit events behind the rollup cursor; upgrade every instance that shares the schema, because older writers do not take the lock. Events skipped by earlier versions are not backfilled. Unavailable storage shows process-local counters, never a sum of memory and database history.
- Recent logs with level filters (`warn`, `error`, optional `info`), keyword search, request-id filtering, and copy-summary actions

The log panel uses a compact always-visible toolbar plus collapsible advanced filters instead of a sticky filter bar.

### Channels, exposed models and key access

In **Upstream / Model**, enter each channel's actual deployment IDs and map them to exact Catalog IDs. For an existing upstream, **Enable channel mappings in draft** previews an explicit migration; loading a legacy config does not migrate it. An enabled row is available for selection, not automatically published. In **Exposed models**, select the subset to publish and, for ambiguous candidates, choose the exact channel and deployment. Changing that binding keeps the public model ID. A row that an exposed model is bound to cannot be renamed, retargeted, disabled or deleted until that model is switched to another row (add the replacement row first); the editor lists the referencing models and flags bindings that no longer resolve. There is no automatic failover.

A saved API-key channel for `openai` at `https://api.openai.com` or `https://api.openai.com/v1` can **Fetch available IDs** through the server. Select and map exact IDs to add disabled rows to the draft; nothing is published. Enter deployment names manually for Azure and other ordinary channels.

Grant access only in **Key Governance**. New keys default to **Selected public models only**, with no models selected. **All** includes future publications. Legacy keys without a mode retain their previous permissions. Anonymous access is a separate identity: require API keys for isolation. Review and save the draft once. See the [schema, migration and downgrade notes](docs/configuration/feature-flags.zh-CN.md#普通渠道映射暴露与-key-权限).

**Runtime → Usage by canonical model and channel** groups recorded inference, not the current configuration. Expand a canonical model for channel subtotals and a channel for public alias, source deployment, actual model, route, usage source and pricing tier. A switch, upstream rename or tariff update does not move earlier traffic. For example, channels with 12,000/3,000 and 8,000/2,000 input/output tokens make one parent with 20,000/5,000. Do not add detail rows or cache tokens again. Known costs are subtotals by currency; missing prices, counts and unobserved cache writes are not zero.

`GET /admin/api/stats` adds `canonicalModels[].channels[].details`, with nullable IDs for missing evidence, and `canonicalFilters`. Existing `perModel` remains keyed by public ID. All-time database statistics use daily rollups; Key/time filters read retained events (`canonicalDetailRetentionDays`). Writers add nullable `channel_detail` and `channel_settlements` rollup columns without rebuilding old rows; GETs do not migrate the database. Pre-upgrade model rollups without matching detail remain under **Not recorded** without backfill. Model reset clears both model views, not global/Key totals. The memory channel table supports all-time per-Key counters and exact time filtering over the last 8,192 process-local inference events; `canonicalWindowTruncated` warns when earlier events in the selected window were evicted. Other memory counters remain cumulative. Storage fallback and process restarts do not imply that durable history was loaded.

`GET /admin/api/logs` accepts exact `canonicalModelId`, `channelId`, `sourceModelId` and `configRevision` filters on inference events or grouped requests. These fields come from the applied configuration selected for the request, including deferred streaming settlement. An authorization failure has no serving channel. Historical logs without these fields are not reclassified.

For an authorized GitHub Copilot deployment, choose **Add GitHub Copilot channel**, select the authorized profile and sign in on GitHub's device page. **Check status** reads the cached state; **Refresh model list** requests discovery. The form never asks for a token. Only select exact discovered deployment IDs and match them to Catalog IDs. Refreshing does not change approvals; stale or failed discovery cannot approve a new mapping or binding. Save the draft using the usual review flow. Local disconnect is a separate operation: move any bound public models first. To revoke the application on GitHub, use [authorized OAuth apps](https://github.com/settings/applications).

Selecting a Copilot identity supplies its reference OAuth application; optional environment overrides remain available. Admin Basic Auth and private credential storage are required, but there is no Copilot-specific encryption key requirement. Credentials currently use plaintext private storage, like secrets stored in ordinary configuration; they are never returned to the browser or included in configuration/history/logs. Legacy encrypted credentials report `COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED` and require reauthorization rather than automatic decryption or deletion. See [deployment prerequisites and trust boundaries](docs/configuration/feature-flags.zh-CN.md#aoai-proxy-启用-copilot-渠道的部署前提), [credential storage/recovery](docs/development/copilot-credential-store.md), and the [deferred global encryption design](docs/development/encryption-design.zh-CN.md). Offline provider fixtures test the integration; they do not establish that a GitHub subscription permits consumer traffic or that a model accepts a particular native protocol.

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

- amd64 local image: `./start.sh --build`
- arm64 local image: `DOCKER_PLATFORM=linux/arm64 ./start.sh --build`
- amd64 build and push to ACR: `./start.sh --build --push`
- arm64 build and push to ACR: `DOCKER_PLATFORM=linux/arm64 ./start.sh --build --push`

The default amd64 image is `alexmcr.azurecr.io/aoai-proxy:nextgen-latest`. When `DOCKER_PLATFORM=linux/arm64`, the default tag changes to `nextgen-latest-arm64`. `IMAGE_REF`, `IMAGE_TAG`, `ACR_LOGIN_SERVER`, and `IMAGE_REPOSITORY` can override that selection. Pushes use credentials already stored by the local Docker CLI and never run a registry login command.

The helper injects the generated version and UTC build time into the image. Query `GET /version` without authentication to identify a running deployment:

```json
{
  "service": "aoai-proxy",
  "version": "nextgen-202608100257",
  "buildTime": "2026-08-10T02:57:55Z"
}
```

The default version uses the UTC build minute in `nextgen-YYYYMMDDHHmm` format. The same values are available as standard OCI image labels.

The Dockerfile tracks the current stable major lines with `NODE_MAJOR=24` and `CADDY_MAJOR=2`, and pins `ALPINE_VERSION=3.24` so the Node dependency stage and minimal Alpine runtime use the same musl release. The runtime copies only the Node executable instead of retaining npm, Yarn, and build headers. The helper runs `docker buildx build --pull` so each build fetches the latest available patch/minor image in those version lines. A build without `--push` uses buildx `--load`; a combined build and push uses `--push` directly. Multi-platform output must be pushed because Docker cannot load a multi-platform manifest into the classic local image store.

The selected buildx builder must advertise every requested platform. Cross-building arm64 on an amd64 host normally requires QEMU/binfmt support. When calling buildx directly, pass the platform and build metadata:

```bash
docker buildx build --pull --load \
  --platform linux/amd64 \
  --build-arg NODE_MAJOR=24 \
  --build-arg ALPINE_VERSION=3.24 \
  --build-arg CADDY_MAJOR=2 \
  --build-arg AOAI_PROXY_VERSION=nextgen-202608100257 \
  --build-arg AOAI_PROXY_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
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
- Azure Database for PostgreSQL Flexible Server and a database child resource when `distributionProfile=nextgen` and `persistenceMode=database` or `persistenceMode=database+azureFile`
- An optional PostgreSQL `0.0.0.0` Azure-services firewall rule only when `allowAzureServicesToDatabase=true`
- A new storage account only when `persistenceMode=azureFile` or `persistenceMode=database+azureFile`
- Azure Files share when `persistenceMode=azureFile` or `persistenceMode=database+azureFile`
- Secure `CONFIG_DB_CONNECTION_STRING` injection into the container when `persistenceMode=database` or `persistenceMode=database+azureFile`
- Secure admin password and client API-key injection; the checked-in parameter files intentionally omit these values
- Caddy automatic HTTPS configuration with only port `443` exposed publicly; Node port `3000` remains internal for health probes
- RBAC assignment for `Cognitive Services OpenAI User` on the target Azure OpenAI resource

`distributionProfile=minimum` forces the effective deployment persistence mode to `azureFile`, so the same image is deployed without PostgreSQL resources. `distributionProfile=nextgen` preserves the selected `persistenceMode`.

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

Use [infra/azure_deployment_with_UI/README.md](infra/azure_deployment_with_UI/README.md) when you want the Azure Portal to use `createUiDefinition.json` and show the richer resource-selection UI.

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

- Azure Files walkthrough: [docs/deployment/aci-persistence.en.md](docs/deployment/aci-persistence.en.md)
- Chinese version: [docs/deployment/aci-persistence.zh-CN.md](docs/deployment/aci-persistence.zh-CN.md)

## Caddy TLS

Use the admin page to configure domain, email, upstream, and transport timeouts. Saving config regenerates the Caddyfile and attempts a hot reload.

When Caddy is already enabled and the container restarts, the app now treats the early boot period as `starting` instead of an error and retries the local `caddy reload` probe in the background until the Caddy process is ready.

If active health checks are enabled and `/healthz` is API-key protected, add a health header in Caddy or disable `health_uri` to avoid false 401/503 failures.

## Foundry v1 Notes

- Data plane path is `/openai/v1/*`
- `api-version` is optional; default behavior is v1
- Request `model` must be the deployment identifier

### Modern Model Compatibility

For models with the compiled `reasoning` capability, plus requests that explicitly carry protocol reasoning fields, the proxy applies a small set of request normalizations before forwarding to Foundry:

- `max_tokens` is upgraded to `max_completion_tokens` for reasoning `chat/completions` requests
- `top_logprobs` implies `logprobs: true` when the client omits it
- `reasoning_effort` and `reasoning.effort` are normalized to lowercase; model-specific aliases such as `xhigh` to `max` come from the Model Catalog
- `serviceTier` is normalized to `service_tier`; `service_tier`, `verbosity`, and `top_k` are preserved by default instead of being guessed from the model name
- Providers that reject optional fields can list them in `upstreams[].requestPolicy.blockedParams`; set `dropUnsupportedParams: true` to remove them, or leave it false to reject the request explicitly
- `web_search_preview` tool spellings are normalized to `web_search`; the upstream decides support unless an explicit request policy blocks the field

The proxy keeps `stream_options` on compatible native routes. When Chat is converted to Responses or Messages, it consumes `stream_options.include_usage` and emits the requested Chat usage chunk before `[DONE]`; unknown stream options follow the protocol-shim loss policy.

## Protocol Routing

The proxy exposes three text-generation protocols:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

The selected model route determines the upstream protocol. Matching protocol pairs use near-passthrough; mismatched pairs use explicit request, JSON response, and SSE conversion.

Upstream errors use the proxy's normalized error envelope by default. Set `upstreams[].errorPolicy.nativePassthrough` or a route profile's `nativeErrorPassthrough` to `true` only when a native protocol client needs provider-specific error bodies. This opt-in is limited to native routes and preserves safe response metadata such as `Content-Type`, `Retry-After`, and the proxy request ID; protocol shims and network failures remain normalized.

| Client protocol | Chat backend | Responses backend | Messages backend |
| --- | --- | --- | --- |
| Chat Completions | near-passthrough | convert | convert |
| Responses | convert | near-passthrough | convert |
| Anthropic Messages | convert | convert | near-passthrough |

Near-passthrough is semantic rather than byte-for-byte. The proxy still maps the model ID, applies request policy and media handling, replaces authentication headers, observes usage, and enforces stream timeouts. Native Responses preserves Responses items and events. Native Messages preserves ordered Anthropic blocks and SSE events, including tool use/results and thinking signatures present in the body.

Cross-protocol conversion covers text, input images, function tools, tool calls/results, token limits, stop reasons, usage, and streaming lifecycle events. Responses `reasoning.encrypted_content` is mapped to Anthropic thinking signatures in both directions, including streaming continuations. Protocol-unrepresentable core state is always rejected; other non-core fields without a safe equivalent follow the configured strict or best-effort loss policy.

`compatibility.protocolShim.rejectLossyRequests` and `rejectLossyResponses` both default to `false`. Best-effort conversions emit `proxy.protocol_shim_lossy_conversion` with the phase, field path, source/target protocols, and loss reason. Enable either strict switch only when rejecting a non-lossless conversion is preferable to continuing. The response switch applies to both JSON and SSE responses.

```json
{
  "compatibility": {
    "protocolShim": {
      "rejectLossyRequests": false,
      "rejectLossyResponses": false
    }
  }
}
```

Config normalization upgrades version 2 files to version 3. For GPT-5.6 Luna, Sol, and Terra only, the exact legacy template route `{ "*": "responses" }` is removed during that upgrade so Chat and Responses requests use their native interfaces. Other version 3 route overrides are preserved only when their targets remain allowed by the matched Catalog definition.

For Claude deployments in Microsoft Foundry, configure the upstream route as `messages: "/anthropic/v1/messages"`. The proxy automatically switches an Azure OpenAI resource host to `*.services.ai.azure.com`, injects `anthropic-version: 2023-06-01` when absent, uses `x-api-key` for key authentication, and uses the `https://ai.azure.com/.default` scope for AAD authentication.

Set `models[].hostingMode` to `azure` or `anthropic` when the matched Claude pricing template offers both hosting modes. This records the deployment infrastructure for region, data-handling, and capability metadata; it is not evidence of Responses support. The currently documented Azure-hosted and Anthropic-hosted Claude deployments both use Messages. Incoming Responses `reasoning.effort` is therefore converted to `output_config.effort` with `thinking.type="adaptive"`. A route override may select only an interface or transport target allowed by that hosting-resolved Catalog descriptor.

### Harness administration

The admin **Harness** tab manages Claude Code and Codex catalog membership without changing protocol routing. Its **Select models** dialog is a multi-select: current members appear checked, the status filter offers All models / Selectable - native protocol (default) / Selectable - needs conversion / Not selectable, and the dialog is searchable, with blocking reasons (non-text models such as image, video, speech/TTS, transcription/ASR, realtime and embedding models are always Not selectable, for both clients), and links to the relevant settings. Confirming applies all additions and removals together. Eligibility is static configuration validation, not a live connectivity or CLI compatibility test. Failed, loading or obsolete previews cannot authorize additions.

A model whose Model Catalog card has no native `responses` (Codex) or `messages` (Claude Code) interface, such as DeepSeek V4.1 Flash, can still be used when its upstream has that route configured: switching the member to native enables a Harness-owned native route override (`models[].clientNativeRoute.codex` / `.claudeCode`). While the model is a member, that route key resolves natively, ahead of `models[].routes` and the card's interface list; removing the model deletes the flag and the configured routes apply again. To connect such a model to Codex natively, add a `responses` route to its upstream (for example `/openai/v1/responses`), select the model in the Codex section (it is listed under **Selectable - needs conversion**, because an upstream route alone is not evidence that the provider supports it), click **Switch to native route** on the member card and save. The override is listed under **Selectable - native protocol** only when conversion is unavailable. The override applies to every caller of that public route for the model, and `models[].routes`, `upstreams[].routes` and the card are never rewritten. The admin form does not edit `upstreams[].routes`; add the route in the **Advanced JSON** tab. Connectivity with the real provider is not verified by the static check.

Native routing is preferred and recommended. When the upstream has no native endpoint (for example DeepSeek has no `/responses`), the model is listed under **Selectable - needs conversion**: selecting it writes `models[].clientConversion.<client>`, and `responses` / `messages` requests are converted by the protocol shim to the final route's protocol (for example Chat). Conversion keeps the shim's existing limits: Codex does not forward `prompt_cache_key`, `include`, `reasoning.summary`, `previous_response_id` or `custom` / `web_search` tools; Claude Code does not forward `thinking`, `metadata` or `cache_control`; `responses/compact` and `messages/count_tokens` are unavailable; dropped fields log `proxy.protocol_shim_lossy_conversion`. The category is unavailable while `compatibility.protocolShim.rejectLossyRequests` is enabled (reason `CONVERSION_BLOCKED_BY_POLICY`), and a converted member can be switched to the native route override once the upstream declares the route. The two categories follow configuration evidence: **native protocol** means the configured route already resolves to the client's protocol (Model Catalog interface or an active override), **needs conversion** means it does not but conversion is possible. Removing the model deletes the flag.

Draft additions/removals, saved members and the active publication state are shown separately. Use the normal **Review & Save** workflow; closing a catalog retains its members. Actual model visibility still depends on the caller's API key permissions. The diagnostics link checks the active configuration through the existing operations page, not the unsaved draft.

Each client has a connection guide: explicitly enter the public proxy root or `/v1` address, choose a selected eligible model, and copy the Bash/Zsh or Codex TOML template. Templates use a credential placeholder, never retrieve keys or make upstream calls, and should be merged rather than overwrite existing client settings.

Selected Codex models also expose draft/active catalog JSON and metadata sources. The advanced fields edit existing `models[].codex` overrides for context window, supported/default reasoning efforts, priority, description and base instructions. Blank fields inherit existing behavior; clearing displayed overrides preserves other fields. Comma-separated effort edits apply on blur. Default priority is the index after consumer filtering, so it may differ for restricted API keys. These controls change discovery metadata, not provider capability or request policy.

### Claude Code

The model endpoint negotiates Anthropic's model-list shape when the request contains `Anthropic-Version`, uses `format=anthropic` / `format=messages`, or has a Claude/Anthropic user agent. When the Claude Code catalog is enabled, a Claude Code User-Agent or `format=claude-code` returns only models explicitly selected in the Harness settings that resolve to native Messages; generic Anthropic SDK discovery retains the broader accessible model list. An explicit `format` takes precedence over User-Agent. Requests for a disabled client catalog return `ClientCatalogDisabled` instead of falling back to another format. Claude Code gateway model discovery can therefore be enabled:

```bash
export ANTHROPIC_BASE_URL="https://proxy.example.com"
export ANTHROPIC_AUTH_TOKEN="your-proxy-api-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

`compatibility.claudeCode.enabled` defaults to `true` and controls only publication of the Claude Code catalog. Messages header behavior is configured independently: `compatibility.anthropic.forwardSdkMetadataHeaders` safely forwards Claude/Anthropic and Stainless metadata prefixes while client credentials remain blocked, and `compatibility.anthropic.unknownBetaPolicy` controls whether direct Anthropic upstreams preserve unknown `anthropic-beta` values. Azure/Foundry upstreams use the reviewed allowlist; filtered values are recorded under `proxy.anthropic_betas_filtered`.

Select each production Claude Code model in the admin Harness tab and keep it on native Messages. Config load/save rejects a selected model whenever it is disabled, its upstream or public Messages route is disabled, or it no longer resolves to native Messages, even when catalog publication is disabled:

```json
{
  "clientCompatibility": { "claudeCode": true },
  "routes": { "*": "messages" }
}
```

Model IDs must be unique. This prevents discovery metadata and runtime routing from resolving the same public ID to different model entries.

The proxy enables three Foundry-specific Anthropic compatibility policies by default under `compatibility.anthropic`:

- `betaAllowlistEnabled`: forwards only reviewed beta tokens. Defaults include fine-grained tool streaming, interleaved thinking, and context management.
- `normalizeManualThinkingToolChoice`: changes forced `any` / named-tool choice to `auto` only for manual `thinking.type="enabled"`; adaptive thinking is unchanged.
- `sanitizeCacheControl`: retains valid ephemeral cache controls and the Foundry-supported `5m` / `1h` TTL values while removing unsupported fields or placements.
- `validateThinkingByModel`: validates `thinking.type` for Claude models whose capabilities are explicitly documented. Resolution checks the deployment name first, then the model ID and `pricingRef`; add a deployment-specific entry under `thinkingTypesByModel` to override the standard model profile. Thinking values not covered by an explicit strict policy remain pass-through.
- `effortLevelsByModel`: lists each Claude model's supported effort levels. Unsupported levels fail before the upstream call; `xhigh` is normalized to `max` only when the model supports `max` but not `xhigh`, matching the provider's documented equivalence.

These settings are request compatibility controls, not protocol selectors. A protocol change requires the matched Catalog definition and hosting mode to declare the target interface; compatibility switches cannot bypass that boundary.

### Codex

`compatibility.codex.enabled` also defaults to `true` and controls only publication of the Codex catalog. A `/v1/models` request using `format=codex`, carrying Codex's `client_version` query parameter, or coming from a Codex User-Agent receives Codex's `{ "models": [...] }` catalog rather than the standard OpenAI list. User-Agent detection is case-insensitive and based on normalized client keywords, so it does not depend on an exact header string, separator style, or client version. Explicit `format` takes precedence over the other signals. The catalog includes only models selected in the Harness settings that resolve natively to Responses and are text-generation models:

```json
{
  "clientCompatibility": { "codex": true },
  "routes": {},
  "codex": {
    "supportedReasoningEfforts": ["low", "medium", "high"],
    "baseInstructions": "You are a coding agent working in the user's current workspace."
  }
}
```

Codex context metadata resolves in this order: `models[].codex.contextWindow`, `models[].contextWindow`, the matched Model Catalog `contextWindow`, `maxInputTokens` when no total is known, then the legacy `128000` fallback. Models with configured or catalog token-limit metadata publish the complete context window, including input and output capacity, as both the current and maximum window with a 100 percent effective window. Set `models[].codex.contextWindow` only when a deployment-specific limit must replace the catalog value; values must be positive safe integers. Models without any configured or catalog limit retain the historical 128,000-token, 95-percent fallback.

Codex `0.153.2` requests `<base_url>/models?client_version=0.153.2` and requires each model entry to contain an instruction source. The proxy emits a concise default `base_instructions`; set `models[].codex.baseInstructions` to replace it with deployment-specific instructions. The query parameter selects only the response representation and never bypasses model access or Harness eligibility.

Configure Codex with a custom provider whose `base_url` ends in `/v1`, `wire_api = "responses"`, and `supports_websockets = false`. Marked Codex models are rejected by config validation if their Responses entry resolves through Chat or Messages conversion. Dual-protocol models should leave the wildcard route empty so non-Codex Chat clients retain native Chat Completions.

Streaming input accepts LF or CRLF SSE framing, multiple `data:` fields, and a terminal event without a trailing newline. A stream completes only after the source protocol supplies matching terminal evidence: Chat `[DONE]` or a final `finish_reason` at EOF, Responses `response.completed` or `response.incomplete`, and Anthropic `message_stop`. Responses `response.failed` and provider error events are terminal failures. The Responses rule is invariant and is not weakened when the Codex catalog is disabled. Premature EOF is reported as `UPSTREAM_INCOMPLETE_STREAM` and is never turned into a successful target terminator.

Parallel tool calls retain their indexes and stable call IDs across protocol conversion. Consecutive Responses function calls become one Chat assistant tool-call turn, argument deltas are buffered until the tool identity is known, and tool controls are omitted when no valid tools remain. HTTP 200 payloads that carry a provider-level failed status remain failures rather than empty successful completions.

Client cancellation propagates through upstream header waits, retry backoff, streaming reads, and non-stream response-body reads. Non-success error bodies are bounded and cancellation-aware, so a disconnected client does not leave an upstream request or retry loop running.

## Model Route Overrides

Use `models[].routes` when the client-facing route and backend-supported route differ.

The model must first bind to a Catalog definition. Source keys are `"*"` or Catalog interface names, and target values are limited to that model's hosting-resolved interfaces plus explicit Catalog transport targets. Direct paths and administrator-invented aliases are invalid; configure their concrete URL templates under `upstreams[].routes`.

```json
{
  "models": [
    {
      "id": "my-public-model",
      "upstream": "foundry",
      "targetModel": "my-deployment",
      "pricingRef": "gpt-5.6-luna",
      "routes": {
        "chat/completions": "responses"
      }
    }
  ]
}
```

Route a Claude deployment to its native Messages backend:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-6",
      "upstream": "foundry",
      "targetModel": "claude-sonnet-4-6",
      "clientCompatibility": {
        "claudeCode": true
      },
      "routes": {
        "*": "messages"
      }
    }
  ]
}
```

### Microsoft Model Router

The bundled `model-router` Catalog definition supports native Chat Completions and native Responses. Existing persisted model entries are not rewritten by a Catalog update. Remove any legacy wildcard such as `"*": "chat/completions"`; otherwise Responses requests will still be forced through the Chat shim.

For the complete Chat/Responses/Messages matrix, keep only the explicit Messages fallback:

```json
{
  "id": "model-router",
  "upstream": "foundry",
  "targetModel": "model-router",
  "pricingRef": "model-router",
  "routes": {
    "messages": "chat/completions"
  }
}
```

If Messages is not exposed, `"routes": {}` is sufficient for native Chat and Responses. The selected upstream must define both `chat/completions` and `responses` paths. Saving through the admin UI applies the change immediately. After editing the active `CONFIG_PATH` file directly, use the admin Reload action or restart the process. Container deployments default to `/app/data/config.json`; an existing persistent file is intentionally not replaced from the image default during startup.

## curl Examples

List models:

- `curl -sS http://127.0.0.1:3000/v1/models -H 'authorization: Bearer CHANGEME' | jq .`

Chat request:

- `curl -sS http://127.0.0.1:3000/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer CHANGEME' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"ping"}]}' | jq .`

Anthropic Messages request:

- `curl -sS http://127.0.0.1:3000/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H 'x-api-key: CHANGEME' -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"ping"}]}' | jq .`
