import crypto from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { LogsIngestionClient } from "@azure/monitor-ingestion";
import { request } from "undici";
import {
  buildLogAnalyticsRecord,
  LOG_ANALYTICS_COLUMNS,
  LOG_ANALYTICS_SCHEMA_VERSION
} from "./logs.js";

const ARM_ORIGIN = "https://management.azure.com";
const ARM_SCOPE = `${ARM_ORIGIN}/.default`;
const API_VERSIONS = {
  workspace: "2023-09-01",
  table: "2023-09-01",
  dce: "2024-03-11",
  dcr: "2024-03-11",
  permissions: "2022-04-01"
};
const MANAGED_TAG = "aoai-proxy-managed";
const SCHEMA_TAG = "aoai-proxy-schema";
const INGESTION_HOST_SUFFIX = ".ingest.monitor.azure.com";
const ARM_POLL_INTERVAL_MS = 1000;
const ARM_MAX_POLL_ATTEMPTS = 600;

class InitializationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "InitializationError";
    this.code = code;
    this.statusCode = options.statusCode || 400;
    this.details = options.details || null;
  }
}

function normalizeError(error) {
  return {
    code: error?.code || error?.name || "LOG_ANALYTICS_INITIALIZATION_FAILED",
    statusCode: Number(error?.statusCode) || 500,
    message: String(error?.message || error || "Log Analytics initialization failed").slice(0, 2000)
  };
}

function normalizeLocation(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseAzureResourceId(value, expectedProvider, expectedType) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  const segments = text.split("/").filter(Boolean).map(decodeSegment);
  const subscriptionIndex = segments.findIndex((segment) => segment.toLowerCase() === "subscriptions");
  const resourceGroupIndex = segments.findIndex((segment) => segment.toLowerCase() === "resourcegroups");
  const providerIndex = segments.findIndex((segment) => segment.toLowerCase() === "providers");
  if (subscriptionIndex !== 0 || resourceGroupIndex !== 2 || providerIndex !== 4 || segments.length !== 8) {
    throw new InitializationError("INVALID_AZURE_RESOURCE_ID", `Invalid Azure resource ID for ${expectedType}`);
  }
  const provider = segments[providerIndex + 1];
  const resourceType = segments[providerIndex + 2];
  if (provider.toLowerCase() !== expectedProvider.toLowerCase() || resourceType.toLowerCase() !== expectedType.toLowerCase()) {
    throw new InitializationError("INVALID_AZURE_RESOURCE_TYPE", `Expected ${expectedProvider}/${expectedType}`);
  }
  return {
    id: `/${segments.join("/")}`,
    subscriptionId: segments[1],
    resourceGroupName: segments[3],
    provider,
    resourceType,
    name: segments[7],
    resourceGroupId: `/subscriptions/${segments[1]}/resourceGroups/${segments[3]}`
  };
}

function normalizeTableName(value) {
  const requested = String(value || "AOAIProxyLogs_CL").trim();
  const tableName = requested.toLowerCase().endsWith("_cl") ? requested : `${requested}_CL`;
  if (!/^[A-Za-z0-9_-]{4,63}$/.test(tableName)) {
    throw new InitializationError("INVALID_TABLE_NAME", "Log Analytics table name must be 4-63 letters, numbers, hyphens, or underscores");
  }
  return tableName;
}

function normalizeDcrName(value) {
  const name = String(value || "aoai-proxy-logs").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new InitializationError("INVALID_DCR_NAME", "DCR name contains unsupported characters");
  }
  return name;
}

function normalizeStreamName(value, tableName) {
  const fallback = `Custom-${tableName.replace(/_CL$/i, "")}`;
  const streamName = String(value || fallback).trim();
  if (!/^Custom-[A-Za-z0-9._-]{1,120}$/.test(streamName)) {
    throw new InitializationError("INVALID_STREAM_NAME", "DCR stream name must start with Custom-");
  }
  return streamName;
}

function validateIngestionEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(String(value || ""));
  } catch {
    throw new InitializationError("INVALID_DCE_ENDPOINT", "DCE does not expose a valid logs ingestion endpoint");
  }
  if (endpoint.protocol !== "https:" || !endpoint.hostname.toLowerCase().endsWith(INGESTION_HOST_SUFFIX)) {
    throw new InitializationError("INVALID_DCE_ENDPOINT", "DCE logs ingestion endpoint must use the Azure Monitor public ingestion domain");
  }
  return endpoint.origin;
}

