# Project Guidelines

## Source Of Truth

- [README.md](README.md): local startup, runtime configuration, and deployment. [Configuration guide](docs/configuration/feature-flags.zh-CN.md): setting defaults and reload/restart requirements.
- [Protocol support](docs/protocols/protocol-support.md): the 3x3 Chat/Responses/Messages matrix and compatibility boundaries. Treat public JSON, SSE, errors, and model discovery as wire contracts.
- [Model card guide](pricing/README.md): pricing, capabilities, protocol profiles, and route templates. [Test guide](test/README.md): focused suites and integration prerequisites.
- `minimum` and `nextgen` are runtime profiles on one baseline, not separate implementations. Both retain the protocol matrix and bundled/remote-updatable Model Catalog. Do not restore or hard-merge the old minimum branch.

## Protocol Invariants

- Prefer native passthrough. When client and upstream protocols match, do not route payloads through a lower-common-denominator representation; preserve native objects and raw SSE frames except for authentication, model mapping, safety, and explicit policy handling.
- Resolve the effective backend protocol from the final upstream URL. A configured route name alone is not sufficient.
- Preserve core semantics during conversion: public model mapping, system/developer instructions, ordered text, supported images, function tools, tool calls/results and IDs, output token limits, supported reasoning controls, stream intent, usage, and terminal reason.
- Prefer explicit field mapping, then safe extension passthrough. If the target protocol cannot carry a non-core field, use the configured best-effort loss behavior and emit `proxy.protocol_shim_lossy_conversion` rather than silently deleting it.
- Never silently drop or fabricate core state. Signed/redacted thinking, server-side conversation state, or another unrepresentable invariant must follow the explicit strict/loss policy.
- Do not reject a field merely because a capability catalog, host heuristic, or known provider version suggests the upstream may not support it. After protocol normalization, let the real upstream decide unless an explicit administrator policy, security boundary, or proven protocol invariant requires local rejection.
- Keep inbound credentials separate from upstream credentials. Credential-like and hop-by-hop headers remain blocked; protocol metadata headers may only follow their established allowlist.
- Keep `messages/count_tokens` native to Messages and `responses/compact` native to Responses. Validate their final URL suffixes; do not emulate them through another protocol.
- Require source-protocol terminal evidence for streams, retry only before downstream-visible output, and cancel upstream work when the client disconnects.
- Claude Code requires native Messages and Codex requires native Responses. Keep their model-discovery eligibility aligned with the final native route; generic shim support is not sufficient.
- HTTP audio/image edits, Realtime WebSocket, and WebRTC are independently gated and disabled by default in both profiles. WebRTC media bypasses the proxy; its in-process call registry requires a single instance or affinity, and client-secret export requires a separate administrator opt-in.

## Protocol Regression Workflow

- Use one named source -> target direction as the unit of change; conversion rules are not symmetric. Run its narrowest existing contract before changing shared validators, converters, or stream state.
- Freeze client output and upstream URL/body/headers with assertions. Cover JSON and SSE separately, including terminal/error behavior. Add a failing focused test before repairing a frozen direction; keep the repair directional.
- Rejection tests must identify a security, administrator-policy, unrepresentable-core-state, or actual-upstream boundary. Assert no upstream request for proxy preflight rejection; otherwise assert upstream receipt and preserved status/error semantics.
- Scope negative tests to one direction, phase, structure, and outcome. Add the nearest counterexample, not a global unsupported-field list. Broaden the matrix only for shared-code or shared-wire changes.

## High-Level Architecture

