import { randomUUID } from "node:crypto";
import { getUpstreamAuthHeaders } from "./auth.js";
import { getCodexModelMetadata } from "./codex-models.js";
import { getDescriptorRouteTargets, resolveModelDescriptor } from "./model-catalog.js";
import {
  prepareImageGenerationRequest,
  isBlackForestLabsProviderPath
} from "./proxy/image-adapter.js";
import {
  HARNESS_CLIENT_ROUTE_KEYS,
  findUpstream,
  hasHarnessNativeRoute,
  isPublicRouteEnabled,
  resolveRoutePlan
} from "./proxy/routing.js";
import { classifyFetchError, resolveUpstreamPolicy } from "./proxy/reliability.js";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeProvider(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function isDisabledStatus(status) {
  return normalizeString(status).toLowerCase() === "disabled";
}

function inferValidationRouteKey(model, definition, descriptor = null) {
  const descriptorInterfaces = normalizeStringArray(descriptor?.interfaces);
  const interfaces = descriptorInterfaces.length > 0
    ? descriptorInterfaces
    : normalizeStringArray(definition?.interfaces);
  const defaultInterface = normalizeString(descriptor?.defaultInterface || definition?.defaultInterface).toLowerCase();
  const routeKey = interfaces.includes("images/generations")
    ? "images/generations"
    : interfaces.includes(defaultInterface)
      ? defaultInterface
    : interfaces.includes("messages")
      ? "messages"
      : interfaces.includes("responses") && !interfaces.includes("chat/completions")
        ? "responses"
        : "chat/completions";
  return routeKey;
}

function buildValidationTarget(model, upstream, routeKey, descriptor = null) {
  const plan = resolveRoutePlan({ routeKey, model, upstream, descriptor });

  return {
    deployment: plan.deployment,
    routeKey,
    backendRouteKey: plan.backendRouteKey,
    targetUrl: plan.targetUrl,
    descriptor,
    overrideType: plan.override?.type || "routeKey"
  };
}

function buildValidationPayload(target) {
  const basePayload = target.backendRouteKey === "responses"
    ? {
      model: target.deployment,
      input: "health-check"
    }
    : target.backendRouteKey === "messages"
      ? {
        model: target.deployment,
        messages: [
          {
            role: "user",
            content: "health-check"
          }
        ],
        max_tokens: 1
      }
    : target.backendRouteKey === "images/generations"
      ? {
        model: target.deployment,
        prompt: "health-check",
        size: "1024x1024"
      }
      : target.backendRouteKey === "chat/completions"
        ? {
        model: target.deployment,
        messages: [
          {
            role: "user",
            content: "health-check"
          }
        ]
        }
        : null;

  if (!basePayload) return null;

  return prepareImageGenerationRequest({
    body: basePayload,
    model: {
      id: target.deployment,
      targetModel: target.deployment,
      pricingRef: target.pricingRef || target.deployment
    },
    descriptor: target.descriptor,
    routeKey: target.routeKey,
    backendRouteKey: target.backendRouteKey,
    targetUrl: target.targetUrl
  });
}

function rankState(state) {
  if (state === "failed") return 3;
  if (state === "warning") return 2;
  if (state === "skipped") return 1;
  return 0;
}

function summarizeStates(items) {
  const summary = {
    total: items.length,
    ok: 0,
    warning: 0,
    failed: 0,
    skipped: 0
  };
  for (const item of items) {
    if (item?.state === "ok") summary.ok += 1;
    else if (item?.state === "warning") summary.warning += 1;
    else if (item?.state === "failed") summary.failed += 1;
    else if (item?.state === "skipped") summary.skipped += 1;
  }
  return summary;
}

function buildStaticIssue(model, message) {
  return {
    modelId: normalizeString(model?.id),
    upstream: normalizeString(model?.upstream),
    message
  };
}

function getCatalogIdentity(model) {
  return normalizeString(model?.pricingRef)
    || normalizeString(model?.id)
    || normalizeString(model?.targetModel);
}

function getCatalogRouteBindingIssues(model, descriptor, snapshot) {
  const issues = [];
  const allowedSources = new Set(normalizeStringArray(snapshot?.routeInterfaces));
  const allowedTargets = new Set(getDescriptorRouteTargets(descriptor));

  for (const [source, target] of Object.entries(model?.routes || {})) {
    const normalizedSource = normalizeString(source);
    const normalizedTarget = normalizeString(target);
    if (normalizedSource !== "*" && !allowedSources.has(normalizedSource)) {
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" route source "${source}" is not an interface declared by the Model Catalog`
      ));
    }
    if (!allowedTargets.has(normalizedTarget)) {
      const allowed = [...allowedTargets].sort().join(", ") || "none";
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" route target "${target}" is not allowed by Model Catalog model "${descriptor.catalogId}"; allowed targets: ${allowed}`
      ));
    }
  }
  return issues;
}

