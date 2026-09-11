# MAI Inference and Voice/Realtime Implementation

Approved: 2026-09-11. This document tracks implementation, not a declaration
that all listed endpoints are available. Preserve native wire contracts and
the existing Chat/Responses/Messages matrix in both scope profiles.

## Scope

- MAI Image generation/editing and MAI Thinking native Chat JSON/SSE.
- OpenAI and Azure OpenAI speech, file transcription/translation and Realtime
  conversation/transcription/translation, verified separately by hosting mode.
- MAI Voice and MAI Transcribe use Azure Speech, not `/mai/v1/audio/*`.
  Standard audio compatibility and separately authorized native Speech routes.
- WebSocket full relay; WebRTC session setup/control only, media and data
  channel connect directly to the provider.
- Default WebRTC flow: server-created calls. Upstream client secret export is
  administrator opt-in: secrets can create multiple sessions, settings can be
  overridden, and secret expiration does not terminate existing sessions.
- No SIP, GPT-Live, custom voice management, transcoding, automatic long-file
  splitting, cross-protocol realtime conversion or self-hosted WebRTC media.
- Initial call bindings require a single instance or session affinity. Do not
  introduce a mandatory database or claim distributed concurrency enforcement.

## Milestones

| Phase | Work | Status |
| --- | --- | --- |
| P0 | Exact endpoint/encoding/auth contracts and existing focused baseline | Baseline passed; provider-specific evidence gates below remain open |
| P1 | MAI final URL routing, catalog/templates, Thinking native encrypted state | Mock acceptance passed; live provider checks not run |
| P2 | Scoped multipart parsing, binary/text/SSE relay; OpenAI audio and MAI edits | Mock transport and known-cost accounting passed; live acceptance pending |
| P3 | Azure Speech native and OpenAI-compatible adapters | Mock acceptance passed, including cards/templates; live/Entra acceptance pending |
| P4 | Realtime WebSocket handshake, relay, session modes and lifecycle | Mock backpressure/shutdown and independent-model accounting passed; local Caddy passed; live acceptance pending |
| P5 | WebRTC calls, guarded client secrets, ownership-bound sideband/hangup | Core mock contracts passed; live/provider-specific control acceptance pending |
| P6 | Usage/leases, admin controls, documentation and release gates | Local known-cost settlement, PostgreSQL/Caddy, full tests/build, CLI and admin display gates passed; live/deployment acceptance pending |

## Responses Speech Extension (2026-09-11)

Approved follow-up: keep currency configuration permissive; price and budget numbers
are USD units, sum known charges and display USD. No FX, currency lock or historical
ledger migration. Existing historical amounts are not retroactively verified by this
unit convention. Missing media price/usage stays unknown.

| Phase | Work | Status |
| --- | --- | --- |
| D0 | Freeze existing accounting, MAI and Speech contracts | 53 focused tests passed |
| D1 | USD numeric settlement and single subtotal display | 18 accounting/router tests and 21 accounting/admin tests passed |
| D2 | Explicit Responses adapter binding and inline Transcribe | 45 native/media/catalog tests and 34 adapter boundary/catalog/pricing tests passed |
| D3 | Voice completed tool/file result with bounded buffering | Three formats, errors, bounds, privacy, disconnect/timeout and single settlement passed in the 6-test Speech suite |
| D4 | Documentation and admin integration | Protocol examples, USD units and bounds documented; actual EN/ZH hints and editable currency save/reload verified |
| D5 | Focused/full regression, build and optional integrations | Final 386 unit tests, 42 routes, build126, diagnostics/diff, PostgreSQL2 and browser gates passed; external acceptance remains open |

Responses compatibility is additive: native audio/Speech and MAI Thinking/Image
remain unchanged. Explicit catalog adapter metadata selects the physical Speech
route after model authorization. Transcribe receives one inline file and returns
output_text; Voice returns a completed tool call/file result pair that clients must
decode. No extra LLM, generic tool executor, file store, URL fetch or SSE in this
phase. Each request has one media lease and settlement. Real Speech/Entra/pricing
and client playback remain independent external gates.

