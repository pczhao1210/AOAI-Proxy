import assert from "node:assert/strict";
import test from "node:test";
import { initializeLogAnalytics } from "../src/log-analytics-admin.js";
import { LOG_ANALYTICS_COLUMNS } from "../src/logs.js";

const workspaceId = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/logs-rg/providers/Microsoft.OperationalInsights/workspaces/proxy-logs";
const dceId = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/logs-rg/providers/Microsoft.Insights/dataCollectionEndpoints/proxy-dce";

function createArmFixture({
  existingDcr = null,
  existingTable = null,
  workspaceLocation = "eastus",
  dceLocation = "eastus",
  publicNetworkAccess = "Enabled",
  permissionResponse = null
} = {}) {
  const calls = [];
  const armRequest = async ({ method, url, body }) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    calls.push({ method, path, body });
    if (path === workspaceId && method === "GET") {
      return { status: 200, headers: {}, body: { id: workspaceId, location: workspaceLocation, properties: { customerId: "workspace-customer-id" } } };
    }
    if (path === dceId && method === "GET") {
      return {
        status: 200,
        headers: {},
        body: {
          id: dceId,
          location: dceLocation,
          properties: {
            networkAcls: { publicNetworkAccess },
            logsIngestion: { endpoint: "https://proxy-dce.eastus-1.ingest.monitor.azure.com" }
          }
        }
      };
    }
    if (path.endsWith("/providers/Microsoft.Authorization/permissions") && method === "GET") {
      if (typeof permissionResponse === "function") return permissionResponse({ path });
      if (permissionResponse) return permissionResponse;
      return {
        status: 200,
        headers: {},
        body: { value: [{ actions: ["*"], notActions: [], dataActions: ["Microsoft.Insights/Telemetry/Write"], notDataActions: [] }] }
      };
    }
    if (path.endsWith("/tables/AOAIProxyLogs_CL") && method === "GET") {
      return existingTable
        ? { status: 200, headers: {}, body: existingTable }
        : { status: 404, headers: {}, body: { error: { code: "NotFound" } } };
    }
    if (path.endsWith("/tables/AOAIProxyLogs_CL") && method === "PUT") {
      return { status: 200, headers: {}, body: { id: path, properties: { provisioningState: "Succeeded" } } };
    }
    if (path.endsWith("/dataCollectionRules/aoai-proxy-logs") && method === "GET") {
      return existingDcr
        ? { status: 200, headers: {}, body: existingDcr }
        : { status: 404, headers: {}, body: { error: { code: "NotFound" } } };
    }
    if (path.endsWith("/dataCollectionRules/aoai-proxy-logs") && method === "PUT") {
      return {
        status: 201,
        headers: {},
        body: { id: path, tags: body.tags, properties: { ...body.properties, immutableId: "dcr-test-immutable" } }
      };
    }
    throw new Error(`Unexpected ARM call: ${method} ${path}`);
  };
  return { calls, armRequest };
}

test("initialization creates the custom table and Direct DCR before uploading a probe", async () => {
  const fixture = createArmFixture();
  let uploaded = null;
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    dataCollectionRuleName: "aoai-proxy-logs",
    tableName: "AOAIProxyLogs",
    streamName: "Custom-AOAIProxyLogs"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async (value) => { uploaded = value; }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "initialized");
  assert.equal(result.suggestedConfig.tableName, "AOAIProxyLogs_CL");
  assert.equal(result.suggestedConfig.dcrImmutableId, "dcr-test-immutable");
  assert.equal(result.suggestedConfig.enabled, true);
  assert.equal(uploaded.endpoint, "https://proxy-dce.eastus-1.ingest.monitor.azure.com");
  assert.equal(uploaded.record.Event, "loganalytics.initialization_probe");
  assert.equal(uploaded.record.RequestId, result.probe.requestId);

  const tablePut = fixture.calls.find((call) => call.method === "PUT" && call.path.includes("/tables/"));
  const dcrPut = fixture.calls.find((call) => call.method === "PUT" && call.path.includes("/dataCollectionRules/"));
  assert.equal(tablePut.body.properties.schema.columns.length, LOG_ANALYTICS_COLUMNS.length);
  assert.equal(dcrPut.body.kind, "Direct");
  assert.equal(dcrPut.body.properties.dataCollectionEndpointId, dceId);
  assert.equal(dcrPut.body.properties.destinations.logAnalytics[0].workspaceResourceId, workspaceId);
  assert.equal(dcrPut.body.properties.dataFlows[0].outputStream, "Custom-AOAIProxyLogs_CL");
  assert.equal(dcrPut.body.properties.streamDeclarations["Custom-AOAIProxyLogs"].columns.length, LOG_ANALYTICS_COLUMNS.length);
  assert.deepEqual(result.phases.map((phase) => phase.name), [
    "validate",
    "resources",
    "management_permissions",
    "table",
    "dcr",
    "ingestion_permission",
    "probe"
  ]);
});