const CLIENT_COMPATIBILITY_PROTOCOLS = {
  claudeCode: { label: "Claude Code", routeKey: HARNESS_CLIENT_ROUTE_KEYS.claudeCode },
  codex: { label: "Codex", routeKey: HARNESS_CLIENT_ROUTE_KEYS.codex }
};
const NATIVE_ROUTE_REPAIRABLE_REASONS = new Set(["NON_NATIVE_PROTOCOL", "ROUTE_UNAVAILABLE"]);
const CONVERSION_REPAIRABLE_REASONS = new Set(["NON_NATIVE_PROTOCOL"]);
const CONVERSION_ROUTE_KEYS = new Set(["chat/completions", "responses", "messages"]);
// Harness clients are text-generation agents; models that only serve media, speech, realtime or vector workloads cannot back them.
const TEXT_GENERATION_INTERFACES = new Set(["chat/completions", "responses", "messages"]);
const NON_TEXT_CAPABILITIES = [
  "image-generation", "image-editing", "text-to-image", "text-to-video", "video-generation",
  "text-to-speech", "speech-to-text", "speech-to-speech", "transcription", "realtime"
];

// The conversion flag is an administrator acknowledgement that a Harness member may use the
// shim-converted route. It is inert unless the model is a member, and the native override wins.
function hasHarnessConversion(model, clientName) {
  return model?.clientCompatibility?.[clientName] === true
    && model?.clientConversion?.[clientName] === true
    && model?.clientNativeRoute?.[clientName] !== true;
}

// Mirrors the request-side gate in proxy.js: strict mode rejects every lossy shim request.
function rejectsLossyShimRequests(config) {
  return config?.compatibility?.protocolShim?.rejectLossyRequests !== false;
}

function normalizeCapabilities(model, descriptor) {
  const capabilities = Array.isArray(descriptor?.capabilities) && descriptor.capabilities.length > 0
    ? descriptor.capabilities
    : model?.capabilities;
  return new Set(normalizeStringArray(capabilities).map((value) => value.toLowerCase().replaceAll("_", "-")));
}

function buildEligibilityReason(code, message) {
  return { code, message };
}

// Returns why the Catalog entry is not a text-generation model, or null when it is (or is unknown).
function getNonTextModelDetail(model, descriptor) {
  if (!descriptor?.catalogMatched) return null;
  const interfaces = normalizeStringArray(descriptor.interfaces);
  if (interfaces.length > 0 && !interfaces.some((name) => TEXT_GENERATION_INTERFACES.has(name))) {
    return `its interfaces (${interfaces.join(", ")}) include no chat/completions, responses or messages protocol`;
  }
  const outputs = normalizeStringArray(descriptor.definition?.outputModalities).map((value) => value.toLowerCase());
  if (outputs.length > 0 && !outputs.includes("text")) {
    return `it does not produce text output (${outputs.join(", ")})`;
  }
  const capabilities = normalizeCapabilities(model, descriptor);
  const label = NON_TEXT_CAPABILITIES.find((capability) => capabilities.has(capability));
  return label ? `it is declared as ${label}` : null;
}

