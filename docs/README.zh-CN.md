# AOAI Foundry Proxy

> 面向 Azure AI Foundry / Azure OpenAI 的 OpenAI 兼容反向代理，支持 SSE 流式转发、可配置 Caddy TLS，以及部署时可选的持久化方式。

[English](../README.md) | [简体中文](README.zh-CN.md) | [Docs Index](README.md)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Faoai-nextgen%2Finfra%2Fazuredeploy.json)

## 概述

- OpenAI 兼容端点：`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/models`
- Client -> Proxy 使用 API Key 鉴权
- Proxy -> Azure AI Foundry / Azure OpenAI 根据 `auth.mode` 使用 AAD token 或 `api-key`
- 静态管理页支持配置编辑、AAD 验证、统计查看和最近日志排查
- 支持 `models[].routes` 与 `upstreams[].routes` 做模型级和上游级路由映射

## 部署资产

- Bicep 模板：[../infra/main.bicep](../infra/main.bicep)
- ARM 模板：[../infra/azuredeploy.json](../infra/azuredeploy.json)
- Portal 自定义参数页定义：[../infra/createUiDefinition.json](../infra/createUiDefinition.json)
- Azure Managed Application 包源文件：[../infra/azure_deployment_with_UI](../infra/azure_deployment_with_UI)
- 参数文件：[../infra/parameters/dev.json](../infra/parameters/dev.json)、[../infra/parameters/prod.json](../infra/parameters/prod.json)

说明：Deploy to Azure 按钮指向 ARM JSON 模板，因为 Azure Portal 的远程模板按钮当前不直接支持远程 Bicep 文件。
补充：标准的原始模板 Deploy to Azure 流程不会自动使用 `createUiDefinition.json`。如果需要 Portal 中更友好的资源选择界面，需要使用 Azure Managed Application 打包与发布流程。
补充：当前部署模板已经区分 `new` 和 `existing` 资源路径，在受 Azure Policy 限制的环境里可以复用预先创建好的 Azure Files、Blob 或 PostgreSQL 资源，而不是强制新建。

## 持久化方式

当前支持在部署时选择持久化方式，且 Azure 模板默认使用 `database`。

### `database`

- Bicep、ARM 和 Portal 自定义 UI 的默认模式
- 自动创建 Azure Database for PostgreSQL Flexible Server，并以安全环境变量方式注入连接串
- 部署时可以选择新建 PostgreSQL 资源，或复用现有 server/database
- Azure 模板中如果 `databaseName` 为空，会自动创建 `aoaiproxy`
- 应用会在该数据库内自动创建 schema、table 和配置行
- 只负责代理配置持久化，不会自动把 `/app/data` 变成持久卷
- 在纯 `database` 模式下，本地缓存文件、生成的 Caddyfile、ACME 证书和 Caddy 状态仍是容器本地数据，替换容器后不会保留

### `azureFile`

- 保留当前 ACI + Azure Files 挂载 `/app/data`
- 适合需要文件系统语义的配置、Caddyfile 与 Caddy 状态持久化
- 部署时可以选择新建 storage/share，或复用现有资源
- 部署 UI 现在提供可选的 Azure Files 存储账号 key 输入框；如果手工填写，模板会直接使用这个密钥，不再调用 `listKeys`
- 如果未填写，模板会按原有逻辑自动调用 `listKeys` 获取挂载所需密钥

这条凭据链路的具体行为如下：

- Bicep / ARM 参数名为 `azureFileStorageAccountKey`
- Portal 自定义 UI 中显示为可选密码框 `Azure Files storage account key`
- 填写后，部署会把该安全值直接写入 ACI 的 Azure Files volume 定义
- 留空后，部署发起身份必须对目标存储账号具备 `listKeys` 所需权限，因为模板会在部署阶段解析挂载凭据
- 这个能力主要用于“存储账号和文件共享已经预创建，但不希望部署过程再额外做一次 key 查询”的场景
- 如果选择的是 existing file share，`fileShareName` 仍然必须是已经存在的共享；手填 key 只改变凭据来源，不会替你创建共享

