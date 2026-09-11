# Project Guidelines

## Source Of Truth

- Treat public request/response objects, SSE frames, errors, and model catalogs as wire contracts.
- Keep the bundled Model Catalog, runtime compilation and lookup, and remote atomic catalog updates in both `minimum` and `nextgen`.
- Use [protocol support](docs/protocols/protocol-support.md) for protocol semantics, compatibility boundaries, and the 3x3 Chat/Responses/Messages matrix.
- Use the [model card guide](pricing/README.md) for pricing fields, capabilities, and route templates; preserve atomic catalog activation and retain the previous generation on update failure.
- Use [test/README.md](test/README.md) for focused, CLI, real-upstream, and latency test prerequisites.
- Use [README.md](README.md) for runtime and deployment configuration, and the [Git workflow guide](docs/development/git-workflow.zh-CN.md) for branch/worktree operations.
- Use the [configuration guide](docs/configuration/feature-flags.zh-CN.md) for defaults and reload behavior, and the [documentation index](docs/README.md) for deployment and observability guides.
- Keep `minimum` and `nextgen` as scope profiles on the same code baseline. Do not restore long-lived feature branches or hard-merge the old minimum branch unless explicitly requested.

## Protocol Invariants

- Prefer native passthrough. When client and upstream protocols match, do not route payloads through a lower-common-denominator representation; preserve native objects and raw SSE frames except for authentication, model mapping, safety, and explicit policy handling.
- Resolve the effective backend protocol from the final upstream URL. A configured route name alone is not sufficient.
- Treat each cross-protocol direction independently. A successful Chat -> Messages rule does not imply the reverse rule or another target is equivalent.
- Preserve core semantics during conversion: public model mapping, system/developer instructions, ordered text, supported images, function tools, tool calls/results and IDs, output token limits, supported reasoning controls, stream intent, usage, and terminal reason.
- Prefer explicit field mapping, then safe extension passthrough. If the target protocol cannot carry a non-core field, use the configured best-effort loss behavior and emit `proxy.protocol_shim_lossy_conversion` rather than silently deleting it.
- Never silently drop or fabricate core state. Signed/redacted thinking, server-side conversation state, or another unrepresentable invariant must follow the explicit strict/loss policy.
- Do not reject a field merely because a capability catalog, host heuristic, or known provider version suggests the upstream may not support it. After protocol normalization, let the real upstream decide unless an explicit administrator policy, security boundary, or proven protocol invariant requires local rejection.
- Keep inbound credentials separate from upstream credentials. Credential-like and hop-by-hop headers remain blocked; protocol metadata headers may only follow their established allowlist.
- Keep `messages/count_tokens` native to Messages and `responses/compact` native to Responses. Validate their final URL suffixes; do not emulate them through another protocol.
- Require source-protocol terminal evidence for streams, retry only before downstream-visible output, and cancel upstream work when the client disconnects.

## Direction Freeze Discipline

- Use one named source -> target direction as the unit of change. Do not modify unrelated conversion directions to make one case pass.
- Before changing shared validators, converters, or stream state, run the narrowest existing contract for the affected direction and record what currently passes.
- Once a direction passes, freeze its client wire output and recorded upstream URL, body, and headers with regression assertions. Later work must rerun that contract and preserve it unless the task explicitly changes that direction's contract.
- Add a failing focused test before changing an already frozen direction. Keep the repair local; avoid broad shared rewrites when a directional adapter or policy rule can express the behavior.
- JSON and SSE are separate contracts for the same direction. A direction is not frozen until both applicable forms and their terminal/error behavior are covered.

## Negative-Test Boundaries

- Define the intended boundary before adding a rejection test: security, explicit administrator policy, protocol-unrepresentable core state, or actual upstream rejection.
- Keep each negative test scoped to one direction, phase, structure, and expected outcome. Do not grow global unsupported-field lists from a single provider example.
- For proxy-owned preflight rejection, assert that no upstream request was made. For upstream capability behavior, assert that the request reached the mock upstream and preserve the upstream status/error semantics.
- Add only the nearest counterexample needed to protect the boundary. Broaden the matrix only when shared code or shared wire behavior changed.

## Module Boundaries

- `src/server.js`: route registration, public model catalogs, and admin HTTP surface.
- `src/proxy/routing.js`: route overrides, final protocol reconciliation, upstream URLs, and native utility URLs.
- `src/proxy.js`: request orchestration, native/shim selection, policy application, upstream calls, and JSON response dispatch.
- [src/proxy/body.js](src/proxy/body.js): body cleanup, proxy controls, and media input handling.
- [src/proxy/request-policy.js](src/proxy/request-policy.js) and [src/proxy/anthropic-policy.js](src/proxy/anthropic-policy.js): configured field/tool/image-generation policy and Messages thinking/effort/cache policy, respectively.
- [src/proxy/upstream-headers.js](src/proxy/upstream-headers.js): upstream header assembly and beta filtering; the orchestrator resolves backend/auth and logs filtered betas.
- `src/proxy/shim.js`: directional compatibility analysis, request converters, and JSON response mappers.
- `src/proxy/stream.js`: native SSE observation/passthrough and cross-protocol stream state machines.
- `src/config.js` and `src/model-validation.js`: defaults, normalization, validation, and client-native route gates.
- [src/model-catalog.js](src/model-catalog.js): model card compilation, immutable snapshots, lookup, and candidate validation.
- [src/usage.js](src/usage.js): internal governance/statistics usage normalization; preserve explicit zero counters and the original protocol usage object.
- `test/lib/route-definitions.js` and `test/proxy-safety.test.js`: route contracts and focused protocol/unit regressions.
- Keep adapters and validators small and directional. Do not use Chat as an intermediate format for native Responses or Messages semantics merely for code reuse.

## Validation

Install development dependencies and build the admin UI with:

```bash
npm ci
npm run build
```

`npm run build` builds only the admin UI; it does not validate the backend. Runtime and tests use Node.js ES modules, with scripts defined in [package.json](package.json).

Run the narrowest applicable check first. Select a focused `node --test` suite from [test/README.md](test/README.md), or a route ID from [test/lib/route-definitions.js](test/lib/route-definitions.js), for example:

```bash
node --input-type=module -e 'import { runRouteTestById } from "./test/lib/run-route-test.js"; await runRouteTestById("message-to-response")'
```

Mock route tests use disposable proxy processes and temporary configs; do not point them at the running service. Admin component tests need development dependencies but no browser, backend, or credentials; browser layout and save/reload checks remain separate.

After focused checks pass for code changes, run:

```bash
npm run test:unit
npm run test:routes
```

Run CLI contracts, real-upstream tests (including `npm run test:real:matrix`), and latency checks only when their [documented prerequisites](test/README.md) are available. Record checks not run; mock or synthetic checks do not establish real-upstream or deployment acceptance. There is no generic `npm test` script.

## Worktree And Generated Files

- Inspect `git status --short --branch` before editing. Preserve unrelated staged or unstaged user changes.
- Do not manually edit runtime state in `config/config.json`, `data/`, the root `Caddyfile`, or `test/output/` unless explicitly requested.
- Edit admin sources under `admin-ui/`; `npm run build` regenerates `public/admin-app/`.
- Keep changes compact and within the owning module so a route, conversion, or stream failure can be debugged independently.