export function getHarnessClientEligibility(config, model, clientName, snapshot, context = {}) {
  const protocol = CLIENT_COMPATIBILITY_PROTOCOLS[clientName];
  if (!protocol) {
    throw new Error(`Unknown Harness client: ${clientName}`);
  }

  const reasons = [];
  let conversion = null;
  const descriptor = context.descriptor ?? resolveModelDescriptor(model, snapshot);
  const upstream = context.upstream ?? findUpstream(config, model?.upstream);
  if (isDisabledStatus(model?.status)) {
    reasons.push(buildEligibilityReason(
      "MODEL_DISABLED",
      `model "${model?.id}" is marked for ${protocol.label} but the model is disabled`
    ));
  }
  if (!descriptor?.catalogMatched) {
    reasons.push(buildEligibilityReason(
      "MODEL_CATALOG_NOT_FOUND",
      `model "${model?.id}" is marked for ${protocol.label} but was not found in the Model Catalog`
    ));
  }
  if (!upstream) {
    reasons.push(buildEligibilityReason(
      "UPSTREAM_NOT_FOUND",
      `model "${model?.id}" is marked for ${protocol.label} but references an unknown upstream`
    ));
  } else if (isDisabledStatus(upstream.status)) {
    reasons.push(buildEligibilityReason(
      "UPSTREAM_DISABLED",
      `model "${model?.id}" is marked for ${protocol.label} but upstream "${upstream.name}" is disabled`
    ));
  }
  if (!isPublicRouteEnabled(config, protocol.routeKey)) {
    reasons.push(buildEligibilityReason(
      "PUBLIC_ROUTE_DISABLED",
      `model "${model?.id}" is marked for ${protocol.label} but public route ${protocol.routeKey} is disabled`
    ));
  }
  const nonTextDetail = getNonTextModelDetail(model, descriptor);
  if (nonTextDetail) {
    reasons.push(buildEligibilityReason(
      "NON_TEXT_MODEL",
      `model "${model?.id}" is marked for ${protocol.label} but is not a text-generation model: ${nonTextDetail}`
    ));
  }

  if (!nonTextDetail && descriptor?.catalogMatched && upstream && !isDisabledStatus(upstream.status) && isPublicRouteEnabled(config, protocol.routeKey)) {
    try {
      const target = buildValidationTarget(model, upstream, protocol.routeKey, descriptor);
      if (target.backendRouteKey !== protocol.routeKey) {
        if (hasHarnessConversion(model, clientName) && CONVERSION_ROUTE_KEYS.has(target.backendRouteKey)) {
          conversion = {
            from: protocol.routeKey,
            to: target.backendRouteKey,
            routePath: new URL(target.targetUrl).pathname
          };
          if (rejectsLossyShimRequests(config)) {
            reasons.push(buildEligibilityReason(
              "CONVERSION_BLOCKED_BY_POLICY",
              `model "${model?.id}" is marked for ${protocol.label} through ${protocol.routeKey} -> ${target.backendRouteKey} conversion, but compatibility.protocolShim.rejectLossyRequests rejects the lossy requests ${protocol.label} sends`
            ));
          }
        } else {
          reasons.push(buildEligibilityReason(
            "NON_NATIVE_PROTOCOL",
            `model "${model?.id}" is marked for ${protocol.label} but ${protocol.routeKey} resolves to ${target.backendRouteKey}; native ${protocol.routeKey} is required`
          ));
        }
      }
    } catch (error) {
      reasons.push(buildEligibilityReason(
        "ROUTE_UNAVAILABLE",
        `model "${model?.id}" is marked for ${protocol.label} but has no usable native ${protocol.routeKey} route: ${error?.message || "route resolution failed"}`
      ));
    }
  }

  const eligible = reasons.length === 0;
  return {
    eligible,
    mode: eligible ? (conversion ? "conversion" : "native") : null,
    routeKey: protocol.routeKey,
    reasons,
    ...(conversion ? { conversion } : {})
  };
}

