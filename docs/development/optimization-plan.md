# Reliability and Media Optimization Plan

## Scope and Constraints

- Preserve native request/response objects, SSE contracts, and independent conversion directions.
- Keep minimum and nextgen on the same baseline.
- Fix confirmed defects before adaptive compression or structural refactoring.
- Do not enable remote image downloading or change existing compression defaults.
- Follow each substantive change with its narrowest executable regression check.

## Implementation Closeout

- User instruction on 2026-09-07: finish remaining implementation, but defer final validation.
    Continue focused pre/post-edit checks; do not rerun the complete acceptance batch in this work period.
- The remaining phase 4 scope is finite: logging-content confirmation/synchronization, generic request
    policy decisions, and Messages-specific body compatibility decisions. Close these named responsibilities,
    regenerate deliverable admin assets and update documentation, then stop at the final validation gate.
- Keep JSON/SSE execution loops, directional converters, persistence and initialization diagnostics in their
    existing ownership boundaries. Further file-size-only refactors are not prerequisites for this plan.
- Phase 5 remains explicitly deferred. Remote fetching and adaptive production enablement are not authorized
    by this implementation closeout; real-image/load work belongs to the final acceptance gates below.

## Milestones

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Freeze the existing contracts and add failing regression tests | Complete |
| 1 | Media policy coverage, stalled downstream stream cancellation, Model Router pricing | Complete |
| 2 | Header allowlists, retry status policy, stale admin statistics responses | Complete |
| 3 | Opt-in adaptive image optimization, resource budgets, UI and observability | Engineering gates complete; real-image/load acceptance pending before production enablement |
| 4 | Deduplicate body readers, retry decisions and usage normalization; split large modules | Complete; final local unit/route/build/audit, isolated CLI and browser acceptance pass |
| 5 | Optional remote image fetching with a separate security design | Deferred; requires an explicit need |

## Validation Evidence

- Review baseline: 127 unit tests and 42 mock route contracts passed.
- Review baseline: admin production build passed with output in a temporary directory.
- Current workspace started clean.
- Media regression red baseline: all four original bypass cases failed before the repair.
- Media repair: 20 focused unit/integration checks passed, including zero upstream requests on rejection and native object preservation.
- Eight existing Messages-related JSON/SSE directional contracts passed before and after the media repair.
- Media handling now validates formal source/target image structures, preserves native Messages bytes, and ignores unrelated business fields.
- Stream repair: 27 focused checks passed across all nine directions, covering idle/max-duration cancellation, blocked socket cleanup and timeout classification.
- All 34 existing stream-focused unit contracts passed before and after the stream repair.
- Pricing repair: three Model Router cases failed before the repair; all four pricing regressions now pass, including direct-model override preservation.
- Unknown actual-model pricing now remains explicitly incomplete rather than reusing the router fee.
- Phase 1 gates passed: 178 unit/integration tests and all 42 mock route contracts.
- Phase 2 policy repair: 25 focused checks passed, including persisted configuration, all three native protocols in JSON/SSE mode, exact retry counts and native 429 error preservation.
- Admin runtime loading: four unit regressions passed for response ordering, delayed initial batches, filter snapshots and obsolete errors.
- Browser API-interception checks passed: late success and error responses for Key A cannot overwrite Key B, and a delayed initial secondary-data batch cannot overwrite newer statistics.
- Final gates passed: 207 unit/integration tests, all 42 mock route contracts, and `npm run build` (regenerated `public/admin-app/`).
- Editor diagnostics reported no errors. Runtime configuration and persistent data were not edited.
- Phase 3 red baseline: preservation and minimum-byte tests failed under legacy encoding; disabled compression passed.
- Phase 3: 31 image/media/queue tests passed, including EXIF orientation, alpha/animation preservation,
  savings fallback, per-request deduplication, decoder pixel fallback, cancellation and explicit budgets.
- Adaptive encoding now runs after governance admission and records metadata-only image decisions.
- Existing legacy enablement, native Messages preservation in legacy mode and remote URL passthrough remain unchanged.
- All nine adaptive directions pass JSON/SSE HTTP contracts, including final URL/body/auth, terminal events,
    zero-upstream budget rejection and no encoding after governance denial.