- [src/server.js](src/server.js) starts Fastify, configuration, authentication, the upstream HTTP pool, and Caddy integration. It exposes public routes/model discovery and the separately protected admin API.
- [src/proxy.js](src/proxy.js) orchestrates model resolution, governance, policy, upstream calls, and response dispatch. [routing.js](src/proxy/routing.js) resolves overrides and final URLs/protocols; [shim.js](src/proxy/shim.js) owns directional request/JSON conversion; [stream.js](src/proxy/stream.js) owns native SSE and shim state machines. Map public model IDs to `targetModel` upstream and restore them in successful responses; never use Chat as an intermediate for native Responses/Messages.
- Keep body cleanup in [body.js](src/proxy/body.js), configured field/tool/image-generation policy in [request-policy.js](src/proxy/request-policy.js), Messages thinking/effort/cache policy in [anthropic-policy.js](src/proxy/anthropic-policy.js), and header assembly/beta filtering in [upstream-headers.js](src/proxy/upstream-headers.js). The orchestrator decides when to apply them and logs filtered betas.
- [media.js](src/proxy/media.js), [realtime.js](src/proxy/realtime.js), and [webrtc.js](src/proxy/webrtc.js) own HTTP media, WebSocket forwarding, and WebRTC setup/control respectively, separate from text shims.
- [pricing/](pricing/) contains model protocol/routing facts as well as prices. [pricing-library.js](src/pricing-library.js) loads/syncs definitions; [model-catalog.js](src/model-catalog.js) compiles immutable descriptors shared by routing, discovery, normalization, and pricing. [model-validation.js](src/model-validation.js) checks bindings and client-native eligibility. Remote updates must validate a candidate, activate files/indexes/snapshot atomically, and retain the previous generation on failure.
- [persistence.js](src/persistence.js) stores configuration; [runtime-store.js](src/runtime-store.js) stores PostgreSQL events/rollups. [stats.js](src/stats.js) keeps in-memory counters and [governance.js](src/governance.js) enforces per-key access/limits; both use [usage.js](src/usage.js) for token totals.
- The React/Vite admin app's [App.jsx](admin-ui/src/App.jsx) owns editable config and review/save state. Fastify serves its built assets; the container copies them without rebuilding the UI.

## Configuration, Catalog, And Admin Conventions

- Configuration uses schema version 3. Defaults and normalization live in [src/config.js](src/config.js); keep [config/sample_config.json](config/sample_config.json), admin controls, and the [configuration guide](docs/configuration/feature-flags.zh-CN.md) aligned when adding settings.
- Environment overrides and profile restrictions apply to a runtime clone; saves must preserve environment-managed and profile-disabled persisted values. File edits require explicit reload. Only hot-reloadable settings take effect on save/reload; startup-only settings and environment changes require restart, as documented in the configuration guide.
- Every configured model must resolve a Catalog definition via `pricingRef`, public ID, or target model. `models[].routes` selects catalog-allowed interfaces or declared transport targets; concrete URL paths belong in `upstreams[].routes`. Keep provider-native `interfaces`/`capabilities` separate from explicit proxy-only `proxyAdapters`.
- Source model token limits independently and record `sources.limits`; never infer limits from names/prices. Preserve explicit zero counters and raw protocol usage; missing media usage/rates or incomplete sessions remain unknown/partial, not zero-cost success.
- Admin forms use `updateConfig`/`updateField` and [shared path helpers](admin-ui/src/utils.js); preserve hidden settings and numeric zeros. Add UI text to both dictionaries in [i18n.jsx](admin-ui/src/i18n.jsx).
- Use [api.js](admin-ui/src/api.js) for custom admin paths and the `x-aoai-admin-csrf` mutation header. Preserve [secret redaction/restoration](src/admin-config.js) so masked round trips do not overwrite credentials.

## Model Card Authoring

