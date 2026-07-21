# 通过 DCE 写入 Log Analytics

AOAI Proxy 可以使用 Azure Monitor Logs Ingestion API，将代理请求、关联 ID、Prompt/输出摘要、Token 用量和估算成本写入 Log Analytics。本功能默认关闭，不会为未启用的部署创建 Azure Monitor 资源。

## 资源边界

开始前需要预先创建：

- 一个 Log Analytics Workspace。
- 一个启用公网访问的 Data Collection Endpoint（DCE）。
- 可获取 Azure token 的代理运行身份，例如 ACI 的 SystemAssigned 托管身份。

Workspace 和 DCE 必须位于同一 Azure 区域。初始化流程会在 DCE 所在订阅和资源组创建：

- 自定义表，默认 `AOAIProxyLogs_CL`。
- Direct DCR，默认 `aoai-proxy-logs`。

应用不会创建 Workspace、DCE 或 RBAC role assignment，也不会覆盖不带 AOAI Proxy 管理标记的现有 DCR。

## 权限

初始化涉及两组独立权限。

### 管理面

运行身份至少需要：

```text
Microsoft.OperationalInsights/workspaces/read
Microsoft.OperationalInsights/workspaces/tables/read
Microsoft.OperationalInsights/workspaces/tables/write
Microsoft.Insights/dataCollectionEndpoints/read
Microsoft.Insights/dataCollectionRules/read
Microsoft.Insights/dataCollectionRules/write
Microsoft.Authorization/permissions/read
```

快速配置可以在 Workspace scope 授予 `Log Analytics Contributor`，并在 DCE 资源组授予 `Monitoring Contributor`。生产环境也可以创建只包含上述 actions 的自定义角色。

### 数据写入

运行身份还必须具有：

```text
Microsoft.Insights/Telemetry/Write
```

推荐在 DCE 资源组预先授予内置角色 `Monitoring Metrics Publisher`，这样随后创建的 DCR 会继承权限：

```bash
az role assignment create \
  --assignee-object-id <managed-identity-principal-id> \
  --assignee-principal-type ServicePrincipal \
  --role "Monitoring Metrics Publisher" \
  --scope <dce-resource-group-resource-id>
```

该角色的定义 ID 是 `3913510d-42f4-4e42-8a64-420c390055eb`。也可以先初始化 DCR，在 probe 返回 `needs_ingestion_permission` 后，将角色直接授予返回的 DCR scope，再次点击初始化。

管理面 Contributor 权限不能替代 `Telemetry/Write`。RBAC 变更传播可能需要几分钟。

## 在管理页初始化

1. 打开管理页的 **配置工作台 > 日志与 Log Analytics**。
2. 填写 Workspace Resource ID 和 DCE Resource ID。
3. 根据需要修改 DCR、表和输入流名称。
4. 点击 **初始化并测试**。
5. 检查 `resources`、`management_permissions`、`table`、`dcr`、`ingestion_permission` 和 `probe` 阶段。
6. probe 成功后，派生的 Workspace ID、endpoint、DCR Resource ID 和 immutable ID 会回填到配置草稿。
7. 点击页面原有的 **保存配置**，正式启用 sink。

初始化是幂等的：已有表只补充缺失列；列类型冲突会停止，不会删除或重建表。只有带 AOAI Proxy 管理 tag 且目标 Workspace/DCE 一致的 DCR 才会更新。

从旧版本升级后请再次点击 **初始化并测试**。当前 schema v2 会增量添加 `UsageSource`、`UsageEstimated` 和 `UsageEstimationReason`，并同步受管理 DCR；不需要重建表。

Logs Ingestion API 接受 probe 后，记录在查询中可见通常仍有短暂延迟。

## 日志详细程度

- `Partial`：默认模式。保存请求和输出的前 512 个脱敏字符，同时记录长度、项目数量、截断状态和 SHA-256。
- `Full`：保存受 `maxPayloadLogBytes` 限制的脱敏请求和模型输出 JSON。

以下内容在两种模式下都不会写入：Authorization、API key、密码、token、client secret、敏感 URL 参数、Base64、data URL、图片/音频二进制。流式响应只做有界语义内容聚合，不保存原始 SSE 帧。

## Usage 降级