### `blob`

- 使用 Blob SDK 在应用层保存和读取配置文件
- 通过 `DefaultAzureCredential` 和托管身份访问 Blob
- 部署时可以选择新建 storage/container，或复用现有资源
- 不替代 `/app/data` 的 Azure Files 挂载语义，只解决配置读写与恢复问题
- 如果 Blob RBAC 还未生效，启动时会先回退到本地缓存配置 `/app/data/config.json`
- 在 Blob 暂时不可用期间，配置写入会先落到本地文件，并在后台持续重试同步到 Blob
- RBAC 生效后，应用会自动恢复到 Blob 持久化，不需要重启容器

### 关键约束

ACI 原生 Azure Files 挂载目前仍依赖 Shared Key。托管身份可以用于 Blob SDK 的应用层访问，但不能把 Azure Files 卷挂载直接改造成 AAD-only 认证。如果你的目标是“完全禁用 Key Authentication 且仍保留 `/app/data` 挂载语义”，需要评估 ACA、AKS 或 VM 等替代平台。

落地上可以这样理解：

- 手填 key 解决的是“部署阶段是否需要调用 `listKeys`”
- 它并不会消除 ACI 挂载 Azure Files 时对存储账号 key 的依赖
- 如果存储账号本身禁用了 shared key access，那么无论是手填 key 还是自动 `listKeys`，都不适合作为 ACI 的 Azure Files 挂载方案

## 超时模型

当前默认值已经调整为更适合长响应和流式场景：

```json
"server": {
  "upstream": {
    "connectTimeoutMs": 5000,
    "requestTimeoutMs": 600000,
    "firstByteTimeoutMs": 90000,
    "idleTimeoutMs": 600000,
    "maxRetries": 1,
    "retryBaseMs": 800,
    "retryMaxMs": 8000,
    "pool": {
      "connections": 32,
      "keepAliveTimeoutMs": 30000,
      "keepAliveMaxTimeoutMs": 120000,
      "headersTimeoutMs": 60000,
      "bodyTimeoutMs": 0,
      "pipelining": 1
    }
  },
  "caddy": {
    "transport": {
      "dialTimeoutMs": 5000,
      "responseHeaderTimeoutMs": 45000,
      "keepAliveTimeoutMs": 120000
    }
  }
}
```

建议：

- `server.caddy.transport.dialTimeoutMs` 与 `server.upstream.connectTimeoutMs` 保持一致
- `server.caddy.transport.responseHeaderTimeoutMs` 不低于 `server.upstream.firstByteTimeoutMs`
- `server.upstream.idleTimeoutMs` 需要覆盖 SSE 中事件间隔较长的情况
- 对低并发但强调延迟的部署，优先调 `server.upstream.pool`，再考虑改动重试策略
- 对 MCP 或 tool-calling 场景，建议适当拉长 `firstByteTimeoutMs` 和 `idleTimeoutMs`，同时保持较低的 `maxRetries`，避免重放带副作用的工具调用

## 本地运行

1. 复制示例配置：
   - `cp config/sample_config.json config/config.json`
2. 编辑 `config/config.json`：
   - 将 `upstreams[].baseUrl` 替换为真实 Foundry 或 Azure OpenAI 资源域名
   - 将 `models[].targetModel` 设置为 deployment identifier
  - 选择上游认证方式：
    - `auth.mode = "servicePrincipal"`，配合 `scope`，并使用服务主体字段或托管身份
    - `auth.mode = "apiKey"`，并设置 `auth.apiKey`
   - 替换默认 API Key 和管理账号密码
3. 安装依赖并启动：
   - `npm install`
   - `npm run start`

## 环境变量

### 通用

