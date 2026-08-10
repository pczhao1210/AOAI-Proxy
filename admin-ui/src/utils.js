export const REDACTED_SECRET_VALUE = "__AOAI_PROXY_REDACTED__";

export const DEFAULT_KEY_TEMPLATE = {
  id: "",
  displayName: "",
  owner: "",
  key: "",
  status: "active",
  allowedModels: [],
  tags: [],
  rateLimit: {
    windowSeconds: 60,
    rpm: 0,
    tpm: 0,
    concurrency: 0
  },
  budget: {
    limitAmount: 0,
    currency: "USD",
    windowType: "monthly",
    softLimitRatio: 0.8,
    hardLimitAction: "block"
  },
  notes: ""
};

export const DEFAULT_UPSTREAM_TEMPLATE = {
  name: "",
  provider: "azure-openai",
  baseUrl: "",
  resourceName: "",
  status: "active",
  priority: 100,
  capabilities: [],
  routes: {
    "chat/completions": "/openai/v1/chat/completions",
    responses: "/openai/v1/responses",
    messages: "/anthropic/v1/messages",
    "images/generations": "/openai/v1/images/generations",
    "openai-image": "/openai/deployments/{deployment}/images/generations?api-version=2025-04-01-preview",
    "blackforest-image": "/providers/blackforestlabs/v1/{deployment}?api-version=preview"
  }
};

export const DEFAULT_MODEL_TEMPLATE = {
  id: "",
  displayName: "",
  status: "active",
  upstream: "",
  targetModel: "",
  capabilities: [],
  pricingRef: "",
  accessTags: [],
  clientCompatibility: {
    claudeCode: false,
    codex: false
  },
  codex: {},
  fallbackModels: [],
  defaultParams: {},
  requestPolicy: {
    allowedParams: [],
    blockedParams: [],
    dropUnsupportedParams: false
  },
  routes: {}
};

const LEGACY_ROUTE_CAPABILITIES = new Set(["chat", "responses", "messages", "stream", "images", "image"]);
export const KNOWN_MODEL_ROUTE_VALUES = [
  "chat/completions",
  "responses",
  "messages",
  "images/generations",
  "openai-image",
  "blackforest-image"
];

export const DEFAULT_LOG_FILTERS = {
  level: ["fatal", "error", "warn", "info"],
  event: "",
  modelId: "",
  requestId: "",
  keyword: "",
  limit: 100,
  autoRefresh: true
};

export const TEST_ENDPOINTS = [
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/messages",
  "/v1/images/generations"
];

