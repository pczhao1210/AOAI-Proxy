// The runtime clone can outlive the configuration which is currently active.
const revisions = new WeakMap();
let activeConfig;

export function registerInferenceRevision(config, revision, historyId = null, descriptors = []) {
  revisions.set(config, { revision, historyId, catalogIds: new Map(descriptors.map(row => [row.publicId, row.catalogId])) });
  activeConfig = config;
}

export function getInferenceRevision(config) {
  return revisions.get(config)?.revision || null;
}

export function inferenceBinding(config, model, descriptor, deployment, routeKey, backendRouteKey) {
  const generation = revisions.get(config);
  // Multipart uploads and first-event realtime selection can finish after a reload.
  const catalogId = generation && config !== activeConfig ? generation.catalogIds.get(model.id) : descriptor?.catalogId;
  return Object.freeze({
    modelId: model.id,
    canonicalModelId: model.canonicalModelId || catalogId || null,
    channelId: model.selectedBinding?.channelId || null,
    sourceModelId: deployment || model.selectedBinding?.sourceModelId || model.targetModel || null,
    configRevision: getInferenceRevision(config),
    ...(generation?.historyId && { historyId: generation.historyId }),
    routeKey,
    backendRouteKey
  });
}
