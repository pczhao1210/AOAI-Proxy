import assert from "node:assert/strict";
import { ensure } from "./harness.js";

export const routeTests = [
  {
    id: "version",
    description: "public build version metadata",
    async run(ctx) {
      const result = await ctx.request("/version");

      assert.equal(result.status, 200, result.text);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.deepEqual(result.json, {
        service: "aoai-proxy",
        version: "nextgen-202608100000",
        buildTime: "2026-08-10T00:00:00Z"
      });
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
      assert.deepEqual(codexModel.supported_reasoning_levels.map((item) => item.effort), ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(codexModel.support_verbosity, false);
      assert.equal(codexModel.use_responses_lite, false);
      assert.equal(result.json.models.some((model) => model.slug === "gpt-5-mini"), false);
      assert.equal(result.json.models.some((model) => model.slug === "claude-sonnet-4-6"), false);
      assert.equal(result.json.models.some((model) => model.slug === "chat-only"), false);
      assert.equal(result.json.models.some((model) => model.slug === "gpt-image-1.5"), false);

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

      codexModel.routes = { "*": "responses" };
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
      assert.match(unknownResponsesPath.json?.error || "", /marked for Codex.*resolves to unknown/);
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
      codexModel.routes = { "*": "responses" };
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
      assert.match(claudeModelRouter.json?.error || "", /marked for Claude Code.*resolves to chat\/completions/);
      claudeModel.targetModel = originalClaudeTargetModel;

      claudeModel.routes = { "*": "responses" };
      const invalidClaude = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(invalidClaude.status, 400, invalidClaude.text);
      assert.match(invalidClaude.json?.error || "", /marked for Claude Code.*native messages is required/);

      const claudeUpstream = config.upstreams.find((upstream) => upstream.name === claudeModel.upstream);
      ensure(claudeUpstream, "Expected Claude Code model upstream");
      claudeUpstream.routes.messagez = "/custom/messages";
      claudeModel.routes = { "*": "messagez" };
      const unknownClaudeProtocol = await ctx.adminRequest("/admin/api/config", {
        method: "PUT",
        headers: { "x-aoai-admin-csrf": "1" },
        json: config
      });
      assert.equal(unknownClaudeProtocol.status, 400, unknownClaudeProtocol.text);
      assert.match(unknownClaudeProtocol.json?.error || "", /marked for Claude Code.*resolves to messagez/);

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
    description: "known Claude models validate thinking mode",
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

      assert.equal(result.status, 400, result.text);
      assert.equal(result.json?.error?.param, "thinking.type");
      assert.match(result.json?.error?.message || "", /adaptive/);
      assert.equal(ctx.upstreamRequests.length, 0);

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
      ensure(aliasRequest, "Expected custom Claude deployment request");
      assert.deepEqual(aliasRequest.body?.thinking, { type: "enabled", budget_tokens: 1024 });
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
          input: "hello",
          max_output_tokens: 64,
          stream: true
        }
      });

      assert.equal(result.status, 200, result.text);
      assert.match(result.text, /"type":"response.output_text.delta"/);
      assert.match(result.text, /ok from mock messages stream/);
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
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "gpt-5.6-luna",
          messages: [{ role: "user", content: "trigger failed json" }]
        }
      });

      assert.equal(result.status, 502, result.text);
      assert.equal(result.json?.code, "UPSTREAM_PROVIDER_RESPONSE_ERROR");
      assert.equal(result.json?.error?.code, "model_failed");
      assert.match(result.json?.error?.message || "", /mock JSON response failed/);
    }
  },
  {
    id: "invalid-protocol-route",
    description: "unknown text backend protocols are rejected",
    async run(ctx) {
      ctx.clearUpstreamRequests();
      const result = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "invalid-protocol-route",
          messages: [{ role: "user", content: "hello" }]
        }
      });

      assert.equal(result.status, 400, result.text);
      assert.equal(result.json?.code, "UNSUPPORTED_PROTOCOL_ROUTE");
      assert.equal(ctx.upstreamRequests.length, 0);

      const invalidPathResult = await ctx.publicRequest("/v1/chat/completions", {
        method: "POST",
        json: {
          model: "invalid-protocol-path",
          messages: [{ role: "user", content: "hello" }]
        }
      });

      assert.equal(invalidPathResult.status, 400, invalidPathResult.text);
      assert.equal(invalidPathResult.json?.code, "UNSUPPORTED_PROTOCOL_ROUTE");
      assert.equal(ctx.upstreamRequests.length, 0);
    }
  },
  {
    id: "gpt-5.6-chat-stream",
    description: "GPT-5.6 Chat stream through Responses upstream",
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
      assert.match(result.text, /ok from mock responses stream/);
      assert.equal((result.text.match(/data: \[DONE\]/g) || []).length, 1);

      const upstreamRequest = ctx.getUpstreamRequest((item) => item.url.includes("/openai/v1/responses"));
      ensure(upstreamRequest, "Expected GPT-5.6 request to use the Responses upstream");
      assert.equal(upstreamRequest.body?.model, "gpt-5.6-luna");
      assert.equal(upstreamRequest.body?.stream, true);
      assert.deepEqual(upstreamRequest.body?.reasoning, { effort: "max" });
      assert.equal(upstreamRequest.body?.tools?.[0]?.name, "lookup");
      assert.equal("messages" in upstreamRequest.body, false);
      assert.equal("reasoning_effort" in upstreamRequest.body, false);
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