- `CONFIG_PATH`：本地缓存配置路径，默认 `./config/config.json`
- `BODY_LIMIT`：请求体大小限制，默认 `52428800`
- `CADDY_BIN`：可选的 Caddy 可执行文件路径覆盖
- `ADMIN_LOG_BUFFER_SIZE`：管理页内存日志环形缓冲大小，默认 `1000`

### 可选的上游连接池覆盖项

配置文件中的 `server.upstream.pool` 为主；以下环境变量可在特殊场景下继续覆盖：

- `UPSTREAM_MAX_CONNECTIONS`
- `UPSTREAM_KEEPALIVE_TIMEOUT_MS`
- `UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS`
- `UPSTREAM_HEADERS_TIMEOUT_MS`
- `UPSTREAM_BODY_TIMEOUT_MS`
- `UPSTREAM_PIPELINING`

### 持久化模式

- `PERSISTENCE_MODE=database|azureFile|blob`
- `CONFIG_DB_CONNECTION_STRING` 或 `DATABASE_URL`，用于 `database` 模式
- `AZURE_STORAGE_ACCOUNT_URL=https://<storage>.blob.core.windows.net`
- `CONFIG_BLOB_CONTAINER=<container-name>`
- `CONFIG_BLOB_NAME=config/config.json`
- `BLOB_RECOVERY_INTERVAL_MS=30000`，控制回退到本地缓存后重试 Blob 的间隔

在 `database` 模式下，应用会优先从 PostgreSQL 读取配置，并保留本地缓存用于启动引导和降级回退。

在 `blob` 模式下，应用会优先从 Blob 读取配置；如果 Blob 中还没有配置文件，则回退到本地缓存配置。

## 管理页

访问 `/admin` 进入管理页。

当前管理页已支持：

- 代理、AAD、配置、运行状态的顶部摘要卡片
- 配置脏状态标记、基础结构提醒，以及保存前本地差异预览
- Caddy 连接超时
- Caddy 响应头超时
- Caddy keepalive
- 运行时持久化模式摘要，区分配置模式与当前实际生效模式
- Blob 访问状态、是否存在待同步写入、最近一次 Blob 错误
- 最近日志查看，支持 `warn`、`error`、可选 `info` 级别筛选，以及关键词、request id 过滤和摘要复制

日志区域使用“常用筛选常驻 + 高级筛选折叠”的方式，而不是吸顶筛选栏。

### 管理登录

通过 `server.adminAuth` 控制，启用后会保护 `/admin` 与 `/admin/api/*`。

## 统计说明

- 统计仅保存在内存中，重启后会清零
- `usage` 会从非流式 JSON 响应和流式 SSE usage 事件中采集
- 如果上游返回 cached token 相关字段，也会一并统计
- 代理会为流式 `chat/completions` 和 `responses` 请求保留 `stream_options`；只在 Foundry v1 可能拒绝的其他路由上移除它

## 日志说明

- 管理页日志保存在内存环形缓冲中，服务重启后会清空
- 默认保留最近 `1000` 条，可通过 `ADMIN_LOG_BUFFER_SIZE` 调整
- 进入管理页缓冲前会对常见敏感字段做脱敏，并截断过长字符串
- 这套日志更适合“最近问题排查”，不等价于长期审计日志存储

## Docker

构建：

- `docker build -t aoai-proxy:latest .`

使用 Azure Files 风格本地持久化运行：

- `docker run --rm -p 3000:3000 -p 443:443 -v $(pwd)/data:/app/data aoai-proxy:latest`

使用 Blob 配置持久化运行：

```bash
docker run --rm -p 3000:3000 -p 443:443 \
  -e PERSISTENCE_MODE=blob \
  -e AZURE_STORAGE_ACCOUNT_URL=https://<storage>.blob.core.windows.net \
  -e CONFIG_BLOB_CONTAINER=aoai-proxy-config \
  -e CONFIG_BLOB_NAME=config/config.json \
  aoai-proxy:latest
```