Chat Completions 或 Responses 请求未收到上游 usage 时，代理会用已发生的语义输入和已观察到的输出字节数按约 4 UTF-8 bytes/token 做本地估算。这覆盖正常响应缺少 usage、部分流异常和客户端中途断开；Base64、data URL、图片、音频和文件内容不参与估算。

估算记录仍进入治理统计、runtime store 和 Log Analytics，但会明确设置：

- `UsageSource = "local_estimate"`
- `UsageEstimated = true`
- `UsageEstimationReason` 为触发原因

收到上游 usage 时使用 `UsageSource = "upstream"`，且同一请求只记录一次。估算值用于连接异常时的连续性统计，不等同于供应商账单；图片生成等非文本路由不会生成本地 token 估算。

## 性能与故障边界

Log Analytics 上传通过内存队列异步执行，请求和响应发送不会等待 DCE。成功响应的 usage、响应快照和完成日志在响应交付后处理；流式输出只追加有界语义文本。

默认保护参数：

| 配置 | 默认值 | 行为 |
| --- | ---: | --- |
| `observability.logs.maxBufferBytes` | 16777216 | Admin 内存日志字节上限；同时受 `bufferSize` 限制 |
| `maxQueueSize` | 5000 | 待上传记录条数上限 |
| `maxQueueBytes` | 67108864 | 待上传记录总字节上限 |
| `uploadTimeoutMs` | 30000 | 单次 SDK 上传 deadline，超时会 abort |
| `maxUploadRetries` | 3 | 可重试失败的最大重试次数；不含首次上传 |
| `retryBaseDelayMs` | 1000 | 指数退避初始延迟 |
| `retryMaxDelayMs` | 30000 | 指数退避最大延迟 |

队列先达到条数或字节上限时按最旧记录淘汰；单条记录超过字节上限时直接丢弃。HTTP 408/409/429、5xx、超时和常见网络错误会退避重试，永久错误不会无限重试。达到重试上限后丢弃该 batch，不会阻塞代理请求。如果底层 SDK 在 abort 后仍不结束，代理保持单个在途调用并暂停新上传，队列继续受上述边界约束；迟到成功会移除对应重试记录。此时 runtime 的 `uploadPendingAfterTimeout` 为 `true`。运行页可观察 queue bytes、丢弃数、连续失败、下次重试和最近错误。Admin 内存日志也按条数和字节数双重淘汰，避免 `Full` 模式长期推高堆内存。

## 关联 ID

代理支持以下请求头：

```text
x-request-id
x-conversation-id
x-session-id
x-correlation-id
```

`RequestId` 优先使用 `x-request-id`，否则使用 Fastify 请求 ID。`ConversationId` 和 `SessionId` 会互相回退，再回退到 `x-correlation-id`，最终回退到 `RequestId`。三个字段都会作为 Log Analytics 顶级列写入。

## KQL 示例

查询一次请求的完整事件链：

```kusto
AOAIProxyLogs_CL
| where RequestId == "<request-id>"
| order by TimeGenerated asc
| project TimeGenerated, Event, Level, ModelId, ActualModelName,
          UsageSource, UsageEstimated, UsageEstimationReason,
          PromptTokens, CompletionTokens, TotalTokens, EstimatedCostAmount,
          RequestPreview, ResponsePreview
```

按会话汇总用量和成本：

```kusto
AOAIProxyLogs_CL
| where Event == "proxy.usage_recorded"
| where ConversationId == "<conversation-id>" or SessionId == "<session-id>"
| summarize Requests=dcount(RequestId),
            EstimatedRequests=dcountif(RequestId, UsageEstimated),
            PromptTokens=sum(PromptTokens),
            CompletionTokens=sum(CompletionTokens),
            EstimatedCost=sum(EstimatedCostAmount)
```

查询初始化 probe：

```kusto
AOAIProxyLogs_CL
| where Event == "loganalytics.initialization_probe"
| where RequestId == "<probe-request-id>"
```

## 手工接入

已有自定义表和 DCR 时，可以跳过初始化，直接填写 Logs Ingestion Endpoint、DCR Immutable ID、Stream Name 和 Workspace ID，再启用 Log Analytics sink。DCR 输入 schema 必须与当前应用的 Log Analytics 列契约一致。