function buildArmUrl(resourceId, apiVersion) {
  const url = new URL(`${ARM_ORIGIN}${resourceId}`);
  url.searchParams.set("api-version", apiVersion);
  return url.toString();
}

function assertArmUrl(value) {
  const url = new URL(value, ARM_ORIGIN);
  if (url.origin !== ARM_ORIGIN) {
    throw new InitializationError("INVALID_ARM_OPERATION_URL", "Azure operation URL must target management.azure.com");
  }
  return url.toString();
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "").trim();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function armOperationState(body) {
  return String(body?.status || body?.properties?.provisioningState || "").trim().toLowerCase();
}

function retryDelayMs(response, fallbackMs) {
  const seconds = Number(responseHeader(response, "retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createArmRequest(credential) {
  let cachedToken = null;
  return async ({ method = "GET", url, body }) => {
    const target = assertArmUrl(url);
    if (!cachedToken || !cachedToken.expiresOnTimestamp || cachedToken.expiresOnTimestamp <= Date.now() + 60000) {
      cachedToken = await credential.getToken(ARM_SCOPE);
    }
    const response = await request(target, {
      method,
      headers: {
        authorization: `Bearer ${cachedToken.token}`,
        accept: "application/json",
        ...(body == null ? {} : { "content-type": "application/json" })
      },
      body: body == null ? undefined : JSON.stringify(body),
      headersTimeout: 30000,
      bodyTimeout: 60000
    });
    const text = await response.body.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text ? { message: text.slice(0, 2000) } : null;
    }
    return { status: response.statusCode, headers: response.headers || {}, body: parsed };
  };
}

async function armCall(armRequest, method, resourceId, apiVersion, body) {
  return armRequest({ method, url: buildArmUrl(resourceId, apiVersion), body });
}

function armError(response, code, fallbackMessage) {
  const details = response?.body?.error || response?.body || null;
  const message = details?.message || fallbackMessage;
  return new InitializationError(details?.code || code, message, {
    statusCode: response?.status || 502,
    details
  });
}

function requireSuccess(response, code, message, allowed = [200, 201, 202]) {
  if (!allowed.includes(response?.status)) throw armError(response, code, message);
  return response;
}

async function waitForArmWrite(armRequest, initialResponse, resourceId, apiVersion, options = {}) {
  const operationHeader = responseHeader(initialResponse, "azure-asyncoperation") || responseHeader(initialResponse, "location");
  const initialState = armOperationState(initialResponse?.body);
  const runningStates = new Set(["accepted", "creating", "inprogress", "running", "updating"]);
  const failedStates = new Set(["canceled", "cancelled", "failed"]);
  if (initialResponse?.status !== 202 && !operationHeader && !runningStates.has(initialState)) return initialResponse;

  const operationUrl = operationHeader ? assertArmUrl(operationHeader) : "";
  const sleep = options.sleep || delay;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? Math.max(0, options.pollIntervalMs) : ARM_POLL_INTERVAL_MS;
  const maxAttempts = Number.isInteger(options.maxAttempts) ? Math.max(1, options.maxAttempts) : ARM_MAX_POLL_ATTEMPTS;
  let previous = initialResponse;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(retryDelayMs(previous, pollIntervalMs));
    const polled = operationUrl
      ? await armRequest({ method: "GET", url: operationUrl })
      : await armCall(armRequest, "GET", resourceId, apiVersion);
    if (![200, 201, 202, 404].includes(polled?.status)) {
      throw armError(polled, "ARM_OPERATION_POLL_FAILED", "Unable to read Azure operation status");
    }

    const state = armOperationState(polled?.body);
    if (failedStates.has(state)) {
      const details = polled?.body?.error || polled?.body || null;
      throw new InitializationError(
        details?.code || "ARM_OPERATION_FAILED",
        details?.message || `Azure operation ended with status ${state}`,
        { statusCode: 502, details }
      );
    }
    const operationComplete = operationUrl
      ? state === "succeeded"
      : polled.status === 200 && !runningStates.has(state);
    if (operationComplete) {
      const resource = operationUrl
        ? await armCall(armRequest, "GET", resourceId, apiVersion)
        : polled;
      if (resource.status === 200) return resource;
      if (resource.status !== 404) throw armError(resource, "ARM_RESOURCE_READ_FAILED", "Unable to read completed Azure resource");
    }
    previous = polled;
  }

  throw new InitializationError("ARM_OPERATION_TIMEOUT", "Azure resource operation did not complete before the polling limit", { statusCode: 504 });
}