容器仍使用 `DefaultAzureCredential`，因此本地开发请提供服务主体凭据，在 Azure 中请使用托管身份。

## 上游认证模式

### `servicePrincipal`

- 默认模式
- 当提供 `tenantId`、`clientId`、`clientSecret` 时使用服务主体 client secret
- 否则回退到 `DefaultAzureCredential`，包括可用时的托管身份
- 需要配置 `auth.scope`

### `apiKey`

- 转发到 Azure AI Foundry / Azure OpenAI 时使用 `api-key` 请求头
- 需要配置 `auth.apiKey`
- 不会申请 AAD token，也不会使用 `auth.scope`

## Azure 部署

### 使用 Bicep

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/main.bicep \
  --parameters @infra/parameters/dev.json
```

### 使用 ARM JSON

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/azuredeploy.json \
  --parameters @infra/parameters/prod.json
```

模板会创建或配置：

- 启用系统分配托管身份的 Container Group
- `persistenceMode=database` 时的 Azure Database for PostgreSQL Flexible Server、允许 Azure 服务访问的防火墙规则，以及数据库子资源
- 仅在 `persistenceMode=azureFile` 或 `persistenceMode=blob` 时创建 Storage Account
- `persistenceMode=azureFile` 时的 Azure Files 共享
- `persistenceMode=blob` 时的 Blob Container
- `persistenceMode=database` 时向容器安全注入 `CONFIG_DB_CONNECTION_STRING`
- `blob` 模式下会给容器托管身份和当前部署发起者同时授予 Blob 容器级别的 `Storage Blob Data Contributor` 角色
- 面向目标 Azure OpenAI 资源的 `Cognitive Services OpenAI User` 角色授权

目标 Azure OpenAI / Foundry 资源可以位于同一订阅下的不同资源组；不在当前部署资源组时，设置 `cognitiveServicesAccountResourceGroup` 即可。
如果 `storageAccountName` 为空，模板会在存储模式下自动生成一个合法名称。
如果 `databaseServerName` 为空，模板会自动生成 PostgreSQL 服务器名。
如果 `databaseName` 为空，模板会创建 `aoaiproxy`。
PostgreSQL 默认规格是 `Burstable` + `Standard_B1ms` + `32 GB`，对应微软文档里最小的开发向规格。

Azure Files 凭据补充说明：

- Bicep / ARM 可额外传入可选安全参数 `azureFileStorageAccountKey`
- 如果该参数有值，模板直接把它用于 ACI 的 Azure Files 挂载，不再调用 `listKeys`
- 如果该参数为空，模板会回退到 `listKeys`
- 这意味着“手填 key”可以减少对部署发起身份的 key 查询依赖，但并不改变 Azure Files 挂载仍需 shared key 的平台限制

当前限制：这套 ACI 模板没有稳定可选的 ARM64 机型参数，因此当前落地的是最小 PostgreSQL 开发规格默认值，而不是显式 ARM 系列运行时选择。

### 使用 Azure Managed Application 与自定义 UI 部署

如果希望在 Azure Portal 中使用资源选择器，而不是原始参数页，请使用 [../infra/azure_deployment_with_UI](../infra/azure_deployment_with_UI) 里的 Managed Application 包源文件。

这套自定义 UI 现在默认走 PostgreSQL 配置持久化，并暴露数据库服务器名、数据库名、管理员账号和 SKU 选择；只有切换到 Azure Files 或 Blob 时才显示存储相关输入。

当选择 Azure Files 时，UI 还会显示一个可选的 `Azure Files storage account key` 密码框：

- 填写时：直接使用输入的 key 挂载共享
- 留空时：由模板自动调用 `listKeys`
- 两种方式最终都还是在 ACI 挂载阶段使用 shared key；区别只在于密钥来自手工输入还是部署时查询