export function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatList(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function supportsPricingTemplate(definition) {
  return !!(definition?.supportsProxyTemplate && definition?.proxyTemplate?.id && definition?.proxyTemplate?.targetModel);
}

export function ensureUniqueName(baseValue, existingValues) {
  const normalizedExisting = new Set((existingValues || []).filter(Boolean));
  const seed = String(baseValue || "item").trim() || "item";
  if (!normalizedExisting.has(seed)) return seed;
  let counter = 2;
  while (normalizedExisting.has(`${seed}-${counter}`)) {
    counter += 1;
  }
  return `${seed}-${counter}`;
}

export function hasLegacyRouteCapabilities(capabilities) {
  const normalized = normalizeStringArray(capabilities);
  return normalized.length > 0 && normalized.every((capability) => LEGACY_ROUTE_CAPABILITIES.has(capability));
}

export function isKnownModelRouteValue(value) {
  return KNOWN_MODEL_ROUTE_VALUES.includes(String(value || "").trim());
}

export function getSuggestedModelRouteValues(source) {
  const interfaces = normalizeStringArray(source?.interfaces);
  const capabilities = normalizeStringArray(source?.capabilities);
  const provider = String(source?.provider || "").trim().toLowerCase();
  const values = [];

  const isImageModel = interfaces.includes("images/generations")
    || capabilities.includes("image-generation")
    || capabilities.includes("image-editing");

  if (interfaces.includes("chat/completions")) {
    values.push("chat/completions");
  }
  if (interfaces.includes("responses")) {
    values.push("responses");
  }
  if (interfaces.includes("messages")) {
    values.push("messages");
  }
  if (isImageModel) {
    values.push("images/generations");
    if (provider === "black-forest-labs") {
      values.push("blackforest-image");
    } else {
      values.push("openai-image");
    }
  }

  if (!values.length) {
    values.push(...KNOWN_MODEL_ROUTE_VALUES);
  }

  return Array.from(new Set(values));
}

export function buildSuggestedUpstreamName(definition, config) {
  const baseName = String(definition?.provider || definition?.family || "upstream")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "upstream";
  return ensureUniqueName(baseName, (config?.upstreams || []).map((item) => item?.name));
}

export function buildUpstreamFromPricingTemplate(definition, upstreamName) {
  return {
    ...cloneJson(DEFAULT_UPSTREAM_TEMPLATE),
    name: upstreamName,
    provider: definition?.provider || DEFAULT_UPSTREAM_TEMPLATE.provider,
    capabilities: normalizeStringArray(definition?.upstreamTemplate?.capabilities || definition?.capabilities)
  };
}

export function buildModelFromPricingTemplate(definition, upstreamName, config) {
  const template = asPlainObject(definition?.proxyTemplate);
  const modelId = ensureUniqueName(
    template.id || definition?.id || `model_${(config?.models || []).length + 1}`,
    (config?.models || []).map((item) => item?.id)
  );
  return {
    ...cloneJson(DEFAULT_MODEL_TEMPLATE),
    id: modelId,
    displayName: String(template.displayName || definition?.displayName || modelId),
    status: "active",
    upstream: upstreamName || "",
    targetModel: String(template.targetModel || definition?.id || modelId),
    capabilities: normalizeStringArray(template.capabilities?.length ? template.capabilities : definition?.capabilities),
    pricingRef: String(template.pricingRef || definition?.id || ""),
    routes: cloneJson(template.routes || {})
  };
}

function normalizeTemplateLookupValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getTemplateLookupValues(definition) {
  return [
    definition?.id,
    definition?.displayName,
    definition?.proxyTemplate?.id,
    definition?.proxyTemplate?.targetModel,
    definition?.proxyTemplate?.pricingRef
  ]
    .map(normalizeTemplateLookupValue)
    .filter(Boolean);
}

export function findPricingTemplateByHint(definitions, ...hints) {
  const normalizedHints = hints
    .flat()
    .map(normalizeTemplateLookupValue)
    .filter(Boolean);

  if (!normalizedHints.length) return null;

  for (const hint of normalizedHints) {
    const matched = (definitions || []).find((definition) => getTemplateLookupValues(definition).includes(hint));
    if (matched) return matched;
  }

  return null;
}

export function findPricingTemplateForModel(definitions, model) {
  return findPricingTemplateByHint(
    definitions,
    model?.pricingRef,
    model?.id,
    model?.targetModel,
    model?.displayName
  );
}

export function applyPricingTemplateToModel(config, model, definition) {
  const templateModel = buildModelFromPricingTemplate(definition, model?.upstream || "", config);
  const normalizedModel = asPlainObject(model);
  const normalizedRequestPolicy = asPlainObject(normalizedModel.requestPolicy);
  const explicitTargetModel = String(normalizedModel.targetModel || "").trim();
  const explicitPricingRef = String(normalizedModel.pricingRef || "").trim();

  return {
    ...cloneJson(DEFAULT_MODEL_TEMPLATE),
    ...cloneJson(normalizedModel),
    id: String(normalizedModel.id || templateModel.id || ""),
    displayName: String(normalizedModel.displayName || templateModel.displayName || normalizedModel.id || ""),
    status: String(normalizedModel.status || templateModel.status || "active"),
    upstream: String(normalizedModel.upstream || templateModel.upstream || ""),
    targetModel: String(explicitTargetModel || templateModel.targetModel || ""),
    capabilities: [...templateModel.capabilities],
    pricingRef: String(explicitPricingRef || templateModel.pricingRef || ""),
    accessTags: normalizeStringArray(normalizedModel.accessTags),
    fallbackModels: normalizeStringArray(normalizedModel.fallbackModels),
    defaultParams: cloneJson(asPlainObject(normalizedModel.defaultParams)),
    requestPolicy: {
      ...cloneJson(DEFAULT_MODEL_TEMPLATE.requestPolicy),
      ...cloneJson(normalizedRequestPolicy),
      allowedParams: normalizeStringArray(normalizedRequestPolicy.allowedParams),
      blockedParams: normalizeStringArray(normalizedRequestPolicy.blockedParams),
      dropUnsupportedParams: normalizedRequestPolicy.dropUnsupportedParams === true
    },
    routes: cloneJson(templateModel.routes || {})
  };
}

export function upsertPricingCatalogEntry(config, definition) {
  const pricingRef = String(definition?.proxyTemplate?.pricingRef || definition?.id || "").trim();
  if (!pricingRef || !definition?.pricingCatalogEntry) return;

  config.access = asPlainObject(config.access);
  config.access.pricingCatalog = asPlainObject(config.access.pricingCatalog);
  config.access.pricingCatalog[pricingRef] = cloneJson(definition.pricingCatalogEntry);
}

export function syncUpstreamCapabilities(config, upstreamName) {
  const upstream = (config?.upstreams || []).find((item) => item?.name === upstreamName);
  if (!upstream) return;

  const union = new Set();
  for (const model of config?.models || []) {
    if (model?.upstream !== upstreamName) continue;
    for (const capability of normalizeStringArray(model.capabilities)) {
      union.add(capability);
    }
  }

  upstream.capabilities = [...union];
}

export function getValueByPath(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), source);
}