function wildcardMatches(pattern, action) {
  const escaped = String(pattern || "")
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(action);
}

function permissionAllows(permissionResult, action, dataAction = false) {
  for (const permission of permissionResult?.value || []) {
    const allowed = dataAction ? permission.dataActions || [] : permission.actions || [];
    const denied = dataAction ? permission.notDataActions || [] : permission.notActions || [];
    if (allowed.some((pattern) => wildcardMatches(pattern, action)) && !denied.some((pattern) => wildcardMatches(pattern, action))) {
      return true;
    }
  }
  return false;
}

async function readPermissions(armRequest, scopeId) {
  const permissionId = `${scopeId}/providers/Microsoft.Authorization/permissions`;
  const response = await armCall(armRequest, "GET", permissionId, API_VERSIONS.permissions);
  if (response.status !== 200) {
    return { status: "unknown", actions: {}, error: normalizeError(armError(response, "PERMISSION_CHECK_FAILED", "Unable to read effective Azure permissions")) };
  }
  return { status: "available", result: response.body || { value: [] } };
}

function tableColumn(column) {
  return {
    name: column.name,
    type: column.type === "datetime" ? "dateTime" : column.type,
    description: `${column.name} generated by AOAI Proxy`
  };
}

function normalizedColumnType(value) {
  return String(value || "").toLowerCase() === "datetime" ? "datetime" : String(value || "").toLowerCase();
}

async function reconcileTable(armRequest, workspace, tableName, armPolling) {
  const tableId = `${workspace.id}/tables/${tableName}`;
  const current = await armCall(armRequest, "GET", tableId, API_VERSIONS.table);
  if (![200, 404].includes(current.status)) throw armError(current, "TABLE_READ_FAILED", "Unable to read Log Analytics table");

  const existingSchema = current.body?.properties?.schema || {};
  const tableType = String(existingSchema.tableType || current.body?.properties?.tableType || "").toLowerCase();
  const tableSubType = String(existingSchema.tableSubType || current.body?.properties?.tableSubType || "").toLowerCase();
  if (current.status === 200 && tableType && tableType !== "customlog") {
    throw new InitializationError("TABLE_TYPE_CONFLICT", `${tableName} is not a custom log table`, { statusCode: 409 });
  }
  if (current.status === 200 && tableSubType && tableSubType !== "datacollectionrulebased") {
    throw new InitializationError("TABLE_SUBTYPE_CONFLICT", `${tableName} is not DCR-based`, { statusCode: 409 });
  }

  const existingColumns = Array.isArray(existingSchema.columns) ? existingSchema.columns : [];
  const standardColumns = Array.isArray(existingSchema.standardColumns) ? existingSchema.standardColumns : [];
  const knownColumns = new Map([...existingColumns, ...standardColumns].map((column) => [String(column.name).toLowerCase(), column]));
  const missing = [];
  for (const required of LOG_ANALYTICS_COLUMNS) {
    const existing = knownColumns.get(required.name.toLowerCase());
    if (!existing) {
      missing.push(tableColumn(required));
      continue;
    }
    if (normalizedColumnType(existing.type) !== normalizedColumnType(required.type)) {
      throw new InitializationError("TABLE_SCHEMA_CONFLICT", `Column ${required.name} has type ${existing.type}, expected ${required.type}`, { statusCode: 409 });
    }
  }
  if (current.status === 200 && missing.length === 0) {
    return { id: tableId, action: "verified", addedColumns: [] };
  }

  const properties = {
    schema: {
      name: tableName,
      columns: current.status === 404 ? LOG_ANALYTICS_COLUMNS.map(tableColumn) : [...existingColumns, ...missing]
    }
  };
  for (const key of ["plan", "retentionInDays", "totalRetentionInDays"]) {
    if (current.body?.properties?.[key] != null) properties[key] = current.body.properties[key];
  }
  const updated = await armCall(armRequest, "PUT", tableId, API_VERSIONS.table, { properties });
  requireSuccess(updated, "TABLE_WRITE_FAILED", "Unable to create or update Log Analytics table");
  await waitForArmWrite(armRequest, updated, tableId, API_VERSIONS.table, armPolling);
  return { id: tableId, action: current.status === 404 ? "created" : "updated", addedColumns: missing.map((column) => column.name) };
}

