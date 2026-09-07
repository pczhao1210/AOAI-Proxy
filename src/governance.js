import { appendStructuredLog } from "./logs.js";
import { resolveModelDescriptor } from "./model-catalog.js";
import { findPricingDefinitionForModel } from "./pricing-library.js";
import { hydrateGovernanceRuntime, recordRuntimeBlocked, recordRuntimeWarning } from "./runtime-store.js";
import { getUsageTotals } from "./usage.js";

const governanceState = {
  perKey: new Map()
};

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0) return fallback;
  return numeric;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toIsoString(timestamp) {
  return new Date(timestamp).toISOString();
}

function getRateWindowStart(windowSeconds, now) {
  const normalizedWindowSeconds = Math.max(1, toNonNegativeInteger(windowSeconds, 60) || 60);
  const windowMs = normalizedWindowSeconds * 1000;
  return Math.floor(now / windowMs) * windowMs;
}

function buildRateWindow(now, startedAt = now) {
  return {
    startedAt: toIsoString(startedAt),
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    blockedRequests: 0
  };
}

function getBudgetWindowStart(windowType, now) {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (windowType === "daily") {
    return Date.UTC(year, month, day);
  }
  if (windowType === "weekly") {
    const dayOfWeek = date.getUTCDay() || 7;
    return Date.UTC(year, month, day - dayOfWeek + 1);
  }
  return Date.UTC(year, month, 1);
}

function getBudgetWindowKey(windowType, now) {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (windowType === "daily") {
    return `${year}-${month}-${day}`;
  }
  if (windowType === "weekly") {
    const dayOfWeek = date.getUTCDay() || 7;
    const monday = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate() - dayOfWeek + 1));
    const mondayYear = monday.getUTCFullYear();
    const mondayMonth = String(monday.getUTCMonth() + 1).padStart(2, "0");
    const mondayDay = String(monday.getUTCDate()).padStart(2, "0");
    return `${mondayYear}-${mondayMonth}-${mondayDay}`;
  }
  return `${year}-${month}`;
}

function buildBudgetWindow(settings, now) {
  return {
    key: getBudgetWindowKey(settings.windowType, now),
    startedAt: toIsoString(getBudgetWindowStart(settings.windowType, now)),
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    spentAmount: 0,
    blockedRequests: 0,
    softLimitReached: false,
    softLimitReachedAt: "",
    hardLimitWarningAt: "",
    unmeteredWarningAt: ""
  };
}

function ensureKeyRuntime(keyId) {
  if (!governanceState.perKey.has(keyId)) {
    governanceState.perKey.set(keyId, {
      keyId,
      displayName: keyId,
      owner: "",
      currentConcurrent: 0,
      totalRequests: 0,
      totalErrors: 0,
      totalBlockedRequests: 0,
      lastSeenAt: "",
      lastBlockedAt: "",
      lastBlockedReason: "",
      hydratedAt: "",
      hydrationPromise: null,
      rateWindow: buildRateWindow(Date.now()),
      budgetWindow: buildBudgetWindow({ windowType: "monthly" }, Date.now())
    });
  }
  return governanceState.perKey.get(keyId);
}