export function setValueByPath(target, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

export function formatDateTime(value) {
  const parsed = Date.parse(value || "");
  if (Number.isNaN(parsed)) return value || "-";
  const date = new Date(parsed);
  const pad = (part, width = 2) => String(part).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function msToDuration(ms, fallbackMs) {
  const numeric = Number(ms);
  const safe = Number.isFinite(numeric) && numeric >= 0 ? numeric : fallbackMs;
  return `${Math.max(1, Math.round(safe / 1000))}s`;
}

export function buildCaddyPreview(caddyConfig, serverPort) {
  if (!caddyConfig?.enabled) {
    return "# Caddy disabled\n# Proxy still listens on the configured server.port directly.";
  }
  const dialTimeout = msToDuration(caddyConfig?.transport?.dialTimeoutMs, 5000);
  const responseHeaderTimeout = msToDuration(caddyConfig?.transport?.responseHeaderTimeoutMs, 300000);
  const keepAliveTimeout = msToDuration(caddyConfig?.transport?.keepAliveTimeoutMs, 120000);
  const domain = caddyConfig.domain || "example.com";
  const upstreamHost = caddyConfig.upstreamHost || "127.0.0.1";
  const upstreamPort = caddyConfig.upstreamPort || serverPort || 3000;
  return `${domain} {\n  encode gzip\n\n  reverse_proxy ${upstreamHost}:${upstreamPort} {\n    transport http {\n      dial_timeout ${dialTimeout}\n      response_header_timeout ${responseHeaderTimeout}\n      keepalive ${keepAliveTimeout}\n    }\n  }\n}`;
}

export function buildDefaultTestPayload(endpoint, config) {
  const defaultModel = config?.models?.[0]?.id || config?.media?.generation?.defaultModel || "";
  if (endpoint === "/v1/responses") {
    return {
      model: defaultModel,
      input: "Return a short diagnostics summary for the AOAI proxy."
    };
  }
  if (endpoint === "/v1/messages") {
    return {
      model: defaultModel,
      messages: [{ role: "user", content: "Return a short diagnostics summary for the AOAI proxy." }],
      max_tokens: 256
    };
  }
  if (endpoint === "/v1/images/generations") {
    return {
      model: defaultModel,
      prompt: "A bold minimalist poster of cloud infrastructure over Tokyo skyline.",
      size: "1024x1024"
    };
  }
  return {
    model: defaultModel,
    messages: [
      {
        role: "user",
        content: "Summarize the current AOAI proxy health in one paragraph."
      }
    ],
    stream: false
  };
}

export function getLogMessage(entry) {
  const message = entry?.message || "";
  const failureReason = entry?.failureReason || "";
  if (message && failureReason && message !== failureReason && !message.includes(failureReason)) {
    return `${message}: ${failureReason}`;
  }
  return message || failureReason || entry?.errorCode || entry?.event || "-";
}

export function getLogDetails(entry) {
  const details = { ...(entry?.fields || {}) };
  if (entry?.clientIp) details.clientIp = entry.clientIp;
  if (entry?.forwardedFor) details.forwardedFor = entry.forwardedFor;
  if (entry?.userAgent) details.userAgent = entry.userAgent;
  return details;
}

export function getLocalizedLogLevelLabel(level, t) {
  const normalized = String(level || "info").toLowerCase();
  return t(`logs.level.${normalized}`, normalized);
}

export function getLocalizedLogEventLabel(eventName, t) {
  if (!eventName) return "";
  return t(`logs.event.${eventName}`, eventName);
}

export function getLocalizedLogSourceLabel(source, t) {
  if (!source) return "";
  return t(`logs.source.${source}`, source);
}

export function buildLogSummaryText(entry, t, formatDateTimeFn = formatDateTime) {
  const header = [
    `[${getLocalizedLogLevelLabel(entry?.level, t)}]`,
    getLocalizedLogEventLabel(entry?.event, t)
  ].filter(Boolean).join(" ");
  const lines = [
    header,
    getLogMessage(entry),
    entry?.ts ? `${t("logs.meta.time", "Time")}: ${formatDateTimeFn(entry.ts)}` : "",
    entry?.source ? `${t("logs.meta.source", "Source")}: ${getLocalizedLogSourceLabel(entry.source, t)}` : "",
    entry?.requestId ? `${t("logs.meta.requestId", "Request ID")}: ${entry.requestId}` : "",
    entry?.azureRequestId ? `${t("logs.meta.azureRequestId", "Azure Request ID")}: ${entry.azureRequestId}` : "",
    entry?.modelId ? `${t("logs.meta.model", "Model")}: ${entry.modelId}` : "",
    entry?.errorCode ? `${t("logs.meta.errorCode", "Error Code")}: ${entry.errorCode}` : "",
    entry?.status != null ? `${t("logs.meta.status", "Status")}: ${entry.status}` : ""
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatBool(value, t) {
  return value ? t("common.yes", "Yes") : t("common.no", "No");
}

export function formatRuntimeError(error) {
  if (!error) return "-";
  const code = error.code || "UnknownError";
  const message = error.message || "Unknown error";
  return `${code}: ${message}`;
}

export function describePersistenceRuntime(persistenceRuntime, t) {
  const runtime = persistenceRuntime || {};
  const configuredMode = runtime.mode || "file";
  const activeMode = runtime.activeMode || configuredMode;
  const lines = [
    `${t("runtime.configuredMode", "Configured Mode")}: ${configuredMode}`,
    `${t("runtime.activeMode", "Active Mode")}: ${activeMode}`,
    `${t("runtime.configPath", "Config Path")}: ${runtime.configPath || "-"}`,
    `${t("runtime.compatibilityPath", "Compatibility Path")}: ${runtime.compatibilityPath || "-"}`,
    `${t("runtime.dataDirMode", "Data Dir Mode")}: ${runtime.dataDirMode || "ephemeral"}`,
    `${t("runtime.pendingSync", "Pending Sync")}: ${formatBool(runtime.pendingDatabaseSync, t)}`,
    `${t("runtime.databaseAccessStateLabel", "Database Access State")}: ${runtime.databaseAccessState || "disabled"}`,
    `${t("runtime.databaseRecoveryIntervalMs", "Database Recovery Interval")}: ${runtime.databaseRecoveryIntervalMs ?? 0}`,
    `${t("runtime.nextDatabaseRecoveryAttemptAt", "Next Database Recovery")}: ${runtime.nextDatabaseRecoveryAttemptAt || "-"}`
  ];

  if (runtime.databaseProvider || runtime.databaseSchema || runtime.databaseTableName) {
    lines.push(`${t("runtime.databaseTarget", "Database Target")}: ${runtime.databaseProvider || "postgresql"}.${runtime.databaseSchema || "public"}.${runtime.databaseTableName || "proxy_configs"} (${runtime.databaseConfigKey || "active"})`);
  }
  if (runtime.lastDatabaseError) {
    lines.push(`${t("runtime.lastDatabaseError", "Last Database Error")}: ${formatRuntimeError(runtime.lastDatabaseError)}`);
  }
  return lines.join("\n");
}

export function describeLoggingRuntime(loggingRuntime, t) {
  const runtime = loggingRuntime || {};
  const lines = [
    `${t("field.logLevel", "Log Level")}: ${runtime.level || "-"}`,
    `${t("field.logSinks", "Log Sinks")}: ${Array.isArray(runtime.sinks) ? runtime.sinks.join(", ") : "-"}`,
    `${t("field.logBufferSize", "Log Buffer Size")}: ${runtime.memoryBufferSize ?? 0}`,
    `${t("runtime.logAnalyticsEnabled", "Log Analytics Enabled")}: ${formatBool(runtime.logAnalyticsEnabled ?? runtime.enabled, t)}`,
    `${t("runtime.logAnalyticsConfigured", "Log Analytics Configured")}: ${formatBool(runtime.logAnalyticsConfigured ?? runtime.configured, t)}`,
    `${t("runtime.flushing", "Flushing")}: ${formatBool(runtime.flushing, t)}`,
    `${t("runtime.queueLength", "Queue Length")}: ${runtime.queueLength ?? 0}`,
    `${t("runtime.droppedEntries", "Dropped Entries")}: ${runtime.droppedEntries ?? 0}`,
    `${t("runtime.flushFailures", "Flush Failures")}: ${runtime.flushFailures ?? 0}`,
    `${t("runtime.contentMode", "Content Mode")}: ${runtime.contentMode || "summary"}`,
    `${t("runtime.flushIntervalMs", "Flush Interval ms")}: ${runtime.flushIntervalMs ?? 0}`,
    `${t("runtime.batchSize", "Batch Size")}: ${runtime.batchSize ?? 0}`,
    `${t("runtime.samplingRatio", "Sampling Ratio")}: ${runtime.samplingRatio ?? 1}`,
    `${t("runtime.maxConcurrency", "Max Concurrency")}: ${runtime.maxConcurrency ?? 0}`
  ];

  if (runtime.endpoint) {
    lines.push(`${t("runtime.endpoint", "Endpoint")}: ${runtime.endpoint}`);
  }
  if (runtime.workspaceId) {
    lines.push(`${t("runtime.workspaceId", "Workspace ID")}: ${runtime.workspaceId}`);
  }
  if (runtime.tableName) {
    lines.push(`${t("runtime.tableName", "Table")}: ${runtime.tableName}`);
  }
  if (runtime.streamName) {
    lines.push(`${t("runtime.streamName", "Stream")}: ${runtime.streamName}`);
  }
  if (runtime.lastSuccessTs) {
    lines.push(`${t("runtime.lastSuccessTs", "Last Success")}: ${runtime.lastSuccessTs}`);
  }
  if (runtime.nextFlushAt) {
    lines.push(`${t("runtime.nextFlushAt", "Next Flush")}: ${runtime.nextFlushAt}`);
  }
  if (runtime.lastError) {
    lines.push(`${t("runtime.lastError", "Last Error")}: ${formatRuntimeError(runtime.lastError)}`);
  }
  return lines.join("\n");
}

export function flattenConfig(value, prefix = "", out = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenConfig(item, `${prefix}[${index}]`, out);
    });
    if (!value.length && prefix) {
      out[prefix] = "[]";
    }
    return out;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length && prefix) {
      out[prefix] = "{}";
      return out;
    }
    entries.forEach(([key, child]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenConfig(child, nextPrefix, out);
    });
    return out;
  }
  if (prefix) {
    out[prefix] = JSON.stringify(value);
  }
  return out;
}