- Configuration persistence/validation passed, including legacy defaults and valid zero-valued limits.
- Admin production build passed. Desktop/mobile browser checks passed for modes, English/Chinese labels,
    saved configuration JSON, zero-valued settings and no horizontal overflow.
- The 12-sample-per-case synthetic benchmark passed; see [recorded baseline](image-optimization-baseline.md)
    for bytes, p50/p95, CPU/RSS, fidelity assertions and limitations.
- Final phase 3 gates: 242 unit/integration tests and 42 route contracts passed, plus production build,
    desktop/mobile browser checks, editor diagnostics and `git diff --check`.
- A hot-configuration queue-capacity regression failed before the local repair and now passes;
    waiting work remains bounded when concurrency settings change. Runtime config and data remain untouched.
- Phase 4 shared response reader: nine text/JSON contract checks plus three existing cancellation/size
    regressions passed before and after removing the duplicated JSON reader loop. Error codes and public signatures remain unchanged.
- A stalled upstream cancel promise reproduced size-limit hangs in both readers. Size rejection now
    requests cancellation without awaiting remote cleanup; all 11 reader tests and three existing checks pass.
- Shared retry decision extraction passed 64 reader/policy/backpressure checks. Explicit HTTP status
    lists, retry budgets and the existing SSE first-chunk boundary are preserved; execution loops remain separate.
- Internal usage normalization moved to `src/usage.js`, shared by governance and statistics only.
    Four ordinary protocol/cache cases passed before extraction; three regressions reproduced string
    concatenation, explicit-zero replacement and invalid counters in statistics. All seven now pass across
    global/model/key/actual-model buckets without mutating input usage; four pricing and five JSON/SSE usage checks also passed.
- Final phase 4 core gates: 261 unit/integration tests and all 42 route contracts passed; editor diagnostics
    and `git diff --check` passed. This slice changed backend logic/tests only, so frontend build/browser checks
    were not rerun; the recorded phase 3 checks still apply to the unchanged admin sources. Runtime config/data were not edited.

- Header extraction: `src/proxy/upstream-headers.js` owns assembly and beta filtering; authentication
    acquisition, final protocol resolution, logging and HTTP/SSE execution stay in their existing modules.
    The pre/post extraction baseline passed 45 focused tests plus two Anthropic route contracts.
- All 24 direct-module/HTTP header checks passed, including Bearer auth, immutability, correlation
    toggle/fallback, SDK blocking, version fallback, beta case/order and direct-provider/host boundaries.
- Final header-extraction gates: 285 unit/integration tests and all 42 route contracts passed; editor
    diagnostics and `git diff --check` passed. No frontend changes were made in this slice, so frontend
    build/browser checks were not rerun. Runtime configuration and persistent data were not edited.

- Media form extraction: five component contracts passed on the original `WorkspaceTab` and after
    extraction to `MediaPolicySection`. They freeze four mode states, section anchor/group, numeric zeros,
    list parsing, boolean update paths and hidden-setting preservation. The test fixture uses the same
    path setter as the application and feeds changes back into controlled inputs.
- React Testing Library and jsdom are development-only dependencies; Vite loads JSX for `node:test`.
    Editor diagnostics passed. Final gates passed: production build, 290 unit/integration tests and all
    42 route contracts. The build regenerated `public/admin-app/`; runtime configuration/data were not edited.
- Media browser checks passed at 1440x1000 and 390x844 with English and Chinese labels, no horizontal
    overflow, and mobile section navigation/accordion grouping intact. Two intercepted config PUTs through
    the review/save modal preserved numeric zeros, boolean/list values, exact paths and hidden legacy settings.
    Browser checks used fixture APIs only, not a live backend. Real upstream/CLI/database and real-image/load
    checks were not rerun for this UI-only extraction and remain deferred as documented below.