Final delta evidence:
- `npm run test:unit`: 386 passed, zero failures/skips, rerun after the final
  Chinese translation override fix. `npm run test:routes`: 42 passed.
- `npm run build`: 126 modules; touched-file diagnostics and `git diff --check`
  clean. Four modified docs / 17 local links valid. All 91 bundled model cards
  have no non-USD rate currency labels; this is not live pricing verification.
- Disposable loopback PostgreSQL16: two tests passed, including known/unknown
  amounts, legacy-label independence, filtering and budget hydration. Container
  removed; no production data or historical currency migration.
- Actual isolated admin: EN/ZH at 1440/390px show `0.0060 USD + Unknown` (localized),
  without document overflow or double counting. Currency EUR -> GBP is editable,
  saves with HTTP200, survives reload, and does not change USD totals. Screenshots
  and final Chinese pricing hint verified. Preview uses mock fixtures only.
- Not rerun for this delta: pinned CLI contracts, optional generated Caddy,
  real-upstream matrix, paid latency/load and deployment tests. Prior P6 evidence
  below is historical; its mixed-currency presentation was superseded by D1.
- No OpenAI SDK is installed. SDK parsing/client audio playback, actual MAI Speech
  region/model/formats/errors, Entra, verified rates and deployment acceptance
  remain external gates. No live runtime config edits or paid provider calls.

Next smallest step: with an isolated endpoint, credentials supplied outside chat,
a short lawful WAV fixture and cost authorization, run one real MAI-Transcribe-2
request; then verify Voice file extraction/playback in the target SDK/client.

## Contracts and Ownership

- `src/proxy/routing.js`: final URL and provider path selection. MAI images use
  `/mai/v1/images/generations`; Thinking uses `/mai/v1/chat/completions` on the
  Foundry services endpoint. Respect explicit administrator overrides.
- `src/server.js` / `src/proxy.js`: new scoped media/upgrade dispatch; retain
  existing JSON/SSE orchestration. Do not make all bodies raw or multipart.
- `src/proxy/body.js` / `upstream-headers.js` / `src/auth.js`: inbound/upstream
  credential isolation. Speech subscription keys use typed upstream auth,
  never a relaxation of credential-like header filtering.
- Catalog/profile additions remain backwards compatible; candidate updates
  activate atomically and retain the previous snapshot on failure.
- P2 uses bounded multipart parsing with file-before-model support, immutable
  file bytes, ordered fields, unique routing controls and upload limits.
  Binary responses use backpressure/cancellation, not JSON parsing. No retries
  for consumed/non-replayable bodies or downstream-visible output.
- P3 maps plain input safely to SSML and uses explicit native voice names or
  administrator aliases. Transcribe uses `audio` and `definition`, including
  `enhancedMode.model`. Do not invent timestamps, formats or streaming results.
- P4 distinguishes `/realtime` transcription sessions from the separate
  `/realtime/translations` protocol. Handle nested transcription model mapping,
  bounded initial configuration, authorization before upstream audio, native
  event/error/terminal behavior, backpressure and exactly-once lease release.
- P5 stores principal, public model, upstream/profile, call ID, expiry and
  usage state. Unknown/foreign call IDs fail closed. A sideband disconnect is
  not a media-call termination. Existing calls retain their routing snapshot.
- P6 separates tokens/duration/bytes and primary/sideband accounting. Missing
  usage or price is unknown, not zero. Direct WebRTC cannot guarantee inline
  policy enforcement or exact hard budgets. Do not log secrets, SDP, raw media
  or opaque encrypted reasoning even when full content logging is enabled.

## Evidence Gates

- MAI Image/Thinking provider paths confirmed in their Microsoft Learn guides.
- MAI Voice uses `/cognitiveservices/v1` (SSML to audio); MAI Transcribe uses
  `/speechtotext/transcriptions:transcribe?api-version=2025-10-15` (multipart to
  synchronous JSON). Verify exact result shape and each output format before
  freezing a compatibility mapping.
