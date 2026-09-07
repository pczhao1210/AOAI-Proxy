# Reliability and Media Optimization Plan

## Scope and Constraints

- Preserve native request/response objects, SSE contracts, and independent conversion directions.
- Keep minimum and nextgen on the same baseline.
- Fix confirmed defects before adaptive compression or structural refactoring.
- Do not enable remote image downloading or change existing compression defaults.
- Follow each substantive change with its narrowest executable regression check.

## Milestones

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Freeze the existing contracts and add failing regression tests | Complete |
| 1 | Media policy coverage, stalled downstream stream cancellation, Model Router pricing | Complete |
| 2 | Header allowlists, retry status policy, stale admin statistics responses | Complete |
| 3 | Opt-in adaptive image optimization, resource budgets, UI and observability | Engineering gates complete; real-image/load acceptance pending before production enablement |
| 4 | Deduplicate body readers, retry decisions and usage normalization; split large modules | Core/header and media form slices verified; further decomposition pending |
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
| Remaining request orchestration and admin module decomposition | Pending | Split one independently testable responsibility at a time; preserve directional and UI contracts |

## Remaining Gates


- Phases 0-2 are frozen with focused regressions, zero-upstream media rejection assertions, full unit/route validation, and browser ordering checks.
- Dependency audit: three existing package findings remain open; assess affected usage and remediate in a separate bounded maintenance slice.
- Real upstream, CLI client and real PostgreSQL checks have not been run; use their documented prerequisites.
- Real-photo/OCR quality, production-load memory and real-client disconnect timing remain unverified;
    only synthetic codec cost and unit cancellation semantics have been measured. Adaptive stays opt-in.

## Next Smallest Step

Triage the Fastify, PostCSS and nanoid audit findings before the next structural extraction. Establish
affected usage and the smallest dependency update, then verify its focused contract plus build/unit/route gates.
After that maintenance slice, the next UI candidate is the routing-policy form in `WorkspaceTab`, using
the component test setup to freeze field paths and controls before extraction. Keep existing UI layout intact.
Leave JSON/SSE execution loops and directional converters independent; further request-orchestration
decomposition remains a later slice.
Real-photo/OCR acceptance and deployment-sized load tests remain required before recommending adaptive enablement.
Keep existing compression defaults and remote URL passthrough unchanged. Synthetic photographic
texture is a repeatable codec stress fixture, not evidence of real-model visual/OCR accuracy.
Structural deduplication remains phase 4, not part of this image milestone.