async function hydrateRuntimeStateIfNeeded(config, consumer, runtime, rateLimitSettings, budgetSettings, now) {
  if (!consumer?.keyId || runtime.hydratedAt) {
    return;
  }
  if (!runtime.hydrationPromise) {
    runtime.hydrationPromise = (async () => {
      const rateWindowStart = toIsoString(getRateWindowStart(rateLimitSettings.windowSeconds, now));
      const budgetWindowStart = toIsoString(getBudgetWindowStart(budgetSettings.windowType, now));
      const persisted = await hydrateGovernanceRuntime(config, consumer.keyId, rateWindowStart, budgetWindowStart);
      runtime.rateWindow.startedAt = rateWindowStart;
      runtime.budgetWindow.startedAt = budgetWindowStart;
      runtime.budgetWindow.key = getBudgetWindowKey(budgetSettings.windowType, now);
      if (persisted) {
        runtime.lastSeenAt = persisted.last_seen_at ? new Date(persisted.last_seen_at).toISOString() : runtime.lastSeenAt;
        runtime.totalRequests = toNonNegativeInteger(persisted.total_requests, runtime.totalRequests);
        runtime.totalErrors = toNonNegativeInteger(persisted.total_errors, runtime.totalErrors);
        runtime.totalBlockedRequests = toNonNegativeInteger(persisted.total_blocked_requests, runtime.totalBlockedRequests);
        runtime.lastBlockedAt = persisted.last_blocked_at ? new Date(persisted.last_blocked_at).toISOString() : runtime.lastBlockedAt;
        runtime.lastBlockedReason = String(persisted.last_blocked_reason || runtime.lastBlockedReason || "");
        runtime.rateWindow.requests = toNonNegativeInteger(persisted.rate_requests, runtime.rateWindow.requests);
        runtime.rateWindow.promptTokens = toNonNegativeInteger(persisted.rate_prompt_tokens, runtime.rateWindow.promptTokens);
        runtime.rateWindow.completionTokens = toNonNegativeInteger(persisted.rate_completion_tokens, runtime.rateWindow.completionTokens);
        runtime.rateWindow.totalTokens = toNonNegativeInteger(persisted.rate_total_tokens, runtime.rateWindow.totalTokens);
        runtime.rateWindow.cachedTokens = toNonNegativeInteger(persisted.rate_cached_tokens, runtime.rateWindow.cachedTokens);
        runtime.rateWindow.blockedRequests = toNonNegativeInteger(persisted.rate_blocked_requests, runtime.rateWindow.blockedRequests);
        runtime.budgetWindow.requests = toNonNegativeInteger(persisted.budget_requests, runtime.budgetWindow.requests);
        runtime.budgetWindow.promptTokens = toNonNegativeInteger(persisted.budget_prompt_tokens, runtime.budgetWindow.promptTokens);
        runtime.budgetWindow.completionTokens = toNonNegativeInteger(persisted.budget_completion_tokens, runtime.budgetWindow.completionTokens);
        runtime.budgetWindow.totalTokens = toNonNegativeInteger(persisted.budget_total_tokens, runtime.budgetWindow.totalTokens);
        runtime.budgetWindow.cachedTokens = toNonNegativeInteger(persisted.budget_cached_tokens, runtime.budgetWindow.cachedTokens);
        runtime.budgetWindow.spentAmount = Math.max(0, toFiniteNumber(persisted.budget_spent_amount, runtime.budgetWindow.spentAmount));
        runtime.budgetWindow.blockedRequests = toNonNegativeInteger(persisted.budget_blocked_requests, runtime.budgetWindow.blockedRequests);
        if (budgetSettings.limitAmount > 0) {
          const softLimitAmount = budgetSettings.limitAmount * budgetSettings.softLimitRatio;
          runtime.budgetWindow.softLimitReached = softLimitAmount > 0 && runtime.budgetWindow.spentAmount >= softLimitAmount;
          if (runtime.budgetWindow.softLimitReached && !runtime.budgetWindow.softLimitReachedAt) {
            runtime.budgetWindow.softLimitReachedAt = runtime.lastSeenAt || toIsoString(now);
          }
        }
      }
      runtime.hydratedAt = toIsoString(now);
    })().finally(() => {
      runtime.hydrationPromise = null;
    });
  }
  await runtime.hydrationPromise;
}

function getRateLimitSettings(config, apiKey) {
  const defaults = config?.access?.rateLimits || {};
  const override = apiKey?.rateLimit || {};
  const inheritWhenZero = (overrideValue, defaultValue, fallback = 0) => {
    const normalizedOverride = toNonNegativeInteger(overrideValue, 0);
    return normalizedOverride > 0
      ? normalizedOverride
      : toNonNegativeInteger(defaultValue, fallback);
  };
  return {
    windowSeconds: Math.max(1, inheritWhenZero(override.windowSeconds, defaults.windowSeconds, 60) || 60),
    rpm: inheritWhenZero(override.rpm, defaults.defaultRpm),
    tpm: inheritWhenZero(override.tpm, defaults.defaultTpm),
    concurrency: inheritWhenZero(override.concurrency, defaults.defaultConcurrency)
  };
}