- Azure dated file transcription/translation has `2024-10-21` evidence. The
  speech operation found during planning is `2025-04-01-preview`; reconcile
  the operation's encoding examples before publishing a default template.
- Azure Realtime GA uses `/openai/v1`; deprecated preview paths are not new
  defaults. Verify Azure WebRTC transcription/translation and each Entra
  audience independently. Model availability is not endpoint acceptance.
- Incomplete provider evidence limits support claims/default templates, not
  native passthrough via a new global unsupported-field list.

## Validation and Progress

2026-09-11:

- Implementation started from a clean `aoai-nextgen` worktree.
- P0 baseline: `node --test test/model-catalog.test.js test/image-routes.test.js
  test/upstream-headers.test.js test/auth.test.js`: 63 passed, zero failures.
- Added MAI full route-plan regression; confirmed failure at the wrong
  `.openai.azure.com/openai/deployments/...` URL before repairing routing.
- After repair: `node --test test/model-catalog.test.js`: 18 passed.
- Legacy bindings, explicit overrides, template generation and Thinking card:
  `node --test test/model-catalog.test.js`: 21 passed.
- Native Image/Thinking process contracts: `node --test test/mai-routes.test.js`:
  8 passed. Frozen URL, deployment, credential isolation, extension fields,
  JSON/SSE, public model mapping, usage, tool messages, safety error plus DONE,
  truncated streams and full-log encrypted-state privacy.
- Regression reproduced that meaningless-value cleanup removed null fields
  from encrypted assistant messages; preserve these complete Chat messages.
- Encrypted content log test failed before permanent redaction; six focused
  content-snapshot tests now pass without mutating the wire message.
- P1 full gates: `npm run test:unit` 329 passed; `npm run test:routes` all
  42 routes passed; `npm run build` succeeded. Changed source diagnostics clean.
- P2: opt-in speech, transcription, translation and MAI multipart edits now
  preserve binary bytes, field ordering, native errors and source SSE terminals.
  Upload buffering has bounded per-request and process-wide reservations;
  response relay has byte limits, backpressure, cancellation and idle deadlines.
- P2 focused: `node --test test/media-http.test.js` 16 passed, including
  cancellation/timeout lease cleanup, content-header isolation, default limits
  and model/token/budget rejection without upstream calls. Temporary unmetered
  admission blocks keys with TPM or monetary budgets; post-hoc P6 settlement does
  not implement admission reservations or hard caps.
- MAI edits plus P1/catalog freeze: `node --test test/mai-routes.test.js
  test/model-catalog.test.js` 30 passed. Includes new and legacy MAI bindings.
- Resumed P3 from its failing tests: Speech paths were unknown to the route
  validator. Added exact final-path recognition and verified the unknown-path
  counterexample. Existing upstream credential filters remain unchanged.
- P3 core: `node --test test/azure-speech.test.js` 2 passed. Native SSML and
  multipart plus OpenAI-compatible TTS/transcription preserve audio bytes and
  subscription-key isolation. SSML model binding and entity rejection covered.
- P3 negative/result contracts: 3 passed, including unknown/null result shapes,
  multi-voice ownership, external entities, native provider 429 and retry-after,
  duplicate transcription definitions and strict-loss rejection before upstream.
- Added MAI-Voice-2, MAI-Voice-2-Flash and MAI-Transcribe-2 model cards. Catalog
  templates require route identifiers, not URLs; use dedicated Speech aliases
  with exact default paths. Unknown prices remain null. Template/default path
  contracts passed for all three cards, including an explicit Speech base URL.
- P1-P3 focused regression: 54 passed. Full gates: `npm run test:unit` 351
  passed; `npm run test:routes` all 42 passed; `npm run build` succeeded.
- P4: installed `ws`; reproduced the missing Upgrade handler as HTTP 404.
  Native OpenAI/Azure conversation and translation handshakes now isolate
  upstream credentials, map public models and preserve unmodified event bytes.