function resolveNativeRoutePath(config, model, clientName, snapshot) {
  const { routeKey } = CLIENT_COMPATIBILITY_PROTOCOLS[clientName];
  const upstream = findUpstream(config, model?.upstream);
  const descriptor = resolveModelDescriptor(model, snapshot);
  if (!upstream || !descriptor) return null;
  try {
    const target = buildValidationTarget(model, upstream, routeKey, descriptor);
    return target.backendRouteKey === routeKey ? new URL(target.targetUrl).pathname : null;
  } catch {
    return null;
  }
}

function getHarnessClientNativeRouteState(config, model, clientName, snapshot, eligibility) {
  if (hasHarnessNativeRoute(model, eligibility.routeKey)) {
    return { active: true, routePath: resolveNativeRoutePath(config, model, clientName, snapshot) };
  }
  const repairable = Boolean(eligibility.conversion)
    || (eligibility.reasons.length > 0 && eligibility.reasons.every((reason) => NATIVE_ROUTE_REPAIRABLE_REASONS.has(reason.code)));
  if (!repairable) {
    return { active: false, candidate: null };
  }
  const trial = {
    ...model,
    clientCompatibility: { ...model?.clientCompatibility, [clientName]: true },
    clientNativeRoute: { ...model?.clientNativeRoute, [clientName]: true }
  };
  const result = getHarnessClientEligibility(config, trial, clientName, snapshot);
  return {
    active: false,
    candidate: {
      eligible: result.eligible,
      reasons: result.reasons,
      routePath: result.eligible ? resolveNativeRoutePath(config, trial, clientName, snapshot) : null
    }
  };
}

function getHarnessClientConversionState(config, model, clientName, snapshot, eligibility) {
  if (eligibility.conversion) {
    return { active: true, ...eligibility.conversion };
  }
  if (
    hasHarnessNativeRoute(model, eligibility.routeKey)
    || !eligibility.reasons.length
    || !eligibility.reasons.every((reason) => CONVERSION_REPAIRABLE_REASONS.has(reason.code))
  ) {
    return { active: false, candidate: null };
  }
  const trial = {
    ...model,
    clientCompatibility: { ...model?.clientCompatibility, [clientName]: true },
    clientConversion: { ...model?.clientConversion, [clientName]: true }
  };
  const result = getHarnessClientEligibility(config, trial, clientName, snapshot);
  return {
    active: false,
    candidate: {
      eligible: result.eligible,
      reasons: result.reasons,
      from: result.conversion?.from ?? null,
      to: result.conversion?.to ?? null,
      routePath: result.conversion?.routePath ?? null
    }
  };
}

function getHarnessClientPreview(config, model, clientName, snapshot) {
  const eligibility = getHarnessClientEligibility(config, model, clientName, snapshot);
  const { conversion, ...preview } = eligibility;
  return {
    ...preview,
    nativeRoute: getHarnessClientNativeRouteState(config, model, clientName, snapshot, eligibility),
    conversion: getHarnessClientConversionState(config, model, clientName, snapshot, eligibility)
  };
}

export function getHarnessModelEligibility(config, snapshot) {
  return (Array.isArray(config?.models) ? config.models : []).map((model) => ({
    modelId: normalizeString(model?.id),
    displayName: normalizeString(model?.displayName) || normalizeString(model?.id),
    selected: {
      claudeCode: model?.clientCompatibility?.claudeCode === true,
      codex: model?.clientCompatibility?.codex === true
    },
    clients: {
      claudeCode: getHarnessClientPreview(config, model, "claudeCode", snapshot),
      codex: getHarnessClientPreview(config, model, "codex", snapshot)
    }
  }));
}

