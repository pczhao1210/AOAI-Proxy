## pricing directory

This directory stores reusable model definitions for AOAI Proxy.

### Field semantics

- `capabilities`
  - Stores provider/model-native feature labels directly, such as `reasoning`, `vision`, `function-calling`, and `structured-outputs`.
  - This list is intended to be copied into `config.models[].capabilities` as the model capability declaration.

- `proxyTemplate.capabilities`
  - Mirrors the same model-native capability list for direct config scaffolding.

### Upstream defaults

For runtime config normalization, `upstreams[].capabilities` defaults to the union of all `models[].capabilities` declared by models bound to that upstream.

If an upstream explicitly declares a capability that is not declared by any model using that upstream, config validation fails.