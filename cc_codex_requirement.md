# Claude Code 与 OpenAI Codex 兼容性审计

> 审计日期：2026-08-10  
> 审计对象：当前仓库、`anthropics/claude-code`、`openai/codex` 及两者官方协议/配置说明  
> 本文只评价客户端到本代理的协议兼容性；模型本身是否支持某项能力，仍取决于实际上游、部署版本和 Azure 配额。

## 1. 结论

当前仓库**已经完成 Claude Code 与 Codex 的 P0 核心协议适配，可以同时承接两个固定版本客户端的基础 HTTP/SSE 工作流，但还不能宣称覆盖两者全部高级能力**。

推荐的生产路由是：

- Claude Code -> 本代理 `/v1/messages` -> 原生 Anthropic Messages 上游。
- Codex -> 本代理 `/v1/responses` -> 原生 OpenAI Responses 上游。
- 不要把 Messages、Responses、Chat Completions 之间的 shim 当作协议等价实现。shim 适合基础文本和普通函数工具的降级场景，不适合作为两个 CLI 的默认生产路径。

综合评级：

| 客户端与路径 | 当前评级 | 结论 |
| --- | --- | --- |
| Claude Code -> 原生 Messages | **核心兼容** | Claude Code `2.1.226` 的真实单轮流式请求已通过；动态 beta、SDK 元数据、模型映射、凭据隔离和原生 token counting 均已验证。高级工具/缓存/异常矩阵仍需扩展。 |
| Claude Code -> Responses/Chat shim | **有限兼容** | 可转换基础文本和函数工具，但会丢失部分 Anthropic 特有字段、内容块和缓存/思考语义。 |
| Codex -> 原生 Responses | **核心兼容** | Codex `0.147.0` 的专用模型目录、合法 Responses item 生命周期、顶层终态、文本输出和凭据隔离已通过真实 CLI 验证。原生 compact API 已覆盖，但该固定版本自定义 provider 是否自动调用尚未验证；WebSocket 和部分现代 item 仍未覆盖。 |
| Codex -> Messages/Chat shim | **有限兼容，不建议生产使用** | 不能保持完整 Responses item、会话连续性、内置工具及加密 reasoning 等语义。 |

因此，对“是否能够满足这两个工具的请求和正常响应”的直接回答是：

- **固定版本的基础交互可以满足**，前提是每类模型显式标记并路由到对应的原生协议上游。
- Claude Code 的 header/beta 前向兼容、Codex 专用模型目录、Responses 严格终态和配置路由门禁已经实现。
- **所有高级能力仍不能一概保证正常**。真实 CLI 的多轮、工具、thinking/reasoning、缓存、取消和错误矩阵尚未全部完成；Codex 自动触发远端 compact 和 Responses WebSocket 仍属于后续能力。

## 2. 审计依据和范围

外部依据：