export function getHarnessCatalogState(config, snapshot) {
  const items = getHarnessModelEligibility(config, snapshot);
  let codexIndex = 0;
  for (const [index, item] of items.entries()) {
    if (item.selected.codex && item.clients.codex.eligible) {
      const model = config.models[index];
      item.codex = getCodexModelMetadata(
        model,
        codexIndex++,
        resolveModelDescriptor(model, snapshot),
        { converted: item.clients.codex.mode === "conversion" }
      );
    }
  }
  return {
    catalogs: {
      claudeCode: { enabled: config?.compatibility?.claudeCode?.enabled !== false },
      codex: { enabled: config?.compatibility?.codex?.enabled !== false }
    },
    items
  };
}

function getClientCompatibilityIssues(config, model, upstream, descriptor, snapshot) {
  const issues = [];
  for (const clientName of Object.keys(CLIENT_COMPATIBILITY_PROTOCOLS)) {
    if (model?.clientCompatibility?.[clientName] !== true) continue;
    const eligibility = getHarnessClientEligibility(
      config,
      model,
      clientName,
      snapshot,
      { upstream, descriptor }
    );
    if (!eligibility.eligible) issues.push(buildStaticIssue(model, eligibility.reasons[0].message));
  }
  return issues;
}

export function getConfiguredModelBindingIssues(config, snapshot) {
  const issues = [];
  for (const model of Array.isArray(config?.models) ? config.models : []) {
    if (!model?.id) continue;

    if (isDisabledStatus(model?.status)) {
      issues.push(...getClientCompatibilityIssues(
        config,
        model,
        findUpstream(config, model.upstream),
        resolveModelDescriptor(model, snapshot),
        snapshot
      ));
      continue;
    }

    const descriptor = resolveModelDescriptor(model.id, snapshot);
    if (!descriptor?.catalogMatched) {
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" references "${getCatalogIdentity(model)}", which was not found in the Model Catalog`
      ));
      continue;
    }

    const configuredHostingMode = normalizeString(model.hostingMode).toLowerCase();
    const supportedHostingModes = new Set([
      ...normalizeStringArray(descriptor.definition?.hostingModes),
      ...Object.keys(descriptor.definition?.interfacesByHostingMode || {})
    ].map((mode) => mode.toLowerCase()));
    if (
      configuredHostingMode
      && !supportedHostingModes.has(configuredHostingMode)
    ) {
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" hostingMode "${configuredHostingMode}" is not supported by Model Catalog model "${descriptor.catalogId}"; supported modes: ${[...supportedHostingModes].sort().join(", ") || "none"}`
      ));
      continue;
    }

    const routeBindingIssues = getCatalogRouteBindingIssues(model, descriptor, snapshot);
    issues.push(...routeBindingIssues);
    if (routeBindingIssues.length > 0) continue;

    const upstream = findUpstream(config, model.upstream);
    if (!upstream) {
      issues.push(buildStaticIssue(model, `model \"${model.id}\" references unknown upstream \"${model.upstream}\"`));
      continue;
    }
    if (isDisabledStatus(upstream?.status)) {
      issues.push(buildStaticIssue(model, `model \"${model.id}\" is bound to disabled upstream \"${upstream.name}\"`));
    }

    issues.push(...getClientCompatibilityIssues(config, model, upstream, descriptor, snapshot));

    const definition = descriptor?.definition;
    const definitionProvider = normalizeProvider(definition?.provider);
    const validationRouteKeys = new Set(normalizeStringArray(descriptor?.interfaces));
    for (const sourceRouteKey of Object.keys(model?.routes || {})) {
      const normalizedSource = normalizeString(sourceRouteKey).toLowerCase();
      if (normalizedSource && normalizedSource !== "*") validationRouteKeys.add(normalizedSource);
    }
    if (validationRouteKeys.size === 0) {
      validationRouteKeys.add(inferValidationRouteKey(model, definition, descriptor));
    }
    for (const validationRouteKey of validationRouteKeys) {
      try {
        const target = buildValidationTarget(model, upstream, validationRouteKey, descriptor);
        if (
          definitionProvider === "black-forest-labs"
          && !isBlackForestLabsProviderPath(target.targetUrl)
        ) {
          issues.push(buildStaticIssue(
            model,
            `model \"${model.id}\" requires a /providers/blackforestlabs/v1/... route, but route \"${validationRouteKey}\" resolves to \"${target.targetUrl}\"`
          ));
        }
      } catch (error) {
        issues.push(buildStaticIssue(
          model,
          `model \"${model.id}\" has no usable upstream route for \"${validationRouteKey}\": ${error?.message || "route resolution failed"}`
        ));
      }
    }
  }
  return issues;
}