export function computeConfigDiff(previousConfig, nextConfig) {
  const previousFlat = flattenConfig(previousConfig || {});
  const nextFlat = flattenConfig(nextConfig || {});
  const keys = new Set([...Object.keys(previousFlat), ...Object.keys(nextFlat)]);
  const diff = { added: [], removed: [], changed: [] };

  Array.from(keys).sort().forEach((key) => {
    if (!(key in previousFlat)) {
      diff.added.push(key);
      return;
    }
    if (!(key in nextFlat)) {
      diff.removed.push(key);
      return;
    }
    if (previousFlat[key] !== nextFlat[key]) {
      diff.changed.push(key);
    }
  });

  return diff;
}

export function summarizeConfigDiff(diff) {
  return (diff?.added?.length || 0) + (diff?.removed?.length || 0) + (diff?.changed?.length || 0);
}

export function inspectConfigStructure(config) {
  const issues = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["Root config must be an object"];
  }
  if (!config.server || typeof config.server !== "object") {
    issues.push("server must be an object");
  }
  if (!config.auth || typeof config.auth !== "object") {
    issues.push("auth must be an object");
  }
  if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
    issues.push("apiKeys must be a non-empty array");
  }
  if (!Array.isArray(config.upstreams) || config.upstreams.length === 0) {
    issues.push("upstreams must be a non-empty array");
  }
  if (!Array.isArray(config.models) || config.models.length === 0) {
    issues.push("models must be a non-empty array");
  }
  return issues;
}