- Dependency audit reports three vulnerable packages: Fastify (moderate), PostCSS and nanoid (high).
    Their versions were not changed. The new test dependencies require an lru-cache patch update from
    11.5.0 to 11.5.2. No automatic audit remediation was applied in this component-extraction slice.

## Phase 4 Slices

| Slice | Status | Verification |
| --- | --- | --- |
| Shared response reading | Complete | 11 reader cases plus existing body/header/retry cancellation contracts |
| Pure retry decisions | Complete | Native JSON/SSE status policies, retry exhaustion, network policy and downstream-output boundary |
| Internal usage normalization | Complete | Protocol/cache counters, zero/string/invalid inputs, all statistics buckets and unchanged pricing |
| Upstream header assembly | Complete | Nine JSON/SSE directions and direct-module boundaries frozen; 285 tests and 42 routes pass |
| Admin media-policy form | Complete | Five pre/post contracts, 290 tests, 42 routes, production build and bilingual desktop/mobile save/layout checks pass |
| Admin routing-policy form | Complete | Seven pre/post routing contracts, 297 tests, 42 routes, build and bilingual desktop/mobile navigation/save checks pass |
| Dependency security maintenance | Complete | Zero audit findings after npm ci; 55 pre/post checks, 290 tests, 42 routes and unchanged production build pass |
| Logging content mode | Complete | Five direct checks, final 315-test suite and bilingual desktop/mobile confirmation/save acceptance pass |
| Generic request policy decisions | Complete | Six module checks, 26 policy checks and final 315-test/42-route batch pass; invocation order unchanged |
| Messages body compatibility decisions | Complete | Seven module checks, compatibility/header contracts and final unit/route/CLI batch pass |

## Logging Content Evidence

- `LogContentModeField` owns the existing summary/full control and confirmation. Its position, translation
    keys, confirmation text and both update paths/order are unchanged; initialization diagnostics stay in place.
- Five focused tests passed before and after extraction: defaults/options, canceled full mode, confirmed full
    mode with disabled remote sink, exit without confirmation and full-mode reentry. All 17 media/routing/log
    component checks and editor diagnostics pass. No logging runtime defaults or data were changed.
- Browser/save and full repository acceptance were deferred during implementation closeout, then passed
    after final validation was authorized; see the final batch below.

## Request Policy Evidence

- `src/proxy/request-policy.js` owns the original parameter filtering, route-profile key mapping,
    empty-tool control cleanup and image-generation policy. Invocation order, mutation rules, errors and
    explicit administrator drop/reject behavior are unchanged. Six direct module regressions pass.
- The 26 existing policy tests and parameter/tool routes passed before/after extraction; both image
    generation routes also passed. Empty allowlists remain unrestricted here, and the public model field
    remains exempt from field filtering. No capability-based rejection was added.
- `src/proxy/anthropic-policy.js` owns the original Messages thinking/effort and cache-control decisions.
    Seven direct regressions cover explicit model/deployment precedence, effort aliases, upstream authority
    over catalog suggestions, disabled policy flags, manual thinking controls and signed/redacted state.
- The three Messages/Claude compatibility routes passed before and after extraction. All 24 header/directional
    checks pass, including the nine client/upstream JSON/SSE combinations and recorded URL/body/header behavior.
- `src/proxy.js` still controls routing, policy order, governance, JSON/SSE execution and error dispatch.
    No retries, cancellation rules, directional converters, stream state machines or runtime defaults changed.
- Implementation and delivery documentation are complete. `npm run build` passed and regenerated
    `public/admin-app/` from the final admin sources. Touched-file editor diagnostics and `git diff --check`
    reported no errors; runtime configuration and data were not changed.
- Full repository/browser validation subsequently passed for the final combined baseline; see the final
    batch below. Real-service validation remains unverified and is not implied by local passing results.

## Routing Form Evidence

- `RoutingPolicySection` now owns the `workspace-routing` accordion with only `config`, `updateField`
    and `t` props. Section ID/group, placement after media, field order, defaults and save orchestration
    are unchanged. Backend routing and protocol policy code were not modified.
