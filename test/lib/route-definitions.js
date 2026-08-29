import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ensure } from "./harness.js";

export const routeTests = [
  {
    id: "version",
    description: "public build version metadata",
    async run(ctx) {
      const result = await ctx.request("/version");

      assert.equal(result.status, 200, result.text);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.equal(result.headers.get("x-aoai-proxy-profile"), "nextgen");
      assert.deepEqual(result.json, {
        service: "aoai-proxy",
        version: "nextgen-202608100000",
        buildTime: "2026-08-10T00:00:00Z"
      });
    }
  },
  {
    id: "request-body-limit",
    description: "chunked request bodies are bounded before normalization",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      config.proxy.guards.maxRequestBodyBytes = 1024;
      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(saved.status, 200, saved.text);

      const rawBody = JSON.stringify({
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "hello" }],
        discarded: Array.from({ length: 600 }, () => null)
      });
      ensure(Buffer.byteLength(rawBody) > 1024, "Expected oversized raw request fixture");

      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Readable.from([rawBody]),
        duplex: "half"
      });

      assert.equal(result.status, 413, result.text);
      assert.equal(ctx.upstreamRequests.length, 0, "Oversized raw request must not reach upstream");
    }
  },
  {
    id: "minimum-profile-boundaries",
    description: "minimum profile disables peripheral admin capabilities without disabling proxy routes",
    async run(ctx) {
      const loaded = await ctx.adminRequest("/admin/api/config");
      assert.equal(loaded.status, 200, loaded.text);
      loaded.json.distribution.profile = "minimum";
      loaded.json.observability.logAnalytics.enabled = true;
      loaded.json.observability.runtimeStore.enabled = true;
      loaded.json.access.budgets.enabled = true;

      const saved = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: loaded.json
      });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json.config.distribution.profile, "minimum");
      assert.equal(saved.json.config.observability.logAnalytics.enabled, false);
      assert.equal(saved.json.config.observability.runtimeStore.enabled, false);
      assert.equal(saved.json.config.access.budgets.enabled, false);

      const runtime = await ctx.adminRequest("/admin/api/runtime");
      assert.equal(runtime.status, 200, runtime.text);
      assert.equal(runtime.json.runtime.distribution.profile, "minimum");
      assert.equal(runtime.json.runtime.distribution.capabilities.databaseAdmin, false);
      assert.equal(runtime.json.runtime.distribution.capabilities.logAnalytics, false);
      assert.equal(runtime.json.runtime.distribution.capabilities.modelCatalog, true);
      assert.equal(runtime.json.runtime.distribution.capabilities.modelCatalogSync, true);

      for (const [route, method] of [
        ["/admin/api/database/config", "GET"],
        ["/admin/api/database/test", "POST"],
        ["/admin/api/log-analytics/initialize", "POST"]
      ]) {
        const result = await ctx.adminRequest(route, {
          method,
          headers: { "x-aoai-admin-csrf": "1" },
          ...(method === "POST" ? { json: {} } : {})
        });
        assert.equal(result.status, 404, `${route}: ${result.text}`);
        assert.equal(result.json.code, "DISTRIBUTION_FEATURE_DISABLED");
        assert.equal(result.json.profile, "minimum");
      }

      const pricing = await ctx.adminRequest("/admin/api/pricing-library");
      assert.equal(pricing.status, 200, pricing.text);
      const models = await ctx.publicRequest("/v1/models");
      assert.equal(models.status, 200, models.text);
    }
  },
  {
    id: "anthropic-models",
    description: "Claude Code-compatible model discovery",
    async run(ctx) {
      const result = await ctx.publicRequest("/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-code/1.0"
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, undefined);
      assert.equal(result.json?.has_more, false);
      ensure(Array.isArray(result.json?.data) && result.json.data.length > 0, "Expected Anthropic model data");
      assert.equal(result.json.data[0]?.type, "model");
      ensure(result.json.data[0]?.id, "Expected model ID");
      ensure(result.json.data[0]?.display_name, "Expected model display name");
      ensure(result.json.data[0]?.created_at, "Expected model creation timestamp");
      assert.equal(result.json?.first_id, result.json.data[0].id);
      assert.equal(result.json?.last_id, result.json.data.at(-1).id);
      assert.deepEqual(result.json.data.map((model) => model.id), ["claude-native"]);

      const genericResult = await ctx.publicRequest("/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "user-agent": "anthropic-sdk-js/0.1"
        }
      });
      assert.equal(genericResult.status, 200, genericResult.text);
      ensure(genericResult.json.data.length > 1, "Expected generic Anthropic discovery to retain all accessible models");

      const formatOnlyResult = await ctx.publicRequest("/v1/models?format=claude-code");
      assert.equal(formatOnlyResult.status, 200, formatOnlyResult.text);
      assert.equal(formatOnlyResult.json?.object, undefined);
      assert.deepEqual(formatOnlyResult.json.data.map((model) => model.id), ["claude-native"]);

      const explicitFormatResult = await ctx.publicRequest("/v1/models?format=claude-code", {
        headers: { "user-agent": "codex_cli_rs/0.147.0" }
      });
      assert.equal(explicitFormatResult.status, 200, explicitFormatResult.text);
      assert.equal(explicitFormatResult.json?.models, undefined);
      assert.deepEqual(explicitFormatResult.json?.data?.map((model) => model.id), ["claude-native"]);

      const config = await ctx.readConfigFile();
      config.compatibility = {
        ...(config.compatibility || {}),
        claudeCode: { enabled: false }
      };
      const disabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(disabledConfig.status, 200, disabledConfig.text);
      const disabledResult = await ctx.publicRequest("/v1/models?format=claude-code");
      assert.equal(disabledResult.status, 200, disabledResult.text);
      assert.equal(disabledResult.json?.object, "list");
      ensure(Array.isArray(disabledResult.json?.data), "Expected standard model data with Claude Code compatibility disabled");
    }
  },
  {
    id: "codex-models",
    description: "Codex-compatible model discovery",
    async run(ctx) {
      const result = await ctx.publicRequest("/v1/models", {
        headers: { "user-agent": "codex_cli_rs/0.147.0" }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, undefined);
      assert.equal(result.json?.data, undefined);
      ensure(Array.isArray(result.json?.models) && result.json.models.length > 0, "Expected Codex model data");
      const codexModel = result.json.models.find((model) => model.slug === "gpt-5.6-luna");
      ensure(codexModel, "Expected native Responses model in Codex catalog");
      assert.equal(codexModel.display_name, "GPT-5.6 Luna");
      assert.equal(codexModel.context_window, 128000);
      assert.equal(codexModel.default_reasoning_level, "medium");
      assert.deepEqual(codexModel.supported_reasoning_levels.map((item) => item.effort), ["none", "low", "medium", "high", "xhigh", "max"]);
      assert.equal(codexModel.support_verbosity, false);
      assert.equal(codexModel.use_responses_lite, false);
      assert.equal(result.json.models.some((model) => model.slug === "gpt-5-mini"), false);
      assert.equal(result.json.models.some((model) => model.slug === "claude-sonnet-4-6"), false);
      assert.equal(result.json.models.some((model) => model.slug === "chat-only"), false);
      assert.equal(result.json.models.some((model) => model.slug === "gpt-image-1.5"), false);

      const staleCapabilityConfig = await ctx.readConfigFile();
      const staleCapabilityModel = staleCapabilityConfig.models.find((model) => model.id === "gpt-5.6-luna");
      staleCapabilityModel.capabilities = ["reasoning"];
      const savedStaleCapabilities = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: staleCapabilityConfig
      });
      assert.equal(savedStaleCapabilities.status, 200, savedStaleCapabilities.text);

      const refreshedResult = await ctx.publicRequest("/v1/models?format=codex");
      assert.equal(refreshedResult.status, 200, refreshedResult.text);
      const refreshedModel = refreshedResult.json?.models?.find((model) => model.slug === "gpt-5.6-luna");
      ensure(refreshedModel, "Expected refreshed Codex model data");
      assert.deepEqual(refreshedModel.input_modalities, ["text", "image"]);
      assert.equal(refreshedModel.supports_image_detail_original, true);
      assert.equal(refreshedModel.supports_parallel_tool_calls, true);

      const standardResult = await ctx.publicRequest("/v1/models", {
        headers: { "user-agent": "openai-node/6.0" }
      });
      assert.equal(standardResult.status, 200, standardResult.text);
      assert.equal(standardResult.json?.object, "list");
      ensure(Array.isArray(standardResult.json?.data), "Expected standard OpenAI model data");

      const relativeRouteConfig = await ctx.readConfigFile();
      const relativeRouteUpstream = relativeRouteConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      ensure(relativeRouteUpstream, "Expected mock Foundry upstream");
      relativeRouteUpstream.routes.responses = "responses";
      const savedRelativeRoute = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: relativeRouteConfig
      });
      assert.equal(savedRelativeRoute.status, 200, savedRelativeRoute.text);
      const relativeRouteResult = await ctx.publicRequest("/v1/models?format=codex");
      assert.equal(relativeRouteResult.status, 200, relativeRouteResult.text);
      assert.ok(relativeRouteResult.json.models.some((model) => model.slug === "gpt-5.6-luna"));

      const config = await ctx.readConfigFile();
      config.compatibility = {
        ...(config.compatibility || {}),
        codex: { enabled: false }
      };
      const disabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(disabledConfig.status, 200, disabledConfig.text);
      const disabledResult = await ctx.publicRequest("/v1/models", {
        headers: { "user-agent": "codex_cli_rs/0.147.0" }
      });
      assert.equal(disabledResult.status, 200, disabledResult.text);
      assert.equal(disabledResult.json?.object, "list");
      ensure(Array.isArray(disabledResult.json?.data), "Expected standard model data with Codex compatibility disabled");
    }
  },
  {
    id: "client-native-route-validation",
    description: "Claude Code and Codex models require native protocol routes",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      const codexModel = config.models.find((model) => model.id === "gpt-5.6-luna");
      ensure(codexModel, "Expected Codex-marked model");

      const nullCompatibility = structuredClone(config);
      nullCompatibility.compatibility = null;
      const nullCompatibilityResult = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: nullCompatibility
      });
      assert.equal(nullCompatibilityResult.status, 400, nullCompatibilityResult.text);
      assert.match(nullCompatibilityResult.json?.error || "", /compatibility must be an object/);

      const invalidCompatibility = structuredClone(config);
      invalidCompatibility.compatibility = {
        ...(invalidCompatibility.compatibility || {}),
        codex: null
      };
      const invalidCompatibilityResult = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidCompatibility
      });
      assert.equal(invalidCompatibilityResult.status, 400, invalidCompatibilityResult.text);
      assert.match(invalidCompatibilityResult.json?.error || "", /compatibility\.codex must be an object/);

      config.models.push({ ...codexModel });
      const duplicateModel = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(duplicateModel.status, 400, duplicateModel.text);
      assert.match(duplicateModel.json?.error || "", /duplicates model ID "gpt-5\.6-luna"/);
      config.models.pop();

      codexModel.routes = { "*": "chat/completions" };

      const invalidCodex = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(invalidCodex.status, 400, invalidCodex.text);
      assert.match(invalidCodex.json?.error || "", /marked for Codex.*native responses is required/);

      codexModel.routes = {};
      const originalCodexTargetModel = codexModel.targetModel;
      codexModel.targetModel = "model-router";
      const codexModelRouter = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(codexModelRouter.status, 400, codexModelRouter.text);
      assert.match(codexModelRouter.json?.error || "", /marked for Codex.*resolves to chat\/completions/);
      codexModel.targetModel = originalCodexTargetModel;

      const foundryUpstream = config.upstreams.find((upstream) => upstream.name === codexModel.upstream);
      ensure(foundryUpstream, "Expected Codex model upstream");
      const originalResponsesRoute = foundryUpstream.routes.responses;
      foundryUpstream.routes.responses = "/openai/v1/chat/completions";
      const mismatchedResponsesPath = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(mismatchedResponsesPath.status, 400, mismatchedResponsesPath.text);
      assert.match(mismatchedResponsesPath.json?.error || "", /marked for Codex.*resolves to chat\/completions/);

      foundryUpstream.routes.responses = "/openai/v1/responsez";
      const unknownResponsesPath = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(unknownResponsesPath.status, 400, unknownResponsesPath.text);
      assert.match(
        unknownResponsesPath.json?.error || "",
        /marked for Codex.*no usable native responses route.*final backend route unknown/
      );
      foundryUpstream.routes.responses = originalResponsesRoute;

      config.routing = {
        ...(config.routing || {}),
        routeProfiles: {
          ...(config.routing?.routeProfiles || {}),
          responses: {
            ...(config.routing?.routeProfiles?.responses || {}),
            enabled: false
          }
        }
      };
      const disabledResponsesRoute = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(disabledResponsesRoute.status, 400, disabledResponsesRoute.text);
      assert.match(disabledResponsesRoute.json?.error || "", /marked for Codex.*public route responses is disabled/);
      config.routing.routeProfiles.responses.enabled = true;

      config.compatibility = {
        ...(config.compatibility || {}),
        codex: { enabled: false }
      };
      const disabledCodex = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(disabledCodex.status, 200, disabledCodex.text);

      config.compatibility.codex.enabled = true;
      codexModel.routes = {};
      const claudeModel = config.models.find((model) => model.id === "claude-native");
      ensure(claudeModel, "Expected Claude Code-marked model");
      const originalClaudeTargetModel = claudeModel.targetModel;
      claudeModel.targetModel = "model-router";
      claudeModel.routes = { "*": "messages" };
      const claudeModelRouter = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(claudeModelRouter.status, 400, claudeModelRouter.text);
      assert.match(
        claudeModelRouter.json?.error || "",
        /marked for Claude Code.*does not allow route target chat\/completions/
      );
      claudeModel.targetModel = originalClaudeTargetModel;

      claudeModel.routes = { "*": "responses" };
      const invalidClaude = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(invalidClaude.status, 400, invalidClaude.text);
      assert.match(invalidClaude.json?.error || "", /route target "responses".*claude-sonnet-4-6/);

      const claudeUpstream = config.upstreams.find((upstream) => upstream.name === claudeModel.upstream);
      ensure(claudeUpstream, "Expected Claude Code model upstream");
      claudeUpstream.routes.messagez = "/custom/messages";
      claudeModel.routes = { "*": "messagez" };
      const aliasedClaudeProtocol = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(aliasedClaudeProtocol.status, 400, aliasedClaudeProtocol.text);
      assert.match(aliasedClaudeProtocol.json?.error || "", /route target "messagez".*claude-sonnet-4-6/);

      delete claudeUpstream.routes.messagez;
      claudeModel.routes = { "*": "messages" };
      const validConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(validConfig.status, 200, validConfig.text);
    }
  },
  {
    id: "gpt-5.6-route-migration",
    description: "legacy GPT-5.6 wildcard routes migrate without blocking explicit v3 overrides",
    async run(ctx) {
      const legacyConfig = await ctx.readConfigFile();
      legacyConfig.version = 2;
      legacyConfig.server.upstream.maxResponseBytes = 32 * 1024 * 1024;
      delete legacyConfig.proxy.guards.maxResponseBodyBytes;
      const legacyModel = legacyConfig.models.find((model) => model.id === "gpt-5.6-luna");
      ensure(legacyModel, "Expected GPT-5.6 model config");
      legacyModel.routes = { "*": "responses" };
      const migrated = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: legacyConfig
      });
      assert.equal(migrated.status, 200, migrated.text);

      const migratedConfig = await ctx.readConfigFile();
      const migratedModel = migratedConfig.models.find((model) => model.id === "gpt-5.6-luna");
      assert.equal(migratedConfig.version, 3);
      assert.equal(migratedConfig.proxy.guards.maxResponseBodyBytes, 32 * 1024 * 1024);
      assert.deepEqual(migratedModel?.routes, {});

      migratedConfig.admin.basePath = "/admin?unsafe=true";
      const invalidAdminPath = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: migratedConfig
      });
      assert.equal(invalidAdminPath.status, 400, invalidAdminPath.text);
      assert.match(invalidAdminPath.json?.error || "", /absolute URL path without query or fragment/);
      migratedConfig.admin.basePath = "/admin";

      ctx.clearUpstreamRequests();
      const nativeChat = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "use native chat" }]
        }
      });
      assert.equal(nativeChat.status, 200, nativeChat.text);
      ensure(
        ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions")),
        "Expected migrated GPT-5.6 Chat request to stay native"
      );

      migratedModel.routes = { "*": "responses" };
      const explicitOverride = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: migratedConfig
      });
      assert.equal(explicitOverride.status, 200, explicitOverride.text);

      ctx.clearUpstreamRequests();
      const convertedChat = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "use explicit responses override" }]
        }
      });
      assert.equal(convertedChat.status, 200, convertedChat.text);
      ensure(
        ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses")),
        "Expected explicit v3 wildcard override to use Responses"
      );
    }
  },
  {
    id: "chat-web-search-to-responses",
    description: "Chat web search uses the Azure Responses protocol without a client-specific gate",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      const chatOnlyModel = config.models.find((model) => model.id === "chat-only");
      ensure(chatOnlyModel, "Expected chat-only model config");
      chatOnlyModel.pricingRef = "model-router";
      config.compatibility = {
        ...(config.compatibility || {}),
        protocolShim: {
          ...(config.compatibility?.protocolShim || {}),
          rejectLossyRequests: true
        }
      };
      const savedConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(savedConfig.status, 200, savedConfig.text);

      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          messages: [{ role: "user", content: "Find today's Azure AI news." }],
          tools: [{
            type: "web_search_preview_2025_03_11",
            search_context_size: "medium",
            user_location: {
              type: "approximate",
              country: "US",
              city: "Redmond",
              region: "Washington"
            }
          }],
          tool_choice: { type: "web_search_preview_2025_03_11" }
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "chat.completion");
      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected Chat web search to use the Responses upstream");
      assert.deepEqual(upstreamRequest.body?.tools, [{
        type: "web_search",
        search_context_size: "medium",
        user_location: {
          type: "approximate",
          country: "US",
          city: "Redmond",
          region: "Washington"
        }
      }]);
      assert.deepEqual(upstreamRequest.body?.tool_choice, { type: "web_search" });

      ctx.clearUpstreamRequests();
      const chatOnlyResult = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "chat-only",
          messages: [{ role: "user", content: "Search from a Chat-only model." }],
          tools: [{ type: "web_search_preview" }]
        }
      });
      assert.equal(chatOnlyResult.status, 200, chatOnlyResult.text);
      ensure(
        ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions")),
        "Expected a Catalog Chat-only model to stay on the Chat upstream"
      );
      assert.equal(
        ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses")),
        null
      );
    }
  },
  {
    id: "chat-completion",
    description: "chat/completions route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          messages: [
            {
              role: "user",
              content: "hello"
            }
          ]
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "chat.completion");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions"));
      ensure(upstreamRequest, "Expected upstream chat completion request");
      assert.equal(upstreamRequest.body?.model, "gpt-5-mini");
    }
  },
  {
    id: "response",
    description: "responses route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          input: [{
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "namespace",
                name: "functions",
                description: "",
                tools: [
                  {
                    type: "custom",
                    name: "nested_lookup",
                    description: "   ",
                    format: { type: "text" }
                  },
                  {
                    type: "function",
                    name: "documented_lookup",
                    description: "Keep this description",
                    parameters: { type: "object", properties: {} }
                  },
                  {
                    type: "function",
                    name: "missing_description",
                    parameters: { type: "object", properties: {} }
                  }
                ]
              },
              {
                type: "tool_search",
                execution: "client",
                description: "",
                parameters: { type: "object", properties: {} }
              }
            ]
          }, {
            type: "tool_search_output",
            call_id: "search_1",
            status: "completed",
            execution: "client",
            tools: [{
              type: "function",
              name: "deferred_lookup",
              description: "",
              parameters: { type: "object", properties: {} }
            }]
          }, {
            role: "user",
            content: "hello"
          }],
          tools: [
            {
              type: "function",
              name: "lookup",
              description: "",
              parameters: {
                type: "object",
                properties: {}
              }
            },
            {
              type: "code_interpreter",
              container: { type: "auto" }
            }
          ]
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "response");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected upstream responses request");
      assert.equal(upstreamRequest.body?.model, "gpt-5-mini");
      assert.equal(upstreamRequest.body.tools[0].description, "lookup");
      assert.equal("description" in upstreamRequest.body.tools[1], false);
      assert.equal(upstreamRequest.body.input[0].tools[0].description, "Tools in the functions namespace.");
      assert.equal(upstreamRequest.body.input[0].tools[0].tools[0].description, "nested_lookup");
      assert.equal(upstreamRequest.body.input[0].tools[0].tools[1].description, "Keep this description");
      assert.equal(upstreamRequest.body.input[0].tools[0].tools[2].description, "missing_description");
      assert.equal(upstreamRequest.body.input[0].tools[1].description, "");
      assert.equal(upstreamRequest.body.input[1].tools[0].description, "");
    }
  },
  {
    id: "response-compact",
    description: "native Responses compaction route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses/compact", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: [{ role: "user", content: "compact this conversation" }],
          instructions: "Preserve the important state."
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "response.compaction");
      assert.equal(result.json?.output?.[1]?.type, "compaction");
      assert.equal(result.json?.output?.[1]?.encrypted_content, "encrypted-compaction-state");
      assert.deepEqual(result.json?.usage, {
        input_tokens: 21,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 29
      });

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses/compact"));
      ensure(upstreamRequest, "Expected native Responses compaction upstream request");
      assert.equal(upstreamRequest.body?.model, "gpt-5.6-luna");
      assert.deepEqual(upstreamRequest.body?.input, [{ role: "user", content: "compact this conversation" }]);
      assert.equal(upstreamRequest.body?.instructions, "Preserve the important state.");
      assert.equal(upstreamRequest.headers["api-key"], "test-upstream-key");
      assert.notEqual(upstreamRequest.headers.authorization, "Bearer test-client-key");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const stats = await ctx.adminRequest("/admin/api/stats");
      assert.equal(stats.status, 200, stats.text);
      assert.equal(stats.json?.totals?.promptTokens, 21);
      assert.equal(stats.json?.totals?.completionTokens, 8);
      assert.equal(stats.json?.totals?.totalTokens, 29);
      assert.equal(stats.json?.totals?.cachedTokens, 3);

      const config = await ctx.readConfigFile();
      const foundryUpstream = config.upstreams.find((upstream) => upstream.name === "mock-foundry");
      ensure(foundryUpstream, "Expected mock Foundry upstream");
      foundryUpstream.routes["responses/compact"] = "/openai/v1/responses/compact?deployment={deployment}";
      const explicitRouteConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(explicitRouteConfig.status, 200, explicitRouteConfig.text);

      ctx.clearUpstreamRequests();
      const explicitRoute = await ctx.publicRequest("/v1/responses/compact", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          previous_response_id: "resp_previous"
        }
      });
      assert.equal(explicitRoute.status, 200, explicitRoute.text);
      const explicitUpstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/responses/compact"));
      ensure(explicitUpstreamRequest, "Expected explicitly configured Responses compaction request");
      assert.equal(
        new URL(explicitUpstreamRequest.url, "http://mock").searchParams.get("deployment"),
        "gpt-5.6-luna"
      );

      ctx.clearUpstreamRequests();
      const invalidPayload = await ctx.publicRequest("/v1/responses/compact", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "Reject malformed provider payloads",
          instructions: "trigger invalid compaction"
        }
      });
      assert.equal(invalidPayload.status, 502, invalidPayload.text);
      assert.equal(invalidPayload.json?.error?.code, "InvalidCompactionResponse");

      ctx.clearUpstreamRequests();
      const unsupported = await ctx.publicRequest("/v1/responses/compact", {
        method: "POST",
        json: {
          model: "chat-only",
          input: "Do not shim this request"
        }
      });
      assert.equal(unsupported.status, 400, unsupported.text);
      assert.equal(unsupported.json?.error?.code, "ResponseCompactionNotSupported");
      assert.equal(ctx.upstreamRequests.length, 0, "Unsupported compaction must not call an upstream");

      const disabledConfig = await ctx.readConfigFile();
      disabledConfig.compatibility.codex.enabled = false;
      disabledConfig.routing.routeProfiles.responses.enabled = false;
      const savedDisabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: disabledConfig
      });
      assert.equal(savedDisabledConfig.status, 200, savedDisabledConfig.text);

      ctx.clearUpstreamRequests();
      const disabled = await ctx.publicRequest("/v1/responses/compact", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "Responses is disabled"
        }
      });
      assert.equal(disabled.status, 404, disabled.text);
      assert.equal(disabled.json?.error?.code, "RouteDisabled");
      assert.equal(ctx.upstreamRequests.length, 0, "Disabled compaction must not call an upstream");
    }
  },
  {
    id: "empty-tool-controls",
    description: "tool controls are omitted without tools",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const responsesResult = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5-mini",
          input: "hello",
          tool_choice: "required",
          parallel_tool_calls: true
        }
      });
      assert.equal(responsesResult.status, 200, responsesResult.text);
      const responsesRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(responsesRequest, "Expected Responses upstream request");
      assert.equal("tool_choice" in responsesRequest.body, false);
      assert.equal("parallel_tool_calls" in responsesRequest.body, false);

      ctx.clearUpstreamRequests();
      const messagesResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }],
          tool_choice: { type: "any" }
        }
      });
      assert.equal(messagesResult.status, 200, messagesResult.text);
      const messagesRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(messagesRequest, "Expected Messages upstream request");
      assert.equal("tool_choice" in messagesRequest.body, false);
    }
  },
  {
    id: "request-parameter-policy",
    description: "model and upstream policies control request parameter fidelity",
    async run(ctx) {
      const invalidModelPolicy = await ctx.readConfigFile();
      const invalidModel = invalidModelPolicy.models.find((model) => model.id === "gpt-5.6-luna");
      invalidModel.requestPolicy = "invalid";
      const rejectedModelPolicy = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidModelPolicy
      });
      assert.equal(rejectedModelPolicy.status, 400, rejectedModelPolicy.text);
      assert.match(rejectedModelPolicy.json?.error || "", /requestPolicy must be an object/);

      const invalidUpstreamPolicy = await ctx.readConfigFile();
      const invalidPolicyUpstream = invalidUpstreamPolicy.upstreams.find((upstream) => upstream.name === "mock-foundry");
      invalidPolicyUpstream.requestPolicy = {
        allowedParams: [],
        blockedParams: ["verbosity", 123],
        dropUnsupportedParams: false
      };
      const rejectedUpstreamPolicy = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidUpstreamPolicy
      });
      assert.equal(rejectedUpstreamPolicy.status, 400, rejectedUpstreamPolicy.text);
      assert.match(rejectedUpstreamPolicy.json?.error || "", /blockedParams must be an array of strings/);

      const invalidRoutePolicy = await ctx.readConfigFile();
      invalidRoutePolicy.routing = {
        routeProfiles: {
          responses: { allowedRequestFields: ["input", 123] }
        }
      };
      const rejectedRoutePolicy = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidRoutePolicy
      });
      assert.equal(rejectedRoutePolicy.status, 400, rejectedRoutePolicy.text);
      assert.match(rejectedRoutePolicy.json?.error || "", /allowedRequestFields must be an array of strings/);

      const extensionConfig = await ctx.readConfigFile();
      const extensionUpstream = extensionConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      ensure(extensionUpstream, "Expected mock Foundry upstream");
      extensionConfig.upstreams.push({
        ...structuredClone(extensionUpstream),
        name: "mock-provider-extension",
        capabilities: []
      });
      extensionConfig.models.push({
        id: "gpt-6-provider-extension",
        displayName: "GPT-6 Provider Extension",
        status: "active",
        upstream: "mock-provider-extension",
        targetModel: "gpt-6-provider-extension",
        pricingRef: "gpt-5.6-luna",
        routes: { "*": "responses" }
      });
      const savedExtensionConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: extensionConfig
      });
      assert.equal(savedExtensionConfig.status, 200, savedExtensionConfig.text);

      ctx.clearUpstreamRequests();
      const forwardedExtension = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-6-provider-extension",
          input: "let the upstream evaluate provider extensions",
          reasoning: { effort: "FUTURE_LEVEL" },
          tools: [{ type: "web_search_preview_2025_03_11" }]
        }
      });
      assert.equal(forwardedExtension.status, 200, forwardedExtension.text);
      const forwardedExtensionRequest = ctx.getUpstreamRequest(
        (item) => item.body?.model === "gpt-6-provider-extension"
      );
      ensure(forwardedExtensionRequest, "Provider extension request must reach the upstream");
      assert.equal(forwardedExtensionRequest.body?.reasoning?.effort, "future_level");
      assert.equal(forwardedExtensionRequest.body?.tools?.[0]?.type, "web_search");

      ctx.clearUpstreamRequests();
      const convertedExtension = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-6-provider-extension",
          messages: [{ role: "user", content: "preserve future reasoning through the shim" }],
          reasoning_effort: "FUTURE_LEVEL"
        }
      });
      assert.equal(convertedExtension.status, 200, convertedExtension.text);
      const convertedExtensionRequest = ctx.getUpstreamRequest(
        (item) => item.body?.model === "gpt-6-provider-extension"
      );
      ensure(convertedExtensionRequest, "Converted provider extension request must reach the Responses upstream");
      assert.equal(convertedExtensionRequest.body?.reasoning?.effort, "future_level");
      assert.equal("reasoning_effort" in convertedExtensionRequest.body, false);

      ctx.clearUpstreamRequests();
      const preserved = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "preserve provider-supported parameters",
          serviceTier: "priority",
          verbosity: "high",
          top_k: 7
        }
      });
      assert.equal(preserved.status, 200, preserved.text);
      const preservedRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(preservedRequest, "Expected preserved Responses request");
      assert.equal(preservedRequest.body?.service_tier, "priority");
      assert.equal("serviceTier" in preservedRequest.body, false);
      assert.equal(preservedRequest.body?.verbosity, "high");
      assert.equal(preservedRequest.body?.top_k, 7);

      const dropConfig = await ctx.readConfigFile();
      const foundryUpstream = dropConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      ensure(foundryUpstream, "Expected mock Foundry upstream");
      foundryUpstream.requestPolicy = {
        allowedParams: [],
        blockedParams: ["verbosity", "top_k"],
        dropUnsupportedParams: true
      };
      const savedDropConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: dropConfig
      });
      assert.equal(savedDropConfig.status, 200, savedDropConfig.text);

      ctx.clearUpstreamRequests();
      const dropped = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "drop explicitly unsupported parameters",
          service_tier: "priority",
          verbosity: "high",
          top_k: 7
        }
      });
      assert.equal(dropped.status, 200, dropped.text);
      const droppedRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(droppedRequest, "Expected policy-filtered Responses request");
      assert.equal(droppedRequest.body?.service_tier, "priority");
      assert.equal("verbosity" in droppedRequest.body, false);
      assert.equal("top_k" in droppedRequest.body, false);

      const rejectConfig = await ctx.readConfigFile();
      const rejectUpstream = rejectConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      rejectUpstream.requestPolicy.dropUnsupportedParams = false;
      const savedRejectConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: rejectConfig
      });
      assert.equal(savedRejectConfig.status, 200, savedRejectConfig.text);

      ctx.clearUpstreamRequests();
      const rejected = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "reject explicitly unsupported parameters",
          verbosity: "high"
        }
      });
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal(rejected.json?.error?.code, "UnsupportedParameter");
      assert.equal(rejected.json?.error?.param, "verbosity");
      assert.equal(ctx.upstreamRequests.length, 0, "Rejected parameter policy must not call an upstream");
    }
  },
  {
    id: "message",
    description: "native Anthropic Messages route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const requestBody = {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: [{ type: "text", text: "Keep the typed blocks intact." }],
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "consider", signature: "sig_1" }]
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result", is_error: false }]
          }
        ],
        tools: [{
          name: "lookup",
          description: "Look up a value",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"]
          }
        }],
        thinking: { type: "enabled", budget_tokens: 1024 }
      };
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14"
        },
        json: requestBody
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.type, "message");
      assert.equal(result.json?.model, "claude-sonnet-4-6");
      assert.equal(result.json?.stop_reason, "end_turn");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(upstreamRequest, "Expected native Anthropic Messages upstream request");
      assert.equal(upstreamRequest.body?.model, "claude-sonnet-4-20250514");
      assert.deepEqual(upstreamRequest.body?.system, requestBody.system);
      assert.deepEqual(upstreamRequest.body?.messages, requestBody.messages);
      assert.deepEqual(upstreamRequest.body?.tools, requestBody.tools);
      assert.deepEqual(upstreamRequest.body?.thinking, requestBody.thinking);
      assert.equal(upstreamRequest.headers?.["anthropic-version"], "2023-06-01");
      assert.equal(upstreamRequest.headers?.["anthropic-beta"], "interleaved-thinking-2025-05-14");
      assert.equal(upstreamRequest.headers?.["x-api-key"], "test-upstream-key");
      assert.equal(upstreamRequest.headers?.["api-key"], undefined);
    }
  },
  {
    id: "message-compatibility",
    description: "Foundry Anthropic compatibility policies",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": [
            "fine-grained-tool-streaming-2025-05-14",
            "unknown-beta",
            "context-management-2025-06-27",
            "fine-grained-tool-streaming-2025-05-14"
          ].join(",")
        },
        json: {
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
          tool_choice: { type: "tool", name: "lookup" },
          cache_control: { type: "ephemeral", ttl: "1h" },
          metadata: { cache_control: { type: "ephemeral" } },
          system: [{
            type: "text",
            text: "Use tools carefully.",
            cache_control: { type: "ephemeral", ttl: "1h", unsupported: true }
          }],
          messages: [{
            role: "user",
            cache_control: { type: "ephemeral" },
            content: [{
              type: "text",
              text: "look up item 1",
              cache_control: { type: "persistent", ttl: "1h" }
            }]
          }],
          tools: [{
            name: "lookup",
            description: "Look up an item",
            input_schema: { type: "object", cache_control: { type: "ephemeral" } },
            cache_control: { type: "ephemeral", ttl: "5m", extra: "drop" }
          }]
        }
      });

      assert.equal(result.status, 200, result.text);
      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(upstreamRequest, "Expected native Messages upstream request");
      assert.equal(
        upstreamRequest.headers?.["anthropic-beta"],
        "fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27"
      );
      assert.deepEqual(upstreamRequest.body?.tool_choice, { type: "auto" });
      assert.deepEqual(upstreamRequest.body?.cache_control, { type: "ephemeral", ttl: "1h" });
      assert.equal("cache_control" in upstreamRequest.body.metadata, false);
      assert.deepEqual(upstreamRequest.body?.system?.[0]?.cache_control, { type: "ephemeral", ttl: "1h" });
      assert.equal("cache_control" in upstreamRequest.body.messages[0], false);
      assert.equal("cache_control" in upstreamRequest.body.messages[0].content[0], false);
      assert.deepEqual(upstreamRequest.body?.tools?.[0]?.cache_control, { type: "ephemeral", ttl: "5m" });
      assert.equal("cache_control" in upstreamRequest.body.tools[0].input_schema, false);

      const filteredBetaLogs = await ctx.adminRequest(
        "/admin/api/logs?event=proxy.anthropic_betas_filtered"
      );
      assert.equal(filteredBetaLogs.status, 200, filteredBetaLogs.text);
      assert.equal(filteredBetaLogs.json.total, 1);
      assert.equal(filteredBetaLogs.json.items[0].fields.filteredBetas, '["unknown-beta"]');
      assert.equal(filteredBetaLogs.json.items[0].fields.filteredBetaCount, 1);
      assert.equal(filteredBetaLogs.json.items[0].fields.upstreamProvider, "provider:azure-openai");

      ctx.clearUpstreamRequests();
      const adaptiveResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          thinking: { type: "adaptive" },
          tool_choice: { type: "tool", name: "lookup" },
          messages: [{ role: "user", content: "look up item 2" }],
          tools: [{ name: "lookup", description: "Look up an item", input_schema: { type: "object" } }]
        }
      });
      assert.equal(adaptiveResult.status, 200, adaptiveResult.text);
      const adaptiveRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(adaptiveRequest, "Expected adaptive Messages upstream request");
      assert.deepEqual(adaptiveRequest.body?.thinking, { type: "adaptive" });
      assert.deepEqual(adaptiveRequest.body?.tool_choice, { type: "tool", name: "lookup" });
    }
  },
  {
    id: "claude-code-compatibility",
    description: "Claude Code headers and native Anthropic beta compatibility",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      config.proxy.forwardHeaders = {
        mode: "allowlist",
        allow: ["user-agent", "anthropic-version", "anthropic-beta"],
        deny: ["authorization", "x-api-key"],
        addRequestIdHeader: true
      };
      config.compatibility = {
        ...(config.compatibility || {}),
        claudeCode: { enabled: true }
      };
      const enabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(enabledConfig.status, 200, enabledConfig.text);

      ctx.clearUpstreamRequests();
      const enabledResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": "future-beta-2026-08-10,interleaved-thinking-2025-05-14,future-beta-2026-08-10",
          "x-claude-code-session-id": "session_123",
          "x-stainless-package-version": "1.2.3",
          "x-anthropic-api-key": "client-secret-1",
          "x-claude-authorization": "Bearer client-secret-2",
          "x-stainless-access-token": "client-secret-3",
          cookie: "session=client-secret-4",
          "set-cookie": "session=client-secret-5"
        },
        json: {
          model: "claude-native",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }]
        }
      });
      assert.equal(enabledResult.status, 200, enabledResult.text);
      const enabledRequest = ctx.getUpstreamRequest((item) => item.url.includes("/anthropic/v1/messages"));
      ensure(enabledRequest, "Expected native Anthropic request");
      assert.equal(
        enabledRequest.headers?.["anthropic-beta"],
        "future-beta-2026-08-10,interleaved-thinking-2025-05-14"
      );
      assert.equal(enabledRequest.headers?.["x-claude-code-session-id"], "session_123");
      assert.equal(enabledRequest.headers?.["x-stainless-package-version"], "1.2.3");
      assert.equal(enabledRequest.headers?.["x-anthropic-api-key"], undefined);
      assert.equal(enabledRequest.headers?.["x-claude-authorization"], undefined);
      assert.equal(enabledRequest.headers?.["x-stainless-access-token"], undefined);
      assert.equal(enabledRequest.headers?.cookie, undefined);
      assert.equal(enabledRequest.headers?.["set-cookie"], undefined);
      assert.equal(enabledRequest.headers?.authorization, undefined);
      assert.equal(enabledRequest.headers?.["x-api-key"], "test-upstream-key");

      config.compatibility.claudeCode.enabled = false;
      const disabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(disabledConfig.status, 200, disabledConfig.text);

      ctx.clearUpstreamRequests();
      const disabledResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-beta": "future-beta-2026-08-10",
          "x-claude-code-session-id": "session_456",
          "x-stainless-package-version": "1.2.4"
        },
        json: {
          model: "claude-native",
          max_tokens: 64,
          messages: [{ role: "user", content: "hello" }]
        }
      });
      assert.equal(disabledResult.status, 200, disabledResult.text);
      const disabledRequest = ctx.getUpstreamRequest((item) => item.url.includes("/anthropic/v1/messages"));
      ensure(disabledRequest, "Expected native Anthropic request with compatibility disabled");
      assert.equal(disabledRequest.headers?.["anthropic-beta"], undefined);
      assert.equal(disabledRequest.headers?.["x-claude-code-session-id"], undefined);
      assert.equal(disabledRequest.headers?.["x-stainless-package-version"], undefined);
    }
  },
  {
    id: "message-thinking-model-policy",
    description: "Claude catalog policy passes through while explicit overrides validate thinking mode",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-sonnet-5",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
          messages: [{ role: "user", content: "hello" }]
        }
      });

      assert.equal(result.status, 200, result.text);
      const catalogRequest = ctx.getUpstreamRequest((item) => item.body?.model === "claude-sonnet-5");
      ensure(catalogRequest, "Expected catalog policy request to reach the upstream");
      assert.deepEqual(catalogRequest.body?.thinking, { type: "enabled", budget_tokens: 1024 });

      ctx.clearUpstreamRequests();
      const aliasResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-sonnet-5-alias",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
          messages: [{ role: "user", content: "hello alias" }]
        }
      });
      assert.equal(aliasResult.status, 200, aliasResult.text);
      const aliasRequest = ctx.getUpstreamRequest((item) => item.body?.model === "team-sonnet-deployment");
      ensure(aliasRequest, "Expected configured alias to inherit catalog passthrough policy");

      const aliasConfig = await ctx.readConfigFile();
      aliasConfig.compatibility = aliasConfig.compatibility || {};
      aliasConfig.compatibility.anthropic = aliasConfig.compatibility.anthropic || {};
      aliasConfig.compatibility.anthropic.thinkingTypesByModel = aliasConfig.compatibility.anthropic.thinkingTypesByModel || {};
      aliasConfig.compatibility.anthropic.thinkingTypesByModel["team-sonnet-deployment"] = ["adaptive"];
      const savedAliasConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: aliasConfig
      });
      assert.equal(savedAliasConfig.status, 200, savedAliasConfig.text);

      ctx.clearUpstreamRequests();
      const strictAliasResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-sonnet-5-alias",
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
          messages: [{ role: "user", content: "hello alias" }]
        }
      });
      assert.equal(strictAliasResult.status, 400, strictAliasResult.text);
      assert.equal(strictAliasResult.json?.error?.param, "thinking.type");
      assert.match(strictAliasResult.json?.error?.message || "", /adaptive/);
      assert.equal(ctx.upstreamRequests.length, 0);
    }
  },
  {
    id: "message-stream",
    description: "native Anthropic Messages stream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14"
        },
        json: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "stream a short response" }],
          max_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.headers.get("content-type") || "", /^text\/event-stream/);
      assert.match(result.text, /event: message_start/);
      assert.match(result.text, /"model":"claude-sonnet-4-6"/);
      assert.doesNotMatch(result.text, /"model":"claude-sonnet-4-20250514"/);
      assert.match(result.text, /"type":"content_block_delta"/);
      assert.match(result.text, /ok from mock messages stream/);
      assert.match(result.text, /event: message_stop/);
      assert.doesNotMatch(result.text, /response\.output_text\.delta/);
      assert.doesNotMatch(result.text, /data: \[DONE\]/);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(upstreamRequest, "Expected native Anthropic Messages stream upstream request");
      assert.equal(upstreamRequest.body?.model, "claude-sonnet-4-20250514");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.equal(upstreamRequest.headers?.["anthropic-version"], "2023-06-01");
      assert.equal(upstreamRequest.headers?.["x-api-key"], "test-upstream-key");
    }
  },
  {
    id: "chat-to-message",
    description: "Chat request through Anthropic Messages upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" }
          ],
          tools: [{
            type: "function",
            function: { name: "lookup", description: "Look up", parameters: { type: "object" } }
          }],
          max_tokens: 64
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "chat.completion");
      assert.equal(result.json?.choices?.[0]?.message?.content, "ok from mock messages");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(upstreamRequest, "Expected Chat request to use the Messages upstream");
      assert.equal(upstreamRequest.body?.model, "claude-sonnet-4-20250514");
      assert.equal(upstreamRequest.body?.system, "Be concise.");
      assert.equal(upstreamRequest.body?.messages?.[0]?.content?.[0]?.text, "hello");
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
      assert.equal(upstreamRequest.headers?.["x-api-key"], "test-upstream-key");
    }
  },
  {
    id: "response-to-message",
    description: "Responses request through Anthropic Messages upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          instructions: "Be concise.",
          input: "hello",
          max_output_tokens: 64
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.object, "response");
      assert.equal(result.json?.output?.[0]?.content?.[0]?.text, "ok from mock messages");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(upstreamRequest, "Expected Responses request to use the Messages upstream");
      assert.equal(upstreamRequest.body?.system, "Be concise.");
      assert.equal(upstreamRequest.body?.messages?.[0]?.content?.[0]?.text, "hello");
      assert.equal(upstreamRequest.body?.max_tokens, 64);
    }
  },
  {
    id: "claude-responses-compatibility",
    description: "Claude Responses reasoning follows model and hosting capabilities",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      const claudeModel = config.models.find((model) => model.id === "claude-sonnet-4-6");
      ensure(claudeModel, "Expected Claude model config");
      claudeModel.routes = {};
      claudeModel.hostingMode = "anthropic";
      const savedConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(savedConfig.status, 200, savedConfig.text);

      ctx.clearUpstreamRequests();
      const claudeResult = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "hello",
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "medium" }
        }
      });
      assert.equal(claudeResult.status, 200, claudeResult.text);
      const claudeRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(claudeRequest, "Expected Claude Messages upstream request");
      assert.deepEqual(claudeRequest.body?.output_config, { effort: "medium" });
      assert.deepEqual(claudeRequest.body?.thinking, { type: "adaptive" });
      assert.equal("reasoning" in claudeRequest.body, false);
      assert.equal("include" in claudeRequest.body, false);

      ctx.clearUpstreamRequests();
      const normalizedResult = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "hello",
          reasoning: { effort: "xhigh" }
        }
      });
      assert.equal(normalizedResult.status, 200, normalizedResult.text);
      const normalizedRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(normalizedRequest, "Expected normalized Claude Messages upstream request");
      assert.deepEqual(normalizedRequest.body?.output_config, { effort: "max" });

      ctx.clearUpstreamRequests();
      const invalidResult = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "hello",
          reasoning: { effort: "minimal" }
        }
      });
      assert.equal(invalidResult.status, 200, invalidResult.text);
      const passthroughRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(passthroughRequest, "Expected unknown catalog effort to reach the upstream");
      assert.deepEqual(passthroughRequest.body?.output_config, { effort: "minimal" });

      const invalidHostingConfig = structuredClone(config);
      const invalidHostingModel = invalidHostingConfig.models.find((model) => model.id === "claude-sonnet-4-6");
      invalidHostingModel.hostingMode = "azure";
      const invalidHostingResult = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidHostingConfig
      });
      assert.equal(invalidHostingResult.status, 400, invalidHostingResult.text);
      assert.match(invalidHostingResult.json?.error || "", /hostingMode=azure is not supported/);

      ctx.clearUpstreamRequests();
      const opusResult = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-opus-4-8",
          input: "hello",
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "xhigh" }
        }
      });
      assert.equal(opusResult.status, 200, opusResult.text);
      const opusRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/messages"));
      ensure(opusRequest, "Expected Azure-hosted Opus Messages upstream request");
      assert.deepEqual(opusRequest.body?.output_config, { effort: "xhigh" });
      assert.deepEqual(opusRequest.body?.thinking, { type: "adaptive" });
      assert.equal("include" in opusRequest.body, false);
      assert.equal("reasoning" in opusRequest.body, false);
    }
  },
  {
    id: "message-to-response",
    description: "Messages request through Responses upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14"
        },
        json: {
          model: "gpt-5.6-luna",
          system: "Be concise.",
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          max_tokens: 64
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.type, "message");
      assert.equal(result.json?.content?.[0]?.text, "ok from mock responses");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected Messages request to use the Responses upstream");
      assert.equal(upstreamRequest.body?.instructions, "Be concise.");
      assert.equal(upstreamRequest.body?.input?.[0]?.content, "hello");
      assert.equal(upstreamRequest.body?.max_output_tokens, 64);
      assert.equal(upstreamRequest.headers?.["api-key"], "test-upstream-key");
      assert.equal(upstreamRequest.headers?.["x-api-key"], undefined);
      assert.equal(upstreamRequest.headers?.["anthropic-version"], undefined);
      assert.equal(upstreamRequest.headers?.["anthropic-beta"], undefined);
    }
  },
  {
    id: "message-to-chat",
    description: "Messages request through Chat upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14"
        },
        json: {
          model: "chat-only",
          system: "Be concise.",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.equal(result.json?.type, "message");
      assert.equal(result.json?.model, "chat-only");
      assert.equal(result.json?.content?.[0]?.text, "ok from mock chat");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions"));
      ensure(upstreamRequest, "Expected Messages request to use the Chat upstream");
      assert.equal(upstreamRequest.body?.model, "chat-only-deployment");
      assert.deepEqual(upstreamRequest.body?.messages?.[0], { role: "system", content: "Be concise." });
      assert.deepEqual(upstreamRequest.body?.messages?.[1], { role: "user", content: "hello" });
      assert.equal(upstreamRequest.headers?.["anthropic-version"], undefined);
      assert.equal(upstreamRequest.headers?.["anthropic-beta"], undefined);
    }
  },
  {
    id: "responses-nonterminal-shim-rejected",
    description: "Nonterminal Responses JSON is never fabricated as a final Chat or Messages response",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      const model = config.models.find((item) => item.id === "gpt-5.6-luna");
      ensure(model, "Expected GPT-5.6 model config");
      model.routes = {
        ...(model.routes || {}),
        "chat/completions": "responses",
        messages: "responses"
      };
      config.compatibility = {
        ...(config.compatibility || {}),
        protocolShim: {
          ...(config.compatibility?.protocolShim || {}),
          rejectLossyResponses: false
        }
      };
      const savedConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(savedConfig.status, 200, savedConfig.text);

      const chatResult = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger nonterminal response" }]
        }
      });
      assert.equal(chatResult.status, 502, chatResult.text);
      assert.equal(chatResult.json?.error?.code, "UnsupportedProtocolShimResponse");
      assert.equal(chatResult.json?.error?.param, "status");

      const messagesResult = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          max_tokens: 64,
          messages: [{ role: "user", content: "trigger nonterminal response" }]
        }
      });
      assert.equal(messagesResult.status, 502, messagesResult.text);
      assert.equal(messagesResult.json?.error?.code, "UnsupportedProtocolShimResponse");
      assert.equal(messagesResult.json?.error?.param, "status");
    }
  },
  {
    id: "chat-to-message-stream",
    description: "Chat stream through Anthropic Messages upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /"object":"chat.completion.chunk"/);
      assert.match(result.text, /ok from mock messages stream/);
      assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);
    }
  },
  {
    id: "response-to-message-stream",
    description: "Responses stream through Anthropic Messages upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "trigger encrypted reasoning stream",
          max_output_tokens: 64,
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "medium" },
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /"type":"response.output_text.delta"/);
      assert.match(result.text, /reasoning preserved/);
      assert.match(result.text, /"encrypted_content":"opaque-stream-signature"/);
      assert.match(result.text, /"type":"response.completed"/);
      assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);
    }
  },
  {
    id: "message-to-response-stream",
    description: "Messages stream through Responses upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /event: message_start/);
      assert.match(result.text, /ok from mock responses stream/);
      assert.match(result.text, /"usage":\{"input_tokens":10,"output_tokens":6/);
      assert.match(result.text, /event: message_stop/);
      assert.doesNotMatch(result.text, /data: \[DONE\]/);
    }
  },
  {
    id: "message-to-chat-stream",
    description: "Messages stream through Chat upstream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "chat-only",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /event: message_start/);
      assert.match(result.text, /"model":"chat-only"/);
      assert.doesNotMatch(result.text, /"model":"chat-only-deployment"/);
      assert.match(result.text, /ok from mock chat stream/);
      assert.match(result.text, /"usage":\{"input_tokens":11,"output_tokens":7/);
      assert.match(result.text, /event: message_stop/);
      assert.doesNotMatch(result.text, /data: \[DONE\]/);
    }
  },
  {
    id: "message-stream-provider-error",
    description: "Messages conversion preserves Anthropic stream error framing",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger provider error" }],
          max_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /event: message_start/);
      assert.match(result.text, /event: error/);
      assert.match(result.text, /"type":"provider_error"/);
      assert.match(result.text, /mock provider failed/);
      assert.doesNotMatch(result.text, /data: \[DONE\]/);
      assert.doesNotMatch(result.text, /event: message_stop/);
    }
  },
  {
    id: "json-provider-error",
    description: "HTTP 200 failed payloads remain provider errors",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger failed json"
        }
      });

      assert.equal(result.status, 502, result.text);
      assert.equal(result.json?.code, "UPSTREAM_PROVIDER_RESPONSE_ERROR");
      assert.equal(result.json?.error?.code, "model_failed");
      assert.match(result.json?.error?.message || "", /mock JSON response failed/);
    }
  },
  {
    id: "native-error-passthrough",
    description: "native routes optionally preserve upstream error bodies",
    async run(ctx) {
      const invalidRouteConfig = await ctx.readConfigFile();
      invalidRouteConfig.routing = {
        ...(invalidRouteConfig.routing || {}),
        routeProfiles: {
          ...(invalidRouteConfig.routing?.routeProfiles || {}),
          responses: {
            ...(invalidRouteConfig.routing?.routeProfiles?.responses || {}),
            nativeErrorPassthrough: "yes"
          }
        }
      };
      const rejectedRouteConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidRouteConfig
      });
      assert.equal(rejectedRouteConfig.status, 400, rejectedRouteConfig.text);
      assert.match(rejectedRouteConfig.json?.error || "", /nativeErrorPassthrough must be a boolean/);

      const invalidUpstreamConfig = await ctx.readConfigFile();
      const invalidUpstream = invalidUpstreamConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      invalidUpstream.errorPolicy = { nativePassthrough: "yes" };
      const rejectedUpstreamConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidUpstreamConfig
      });
      assert.equal(rejectedUpstreamConfig.status, 400, rejectedUpstreamConfig.text);
      assert.match(rejectedUpstreamConfig.json?.error || "", /nativePassthrough must be a boolean/);

      ctx.clearUpstreamRequests();
      const normalized = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        headers: { "x-request-id": "req-normalized-error" },
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native HTTP error"
        }
      });
      assert.equal(normalized.status, 429, normalized.text);
      assert.equal(normalized.json?.code, "UPSTREAM_RATE_LIMIT");
      assert.equal(normalized.json?.error?.code, "native_rate_limit");
      assert.equal(normalized.json?.native_marker, undefined);
      assert.equal(normalized.headers.get("retry-after"), null);

      const normalizedStreamEvent = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native stream error",
          stream: true
        }
      });
      assert.equal(normalizedStreamEvent.status, 200, normalizedStreamEvent.text);
      assert.match(normalizedStreamEvent.text, /event: error/);
      assert.match(normalizedStreamEvent.text, /native_stream_failure/);
      assert.doesNotMatch(normalizedStreamEvent.text, /native_marker/);

      const upstreamConfig = await ctx.readConfigFile();
      const foundryUpstream = upstreamConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      ensure(foundryUpstream, "Expected mock Foundry upstream");
      foundryUpstream.errorPolicy = { nativePassthrough: true };
      const savedUpstreamConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: upstreamConfig
      });
      assert.equal(savedUpstreamConfig.status, 200, savedUpstreamConfig.text);

      const nativeHttpError = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        headers: { "x-request-id": "req-native-error" },
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native HTTP error"
        }
      });
      assert.equal(nativeHttpError.status, 429, nativeHttpError.text);
      assert.equal(nativeHttpError.headers.get("x-request-id"), "req-native-error");
      assert.match(nativeHttpError.headers.get("content-type") || "", /application\/json/);
      assert.equal(nativeHttpError.headers.get("retry-after"), "2");
      assert.deepEqual(nativeHttpError.json, {
        type: "error",
        error: {
          type: "rate_limit_error",
          code: "native_rate_limit",
          message: "native upstream rate limit"
        },
        native_marker: "preserved"
      });

      const nativeStreamHttpError = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        headers: { "x-request-id": "req-native-stream-error" },
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native HTTP error",
          stream: true
        }
      });
      assert.equal(nativeStreamHttpError.status, 429, nativeStreamHttpError.text);
      assert.equal(nativeStreamHttpError.headers.get("x-request-id"), "req-native-stream-error");
      assert.equal(nativeStreamHttpError.json?.native_marker, "preserved");

      const nativeStreamEvent = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native stream error",
          stream: true
        }
      });
      assert.equal(nativeStreamEvent.status, 200, nativeStreamEvent.text);
      assert.match(nativeStreamEvent.text, /"native_marker":"preserved"/);
      assert.doesNotMatch(nativeStreamEvent.text, /event: error/);

      const nativeProviderFailure = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        headers: { "x-request-id": "req-native-provider-failure" },
        json: {
          model: "gpt-5.6-luna",
          input: "trigger failed json"
        }
      });
      assert.equal(nativeProviderFailure.status, 200, nativeProviderFailure.text);
      assert.equal(nativeProviderFailure.headers.get("x-request-id"), "req-native-provider-failure");
      assert.equal(nativeProviderFailure.json?.status, "failed");
      assert.equal(nativeProviderFailure.json?.error?.code, "model_failed");
      assert.match(nativeProviderFailure.text, /^\{\n  "id": "resp-failed-test"/);
      assert.equal(nativeProviderFailure.headers.get("retry-after"), "3");

      const interruptedErrorBody = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger interrupted native HTTP error",
          stream: true
        }
      });
      assert.equal(typeof interruptedErrorBody.json?.error, "object", interruptedErrorBody.text);
      assert.match(interruptedErrorBody.json?.code || "", /^UPSTREAM_/);
      assert.equal(interruptedErrorBody.json?.native_marker, undefined);

      const shimErrorConfig = await ctx.readConfigFile();
      const shimErrorModel = shimErrorConfig.models.find((model) => model.id === "gpt-5.6-luna");
      ensure(shimErrorModel, "Expected GPT-5.6 model config");
      shimErrorModel.routes = { "chat/completions": "responses" };
      const savedShimErrorConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: shimErrorConfig
      });
      assert.equal(savedShimErrorConfig.status, 200, savedShimErrorConfig.text);

      const normalizedShimError = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger native HTTP error" }]
        }
      });
      assert.equal(normalizedShimError.status, 429, normalizedShimError.text);
      assert.equal(normalizedShimError.json?.code, "UPSTREAM_RATE_LIMIT");
      assert.equal(normalizedShimError.json?.native_marker, undefined);

      const routeConfig = await ctx.readConfigFile();
      const routeUpstream = routeConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      routeUpstream.errorPolicy.nativePassthrough = false;
      routeConfig.routing.routeProfiles.responses.nativeErrorPassthrough = true;
      const savedRouteConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: routeConfig
      });
      assert.equal(savedRouteConfig.status, 200, savedRouteConfig.text);

      const routeNativeError = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger native HTTP error"
        }
      });
      assert.equal(routeNativeError.status, 429, routeNativeError.text);
      assert.equal(routeNativeError.json?.native_marker, "preserved");

      const networkConfig = await ctx.readConfigFile();
      const networkUpstream = networkConfig.upstreams.find((upstream) => upstream.name === "mock-foundry");
      networkUpstream.baseUrl = "http://127.0.0.1:1/";
      const savedNetworkConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: networkConfig
      });
      assert.equal(savedNetworkConfig.status, 200, savedNetworkConfig.text);

      const networkFailure = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "network failure must stay normalized"
        }
      });
      assert.equal(networkFailure.status, 502, networkFailure.text);
      assert.equal(typeof networkFailure.json?.error, "object");
      assert.match(networkFailure.json?.code || "", /^UPSTREAM_/);
      assert.equal(networkFailure.json?.requestId != null, true);
    }
  },
  {
    id: "shim-compatibility-guards",
    description: "protocol shims reject lossy modern items while native routes preserve them",
    logLevel: "warn",
    async run(ctx) {
      const shimConfig = await ctx.readConfigFile();
      const gptModel = shimConfig.models.find((model) => model.id === "gpt-5.6-luna");
      ensure(gptModel, "Expected GPT-5.6 model config");
      gptModel.routes = { "*": "responses" };
      shimConfig.compatibility = {
        ...(shimConfig.compatibility || {}),
        protocolShim: {
          rejectLossyRequests: true,
          rejectLossyResponses: true
        }
      };
      const savedShimConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: shimConfig
      });
      assert.equal(savedShimConfig.status, 200, savedShimConfig.text);

      const invalidShimConfig = structuredClone(shimConfig);
      invalidShimConfig.compatibility.protocolShim.rejectLossyRequests = "false";
      const invalidShimResult = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidShimConfig
      });
      assert.equal(invalidShimResult.status, 400, invalidShimResult.text);
      assert.match(invalidShimResult.json?.error || "", /rejectLossyRequests must be a boolean/);

      ctx.clearUpstreamRequests();
      const rejectedResponses = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "chat-only",
          input: [{
            type: "custom_tool_call",
            call_id: "custom_1",
            name: "shell",
            input: "pwd"
          }]
        }
      });
      assert.equal(rejectedResponses.status, 400, rejectedResponses.text);
      assert.equal(rejectedResponses.json?.error?.code, "UnsupportedProtocolShim");
      assert.equal(rejectedResponses.json?.error?.param, "input[0]");
      assert.equal(ctx.upstreamRequests.length, 0, "Rejected Responses shim must not call an upstream");

      const rejectedMessages = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          max_tokens: 64,
          messages: [{
            role: "user",
            content: [{
              type: "document",
              source: { type: "url", url: "https://example.test/manual.pdf" }
            }]
          }]
        }
      });
      assert.equal(rejectedMessages.status, 400, rejectedMessages.text);
      assert.equal(rejectedMessages.json?.error?.code, "UnsupportedProtocolShim");
      assert.equal(rejectedMessages.json?.error?.param, "messages[0].content[0]");
      assert.equal(ctx.upstreamRequests.length, 0, "Rejected Messages shim must not call an upstream");

      const nativeResponses = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: [{
            type: "custom_tool_call",
            call_id: "custom_1",
            name: "shell",
            input: "pwd"
          }]
        }
      });
      assert.equal(nativeResponses.status, 200, nativeResponses.text);
      const nativeResponsesRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(nativeResponsesRequest, "Expected native Responses request");
      assert.equal(nativeResponsesRequest.body?.input?.[0]?.type, "custom_tool_call");

      ctx.clearUpstreamRequests();
      const nativeMessages = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-native",
          max_tokens: 64,
          messages: [{
            role: "user",
            content: [{
              type: "document",
              source: { type: "url", url: "https://example.test/manual.pdf" }
            }]
          }]
        }
      });
      assert.equal(nativeMessages.status, 200, nativeMessages.text);
      const nativeMessagesRequest = ctx.getUpstreamRequest((item) => item.url.includes("/anthropic/v1/messages"));
      ensure(nativeMessagesRequest, "Expected native Messages request");
      assert.equal(nativeMessagesRequest.body?.messages?.[0]?.content?.[0]?.type, "document");

      ctx.clearUpstreamRequests();
      const rejectedResponsesOutput = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger modern Responses item" }]
        }
      });
      assert.equal(rejectedResponsesOutput.status, 502, rejectedResponsesOutput.text);
      assert.equal(rejectedResponsesOutput.json?.error?.code, "UnsupportedProtocolShimResponse");
      assert.equal(rejectedResponsesOutput.json?.error?.param, "output[0]");

      const nativeResponsesOutput = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger modern Responses item"
        }
      });
      assert.equal(nativeResponsesOutput.status, 200, nativeResponsesOutput.text);
      assert.equal(nativeResponsesOutput.json?.output?.[0]?.type, "web_search_call");

      const convertedMessagesOutput = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "trigger modern Messages block",
          include: ["reasoning.encrypted_content"]
        }
      });
      assert.equal(convertedMessagesOutput.status, 200, convertedMessagesOutput.text);
      assert.equal(convertedMessagesOutput.json?.output?.[0]?.type, "reasoning");
      assert.equal(convertedMessagesOutput.json?.output?.[0]?.encrypted_content, "opaque-thinking-state");

      const nativeMessagesOutput = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-native",
          max_tokens: 64,
          messages: [{ role: "user", content: "trigger modern Messages block" }]
        }
      });
      assert.equal(nativeMessagesOutput.status, 200, nativeMessagesOutput.text);
      assert.equal(nativeMessagesOutput.json?.content?.[0]?.type, "redacted_thinking");

      ctx.clearUpstreamRequests();
      const chatUsageStream = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "include converted usage" }],
          stream: true,
          stream_options: { include_usage: true }
        }
      });
      assert.equal(chatUsageStream.status, 200, chatUsageStream.text);
      assert.match(
        chatUsageStream.text,
        /"choices":\[\],"usage":\{"prompt_tokens":10,"completion_tokens":6,"total_tokens":16\}/
      );
      assert.equal((chatUsageStream.text.match(/data: \[DONE\]/g) || []).length, 1);
      const chatUsageUpstream = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(chatUsageUpstream, "Expected include_usage Chat stream to reach Responses");
      assert.equal("stream_options" in chatUsageUpstream.body, false);

      const rejectedResponsesStream = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger modern Responses stream item" }],
          stream: true
        }
      });
      assert.equal(rejectedResponsesStream.status, 200, rejectedResponsesStream.text);
      assert.match(rejectedResponsesStream.text, /unsupported_protocol_shim_stream/);
      assert.equal((rejectedResponsesStream.text.match(/data: \[DONE\]/g) || []).length, 1);

      const nativeResponsesStream = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "trigger modern Responses stream item",
          stream: true
        }
      });
      assert.equal(nativeResponsesStream.status, 200, nativeResponsesStream.text);
      assert.match(nativeResponsesStream.text, /"type":"computer_call"/);
      assert.match(nativeResponsesStream.text, /"type":"response.completed"/);

      const rejectedMessagesStream = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "claude-sonnet-4-6",
          input: "trigger modern Messages stream block",
          stream: true
        }
      });
      assert.equal(rejectedMessagesStream.status, 200, rejectedMessagesStream.text);
      assert.match(rejectedMessagesStream.text, /unsupported_protocol_shim_stream/);
      assert.doesNotMatch(rejectedMessagesStream.text, /"type":"response.completed"/);

      const nativeMessagesStream = await ctx.publicRequest("/v1/messages", {
        method: "POST",
        json: {
          model: "claude-native",
          max_tokens: 64,
          messages: [{ role: "user", content: "trigger modern Messages stream block" }],
          stream: true
        }
      });
      assert.equal(nativeMessagesStream.status, 200, nativeMessagesStream.text);
      assert.match(nativeMessagesStream.text, /"type":"server_tool_use"/);
      assert.match(nativeMessagesStream.text, /"type":"message_stop"/);

      const requestPermissiveConfig = await ctx.readConfigFile();
      requestPermissiveConfig.compatibility.protocolShim.rejectLossyRequests = false;
      const savedRequestPermissiveConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: requestPermissiveConfig
      });
      assert.equal(savedRequestPermissiveConfig.status, 200, savedRequestPermissiveConfig.text);

      ctx.clearUpstreamRequests();
      const lossyRequest = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "chat-only",
          input: [{
            type: "custom_tool_call",
            call_id: "custom_2",
            name: "shell",
            input: "pwd"
          }]
        }
      });
      assert.equal(lossyRequest.status, 200, lossyRequest.text);
      ensure(
        ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions")),
        "Expected lossy request conversion to reach Chat Completions"
      );
      const requestWarnings = await ctx.adminRequest(
        "/admin/api/logs?event=proxy.protocol_shim_lossy_conversion"
      );
      assert.equal(requestWarnings.status, 200, requestWarnings.text);
      const requestWarning = requestWarnings.json.items.find(
        (item) => item.fields.shimPhase === "request"
      );
      ensure(requestWarning, "Expected lossy request warning");
      assert.equal(requestWarning.event, "proxy.protocol_shim_lossy_conversion");
      assert.equal(requestWarning.fields.param, "input[0]");
      assert.equal(requestWarning.sourceProtocol, "responses");
      assert.equal(requestWarning.targetProtocol, "chat/completions");
      assert.match(requestWarning.failureReason, /unsupported Responses item type/);

      const responsePermissiveConfig = await ctx.readConfigFile();
      responsePermissiveConfig.compatibility.protocolShim.rejectLossyResponses = false;
      const savedResponsePermissiveConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: responsePermissiveConfig
      });
      assert.equal(savedResponsePermissiveConfig.status, 200, savedResponsePermissiveConfig.text);

      ctx.clearUpstreamRequests();
      const lossyResponse = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger modern Responses item" }]
        }
      });
      assert.equal(lossyResponse.status, 200, lossyResponse.text);
      assert.equal(lossyResponse.json?.object, "chat.completion");
      const responseWarnings = await ctx.adminRequest(
        "/admin/api/logs?event=proxy.protocol_shim_lossy_conversion"
      );
      assert.equal(responseWarnings.status, 200, responseWarnings.text);
      const responseWarning = responseWarnings.json.items.find(
        (item) => item.fields.shimPhase === "response"
      );
      ensure(responseWarning, "Expected lossy response warning");
      assert.equal(responseWarning.fields.param, "output[0]");
      assert.equal(responseWarning.sourceProtocol, "responses");
      assert.equal(responseWarning.targetProtocol, "chat/completions");
      assert.match(responseWarning.failureReason, /unsupported Responses item type/);

      const lossyResponseStream = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger modern Responses stream item" }],
          stream: true
        }
      });
      assert.equal(lossyResponseStream.status, 200, lossyResponseStream.text);
      assert.doesNotMatch(lossyResponseStream.text, /unsupported_protocol_shim_stream/);
      assert.match(lossyResponseStream.text, /: protocol-shim keep-alive/);
      assert.equal((lossyResponseStream.text.match(/data: \[DONE\]/g) || []).length, 1);
      const streamWarnings = await ctx.adminRequest(
        "/admin/api/logs?event=proxy.protocol_shim_lossy_conversion"
      );
      assert.equal(streamWarnings.status, 200, streamWarnings.text);
      const streamWarning = streamWarnings.json.items.find(
        (item) => item.fields.shimPhase === "stream"
      );
      ensure(streamWarning, "Expected lossy stream warning");
      assert.equal(streamWarning.fields.param, "output[0]");
      assert.equal(streamWarning.sourceProtocol, "responses");
      assert.equal(streamWarning.targetProtocol, "chat/completions");
      assert.match(streamWarning.failureReason, /unsupported Responses item type/);
    }
  },
  {
    id: "message-count-tokens",
    description: "native Anthropic token counting route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31"
        },
        json: {
          model: "claude-native",
          messages: [{ role: "user", content: "Count these tokens" }],
          system: "You count accurately.",
          tools: [{
            name: "lookup",
            description: "Look up a value",
            input_schema: { type: "object", properties: {} }
          }]
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.json, { input_tokens: 42 });
      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/anthropic/v1/messages/count_tokens"));
      ensure(upstreamRequest, "Expected native token-counting upstream request");
      assert.equal(upstreamRequest.body?.model, "claude-native-deployment");
      assert.deepEqual(upstreamRequest.body?.messages, [{ role: "user", content: "Count these tokens" }]);
      assert.equal(upstreamRequest.body?.system, "You count accurately.");
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
      assert.equal(upstreamRequest.headers["anthropic-version"], "2023-06-01");
      assert.equal(upstreamRequest.headers["anthropic-beta"], "prompt-caching-2024-07-31");
      assert.equal(upstreamRequest.headers["x-api-key"], "test-upstream-key");
      assert.notEqual(upstreamRequest.headers.authorization, "Bearer test-client-key");

      await new Promise((resolve) => setTimeout(resolve, 10));
      const stats = await ctx.adminRequest("/admin/api/stats");
      assert.equal(stats.status, 200, stats.text);
      assert.equal(stats.json?.totals?.promptTokens, 0);
      assert.equal(stats.json?.totals?.completionTokens, 0);
      assert.equal(stats.json?.totals?.totalTokens, 0);
      assert.equal(stats.json?.totals?.cachedTokens, 0);

      const config = await ctx.readConfigFile();
      const anthropicUpstream = config.upstreams.find((upstream) => upstream.name === "mock-anthropic");
      ensure(anthropicUpstream, "Expected mock Anthropic upstream");
      anthropicUpstream.routes["messages/count_tokens"] = "/anthropic/v1/messages/count_tokens?deployment={deployment}";
      const explicitRouteConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(explicitRouteConfig.status, 200, explicitRouteConfig.text);

      ctx.clearUpstreamRequests();
      const explicitRoute = await ctx.publicRequest("/v1/messages/count_tokens", {
        method: "POST",
        json: {
          model: "claude-native",
          messages: [{ role: "user", content: "Use the explicit route" }]
        }
      });
      assert.equal(explicitRoute.status, 200, explicitRoute.text);
      const explicitUpstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/messages/count_tokens"));
      ensure(explicitUpstreamRequest, "Expected explicitly configured token-counting request");
      assert.equal(
        new URL(explicitUpstreamRequest.url, "http://mock").searchParams.get("deployment"),
        "claude-native-deployment"
      );

      ctx.clearUpstreamRequests();
      const invalidPayload = await ctx.publicRequest("/v1/messages/count_tokens", {
        method: "POST",
        json: {
          model: "claude-native",
          messages: [{ role: "user", content: "Reject malformed provider payloads" }],
          system: "trigger invalid token count"
        }
      });
      assert.equal(invalidPayload.status, 502, invalidPayload.text);
      assert.equal(invalidPayload.json?.error?.code, "InvalidTokenCountResponse");

      ctx.clearUpstreamRequests();
      const unsupported = await ctx.publicRequest("/v1/messages/count_tokens", {
        method: "POST",
        json: {
          model: "chat-only",
          messages: [{ role: "user", content: "Do not shim this request" }]
        }
      });
      assert.equal(unsupported.status, 400, unsupported.text);
      assert.equal(unsupported.json?.error?.code, "TokenCountingNotSupported");
      assert.equal(ctx.upstreamRequests.length, 0, "Unsupported token counting must not call an upstream");

      const disabledConfig = await ctx.readConfigFile();
      disabledConfig.compatibility.claudeCode.enabled = false;
      disabledConfig.routing.routeProfiles.messages.enabled = false;
      const savedDisabledConfig = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: disabledConfig
      });
      assert.equal(savedDisabledConfig.status, 200, savedDisabledConfig.text);

      ctx.clearUpstreamRequests();
      const disabled = await ctx.publicRequest("/v1/messages/count_tokens", {
        method: "POST",
        json: {
          model: "claude-native",
          messages: [{ role: "user", content: "Messages is disabled" }]
        }
      });
      assert.equal(disabled.status, 404, disabled.text);
      assert.equal(disabled.json?.error?.code, "RouteDisabled");
      assert.equal(ctx.upstreamRequests.length, 0, "Disabled token counting must not call an upstream");
    }
  },
  {
    id: "invalid-protocol-route",
    description: "arbitrary aliases and direct model route paths are rejected during config validation",
    async run(ctx) {
      const config = await ctx.readConfigFile();
      const model = config.models.find((item) => item.id === "chat-only");
      ensure(model, "Expected chat-only model config");
      const originalRoutes = structuredClone(model.routes);

      model.routes = { "*": "unknown-protocol" };
      const invalidAlias = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(invalidAlias.status, 400, invalidAlias.text);
      assert.match(invalidAlias.json?.error || "", /route target "unknown-protocol".*gpt-4o-mini/);

      model.routes = { "*": "/openai/v1/responsez" };
      const invalidPath = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(invalidPath.status, 400, invalidPath.text);
      assert.match(invalidPath.json?.error || "", /route target "\/openai\/v1\/responsez".*gpt-4o-mini/);

      const persistedConfig = await ctx.readConfigFile();
      const persistedModel = persistedConfig.models.find((item) => item.id === "chat-only");
      assert.deepEqual(persistedModel?.routes, originalRoutes);

      const invalidRouteShapeConfig = await ctx.readConfigFile();
      const disabledModel = invalidRouteShapeConfig.models.find((item) => item.id === "chat-only");
      ensure(disabledModel, "Expected chat-only model config");
      disabledModel.status = "disabled";
      disabledModel.routes = [];
      const invalidRouteShape = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidRouteShapeConfig
      });
      assert.equal(invalidRouteShape.status, 400, invalidRouteShape.text);
      assert.match(invalidRouteShape.json?.error || "", /models\[\d+\]\.routes must be an object/);

      const invalidUpstreamRouteShapeConfig = await ctx.readConfigFile();
      const invalidUpstream = invalidUpstreamRouteShapeConfig.upstreams.find((item) => item.name === "mock-foundry");
      ensure(invalidUpstream, "Expected mock Foundry upstream config");
      invalidUpstream.routes = [];
      const invalidUpstreamRouteShape = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: invalidUpstreamRouteShapeConfig
      });
      assert.equal(invalidUpstreamRouteShape.status, 400, invalidUpstreamRouteShape.text);
      assert.match(invalidUpstreamRouteShape.json?.error || "", /upstreams\[\d+\]\.routes must be an object/);

      ctx.clearUpstreamRequests();
      const incompatibleEndpoint = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-image-1.5",
          messages: [{ role: "user", content: "This model only supports image generation." }]
        }
      });
      assert.equal(incompatibleEndpoint.status, 400, incompatibleEndpoint.text);
      assert.equal(incompatibleEndpoint.json?.code, "UNSUPPORTED_PROTOCOL_ROUTE");
      assert.equal(ctx.upstreamRequests.length, 0);
    }
  },
  {
    id: "gpt-5.6-chat-stream",
    description: "native GPT-5.6 Chat stream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "use the lookup tool" }],
          tools: [{
            type: "function",
            function: {
              name: "lookup",
              description: "Look up a value",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"]
              }
            }
          }],
          reasoning_effort: "max",
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.headers.get("content-type") || "", /^text\/event-stream/);
      assert.match(result.text, /ok from mock chat stream/);
      assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/chat/completions"));
      ensure(upstreamRequest, "Expected GPT-5.6 request to use the Chat Completions upstream");
      assert.equal(upstreamRequest.body?.model, "gpt-5.6-luna");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.equal(upstreamRequest.body?.reasoning_effort, "max");
      assert.equal(upstreamRequest.body?.tools?.[0]?.function?.name, "lookup");
      assert.deepEqual(upstreamRequest.body?.messages, [{ role: "user", content: "use the lookup tool" }]);
      assert.equal("input" in upstreamRequest.body, false);
      assert.equal("reasoning" in upstreamRequest.body, false);
    }
  },
  {
    id: "gpt-5.6-responses-stream",
    description: "native GPT-5.6 Responses stream",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/responses", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          input: "stream a short response",
          tools: [{
            type: "function",
            name: "lookup",
            description: "",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"]
            }
          }],
          reasoning: { effort: "max" },
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.headers.get("content-type") || "", /^text\/event-stream/);
      assert.match(result.text, /"type":"response.output_text.delta"/);
      assert.match(result.text, /"type":"response.completed"/);
      assert.doesNotMatch(result.text, /"object":"chat.completion.chunk"/);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected native GPT-5.6 Responses upstream request");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.deepEqual(upstreamRequest.body?.reasoning, { effort: "max" });
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
      assert.equal(upstreamRequest.body?.tools?.[0]?.description, "lookup");
    }
  },
  {
    id: "openai-image",
    description: "openai-image route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/images/generations", {
        method: "POST",
        json: {
          model: "gpt-image-1.5",
          prompt: "draw a cat",
          size: "1024x1024",
          quality: "hd",
          response_format: "b64_json"
        }
      });

      assert.equal(result.status, 200, result.text);
      ensure(Array.isArray(result.json?.data), "Expected generated image data array");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/deployments/gpt-image-1.5/images/generations"));
      ensure(upstreamRequest, "Expected deployment image generation upstream request");
      assert.equal(upstreamRequest.body?.quality, "high");
      assert.equal("model" in upstreamRequest.body, false);
      assert.equal("response_format" in upstreamRequest.body, false);
    }
  },
  {
    id: "blackforest-image",
    description: "blackforest-image route",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/images/generations", {
        method: "POST",
        json: {
          model: "flux-2-pro",
          prompt: "draw a forest",
          size: "1024x1024",
          response_format: "url",
          background: "transparent"
        }
      });

      assert.equal(result.status, 200, result.text);
      ensure(Array.isArray(result.json?.data), "Expected generated image data array");

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/providers/blackforestlabs/v1/flux-2-pro"));
      ensure(upstreamRequest, "Expected Black Forest Labs upstream request");
      assert.equal(upstreamRequest.body?.width, 1024);
      assert.equal(upstreamRequest.body?.height, 1024);
      assert.equal("size" in upstreamRequest.body, false);
      assert.equal("background" in upstreamRequest.body, false);
    }
  }
];

export function getRouteTest(id) {
  return routeTests.find((item) => item.id === id) || null;
}