function getBudgetSettings(config, apiKey) {
  const defaults = config?.access?.budgets || {};
  const override = apiKey?.budget || {};
  const limitAmount = Math.max(0, toFiniteNumber(override.limitAmount, 0));
  return {
    enabled: defaults.enabled === true || limitAmount > 0,
    limitAmount,
    currency: String(override.currency || defaults.defaultCurrency || "USD"),
    windowType: String(override.windowType || defaults.defaultWindowType || "monthly"),
    softLimitRatio: Math.min(1, Math.max(0, toFiniteNumber(override.softLimitRatio ?? defaults.softLimitRatio, 0.8))),
    hardLimitAction: String(override.hardLimitAction || defaults.hardLimitAction || "block")
  };
}

function resetRateWindowIfNeeded(runtime, settings, now) {
  const nextWindowStart = getRateWindowStart(settings.windowSeconds, now);
  const startedAt = Date.parse(runtime.rateWindow?.startedAt || "") || 0;
  if (startedAt !== nextWindowStart) {
    runtime.rateWindow = buildRateWindow(now, nextWindowStart);
  }
}

function resetBudgetWindowIfNeeded(runtime, settings, now) {
  const nextKey = getBudgetWindowKey(settings.windowType, now);
  if (!runtime.budgetWindow || runtime.budgetWindow.key !== nextKey) {
    runtime.budgetWindow = buildBudgetWindow(settings, now);
  }
}

function normalizePricingEntry(entry, defaultCurrency) {
  if (!entry || typeof entry !== "object") return null;
  const inputPer1kTokens = Math.max(0, toFiniteNumber(entry.inputPer1kTokens ?? entry.promptPer1kTokens, 0));
  const outputPer1kTokens = Math.max(0, toFiniteNumber(entry.outputPer1kTokens ?? entry.completionPer1kTokens, 0));
  const cachedInputPer1kTokens = Math.max(0, toFiniteNumber(entry.cachedInputPer1kTokens ?? entry.cachedPromptPer1kTokens, 0));
  if (inputPer1kTokens <= 0 && outputPer1kTokens <= 0 && cachedInputPer1kTokens <= 0) {
    return null;
  }
  return {
    currency: String(entry.currency || defaultCurrency || "USD"),
    inputPer1kTokens,
    outputPer1kTokens,
    cachedInputPer1kTokens
  };
}

function normalizeLookupCandidates(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return [];
  const candidates = [normalized];
  const withoutDateSuffix = normalized.replace(/-(20\d{2}-\d{2}-\d{2})$/, "");
  if (withoutDateSuffix && withoutDateSuffix !== normalized) {
    candidates.push(withoutDateSuffix);
  }
  return [...new Set(candidates)];
}

function matchesPricingCandidate(model, candidate) {
  if (!model || !candidate) return false;
  const normalizedCandidate = candidate.toLowerCase();
  return [model.id, model.targetModel, model.pricingRef, model.displayName]
    .filter((value) => typeof value === "string" && value.trim())
    .some((value) => value.trim().toLowerCase() === normalizedCandidate);
}

function resolvePricingModel(config, model, actualModelName) {
  const candidates = normalizeLookupCandidates(actualModelName);
  if (!candidates.length) {
    return {
      model,
      actualModelName: ""
    };
  }

  const configuredModels = Array.isArray(config?.models) ? config.models : [];
  const modelRouterRequest = isModelRouterRequest(model);
  const catalog = config?.access?.pricingCatalog && typeof config.access.pricingCatalog === "object"
    ? config.access.pricingCatalog
    : null;

  for (const candidate of candidates) {
    const configuredModel = configuredModels.find((item) => matchesPricingCandidate(item, candidate));
    if (configuredModel) {
      return {
        model: configuredModel,
        actualModelName: candidate
      };
    }
    if (catalog && catalog[candidate]) {
      return {
        model: modelRouterRequest
          ? { id: candidate, pricingRef: candidate }
          : { ...model, pricingRef: candidate },
        actualModelName: candidate
      };
    }
  }

  return {
    model: modelRouterRequest
      ? { id: candidates.at(-1), pricingRef: candidates.at(-1) }
      : model,
    actualModelName: candidates[0]
  };
}