- Keep each active `pricing/*.json` self-contained; do not add family inheritance, cross-file references, or generated duplicates. Leave `pricing/archive/` unchanged unless explicitly updating an archived model.
- Store each token price once using canonical `*Per1mTokens` fields. Flat rates belong in `pricing`; whole-request rates belong only in `pricing.tiers`, with explicit `tiering`, contiguous integer bounds and independent rates per tier. Do not repeat the short tier at the root or add per-thousand copies. Keep media channel/hosting rates and non-token units distinct.
- Omit `pricingCatalogEntry` when it would duplicate `pricing`. Missing means use `pricing`; explicit `null` disables automatic text pricing and must not be removed. Keep a non-null entry only for a deliberate pricing override. Missing rates are not zero.
- `proxyTemplate: {}` opts into a template using the root `id`, `displayName` and `capabilities`; `targetModel` and `pricingRef` default to the root `id`. Store only differing fields such as deployment IDs and route overrides. Missing or `null` templates remain disabled; do not replace them with `{}`. Explicit empty arrays and transport routes are not disposable defaults.
- Use the shared [model-card defaults](src/model-card.js) in backend/admin consumers. Preserve legacy cards and config overrides; do not add another price/template fallback implementation.
- Keep independently sourced limits, protocol-specific parameter paths, hosting facts, evidence URLs, and provider/policy exceptions. Equal URLs may substantiate different facts; do not replace them with implicit references. New notes should explain caveats/provenance rather than duplicate structured prices or generic runtime behavior.
- Use two-space JSON, stable field ordering and compact short scalar arrays through `npm run cards:format`; `npm run cards:check` must pass. The tool operates on active cards only. Validate defaults/import/sync with `node --test test/model-card-format.test.js test/model-catalog.test.js test/pricing-sync.test.js` and pricing/route tests when changing semantics.
- Deploy the compact-card-aware runtime/admin before syncing compact cards to an older deployment. Existing persisted cards and explicit pricing overrides still take precedence; formatting does not migrate live configuration.

## Validation

Run from the repository root with Node.js 24 (the [Dockerfile](Dockerfile) default). Backend code/tests use ES modules; commands come from [package.json](package.json).

| Command | Purpose |
| --- | --- |
| `npm ci` | Install runtime and development dependencies. |
| `npm run build` | Build only the admin UI (alias for `build:admin`), not backend validation. |
| `npm start` | Start the Fastify backend with the active configuration. |
| `npm run dev` | Start the backend with Node's file watcher. |
| `npm run admin:dev` | Start the Vite admin development server; backend APIs are separate. |

Follow [local startup](README.md#local-run) for configuration and credentials. `CONFIG_PATH` defaults to `./config/config.json` locally and `/app/data/config.json` in the container.

Run the narrowest applicable check first. Select a focused `node --test` suite from [test/README.md](test/README.md), a single named test, or a route ID from [test/lib/route-definitions.js](test/lib/route-definitions.js):

```bash
node --test test/model-catalog.test.js
node --test --test-name-pattern='Model Catalog compiler rejects ambiguous aliases' test/model-catalog.test.js
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("message-to-response")'
```

Mock routes use disposable proxies and temporary configs through [test/lib/harness.js](test/lib/harness.js), never the running service. Admin media/routing/log-content form tests share [admin-workspace-form.js](test/lib/admin-workspace-form.js): `node:test`, React Testing Library, jsdom, and Vite JSX transformation, with no backend or credentials. Browser layout/save/reload checks are separate.

After focused code checks pass, run:

```bash
npm run test:unit
npm run test:routes
```

Run CLI, real-upstream (including `npm run test:real:matrix`), and latency checks only with their [documented prerequisites](test/README.md). Record unrun checks; mocks do not establish live-provider or deployment acceptance.

## Worktree And Generated Files

- Inspect `git status --short --branch` before editing. Preserve unrelated staged or unstaged user changes.
- Follow the [Git workflow](docs/development/git-workflow.zh-CN.md): commit changes to `aoai-nextgen` first, then promote validated commits to `master`; no master-only implementation commits.
- Do not manually edit runtime state in `config/config.json`, `data/`, the root `Caddyfile`, or `test/output/` unless explicitly requested.
- Edit [admin-ui/](admin-ui/); `npm run build` regenerates [public/admin-app/](public/admin-app/).
