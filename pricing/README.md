## pricing directory

This directory stores reusable model definitions for AOAI Proxy.

### Canonical authoring format

Each active card is a self-contained JSON document, not an instance of a shared
family template. Backend loading, remote sync and the bundled admin library use
the same [price/template defaults](../src/model-card.js). Compact source files
expand into complete runtime/admin objects; old full cards remain accepted.

- Write token rates in USD per **1M tokens**, using `inputPer1mTokens`,
  `cachedInputPer1mTokens`, `cacheWritePer1mTokens` (or explicit TTL rates), and
  `outputPer1mTokens`. Do not store a second per-1K representation.
- Flat prices live directly under `pricing`. For whole-request prices, write
  rates only in `pricing.tiers`, with `tiering` and explicit interval bounds.
  Do not duplicate the short tier at the root. Unknown/unpublished rates are
  omitted, never filled with zero; independently published zero prices remain zero.
- Omit a duplicate `pricingCatalogEntry`: absence uses `pricing`. Keep explicit
  `pricingCatalogEntry: null` for automatic-text-pricing opt-out, including
  media/reference-only cards. A distinct non-null entry remains a supported
  intentional override, not another copy to keep in sync.
- Use `proxyTemplate: {}` when the model is offered as a template and needs no
  overrides. It inherits root `id`, `displayName`, and `capabilities`;
  `targetModel` and `pricingRef` default to root `id`. Keep only exceptions such
  as an upstream deployment ID or a route mapping. Missing/null templates do
  **not** opt in. Routes and explicit empty arrays are preserved, not inferred.
- Keep protocol-specific profiles, hosting modes, limits, media channels,
  non-token units, and evidence. Do not collapse Chat/Responses parameter paths
  or make one provider's rates apply to another. Sources may repeat a URL to
  independently substantiate capabilities and limits.
- Notes should explain model/provider-specific caveats and policy provenance;
  avoid restating structured fields or the generic billing implementation.

For example, a template-only override is now:

```json
"proxyTemplate": {
  "targetModel": "provider-specific-deployment",
  "routes": { "chat/completions": "responses" }
}
```

### Complete model-card requirements

A model card is a complete deployment descriptor, not just a price table.
When adding or completing a card, audit the entire raw JSON against the
checklist below. Use a complete card for the same provider and protocol as a
structural reference; do not stop after filling prices or rely on loader
defaults to hide missing metadata. An explicitly price-only edit stays
price-only, but report any other incomplete fields discovered.

Declare `defaultInterface` explicitly, including single-interface cards.
When making an existing implicit default explicit, preserve the Catalog's
previous resolution and administrator route overrides; do not infer a new
routing policy from a model name. `modelVersion` is the provider's opaque
deployment revision, which can be `"1"` rather than a date. Unknown revisions
must remain unknown, not be synthesized from a release announcement.

| Area | Required review |
| --- | --- |
| Identity and deployment | Exact `id`, `displayName`, `provider`, `family`, published `modelVersion` and `status`; hosting modes and deployment target overrides when applicable. |
| Limits | Independently sourced `contextWindow`, `maxInputTokens` and `maxOutputTokens` where published, with `sources.limits`; never infer input from context minus output. |
| Native support | `interfaces`, `defaultInterface`, input/output modalities and capabilities; distinguish native provider support, protocol-specific tool restrictions and proxy routing policy. |
| Reasoning and thinking | For every applicable native protocol, record the correct parameter path, complete supported `levels`/`types`, omitted-parameter `default`, validation policy and relevant aliases or budget constraints when provider evidence establishes them. Keep unknown choices/defaults unset with field-path notes; do not claim a control is fixed just because support is undocumented. |
| Pricing | Currency, billing unit, source type/status, all published input/output/cache-read/cache-write rates, applicable TTL/media/hosting units and complete whole-request tiers with IDs, bounds and selection policy. |
| Import and evidence | Correct enabled/disabled template semantics and route overrides, independent `sources` URLs, and concise `notes` for missing fields, provider disagreements and administrator-approved reference policies. |

For configurable reasoning, a profile containing only `parameter` and
`validation: "passthrough"` is incomplete when effort choices and defaults can
be established. Chat's `reasoning_effort` and Responses' `reasoning.effort`
are separate profiles; never flatten their lists or assume `max` is available
on both. Keep `passthrough` where established: descriptive metadata must not
become a new local rejection policy.

Do not leave an applicable native protocol's profile absent: that can expose
generic fallback choices/defaults as apparent model facts. If the protocol
parameter path is known but its deployment-specific support, choices or default
are not, declare the path and passthrough policy without adding guessed
levels/defaults, and document the unresolved
`protocolProfiles.<protocol>.<control>.<field>` paths in that card's notes.
Only source a `configurable: false` profile when the provider documents a fixed
request-level control. Keep proxy-only `shimDefault` activation separate from
the provider's omitted-parameter `default`. A declared thinking `shimDefault`
must be a nonempty string in that profile's nonempty `types` list. Remote sync
rejects an invalid candidate before replacing the active files or Catalog.

Prefer exact-model, selected-provider evidence over sibling cards. If the
administrator explicitly requests a sibling reference to complete reasoning
metadata, record the model names and approval in `notes`, materialize the
values in the new self-contained card, and identify what remains a reference
rather than an independently verified deployment fact. Preserve contradictory
provider evidence rather than presenting a family default as universal.
This exception does not authorize inferred token limits, copied prices or
runtime family inheritance.

GPT-6.1 Sol's Azure card follows the administrator-approved
[GPT-6 Astra](gpt-6-astra.json)/[GPT-6 Luna](gpt-6-luna.json) profiles:
Chat lists `none`, `low`, `medium`, `high`, `xhigh`; Responses additionally
lists `max`; both record the reference default `medium`. Azure documents
`none` and restricts `max` to Responses, while OpenAI's exact-model page
excludes `none` and publishes `medium` as default. These provider/reference
distinctions remain in the card's evidence and notes, not hidden by blank
lists or defaults.

Run `cards:check` and `cards:validate` on raw cards and review every diagnostic
for the changed card. A fully completed card with available evidence should
have no `REVIEW` diagnostics. A genuinely unpublished, inapplicable or
deployment-dependent value remains absent, with its field path and reason
documented in `notes` and the change summary; never invent a value or zero
just to clear a diagnostic. Focused tests must freeze declared reasoning
choices/defaults, their compiled Catalog profiles and template import, plus
pricing boundaries when applicable. Offline validation checks completeness
and structure, not the truth or live acceptance of provider documentation.