test("initialization refuses to overwrite an existing unowned DCR", async () => {
  const fixture = createArmFixture({
    existingDcr: {
      id: "existing",
      location: "eastus",
      tags: {},
      properties: {
        dataCollectionEndpointId: dceId,
        destinations: { logAnalytics: [{ workspaceResourceId: workspaceId }] },
        immutableId: "dcr-existing"
      }
    }
  });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    dataCollectionRuleName: "aoai-proxy-logs",
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => { throw new Error("probe should not run"); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DCR_OWNERSHIP_CONFLICT");
  assert.equal(fixture.calls.some((call) => call.method === "PUT" && call.path.includes("/dataCollectionRules/")), false);
});

test("initialization adds only missing columns to an existing DCR-based custom table", async () => {
  const existingColumns = LOG_ANALYTICS_COLUMNS.slice(0, -1).map(({ name, type }) => ({ name, type }));
  const fixture = createArmFixture({
    existingTable: {
      properties: {
        schema: {
          name: "AOAIProxyLogs_CL",
          tableType: "CustomLog",
          tableSubType: "DataCollectionRuleBased",
          columns: existingColumns
        },
        retentionInDays: 30
      }
    }
  });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.resources.table.action, "updated");
  assert.deepEqual(result.resources.table.addedColumns, [LOG_ANALYTICS_COLUMNS.at(-1).name]);
  const tablePut = fixture.calls.find((call) => call.method === "PUT" && call.path.includes("/tables/"));
  assert.equal(tablePut.body.properties.schema.columns.length, LOG_ANALYTICS_COLUMNS.length);
  assert.equal(tablePut.body.properties.retentionInDays, 30);
});

test("initialization stops before writes when an existing table column type conflicts", async () => {
  const fixture = createArmFixture({
    existingTable: {
      properties: {
        schema: {
          tableType: "CustomLog",
          tableSubType: "DataCollectionRuleBased",
          columns: [{ name: LOG_ANALYTICS_COLUMNS[0].name, type: "string" }]
        }
      }
    }
  });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => { throw new Error("probe should not run"); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TABLE_SCHEMA_CONFLICT");
  assert.equal(fixture.calls.some((call) => call.method === "PUT"), false);
});

test("initialization reconciles an existing AOAI Proxy-managed DCR", async () => {
  const fixture = createArmFixture({
    existingDcr: {
      id: `${dceId}/../dataCollectionRules/aoai-proxy-logs`,
      location: "eastus",
      tags: { "aoai-proxy-managed": "true", costCenter: "shared-ai" },
      properties: {
        dataCollectionEndpointId: dceId,
        destinations: { logAnalytics: [{ workspaceResourceId: workspaceId }] },
        immutableId: "dcr-existing"
      }
    }
  });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.resources.dcr.action, "updated");
  assert.equal(fixture.calls.filter((call) => call.method === "PUT" && call.path.includes("/dataCollectionRules/")).length, 1);
  const dcrPut = fixture.calls.find((call) => call.method === "PUT" && call.path.includes("/dataCollectionRules/"));
  assert.equal(dcrPut.body.tags.costCenter, "shared-ai");
  const workspacePermissionRead = fixture.calls.find((call) => call.method === "GET" && call.path.endsWith("/workspaces/proxy-logs/providers/Microsoft.Authorization/permissions"));
  assert.ok(workspacePermissionRead);
});

test("initialization rejects region mismatch and disabled public DCE access before resource writes", async (t) => {
  const cases = [
    { name: "region mismatch", fixture: { dceLocation: "westus" }, code: "AZURE_MONITOR_REGION_MISMATCH" },
    { name: "public access disabled", fixture: { publicNetworkAccess: "Disabled" }, code: "DCE_PUBLIC_ACCESS_DISABLED" }
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = createArmFixture(item.fixture);
      const result = await initializeLogAnalytics({
        workspaceResourceId: workspaceId,
        dataCollectionEndpointResourceId: dceId,
        tableName: "AOAIProxyLogs_CL"
      }, {
        credential: {},
        armRequest: fixture.armRequest,
        uploadProbe: async () => { throw new Error("probe should not run"); }
      });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, item.code);
      assert.equal(fixture.calls.some((call) => call.method === "PUT"), false);
    });
  }
});

test("initialization continues when effective permission inspection is unavailable", async () => {
  const fixture = createArmFixture({
    permissionResponse: { status: 403, headers: {}, body: { error: { code: "AuthorizationFailed", message: "permissions/read denied" } } }
  });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.phases.find((phase) => phase.name === "management_permissions").status, "unknown");
  assert.equal(result.phases.find((phase) => phase.name === "ingestion_permission").status, "unknown");
});

