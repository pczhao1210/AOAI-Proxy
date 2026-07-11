import { getLogRuntimeInfo } from "./logs.js";
import { getConfiguredModelBindingIssues } from "./model-validation.js";
import { readPersistedConfigText, writePersistedConfigText, getPersistenceSummary, setPersistenceConfig } from "./persistence.js";
import { resolveNativeModelCapabilities } from "./pricing-library.js";
import { getRuntimeStoreInfo, setRuntimeStoreConfig } from "./runtime-store.js";
import { isSupportedPersistenceMode } from "./persistence-mode.js";

// Default config values
const DEFAULTS = {
  server: {
    host: "0.0.0.0",
    port: 3000,
    gracefulShutdownMs: 30000,
    adminPath: "/admin",
    adminAuth: {
      enabled: false,
      username: "admin",
      password: "change-me"
    },
    caddy: {
      enabled: false,
      domain: "",
      email: "",
      httpsPort: 443,
      upstreamHost: "127.0.0.1",
      upstreamPort: 3000,
      transport: {
        dialTimeoutMs: 5000,
        responseHeaderTimeoutMs: 1260000,
        keepAliveTimeoutMs: 120000
      }
    },
    imageCompression: {
      enabled: false,
      maxSize: 1600,
      quality: 0.85,
      format: "jpeg"
    },
    upstream: {
      connectTimeoutMs: 10000,
      requestTimeoutMs: 900000,
      firstByteTimeoutMs: 300000,
      idleTimeoutMs: 300000,
      maxRetries: 0,
      retryBaseMs: 800,
      retryMaxMs: 8000,
      retryStatuses: [408, 409, 425, 429, 500, 502, 503, 504],
      pool: {
        connections: 32,
        keepAliveTimeoutMs: 60000,
        keepAliveMaxTimeoutMs: 300000,
        headersTimeoutMs: 330000,
        bodyTimeoutMs: 0,
        pipelining: 1
      }
    }
  },
  auth: {
    mode: "servicePrincipal",
    tenantId: "",
    clientId: "",
    clientSecret: "",
    managedIdentityClientId: "",
    scope: "https://cognitiveservices.azure.com/.default",
    apiKey: ""
  },
  admin: {
    basePath: "/admin",
    auth: {
      enabled: false,
      mode: "basic",
      username: "admin",
      password: "change-me",
      passwordRef: "",
      sessionTtlMs: 86400000,
      allowBasicAuth: true,
      allowOidc: false
    },
    security: {
      allowedIps: [],
      csrfProtection: true,
      auditAllWrites: true,
      maskSecretsInUi: true
    },
    features: {
      enableLegacyJsonEditor: true,
      enableConfigImportExport: true,
      enableDangerousActions: false
    }
  },
  proxy: {
    timeouts: {
      connectMs: 10000,
      requestMs: 900000,
      firstByteMs: 300000,
      idleMs: 300000,
      maxStreamDurationMs: 3600000,
      allowPerRequestOverride: false,
      requestOverrideFields: ["timeoutMs", "streamTimeoutMs", "idleTimeoutMs", "maxStreamDurationMs"],
      requestOverrideLimits: {
        requestMs: 900000,
        firstByteMs: 300000,
        idleMs: 900000,
        maxStreamDurationMs: 3600000,
        maxRetries: 0
      }
    },
    retries: {
      maxRetries: 0,
      baseDelayMs: 800,
      maxDelayMs: 8000,
      statuses: [408, 409, 425, 429, 500, 502, 503, 504],
      retryBeforeFirstChunkOnly: true,
      classifyNetworkErrorsAsRetryable: true
    },
    httpClient: {
      implementation: "undici",
      connections: 32,
      keepAliveTimeoutMs: 60000,
      keepAliveMaxTimeoutMs: 300000,
      headersTimeoutMs: 330000,
      bodyTimeoutMs: 0,
      pipelining: 1,
      dnsCacheTtlMs: 300000,
      forceIpv4: false
    },
    forwardHeaders: {
      mode: "denylist",
      allow: ["accept", "accept-encoding", "accept-language", "user-agent", "traceparent", "tracestate", "baggage", "x-request-id", "x-correlation-id", "anthropic-beta", "openai-organization"],
      deny: ["authorization", "x-api-key", "api-key", "ocp-apim-subscription-key", "content-length", "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"],
      addRequestIdHeader: true
    },
    guards: {
      maxRequestBodyBytes: 50 * 1024 * 1024,
      maxResponseBodyBytes: 50 * 1024 * 1024,
      rejectUnknownProxyParams: false,
      dropUnsupportedOpenAiParams: false,
      sanitizeMeaninglessValues: true
    }
  },
  routing: {
    routeProfiles: {
      chatCompletions: {
        enabled: true,
        defaultParams: {},
        allowedRequestFields: []
      },
      responses: {
        enabled: true,
        defaultParams: {},
        allowedRequestFields: []
      },
      imageGenerations: {
        enabled: true,
        defaultParams: {},
        allowedRequestFields: [],
        polling: {
          intervalMs: 2000,
          timeoutMs: 600000
        }
      }
    },
    fallbacks: {
      enabled: false,
      maxFallbacks: 0,
      byModel: {},
      byErrorCode: {}
    },
    cooldowns: {
      enabled: false,
      allowedFails: 3,
      cooldownTimeMs: 30000,
      byErrorType: {}
    },
    healthChecks: {
      enabled: false,
      intervalMs: 300000,
      timeoutMs: 60000,
      trackLatency: true
    },
    preCallChecks: {
      validateModelCapabilities: true,
      validateContextWindow: false,
      validateImageInput: true
    }
  },
  media: {
    inputCompression: {
      enabled: false,
      maxLongSidePx: 1600,
      quality: 0.85,
      outputFormat: "jpeg",
      minQuality: 0.1,
      progressive: false,
      useMozJpeg: true
    },
    remoteImages: {
      allow: false,
      maxDownloadSizeMb: 50,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
      allowedHosts: [],
      timeoutMs: 10000
    },
    inlineImages: {
      maxBase64Bytes: 20 * 1024 * 1024,
      redactInLogs: true,
      logPreviewChars: 64
    },
    generation: {
      enabled: true,
      defaultModel: "",
      requestTimeoutMs: 600000,
      pollIntervalMs: 2000,
      pollTimeoutMs: 600000,
      maxImages: 4,
      allowedSizes: [],
      allowedQualityModes: []
    }
  },
  observability: {
    logs: {
      level: "warn",
      sinks: ["memory", "console"],
      bufferSize: 100,
      redactSecrets: true,
      redactApiKeyInfo: true,
      messageContentMode: "summary",
      maxPayloadLogBytes: 102400,
      maxBase64LogChars: 64,
      includeClientIp: true,
      includeUsage: true,
      includeHeaders: false
    },
    logAnalytics: {
      enabled: false,
      workspaceId: "",
      endpoint: "",
      dcrImmutableId: "",
      streamName: "",
      audience: "",
      credentialRef: "",
      tableName: "AOAIProxyLogs",
      flushIntervalMs: 10000,
      batchSize: 100,
      samplingRatio: 1,
      maxConcurrency: 1,
      maxQueueSize: 5000,
      contentMode: "summary",
      fieldPolicies: {}
    },
    runtimeStore: {
      enabled: true,
      connectionRef: "",
      schema: "public",
      eventsTableName: "runtime_events",
      rollupsTableName: "runtime_rollups",
      metaTableName: "runtime_store_meta",
      localBufferPath: "",
      detailRetentionDays: 30,
      rollupRetentionDays: 365,
      rollupBatchSize: 5000,
      flushIntervalMs: 1000,
      batchSize: 100,
      maxQueueSize: 5000,
      maxPersistedEvents: 50000
    },
    metrics: {
      enabled: false,
      exposePrometheus: false,
      includePerKeyMetrics: true,
      includePerModelMetrics: true
    },
    audit: {
      enabled: true,
      recordReadActions: false,
      recordWriteActions: true,
      retentionDays: 30
    }
  },
  persistence: {
    configStore: {
      mode: "file",
      filePath: "./config/config.json",
      database: {
        enabled: false,
        provider: "postgresql",
        connectionRef: "",
        schema: "public",
        tableName: "proxy_configs",
        configKey: "active",
        pool: {},
        readFallbackMode: "lastKnownGood"
      }
    },
    cache: {
      type: "memory",
      ttlMs: 60000
    },
    compatibilityExport: {
      enabled: true,
      exportLegacyConfigOnChange: true,
      legacyConfigPath: "./config/config.json"
    }
  },
  access: {
    defaults: {
      requireApiKey: true,
      keyHeaderNames: ["Authorization", "x-api-key"],
      defaultKeyStatus: "active",
      enforceUserField: false,
      rejectClientSideMetadataTags: false
    },
    rateLimits: {
      windowSeconds: 60,
      defaultRpm: 60,
      defaultTpm: 0,
      defaultConcurrency: 8
    },
    budgets: {
      enabled: false,
      defaultCurrency: "USD",
      defaultWindowType: "monthly",
      softLimitRatio: 0.8,
      hardLimitAction: "block"
    },
    pricingCatalog: {},
    keyStorage: {
      hashAlgorithm: "sha256",
      prefixLength: 8,
      rotationGracePeriodMs: 0
    }
  },
  compatibility: {
    enableLegacyConfigRead: true,
    enableLegacyConfigWrite: true,
    mapServerAdminPathToAdminBasePath: true,
    mapImageCompressionToMediaInputCompression: true,
    mapServerUpstreamToProxyDefaults: true,
    warnOnDeprecatedFields: true,
    failOnDeprecatedFieldsAfterVersion: 3
  },
  apiKeys: [],
  upstreams: [],
  models: []
};