打包要求：`mainTemplate.json` 和 `createUiDefinition.json` 必须位于 zip 根目录。

```bash
cd infra/azure_deployment_with_UI
zip -j app.zip mainTemplate.json createUiDefinition.json
```

发布 Managed Application definition 示例：

```bash
az managedapp definition create \
  --resource-group <definition-rg> \
  --name aoai-proxy-managedapp \
  --location <location> \
  --display-name "AOAI Foundry Proxy" \
  --description "AOAI Foundry Proxy with custom UI for ACI deployment" \
  --lock-level ReadOnly \
  --authorizations <principalId>:<roleDefinitionId> \
  --create-ui-definition @infra/azure_deployment_with_UI/createUiDefinition.json \
  --main-template @infra/azure_deployment_with_UI/mainTemplate.json
```

创建实例示例：

```bash
az managedapp create \
  --resource-group <application-rg> \
  --name aoai-proxy-instance \
  --location <location> \
  --kind ServiceCatalog \
  --managed-rg-id /subscriptions/<subscription-id>/resourceGroups/<managed-rg-name> \
  --managedapp-definition-id <definition-id>
```

这套 UI 支持在 Portal 中直接选择已有的 Foundry 或 Azure OpenAI 资源，并自动把对应资源组传给模板。

## ACI 持久化、数据库说明与 RBAC

- Azure Files 指南：[aci_persist_vol.md](aci_persist_vol.md)
- English version: [aci_persist_vol.en.md](aci_persist_vol.en.md)

## Caddy TLS

在管理页配置域名、邮箱、上游和传输超时后，保存配置会自动重写 Caddyfile 并尝试热重载。

如果实例重启时已经启用了 Caddy，应用会先把状态标记为 `starting`，并在后台轮询 Caddy 进程是否已就绪，避免刚启动时因为 `caddy reload` 早于 Caddy 进程拉起而误报错误。

如果启用了主动健康检查，同时 `/healthz` 需要 API Key，建议在 Caddy 中增加 `health_headers`，或关闭 `health_uri`，否则可能出现 401/503 的误判。

## Foundry v1 说明

- 数据面路径前缀为 `/openai/v1/*`
- `api-version` 可省略，默认按 v1 行为处理
- 请求体里的 `model` 必须是 deployment identifier

### 现代模型兼容处理

针对 `gpt-5` 及更新模型，以及 `o*` 推理模型，代理现在会在转发到 Foundry 前做一小组高频兼容处理：

- 在 `chat/completions` 上把 `max_tokens` 自动升级为 `max_completion_tokens`
- 当客户端只传 `top_logprobs` 而未传 `logprobs` 时，自动补 `logprobs: true`
- `reasoning_effort` 和 `reasoning.effort` 只接受 `low`、`medium`、`high`；如果传入常见的 `xhigh`，会自动降级为 `high`
- 对现代模型会提前移除 `service_tier`、`verbosity`、`top_k`，减少 Foundry 返回 `unknown_parameter` 的概率
- 如果请求里使用了 `web_search_preview` 相关 tools，代理会直接返回 `400`，因为 Azure Foundry 当前不支持 web search tools

另外，代理现在会为流式 `chat/completions` 和 `responses` 请求保留 `stream_options`；只在 Foundry v1 可能拒绝的其他路由上移除它。

## 模型级路由覆盖

当客户端请求路由与后端能力不一致时，可使用 `models[].routes` 做覆盖：

```json
{
  "models": [
    {
      "id": "my-model",
      "upstream": "foundry",
      "targetModel": "my-deployment",
      "routes": {
        "chat/completions": "responses"
      }
    }
  ]
}
```

## curl 示例

列出模型：

- `curl -sS http://127.0.0.1:3000/v1/models -H 'authorization: Bearer CHANGEME' | jq .`

调用 chat：

- `curl -sS http://127.0.0.1:3000/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer CHANGEME' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"ping"}]}' | jq .`
