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

Use the repository formatter rather than hand-minifying JSON:

```bash
npm run cards:format
npm run cards:check
```

It uses two-space indentation, stable root/price/template field ordering, inline
scalar arrays when they fit within 120 columns, and one note per line. It removes
equivalent duplicates, preserves differing overrides and explicit nulls, and
refuses conflicting rate conversions. It only visits `pricing/*.json`, never
archives or live/persisted configuration. Unit tests enforce canonical formatting
and parity between the backend and bundled admin libraries.

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

The current limit audit intentionally leaves these active text cards unresolved
until provider-specific limits are verified: `DeepSeek-V4-Flash`, `grok-4`, and
`Kimi-K2.5`. The remaining active cards
without `contextWindow`/input/output limits are image, audio, speech, or
realtime-only cards whose provider contracts do not expose the same text-token
window fields. The reviewed exception set is enforced by the Model Catalog unit
test so a newly added card cannot silently introduce another missing limit.

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

Grok 4.3 and 4.6 now enable their **xAI-official** whole-request tables at
`promptTokensAtLeast: 200000`. Both xAI model pages explicitly apply the higher
rate to all tokens when the prompt reaches 200K. These are not independently
verified Azure-hosted prices; administrators must bind a matching price source
or supply a verified override for their deployment.

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
Grok 4.3/4.6 use `short <200K` / `long >=200K`. `K` means 1,000 tokens.
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
UI does not label those subtotals as a complete/free bill. Detail events retain
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
tables show write tokens and write cost separately, including partial or
unreported labels. Write cost is a component of the existing total, not an extra
budget charge.

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