let currentConfig = null;
let persistedConfig = null;
const INSECURE_SECRET_VALUES = new Set([
  "admin",
  "password",
  "change-me",
  "changeme"
]);

function getEnvironmentValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function getEnvironmentBoolean(...names) {
  const value = getEnvironmentValue(...names).toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function isPublicListenHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return !["127.0.0.1", "::1", "localhost"].includes(normalized);
}

function isKnownInsecureSecret(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || INSECURE_SECRET_VALUES.has(normalized);
}

export function applyConfigEnvironmentOverrides(config) {
  const adminUsername = getEnvironmentValue("AOAI_PROXY_ADMIN_USERNAME", "ADMIN_USERNAME");
  const passwordRef = String(config?.admin?.auth?.passwordRef || "").trim();
  const adminPassword = getEnvironmentValue(
    "AOAI_PROXY_ADMIN_PASSWORD",
    "ADMIN_PASSWORD",
    ...(passwordRef ? [passwordRef] : [])
  );
  const adminAuthEnabled = getEnvironmentBoolean("AOAI_PROXY_ADMIN_AUTH_ENABLED", "ADMIN_AUTH_ENABLED");
  const proxyApiKey = getEnvironmentValue("AOAI_PROXY_API_KEY", "PROXY_API_KEY");
  const upstreamApiKey = getEnvironmentValue("AOAI_PROXY_UPSTREAM_API_KEY", "UPSTREAM_API_KEY");
  const caddyEnabled = getEnvironmentBoolean("AOAI_PROXY_CADDY_ENABLED", "CADDY_ENABLED");
  const caddyDomain = getEnvironmentValue("AOAI_PROXY_CADDY_DOMAIN", "CADDY_DOMAIN");
  const caddyEmail = getEnvironmentValue("AOAI_PROXY_CADDY_EMAIL", "CADDY_EMAIL");
  const trustProxy = getEnvironmentBoolean("AOAI_PROXY_TRUST_PROXY", "TRUST_PROXY");

  if (adminUsername) {
    config.admin.auth.username = adminUsername;
    config.server.adminAuth.username = adminUsername;
  }
  if (adminPassword) {
    config.admin.auth.password = adminPassword;
    config.server.adminAuth.password = adminPassword;
  }
  if (adminAuthEnabled !== null || adminPassword) {
    const enabled = adminAuthEnabled ?? true;
    config.admin.auth.enabled = enabled;
    config.server.adminAuth.enabled = enabled;
  }
  if (proxyApiKey) {
    if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
      config.apiKeys = [{ id: "default", key: proxyApiKey, status: "active" }];
    } else {
      const defaultKey = config.apiKeys.find((item) => item?.id === "default");
      if (defaultKey) {
        defaultKey.key = proxyApiKey;
        defaultKey.status = "active";
      } else {
        config.apiKeys.push({ id: "default", key: proxyApiKey, status: "active" });
      }
    }
  }
  if (upstreamApiKey) {
    config.auth.apiKey = upstreamApiKey;
  }
  if (caddyDomain) config.server.caddy.domain = caddyDomain;
  if (caddyEmail) config.server.caddy.email = caddyEmail;
  if (caddyEnabled !== null || caddyDomain) {
    config.server.caddy.enabled = caddyEnabled ?? true;
  }
  if (trustProxy !== null) {
    config.server.trustProxy = trustProxy;
  }
  return config;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function preserveEnvironmentManagedFields(config, previousPersistedConfig) {
  if (!previousPersistedConfig) return config;
  const previous = previousPersistedConfig;
  const adminUsername = getEnvironmentValue("AOAI_PROXY_ADMIN_USERNAME", "ADMIN_USERNAME");
  const passwordRef = String(previous?.admin?.auth?.passwordRef || config?.admin?.auth?.passwordRef || "").trim();
  const adminPassword = getEnvironmentValue(
    "AOAI_PROXY_ADMIN_PASSWORD",
    "ADMIN_PASSWORD",
    ...(passwordRef ? [passwordRef] : [])
  );
  const adminAuthEnabled = getEnvironmentBoolean("AOAI_PROXY_ADMIN_AUTH_ENABLED", "ADMIN_AUTH_ENABLED");
  const proxyApiKey = getEnvironmentValue("AOAI_PROXY_API_KEY", "PROXY_API_KEY");
  const upstreamApiKey = getEnvironmentValue("AOAI_PROXY_UPSTREAM_API_KEY", "UPSTREAM_API_KEY");
  const caddyEnabled = getEnvironmentBoolean("AOAI_PROXY_CADDY_ENABLED", "CADDY_ENABLED");
  const caddyDomain = getEnvironmentValue("AOAI_PROXY_CADDY_DOMAIN", "CADDY_DOMAIN");
  const caddyEmail = getEnvironmentValue("AOAI_PROXY_CADDY_EMAIL", "CADDY_EMAIL");
  const trustProxy = getEnvironmentBoolean("AOAI_PROXY_TRUST_PROXY", "TRUST_PROXY");

  if (adminUsername) {
    config.admin.auth.username = previous.admin.auth.username;
    config.server.adminAuth.username = previous.server.adminAuth.username;
  }
  if (adminPassword) {
    config.admin.auth.password = previous.admin.auth.password;
    config.server.adminAuth.password = previous.server.adminAuth.password;
  }
  if (adminAuthEnabled !== null || adminPassword) {
    config.admin.auth.enabled = previous.admin.auth.enabled;
    config.server.adminAuth.enabled = previous.server.adminAuth.enabled;
  }
  if (proxyApiKey) {
    const candidateKeys = Array.isArray(config.apiKeys) ? config.apiKeys : [];
    const previousKeys = Array.isArray(previous.apiKeys) ? previous.apiKeys : [];
    const candidateDefault = candidateKeys.find((item) => item?.id === "default");
    const previousDefault = previousKeys.find((item) => item?.id === "default");
    if (candidateDefault && previousDefault) {
      candidateDefault.key = previousDefault.key;
      candidateDefault.status = previousDefault.status;
    } else if (candidateDefault && !previousDefault && candidateDefault.key === proxyApiKey) {
      config.apiKeys = candidateKeys.filter((item) => item !== candidateDefault);
    }
  }
  if (upstreamApiKey) config.auth.apiKey = previous.auth.apiKey;
  if (caddyEnabled !== null || caddyDomain) config.server.caddy.enabled = previous.server.caddy.enabled;
  if (caddyDomain) config.server.caddy.domain = previous.server.caddy.domain;
  if (caddyEmail) config.server.caddy.email = previous.server.caddy.email;
  if (trustProxy !== null) config.server.trustProxy = previous.server.trustProxy;
  return config;
}