- Transcription uses `/realtime?intent=transcription`, not a fabricated path.
  An authenticated, leased, bounded waiting state accepts a first `session.update`
  selecting the authorized model before opening the upstream. Clients that wait
  for `session.created` must supply a public `model` query; no event is fabricated.
- Added `jsonc-parser` after reproducing numeric precision loss during model
  mapping. Only model value ranges are rewritten; ambiguous routing fields are
  rejected. Native errors and handshake status/body/retry-after are preserved.
- P4 focused: `node --test test/realtime.test.js` 8 passed. Includes independent
  response/transcription/translation terminals, out-of-order transcription
  completion, incomplete-stream closure, model/metering guards, payload limits,
  idle/session deadlines and connection-scoped concurrency release.
- P4 full backend gates: `npm run test:unit` 359 passed;
  `npm run test:routes` all 42 passed. Changed source diagnostics clean.
- P5 conversation setup/control: `node --test test/webrtc.test.js
  test/realtime.test.js` 10 passed. OpenAI multipart and Azure internal-secret
  plus raw SDP flows are independent. Sideband/hangup require a stored owner;
  routing reload retains the creation snapshot and sideband disconnect does not
  release the media-call lease. Foreign control fails before any upstream call.
- A failed ownership regression exposed the existing `req.proxyAccess.consumer`
  wrapper; corrected the integration and added missing-owner checks in the
  registry. Secret export is still disabled while its focused contract is added.
- P5 expanded contracts now include administrator-opt-in secret export, bounded
  TTL, direct-media policy guards, transcription/translation setup, untrusted
  Location, upstream errors/timeouts and setup capacity recovery. Unconfirmed
  expiry hangup retains the lease; the owner can retry control after expiry.
  Full-content log tests preserve SDP and internal-secret privacy.
- P4/P5 focused: 14 passed. Full gates: `npm run test:unit` 365 passed;
  `npm run test:routes` all 42 passed. P6 starts with observed usage normalization
  and duplicate/cumulative accounting, keeping unsupported pricing unknown.
- P6 usage observation preserves raw usage, explicit zeros, audio/text/cached
  tokens, reported duration and character counts. Per-call response/item IDs
  deduplicate sideband reconnects; cumulative snapshots record increments only.
  At this initial milestone costs remained unknown; the pricing and persistence
  follow-up below adds known-cost settlement. TPM/budget admission stays fail-closed.
- Added independent HTTP/WS/WebRTC admin switches and limits, confirmation for
  raw credential export, and native routing templates for three Realtime cards.
  Resumed focused baseline: usage, admin media, catalog, WS and WebRTC: 53 passed.
- Added default-off transport sections to the sample config; structured comparison
  matches all three runtime defaults. Protocol, configuration, README and test
  documentation now describe actual encoding, auth, ownership/restart limitations
  and independent live gates. Local documentation links and diagnostics pass.
- Added WS slow-consumer tests in both directions: buffer-limit close 1009 and
  subsequent capacity recovery. SIGTERM closes active, awaiting-configuration and
  awaiting-upstream-handshake connections; process exits 0. Both new tests passed.
- Full-suite cancellation test exposed an intermittent Undici FormData EPIPE when
  an upload-capacity 429 preceded remaining body writes. The lifecycle test now
  pre-encodes multipart with the standard Request API; no runtime behavior change.
  Media suite: 18 passed. Streamed multipart fidelity remains independently tested.
- Prior full gates: `npm run test:unit` 373 passed; `npm run test:routes` all 42
  passed. `npm ci` audit: zero vulnerabilities; `npm run build` succeeded (126 modules).
- Integrated browser used a disposable harness proxy and mock, not running config:
  three transport gates default off; export confirmation cancellation stays off;
  six changed paths reviewed/saved (200), stored config reloaded (200), values
  verified through the admin API and reloaded controls. English/Chinese layout at
  1440 and 390 px: 44 visible controls and labels without horizontal overflow.
  Screenshot inspection covered the media panel; it is not a real audio test.