function formatDiffPath(path, kind) {
  const marker = kind === "added" ? "+" : kind === "removed" ? "-" : "~";
  return `${marker} ${path}`;
}

export function buildConfigDiffPreview(diff, t) {
  const diffCount = summarizeConfigDiff(diff);
  if (!diffCount) {
    return `${t("config.diff.previewTitle", "Diff Preview")}: ${t("config.diff.none", "No changes")}`;
  }
  const lines = [t("config.diff.previewTitle", "Diff Preview")];
  (diff?.added || []).slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "added")));
  (diff?.changed || []).slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "changed")));
  (diff?.removed || []).slice(0, 4).forEach((path) => lines.push(formatDiffPath(path, "removed")));
  return lines.join("\n");
}

export const COMPRESSION_PRESETS = {
  light: { maxSize: 1600, quality: 0.85 },
  standard: { maxSize: 1280, quality: 0.8 },
  strong: { maxSize: 1024, quality: 0.7 }
};

export function pickCompressionPreset(config) {
  const maxSize = Number(config?.maxLongSidePx ?? config?.maxSize ?? 1600);
  if (maxSize >= 1500) return "light";
  if (maxSize >= 1200) return "standard";
  return "strong";
}

export function applyCompressionPresetToConfig(config, presetKey, enabled) {
  const preset = COMPRESSION_PRESETS[presetKey] || COMPRESSION_PRESETS.standard;
  config.media = config.media || {};
  config.media.inputCompression = {
    ...(config.media.inputCompression || {}),
    enabled,
    maxLongSidePx: preset.maxSize,
    quality: preset.quality,
    outputFormat: "jpeg"
  };
  config.server = config.server || {};
  config.server.imageCompression = {
    enabled,
    maxSize: preset.maxSize,
    quality: preset.quality,
    format: "jpeg"
  };
  return config;
}