- Seven routing contracts passed before and after extraction: five list paths, beta policy options,
    eleven boolean paths/defaults, polling numeric zeros and disabled-route field preservation.
    This section has no conditional field hiding: disabled routes and beta filtering retain editable settings.
- The media suite's Vite/jsdom lifecycle and controlled-input renderer moved to a shared test helper;
    all five existing media contracts pass alongside the routing suite. No dependencies were added.
- Final gates passed: production build, 297 unit/integration tests and all 42 route contracts. Editor
    diagnostics and `git diff --check` passed. The build regenerated `public/admin-app/`; the preceding
    dependency maintenance changes were preserved, and no runtime configuration/data was edited.
- Browser checks passed in English and Chinese at 1440x1000 and 390x844: no horizontal overflow,
    desktop anchors and mobile select navigation preserve accordion grouping, and disabled routes retain
    editable policy fields. Screenshots were checked on desktop/mobile. Two intercepted config PUTs through
    the review/save modal preserved all routing/compatibility paths, booleans, numeric zero, ordered/case-sensitive
    lists and empty beta allowlists, without changing unrelated media settings.
- Browser APIs used fixtures only. Real upstream, CLI, database and real-image/load checks were not run
    for this UI-only extraction; their documented acceptance gates remain open.

## Dependency Maintenance Evidence

- The 2026-09-07 audit baseline reported Fastify (moderate), PostCSS and nanoid (high).
    Fastify is a runtime dependency. PostCSS and nanoid are the Vite build dependency chain;
    no direct application imports were found. This distinction does not make vulnerable versions safe.
- The current Fastify initializer does not enable its `trustProxy` hop-count option, and no root-primitive
    body schemas are registered. Application forwarding trust remains in `getRequestNetworkContext`;
    the dependency update does not change that explicit policy or add request rejection rules.
- The manifest now requires Fastify `^5.12.1`, covering both reported fixes. Compatible resolution locked
    Fastify 5.12.3, PostCSS 8.5.28 and nanoid 3.3.18. Only the required process-warning 5.0.0 -> 5.1.0
    also changed; no packages were added or removed, no overrides or new direct dependencies were introduced.
- `npm audit` reports zero vulnerabilities. Root and admin Vite resolution both use the updated build
    dependencies. All 55 request-policy/header/media-form checks and the request-body-limit route passed
    before and after upgrading. Manifest/lockfile diagnostics passed.
- Final gates passed after clean `npm ci`: zero audit findings, production build, 290 unit/integration
    tests and all 42 route contracts. Generated admin assets are byte-identical to the committed baseline,
    so browser layout/save checks were not rerun; the prior bilingual desktop/mobile evidence remains applicable.
    Manifest/lockfile diagnostics and the final diff check passed. No application source, runtime configuration
    or persistent data was changed. Real upstream, CLI, database and real-image/load checks were not run.

## Remaining Gates


- Phases 0-2 are frozen with focused regressions, zero-upstream media rejection assertions, full unit/route validation, and browser ordering checks.
- Dependency audit findings and maintenance regression gates are cleared as of 2026-09-07; this is not a guarantee against undisclosed vulnerabilities.
- Isolated Claude Code and Codex client contracts passed in final acceptance. Real upstream and real
    PostgreSQL checks remain unrun because authorized test endpoints/credentials and an isolated database
    connection are not configured. No live PostgreSQL container or host client is available.
- Real-photo/OCR quality, production-load memory and real-client disconnect timing remain unverified;
    only synthetic codec cost and unit cancellation semantics have been measured. Adaptive stays opt-in.

## Next Smallest Step

Local final acceptance is complete. Configure authorized real-upstream test environment variables privately
in the terminal, then run the documented real protocol matrix preflight before paid/model calls. An isolated
PostgreSQL test connection is separately required for live persistence acceptance. There are no remaining
implementation or artifact-generation tasks within the agreed scope. Do not start remote fetching or
additional structural slices.
Real-photo/OCR acceptance and deployment-sized load tests remain required before recommending adaptive enablement.
Keep existing compression defaults and remote URL passthrough unchanged. Synthetic photographic
texture is a repeatable codec stress fixture, not evidence of real-model visual/OCR accuracy.
Structural deduplication is complete in phase 4; it does not satisfy image quality or load acceptance.

