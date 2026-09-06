import { randomUUID } from "node:crypto";
import { getUpstreamAuthHeaders } from "./auth.js";
import { getDescriptorRouteTargets, resolveModelDescriptor } from "./model-catalog.js";
import {
  prepareImageGenerationRequest,
  isBlackForestLabsProviderPath
} from "./proxy/image-adapter.js";
import {
  findUpstream,
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
  claudeCode: { label: "Claude Code", routeKey: "messages" },
  codex: { label: "Codex", routeKey: "responses" }
};

function normalizeCapabilities(model, descriptor) {
  const capabilities = Array.isArray(descriptor?.capabilities) && descriptor.capabilities.length > 0
    ? descriptor.capabilities
    : model?.capabilities;
  return new Set(normalizeStringArray(capabilities).map((value) => value.toLowerCase().replaceAll("_", "-")));
}

function buildEligibilityReason(code, message) {
  return { code, message };
}

export function getHarnessClientEligibility(config, model, clientName, snapshot, context = {}) {
  const protocol = CLIENT_COMPATIBILITY_PROTOCOLS[clientName];
  if (!protocol) {
    throw new Error(`Unknown Harness client: ${clientName}`);
  }

  const reasons = [];
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
  if (
    clientName === "codex"
    && ["image-generation", "image-editing"].some((capability) => normalizeCapabilities(model, descriptor).has(capability))
  ) {
    reasons.push(buildEligibilityReason(
      "UNSUPPORTED_MODEL_CAPABILITY",
      `model "${model?.id}" is marked for Codex but image generation and editing models are not supported`
    ));
  }

  if (descriptor?.catalogMatched && upstream && !isDisabledStatus(upstream.status) && isPublicRouteEnabled(config, protocol.routeKey)) {
    try {
      const target = buildValidationTarget(model, upstream, protocol.routeKey, descriptor);
      if (target.backendRouteKey !== protocol.routeKey) {
        reasons.push(buildEligibilityReason(
          "NON_NATIVE_PROTOCOL",
          `model "${model?.id}" is marked for ${protocol.label} but ${protocol.routeKey} resolves to ${target.backendRouteKey}; native ${protocol.routeKey} is required`
        ));
      }
    } catch (error) {
      reasons.push(buildEligibilityReason(
        "ROUTE_UNAVAILABLE",
        `model "${model?.id}" is marked for ${protocol.label} but has no usable native ${protocol.routeKey} route: ${error?.message || "route resolution failed"}`
      ));
    }
  }

  return {
    eligible: reasons.length === 0,
    routeKey: protocol.routeKey,
    reasons
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
      claudeCode: getHarnessClientEligibility(config, model, "claudeCode", snapshot),
      codex: getHarnessClientEligibility(config, model, "codex", snapshot)
    }
  }));
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