function isDataUrl(value) {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value);
}

function detectBase64Mime(value) {
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("iVBOR")) return "image/png";
  if (value.startsWith("UklGR")) return "image/webp";
  return null;
}

function collectImageTargets(value, results, parent, key) {
  if (typeof value === "string") {
    if (isDataUrl(value)) {
      results.push({ parent, key, value, type: "dataUrl" });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectImageTargets(item, results, value, index));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      if (typeof childValue === "string" && childKey === "image_base64" && !isDataUrl(childValue)) {
        const mime = detectBase64Mime(childValue);
        if (mime) {
          results.push({ parent: value, key: childKey, value: childValue, type: "base64", mime });
          return;
        }
      }
      collectImageTargets(childValue, results, value, childKey);
    });
  }
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  let value = bytes;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function compressDataUrl(dataUrl, preset) {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, preset.maxSize / Math.max(image.width, image.height));
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL("image/jpeg", preset.quality);
}

function replacePlaceholders(value, dataUrl, base64, meta) {
  if (typeof value === "string") {
    if (value === "__IMAGE_DATA_URL__") {
      meta.replaced += 1;
      return dataUrl;
    }
    if (value === "__IMAGE_BASE64__") {
      meta.replaced += 1;
      return base64;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, dataUrl, base64, meta));
  }
  if (value && typeof value === "object") {
    const nextValue = { ...value };
    Object.entries(value).forEach(([key, child]) => {
      nextValue[key] = replacePlaceholders(child, dataUrl, base64, meta);
    });
    return nextValue;
  }
  return value;
}