function resolvePricing(config, model, descriptor = null) {
  const defaultCurrency = config?.access?.budgets?.defaultCurrency || "USD";
  const directPricing = normalizePricingEntry(model?.pricing, defaultCurrency);
  if (directPricing) {
    return { pricing: directPricing, source: "model.pricing" };
  }
  const pricingRef = typeof model?.pricingRef === "string" ? model.pricingRef.trim() : "";
  const catalog = config?.access?.pricingCatalog;
  if (pricingRef && catalog && typeof catalog === "object") {
    const resolved = normalizePricingEntry(catalog[pricingRef], defaultCurrency);
    if (resolved) {
      return { pricing: resolved, source: `access.pricingCatalog.${pricingRef}` };
    }
  }
  const libraryDefinition = descriptor?.definition || findPricingDefinitionForModel(model);
  if (libraryDefinition) {
    const libraryPricing = Object.prototype.hasOwnProperty.call(libraryDefinition, "pricingCatalogEntry")
      ? libraryDefinition.pricingCatalogEntry
      : libraryDefinition.pricing;
    const resolved = normalizePricingEntry(
      libraryPricing,
      defaultCurrency
    );
    if (resolved) {
      return { pricing: resolved, source: `pricing-library.${libraryDefinition.id}` };
    }
  }
  return { pricing: null, source: "" };
}

function isModelRouterRequest(model) {
  return matchesPricingCandidate(model, "model-router");
}

function estimateUsageCost(config, model, usage, actualModelName, descriptor = null) {
  const totals = getUsageTotals(usage);
  const defaultCurrency = config?.access?.budgets?.defaultCurrency || "USD";
  const modelRouterRequest = isModelRouterRequest(model);
  const pricingModelResolution = resolvePricingModel(config, model, actualModelName);
  const actualModelResolved = pricingModelResolution.actualModelName
    && !matchesPricingCandidate(model, pricingModelResolution.actualModelName);

  let actualModelCostAmount = 0;
  let actualModelCostCurrency = defaultCurrency;
  let actualSource = "";
  if (!modelRouterRequest || actualModelResolved) {
    const pricingDescriptor = pricingModelResolution.model === model
      ? descriptor
      : resolveModelDescriptor(pricingModelResolution.model?.id);
    const { pricing, source } = resolvePricing(config, pricingModelResolution.model, pricingDescriptor);
    if (pricing) {
      const billablePromptTokens = Math.max(0, totals.promptTokens - totals.cachedTokens);
      actualModelCostAmount =
        (billablePromptTokens / 1000) * pricing.inputPer1kTokens
        + (totals.cachedTokens / 1000) * pricing.cachedInputPer1kTokens
        + (totals.completionTokens / 1000) * pricing.outputPer1kTokens;
      actualModelCostCurrency = pricing.currency || defaultCurrency;
      actualSource = source;
    }
  }

  let modelRouterCostAmount = 0;
  let modelRouterCostCurrency = defaultCurrency;
  let modelRouterSource = "";
  if (modelRouterRequest) {
    const { pricing, source } = resolvePricing(config, {
      ...model,
      pricingRef: typeof model?.pricingRef === "string" && model.pricingRef.trim() ? model.pricingRef : "model-router"
    }, descriptor);
    if (pricing) {
      modelRouterCostAmount = (totals.promptTokens / 1000) * pricing.inputPer1kTokens;
      modelRouterCostCurrency = pricing.currency || defaultCurrency;
      modelRouterSource = source;
    }
  }

  const amount = actualModelCostAmount + modelRouterCostAmount;
  const currency = actualModelCostAmount > 0
    ? actualModelCostCurrency
    : (modelRouterCostAmount > 0 ? modelRouterCostCurrency : defaultCurrency);
  return {
    configured: modelRouterRequest ? !!(modelRouterSource && actualSource) : amount > 0,
    amount,
    currency,
    source: [modelRouterSource ? `model-router:${modelRouterSource}` : "", actualSource ? `actual:${actualSource}` : ""]
      .filter(Boolean)
      .join(" + "),
    actualModelName: pricingModelResolution.actualModelName,
    modelRouterCostAmount,
    modelRouterCostCurrency,
    actualModelCostAmount,
    actualModelCostCurrency,
    ...totals
  };
}