### GPT-5.5 and newer routing defaults

For GPT-5.5 and newer text cards with native Responses support, set
`defaultInterface: "responses"`. Enabled proxy templates must also explicitly
set `routes: { "chat/completions": "responses" }`. Native Responses requests
stay native; Chat clients use the existing Chat-to-Responses shim.
`defaultInterface` alone does not redirect a supported native Chat request.

This is a project template policy for reasoning with tools, consistent with
OpenAI's [Chat tool-calling restrictions](https://developers.openai.com/api/docs/guides/migrate-to-responses#additional-differences)
and [GPT-6 migration guidance](https://developers.openai.com/api/docs/guides/latest-model#update-api-and-model-parameters).
Preserve provider-native `interfaces`, protocol profiles, and independently
sourced reasoning defaults; do not work around the restriction by forcing
effort to `none` or inventing Responses support. Keep disabled templates disabled
and leave older GPT cards outside this policy.

The override is stored in each self-contained card, not inferred from model
names at runtime. Updated templates apply to newly imported models; existing
persisted model routes require an explicit configuration change and save/reload.
Administrator route overrides remain authoritative.

### Formatting and validation

Use the repository formatter rather than hand-minifying JSON:

```bash
npm run cards:format
npm run cards:check
npm run cards:validate
```

It uses two-space indentation, stable root/price/template field ordering, inline
scalar arrays when they fit within 120 columns, and one note per line. It removes
equivalent duplicates, preserves differing overrides and explicit nulls, and
refuses conflicting rate conversions. It only visits `pricing/*.json`, never
archives or live/persisted configuration. Unit tests enforce canonical formatting
and parity between the backend and bundled admin libraries.

`cards:check` also checks required metadata on the **raw JSON**, before loader
defaults can hide missing fields. `cards:validate` reports those errors plus
`REVIEW` diagnostics for unrecorded text-token limits, configurable reasoning/
thinking choices and defaults, token input/output rates, and unpublished billing
units. It does not rewrite cards. Errors produce a nonzero exit status; review
diagnostics do not, because an absent field may be unpublished, inapplicable, or
deployment-dependent. Neither command verifies online availability or the truth
of a cited source. Explicit zero prices, disabled automatic pricing, fixed
reasoning, and deliberate pricing overrides remain supported.

For open-source models, Foundry availability is the admission criterion. Prefer
the Azure-direct offering for each exact model; use the Foundry Fireworks offering
only when no Azure-direct offering exists. This is not a family-wide provider
switch. Keep the selected deployment ID, protocol facts and price provenance
aligned. DeepSeek V4.1 Flash has no current Azure-direct roster entry; GLM
5.3/5.3 Flash and Kimi K3 use their exact Fireworks Foundry targets. The
current Azure-direct roster does **not** list DeepSeek V4.1 Flash; its active
Foundry offering is `FW-DeepSeek-V4.1-Flash`. Regression tests must compare the
exact model ID and selected hosting surface, not force a direct target when it
is absent from the current roster.

When published, record reasoning levels and defaults, thinking controls, token
limits, rates and billing intervals with evidence for the selected deployment.
Do not infer an input maximum from context minus output, silently copy an
effort default from a sibling model without the explicit reference approval
described above, or invent a long-context tier. Offline tests enforce
structural consistency; provider research determines whether a missing value
can actually be filled.

**Rollout:** deploy the updated runtime and rebuilt admin assets before remotely
syncing compact cards. Older template loaders do not fill their omitted fields.
After that upgrade, data-only card edits still use ordinary catalog sync.
Persisted cards and administrator pricing overrides retain their existing priority.

### Archived model cards

`pricing/archive/` stores model cards that are retained for history or migration
references but must not be offered as active templates. The backend loader reads
only JSON files directly under `pricing/`; it does not recurse into
subdirectories. GitHub pricing sync likewise accepts only JSON file entries
directly under the configured path, and the admin UI bundle uses the
non-recursive `pricing/*.json` glob. Keeping retired cards under `archive/`
therefore excludes them from runtime catalog compilation, GitHub sync, and
bundled UI template updates without deleting their metadata.

When archiving a card, verify the provider-specific lifecycle and preserve the
card's original filename. Do not archive a card solely because another
provider's deployment of the same model has retired.

### Provider profile reconciliation

A release-date or retirement audit is not sufficient to keep this catalog
complete. Provider checks must also diff the current catalog and pricing
surfaces by exact model ID and deployment target, then verify each missing
profile's interface, modalities, context limit, tool support, reasoning
controls, and unit prices. For example, `deepseek-v4p1-flash` is distinct from
`deepseek-v4-flash`, and `glm-5p3-flash` is distinct from `glm-5p3`; family-name
matching must not treat either pair as covered.

The limit audit now records Azure-published input/output limits for
`DeepSeek-V4-Flash`, `grok-4`, and `Kimi-K2.5`, without inferring total context.
The remaining active cards without any `contextWindow`/input/output limits are
image, audio, speech, or realtime-only cards whose corresponding limits have not
been verified. The reviewed exception set is enforced by the Model Catalog unit
test so a newly added card cannot silently introduce another missing limit.
The exception list permits newly verified limits to be filled; it does not
require reviewed cards to remain incomplete forever.

#### Catalog repairs (2026-10-11)

All 87 active cards now declare their native default interface. Existing
defaults and explicit template routes were retained; adding metadata did not
redirect existing Chat requests to Responses. Unverified limits, versions,
control defaults and billing units are identified by field path in each
self-contained card, not hidden behind loader defaults or explained only here.
`cards:validate` still reports evidence-qualified review items; a note explains
an unknown value, it does not turn that value into a verified provider fact.

- Anthropic's live [pricing table](https://platform.claude.com/docs/en/about-claude/pricing)
  supplied all eight previously missing Claude TTL-write tables and corrected
  Sonnet 5.5 cache reads. Sonnet 5's scheduled price increase was cancelled;
  its old introductory amounts are now standard, so only its obsolete note
  needed correction.
- Claude transport modalities are text/image input and text output. Code is
  text content, not a separate wire modality; image understanding does not
  imply image generation. Opus 4.6/4.7 and Sonnet 4.6 are GA in the cited
  Anthropic-infrastructure Foundry offering. Fable 5/5.1 are Preview in that
  offering; a model's release date is not proof of GA on every hosting surface.
- Grok 4/4.3/4.6/4.7 cards select the Azure Foundry offering, not xAI-direct
  endpoints. Their individual Azure limits, versions and lifecycle labels are
  kept separate from xAI facts. Azure's exact-model table lists Chat Completions
  only for 4/4.3/4.6, while its broader deployment how-to mentions Responses;
  native Responses is therefore recorded only for 4.7, whose Azure how-to
  documents it. The 4.3/4.6 xAI rates remain reference data with
  `pricingCatalogEntry: null`; Grok 4 has no verified Azure or current xAI
  numeric price. Azure's effort parameters/defaults are not inferred from xAI.
  GLM 5.3's established Responses interface is retained with its parameter
  path, but its exact Foundry effort choices/default remain unverified, rather
  than falling back to generic medium reasoning. No new local capability
  rejection or omitted-effort injection was introduced.
- The [current Fireworks catalog](https://learn.microsoft.com/azure/foundry/how-to/fireworks/enable-fireworks-models#available-catalog-models)
  supplies the `FW-GLM-5`, `FW-GLM-5.2` and `FW-MiniMax-M2.5` deployment
  identifiers. GLM 5.2 retains the independently checked exact non-Fast Data
  Zone retail prices, not Fireworks-account, Global Standard or PTU rates.
  GLM 5 and MiniMax M2.5 retain active **PTU-only** templates at the
  administrator's request: their pay-per-token offerings are deprecated,
  old token prices are `reference`, and `pricingCatalogEntry: null` disables
  automatic text pricing. A visible historic retail meter is not evidence
  that its offering can still be deployed. PTU charges are not invented from
  token prices.
- Azure-direct DeepSeek V3.2, V3.2 Speciale, V4 Flash and V4 Pro use the
  current Global Standard rates. Azure-direct Kimi K2.5/K2.6 retain historical
  FW meter amounts as `reference` only, with automatic pricing disabled; a
  matching meter name does not prove an Azure-direct Kimi charge.
- GPT-4.1 cards distinguish the OpenAI context maximum from smaller Azure
  Standard/provisioned/batch deployment windows. Codex cards retain the
  Azure/OpenAI `xhigh` documentation discrepancy explicitly; passthrough still
  lets the upstream decide an explicit value. No missing input ceiling,
  deployment default or service-tier price is inferred from a sibling.

Template target/provider changes apply to new imports. Existing deployment
names, routes and administrator pricing overrides are not rewritten, including
overrides on the two PTU cards. Historical cost/tier snapshots are not repriced.
No archive, live configuration or generated admin asset was changed.

#### Full official-source verification (2026-10-11)

The full pass compared **all 85 pre-existing active cards** with exact-model
documentation for the selected provider/hosting; two current MAI Voice 2.1
cards were added separately after Microsoft documented those exact targets.
The active catalog now contains **87 cards**. The source review separated model
publisher facts, API surface facts, hosting/version facts, and billable meters
instead of treating a family name or identical price as proof of equivalence.
The audit distinguishes:

- **verified deployment facts** (exact catalog IDs/versions, interfaces,
  modalities, individual limits, current lifecycle labels and service meters);
- **provider-direct references** that are not Azure Foundry quotes;
- **proxy policies** (routes, conversion defaults, non-configurable controls);
- **unknown or conflicting values**, which remain unset or are explicitly
  identified in each card's `notes`.

It does not claim invoice acceptance or live availability in every region. The
Azure OpenAI public price page currently renders `$-` for several multimodal
rows, and Azure Retail Prices API calls for some products were throttled with
HTTP 429. Existing numerical amounts without a current exact-host record remain
marked/reported as references; OpenAI/xAI/DeepSeek/BFL direct rates are not
silently represented as Azure charges. Unknown values are not cleared with a
zero or a sibling-model default.

The source-backed corrections in this pass include:

- **Azure-direct DeepSeek:** use the current Azure Global prices for V3.2,
  V3.2 Speciale, V4 Flash and V4 Pro, add the documented tool-calling
  capability, and omit an unsupported combined context total for V4 models.
  V4.1 Flash is not on the direct Azure roster; its exact Foundry target is
  `FW-DeepSeek-V4.1-Flash`. Its DeepSeek API price is not a Foundry price, its
  Foundry meter remains unverified, and automatic pricing is disabled.
  Azure Global per-1M input/cached-input/output prices verified in the current
  DeepSeek table are V3.2/Speciale **0.58/—/1.68**, V4 Flash
  **0.19/0.028/0.51**, and V4 Pro **1.74/0.145/3.48**. V4 input/output
  limits are separate ceilings, not a combined context value.
- **Fireworks Foundry:** GLM-5.3 now uses the current FW-GLM-5.3 Azure Global
  meters (effective 2026-09-01). GLM-5, Kimi K2.5 and MiniMax M2.5's old
  pay-per-token SKUs are deprecated/PTU-only; their historical meters no longer
  enable automatic token billing. GLM-5.2 Data Zone rates remain distinct from
  Global/PTU prices. GLM-5.3 Flash Serverless references are not asserted to
  be its Foundry price.
- **OpenAI and Azure:** add Azure-supported `none` to GPT-5.1 Codex/Codex Mini,
  record the conflicting Codex Max `none` evidence without rejecting requests,
  and include GPT-5.4 Nano computer use. GPT-5.6 version/status sources
  conflict; Azure GPT-6.1 tool calling is Responses-only. GPT-4.1 deployment
  limits, Azure Realtime 2.x limits, and OpenAI-direct Realtime snapshots are
  kept distinct rather than combining host-specific context values.
- **OpenAI/Azure price boundaries:** OpenAI Standard rates on Azure-bound cards
  remain explicitly identified as provider-direct references, not Azure
  invoice quotes. Azure OpenAI's current public price page renders `$-` for
  several audio/realtime rows and some Retail Prices API calls returned 429.
  Existing Azure-rate amounts whose current exact meter could not be reproduced
  remain estimates/references; no OpenAI direct audio-channel price is copied
  over a potentially different Azure meter.
- **Grok/Azure price boundaries:** the xAI-direct tier tables for Grok 4.3,
  4.6 and 4.7 remain reference-only on Azure cards; `pricingCatalogEntry: null`
  prevents them from generating automatic Azure costs. Grok 4 has neither a
  verified Azure meter nor a current exact xAI price row, so its pricing is
  unavailable rather than copied from another model.
- **Model Router:** its exact pool has no single input/context/output limit or
  guaranteed union of route features. `contextWindow` is left unset; Codex
  discovery uses the existing 128K/95% compatibility fallback, not a declared
  router-provider cap. The input-only $0.14 SKU is restricted to its published
  regions; underlying model charges remain separate.
- **Retired and lifecycle-uncertain models:** o1-preview is retired and its new
  template is disabled while historical pricing is retained as reference.
  GPT-5.6/GPT-6 lifecycle labels are set to unknown where the current Azure
  table publishes a version but not an explicit GA/Preview label; version/matrix
  conflicts remain recorded instead of guessing.
- **Claude:** effort lists/defaults now match the exact Anthropic model docs.
  For Opus 4.6/4.7/4.8 and Sonnet 4.6, native omitted `thinking` means off;
  the shim's explicit adaptive activation is recorded as a proxy policy, not
  an upstream default. Sonnet 5.5 release date and Sonnet 5 Foundry default
  hosting are corrected. Anthropic token/cache rates describe Anthropic
  standard pricing; CCU conversion, negotiated terms, and Azure Data Zone
  surcharges are separate.
- **MAI:** MAI-Thinking-1 Global token rates and MAI-Transcribe-2's limited
  $0.10/audio-hour offer through 2026-12-31 are recorded in native units.
  Transcription uses one-second billing increments; the release capsule also
  publishes a standard $0.36/audio-hour rate, requiring price review when the
  offer ends. Its 2026-09-03 release date is not a verified deployment revision.
  The legacy 2.0 voice targets remain for existing configs but their new
  templates are disabled because current Microsoft docs list only 2.1 and do
  not establish a 2.0 retirement/price. Separate 2.1 cards use the documented
  $22/$15 per-million-character prices. Proxy synthesis does not expose voice
  cloning.
- **FLUX:** FLUX.2 flex/pro are Azure Foundry Preview; direct BFL megapixel
  rates/formulas are reference-only, not Azure prices. BFL sources conflict
  between $0.05 and $0.06 per MP for Flex; neither current price table proves
  separate reference-image billing. Pro's local first/additional-MP formula is
  not established by the current BFL table. Automatic image pricing stays off.
Remaining limitations are explicit rather than hidden: exact current Azure
OpenAI multimodal invoice amounts, several deployment-specific effort defaults,
Azure lifecycle labels omitted from model rows, the legacy MAI Voice 2.0
availability/price, and a few Foundry meters. The verification source/date and
field-path caveats are recorded in the affected card notes. `cards:check` and
`cards:validate` verify structure and documented unknowns; neither resolves
these provider-side uncertainties.

#### Metadata audit (2026-09-30) and subsequent additions

The September audit observations below are historical. Its outstanding Claude
cache-write and GLM/MiniMax offering-reconciliation gaps are superseded by the
October repairs above; the remaining independently unverified values still
require provider evidence.

Subsequent additions: `claude-sonnet-5-5`, `gpt-6.1-sol`, `grok-4.7` and
`claude-haiku-5-5` brought the active catalog to 85 cards at that point. The
full October source verification above added two separate MAI Voice 2.1 cards,
bringing the current active catalog to 87.

The initial Grok 4.7 card mixed Azure deployment limits with xAI-direct effort
controls and prices. The October source pass selected Azure Foundry: its current
card records GA/version 1, native Chat/Responses and the combined 500K context.
xAI prices remain reference-only with automatic Azure pricing disabled; Azure
effort defaults are not published. See [Grok 4.7](./grok-4.7.json).

[Claude Haiku 5.5](./claude-haiku-5-5.json), released October 7, 2026, is GA
with native Messages on Azure or Anthropic hosting, 1M context and 128K
synchronous output. Adaptive thinking and `medium` effort are defaults;
`disabled` thinking is supported at `high` effort or below. Its whole-request
prices switch only **above 100,000** prompt tokens, including cache. Short/long
USD rates per 1M tokens are 0.10/0.50 input, 0.01/0.05 cache reads,
0.125/0.625 five-minute cache writes, 0.20/1 one-hour writes, and 0.50/2.50
output. The separate batch-only 300K output beta is not a proxy Messages limit.

Sonnet 5.5 uses native Messages on Azure or Anthropic
hosting, a 1M context/128K output limit, adaptive thinking by default and effort
`high`; `between_tools`, not `disabled`, is its provider-specific alternative
with the constraints recorded in the card. Anthropic's current pricing table
explicitly publishes USD 2 / 0.10 / 10 input/cache-read/output and USD 2.50 / 4
five-minute/one-hour cache writes per 1M tokens, verified on 2026-10-11.
The official release date is 2026-09-28; an independent input maximum remains
unpublished.

GPT-6.1 Sol uses Microsoft's exact `2026-09-29` model version, native Chat and
Responses, and independently published 1,050,000 / 922,000 / 128,000
context/input/output limits. The provider documents function tools on Responses
only. Its complete per-protocol reasoning profiles use the administrator-approved
Astra/Luna reference: Chat accepts `none`, `low`, `medium`, `high`, `xhigh`;
Responses additionally lists `max`; both use the reference default `medium`
and retain passthrough validation. Azure's exact-model matrix includes `none`,
but OpenAI's model page excludes it; OpenAI independently publishes the
`medium` default, which remains a reference for Azure rather than a
live-verified omission default. Its pricing now uses published
[Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
Global Standard consumption rates: `sourceType` is `azure-retail-prices-api`
and `status` is `published`. The eight exact-model `Std Gl` meters are
effective **2026-10-01** and, when checked on 2026-10-11, agree across all 26
returned regions. Short/long USD rates per 1M tokens are 2/4 input, 0.10/0.20
cache reads, 2.50/5 cache writes and 10/15 output. These match the previous
OpenAI reference estimates; the source and verification status have changed,
not the amounts. Flex and Data Zone meters and deployment-specific discounts
are not included. The API distinguishes short/long meters but does not publish
their numeric boundary; the
[exact OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
independently establishes the whole-request threshold: input including cache
at 272,000 tokens remains `short <=272K`; 272,001 selects `long >272K`.
No GPT-6 Sol prices or thresholds are inherited.
New imports include the complete Azure pricing. Existing model prices
require explicit review and save, and historical unknown-tier rows and costs
are not reconstructed from the new card. “Tier not recorded” in model
statistics means request-time pricing/tier evidence is missing, not free usage.

At the September audit, all 81 then-active raw cards were inspected. Reachable
Microsoft documentation sources and Anthropic's own API reference supplied
the following updates:

- Azure input/output limits for DeepSeek V4 Flash, Kimi K2.5 and Grok 4/4.3;
  GPT-5 Pro input/output corrected to 272K/128K. Grok 4.6 uses Azure's 200K
  context and 128K output ceiling, not the xAI-direct 500K context.
- FLUX.2 input limits and MAI-Image-2.6/Flash context limits are 32K. Media cards
  are not categorically exempt from recording published token limits.
- Seven Claude cards now record API effort default `high`; Opus 5.5 retains
  `medium`. Evidence is Anthropic's reference cached September 25, not a claim
  that the live product documentation was fetched successfully.
- GPT-5.6 and GPT-6 Astra distinguish Responses-only `max` from Chat effort
  levels. The September Grok 4.6 xAI effort findings are not Azure defaults:
  its current Azure card records only the documented Chat interface and leaves
  Azure-specific effort choices/defaults unset. Catalog levels are descriptive,
  not a new proxy preflight rejection policy.
- GLM 5.3 Flash and Kimi K3 templates use Foundry `FW-...` catalog IDs while
  retaining Fireworks provider/price provenance. They do not use Fireworks-account
  `accounts/fireworks/models/...` identifiers as Foundry deployment defaults.
- Fable 5.1 and Opus 5.5 TTL cache-write rates already recorded in their sourced
  notes were moved into executable price fields; those prices were not freshly
  reverified online at that time. The remaining Claude write rates were filled
  from the live exact-model table during the October follow-up.

The September review items were not replaced with guesses:

- DeepSeek V4.1 Flash's direct input/output maxima; GLM 5.2 effort choices/default;
  older GPT/Codex and realtime effort defaults; missing independent input limits.
- GLM 5/5.2 and MiniMax M2.5 needed exact direct-versus-Fireworks offering
  reconciliation. The October follow-up reconciled the current Azure-direct
  and Fireworks tables and explicit targets; PTU-only retention/pricing opt-out
  was separately approved by the administrator.
- Conflicting Azure/OpenAI realtime limits and deployment-dependent GPT-4.1
  windows. The September Grok 4.3 card mixed xAI context with Azure ceilings;
  the October source pass removed the xAI 1M context from the Azure card and
  retains only Azure's documented input/output limits.
- Claude Fable effort support differs between Microsoft and Anthropic references.
  Existing adaptive thinking defaults are proxy activation choices for explicit
  cross-protocol reasoning, not proof that omitting thinking enables it upstream
  (notably Opus 4.7/4.8). This audit does not change that conversion policy.
- MAI and unpublished image rates, then-missing Claude cache-write rates, and
  Foundry-specific prices where cards use explicitly identified provider reference
  prices. Pricing domains could not be reached during the September audit, so existing
  prices/tiers are not certified as current Azure invoice rates.

Re-run `cards:validate` for the per-file missing-field inventory. Review warnings
are not an exhaustive semantic audit: source conflicts, offering availability,
and optional cache prices still require provider research. No live deployments
were probed.

The GPT-6 Astra, Sol, and Luna cards record only the published Global Standard
short/long-context rates from the [Microsoft Azure GPT-6 launch post](https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/).
Each `pricing.tiers` entry records the context class and input, cached-input,
cache-write, and output rates per million tokens.
All three cards enable automatic pricing from `pricing` using the administrator's
explicitly specified whole-request policy: **this request's input tokens,
including cached input, must exceed 272,000 to select the long tier**.
Exactly 272,000 stays short; 272,001 starts long. The cited post supplies the
prices but does not independently establish this threshold or rule, so the cards
record that policy provenance separately in their notes. The user-provided
Standard pricing screenshot also labels short input as **at most 272K**.
Only Global Standard
rates are included. Existing `models[].pricing` and `access.pricingCatalog`
overrides are not removed by catalog sync and may need deliberate replacement
or removal before the new card policies apply.

Grok 4.3, 4.6 and 4.7 retain their **xAI-official** whole-request tier tables at
`promptTokensAtLeast: 200000` as reference data. The xAI model pages explicitly
apply the higher rate to all tokens when the prompt reaches 200K. These are not
Azure prices; `pricingCatalogEntry: null` disables automatic Azure cost
calculation until the selected Azure meter is verified.

OpenAI's published standard pricing also has 272K prompt-context tiers for
`gpt-5.5`, `gpt-5.4`, and `gpt-5.4-pro`. Their `pricing.tiers` list per-million
rates once, without short-rate copies at the root.
Their executable `pricing` policies follow the administrator-confirmed
strict boundary, **input >272,000**, and charge the entire request at the selected
rate. All nine enabled GPT policies use `promptTokensBelow: 272001` for short and
`promptTokensAtLeast: 272001` for long because intervals are integer `[min, max)`.
Output length and cumulative session usage do not select the tier. These entries do not encode
Batch, Flex, Priority/Fast, or Azure-specific pricing. `gpt-5.4-mini` and
`gpt-5.4-nano` have no separately published long-context rate in the same
pricing table, so they retain their single rate.

GPT-5.6 Sol, Terra, and Luna now use the same executable whole-request policy.
Their short/long input, cache-read, cache-write, and output rates match both the
provided Standard pricing screenshot and the [official OpenAI price table](https://developers.openai.com/api/docs/pricing).
In particular, Sol's short rates are USD **4 / 0.4 / 5 / 20** per million tokens,
not the previous 5 / 0.5 / unlisted / 30. These are OpenAI Standard prices,
not independently verified Azure deployment prices. The published Sol promotion
is available at least through November 21, 2026; recheck prices on future syncs.
Dashes in the published table remain missing rates, never zero/free rates.

Anthropic's current [context-window guide](https://platform.claude.com/docs/en/build-with-claude/context-windows)
says all models with a 1M-token window are billed at standard pricing, and its
[model pricing table](https://platform.claude.com/docs/en/about-claude/pricing#model-pricing)
publishes per-model rates without a context-length threshold. Prompt-cache
write prices are separate cache-operation rates, not long-context tiers, so
the Claude cards retain their standard per-model token prices.

`claude-opus-5-5` is available in Microsoft Foundry on both Azure and
Anthropic infrastructure via native Messages. Its published base rates are
USD 4 input, USD 0.20 cache reads, and USD 20 output per 1M tokens.
Cache writes and US Data Zone inference have separate rates; the flat
`pricing` policy only represents the base rates. Unlike Opus 5,
Opus 5.5 cannot disable adaptive thinking or use a manual thinking budget.

### Field semantics

- `interfaces`
  - Declares the provider-facing API families this model definition is meant to work with.
  - These values influence route suggestions, validation, and how the template is scaffolded into runtime config.

- `inputModalities`
  - Declares the content types the upstream model accepts as input, such as `text`, `image`, or `audio`.

- `outputModalities`
  - Declares the content types the upstream model can emit in its response, such as `text`, `image`, or `audio`.

- `capabilities`
  - Stores provider/model-native feature labels directly, such as `reasoning`, `vision`, `function-calling`, and `structured-outputs`.
  - This list is intended to be copied into `config.models[].capabilities` as the model capability declaration.

- `proxyTemplate.capabilities`
  - Defaults to root `capabilities` during normalization. Do not store a duplicate list in the card.

- `defaultInterface`
  - Selects the provider-facing protocol used when the requested protocol is unavailable and more than one declared interface remains.

- `proxyAdapters`
  - Declares proxy-only compatibility separately from native `interfaces` and `capabilities`.
  - `responses` accepts only `azure-speech-transcribe` (requires `audio/transcriptions`) or `azure-speech-synthesize` (requires `audio/speech`). Invalid bindings reject atomic catalog activation and retain the previous snapshot.
  - MAI Speech cards use these bindings; MAI Thinking and Image do not. No model-name-prefix dispatch or arbitrary tool execution. See the [Responses Speech profile](../docs/protocols/protocol-support.md#responses-speech-profile).

- `protocolProfiles`
  - Stores protocol-specific parameter facts consumed by runtime routing and request conversion.
  - Text profiles can declare `reasoning.parameter`, `levels`, `default`, `aliases`, and `validation`; Messages profiles can also declare thinking types and a default.
  - `images/generations.request` can declare `transport`, `removeModel`, `qualityAliases`, `dropParameters`, and `sizeExpansion`.

- `contextWindow`, `maxInputTokens`, and `maxOutputTokens`
  - Store independently sourced model token limits as positive integers.
  - `contextWindow` is the total model context capacity. Input and output maxima must not exceed it.
  - Codex catalog publication uses the complete `contextWindow`, including input and output capacity, for both its current and maximum window. `maxInputTokens` is used only when the total context window is unavailable.
  - Catalog-backed or explicitly configured windows are published with a 100 percent effective window; the legacy 128,000-token fallback retains the historical 95 percent value.
  - Add `sources.limits` whenever these fields are published. Do not infer limits from model names or pricing tiers.

### Whole-request text pricing

Text JSON and SSE responses share one estimator. It reads upstream `usage`, not
output text deltas, local character counts, `max_tokens`, the model's context
window, or conversation lifetime totals. Existing stream handlers merge usage
snapshots and settle once at source-protocol completion; no output buffering or
new stream conversion is needed. JSON accounting also uses the original upstream
usage before protocol conversion, so cache details are not lost by a shim.

Executable pricing is selected in this order:

1. A nonempty `models[].pricing` override.
2. A nonempty `access.pricingCatalog[pricingRef]` override.
3. The card's `pricing`, unless `pricingCatalogEntry` explicitly overrides it
   (including `null` to opt out).

`pricingCatalogEntry: null` remains an explicit opt-out. Root `pricing.tiers`
can therefore document prices without enabling automatic billing. To enable a
verified table, put the full policy below in `pricing` and omit a duplicate
`pricingCatalogEntry`, or use either administrator override. Admin template import copies the entire policy. It does
not flatten it to the first tier. Existing administrator overrides continue to
win after card sync; remove obsolete overrides deliberately.

This is an illustrative policy, **not a GPT-6 cutoff or a deployment price quote**:

```json
{
  "currency": "USD",
  "billingUnit": "1M tokens",
  "tiering": {
    "basis": "inputTokensIncludingCache",
    "method": "whole-request"
  },
  "tiers": [
    {
      "id": "short <200K",
      "promptTokensBelow": 200000,
      "inputPer1mTokens": 2,
      "cachedInputPer1mTokens": 0.2,
      "outputPer1mTokens": 10
    },
    {
      "id": "long >=200K",
      "promptTokensAtLeast": 200000,
      "inputPer1mTokens": 4,
      "cachedInputPer1mTokens": 0.4,
      "outputPer1mTokens": 15
    }
  ]
}
```

Intervals are `[promptTokensAtLeast, promptTokensBelow)`. The first lower bound
may be omitted for zero, and the final upper bound is omitted for unbounded.
Tables must be ordered, contiguous and nonoverlapping, covering all nonnegative
input counts. If the provider says **above** B, use B+1 as the integer long-tier
lower bound; if it says **at least** B, use B. Verify the exact boundary, the
provider/deployment/service tier and source before enabling a policy. The engine
does not automatically select a region, deployment class, Batch, Flex or Priority
rate.

Each executable tier should have a unique, descriptive `id`. Runtime breakdowns
display the captured ID verbatim and group by actual model plus ID, not by price
or interval alone. The active GPT cards use `short <=272K` / `long >272K`;
Grok 4.3/4.6/4.7 use `short <200K` / `long >=200K` for their xAI reference
tiers. `K` means 1,000 tokens.
Numeric bounds select rates; the ID is never parsed to determine billing.
Keep IDs stable for price-only changes and update their boundary text when a
threshold changes. Reusing an ID across different historical bounds merges those
statistics, retaining the original per-request costs and interval evidence.
Changing an ID creates a separate category; old snapshots are not renamed from
the current catalog. Legacy rollups without captured IDs retain interval-based
fallback labels and are not guessed into a new named category. No database
columns or historical cost recalculation are required.

The selected rates apply to the **entire request**, including output, not only
tokens above the threshold. Each row is independent; no missing rate inherits
the root's short-context price. Rates are finite nonnegative numbers; explicit
zero is valid. Both per-million and legacy per-thousand fields are accepted and
must agree when supplied together. Old flat policies need no `tiering` field.
Unknown tiering methods, malformed intervals and invalid executable rates reject
config saves and catalog activation instead of falling back to cheaper prices.

Input used for selection includes cache reads and writes. Chat/Responses input
totals already include both. Native Messages input excludes the separate
`cache_read_input_tokens` and `cache_creation_input_tokens`, so they are added
once. Already normalized `prompt_tokens` is not expanded again. Ordinary input,
cache reads, cache writes and output are then charged separately. Reasoning tokens
already included in output are not charged a second time.

Supported write prices are `cacheWritePer1mTokens`, `cacheWrite5mPer1mTokens` and
`cacheWrite1hPer1mTokens` (and per-thousand equivalents). Messages TTL evidence
comes from `cache_creation.ephemeral_5m_input_tokens` and
`cache_creation.ephemeral_1h_input_tokens`. A combined write rate can price a
reported combined count; TTL-specific rates require the corresponding breakdown.
Unreported provider-specific write counts are not invented from uncached input.
Observed writes without a usable rate remain unpriced rather than being billed
as ordinary input.

Azure documents `prompt_tokens_details.cache_write_tokens` for Chat on GPT-5.6
and later. OpenAI's [prompt-cache cost example](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance)
documents Responses `input_tokens_details.cache_write_tokens` and the partition:
`ordinary input = input - cache reads - cache writes`. Writes replace the ordinary
input charge for those tokens; they are not an additive surcharge. Missing or
inconsistent required evidence stays unpriced rather than being clamped, inferred
from uncached input, or silently charged as ordinary input. Native response
passthrough and input/total-token quotas are unchanged.

Every request captures the active catalog and configured prices before upstream
work. In-flight requests retain that generation across sync/reload, including
Model Router's eventual actual-model price. Router input fees are calculated
separately from the actual model's full token cost. Usage audit records include
the pricing source, policy digest, selected tier/rates and `costStatus`:

- `priced`: all required costs known, including a valid zero-cost request.
- `partial`: a known subtotal exists but some cost/evidence is missing.
- `unknown`: the request cannot be priced from available evidence.

Missing/invalid input usage and locally estimated token counts cannot select an
exact context tier. Statistics and budgets keep numerical **known subtotals** for
compatibility, with `textUnknownCostRequests` marking incompleteness; the admin
UI presents these as reference costs without an unknown-fee suffix, with a
single disclaimer below the model-statistics heading: estimates may be incomplete
and the Azure billing portal determines final charges. Unavailable amounts show
`—`; confirmed zero-cost requests still show `0.0000 USD`. Detail events retain
the audit and unknown reason, while rollups retain the unknown-request count.
Existing historical events are not retroactively repriced or reclassified.
This remains post-hoc estimated accounting, not a guaranteed prepaid hard cap:
an in-flight request may exceed a budget and unknown costs cannot be enforced
as known spend.

Cache-write reporting is independent of cache reads and total-token accounting.
Each settlement carries `cacheWrite.tokens`, `usageStatus`, `knownCostAmount`,
nullable `estimatedCostAmount`, and `costStatus`. Explicit zero is preserved;
absent/invalid write evidence is unknown. In aggregated statistics, `tokens`
and `estimatedCostAmount` are null when coverage is incomplete, while
`observedTokens` and `knownCostAmount` retain known subtotals. Coverage counts
track observed, priced, partial, and unreported requests.

PostgreSQL event and rollup tables add `cache_write_tokens`,
`cache_write_known_cost_amount`, `cache_write_estimated_cost_amount`,
`cache_write_requests`, `cache_write_observed_requests`,
`cache_write_priced_requests`, `cache_write_partial_cost_requests`, and
`cache_write_unreported_requests`. The additive migration does not manufacture
zero usage/cost for old rows. Spill/replay and aggregate queries preserve the
same nullable coverage. The admin overview, trend and model/key/actual-model
tables show write tokens, including partial or unreported usage labels. The
reference cost already includes priced writes; no standalone write-cost column
or extra budget charge is added.

Reference-cost cards use only the short hint "Cost estimates may be incomplete."
Input/output counters across the admin runtime views use K (1 K = 1,000 tokens),
with up to three decimals and raw counts available on hover. Cache counters
retain token units; stored usage, tier selection and costs are unchanged.

The admin checks every configured model whose executable card defines tiers,
including aliases and custom public IDs. Model-level pricing and persisted
catalog entries still override the library. A library sync does not overwrite
prices previously copied into configuration. When configured tier intervals
differ, the model-statistics price review can explicitly replace the listed
models' prices with complete card snapshots, including all cache rates. Review
and save the draft through the ordinary configuration workflow to activate it.
Shared catalog entries, routes, other models and historical settlements remain
unchanged. Non-tiered historical rows are labeled separately when the current
card is tiered; current card tiers are never used to fabricate historical tiers.
Collapsed model rows show only "Tiered billing" for executable tiered cards;
recorded tier labels and per-tier statistics remain in the expanded breakdown.

The new runtime must be deployed once (and admin assets built before building the
container). Subsequent valid price policy changes apply to new requests after
config save/reload or successful catalog sync; no container rebuild is needed
for those data-only updates. The independent media estimator below is unchanged.

### Media usage pricing

HTTP audio/image-edit, Realtime WebSocket and WebRTC accounting uses a separate
media estimator. It does not apply legacy text-only `pricingCatalogEntry` rates
to audio, images or duration. Image generation on its existing route retains its
existing accounting path; per-image/size/quality media prices are not implemented.

Price selection is `models[].pricing`, then `access.pricingCatalog[pricingRef]`,
then a published `openai-official` model-card price for an OpenAI-mode upstream.
An explicit nonempty override without `billingUnit` disables automatic fallback.
Automatic OpenAI rates are not used for Azure hosting or Azure endpoint paths;
Azure/Speech/custom prices require an administrator-verified explicit override.
Catalog rate publication is not real-provider billing acceptance.

All unit prices and budget amounts must be maintained as USD numbers. Legacy
`currency`/`defaultCurrency` fields remain accepted and editable; they neither
filter charges nor trigger currency conversion. Calculations sum known numerical
charges and display USD. This is a unit convention, not FX: genuinely non-USD
source rates must be corrected by the administrator. Historical data is not
rewritten, converted or retrospectively verified. Unknown media cost stays unknown.

Supported fields (all rates must be finite and nonnegative; currency metadata is optional):

| `billingUnit` | Rate fields | Required upstream evidence |
| --- | --- | --- |
| `minute` | `perMinute` or `realtimeAudioDurationPerMinute`; per-second fallback if absent | Reported duration in seconds; minute price takes precedence over rounded second price |
| `second` | `perSecond` or `realtimeAudioDurationPerSecond` | Reported duration in seconds |
| `1M characters` | `per1mCharacters` | Reported `input_characters`, not locally counted input |
| `1M tokens` / `1K tokens` | `inputPer1mTokens`, `cachedInputPer1mTokens`, `outputPer1mTokens`, or their `Per1kTokens` equivalents | Complete input/output totals, text/audio/image channel counts and cached channel counts |

Duration prices may declare `billingIncrementSeconds`, a positive safe integer
supported only for `minute` or `second` billing. Each response/item's billed
duration is rounded up to that increment before applying its rate; reported
duration counters remain unchanged, including explicit zero. Cumulative updates
round the latest total for the same item, not each delta, and duplicate terminals
do not add a charge. Without this field, fractional durations retain their
existing continuous pricing. MAI-Transcribe-2 declares `1` to match Speech's
one-second increments; this is not a global rounding rule for audio or Realtime.

Token rates for text live at the price root; audio/image rates use the same names
under `channels.audio` / `channels.image`. Per-million rates take precedence.
Channels must sum to the corresponding total, and cached channels to cached total.
Unreported text remainder is not inferred. Zero counters are preserved; unknown
prices or incomplete counters do not become zero-cost requests. Binary TTS without
reported usage therefore remains unknown even with a configured character price.

Each response/item retains its in-memory price snapshot; auxiliary transcription
has its own model price. Duplicate terminals do not bill twice, and cumulative
snapshots bill only increases. `costStatus` is `priced`, `partial` or `unknown`;
`estimatedCostAmount` is null unless all observed items are fully priced and the
transport has complete terminal evidence. New `knownCostAmounts` observations
sum into `USD`, independent of legacy labels; no exchange-rate conversion occurs.

HTTP completion, WS cleanup and WebRTC call finish settle into governance,
statistics and the existing runtime-store queue. All known USD-unit charges enter
the legacy monetary total once, including when a key retains another currency
label. The UI displays that scalar without adding media subtotals again.
Database events whitelist counters, status, sources and amounts,
not raw usage payloads, transcripts, audio or SDP. Rates remain in-memory snapshots,
not an immutable provider invoice. Database outage spill/replay uses existing
runtime-store limits; file mode does not provide a durable media ledger.

Media summaries and unknown counts in database statistics cover retained detail
events (`detailRetentionDays`); historical known amounts remain in rollups after
detail deletion. Pending active-session observations can be lost on process crash.
These are known cost estimates, not crash-safe exactly-once provider settlement.
TPM/budget-constrained media keys remain rejected: admission reservations and hard
caps are not implemented by post-hoc pricing. WebRTC without full terminal evidence
keeps a partial total even when known response charges were observed.

### Label glossary

The tables below document the labels that are currently used by pricing definitions in this directory. When a new label is introduced, update this glossary in the same change so the JSON remains self-explanatory.

#### Interface labels

| Label | Meaning |
| --- | --- |
| `audio/speech` | Speech synthesis endpoint that takes text input and returns generated audio. |
| `audio/transcriptions` | Uploaded-audio transcription endpoint that returns text. |
| `audio/translations` | Uploaded-audio translation endpoint; native file input and output formats. |
| `chat/completions` | Chat Completions style API for turn-based request/response chat. |
| `images/generations` | Image generation and image editing API family. |
| `messages` | Anthropic-style Messages API. |
| `realtime` | General low-latency realtime session API for multimodal interaction. |
| `realtime/transcription_sessions` | Realtime transcription session API for streaming speech-to-text. |
| `realtime/translations` | Realtime speech translation session API. |
| `responses` | Responses API for multi-modal, tool-aware model interactions. |

#### Modality labels

The same modality labels are used in both `inputModalities` and `outputModalities`; whether a value appears in one or both depends on the model.

| Label | Meaning |
| --- | --- |
| `audio` | Spoken audio or audio token content. |
| `code` | Code content treated as a first-class input or output modality by the provider contract. |
| `image` | Image input, reference image, or generated image output. |
| `text` | Natural language text tokens or plain text content. |

#### Capability labels

These labels are provider-native feature hints. They are not a universal ontology, but they should stay stable and readable across pricing definitions.

| Label | Meaning |
| --- | --- |
| `audio-input` | The model accepts audio input directly. |
| `audio-output` | The model can emit audio output directly. |
| `code-optimized` | The model is tuned or positioned specifically for coding tasks. |
| `computer-use` | The model supports computer-use style workflows or tools. |
| `function-calling` | The model can produce tool or function calls. |
| `image-editing` | The model can edit an existing image or use reference or mask images. |
| `image-generation` | The model can generate new images. |
| `json-output` | The model supports JSON-mode or JSON-only style output. |
| `parallel-tool-calling` | The model can issue multiple tool calls within one turn. |
| `realtime` | The model supports realtime session semantics rather than only request/response calls. |
| `reasoning` | The model supports explicit reasoning or thinking-oriented behavior. |
| `speaker-diarization` | Transcription output can separate or label different speakers. |
| `speech-generation` | The model can generate spoken audio responses. |
| `speech-to-speech` | The model can take speech input and return transformed or translated speech output. |
| `speech-to-text` | The model can convert speech or audio input into text. |
| `streaming` | The model API supports streamed partial responses. |
| `structured-outputs` | The model supports schema-constrained structured outputs. |
| `text-to-speech` | The model is intended for text-to-audio synthesis. |
| `transcription` | The model supports transcription workloads for recorded or live audio. |
| `translation` | The model supports translation workloads, including file or realtime speech translation according to its interfaces. |
| `vision` | The model accepts image input for understanding, reference, or editing workflows. |

Notes:

- Normalized `proxyTemplate.capabilities` inherits root `capabilities`; source cards only need a field when deliberately overriding it.
- Some labels overlap by design. For example, a text-to-speech model can carry both `text-to-speech` and `speech-generation`, where one describes the product shape and the other describes the output capability.
- Capability labels should describe what the upstream model can do, not the internal AOAI Proxy route name that happens to carry the request.

### Capability and modality conventions

- If `inputModalities` includes `image`, `capabilities` should also include `vision`.
- If a model supports `image-editing`, it must accept image input; declare both `image` in `inputModalities` and `vision` in `capabilities`.
- Omit duplicate `proxyTemplate.capabilities`; the shared loader keeps templates aligned with root capabilities.
- If vendor documentation disagrees with the current file, correct the underlying modality declaration instead of adding `vision` speculatively.

### Upstream defaults

For runtime config normalization, `upstreams[].capabilities` defaults to the union of all `models[].capabilities` declared by models bound to that upstream.

If an upstream explicitly declares a capability that is not declared by any model using that upstream, config validation fails.