- P6 settlement follow-up: added explicit token-channel/cache, duration and character
  pricing. Each response/item retains its price snapshot; unknown/mixed-currency
  totals stay null and known subtotals remain separate. OpenAI official rates are
  not automatically applied to Azure. Explicit model/catalog pricing may opt in.
- HTTP, WS and WebRTC now share governance/statistics/runtime-event settlement.
  Added failing-before-fix HTTP duration and WS independent-model regressions;
  HTTP/Speech 22 passed, WS 11 passed, WS/WebRTC/accounting 32 passed. WebRTC without
  observed terminal usage reports partial cost, retaining confirmed item charges.
- PostgreSQL 16 isolated loopback database: 2 runtime-store tests passed, including
  known/unknown event persistence, rollups and recreated-pool governance recovery.
  A failing regression exposed missing media summaries in database statistics;
  server-side aggregation now preserves counters, currency subtotals and unknown
  status for totals/model/key, with key/time filtering and retained-detail limits.
- Governance unknown-count recovery, usage and admin labels: 23 focused tests
  passed. Admin labels distinguish known estimates from unknown costs and show
  other currencies separately. Documentation now states rate-unit/hosting rules,
  detail retention, file-mode limitations and crash/transactional boundaries.
- Caddy 2.11.4 from an existing local image: generated-config integration passed
  audio byte fidelity, 64 KiB WS messages and idle closure. Isolated container,
  loopback HTTP and mock providers only; no public TLS/deployment acceptance.
- Final local gates after settlement: `npm run test:unit` 381 passed (zero skipped
  or failed); `npm run test:routes` all 42 passed; `npm run build` succeeded (126
  modules); source/admin/test diagnostics and `git diff --check` passed. Seven
  updated documents contain 53 verified local links. Optional PostgreSQL and Caddy
  gates above were run separately and are not counted among the 381 tests.
- Browser cost display: English/Chinese at 1440/390 px passed page/card/value
  overflow checks with known USD, separate EUR and unknown-cost fixture data;
  screenshot inspected and model table matched the summary. Stats interception
  was removed afterward. Existing save/reload acceptance above remains applicable;
  this follow-up changed display logic, not configuration controls.
- Fixed-version CLI gates passed against disposable mocks: Claude Code 2.1.226
  (native Messages, beta/SDK headers, credential isolation) and Codex 0.153.2
  (model catalog/cache and Responses lifecycle). Global CLI versions were not
  changed; Codex ran in a temporary `npm exec` package environment.
- Local PostgreSQL schema/container and Caddy test container were cleaned up.
  No production configuration, live model traffic, deployment or commit occurred.
- Current next smallest step: obtain an explicitly authorized isolated provider
  endpoint/model, credential channel and cost ceiling, then run one tiny speech
  request before broadening to transcription and WS/WebRTC audio acceptance.
  Live SDK/Entra/audio/provider billing and deployed TLS/network/backpressure
  gates remain open. TPM/budget admission stays fail-closed; crash-safe active
  session accounting, admission reservations and exact hard caps are not claimed.

Per milestone, run the narrowest executable contract first, then
`npm run test:unit` and `npm run test:routes`. UI changes additionally require
component tests and `npm run build`; browser layout/save/reload is separate.
Use disposable mock processes, not the running service.

Not run: live upstream/voice SDK, browser audio/WebRTC tracks, deployment and latency acceptance.
These require the prerequisites in `test/README.md`, isolated credentials and
deployments, representative authorized media and a controlled cost allowance.
Mock tests do not establish provider, billing or deployment acceptance.

## Sources

- https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image
- https://learn.microsoft.com/azure/foundry/foundry-models/how-to/use-foundry-models-mai-thinking
- https://learn.microsoft.com/azure/ai-services/speech-service/mai-voices
- https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
- https://developers.openai.com/api/docs/guides/audio
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/realtime-translation
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
- https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets
- https://learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-webrtc