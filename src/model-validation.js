import { randomUUID } from "node:crypto";
import { getUpstreamAuthHeaders } from "./auth.js";
import { findPricingDefinitionForModel } from "./pricing-library.js";
import {
  prepareImageGenerationRequest,
  isBlackForestLabsProviderPath
} from "./proxy/image-adapter.js";
import {
  findUpstream,
  buildUpstreamUrl,
  buildDirectUpstreamUrl,
  resolveModelRoute,
  resolveEffectiveRouteKey,
  normalizeBackendRouteKey,
  isPublicRouteEnabled,
  inferBackendRouteKey,
  reconcileBackendRouteKey
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

function inferValidationRouteKey(model, definition) {
  const interfaces = normalizeStringArray(definition?.interfaces);
  const routeKey = interfaces.includes("images/generations")
    ? "images/generations"
    : interfaces.includes("messages")
      ? "messages"
      : interfaces.includes("responses") && !interfaces.includes("chat/completions")
        ? "responses"
        : "chat/completions";
  return routeKey;
}

function buildValidationTarget(model, upstream, routeKey) {
  const deployment = normalizeString(model?.targetModel) || normalizeString(model?.id);
  const usesModelRouter = deployment.toLowerCase() === "model-router";
  const override = resolveModelRoute(model, routeKey);
  const effectiveRouteKey = usesModelRouter
    ? "chat/completions"
    : resolveEffectiveRouteKey(routeKey, model, upstream, override);
  const configuredBackendRouteKey = override
    ? inferBackendRouteKey(routeKey, override)
    : normalizeBackendRouteKey(effectiveRouteKey);
  const targetUrl = override?.type === "path"
    ? buildDirectUpstreamUrl(upstream, override.value, deployment, model)
    : buildUpstreamUrl(upstream, effectiveRouteKey, deployment, model);
  const backendRouteKey = reconcileBackendRouteKey(configuredBackendRouteKey, targetUrl);

  return {
    deployment,
    routeKey,
    backendRouteKey,
    targetUrl,
    overrideType: override?.type || "routeKey"
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
      : {
        model: target.deployment,
        messages: [
          {
            role: "user",
            content: "health-check"
          }
        ]
      };

  return prepareImageGenerationRequest({
    body: basePayload,
    model: {
      id: target.deployment,
      targetModel: target.deployment,
      pricingRef: target.pricingRef || target.deployment
    },
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

const CLIENT_COMPATIBILITY_PROTOCOLS = {
  claudeCode: { label: "Claude Code", routeKey: "messages" },
  codex: { label: "Codex", routeKey: "responses" }
};

function getClientCompatibilityIssues(config, model, upstream) {
  const issues = [];
  for (const [clientName, protocol] of Object.entries(CLIENT_COMPATIBILITY_PROTOCOLS)) {
    if (config?.compatibility?.[clientName]?.enabled === false) continue;
    if (model?.clientCompatibility?.[clientName] !== true) continue;
    if (!isPublicRouteEnabled(config, protocol.routeKey)) {
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" is marked for ${protocol.label} but public route ${protocol.routeKey} is disabled`
      ));
      continue;
    }
    try {
      const target = buildValidationTarget(model, upstream, protocol.routeKey);
      if (target.backendRouteKey !== protocol.routeKey) {
        issues.push(buildStaticIssue(
          model,
          `model "${model.id}" is marked for ${protocol.label} but ${protocol.routeKey} resolves to ${target.backendRouteKey}; native ${protocol.routeKey} is required`
        ));
      }
    } catch (error) {
      issues.push(buildStaticIssue(
        model,
        `model "${model.id}" is marked for ${protocol.label} but has no usable native ${protocol.routeKey} route: ${error?.message || "route resolution failed"}`
      ));
    }
  }
  return issues;
}

export function getConfiguredModelBindingIssues(config) {
  const issues = [];
  for (const model of Array.isArray(config?.models) ? config.models : []) {
    if (!model?.id || isDisabledStatus(model?.status)) continue;

    const upstream = findUpstream(config, model.upstream);
    if (!upstream) {
      issues.push(buildStaticIssue(model, `model \"${model.id}\" references unknown upstream \"${model.upstream}\"`));
      continue;
    }
    if (isDisabledStatus(upstream?.status)) {
      issues.push(buildStaticIssue(model, `model \"${model.id}\" is bound to disabled upstream \"${upstream.name}\"`));
    }

    issues.push(...getClientCompatibilityIssues(config, model, upstream));

    const definition = findPricingDefinitionForModel(model);
    const definitionProvider = normalizeProvider(definition?.provider);
    try {
      const target = buildValidationTarget(model, upstream, inferValidationRouteKey(model, definition));
      if (
        definitionProvider === "black-forest-labs"
        && !isBlackForestLabsProviderPath(target.targetUrl)
      ) {
        issues.push(buildStaticIssue(
          model,
          `model \"${model.id}\" requires a /providers/blackforestlabs/v1/... route, but currently resolves to \"${target.targetUrl}\"`
        ));
      }
    } catch (error) {
      issues.push(buildStaticIssue(model, `model \"${model.id}\" has no usable upstream route: ${error?.message || "route resolution failed"}`));
    }
  }
  return issues;
}

function buildStaticResultItem(config, model) {
  const definition = findPricingDefinitionForModel(model);
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
    const target = buildValidationTarget(model, upstream, inferValidationRouteKey(model, definition));
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

  const target = buildValidationTarget(model, upstream, item.routeKey || inferValidationRouteKey(model, findPricingDefinitionForModel(model)));
  const payload = buildValidationPayload(target);
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