function buildStaticResultItem(config, model) {
  const descriptor = resolveModelDescriptor(model?.id);
  const definition = descriptor?.definition;
  const upstream = findUpstream(config, model.upstream);
  const base = {
    modelId: normalizeString(model?.id),
    displayName: normalizeString(model?.displayName) || normalizeString(model?.id),
    modelStatus: normalizeString(model?.status) || "active",
    upstream: normalizeString(model?.upstream),
    upstreamStatus: normalizeString(upstream?.status) || "active",
    upstreamProvider: normalizeString(upstream?.provider) || "azure-openai",
    definitionProvider: normalizeString(definition?.provider),
    interfaces: normalizeStringArray(definition?.interfaces),
    state: "ok",
    messages: [],
    routeKey: "",
    backendRouteKey: "",
    targetUrl: "",
    checkedAt: new Date().toISOString()
  };

  if (isDisabledStatus(model?.status)) {
    return {
      ...base,
      state: "skipped",
      messages: ["model is disabled"]
    };
  }

  if (!upstream) {
    return {
      ...base,
      state: "failed",
      messages: [`unknown upstream: ${normalizeString(model?.upstream) || "<empty>"}`]
    };
  }

  if (isDisabledStatus(upstream?.status)) {
    base.state = "failed";
    base.messages.push(`upstream \"${upstream.name}\" is disabled`);
  }

  try {
    const target = buildValidationTarget(model, upstream, inferValidationRouteKey(model, definition, descriptor), descriptor);
    base.routeKey = target.routeKey;
    base.backendRouteKey = target.backendRouteKey;
    base.targetUrl = target.targetUrl;
    base.pricingRef = normalizeString(model?.pricingRef);
    if (
      normalizeProvider(definition?.provider) === "black-forest-labs"
      && !isBlackForestLabsProviderPath(target.targetUrl)
    ) {
      base.state = "failed";
      base.messages.push("This Black Forest Labs image model requires a /providers/blackforestlabs/v1/... route");
    }
  } catch (error) {
    base.state = "failed";
    base.messages.push(error?.message || "route resolution failed");
  }

  return base;
}