function dcrBody({ workspaceId, dceId, location, streamName, tableName, tags = {} }) {
  return {
    location,
    kind: "Direct",
    tags: {
      ...tags,
      [MANAGED_TAG]: "true",
      [SCHEMA_TAG]: String(LOG_ANALYTICS_SCHEMA_VERSION)
    },
    properties: {
      description: "Direct Logs Ingestion rule managed by AOAI Proxy",
      dataCollectionEndpointId: dceId,
      streamDeclarations: {
        [streamName]: {
          columns: LOG_ANALYTICS_COLUMNS.map(({ name, type }) => ({ name, type }))
        }
      },
      destinations: {
        logAnalytics: [{ name: "workspace", workspaceResourceId: workspaceId }]
      },
      dataFlows: [{
        streams: [streamName],
        destinations: ["workspace"],
        transformKql: "source",
        outputStream: `Custom-${tableName}`
      }]
    }
  };
}

function isSameResourceId(left, right) {
  return String(left || "").replace(/\/+$/, "").toLowerCase() === String(right || "").replace(/\/+$/, "").toLowerCase();
}

async function reconcileDcr(armRequest, options, armPolling) {
  const dcrId = `${options.dce.resourceGroupId}/providers/Microsoft.Insights/dataCollectionRules/${options.dcrName}`;
  const current = await armCall(armRequest, "GET", dcrId, API_VERSIONS.dcr);
  if (![200, 404].includes(current.status)) throw armError(current, "DCR_READ_FAILED", "Unable to read data collection rule");
  if (current.status === 200) {
    if (String(current.body?.tags?.[MANAGED_TAG] || "").toLowerCase() !== "true") {
      throw new InitializationError("DCR_OWNERSHIP_CONFLICT", `${options.dcrName} exists but is not managed by AOAI Proxy`, { statusCode: 409 });
    }
    const currentDce = current.body?.properties?.dataCollectionEndpointId;
    const destinations = current.body?.properties?.destinations?.logAnalytics || [];
    if (!isSameResourceId(currentDce, options.dce.id) || !destinations.some((item) => isSameResourceId(item.workspaceResourceId, options.workspace.id))) {
      throw new InitializationError("DCR_TARGET_CONFLICT", `${options.dcrName} targets a different DCE or workspace`, { statusCode: 409 });
    }
  }
  const updated = await armCall(armRequest, "PUT", dcrId, API_VERSIONS.dcr, dcrBody({
    workspaceId: options.workspace.id,
    dceId: options.dce.id,
    location: options.location,
    streamName: options.streamName,
    tableName: options.tableName,
    tags: current.body?.tags
  }));
  requireSuccess(updated, "DCR_WRITE_FAILED", "Unable to create or update data collection rule");
  const completed = await waitForArmWrite(armRequest, updated, dcrId, API_VERSIONS.dcr, armPolling);
  const resource = completed.body || current.body || {};
  const immutableId = String(resource?.properties?.immutableId || "").trim();
  if (!immutableId.startsWith("dcr-")) {
    throw new InitializationError("DCR_IMMUTABLE_ID_MISSING", "Azure did not return a DCR immutable ID", { statusCode: 502 });
  }
  return { id: dcrId, immutableId, action: current.status === 404 ? "created" : "updated" };
}

function buildProbeRecord(requestId, workspaceId, tableName) {
  const ts = new Date().toISOString();
  return buildLogAnalyticsRecord({
    ts,
    level: "info",
    event: "loganalytics.initialization_probe",
    message: "Log Analytics initialization probe",
    source: "admin",
    requestId,
    conversationId: requestId,
    sessionId: requestId,
    azureRequestId: "",
    consumerKeyId: "",
    modelId: "",
    actualModelName: "",
    routeKey: "",
    backendRouteKey: "",
    stream: false,
    attempt: 1,
    status: 200,
    errorCode: "",
    failureReason: "",
    latencyMs: 0,
    clientIp: "",
    userAgent: "",
    forwardedFor: "",
    usageAvailable: false,
    currency: "",
    requestPreview: "",
    responsePreview: "",
    requestBodyJson: "",
    responseBodyJson: "",
    requestTruncated: false,
    responseTruncated: false,
    requestMessageCount: 0,
    requestToolCount: 0,
    requestItemCount: 0,
    responseMessageCount: 0,
    responseToolCount: 0,
    responseItemCount: 0,
    fields: { probe: true }
  }, {
    contentMode: "summary",
    maxPayloadLogBytes: 102400,
    workspaceId,
    tableName
  });
}