## Final Validation Checklist

Final validation was authorized on 2026-09-07 after implementation closeout. The batch started from a clean
`aoai-nextgen` worktree at `8f61205`. Prior slice results above remain historical evidence, separate from this batch.

- [x] Run `npm ci` and `npm audit` against the final lockfile: clean installation passed, zero vulnerabilities.
- [x] Run `npm run build`, `npm run test:unit` and `npm run test:routes`: build passed, 315 tests passed with
    zero failures/skips, and all 42 route contracts passed.
- [x] Review final editor diagnostics and diff: no workspace diagnostics or whitespace errors; the rebuilt
    production assets are unchanged. Only this plan was modified, not application sources or runtime state.
- [x] In English and Chinese at desktop/mobile widths, check workspace section navigation, media/routing
    controls and review/save JSON paths and types with isolated fixture APIs. Check full-log cancellation,
    confirmation, exit and reentry, preserving both local and remote content-mode fields.
- [x] Run isolated CLI contracts: Claude Code 2.1.226 and Codex 0.153.2 passed, including native stream
    parsing, metadata/beta forwarding, model mapping/catalog caching and upstream credential isolation.
- [ ] Run real PostgreSQL checks with an isolated database. No test connection variables or host PostgreSQL
      client tools or running PostgreSQL containers are available; passing unit tests do not prove live persistence.
- [ ] Run documented real-upstream JSON/SSE and client-disconnect checks with authorized credentials and models.
      All documented `AOAI_PROXY_REAL_*` and required `AOAI_PROXY_MATRIX_*` connection/auth variables checked
      were absent. No real model request was sent and no existing runtime credentials were read.
- [ ] Complete real-photo/OCR quality and deployment-sized CPU/RSS/queue/load acceptance before recommending
    adaptive enablement. Keep it opt-in until that evidence exists.

## Final Browser And Image Evidence

- The freshly built production bundle was served by a temporary loopback-only preview. Every admin API
    request was intercepted by fixture handlers; configuration PUTs never reached the running proxy.
- English and Chinese at 1440x1000 and 390x844 passed logging, media and routing workflows. Twelve verified
    saves comprise eight full/summary logging saves and four combined media/routing saves. Twelve native
    confirmation prompts matched cancellation, acceptance and reentry expectations; leaving full did not prompt.
- Saved payloads preserve both content-mode fields, disabled remote logging, numeric zeros, ordered/case-sensitive
    lists, empty beta allowlists, all routing switches, hidden compression/remote settings and unrelated config.
    Disabled routes retain editable policy controls; legacy/preserve/adaptive field visibility remains correct.
- Final DOM checks assert the actual viewport dimensions, section navigation, no horizontal document overflow
    and no out-of-viewport controls for all three sections in all four combinations. No browser runtime errors
    were captured. Embedded screenshots were inspected, but the editor screenshot tool clips to its panel and
    resets viewport emulation; a complete full-width desktop screenshot was not archived. A distinct-size reset
    restored emulation before the final geometry assertions. No application changes were needed.
- `node test/benchmark-images.js` passed all preservation assertions: 15 mode/fixture combinations, 12 samples
    each. Adaptive PNG/transparent PNG/GIF remained byte-identical; synthetic JPEG savings were 92.94% and
    rotated JPEG savings 92.93%. Adaptive p95 was 62.94 ms / 79.24 ms respectively; per-12-sample CPU totals
    were 702.92 ms / 846.04 ms. Process RSS started at 86.72 MiB and peaked at 120.17 MiB.
- Benchmark environment: Node 24.16.0, Sharp 0.35.4, Linux x64, Xeon E5-2673 v4. This is a sequential synthetic
    preparation benchmark, not production load or visual/OCR accuracy evidence. Compression defaults and
    remote URL behavior remain unchanged; phase 5 remains deferred.