async function fetchValidationResponse({ targetUrl, headers, bodyText, requestTimeoutMs }) {
  const controller = new AbortController();
  const requestTimer = setTimeout(() => {
    controller.abort("request-timeout");
  }, requestTimeoutMs);

  try {
    return await fetch(targetUrl, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "request-timeout") {
      const timeoutError = error instanceof Error ? error : new Error(String(error || ""));
      timeoutError.code = "UPSTREAM_REQUEST_TIMEOUT";
      timeoutError.message = `request timeout after ${requestTimeoutMs}ms`;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(requestTimer);
  }
}

function applyProbeOutcome(item, outcome) {
  if (rankState(outcome.state) > rankState(item.state)) {
    item.state = outcome.state;
  }
  item.probe = {
    ...outcome,
    checkedAt: new Date().toISOString()
  };
}

async function probeConfiguredModel(config, item) {
  const model = (config.models || []).find((candidate) => candidate?.id === item.modelId);
  const upstream = findUpstream(config, item.upstream);
  if (!model || !upstream) {
    applyProbeOutcome(item, {
      state: "failed",
      errorCode: "MODEL_VALIDATION_CONFIG_MISSING",
      message: "model or upstream disappeared before validation probe started"
    });
    return;
  }

  const descriptor = resolveModelDescriptor(model.id);
  const target = buildValidationTarget(
    model,
    upstream,
    item.routeKey || inferValidationRouteKey(model, descriptor?.definition, descriptor),
    descriptor
  );
  const payload = buildValidationPayload(target);
  if (!payload) {
    applyProbeOutcome(item, {
      state: "skipped",
      errorCode: "MODEL_VALIDATION_PROBE_UNSUPPORTED",
      message: `validation probe is not implemented for ${target.backendRouteKey}`
    });
    return;
  }
  const policy = resolveUpstreamPolicy(config, {
    routeKey: target.routeKey,
    model,
    upstream,
    requestOverrides: {
      maxRetries: 0,
      connectMs: Math.min(10000, Math.max(1000, Number(config?.proxy?.timeouts?.connectMs || 5000))),
      requestMs: Math.min(45000, Math.max(5000, Number(config?.proxy?.timeouts?.requestMs || 30000)))
    }
  });

  const usesAnthropicMessages = target.backendRouteKey === "messages";
  const headers = {
    "content-type": "application/json",
    ...(usesAnthropicMessages ? { "anthropic-version": "2023-06-01" } : {}),
    ...await getUpstreamAuthHeaders(
      usesAnthropicMessages ? "https://ai.azure.com/.default" : config?.auth?.scope,
      {
        auth: upstream.auth,
        apiKeyHeader: usesAnthropicMessages ? "x-api-key" : "api-key"
      }
    ),
    "x-request-id": `model-validate-${randomUUID()}`
  };

  try {
    const response = await fetchValidationResponse({
      targetUrl: target.targetUrl,
      headers,
      bodyText: JSON.stringify(payload),
      requestTimeoutMs: policy.requestTimeoutMs
    });

    if (response.ok) {
      await response.body?.cancel?.().catch(() => {});
      applyProbeOutcome(item, {
        state: "ok",
        status: response.status,
        message: `validation probe succeeded with HTTP ${response.status}`
      });
      return;
    }

    const detail = (await response.text().catch(() => "")).trim();
    const message = detail || `validation probe returned HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403 || response.status === 404 || response.status >= 500) {
      applyProbeOutcome(item, {
        state: "failed",
        status: response.status,
        errorCode: response.status >= 500 ? "MODEL_VALIDATION_UPSTREAM_5XX" : "MODEL_VALIDATION_UPSTREAM_REJECTED",
        message
      });
      return;
    }
    applyProbeOutcome(item, {
      state: "warning",
      status: response.status,
      errorCode: "MODEL_VALIDATION_UPSTREAM_WARNING",
      message
    });
  } catch (error) {
    const classified = classifyFetchError(error);
    applyProbeOutcome(item, {
      state: "failed",
      status: classified.status,
      errorCode: classified.code,
      message: classified.detail || error?.message || "validation probe failed"
    });
  }
}

export async function validateConfiguredModels(config, options = {}) {
  const includeProbe = options.probe !== false;
  const items = (Array.isArray(config?.models) ? config.models : []).map((model) => buildStaticResultItem(config, model));

  if (includeProbe) {
    for (const item of items) {
      if (item.state === "failed" || item.state === "skipped") continue;
      await probeConfiguredModel(config, item);
    }
  }

  return {
    ok: true,
    mode: includeProbe ? "static+probe" : "static",
    checkedAt: new Date().toISOString(),
    summary: summarizeStates(items),
    items
  };
}