function markBlocked(runtime, reason, now) {
  runtime.totalBlockedRequests += 1;
  runtime.lastBlockedAt = toIsoString(now);
  runtime.lastBlockedReason = reason;
  runtime.rateWindow.blockedRequests += 1;
  runtime.budgetWindow.blockedRequests += 1;
}

function emitBudgetWarning(config, event, fields = {}) {
  appendStructuredLog("warn", {
    source: "governance",
    event,
    ...fields
  });
  recordRuntimeWarning(config, {
    occurredAt: String(fields.occurredAt || "") || toIsoString(),
    requestId: String(fields.requestId || ""),
    keyId: String(fields.keyId || ""),
    modelId: String(fields.modelId || ""),
    actualModelName: String(fields.actualModelName || ""),
    routeKey: String(fields.routeKey || ""),
    backendRouteKey: String(fields.backendRouteKey || ""),
    signalName: event,
    currency: String(fields.currency || "USD"),
    amount: Number.isFinite(Number(fields.amount)) ? Number(fields.amount) : undefined,
    limitAmount: Number.isFinite(Number(fields.limitAmount)) ? Number(fields.limitAmount) : undefined,
    softLimitAmount: Number.isFinite(Number(fields.softLimitAmount)) ? Number(fields.softLimitAmount) : undefined,
    failureReason: String(fields.failureReason || ""),
    payload: {
      event,
      source: "governance",
      actualModelName: String(fields.actualModelName || ""),
      failureReason: String(fields.failureReason || ""),
      amount: Number.isFinite(Number(fields.amount)) ? Number(fields.amount) : null,
      limitAmount: Number.isFinite(Number(fields.limitAmount)) ? Number(fields.limitAmount) : null,
      softLimitAmount: Number.isFinite(Number(fields.softLimitAmount)) ? Number(fields.softLimitAmount) : null
    }
  });
}

export function resolveApiConsumer(config, presentedKey) {
  const requireApiKey = config?.access?.defaults?.requireApiKey !== false;
  if (!presentedKey) {
    if (!requireApiKey) {
      return {
        ok: true,
        consumer: {
          keyId: "anonymous",
          displayName: "anonymous",
          isAnonymous: true,
          apiKey: null
        }
      };
    }
    return {
      ok: false,
      status: 401,
      error: "Unauthorized",
      message: "API key is required"
    };
  }
  const activeKey = (Array.isArray(config?.apiKeys) ? config.apiKeys : []).find((item) => item?.status !== "disabled" && item?.key === presentedKey);
  if (!activeKey) {
    return {
      ok: false,
      status: 401,
      error: "Unauthorized",
      message: "API key is invalid or disabled"
    };
  }
  return {
    ok: true,
    consumer: {
      keyId: String(activeKey.id || activeKey.displayName || "anonymous"),
      displayName: String(activeKey.displayName || activeKey.id || "anonymous"),
      isAnonymous: false,
      apiKey: activeKey
    }
  };
}

export function filterModelsForConsumer(models, consumer) {
  const source = Array.isArray(models) ? models : [];
  const allowedModels = normalizeStringArray(consumer?.apiKey?.allowedModels);
  return source.filter((model) => {
    if (String(model?.status || "").trim().toLowerCase() === "disabled") return false;
    if (!allowedModels.length) return true;
    return allowedModels.includes(model.id);
  });
}

export function checkConsumerModelAccess(consumer, model) {
  if (String(model?.status || "").trim().toLowerCase() === "disabled") {
    return {
      ok: false,
      status: 404,
      error: "ModelNotFound",
      code: "MODEL_NOT_FOUND",
      message: `model ${model?.id || "unknown"} not found`
    };
  }
  const allowedModels = normalizeStringArray(consumer?.apiKey?.allowedModels);
  if (!allowedModels.length) {
    return { ok: true };
  }
  if (allowedModels.includes(model?.id)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: "ModelAccessDenied",
    code: "MODEL_ACCESS_DENIED",
    message: `API key ${consumer?.keyId || "anonymous"} is not allowed to access model ${model?.id || "unknown"}`
  };
}

