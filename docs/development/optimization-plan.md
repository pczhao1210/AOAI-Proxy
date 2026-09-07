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
| 3 | Opt-in adaptive image optimization, resource budgets, UI and observability | Pending |
| 4 | Deduplicate body readers, retry decisions and usage normalization; split large modules | Pending |
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

## Remaining Gates

- Phases 0-2 are frozen with focused regressions, zero-upstream media rejection assertions, full unit/route validation, and browser ordering checks.
- Real upstream, CLI client and real PostgreSQL checks have not been run; use their documented prerequisites.
- Adaptive compression quality and performance have not been measured.

## Next Smallest Step

Phase 3: establish photo, text-screenshot, transparency and animation fixtures plus resource/quality
baselines before adding opt-in adaptive behavior. Keep existing compression defaults and remote URL
passthrough unchanged. Structural deduplication remains phase 4, not part of these six defect repairs.