export function buildImagePlaceholderPayload(kind, t) {
  const placeholder = kind === "base64" ? "__IMAGE_BASE64__" : "__IMAGE_DATA_URL__";
  return {
    model: "gpt-5-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: t("payload.greeting", "Describe this image.") },
          { type: "image_url", image_url: { url: placeholder } }
        ]
      }
    ],
    stream: false
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function prepareProxyPayload(payload, { imageFile, compressionEnabled, presetKey, t }) {
  const preset = COMPRESSION_PRESETS[presetKey] || COMPRESSION_PRESETS.standard;
  let nextPayload = cloneJson(payload);
  let statsText = "";

  if (imageFile) {
    const originalDataUrl = await readFileAsDataUrl(imageFile);
    let dataUrl = originalDataUrl;
    if (compressionEnabled) {
      try {
        dataUrl = await compressDataUrl(originalDataUrl, preset);
      } catch {
        dataUrl = originalDataUrl;
      }
    }
    const base64 = dataUrl.split(",")[1] || "";
    const meta = { replaced: 0 };
    nextPayload = replacePlaceholders(nextPayload, dataUrl, base64, meta);
    if (meta.replaced === 0) {
      return {
        payload: nextPayload,
        statsText: t("compress.placeholder.missing", "No image placeholder was found in the payload.")
      };
    }
    statsText = `${t("compress.stats", "Compression Stats")}: ${meta.replaced}, ${formatBytes(estimateDataUrlBytes(originalDataUrl))} -> ${formatBytes(estimateDataUrlBytes(dataUrl))}`;
    return { payload: nextPayload, statsText };
  }

  if (!compressionEnabled) {
    return { payload: nextPayload, statsText };
  }

  const targets = [];
  collectImageTargets(nextPayload, targets, null, null);
  if (!targets.length) {
    return {
      payload: nextPayload,
      statsText: t("compress.stats.none", "No inline images detected in the payload.")
    };
  }

  let beforeBytes = 0;
  let afterBytes = 0;
  let compressedCount = 0;

  for (const target of targets) {
    const dataUrl = target.type === "base64" ? `data:${target.mime};base64,${target.value}` : target.value;
    beforeBytes += estimateDataUrlBytes(dataUrl);
    try {
      const compressed = await compressDataUrl(dataUrl, preset);
      afterBytes += estimateDataUrlBytes(compressed);
      compressedCount += 1;
      if (target.type === "base64") {
        target.parent[target.key] = compressed.split(",")[1];
      } else {
        target.parent[target.key] = compressed;
      }
    } catch {
      afterBytes += estimateDataUrlBytes(dataUrl);
    }
  }

  return {
    payload: nextPayload,
    statsText: `${t("compress.stats", "Compression Stats")}: ${compressedCount}, ${formatBytes(beforeBytes)} -> ${formatBytes(afterBytes)}`
  };
}

export function getPayloadEditorNote(payloadText, t) {
  return payloadText.length > 200000
    ? t("payload.tooLarge", "Payload is too large to mirror back into the editor automatically.")
    : "";
}