test("initialization returns the exact DCR role scope when ingestion permission is missing", async () => {
  const fixture = createArmFixture({
    permissionResponse: ({ path }) => ({
      status: 200,
      headers: {},
      body: {
        value: [{
          actions: ["*"],
          notActions: [],
          dataActions: path.includes("/dataCollectionRules/") ? [] : ["Microsoft.Insights/Telemetry/Write"],
          notDataActions: []
        }]
      }
    })
  });
  const permissionError = Object.assign(new Error("Telemetry write denied"), { statusCode: 403, code: "AuthorizationFailed" });
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => { throw permissionError; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "needs_ingestion_permission");
  assert.equal(result.phases.find((phase) => phase.name === "ingestion_permission").status, "missing");
  assert.equal(result.requiredRole.name, "Monitoring Metrics Publisher");
  assert.match(result.requiredRole.scope, /\/dataCollectionRules\/aoai-proxy-logs$/);
  assert.equal(result.suggestedConfig.enabled, false);
});

test("initialization does not recommend an RBAC role for a non-permission probe failure", async () => {
  const fixture = createArmFixture();
  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: fixture.armRequest,
    uploadProbe: async () => { throw Object.assign(new Error("ingestion service unavailable"), { statusCode: 503 }); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "probe_failed");
  assert.equal("requiredRole" in result, false);
});

test("initialization waits for asynchronous ARM writes before reading the DCR immutable ID", async () => {
  const fixture = createArmFixture();
  let dcrReadCount = 0;
  let operationReadCount = 0;
  const baseArmRequest = fixture.armRequest;
  fixture.armRequest = async (request) => {
    const parsed = new URL(request.url);
    if (parsed.pathname.endsWith("/dataCollectionRules/aoai-proxy-logs") && request.method === "GET") {
      dcrReadCount += 1;
      if (dcrReadCount > 1) {
        return {
          status: 200,
          headers: {},
          body: {
            id: parsed.pathname,
            tags: { "aoai-proxy-managed": "true" },
            properties: {
              dataCollectionEndpointId: dceId,
              destinations: { logAnalytics: [{ workspaceResourceId: workspaceId }] },
              immutableId: "dcr-async-immutable"
            }
          }
        };
      }
    }
    if (parsed.pathname.endsWith("/dataCollectionRules/aoai-proxy-logs") && request.method === "PUT") {
      return {
        status: 202,
        headers: { "azure-asyncoperation": "https://management.azure.com/providers/Microsoft.Insights/operations/test?api-version=2024-03-11", "retry-after": "0" },
        body: { status: "Accepted" }
      };
    }
    if (parsed.pathname === "/providers/Microsoft.Insights/operations/test") {
      operationReadCount += 1;
      return { status: 200, headers: { "retry-after": "0" }, body: { status: operationReadCount === 1 ? "InProgress" : "Succeeded" } };
    }
    return baseArmRequest(request);
  };

  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    dataCollectionRuleName: "aoai-proxy-logs",
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: (request) => fixture.armRequest(request),
    sleep: async () => {},
    uploadProbe: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.suggestedConfig.dcrImmutableId, "dcr-async-immutable");
  assert.equal(operationReadCount, 2);
  assert.equal(dcrReadCount, 2);
});

test("initialization reports an asynchronous ARM business failure as a gateway error", async () => {
  const fixture = createArmFixture();
  const baseArmRequest = fixture.armRequest;
  fixture.armRequest = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/dataCollectionRules/aoai-proxy-logs") && request.method === "PUT") {
      return {
        status: 202,
        headers: { "azure-asyncoperation": "https://management.azure.com/providers/Microsoft.Insights/operations/failed?api-version=2024-03-11", "retry-after": "0" },
        body: { status: "Accepted" }
      };
    }
    if (path === "/providers/Microsoft.Insights/operations/failed") {
      return {
        status: 200,
        headers: {},
        body: { status: "Failed", error: { code: "DcrProvisioningFailed", message: "DCR provisioning failed" } }
      };
    }
    return baseArmRequest(request);
  };

  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: (request) => fixture.armRequest(request),
    sleep: async () => {},
    uploadProbe: async () => { throw new Error("probe should not run"); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DcrProvisioningFailed");
  assert.equal(result.error.statusCode, 502);
  assert.equal(result.phases.find((phase) => phase.name === "dcr").status, "failed");
});

test("initialization refuses an ARM operation URL outside management.azure.com", async () => {
  const fixture = createArmFixture();
  const baseArmRequest = fixture.armRequest;
  fixture.armRequest = async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/dataCollectionRules/aoai-proxy-logs") && request.method === "PUT") {
      return {
        status: 202,
        headers: { "azure-asyncoperation": "https://example.invalid/steal-token", "retry-after": "0" },
        body: { status: "Accepted" }
      };
    }
    return baseArmRequest(request);
  };

  const result = await initializeLogAnalytics({
    workspaceResourceId: workspaceId,
    dataCollectionEndpointResourceId: dceId,
    tableName: "AOAIProxyLogs_CL"
  }, {
    credential: {},
    armRequest: (request) => fixture.armRequest(request),
    sleep: async () => {},
    uploadProbe: async () => { throw new Error("probe should not run"); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARM_OPERATION_URL");
  assert.equal(fixture.calls.some((call) => call.path === "/steal-token"), false);
});