- [anthropics/claude-code](https://github.com/anthropics/claude-code)
- [Claude Code LLM gateway 文档](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)
- [Anthropic streaming Messages](https://docs.anthropic.com/en/api/messages-streaming)
- [openai/codex](https://github.com/openai/codex)
- [Codex configuration](https://developers.openai.com/codex/config-reference/)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)

仓库内重点检查：

- `src/server.js`：公开路由、客户端鉴权、模型列表。
- `src/proxy.js`：模型路由、请求策略、上游鉴权、原生透传和错误处理。
- `src/proxy/body.js`：入站 header 清洗及转发策略。
- `src/proxy/shim.js`：Messages、Responses、Chat Completions 的跨协议转换。
- `src/proxy/stream.js`：原生 SSE 透传、跨协议流转换、usage 和终止事件。
- `config/sample_config.json`：默认 header、beta、thinking 和代理策略。
- `test/lib/route-definitions.js`：现有路由及流式契约测试。

本次没有把“接口返回 HTTP 200”视为兼容。判断还包括：请求字段保真、工具调用闭环、SSE 事件顺序、终止语义、错误语义和多轮上下文是否可持续。

## 3. 已满足的核心兼容点

### 3.1 公共端点与鉴权

- 已提供 Claude Code 核心端点 `POST /v1/messages`。
- 已提供 Codex 核心端点 `POST /v1/responses`。
- 同时接受 `Authorization: Bearer <key>` 和 `x-api-key: <key>`，可以分别承接 Codex 和 Claude Code 常见鉴权方式。
- 客户端凭据不会直接作为上游凭据复用；代理会按配置生成 Azure API Key、Bearer token 或其他上游鉴权头。
- 已提供模型发现接口，并会按消费者权限过滤模型。它可以返回标准 OpenAI `data`、Anthropic `data`，也可根据 Codex User-Agent 或 `format=codex` 返回专用 `models` 目录。
- Claude Code User-Agent 或 `format=claude-code` 只发现已标记且原生路由到 Messages 的模型；Codex 目录同样只发布已标记且原生路由到 Responses 的模型。模型 ID 必须唯一，避免目录与运行时解析分裂。

### 3.2 原生协议请求

- 当公开路由与模型后端路由一致时，请求体以原对象为基础转发，并只进行模型部署名替换、兼容性规范化及配置策略处理。
- 原生 Messages 路径支持 `system`、`messages`、`tools`、`tool_choice`、`thinking`、`stream` 等核心字段。
- 原生 Responses 路径支持 `input`、`instructions`、`tools`、`tool_choice`、`reasoning`、`include`、`store`、`prompt_cache_key`、`previous_response_id`、`conversation`、`stream` 等字段的主体保留。
- Responses 函数工具缺少 description 时会补充非空描述，可兼容部分 Azure Responses 校验要求。
- 代理支持模型 ID 到实际 deployment/target model 的映射，因此 CLI 可以使用稳定别名。

注意：原生路径也不是绝对字节级请求透传。`serviceTier` 会规范化为 `service_tier`；`service_tier`、`verbosity` 和 `top_k` 默认保留。route/model/upstream 的字段白名单或黑名单仍可明确拒绝或删除参数。

### 3.3 SSE 与正常响应

- 原生 Messages 和 Responses 流均走 SSE 处理，并保留各自协议的核心事件。
- Messages 覆盖 `message_start`、`content_block_start/delta/stop`、`message_delta`、`message_stop`，包括文本、thinking 和增量工具参数。
- Responses 覆盖 `response.created/in_progress/completed/incomplete/failed`、文本 delta、output item、函数参数 delta、reasoning summary 等核心事件。
- 跨协议流可以生成目标协议所需的开始、内容、工具和完成事件。
- 客户端断开时会中止上游请求；首字节前可按策略重试，流已经开始后不会重放，避免重复输出和重复工具调用。
- 非流式成功响应在原生路径保持原协议 JSON；代理还会记录 usage，缺失时仅对内部计量做本地估算，不会把估算 usage 注入原响应。
- 合法的 Responses item 生命周期经原生透传后，Codex `0.147.0` 能生成 `agent_message`、读取 usage 并正常完成 turn。

### 3.4 基础 agentic 工具调用

- 普通 JSON Schema 函数工具可在 Messages、Responses 和 Chat Completions 之间转换。
- 支持 `tool_use` / `tool_result`、Responses `function_call` / `function_call_output` 和 Chat `tool_calls` 的基础映射。
- 流式函数参数支持增量拼接和目标协议完成事件，具备 CLI 执行本地工具后继续下一轮请求的基础条件。

## 4. 特殊点和使用边界

### 4.1 必须优先使用原生协议路由

路由由公开 route、模型 `routes` 和 upstream `routes` 共同决定。建议确保：

```json
{
  "models": [
    {
      "id": "claude-sonnet",
      "targetModel": "<anthropic-deployment>",
      "routes": { "*": "messages" }
    },
    {
      "id": "gpt-codex",
      "targetModel": "<openai-deployment>",
         "routes": {}
    }
  ]
}
```

实际配置还必须引用对应 upstream；上例只强调协议选择。双协议模型应保持 wildcard route 为空，使 Chat 与 Responses 客户端分别走原生入口；只有 Responses-only 模型才需要全局映射到 Responses。若把 Claude 模型路由到 Responses，或把 Codex 的 Responses 入口路由到 Messages/Chat，代理会启用 shim，能力评级随即降为“有限兼容”。

### 4.2 Claude Code 的 beta/header 是开放集合

Claude Code 会随版本使用新的 `anthropic-beta` 值和新的 Anthropic/SDK 元数据头。官方网关原则是：除凭据等 hop-by-hop/敏感头外，网关应允许这些协议头前向兼容地传递，而不是要求每次发布都更新固定列表。

`compatibility.claudeCode.enabled` 默认开启，并只在 Messages 路径扩展安全 header 前缀。凭据、hop-by-hop header 和显式 denylist 仍优先阻断。

- 对直接 Anthropic upstream，未知 beta 会按原顺序透传并去重，适应后续 Claude Code 版本。
- 对 Azure/Foundry Messages upstream，继续使用独立的静态 allowlist；被过滤值写入 `proxy.anthropic_betas_filtered` 结构化日志，不再静默丢弃。
- Claude Code `2.1.226` 实测中的 `thinking-token-count-2026-05-13`、`prompt-caching-scope-2026-01-05`、`mid-conversation-system-2026-04-07` 和 `effort-2025-11-24` 均能在直接 Anthropic 路径保留。

静态模型 thinking allowlist 仍可能随上游版本漂移，需要持续维护或在 P2 改为能力探测。

### 4.3 Codex 只应配置 Responses wire API

Codex 自定义 provider 应明确设置 `wire_api = "responses"`。当前 Codex 已移除 Chat wire API，配置为 `chat` 会直接报错；现代 Codex 的 reasoning、工具 item、会话续接和压缩都围绕 Responses 契约。

原生 Responses 路径会保留大多数 Codex 字段，但 shim 明确删除或降级 `include`、`store`、`prompt_cache_key`、`previous_response_id`、`conversation`、`context_management`、`background` 等字段，因此不能保证会话续接、加密 reasoning 或缓存行为。

### 4.4 Codex `/models` 不是标准 OpenAI 模型列表

Codex `0.147.0` 在启用远端目录刷新时会请求 `<base_url>/models`，并按专用 `ModelsResponse` 解析。普通 `env_key` 自定义 provider 在干净状态下可能直接使用内置目录；该版本的远端刷新条件包括 Codex backend auth 或 command-backed provider auth。代理现已根据 Codex User-Agent 或 `format=codex` 返回顶层 `models` 和完整 `ModelInfo`，同时保留标准 OpenAI 与 Anthropic 模型列表格式。

Codex 目录只暴露 `clientCompatibility.codex=true` 且原生路由到 Responses 的模型。默认 context window 为 128K；可通过 `models[].codex` 覆盖描述、context window、reasoning 档位和优先级。代理不会复制 Codex 内置 base instructions，避免客户端与服务端提示重复。

### 4.5 错误不是完全透明透传

上游非 2xx 响应会保留 HTTP 状态，并提取上游 `message`、`type`、`code`、`param`，但响应会被包装为代理统一错误结构。基础 CLI 提示和重试通常可工作；若 Claude Code 或 Codex 根据某个 provider 的完整错误 JSON/文本做能力降级，行为可能与直连不同。

### 4.6 能力声明不能替代上游能力

配置允许为模型声明 web search、thinking、图片等能力，代理还会做部分规范化和预检查。这只能控制转发策略，不能让不支持该能力的 deployment 获得能力。模型别名、pricingRef 和 targetModel 也必须与实际上游版本同步。

## 5. 客户端最小配置

### 5.1 Claude Code

建议通过环境变量连接代理，并显式设置模型别名：

```bash
export ANTHROPIC_BASE_URL="https://<proxy-host>"
export ANTHROPIC_AUTH_TOKEN="<proxy-api-key>"
export ANTHROPIC_MODEL="<messages-model-id>"
export ANTHROPIC_DEFAULT_SONNET_MODEL="<messages-model-id>"
export ANTHROPIC_DEFAULT_OPUS_MODEL="<messages-model-id>"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="<messages-model-id>"
```

要求：

- `ANTHROPIC_BASE_URL` 指向代理根地址，不要重复追加 `/v1/messages`。
- `<messages-model-id>` 必须存在于代理配置，消费者有权限访问，并原生路由到 `messages`。
- 不要把真实上游 Anthropic/Azure key 配到 Claude Code；这里只使用代理消费者 key。
- 如客户端选择发送 `x-api-key` 而非 Bearer，当前代理同样可以鉴权。

### 5.2 Codex

在 `~/.codex/config.toml` 中配置自定义 provider：

```toml
model = "<responses-model-id>"
model_provider = "aoai_proxy"

[model_providers.aoai_proxy]
name = "AOAI Proxy"
base_url = "https://<proxy-host>/v1"
env_key = "AOAI_PROXY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

然后设置代理消费者 key：

```bash
export AOAI_PROXY_API_KEY="<proxy-api-key>"
```

要求：

- `base_url` 应包含 `/v1`，Codex 会在其后请求 `/responses`。
- `<responses-model-id>` 必须设置 `clientCompatibility.codex=true` 并原生路由到 `responses`。
- 建议显式设置 `model`；代理 `/models` 已能返回 Codex 专用模型目录，不再需要额外 `model_catalog_json` 来规避解析告警。
- 保持 `supports_websockets = false`。代理已提供原生 `/v1/responses/compact`，但 Codex `0.147.0` 的自定义 provider 没有独立 compact 能力开关；不要通过伪装 provider 名称或地址来强制启用未经真实 CLI 验证的远端 compact。
- 代理已负责首字节前重试，示例关闭 Codex 的 request/stream 重试，避免多层重试放大流量。若要在客户端恢复重试，必须先验证工具调用幂等性和总超时。

## 6. 实施状态与待办

### 6.1 状态总览

| 工作流 | 状态 | 已完成 | 待完成 |
| --- | --- | --- | --- |
| P0 核心协议兼容 | **已完成** | 固定版本原生文本流、header/beta、模型目录、路由门禁、严格终态和凭据隔离 | 无 P0 阻塞项 |
| P1 常用高级能力 | **已完成** | token counting、Responses compact、严格 shim 门禁、参数 policy、可选原生错误透传 | 无 P1 实现阻塞项 |
| 真实 CLI 扩展矩阵 | **部分完成** | Claude Code `2.1.226` 与 Codex `0.147.0` 单轮原生文本流 smoke | 多轮、普通/并行工具、thinking/reasoning、缓存、取消和错误矩阵 |
| 真实上游能力验证 | **部分完成** | 代理级 mock/contract 覆盖和官方协议依据 | 在实际 Anthropic/Azure/OpenAI deployment 验证 utility endpoint、参数 policy 与错误透传 |
| P2 未来能力 | **待开始** | 已保留原生协议和配置扩展边界 | Responses WebSocket、能力探测/版本矩阵、自动发布门禁 |

### 6.2 已完成

- **P0 核心验收已关闭**：Claude Code 与 Codex 的固定版本原生 HTTP/SSE 基础工作流、模型发现、路由约束和安全边界均有自动化及真实 CLI smoke 证据。
- **P1 四项均已完成**：`messages/count_tokens`、`responses/compact`、现代 item/content 的无损 shim 门禁，以及显式参数/错误保真策略。
- **回归基线已建立**：93/93 单元测试、32/32 路由契约、两条固定版本 CLI smoke 和管理端生产构建均通过。
- **通用兼容性边界已明确**：原生路径透明保留未知结构；shim 只承诺基础文本、URL/base64 图片和普通 function tool 的有限兼容，其他结构明确失败。

### 6.3 待完成

按优先级建议继续：

1. **真实 CLI agentic 闭环**：先补 Codex，再补 Claude Code 的多轮、普通函数工具和并行函数工具执行/回传。
2. **真实 CLI 高级语义**：thinking/reasoning、prompt cache、客户端取消、429/5xx、流中错误和缺失终态。
3. **真实上游验证**：对实际部署验证 `count_tokens`、`responses/compact`、参数保留/阻断 policy、原生错误透传及计量结果。
4. **Codex 远端 compact**：确认 Codex `0.147.0` 是否自动调用端点，并验证压缩后续接和恢复语义。
5. **P2 实现**：Responses WebSocket、上游能力/版本探测，以及升级客户端或 API 版本时自动运行双 CLI smoke 的发布门禁。

### 6.4 当前非阻塞项

- 长上下文极限、真实缓存命中率以及所有未来 beta/item 的穷举验证高度依赖上游版本和配额，不作为当前 P0/P1 阻塞项。
- shim 不追求成为 Messages、Responses 与 Chat Completions 的协议等价层；无法无损转换的能力保持明确拒绝。
- 在真实 Codex 自动触发与恢复测试通过前，只声明 `/responses/compact` API 可用，不声明 Codex CLI 已自动启用远端压缩。

### P0：当前实施状态

1. **[已完成] 重做 Anthropic header/beta 策略**
   - 入站 header 先受全局 allowlist/denylist 策略约束；Messages 兼容仅额外开放 Claude/Stainless 元数据前缀，任何含凭据语义的 header 仍优先阻断。
   - 原生 Anthropic upstream 保留完整 `anthropic-beta`；Azure/Foundry Messages upstream 只保留已审查 beta，并记录被过滤值。
   - beta 解析需支持逗号分隔、去重和原顺序，不应把未知值默认视为非法。

2. **[已完成] 增加 Codex 专用模型目录响应**
   - 对 Codex `/models` 请求返回 `{ "models": [...] }` 和完整 `ModelInfo`，不能复用只有 ID 的标准 OpenAI 列表。
   - 通过 User-Agent 或显式 `format=codex` query 选择方言，同时保留现有 OpenAI、Anthropic 列表。
   - 模型 metadata 必须来自代理配置和能力矩阵，并与实际 deployment 同步。

3. **[核心已完成，扩展矩阵待完成] 扩展真实 CLI 契约测试**
   - 已固定 Claude Code `2.1.226` 和 Codex `0.147.0`，并提供 `npm run test:cli:claude-code`、`npm run test:cli:codex`。
   - 两条 smoke 均断言客户端输出、上游原生协议请求、SSE 生命周期、模型发现/header 和凭据隔离。
   - 尚需补齐真实 CLI 的多轮、普通/并行工具、长上下文、thinking/reasoning、缓存、客户端取消、429/5xx、流中错误和缺失终止事件矩阵；其中错误终态和取消已有代理级自动化覆盖。

4. **[已完成] 收紧 Responses SSE 终止契约并修正测试夹具**
   - Responses 必须以 `response.completed`、`response.incomplete` 或 `response.failed` 之一结束；Messages 必须以 `message_stop` 或 `error` 结束。
   - Codex 兼容开启时不再把 output done 当作顶层终态；关闭该开关时保留旧版兼容兜底。
   - Responses mock 已补齐 `output_item.added`、content part、`output_item.done` 和 `response.completed`。

5. **[已完成] 锁定原生路由并做启动校验**
   - 为标记为 Claude Code/Codex 的模型校验 backend route，避免配置失误后静默启用 shim。
   - 管理界面可设置两个全局开关和每模型标记，并显示“原生”或“协议转换”状态；配置还拒绝重复模型 ID、关闭的公开协议和协议键/实际 URL 不一致。

P0 按“核心协议门禁”验收为已完成。第 3 项的固定版本单轮 CLI smoke 已满足 P0；多轮、函数/并行工具、reasoning、取消、429/5xx、流中错误和缺失终止事件仍是高价值后续门禁。长上下文极限、真实缓存命中和所有未来 beta/item 的穷举验证高度依赖上游版本与配额，不要求作为 P0 阻塞项。

### P1：补齐常用高级能力

1. **[已完成] 实现 `POST /v1/messages/count_tokens`**
   - 对所有原生 Messages 模型开放，不要求模型额外标记 `clientCompatibility.claudeCode=true`，避免把通用 Anthropic API 能力绑定到单一客户端。
   - 请求复用模型权限、deployment 映射、Anthropic header/beta 策略、上游鉴权、大小限制、治理、超时、重试和错误包装；响应保留上游 `{ "input_tokens": number }`，但不记为生成 usage 或费用。
   - 优先使用 `upstreams[].routes["messages/count_tokens"]`；缺省时仅从合法的原生 Messages URL 追加 `/count_tokens`。跨协议模型明确返回 `TokenCountingNotSupported`，不会进入 shim，也不会用本地估算伪造精确值。
   - 已覆盖直接 Anthropic、显式上游路径、模型映射、system/tools、beta/header、凭据隔离、畸形响应、关闭路由和 no-shim 门禁。

2. **[已完成] 实现 `POST /v1/responses/compact`**
   - 对所有原生 Responses 模型开放，不要求模型标记 `clientCompatibility.codex=true`，避免把通用 Responses 能力绑定到单一客户端。
   - 优先使用 `upstreams[].routes["responses/compact"]`；缺省时仅从合法的原生 Responses URL 追加 `/compact`。Chat/Messages 后端明确返回 `ResponseCompactionNotSupported`，不会进入 shim。
   - 原样返回 `response.compaction`、加密 compaction item 和官方 usage；compaction usage 正常进入计量与成本记录。已覆盖显式路径、deployment 映射、凭据隔离、畸形响应、关闭路由和 no-shim 门禁。
   - Microsoft Learn 已确认 Azure OpenAI `/openai/v1/responses/compact` 支持。当前只声明 API 可用；Codex `0.147.0` 自定义 provider 是否自动调用仍需长上下文真实 CLI 验证。

3. **[已完成] 扩展 Responses item 和 Anthropic content block 覆盖**
   - 原生 HTTP/JSON 与 SSE 路径继续透明保留未知 item、未知事件和 content block，不把客户端能力限制在代理已知集合内。
   - 跨协议请求在访问上游前校验可表示性；默认无法无损转换时返回 `400 UnsupportedProtocolShim`。跨协议非流式响应默认返回 `502 UnsupportedProtocolShimResponse`；流式响应发送目标协议错误帧并按该协议正常结束连接。
   - `compatibility.protocolShim.rejectLossyRequests` 与 `rejectLossyResponses` 可独立关闭严格门禁。兼容模式继续尽力转换，并通过 `proxy.protocol_shim_lossy_conversion` 记录阶段、字段路径、协议方向和丢失原因；默认值均为 `true`。
   - Chat 转 Responses/Messages 的流式 shim 会消费标准 `stream_options.include_usage`，并在 `[DONE]` 前生成 `choices: []` 的 Chat usage chunk；未知 stream option 仍进入有损门禁。
   - 已明确覆盖 `custom_tool_call/output`、`web_search_call`、`computer_call/output`、`shell/local_shell`、MCP、文件引用、引用/annotations、reasoning、compaction、Anthropic document/file image、server tool、redacted thinking 和 tool error 状态。
   - 同时拒绝会改变控制流但曾被静默删除的会话状态、非默认工具上限、多候选、非文本 modalities、prediction、top-k/metadata 和无法映射的异常终止原因。空 SDK 默认值（如 `include: []`、空状态对象、null reasoning 扩展）不会误触发门禁。
   - shim 仍保留基础文本、URL/base64 图片和普通 function tool 的有限兼容；这不是现代 item 的跨协议等价实现。

4. **[已完成] 提高请求和错误保真度**
   - 删除按 `gpt-*`/`o*` 名称无条件剥离 `service_tier`、`verbosity` 和 `top_k` 的策略。`serviceTier` 统一规范化为 `service_tier`，可选字段默认保留，以优先保证 OpenAI 和其他 provider 的通用协议保真。
   - model 与 upstream 均支持 `requestPolicy.allowedParams`、`blockedParams` 和 `dropUnsupportedParams`。provider 可显式选择保留、删除或拒绝字段；非法 policy 在配置合并前 fail-closed，不会因 normalize 变成空策略。
   - 原生错误透传可通过 `upstreams[].errorPolicy.nativePassthrough` 或 route profile 的 `nativeErrorPassthrough` 显式开启，默认仍使用代理统一错误结构。该模式只作用于原生路由；shim、DNS/TLS/连接/超时和错误体读取失败继续统一包装。
   - 原生非 2xx、首字节前流请求错误、HTTP 200 failed JSON 和 SSE provider error 均受同一 opt-in 控制；透传保留原始 JSON 文本、`Content-Type`、`Retry-After` 和代理 `x-request-id`，但不转发任意或敏感上游 header。
   - undici 的 `error.cause.code` 已纳入网络错误分类，连接超时、连接拒绝和 TLS 失败不会被误归类或错误重试。

### 已确认的兼容性取舍

- 不追求把固定版本 CLI 的全部未来能力作为 P0 阻塞项；优先验证会影响日常 agent 工作流的多轮、工具、reasoning、取消和错误语义。
- `count_tokens` 是通用 Anthropic Messages 能力，不绑定 Claude Code 标记；它只做原生透传，不为 Responses/Chat 模型增加有损 shim 或不精确估算。
- 原生协议继续透明保留未知 item/content block。shim 对无法无损转换的能力采用显式拒绝，而不是静默丢字段；部分过去 best-effort 返回 200 的请求现在会改为请求侧 400、响应侧 502 或流内错误帧，避免错误语义被伪装成成功。
- 原生错误体透传只作为可选模式，默认继续使用代理统一错误结构，避免破坏现有通用客户端；即使开启，shim 与网络层错误也不透传。
- 请求字段默认保真意味着：过去会被代理静默删除的 `service_tier`、`verbosity`、`top_k` 现在可能被不支持它们的 Azure deployment 明确拒绝。此类部署应配置 upstream `blockedParams`，而不是恢复模型名猜测。
- `/responses/compact` 作为通用原生 Responses 能力提供，但不通过伪装 provider 来强迫 Codex 使用；端点兼容与 CLI 自动触发分开验收。

### P2：性能及未来能力

1. **[待开始] 支持 Responses WebSocket**，并在握手、重连和中断语义完成后才向 Codex provider 声明。
2. **[待开始] 建立上游能力探测/版本矩阵**，替代模型名和 beta 的长期静态白名单。
3. **[待开始] 加入发布门禁**：升级 Claude Code、Codex 或上游 API 版本时自动运行双 CLI smoke test。

## 7. 建议验证矩阵

| 场景 | Claude Code / Messages | Codex / Responses | 当前自动化覆盖 |
| --- | --- | --- | --- |
| 非流式文本 | 应通过 | 应通过 | 有路由级覆盖 |
| 流式文本及正常终止 | **Claude Code `2.1.226` 已通过** | **Codex `0.147.0` 已通过** | 有路由覆盖和双 CLI smoke |
| 普通函数工具闭环 | 应通过 | 应通过 | 有转换/流式基础覆盖，缺真实 CLI 闭环 |
| thinking/reasoning | 原生应通过 | 原生应通过 | 有部分覆盖 |
| prompt cache | 直接 Anthropic beta 可透传 | 原生字段可保留 | 缺真实缓存命中测试 |
| 模型发现 | Anthropic 格式已有覆盖 | **Codex 专用格式已通过** | 有路由覆盖和真实 Codex smoke |
| 并行及现代内置工具 | 原生透明透传；shim 无损子集或明确拒绝 | 原生透明透传；shim 无损子集或明确拒绝 | 有请求、JSON 响应、SSE、no-shim 与原生透传覆盖 |
| token counting | 原生 Messages 已支持 | 不适用 | 有路由、URL、安全和 no-shim 覆盖 |
| server-side compact | 不适用 | 原生 Responses 已支持；Codex 自动触发未验证 | 有路由、URL、usage 和 no-shim 覆盖 |
| SSE 非正常 EOF | 基础检查已有 | 严格模式已拒绝 output done 假终态 | 有 passthrough/shim 错误测试，缺真实 CLI 错误矩阵 |
| WebSocket | 不适用 | 不支持 | 未覆盖 |
| 真实 CLI | **`2.1.226` 基础文本流通过** | **`0.147.0` 基础文本流通过** | 两条固定版本 smoke 已固化 |

## 8. 本次验证结果

- `npm run test:routes`：32/32 通过，覆盖原生 Messages、Messages token counting、原生 Responses、Responses compact、参数 policy、可选原生错误、严格 shim 门禁、协议转换、客户端专用模型目录、路由门禁、SSE 和错误帧。
- `npm run test:unit`：93/93 通过，覆盖请求安全、utility URL 门禁、现代 item/content block 可表示性、参数保真、undici 网络错误分类、默认关闭的 SSE 错误透传、转换语义、严格且协议绑定的流终止、usage、取消、POSIX CLI 进程组升级清理和测试夹具失败清理；与路由套件合计 125 项代理级检查通过。
- `npm run test:cli:claude-code`：Claude Code `2.1.226` 在本轮复核中再次通过原生 Messages stream；新 beta、Claude/Stainless 元数据、模型映射和上游凭据隔离均通过。
- `npm run test:cli:codex`：Codex `0.147.0` 在隔离 `CODEX_HOME` 下通过 command-backed test auth 刷新并解析专用模型目录，再以生产式 `env_key` provider 验证合法 Responses item 生命周期，生成 `agent_message` 并正常退出。
- `npm run build:admin`：107 个模块成功构建；Settings 开关和模型兼容状态已进入生产静态资源。
- Foundry beta 可观测性：路由测试确认 `unknown-beta` 被过滤，同时日志事件准确记录过滤值和 upstream 类型。

## 9. 验收门槛

当前已满足 Claude Code 的基础兼容门槛：原生文本流、新 beta/header 前向兼容、模型原生路由门禁和凭据隔离。完整兼容仍需：

- 原生 `/v1/messages` 文本、工具、thinking、prompt cache 和取消流程通过真实 Claude Code 测试。
- 新增未知 `anthropic-beta` 时代理能够按 upstream 策略转发，而无需发版修改代码。
- `message_stop`、`error`、429 和 5xx 行为可被 CLI 正确识别。
- `count_tokens` 已通过原生 Messages 透传实现；非原生模型明确拒绝，不使用本地估算冒充精确计数。

当前已满足 Codex 的基础兼容门槛：专用模型目录、原生文本流、Responses 严格终态、模型原生路由门禁和凭据隔离。完整兼容仍需：

- 自定义 provider 使用 `wire_api = "responses"`，文本、reasoning、函数工具、多轮和取消通过真实 Codex 测试。
- `/models` 能返回 Codex 专用模型目录，或部署文档强制提供经过验证的静态 `model_catalog_json`。
- 所有启用的 Responses item/event 均能原生透传，并正确处理 completed、incomplete、failed 和异常 EOF。
- 原生 server-side compact 端点已通过代理级测试；在真实 Codex 自动触发和恢复语义通过前，不把它描述为已启用的 Codex CLI 行为。WebSocket 继续保持关闭。
- shim 路径不作为兼容验收依据。

## 10. 最终建议

短期不需要重写代理。当前架构已经把路由、鉴权、原生透传、shim 和 SSE 分层，适合在现有实现上补齐协议边界。

最小可靠落地顺序是：将 Claude 模型标记并固定到原生 Messages，将 Codex 模型标记并固定到原生 Responses；在发布时运行两条固定版本 CLI smoke；随后补齐真实 CLI 的工具、thinking/reasoning、取消和错误矩阵。P1 的 `count_tokens`、`responses/compact`、严格 shim 门禁、参数 policy 与可选原生错误透传均已完成；Codex 自动触发 compact 和 WebSocket 再按实际需求推进。

当前对外描述建议使用：**“支持 Claude Code `2.1.226` 和 Codex `0.147.0` 的核心 HTTP/SSE 工作流，要求使用已标记的原生协议模型；工具、缓存、压缩和 WebSocket 等高级能力仍按矩阵验证。”**