export async function acquireRequestGovernance(config, consumer, model, now = Date.now(), requestInfo = {}) {
  if (!consumer?.keyId) {
    return { ok: true, lease: { release() {} } };
  }
  const runtime = ensureKeyRuntime(consumer.keyId);
  runtime.displayName = consumer.displayName || consumer.keyId;
  runtime.owner = consumer.apiKey?.owner || "";
  runtime.lastSeenAt = toIsoString(now);

  const rateLimitSettings = getRateLimitSettings(config, consumer.apiKey);
  const budgetSettings = getBudgetSettings(config, consumer.apiKey);
  resetRateWindowIfNeeded(runtime, rateLimitSettings, now);
  resetBudgetWindowIfNeeded(runtime, budgetSettings, now);
  await hydrateRuntimeStateIfNeeded(config, consumer, runtime, rateLimitSettings, budgetSettings, now);

  if (rateLimitSettings.concurrency > 0 && runtime.currentConcurrent >= rateLimitSettings.concurrency) {
    markBlocked(runtime, "concurrency_limit_exceeded", now);
    recordRuntimeBlocked(config, {
      occurredAt: toIsoString(now),
      requestId: String(requestInfo.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      routeKey: String(requestInfo.routeKey || ""),
      backendRouteKey: String(requestInfo.backendRouteKey || ""),
      blockedReason: "concurrency_limit_exceeded"
    });
    return {
      ok: false,
      status: 429,
      error: "ConcurrencyLimitExceeded",
      code: "KEY_CONCURRENCY_LIMIT_EXCEEDED",
      message: `API key ${consumer.keyId} exceeded concurrency limit ${rateLimitSettings.concurrency}`
    };
  }
  if (rateLimitSettings.rpm > 0 && runtime.rateWindow.requests >= rateLimitSettings.rpm) {
    markBlocked(runtime, "rpm_limit_exceeded", now);
    recordRuntimeBlocked(config, {
      occurredAt: toIsoString(now),
      requestId: String(requestInfo.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      routeKey: String(requestInfo.routeKey || ""),
      backendRouteKey: String(requestInfo.backendRouteKey || ""),
      blockedReason: "rpm_limit_exceeded"
    });
    return {
      ok: false,
      status: 429,
      error: "RequestRateLimitExceeded",
      code: "KEY_RPM_LIMIT_EXCEEDED",
      message: `API key ${consumer.keyId} exceeded ${rateLimitSettings.rpm} requests per ${rateLimitSettings.windowSeconds}s window`
    };
  }
  if (rateLimitSettings.tpm > 0 && runtime.rateWindow.totalTokens >= rateLimitSettings.tpm) {
    markBlocked(runtime, "tpm_limit_exceeded", now);
    recordRuntimeBlocked(config, {
      occurredAt: toIsoString(now),
      requestId: String(requestInfo.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      routeKey: String(requestInfo.routeKey || ""),
      backendRouteKey: String(requestInfo.backendRouteKey || ""),
      blockedReason: "tpm_limit_exceeded"
    });
    return {
      ok: false,
      status: 429,
      error: "TokenRateLimitExceeded",
      code: "KEY_TPM_LIMIT_EXCEEDED",
      message: `API key ${consumer.keyId} exceeded ${rateLimitSettings.tpm} tokens per ${rateLimitSettings.windowSeconds}s window`
    };
  }
  if (budgetSettings.enabled && budgetSettings.limitAmount > 0 && budgetSettings.hardLimitAction === "block" && runtime.budgetWindow.spentAmount >= budgetSettings.limitAmount) {
    markBlocked(runtime, "budget_limit_exceeded", now);
    recordRuntimeBlocked(config, {
      occurredAt: toIsoString(now),
      requestId: String(requestInfo.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      routeKey: String(requestInfo.routeKey || ""),
      backendRouteKey: String(requestInfo.backendRouteKey || ""),
      blockedReason: "budget_limit_exceeded"
    });
    return {
      ok: false,
      status: 429,
      error: "BudgetExceeded",
      code: "KEY_BUDGET_EXCEEDED",
      message: `API key ${consumer.keyId} exceeded budget ${budgetSettings.limitAmount} ${budgetSettings.currency} for ${budgetSettings.windowType} window`
    };
  }

  runtime.currentConcurrent += 1;
  runtime.totalRequests += 1;
  runtime.rateWindow.requests += 1;

  let released = false;
  return {
    ok: true,
    lease: {
      release() {
        if (released) return;
        released = true;
        const nextRuntime = ensureKeyRuntime(consumer.keyId);
        nextRuntime.currentConcurrent = Math.max(0, nextRuntime.currentConcurrent - 1);
      }
    }
  };
}

export function noteGovernanceError(consumer) {
  if (!consumer?.keyId) return;
  const runtime = ensureKeyRuntime(consumer.keyId);
  runtime.totalErrors += 1;
}

export function recordGovernanceUsage(config, consumer, model, usage, now = Date.now(), actualModelName = "", metadata = {}) {
  if (!consumer?.keyId || !usage) {
    return {
      configured: false,
      amount: 0,
      currency: config?.access?.budgets?.defaultCurrency || "USD",
      source: "",
      actualModelName: String(actualModelName || ""),
      ...getUsageTotals(usage)
    };
  }
  const runtime = ensureKeyRuntime(consumer.keyId);
  const rateLimitSettings = getRateLimitSettings(config, consumer.apiKey);
  const budgetSettings = getBudgetSettings(config, consumer.apiKey);
  resetRateWindowIfNeeded(runtime, rateLimitSettings, now);
  resetBudgetWindowIfNeeded(runtime, budgetSettings, now);

  const usageCost = estimateUsageCost(config, model, usage, actualModelName, metadata.modelDescriptor);
  runtime.lastSeenAt = toIsoString(now);
  runtime.rateWindow.promptTokens += usageCost.promptTokens;
  runtime.rateWindow.completionTokens += usageCost.completionTokens;
  runtime.rateWindow.totalTokens += usageCost.totalTokens;
  runtime.rateWindow.cachedTokens += usageCost.cachedTokens;

  runtime.budgetWindow.requests += 1;
  runtime.budgetWindow.promptTokens += usageCost.promptTokens;
  runtime.budgetWindow.completionTokens += usageCost.completionTokens;
  runtime.budgetWindow.totalTokens += usageCost.totalTokens;
  runtime.budgetWindow.cachedTokens += usageCost.cachedTokens;
  runtime.budgetWindow.spentAmount += usageCost.amount;

  if (budgetSettings.enabled && budgetSettings.limitAmount > 0 && !usageCost.configured && !runtime.budgetWindow.unmeteredWarningAt) {
    runtime.budgetWindow.unmeteredWarningAt = toIsoString(now);
    emitBudgetWarning(config, "governance.budget_unmetered_usage", {
      occurredAt: toIsoString(now),
      requestId: String(metadata.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      actualModelName: usageCost.actualModelName || actualModelName || "",
      routeKey: String(metadata.routeKey || ""),
      backendRouteKey: String(metadata.backendRouteKey || ""),
      failureReason: "budget enabled but pricing could not be resolved",
      currency: budgetSettings.currency,
      limitAmount: budgetSettings.limitAmount
    });
  }

  const softLimitAmount = budgetSettings.limitAmount > 0 ? budgetSettings.limitAmount * budgetSettings.softLimitRatio : 0;
  if (softLimitAmount > 0 && !runtime.budgetWindow.softLimitReached && runtime.budgetWindow.spentAmount >= softLimitAmount) {
    runtime.budgetWindow.softLimitReached = true;
    runtime.budgetWindow.softLimitReachedAt = toIsoString(now);
    emitBudgetWarning(config, "governance.budget_soft_limit_reached", {
      occurredAt: toIsoString(now),
      requestId: String(metadata.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      actualModelName: usageCost.actualModelName || actualModelName || "",
      routeKey: String(metadata.routeKey || ""),
      backendRouteKey: String(metadata.backendRouteKey || ""),
      amount: runtime.budgetWindow.spentAmount,
      currency: budgetSettings.currency,
      softLimitAmount,
      limitAmount: budgetSettings.limitAmount
    });
  }

  if (
    budgetSettings.enabled
    && budgetSettings.limitAmount > 0
    && budgetSettings.hardLimitAction === "warn"
    && runtime.budgetWindow.spentAmount >= budgetSettings.limitAmount
    && !runtime.budgetWindow.hardLimitWarningAt
  ) {
    runtime.budgetWindow.hardLimitWarningAt = toIsoString(now);
    emitBudgetWarning(config, "governance.budget_hard_limit_warning", {
      occurredAt: toIsoString(now),
      requestId: String(metadata.requestId || ""),
      keyId: consumer.keyId,
      modelId: model?.id || "",
      actualModelName: usageCost.actualModelName || actualModelName || "",
      routeKey: String(metadata.routeKey || ""),
      backendRouteKey: String(metadata.backendRouteKey || ""),
      amount: runtime.budgetWindow.spentAmount,
      currency: budgetSettings.currency,
      limitAmount: budgetSettings.limitAmount,
      failureReason: "budget hard limit reached with warn action"
    });
  }

  return usageCost;
}

export async function getGovernanceSnapshot(config) {
  const now = Date.now();
  const configuredKeys = Array.isArray(config?.apiKeys) ? config.apiKeys : [];
  const keyIds = new Set();
  const keys = [];

  for (const apiKey of configuredKeys) {
    const keyId = String(apiKey?.id || apiKey?.displayName || "anonymous");
    keyIds.add(keyId);
    const runtime = ensureKeyRuntime(keyId);
    const consumer = { keyId, displayName: apiKey?.displayName || keyId, apiKey };
    const rateLimit = getRateLimitSettings(config, apiKey);
    const budget = getBudgetSettings(config, apiKey);
    resetRateWindowIfNeeded(runtime, rateLimit, now);
    resetBudgetWindowIfNeeded(runtime, budget, now);
    await hydrateRuntimeStateIfNeeded(config, consumer, runtime, rateLimit, budget, now);
    keys.push({
      keyId,
      displayName: consumer.displayName,
      owner: apiKey?.owner || "",
      status: apiKey?.status || "active",
      allowedModels: normalizeStringArray(apiKey?.allowedModels),
      rateLimit,
      budget,
      runtime: {
        currentConcurrent: runtime.currentConcurrent,
        totalRequests: runtime.totalRequests,
        totalErrors: runtime.totalErrors,
        totalBlockedRequests: runtime.totalBlockedRequests,
        lastSeenAt: runtime.lastSeenAt,
        lastBlockedAt: runtime.lastBlockedAt,
        lastBlockedReason: runtime.lastBlockedReason,
        rateWindow: { ...runtime.rateWindow },
        budgetWindow: { ...runtime.budgetWindow }
      }
    });
  }

  for (const [keyId, runtime] of governanceState.perKey.entries()) {
    if (keyIds.has(keyId)) continue;
    keys.push({
      keyId,
      displayName: runtime.displayName || keyId,
      owner: runtime.owner || "",
      status: keyId === "anonymous" ? "active" : "unknown",
      allowedModels: [],
      rateLimit: { windowSeconds: 60, rpm: 0, tpm: 0, concurrency: 0 },
      budget: { enabled: false, limitAmount: 0, currency: config?.access?.budgets?.defaultCurrency || "USD", windowType: "monthly", softLimitRatio: 0.8, hardLimitAction: "block" },
      runtime: {
        currentConcurrent: runtime.currentConcurrent,
        totalRequests: runtime.totalRequests,
        totalErrors: runtime.totalErrors,
        totalBlockedRequests: runtime.totalBlockedRequests,
        lastSeenAt: runtime.lastSeenAt,
        lastBlockedAt: runtime.lastBlockedAt,
        lastBlockedReason: runtime.lastBlockedReason,
        rateWindow: { ...runtime.rateWindow },
        budgetWindow: { ...runtime.budgetWindow }
      }
    });
  }

  keys.sort((a, b) => a.keyId.localeCompare(b.keyId));
  return {
    generatedAt: new Date(now).toISOString(),
    keys
  };
}