function deepMerge(base, override) {
  if (Array.isArray(base)) {
    return Array.isArray(override) ? override : base;
  }
  if (typeof base === "object" && base !== null) {
    const out = { ...base };
    for (const [k, v] of Object.entries(override || {})) {
      if (k in base) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return override ?? base;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickInteger(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return value;
  }
  return undefined;
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function collectCapabilitiesForUpstream(models, upstreamName) {
  if (!upstreamName) return [];
  const unique = new Set();
  for (const model of Array.isArray(models) ? models : []) {
    if (model?.upstream !== upstreamName) continue;
    for (const capability of normalizeStringArray(model.capabilities)) {
      unique.add(capability);
    }
  }
  return [...unique];
}

function normalizeRouteProfileKey(routeKey) {
  if (routeKey === "chat/completions") return "chatCompletions";
  if (routeKey === "responses") return "responses";
  if (routeKey === "images/generations") return "imageGenerations";
  return routeKey;
}

function applySchemaCompatibility(rawConfig, merged) {
  const raw = asPlainObject(rawConfig);
  const rawServer = asPlainObject(raw.server);
  const rawAdmin = asPlainObject(raw.admin);
  const rawProxy = asPlainObject(raw.proxy);
  const rawMedia = asPlainObject(raw.media);

  merged.version = pickInteger(raw.version, merged.version, 2);

  merged.admin = deepMerge(DEFAULTS.admin, asPlainObject(merged.admin));
  merged.admin.basePath = String(pickDefined(rawAdmin.basePath, rawServer.adminPath, merged.admin.basePath) || DEFAULTS.admin.basePath);
  merged.admin.auth = deepMerge(
    DEFAULTS.admin.auth,
    deepMerge(asPlainObject(rawServer.adminAuth), asPlainObject(rawAdmin.auth))
  );
  merged.server.adminPath = merged.admin.basePath;
  merged.server.adminAuth = {
    enabled: merged.admin.auth.enabled !== false,
    username: String(merged.admin.auth.username || DEFAULTS.server.adminAuth.username),
    password: String(merged.admin.auth.password || rawServer.adminAuth?.password || DEFAULTS.server.adminAuth.password)
  };

  merged.media = deepMerge(DEFAULTS.media, asPlainObject(merged.media));
  merged.media.inputCompression = deepMerge(
    DEFAULTS.media.inputCompression,
    deepMerge(asPlainObject(rawServer.imageCompression), asPlainObject(rawMedia.inputCompression))
  );
  merged.media.remoteImages = deepMerge(DEFAULTS.media.remoteImages, asPlainObject(merged.media.remoteImages));
  merged.media.remoteImages.allowedMimeTypes = normalizeStringArray(merged.media.remoteImages.allowedMimeTypes);
  merged.media.remoteImages.allowedHosts = normalizeStringArray(merged.media.remoteImages.allowedHosts);
  merged.media.inlineImages = deepMerge(DEFAULTS.media.inlineImages, asPlainObject(merged.media.inlineImages));
  merged.media.generation = deepMerge(DEFAULTS.media.generation, asPlainObject(merged.media.generation));
  merged.server.imageCompression = {
    enabled: merged.media.inputCompression.enabled !== false,
    maxSize: pickNumber(merged.media.inputCompression.maxLongSidePx, DEFAULTS.server.imageCompression.maxSize),
    quality: pickNumber(merged.media.inputCompression.quality, DEFAULTS.server.imageCompression.quality),
    format: merged.media.inputCompression.outputFormat === "webp" ? "webp" : "jpeg"
  };

  const rawLegacyUpstream = asPlainObject(rawServer.upstream);
  const rawProxyTimeouts = asPlainObject(rawProxy.timeouts);
  const rawProxyRetries = asPlainObject(rawProxy.retries);
  const rawProxyHttpClient = asPlainObject(rawProxy.httpClient);
  merged.proxy = deepMerge(DEFAULTS.proxy, asPlainObject(merged.proxy));
  merged.proxy.timeouts = deepMerge(DEFAULTS.proxy.timeouts, asPlainObject(merged.proxy.timeouts));
  merged.proxy.timeouts.connectMs = pickInteger(rawProxyTimeouts.connectMs, rawLegacyUpstream.connectTimeoutMs, merged.proxy.timeouts.connectMs, DEFAULTS.proxy.timeouts.connectMs);
  merged.proxy.timeouts.requestMs = pickInteger(rawProxyTimeouts.requestMs, rawLegacyUpstream.requestTimeoutMs, merged.proxy.timeouts.requestMs, DEFAULTS.proxy.timeouts.requestMs);
  merged.proxy.timeouts.firstByteMs = pickInteger(rawProxyTimeouts.firstByteMs, rawLegacyUpstream.firstByteTimeoutMs, merged.proxy.timeouts.firstByteMs, DEFAULTS.proxy.timeouts.firstByteMs);
  merged.proxy.timeouts.idleMs = pickInteger(rawProxyTimeouts.idleMs, rawLegacyUpstream.idleTimeoutMs, merged.proxy.timeouts.idleMs, DEFAULTS.proxy.timeouts.idleMs);
  merged.proxy.timeouts.maxStreamDurationMs = pickInteger(rawProxyTimeouts.maxStreamDurationMs, merged.proxy.timeouts.maxStreamDurationMs, DEFAULTS.proxy.timeouts.maxStreamDurationMs) ?? 0;
  merged.proxy.timeouts.allowPerRequestOverride = pickBoolean(rawProxyTimeouts.allowPerRequestOverride, merged.proxy.timeouts.allowPerRequestOverride, DEFAULTS.proxy.timeouts.allowPerRequestOverride) ?? false;
  merged.proxy.timeouts.requestOverrideFields = normalizeStringArray(
    pickDefined(rawProxyTimeouts.requestOverrideFields, merged.proxy.timeouts.requestOverrideFields, DEFAULTS.proxy.timeouts.requestOverrideFields)
  );

  merged.proxy.retries = deepMerge(DEFAULTS.proxy.retries, asPlainObject(merged.proxy.retries));
  merged.proxy.retries.maxRetries = pickInteger(rawProxyRetries.maxRetries, rawLegacyUpstream.maxRetries, merged.proxy.retries.maxRetries, DEFAULTS.proxy.retries.maxRetries);
  merged.proxy.retries.baseDelayMs = pickInteger(rawProxyRetries.baseDelayMs, rawLegacyUpstream.retryBaseMs, merged.proxy.retries.baseDelayMs, DEFAULTS.proxy.retries.baseDelayMs);
  merged.proxy.retries.maxDelayMs = pickInteger(rawProxyRetries.maxDelayMs, rawLegacyUpstream.retryMaxMs, merged.proxy.retries.maxDelayMs, DEFAULTS.proxy.retries.maxDelayMs);
  merged.proxy.retries.statuses = Array.isArray(rawProxyRetries.statuses)
    ? rawProxyRetries.statuses
    : (Array.isArray(rawLegacyUpstream.retryStatuses) ? rawLegacyUpstream.retryStatuses : merged.proxy.retries.statuses);

  merged.proxy.httpClient = deepMerge(DEFAULTS.proxy.httpClient, asPlainObject(merged.proxy.httpClient));
  const legacyPool = asPlainObject(rawLegacyUpstream.pool);
  merged.proxy.httpClient.connections = pickInteger(rawProxyHttpClient.connections, legacyPool.connections, merged.proxy.httpClient.connections, DEFAULTS.proxy.httpClient.connections);
  merged.proxy.httpClient.keepAliveTimeoutMs = pickInteger(rawProxyHttpClient.keepAliveTimeoutMs, legacyPool.keepAliveTimeoutMs, merged.proxy.httpClient.keepAliveTimeoutMs, DEFAULTS.proxy.httpClient.keepAliveTimeoutMs);
  merged.proxy.httpClient.keepAliveMaxTimeoutMs = pickInteger(rawProxyHttpClient.keepAliveMaxTimeoutMs, legacyPool.keepAliveMaxTimeoutMs, merged.proxy.httpClient.keepAliveMaxTimeoutMs, DEFAULTS.proxy.httpClient.keepAliveMaxTimeoutMs);
  merged.proxy.httpClient.headersTimeoutMs = pickInteger(rawProxyHttpClient.headersTimeoutMs, legacyPool.headersTimeoutMs, merged.proxy.httpClient.headersTimeoutMs, DEFAULTS.proxy.httpClient.headersTimeoutMs);
  merged.proxy.httpClient.bodyTimeoutMs = pickInteger(rawProxyHttpClient.bodyTimeoutMs, legacyPool.bodyTimeoutMs, merged.proxy.httpClient.bodyTimeoutMs, DEFAULTS.proxy.httpClient.bodyTimeoutMs);
  merged.proxy.httpClient.pipelining = pickInteger(rawProxyHttpClient.pipelining, legacyPool.pipelining, merged.proxy.httpClient.pipelining, DEFAULTS.proxy.httpClient.pipelining);
  merged.proxy.httpClient.forceIpv4 = pickBoolean(rawProxyHttpClient.forceIpv4, merged.proxy.httpClient.forceIpv4, DEFAULTS.proxy.httpClient.forceIpv4) ?? false;

  merged.proxy.forwardHeaders = deepMerge(DEFAULTS.proxy.forwardHeaders, asPlainObject(merged.proxy.forwardHeaders));
  merged.proxy.forwardHeaders.mode = merged.proxy.forwardHeaders.mode === "allowlist" ? "allowlist" : "denylist";
  merged.proxy.forwardHeaders.allow = normalizeStringArray(merged.proxy.forwardHeaders.allow);
  merged.proxy.forwardHeaders.deny = normalizeStringArray(merged.proxy.forwardHeaders.deny);

  merged.proxy.guards = deepMerge(DEFAULTS.proxy.guards, asPlainObject(merged.proxy.guards));
  merged.server.upstream = {
    connectTimeoutMs: merged.proxy.timeouts.connectMs,
    requestTimeoutMs: merged.proxy.timeouts.requestMs,
    firstByteTimeoutMs: merged.proxy.timeouts.firstByteMs,
    idleTimeoutMs: merged.proxy.timeouts.idleMs,
    maxRetries: merged.proxy.retries.maxRetries,
    retryBaseMs: merged.proxy.retries.baseDelayMs,
    retryMaxMs: merged.proxy.retries.maxDelayMs,
    retryStatuses: Array.isArray(merged.proxy.retries.statuses) ? merged.proxy.retries.statuses : DEFAULTS.server.upstream.retryStatuses,
    pool: {
      connections: merged.proxy.httpClient.connections,
      keepAliveTimeoutMs: merged.proxy.httpClient.keepAliveTimeoutMs,
      keepAliveMaxTimeoutMs: merged.proxy.httpClient.keepAliveMaxTimeoutMs,
      headersTimeoutMs: merged.proxy.httpClient.headersTimeoutMs,
      bodyTimeoutMs: merged.proxy.httpClient.bodyTimeoutMs,
      pipelining: merged.proxy.httpClient.pipelining
    }
  };

  merged.routing = deepMerge(DEFAULTS.routing, asPlainObject(merged.routing));
  merged.routing.routeProfiles = deepMerge(DEFAULTS.routing.routeProfiles, asPlainObject(merged.routing.routeProfiles));
  for (const routeKey of ["chatCompletions", "responses", "imageGenerations"]) {
    merged.routing.routeProfiles[routeKey] = deepMerge(DEFAULTS.routing.routeProfiles[routeKey], asPlainObject(merged.routing.routeProfiles[routeKey]));
    merged.routing.routeProfiles[routeKey].allowedRequestFields = normalizeStringArray(merged.routing.routeProfiles[routeKey].allowedRequestFields);
  }

  merged.observability = deepMerge(DEFAULTS.observability, asPlainObject(merged.observability));
  merged.persistence = deepMerge(DEFAULTS.persistence, asPlainObject(merged.persistence));
  merged.access = deepMerge(DEFAULTS.access, asPlainObject(merged.access));
  merged.access.defaults.keyHeaderNames = normalizeStringArray(merged.access.defaults.keyHeaderNames);
  merged.compatibility = deepMerge(DEFAULTS.compatibility, asPlainObject(merged.compatibility));

  merged.models = Array.isArray(merged.models)
    ? merged.models.map((model) => {
      const next = deepMerge({
        displayName: "",
        status: "active",
        capabilities: [],
        timeoutProfile: {},
        retryProfile: {},
        defaultParams: {},
        requestPolicy: {
          allowedParams: [],
          blockedParams: [],
          dropUnsupportedParams: false
        },
        mediaPolicy: {},
        pricing: {},
        fallbackModels: [],
        pricingRef: "",
        accessTags: [],
        deprecatedAliasOf: ""
      }, model || {});
      next.capabilities = normalizeStringArray(next.capabilities);
      next.fallbackModels = normalizeStringArray(next.fallbackModels);
      next.accessTags = normalizeStringArray(next.accessTags);
      next.requestPolicy.allowedParams = normalizeStringArray(next.requestPolicy.allowedParams);
      next.requestPolicy.blockedParams = normalizeStringArray(next.requestPolicy.blockedParams);
      return next;
    })
    : [];

  merged.models = merged.models.map((model) => ({
    ...model,
    capabilities: resolveNativeModelCapabilities(model, merged.models)
  }));

  merged.upstreams = Array.isArray(merged.upstreams)
    ? merged.upstreams.map((upstream) => {
      const next = deepMerge({
        provider: "azure-openai",
        apiVersion: "",
        resourceName: "",
        status: "active",
        priority: 100,
        tags: [],
        capabilities: [],
        routes: {
          "chat/completions": "/openai/v1/chat/completions",
          responses: "/openai/v1/responses",
          "images/generations": "/openai/v1/images/generations",
          "openai-image": "/openai/deployments/{deployment}/images/generations?api-version=2025-04-01-preview",
          "blackforest-image": "/providers/blackforestlabs/v1/{deployment}?api-version=preview"
        },
        timeoutProfile: {},
        retryProfile: {},
        headersTemplate: {},
        healthCheck: {
          enabled: false,
          path: "/healthz",
          intervalMs: 300000,
          timeoutMs: 10000
        }
      }, upstream || {});
      next.tags = normalizeStringArray(next.tags);
      next.capabilities = collectCapabilitiesForUpstream(merged.models, next.name);
      return next;
    })
    : [];

  merged.apiKeys = Array.isArray(merged.apiKeys)
    ? merged.apiKeys.map((apiKey) => {
      const next = deepMerge({
        displayName: "",
        owner: "",
        allowedModels: [],
        tags: [],
        rateLimit: {
          windowSeconds: 0,
          rpm: 0,
          tpm: 0,
          concurrency: 0
        },
        budget: {
          limitAmount: 0,
          currency: "",
          windowType: "",
          softLimitRatio: 0.8,
          hardLimitAction: "block"
        },
        notes: ""
      }, apiKey || {});
      next.allowedModels = normalizeStringArray(next.allowedModels);
      next.tags = normalizeStringArray(next.tags);
      return next;
    })
    : [];
}

function normalizeConfig(raw, options = {}) {
  const merged = deepMerge(DEFAULTS, raw || {});
  merged.apiKeys = Array.isArray(merged.apiKeys) ? merged.apiKeys : [];
  merged.upstreams = Array.isArray(merged.upstreams) ? merged.upstreams : [];
  merged.models = Array.isArray(merged.models) ? merged.models : [];
  applySchemaCompatibility(raw || {}, merged);
  if (options.applyEnvironment !== false) {
    applyConfigEnvironmentOverrides(merged);
  }
  merged.access.pricingCatalog = asPlainObject(merged.access.pricingCatalog);
  return merged;
}

// Validate config structure and types
function validateConfig(cfg) {
  const publicServer = isPublicListenHost(cfg?.server?.host);
  const allowInsecurePublicAdmin = getEnvironmentBoolean("ALLOW_INSECURE_PUBLIC_ADMIN") === true;
  if (publicServer && !allowInsecurePublicAdmin) {
    if (cfg?.server?.adminAuth?.enabled !== true) {
      throw new Error("Admin authentication must be enabled for a non-loopback server. Set AOAI_PROXY_ADMIN_PASSWORD or explicitly set ALLOW_INSECURE_PUBLIC_ADMIN=true.");
    }
    if (isKnownInsecureSecret(cfg.server.adminAuth.password)) {
      throw new Error("Admin password for a non-loopback server is empty or uses a known placeholder. Set AOAI_PROXY_ADMIN_PASSWORD to a strong secret.");
    }
    if (cfg?.access?.defaults?.requireApiKey !== false) {
      const activeApiKeys = (Array.isArray(cfg.apiKeys) ? cfg.apiKeys : []).filter((item) => item?.status !== "disabled");
      if (!activeApiKeys.length || activeApiKeys.some((item) => isKnownInsecureSecret(item?.key))) {
        throw new Error("API keys for a non-loopback server must not be empty or use known placeholders. Set AOAI_PROXY_API_KEY to a strong secret.");
      }
    }
  }
  if (!cfg.server || !cfg.server.port) {
    throw new Error("server.port is required");
  }
  if (cfg.version != null && (!Number.isInteger(cfg.version) || cfg.version <= 0)) {
    throw new Error("version must be a positive integer");
  }
  if (!cfg.server.adminPath || typeof cfg.server.adminPath !== "string") {
    throw new Error("server.adminPath must be a string");
  }
  if (!Number.isInteger(cfg.server.gracefulShutdownMs) || cfg.server.gracefulShutdownMs <= 0) {
    throw new Error("server.gracefulShutdownMs must be a positive integer");
  }
  if (!cfg.admin || typeof cfg.admin !== "object") {
    throw new Error("admin must be an object");
  }
  if (!cfg.admin.basePath || typeof cfg.admin.basePath !== "string") {
    throw new Error("admin.basePath must be a string");
  }
  if (cfg.server.caddy != null) {
    if (typeof cfg.server.caddy !== "object") {
      throw new Error("server.caddy must be an object");
    }
    const { enabled, domain, email, httpsPort, upstreamHost, upstreamPort, transport } = cfg.server.caddy;
    if (enabled != null && typeof enabled !== "boolean") {
      throw new Error("server.caddy.enabled must be a boolean");
    }
    if (enabled) {
      if (!domain || typeof domain !== "string") {
        throw new Error("server.caddy.domain must be a non-empty string when enabled");
      }
      if (!email || typeof email !== "string") {
        throw new Error("server.caddy.email must be a non-empty string when enabled");
      }
    }
    if (httpsPort != null && (typeof httpsPort !== "number" || httpsPort <= 0 || httpsPort > 65535)) {
      throw new Error("server.caddy.httpsPort must be a valid port number");
    }
    if (upstreamPort != null && (typeof upstreamPort !== "number" || upstreamPort <= 0 || upstreamPort > 65535)) {
      throw new Error("server.caddy.upstreamPort must be a valid port number");
    }
    if (upstreamHost != null && typeof upstreamHost !== "string") {
      throw new Error("server.caddy.upstreamHost must be a string");
    }
    if (transport != null) {
      if (typeof transport !== "object") {
        throw new Error("server.caddy.transport must be an object");
      }
      const { dialTimeoutMs, responseHeaderTimeoutMs, keepAliveTimeoutMs } = transport;
      const positiveInt = (v) => Number.isInteger(v) && v > 0;
      if (dialTimeoutMs != null && !positiveInt(dialTimeoutMs)) {
        throw new Error("server.caddy.transport.dialTimeoutMs must be a positive integer");
      }
      if (responseHeaderTimeoutMs != null && !positiveInt(responseHeaderTimeoutMs)) {
        throw new Error("server.caddy.transport.responseHeaderTimeoutMs must be a positive integer");
      }
      if (keepAliveTimeoutMs != null && !positiveInt(keepAliveTimeoutMs)) {
        throw new Error("server.caddy.transport.keepAliveTimeoutMs must be a positive integer");
      }
    }
  }
  if (cfg.server.adminAuth != null) {
    if (typeof cfg.server.adminAuth !== "object") {
      throw new Error("server.adminAuth must be an object");
    }
    const { enabled, username, password } = cfg.server.adminAuth;
    if (enabled != null && typeof enabled !== "boolean") {
      throw new Error("server.adminAuth.enabled must be a boolean");
    }
    if (enabled) {
      if (!username || typeof username !== "string") {
        throw new Error("server.adminAuth.username must be a non-empty string when enabled");
      }
      if (!password || typeof password !== "string") {
        throw new Error("server.adminAuth.password must be a non-empty string when enabled");
      }
    }
  }
  if (cfg.server.imageCompression != null) {
    if (typeof cfg.server.imageCompression !== "object") {
      throw new Error("server.imageCompression must be an object");
    }
    const { enabled, maxSize, quality, format } = cfg.server.imageCompression;
    if (enabled != null && typeof enabled !== "boolean") {
      throw new Error("server.imageCompression.enabled must be a boolean");
    }
    if (maxSize != null && (typeof maxSize !== "number" || maxSize <= 0)) {
      throw new Error("server.imageCompression.maxSize must be a positive number");
    }
    if (quality != null && (typeof quality !== "number" || quality <= 0 || quality > 1)) {
      throw new Error("server.imageCompression.quality must be between 0 and 1");
    }
    if (format != null && typeof format !== "string") {
      throw new Error("server.imageCompression.format must be a string");
    }
    if (format && !["jpeg", "webp"].includes(format)) {
      throw new Error("server.imageCompression.format must be jpeg or webp");
    }
  }
  if (cfg.media != null) {
    if (typeof cfg.media !== "object") {
      throw new Error("media must be an object");
    }
    if (cfg.media.remoteImages != null) {
      const remoteImages = cfg.media.remoteImages;
      if (typeof remoteImages !== "object") {
        throw new Error("media.remoteImages must be an object");
      }
      if (remoteImages.allow != null && typeof remoteImages.allow !== "boolean") {
        throw new Error("media.remoteImages.allow must be a boolean");
      }
      if (remoteImages.maxDownloadSizeMb != null && (!Number.isInteger(remoteImages.maxDownloadSizeMb) || remoteImages.maxDownloadSizeMb <= 0)) {
        throw new Error("media.remoteImages.maxDownloadSizeMb must be a positive integer");
      }
      if (remoteImages.allowedMimeTypes != null && (!Array.isArray(remoteImages.allowedMimeTypes) || remoteImages.allowedMimeTypes.some((value) => typeof value !== "string"))) {
        throw new Error("media.remoteImages.allowedMimeTypes must be an array of strings");
      }
      if (remoteImages.allowedHosts != null && (!Array.isArray(remoteImages.allowedHosts) || remoteImages.allowedHosts.some((value) => typeof value !== "string"))) {
        throw new Error("media.remoteImages.allowedHosts must be an array of strings");
      }
    }
    if (cfg.media.inlineImages != null) {
      const inlineImages = cfg.media.inlineImages;
      if (typeof inlineImages !== "object") {
        throw new Error("media.inlineImages must be an object");
      }
      if (inlineImages.maxBase64Bytes != null && (!Number.isInteger(inlineImages.maxBase64Bytes) || inlineImages.maxBase64Bytes <= 0)) {
        throw new Error("media.inlineImages.maxBase64Bytes must be a positive integer");
      }
      if (inlineImages.logPreviewChars != null && (!Number.isInteger(inlineImages.logPreviewChars) || inlineImages.logPreviewChars < 0)) {
        throw new Error("media.inlineImages.logPreviewChars must be a non-negative integer");
      }
    }
  }
  if (cfg.server.upstream != null) {
    if (typeof cfg.server.upstream !== "object") {
      throw new Error("server.upstream must be an object");
    }
    const {
      connectTimeoutMs,
      requestTimeoutMs,
      firstByteTimeoutMs,
      idleTimeoutMs,
      maxRetries,
      retryBaseMs,
      retryMaxMs,
      retryStatuses,
      pool
    } = cfg.server.upstream;
    const positiveInt = (v) => Number.isInteger(v) && v > 0;
    const nonNegativeInt = (v) => Number.isInteger(v) && v >= 0;
    if (connectTimeoutMs != null && !positiveInt(connectTimeoutMs)) {
      throw new Error("server.upstream.connectTimeoutMs must be a positive integer");
    }
    if (requestTimeoutMs != null && !positiveInt(requestTimeoutMs)) {
      throw new Error("server.upstream.requestTimeoutMs must be a positive integer");
    }
    if (firstByteTimeoutMs != null && !positiveInt(firstByteTimeoutMs)) {
      throw new Error("server.upstream.firstByteTimeoutMs must be a positive integer");
    }
    if (idleTimeoutMs != null && !positiveInt(idleTimeoutMs)) {
      throw new Error("server.upstream.idleTimeoutMs must be a positive integer");
    }
    if (maxRetries != null && !nonNegativeInt(maxRetries)) {
      throw new Error("server.upstream.maxRetries must be a non-negative integer");
    }
    if (retryBaseMs != null && !positiveInt(retryBaseMs)) {
      throw new Error("server.upstream.retryBaseMs must be a positive integer");
    }
    if (retryMaxMs != null && !positiveInt(retryMaxMs)) {
      throw new Error("server.upstream.retryMaxMs must be a positive integer");
    }
    if (retryStatuses != null) {
      if (!Array.isArray(retryStatuses) || retryStatuses.some((s) => !Number.isInteger(s) || s < 100 || s > 599)) {
        throw new Error("server.upstream.retryStatuses must be an array of HTTP status codes");
      }
    }
    if (pool != null) {
      if (typeof pool !== "object") {
        throw new Error("server.upstream.pool must be an object");
      }
      const {
        connections,
        keepAliveTimeoutMs,
        keepAliveMaxTimeoutMs,
        headersTimeoutMs,
        bodyTimeoutMs,
        pipelining
      } = pool;
      if (connections != null && !positiveInt(connections)) {
        throw new Error("server.upstream.pool.connections must be a positive integer");
      }
      if (keepAliveTimeoutMs != null && !positiveInt(keepAliveTimeoutMs)) {
        throw new Error("server.upstream.pool.keepAliveTimeoutMs must be a positive integer");
      }
      if (keepAliveMaxTimeoutMs != null && !positiveInt(keepAliveMaxTimeoutMs)) {
        throw new Error("server.upstream.pool.keepAliveMaxTimeoutMs must be a positive integer");
      }
      if (headersTimeoutMs != null && !positiveInt(headersTimeoutMs)) {
        throw new Error("server.upstream.pool.headersTimeoutMs must be a positive integer");
      }
      if (bodyTimeoutMs != null && !nonNegativeInt(bodyTimeoutMs)) {
        throw new Error("server.upstream.pool.bodyTimeoutMs must be a non-negative integer");
      }
      if (pipelining != null && !positiveInt(pipelining)) {
        throw new Error("server.upstream.pool.pipelining must be a positive integer");
      }
    }
  }
  if (cfg.proxy != null) {
    if (typeof cfg.proxy !== "object") {
      throw new Error("proxy must be an object");
    }
    if (cfg.proxy.timeouts != null) {
      const { maxStreamDurationMs, allowPerRequestOverride, requestOverrideFields } = cfg.proxy.timeouts;
      const nonNegativeInt = (v) => Number.isInteger(v) && v >= 0;
      if (maxStreamDurationMs != null && !nonNegativeInt(maxStreamDurationMs)) {
        throw new Error("proxy.timeouts.maxStreamDurationMs must be a non-negative integer");
      }
      if (allowPerRequestOverride != null && typeof allowPerRequestOverride !== "boolean") {
        throw new Error("proxy.timeouts.allowPerRequestOverride must be a boolean");
      }
      if (requestOverrideFields != null && (!Array.isArray(requestOverrideFields) || requestOverrideFields.some((value) => typeof value !== "string"))) {
        throw new Error("proxy.timeouts.requestOverrideFields must be an array of strings");
      }
      const requestOverrideLimits = cfg.proxy.timeouts.requestOverrideLimits;
      if (requestOverrideLimits != null) {
        if (typeof requestOverrideLimits !== "object" || Array.isArray(requestOverrideLimits)) {
          throw new Error("proxy.timeouts.requestOverrideLimits must be an object");
        }
        for (const key of ["requestMs", "firstByteMs", "idleMs", "maxStreamDurationMs", "maxRetries"]) {
          if (requestOverrideLimits[key] != null && (!Number.isInteger(requestOverrideLimits[key]) || requestOverrideLimits[key] < 0)) {
            throw new Error(`proxy.timeouts.requestOverrideLimits.${key} must be a non-negative integer`);
          }
        }
      }
    }
    if (cfg.proxy.forwardHeaders != null) {
      const forwardHeaders = cfg.proxy.forwardHeaders;
      if (typeof forwardHeaders !== "object") {
        throw new Error("proxy.forwardHeaders must be an object");
      }
      if (forwardHeaders.mode != null && !["allowlist", "denylist"].includes(forwardHeaders.mode)) {
        throw new Error("proxy.forwardHeaders.mode must be allowlist or denylist");
      }
      if (forwardHeaders.allow != null && (!Array.isArray(forwardHeaders.allow) || forwardHeaders.allow.some((value) => typeof value !== "string"))) {
        throw new Error("proxy.forwardHeaders.allow must be an array of strings");
      }
      if (forwardHeaders.deny != null && (!Array.isArray(forwardHeaders.deny) || forwardHeaders.deny.some((value) => typeof value !== "string"))) {
        throw new Error("proxy.forwardHeaders.deny must be an array of strings");
      }
    }
    if (cfg.proxy.retries?.retryBeforeFirstChunkOnly === false) {
      throw new Error("proxy.retries.retryBeforeFirstChunkOnly must remain true because streamed requests cannot be safely replayed after output starts");
    }
  }
  if (cfg.persistence != null) {
    if (typeof cfg.persistence !== "object") {
      throw new Error("persistence must be an object");
    }
    if (cfg.persistence.configStore != null) {
      const configStore = cfg.persistence.configStore;
      if (typeof configStore !== "object") {
        throw new Error("persistence.configStore must be an object");
      }
      if (configStore.mode != null && !isSupportedPersistenceMode(configStore.mode)) {
        throw new Error("persistence.configStore.mode must be file, azureFile, database, or database+azureFile");
      }
      if (configStore.filePath != null && typeof configStore.filePath !== "string") {
        throw new Error("persistence.configStore.filePath must be a string");
      }
      if (configStore.database != null) {
        const database = configStore.database;
        if (typeof database !== "object") {
          throw new Error("persistence.configStore.database must be an object");
        }
        if (database.provider != null && typeof database.provider !== "string") {
          throw new Error("persistence.configStore.database.provider must be a string");
        }
        if (database.connectionRef != null && typeof database.connectionRef !== "string") {
          throw new Error("persistence.configStore.database.connectionRef must be a string");
        }
        if (database.schema != null && typeof database.schema !== "string") {
          throw new Error("persistence.configStore.database.schema must be a string");
        }
        if (database.tableName != null && typeof database.tableName !== "string") {
          throw new Error("persistence.configStore.database.tableName must be a string");
        }
        if (database.configKey != null && typeof database.configKey !== "string") {
          throw new Error("persistence.configStore.database.configKey must be a string");
        }
        if (database.readFallbackMode != null && !["lastKnownGood", "none"].includes(database.readFallbackMode)) {
          throw new Error("persistence.configStore.database.readFallbackMode must be lastKnownGood or none");
        }
      }
    }
    if (cfg.persistence.compatibilityExport != null) {
      const compatibilityExport = cfg.persistence.compatibilityExport;
      if (typeof compatibilityExport !== "object") {
        throw new Error("persistence.compatibilityExport must be an object");
      }
      if (compatibilityExport.legacyConfigPath != null && typeof compatibilityExport.legacyConfigPath !== "string") {
        throw new Error("persistence.compatibilityExport.legacyConfigPath must be a string");
      }
    }
  }
  if (cfg.observability != null) {
    if (typeof cfg.observability !== "object") {
      throw new Error("observability must be an object");
    }
    if (cfg.observability.logAnalytics != null) {
      const logAnalytics = cfg.observability.logAnalytics;
      if (typeof logAnalytics !== "object") {
        throw new Error("observability.logAnalytics must be an object");
      }
      if (logAnalytics.enabled != null && typeof logAnalytics.enabled !== "boolean") {
        throw new Error("observability.logAnalytics.enabled must be a boolean");
      }
      for (const key of ["workspaceId", "endpoint", "dcrImmutableId", "streamName", "audience", "credentialRef", "tableName"]) {
        if (logAnalytics[key] != null && typeof logAnalytics[key] !== "string") {
          throw new Error(`observability.logAnalytics.${key} must be a string`);
        }
      }
      for (const key of ["flushIntervalMs", "batchSize", "maxConcurrency", "maxQueueSize"]) {
        if (logAnalytics[key] != null && (!Number.isInteger(logAnalytics[key]) || logAnalytics[key] <= 0)) {
          throw new Error(`observability.logAnalytics.${key} must be a positive integer`);
        }
      }
      if (logAnalytics.samplingRatio != null && (typeof logAnalytics.samplingRatio !== "number" || logAnalytics.samplingRatio < 0 || logAnalytics.samplingRatio > 1)) {
        throw new Error("observability.logAnalytics.samplingRatio must be between 0 and 1");
      }
      if (logAnalytics.contentMode != null && !["summary", "full"].includes(logAnalytics.contentMode)) {
        throw new Error("observability.logAnalytics.contentMode must be summary or full");
      }
    }
    if (cfg.observability.logs != null) {
      const logs = cfg.observability.logs;
      if (typeof logs !== "object") {
        throw new Error("observability.logs must be an object");
      }
      if (logs.bufferSize != null && (!Number.isInteger(logs.bufferSize) || logs.bufferSize <= 0)) {
        throw new Error("observability.logs.bufferSize must be a positive integer");
      }
    }
    if (cfg.observability.runtimeStore != null) {
      const runtimeStore = cfg.observability.runtimeStore;
      if (typeof runtimeStore !== "object") {
        throw new Error("observability.runtimeStore must be an object");
      }
      if (runtimeStore.enabled != null && typeof runtimeStore.enabled !== "boolean") {
        throw new Error("observability.runtimeStore.enabled must be a boolean");
      }
      for (const key of ["connectionRef", "schema", "eventsTableName", "rollupsTableName", "metaTableName", "localBufferPath"]) {
        if (runtimeStore[key] != null && typeof runtimeStore[key] !== "string") {
          throw new Error(`observability.runtimeStore.${key} must be a string`);
        }
      }
      for (const key of ["retentionDays", "detailRetentionDays", "rollupRetentionDays", "rollupBatchSize", "flushIntervalMs", "batchSize", "maxQueueSize", "maxPersistedEvents"]) {
        if (runtimeStore[key] != null && (!Number.isInteger(runtimeStore[key]) || runtimeStore[key] <= 0)) {
          throw new Error(`observability.runtimeStore.${key} must be a positive integer`);
        }
      }
    }
  }
  for (const feature of ["fallbacks", "cooldowns", "healthChecks"]) {
    if (cfg.routing?.[feature]?.enabled === true) {
      throw new Error(`routing.${feature}.enabled is not supported by this proxy version`);
    }
  }
  if (!cfg.auth || typeof cfg.auth !== "object") {
    throw new Error("auth must be an object");
  }
  const authMode = typeof cfg.auth.mode === "string" && cfg.auth.mode.trim() ? cfg.auth.mode.trim() : "servicePrincipal";
  if (!["servicePrincipal", "apiKey"].includes(authMode)) {
    throw new Error("auth.mode must be servicePrincipal or apiKey");
  }
  if (cfg.auth.tenantId != null && typeof cfg.auth.tenantId !== "string") {
    throw new Error("auth.tenantId must be a string");
  }
  if (cfg.auth.clientId != null && typeof cfg.auth.clientId !== "string") {
    throw new Error("auth.clientId must be a string");
  }
  if (cfg.auth.clientSecret != null && typeof cfg.auth.clientSecret !== "string") {
    throw new Error("auth.clientSecret must be a string");
  }
  if (cfg.auth.managedIdentityClientId != null && typeof cfg.auth.managedIdentityClientId !== "string") {
    throw new Error("auth.managedIdentityClientId must be a string");
  }
  if (cfg.auth.scope != null && typeof cfg.auth.scope !== "string") {
    throw new Error("auth.scope must be a string");
  }
  if (cfg.auth.apiKey != null && typeof cfg.auth.apiKey !== "string") {
    throw new Error("auth.apiKey must be a string");
  }
  if (authMode === "apiKey") {
    if (!cfg.auth.apiKey || !cfg.auth.apiKey.trim()) {
      throw new Error("auth.apiKey is required when auth.mode is apiKey");
    }
  } else if (!cfg.auth.scope || !cfg.auth.scope.trim()) {
    throw new Error("auth.scope is required when auth.mode is servicePrincipal");
  }
  if (!Array.isArray(cfg.apiKeys)) {
    throw new Error("apiKeys must be an array");
  }
  if (!Array.isArray(cfg.upstreams) || cfg.upstreams.length === 0) {
    throw new Error("upstreams must be a non-empty array");
  }
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error("models must be a non-empty array");
  }

  for (const [idx, model] of cfg.models.entries()) {
    if (!model?.id || typeof model.id !== "string") {
      throw new Error(`models[${idx}].id is required`);
    }
    if (!model?.upstream || typeof model.upstream !== "string") {
      throw new Error(`models[${idx}].upstream is required`);
    }
    if (model.targetModel != null && typeof model.targetModel !== "string") {
      throw new Error(`models[${idx}].targetModel must be a string`);
    }
    if (model.capabilities != null && (!Array.isArray(model.capabilities) || model.capabilities.some((value) => typeof value !== "string"))) {
      throw new Error(`models[${idx}].capabilities must be an array of strings`);
    }
    if (Array.isArray(model.fallbackModels) && model.fallbackModels.length > 0) {
      throw new Error(`models[${idx}].fallbackModels is not supported by this proxy version`);
    }
    if (model.routes != null) {
      if (typeof model.routes !== "object") {
        throw new Error(`models[${idx}].routes must be an object`);
      }
      for (const [k, v] of Object.entries(model.routes)) {
        if (typeof v !== "string") {
          throw new Error(`models[${idx}].routes[${k}] must be a string`);
        }
      }
    }
    if (model.pricing != null) {
      if (typeof model.pricing !== "object") {
        throw new Error(`models[${idx}].pricing must be an object`);
      }
      for (const key of ["inputPer1kTokens", "promptPer1kTokens", "outputPer1kTokens", "completionPer1kTokens", "cachedInputPer1kTokens", "cachedPromptPer1kTokens"]) {
        if (model.pricing[key] != null && (typeof model.pricing[key] !== "number" || model.pricing[key] < 0)) {
          throw new Error(`models[${idx}].pricing.${key} must be a non-negative number`);
        }
      }
      if (model.pricing.currency != null && typeof model.pricing.currency !== "string") {
        throw new Error(`models[${idx}].pricing.currency must be a string`);
      }
    }
  }

  if (cfg.access != null) {
    if (typeof cfg.access !== "object") {
      throw new Error("access must be an object");
    }
    if (cfg.access.pricingCatalog != null) {
      if (typeof cfg.access.pricingCatalog !== "object") {
        throw new Error("access.pricingCatalog must be an object");
      }
      for (const [pricingRef, entry] of Object.entries(cfg.access.pricingCatalog)) {
        if (!entry || typeof entry !== "object") {
          throw new Error(`access.pricingCatalog.${pricingRef} must be an object`);
        }
        for (const key of ["inputPer1kTokens", "promptPer1kTokens", "outputPer1kTokens", "completionPer1kTokens", "cachedInputPer1kTokens", "cachedPromptPer1kTokens"]) {
          if (entry[key] != null && (typeof entry[key] !== "number" || entry[key] < 0)) {
            throw new Error(`access.pricingCatalog.${pricingRef}.${key} must be a non-negative number`);
          }
        }
        if (entry.currency != null && typeof entry.currency !== "string") {
          throw new Error(`access.pricingCatalog.${pricingRef}.currency must be a string`);
        }
      }
    }
  }

  for (const [idx, apiKey] of cfg.apiKeys.entries()) {
    if (apiKey.id != null && typeof apiKey.id !== "string") {
      throw new Error(`apiKeys[${idx}].id must be a string`);
    }
    if (apiKey.key != null && typeof apiKey.key !== "string") {
      throw new Error(`apiKeys[${idx}].key must be a string`);
    }
    if (apiKey.status != null && !["active", "disabled"].includes(apiKey.status)) {
      throw new Error(`apiKeys[${idx}].status must be active or disabled`);
    }
    if (apiKey.allowedModels != null && (!Array.isArray(apiKey.allowedModels) || apiKey.allowedModels.some((value) => typeof value !== "string"))) {
      throw new Error(`apiKeys[${idx}].allowedModels must be an array of strings`);
    }
    if (apiKey.tags != null && (!Array.isArray(apiKey.tags) || apiKey.tags.some((value) => typeof value !== "string"))) {
      throw new Error(`apiKeys[${idx}].tags must be an array of strings`);
    }
    if (apiKey.rateLimit != null) {
      if (typeof apiKey.rateLimit !== "object") {
        throw new Error(`apiKeys[${idx}].rateLimit must be an object`);
      }
      for (const key of ["windowSeconds", "rpm", "tpm", "concurrency"]) {
        if (apiKey.rateLimit[key] != null && (!Number.isInteger(apiKey.rateLimit[key]) || apiKey.rateLimit[key] < 0)) {
          throw new Error(`apiKeys[${idx}].rateLimit.${key} must be a non-negative integer`);
        }
      }
    }
    if (apiKey.budget != null) {
      if (typeof apiKey.budget !== "object") {
        throw new Error(`apiKeys[${idx}].budget must be an object`);
      }
      if (apiKey.budget.limitAmount != null && (typeof apiKey.budget.limitAmount !== "number" || apiKey.budget.limitAmount < 0)) {
        throw new Error(`apiKeys[${idx}].budget.limitAmount must be a non-negative number`);
      }
      if (apiKey.budget.currency != null && typeof apiKey.budget.currency !== "string") {
        throw new Error(`apiKeys[${idx}].budget.currency must be a string`);
      }
      if (apiKey.budget.windowType != null && apiKey.budget.windowType !== "" && !["daily", "weekly", "monthly"].includes(apiKey.budget.windowType)) {
        throw new Error(`apiKeys[${idx}].budget.windowType must be daily, weekly, or monthly`);
      }
      if (apiKey.budget.softLimitRatio != null && (typeof apiKey.budget.softLimitRatio !== "number" || apiKey.budget.softLimitRatio < 0 || apiKey.budget.softLimitRatio > 1)) {
        throw new Error(`apiKeys[${idx}].budget.softLimitRatio must be between 0 and 1`);
      }
      if (apiKey.budget.hardLimitAction != null && !["block", "warn"].includes(apiKey.budget.hardLimitAction)) {
        throw new Error(`apiKeys[${idx}].budget.hardLimitAction must be block or warn`);
      }
    }
  }

  for (const [idx, upstream] of cfg.upstreams.entries()) {
    if (!upstream?.name) {
      throw new Error(`upstreams[${idx}].name is required`);
    }
    const hasBaseUrl = typeof upstream?.baseUrl === "string" && upstream.baseUrl.trim();
    const hasResourceName = typeof upstream?.resourceName === "string" && upstream.resourceName.trim();
    if (!hasBaseUrl && !hasResourceName) {
      throw new Error(`upstreams[${idx}].baseUrl or upstreams[${idx}].resourceName is required`);
    }
    if (hasBaseUrl) {
      let parsed;
      try {
        parsed = new URL(upstream.baseUrl);
      } catch {
        throw new Error(`upstreams[${idx}].baseUrl must be a valid URL`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`upstreams[${idx}].baseUrl must be http(s)`);
      }
    }
    if (upstream.resourceName != null && typeof upstream.resourceName !== "string") {
      throw new Error(`upstreams[${idx}].resourceName must be a string`);
    }
    if (upstream.capabilities != null && (!Array.isArray(upstream.capabilities) || upstream.capabilities.some((value) => typeof value !== "string"))) {
      throw new Error(`upstreams[${idx}].capabilities must be an array of strings`);
    }
    if (upstream.routes && typeof upstream.routes !== "object") {
      throw new Error(`upstreams[${idx}].routes must be an object`);
    }
  }
  const bindingIssues = getConfiguredModelBindingIssues(cfg);
  if (bindingIssues.length) {
    const preview = bindingIssues.slice(0, 3).map((issue) => issue.message).join("; ");
    throw new Error(preview);
  }
  return cfg;
}

export function getConfigPath() {
  return getPersistenceSummary(currentConfig).configPath;
}

export async function loadConfig() {
  const rawText = await readPersistedConfigText();
  const raw = JSON.parse(rawText);
  const normalizedPersistedConfig = normalizeConfig(raw, { applyEnvironment: false });
  const cfg = validateConfig(applyConfigEnvironmentOverrides(cloneConfig(normalizedPersistedConfig)));
  persistedConfig = normalizedPersistedConfig;
  currentConfig = cfg;
  setPersistenceConfig(cfg);
  setRuntimeStoreConfig(cfg);
  return cfg;
}

export function getConfig() {
  if (!currentConfig) {
    throw new Error("Configuration not loaded yet");
  }
  return currentConfig;
}

export function getPersistedConfig() {
  if (!persistedConfig) {
    throw new Error("Configuration not loaded yet");
  }
  return cloneConfig(persistedConfig);
}

export async function saveConfig(nextConfig) {
  const normalized = preserveEnvironmentManagedFields(
    normalizeConfig(nextConfig, { applyEnvironment: false }),
    persistedConfig
  );
  const validated = validateConfig(applyConfigEnvironmentOverrides(cloneConfig(normalized)));
  await writePersistedConfigText(JSON.stringify(normalized, null, 2), validated);
  persistedConfig = normalized;
  currentConfig = validated;
  setPersistenceConfig(validated);
  setRuntimeStoreConfig(validated);
  return validated;
}

export async function reloadConfig() {
  return loadConfig();
}

export function getConfigRuntimeInfo() {
  return {
    persistence: getPersistenceSummary(currentConfig),
    logging: getLogRuntimeInfo(currentConfig),
    runtimeStore: getRuntimeStoreInfo(currentConfig)
  };
}