function createCredential(input) {
  const clientId = input.credentialRef ? String(process.env[input.credentialRef] || "").trim() : "";
  return new DefaultAzureCredential(clientId ? { managedIdentityClientId: clientId } : {});
}

async function defaultUploadProbe({ credential, endpoint, immutableId, streamName, record, audience }) {
  const client = new LogsIngestionClient(endpoint, credential, audience ? { audience } : {});
  await client.upload(immutableId, streamName, [record]);
}

function phaseRunner(phases) {
  return async (name, operation) => {
    const phase = { name, status: "pending" };
    phases.push(phase);
    try {
      const value = await operation();
      phase.status = value?.status === "unknown" || value?.status === "missing"
        ? value.status
        : "succeeded";
      phase.details = value?.details || null;
      return value;
    } catch (error) {
      phase.status = "failed";
      phase.error = normalizeError(error);
      throw error;
    }
  };
}

export async function initializeLogAnalytics(input = {}, dependencies = {}) {
  const phases = [];
  const runPhase = phaseRunner(phases);
  let context = null;
  let table = null;
  let dcr = null;
  let managementPermissions = null;
  const probeRequestId = `loganalytics-init-${crypto.randomUUID()}`;

  try {
    context = await runPhase("validate", async () => {
      const workspace = parseAzureResourceId(input.workspaceResourceId, "Microsoft.OperationalInsights", "workspaces");
      const dce = parseAzureResourceId(input.dataCollectionEndpointResourceId, "Microsoft.Insights", "dataCollectionEndpoints");
      const tableName = normalizeTableName(input.tableName);
      return {
        workspace,
        dce,
        tableName,
        streamName: normalizeStreamName(input.streamName, tableName),
        dcrName: normalizeDcrName(input.dataCollectionRuleName),
        details: { workspaceResourceId: workspace.id, dataCollectionEndpointResourceId: dce.id, tableName }
      };
    });

    const credential = dependencies.credential || createCredential(input);
    const armRequest = dependencies.armRequest || createArmRequest(credential);
    const armPolling = {
      sleep: dependencies.sleep
    };

    const discovered = await runPhase("resources", async () => {
      const [workspaceResponse, dceResponse] = await Promise.all([
        armCall(armRequest, "GET", context.workspace.id, API_VERSIONS.workspace),
        armCall(armRequest, "GET", context.dce.id, API_VERSIONS.dce)
      ]);
      requireSuccess(workspaceResponse, "WORKSPACE_READ_FAILED", "Unable to read Log Analytics workspace", [200]);
      requireSuccess(dceResponse, "DCE_READ_FAILED", "Unable to read data collection endpoint", [200]);
      const workspaceLocation = normalizeLocation(workspaceResponse.body?.location);
      const dceLocation = normalizeLocation(dceResponse.body?.location);
      if (!workspaceLocation || workspaceLocation !== dceLocation) {
        throw new InitializationError("AZURE_MONITOR_REGION_MISMATCH", "Workspace and DCE must be in the same Azure region", { statusCode: 409 });
      }
      const publicAccess = String(dceResponse.body?.properties?.networkAcls?.publicNetworkAccess || "Enabled").toLowerCase();
      if (publicAccess !== "enabled") {
        throw new InitializationError("DCE_PUBLIC_ACCESS_DISABLED", "The selected DCE does not allow public network ingestion", { statusCode: 409 });
      }
      const endpoint = validateIngestionEndpoint(dceResponse.body?.properties?.logsIngestion?.endpoint);
      const workspaceId = String(workspaceResponse.body?.properties?.customerId || "").trim();
      if (!workspaceId) throw new InitializationError("WORKSPACE_CUSTOMER_ID_MISSING", "Workspace customer ID is missing", { statusCode: 502 });
      return { workspaceId, endpoint, location: workspaceResponse.body.location, details: { workspaceId, endpoint, location: workspaceResponse.body.location } };
    });

    managementPermissions = await runPhase("management_permissions", async () => {
      const [workspacePermissions, dcePermissions] = await Promise.all([
        readPermissions(armRequest, context.workspace.id),
        readPermissions(armRequest, context.dce.resourceGroupId)
      ]);
      if (workspacePermissions.status === "unknown" || dcePermissions.status === "unknown") {
        return { status: "unknown", details: { workspace: workspacePermissions.status, dce: dcePermissions.status } };
      }
      const checks = {
        tableRead: permissionAllows(workspacePermissions.result, "Microsoft.OperationalInsights/workspaces/tables/read"),
        tableWrite: permissionAllows(workspacePermissions.result, "Microsoft.OperationalInsights/workspaces/tables/write"),
        dceRead: permissionAllows(dcePermissions.result, "Microsoft.Insights/dataCollectionEndpoints/read"),
        dcrRead: permissionAllows(dcePermissions.result, "Microsoft.Insights/dataCollectionRules/read"),
        dcrWrite: permissionAllows(dcePermissions.result, "Microsoft.Insights/dataCollectionRules/write")
      };
      return { status: Object.values(checks).every(Boolean) ? "available" : "missing", checks, details: checks };
    });

    table = await runPhase("table", async () => {
      const result = await reconcileTable(armRequest, context.workspace, context.tableName, armPolling);
      return { ...result, details: result };
    });

    dcr = await runPhase("dcr", async () => {
      const result = await reconcileDcr(armRequest, {
        workspace: context.workspace,
        dce: context.dce,
        location: discovered.location,
        dcrName: context.dcrName,
        streamName: context.streamName,
        tableName: context.tableName
      }, armPolling);
      return { ...result, details: result };
    });

    const ingestionPermission = await runPhase("ingestion_permission", async () => {
      const permissions = await readPermissions(armRequest, dcr.id);
      if (permissions.status === "unknown") return { status: "unknown", allowed: null, details: { allowed: null } };
      const allowed = permissionAllows(permissions.result, "Microsoft.Insights/Telemetry/Write", true);
      return { status: allowed ? "available" : "missing", allowed, details: { allowed } };
    });

    const probeRecord = buildProbeRecord(probeRequestId, discovered.workspaceId, context.tableName);
    try {
      await runPhase("probe", async () => {
        await (dependencies.uploadProbe || defaultUploadProbe)({
          credential,
          endpoint: discovered.endpoint,
          immutableId: dcr.immutableId,
          streamName: context.streamName,
          record: probeRecord,
          audience: input.audience
        });
        return { details: { requestId: probeRequestId, uploaded: true } };
      });
    } catch (error) {
      const normalized = normalizeError(error);
      const permissionFailure = normalized.statusCode === 401 || normalized.statusCode === 403 || ingestionPermission.allowed === false;
      return {
        ok: false,
        status: permissionFailure ? "needs_ingestion_permission" : "probe_failed",
        phases,
        permissions: { management: managementPermissions, ingestion: ingestionPermission },
        resources: { table, dcr },
        probe: { requestId: probeRequestId, uploaded: false },
        error: normalized,
        ...(permissionFailure ? {
          requiredRole: {
            name: "Monitoring Metrics Publisher",
            roleDefinitionId: "3913510d-42f4-4e42-8a64-420c390055eb",
            scope: dcr.id,
            dataAction: "Microsoft.Insights/Telemetry/Write"
          }
        } : {}),
        suggestedConfig: {
          enabled: false,
          workspaceResourceId: context.workspace.id,
          dataCollectionEndpointResourceId: context.dce.id,
          dataCollectionRuleName: context.dcrName,
          dataCollectionRuleResourceId: dcr.id,
          workspaceId: discovered.workspaceId,
          endpoint: discovered.endpoint,
          dcrImmutableId: dcr.immutableId,
          streamName: context.streamName,
          tableName: context.tableName
        }
      };
    }

    return {
      ok: true,
      status: "initialized",
      phases,
      permissions: { management: managementPermissions, ingestion: ingestionPermission },
      resources: { table, dcr },
      probe: { requestId: probeRequestId, uploaded: true },
      suggestedConfig: {
        enabled: true,
        workspaceResourceId: context.workspace.id,
        dataCollectionEndpointResourceId: context.dce.id,
        dataCollectionRuleName: context.dcrName,
        dataCollectionRuleResourceId: dcr.id,
        workspaceId: discovered.workspaceId,
        endpoint: discovered.endpoint,
        dcrImmutableId: dcr.immutableId,
        streamName: context.streamName,
        tableName: context.tableName
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      phases,
      permissions: managementPermissions,
      resources: { table, dcr },
      probe: { requestId: probeRequestId, uploaded: false },
      error: normalizeError(error)
    };
  }
}