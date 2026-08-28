## pricing directory

This directory stores reusable model definitions for AOAI Proxy.

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
  - Mirrors the same model-native capability list for direct config scaffolding.

- `defaultInterface`
  - Selects the provider-facing protocol used when the requested protocol is unavailable and more than one declared interface remains.

- `protocolProfiles`
  - Stores protocol-specific parameter facts consumed by runtime routing and request conversion.
  - Text profiles can declare `reasoning.parameter`, `levels`, `default`, `aliases`, and `validation`; Messages profiles can also declare thinking types and a default.
  - `images/generations.request` can declare `transport`, `removeModel`, `qualityAliases`, `dropParameters`, and `sizeExpansion`.

### Label glossary

The tables below document the labels that are currently used by pricing definitions in this directory. When a new label is introduced, update this glossary in the same change so the JSON remains self-explanatory.

#### Interface labels

| Label | Meaning |
| --- | --- |
| `audio/speech` | Speech synthesis endpoint that takes text input and returns generated audio. |
| `audio/transcriptions` | Uploaded-audio transcription endpoint that returns text. |
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
| `translation` | The model supports translation workloads; in this library this is currently used for realtime speech translation. |
| `vision` | The model accepts image input for understanding, reference, or editing workflows. |

Notes:

- `proxyTemplate.capabilities` should normally use the same meanings as root `capabilities`; if a label is present in root definitions but absent from the proxy-template subset, it usually means some pricing entries do not expose a `proxyTemplate`.
- Some labels overlap by design. For example, a text-to-speech model can carry both `text-to-speech` and `speech-generation`, where one describes the product shape and the other describes the output capability.
- Capability labels should describe what the upstream model can do, not the internal AOAI Proxy route name that happens to carry the request.

### Capability and modality conventions

- If `inputModalities` includes `image`, `capabilities` should also include `vision`.
- If a model supports `image-editing`, it must accept image input; declare both `image` in `inputModalities` and `vision` in `capabilities`.
- Keep `proxyTemplate.capabilities` in sync with the root `capabilities` array whenever a pricing definition exposes a proxy template.
- If vendor documentation disagrees with the current file, correct the underlying modality declaration instead of adding `vision` speculatively.

### Upstream defaults

For runtime config normalization, `upstreams[].capabilities` defaults to the union of all `models[].capabilities` declared by models bound to that upstream.

If an upstream explicitly declares a capability that is not declared by any model using that upstream, config validation fails.