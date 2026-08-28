# AOAI Foundry Proxy

> 面向 Azure AI Foundry / Azure OpenAI 的 OpenAI 兼容反向代理，支持 SSE 流式转发、可配置 Caddy TLS，以及部署时可选的持久化方式。

[English](../README.md) | [简体中文](README.zh-CN.md) | [Docs Index](README.md)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Faoai-nextgen%2Finfra%2Fazuredeploy.json)

## 概述

- OpenAI 与 Anthropic 兼容端点：`/v1/chat/completions`、`/v1/responses`、`/v1/responses/compact`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/images/generations`、`/v1/models`
- Client -> Proxy 使用 API Key 鉴权
- Proxy -> Azure AI Foundry / Azure OpenAI 根据 `auth.mode` 使用 AAD token 或 `api-key`
- 静态管理页支持配置编辑、AAD 验证、统计查看和最近日志排查
- 支持 `models[].routes` 与 `upstreams[].routes` 做模型级和上游级路由映射
- 原生协议路由透明保留现代 Responses item 与 Anthropic content block；跨协议 shim 默认拒绝无法无损表示的结构，并提供独立的请求/响应策略开关
- 可选通过 DCE 将关联请求、用量和脱敏 Prompt/输出写入 Log Analytics；参见 [接入指南](log-analytics-dce.md)

## 部署资产

- Bicep 模板：[../infra/main.bicep](../infra/main.bicep)
- ARM 模板：[../infra/azuredeploy.json](../infra/azuredeploy.json)
- Portal 自定义参数页定义：[../infra/createUiDefinition.json](../infra/createUiDefinition.json)
- Azure Managed Application 包源文件：[../infra/azure_deployment_with_UI](../infra/azure_deployment_with_UI)
- 参数文件：[../infra/parameters/dev.json](../infra/parameters/dev.json)、[../infra/parameters/prod.json](../infra/parameters/prod.json)

说明：Deploy to Azure 按钮指向 ARM JSON 模板，因为 Azure Portal 的远程模板按钮当前不直接支持远程 Bicep 文件。
补充：标准的原始模板 Deploy to Azure 流程不会自动使用 `createUiDefinition.json`。如果需要 Portal 中更友好的资源选择界面，需要使用 Azure Managed Application 打包与发布流程。
补充：当前部署模板已经区分 `new` 和 `existing` 资源路径，在受 Azure Policy 限制的环境里可以复用预先创建好的 Azure Files 或 PostgreSQL 资源，而不是强制新建。

## Distribution Profile

`nextgen` 和 `minimum` 是同一套源码、同一个容器镜像上的运行范围 Profile，通过 `distribution.profile` 或 `AOAI_PROXY_PROFILE` 选择，默认值为 `nextgen`。

- 两个 Profile 都保留 Chat Completions、Responses、Messages、完整 $3 \times 3$ 直通/转换矩阵、协议原生辅助端点、图片、路由、认证、SSE、重试和取消。
- 两个 Profile 都包含随镜像发布的 Model Catalog、内存查询和远程原子更新，因此维护模型事实不需要重新构建镜像。
- `minimum` 关闭预算、PostgreSQL runtime event store、Log Analytics 输出与初始化及数据库诊断 API；Model Catalog 和基础内存管理能力仍可用。
- Profile 上限只作用于运行时副本。nextgen 的持久化设置会继续保留，从 `minimum` 切回后可恢复。
- `/admin/api/runtime` 返回当前 Profile 与 capability manifest；`/version` 通过 `X-AOAI-Proxy-Profile` 响应头暴露 Profile，不改变 JSON 契约。

## 持久化方式

当前支持在部署时选择持久化方式，且 Azure 模板默认使用 `database+azureFile`。

### `database+azureFile`

- Bicep、ARM 和 Portal 自定义 UI 的默认模式
- 代理配置存到 Azure Database for PostgreSQL，同时把 `/app/data` 挂到 Azure Files
- 生成的 Caddyfile、ACME 证书、Pricing 同步输出以及其他 `/app/data` 文件会在容器替换后继续保留
- 部署时可以同时选择新建或复用 PostgreSQL 与存储资源
- 适合需要“配置持久化 + 文件系统状态持久化”同时成立的 ACI 场景

### `database`

- 仅启用 PostgreSQL 配置持久化，不创建也不挂载 Azure Files
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

### 关键约束

ACI 原生 Azure Files 挂载目前仍依赖 Shared Key。托管身份用于应用层 Azure 访问时，也不能把 Azure Files 卷挂载直接改造成 AAD-only 认证。如果你的目标是“完全禁用 Key Authentication 且仍保留 `/app/data` 挂载语义”，需要评估 ACA、AKS 或 VM 等替代平台。

落地上可以这样理解：

- 手填 key 解决的是“部署阶段是否需要调用 `listKeys`”
- 它并不会消除 ACI 挂载 Azure Files 时对存储账号 key 的依赖
- 如果存储账号本身禁用了 shared key access，那么无论是手填 key 还是自动 `listKeys`，都不适合作为 ACI 的 Azure Files 挂载方案

## 超时模型

当前默认值已经调整为更适合长响应和流式场景：

```json
{
"server": {
  "gracefulShutdownMs": 30000,
  "caddy": {
    "transport": {
      "dialTimeoutMs": 5000,
      "responseHeaderTimeoutMs": 1260000,
      "keepAliveTimeoutMs": 120000
    }
  }
},
"proxy": {
  "timeouts": {
    "connectMs": 10000,
    "requestMs": 900000,
    "firstByteMs": 300000,
    "idleMs": 300000,
    "maxStreamDurationMs": 3600000
  },
  "retries": {
    "maxRetries": 0,
    "baseDelayMs": 800,
    "maxDelayMs": 8000
  },
  "httpClient": {
    "connections": 32,
    "keepAliveTimeoutMs": 60000,
    "keepAliveMaxTimeoutMs": 300000,
    "headersTimeoutMs": 330000,
    "bodyTimeoutMs": 0,
    "pipelining": 1
  }
},
"access": {
  "rateLimits": {
    "windowSeconds": 60,
    "defaultRpm": 60,
    "defaultTpm": 0,
    "defaultConcurrency": 8
  }
}
}
```

建议：

- `connectMs` 限制到上游的 TCP/TLS 建连；Caddy 的 `dialTimeoutMs` 只限制本机 Caddy 到 Node 的连接。
- `firstByteMs` 限制上游响应头和流式首块等待时间；`headersTimeoutMs` 在它之上保留少量余量。
- `requestMs` 限制收到上游响应头后读取和解析非流式 body 的时间；`idleMs` 限制流式 chunk 之间的空闲时间。
- `bodyTimeoutMs` 设为 `0`，避免 Undici 抢先于代理按路由区分的 request/idle timer 中断请求。
- Caddy 等待 Node 产生下游响应头，因此 `responseHeaderTimeoutMs` 需要覆盖非流式最坏路径 `firstByteMs + requestMs` 并留余量。
- `maxStreamDurationMs` 提供一小时硬上限；只有明确接受无限流时才设置为 `0`。
- tool-calling 或其他可能有副作用的请求保持 `maxRetries=0`，正值可能在输出开始前重放请求。
- Key 级限流值 `0` 表示继承 `access.rateLimits` 全局默认；全局值 `0` 才表示该维度不限。

## 本地运行

1. 复制示例配置：
   - `cp config/sample_config.json config/config.json`
2. 编辑 `config/config.json`：
   - 将 `upstreams[].baseUrl` 替换为真实 Foundry 或 Azure OpenAI 资源域名
   - 将 `models[].targetModel` 设置为 deployment identifier
  - 在管理界面或 `upstreams[].auth` 中为每个上游选择认证方式：
    - `mode = "managedIdentity"`：沿用现有 Azure credential 与 AAD token 获取流程
    - `mode = "apiKey"`：必须填写该上游的 `apiKey`，并按路由要求发送 `api-key` 或 `x-api-key`
    - 未设置上游认证方式时继续继承全局 `auth` 配置，以兼容旧配置
   - 替换默认 API Key 和管理账号密码
3. 安装依赖并启动：
   - `npm install`
  - 当 `server.host` 不是回环地址时，将 `AOAI_PROXY_ADMIN_PASSWORD` 和 `AOAI_PROXY_API_KEY` 设置为强且唯一的秘密值
   - `npm run start`

非回环监听会采用 fail-closed：管理认证关闭或仍存在已知占位凭据时拒绝启动。`ALLOW_INSECURE_PUBLIC_ADMIN=true` 仅用于显式兼容，不建议用于正常部署。

所有可配置布尔开关的默认值、功能、管理页入口、生效方式，以及预留或未接线字段，统一收录在 [Feature Flag 与布尔开关目录](feature-flags.zh-CN.md)。

## 环境变量

### 通用

- `CONFIG_PATH`：本地缓存配置路径，默认 `./config/config.json`
- `BODY_LIMIT`：请求体大小限制，默认 `52428800`
- `CADDY_BIN`：可选的 Caddy 可执行文件路径覆盖
- `SHUTDOWN_TIMEOUT_MS`：可选的优雅关闭时限覆盖；未设置时使用 `server.gracefulShutdownMs`
- `ADMIN_LOG_BUFFER_SIZE`：管理页内存日志环形缓冲大小，默认值和硬上限均为 `100`
- `AOAI_PROXY_PROFILE`：运行范围 Profile，可选 `nextgen`（默认）或 `minimum`
- `AOAI_PROXY_ADMIN_USERNAME`：管理端 Basic Auth 用户名
- `AOAI_PROXY_ADMIN_PASSWORD`：管理端 Basic Auth 密码；设置后默认启用管理认证
- `AOAI_PROXY_API_KEY`：覆盖默认客户端 API Key
- `AOAI_PROXY_UPSTREAM_API_KEY`：覆盖上游 API Key 认证使用的 `auth.apiKey`
- `AOAI_PROXY_CADDY_ENABLED`、`AOAI_PROXY_CADDY_DOMAIN`、`AOAI_PROXY_CADDY_EMAIL`：Caddy HTTPS 覆盖项
- `AOAI_PROXY_TRUST_PROXY`：仅在 Node 只能通过受信反向代理访问时启用
- `ALLOW_INSECURE_PUBLIC_ADMIN`：跳过非回环凭据门禁的显式兼容开关，不建议生产使用

### 可选的上游连接池覆盖项

配置文件中的 `server.upstream.pool` 为主；以下环境变量可在特殊场景下继续覆盖：

- `UPSTREAM_MAX_CONNECTIONS`
- `UPSTREAM_KEEPALIVE_TIMEOUT_MS`
- `UPSTREAM_KEEPALIVE_MAX_TIMEOUT_MS`
- `UPSTREAM_HEADERS_TIMEOUT_MS`
- `UPSTREAM_BODY_TIMEOUT_MS`
- `UPSTREAM_PIPELINING`

### 持久化模式

- `PERSISTENCE_MODE=database|database+azureFile|azureFile`
- `CONFIG_DB_CONNECTION_STRING` 或 `DATABASE_URL`，用于 `database` 与 `database+azureFile` 模式

在 `database` 模式下，应用会优先从 PostgreSQL 读取配置，并保留本地缓存用于启动引导和降级回退。

在 `database+azureFile` 模式下，应用同样会优先从 PostgreSQL 读取配置，但同时要求 `/app/data` 挂载到 Azure Files，这样 Caddy 状态和其他文件系统产物也能跨容器保留。

## 管理页

访问 `/admin` 进入管理页。

当前管理页已支持：

- 代理、AAD、配置、运行状态的顶部摘要卡片
- 配置脏状态标记、基础结构提醒，以及保存前本地差异预览
- Caddy 连接超时
- Caddy 响应头超时
- Caddy keepalive
- 运行时持久化模式摘要，区分配置模式与当前实际生效模式
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

## 测试与延迟诊断

- `npm run test:unit` 覆盖 PostgreSQL 连接池错误、凭据脱敏、SIGTERM 优雅关闭和启动失败清理
- 路由冒烟测试、真实模型测试和延迟分析脚本说明位于 [../test/README.md](../test/README.md)
- `npm run test:latency` 会发起真实流式请求，并自动附带 `x-debug-latency: 1`
- 代理仅在请求带有这个头时输出 `proxy.request_timing`，因此正常业务流量默认不会产生这类延迟分段日志
- 如果希望脚本再按 `request id` 从 `/admin/api/logs` 拉回对应 timing 日志，且管理页开启了 Basic Auth，还需要设置 `AOAI_PROXY_LATENCY_ADMIN_USERNAME` 和 `AOAI_PROXY_LATENCY_ADMIN_PASSWORD`

## Docker

构建：

- amd64 本地镜像：`./start.sh --build`
- arm64 本地镜像：`DOCKER_PLATFORM=linux/arm64 ./start.sh --build`
- amd64 构建并推送到 ACR：`./start.sh --build --push`
- arm64 构建并推送到 ACR：`DOCKER_PLATFORM=linux/arm64 ./start.sh --build --push`

amd64 默认镜像为 `alexmcr.azurecr.io/aoai-proxy:nextgen-latest`。设置 `DOCKER_PLATFORM=linux/arm64` 后，默认 tag 自动切换为 `nextgen-latest-arm64`。可通过 `IMAGE_REF`、`IMAGE_TAG`、`ACR_LOGIN_SERVER` 和 `IMAGE_REPOSITORY` 覆盖。推送只使用本机 Docker CLI 已保存的凭据，不会执行 registry login。

构建脚本会把生成的版本号和 UTC 构建时间注入镜像。无需鉴权即可请求 `GET /version`，用于确认运行中的部署版本：

```json
{
  "service": "aoai-proxy",
  "version": "nextgen-202608100257",
  "buildTime": "2026-08-10T02:57:55Z"
}
```

默认版本号使用 UTC 构建分钟，格式为 `nextgen-YYYYMMDDHHmm`；相同信息也会写入标准 OCI 镜像标签。

Dockerfile 使用动态大版本基线：`NODE_MAJOR=24` 与 `CADDY_MAJOR=2`，实际解析为 `node:24-alpine` 和 `caddy:2-alpine`。构建脚本会执行 `docker buildx build --pull`，因此每次构建都会拉取这些大版本线内最新可用的 patch/minor 镜像。不带 `--push` 的构建使用 buildx `--load`；组合构建和推送会直接使用 `--push`。多平台产物必须直接推送，因为经典本地镜像存储不能载入多平台 manifest。

所选 buildx builder 必须声明所有目标平台。在 amd64 主机交叉构建 arm64 通常还需要 QEMU/binfmt。直接调用 buildx 时，还需传入平台、构建元数据和需要覆盖的大版本参数：

```bash
docker buildx build --pull --load \
  --platform linux/amd64 \
  --build-arg NODE_MAJOR=24 \
  --build-arg CADDY_MAJOR=2 \
  --build-arg AOAI_PROXY_VERSION=nextgen-202608100257 \
  --build-arg AOAI_PROXY_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t aoai-proxy:latest .
```

使用 Azure Files 风格本地持久化运行：

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e AOAI_PROXY_ADMIN_PASSWORD="$AOAI_PROXY_ADMIN_PASSWORD" \
  -e AOAI_PROXY_API_KEY="$AOAI_PROXY_API_KEY" \
  -v "$(pwd)/data:/app/data" \
  aoai-proxy:latest
```

使用 PostgreSQL 配置持久化运行：

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e PERSISTENCE_MODE=database \
  -e AOAI_PROXY_ADMIN_PASSWORD="$AOAI_PROXY_ADMIN_PASSWORD" \
  -e AOAI_PROXY_API_KEY="$AOAI_PROXY_API_KEY" \
  -e CONFIG_DB_CONNECTION_STRING='postgresql://<user>:<password>@<server>.postgres.database.azure.com:5432/<database>?sslmode=require' \
  aoai-proxy:latest
```

容器入口把 Node 和 Caddy 都视为关键进程；任一进程异常退出时，PID 1 会让容器以非零状态结束，以便平台重启策略恢复服务。ACI 模板还会直接探测 `http://127.0.0.1:3000/healthz`，即使 Caddy 仍在运行，也能识别 Node 不可用。

如果容器需要 AAD 上游访问，仍会使用 `DefaultAzureCredential`，因此本地开发请提供服务主体凭据，在 Azure 中请使用托管身份。

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
  --parameters @infra/parameters/dev.json \
  --parameters adminPassword="$AOAI_PROXY_ADMIN_PASSWORD" proxyApiKey="$AOAI_PROXY_API_KEY"
```

### 使用 ARM JSON

```bash
az deployment group create \
  --resource-group <rg> \
  --template-file infra/azuredeploy.json \
  --parameters @infra/parameters/prod.json \
  --parameters adminPassword="$AOAI_PROXY_ADMIN_PASSWORD" proxyApiKey="$AOAI_PROXY_API_KEY"
```

模板会创建或配置：

- 启用系统分配托管身份的 Container Group
- `distributionProfile=nextgen` 且 `persistenceMode=database` 或 `persistenceMode=database+azureFile` 时的 Azure Database for PostgreSQL Flexible Server 和数据库子资源
- 仅当 `allowAzureServicesToDatabase=true` 时创建 PostgreSQL `0.0.0.0` Azure 服务访问防火墙规则
- 仅在 `persistenceMode=azureFile` 或 `persistenceMode=database+azureFile` 时创建 Storage Account
- `persistenceMode=azureFile` 或 `persistenceMode=database+azureFile` 时的 Azure Files 共享
- `persistenceMode=database` 或 `persistenceMode=database+azureFile` 时向容器安全注入 `CONFIG_DB_CONNECTION_STRING`
- 安全注入管理密码与客户端 API Key；仓库参数样例刻意不保存这两个秘密值
- 自动配置 Caddy HTTPS，公网仅开放 `443`；Node 的 `3000` 仅用于容器内健康探针
- 面向目标 Azure OpenAI 资源的 `Cognitive Services OpenAI User` 角色授权

`distributionProfile=minimum` 会把部署的有效持久化模式固定为 `azureFile`，因此使用同一镜像但不创建 PostgreSQL 资源；`distributionProfile=nextgen` 保留所选 `persistenceMode`。

目标 Azure OpenAI / Foundry 资源可以位于同一订阅下的不同资源组；不在当前部署资源组时，设置 `cognitiveServicesAccountResourceGroup` 即可。
如果 `storageAccountName` 为空，模板会在存储模式下自动生成一个合法名称。
如果 `databaseServerName` 为空，模板会自动生成 PostgreSQL 服务器名。
如果 `databaseName` 为空，模板会创建 `aoaiproxy`。
PostgreSQL 默认规格是 `Burstable` + `Standard_B1ms` + `32 GB`，对应微软文档里最小的开发向规格。

安全默认值：

- `allowAzureServicesToDatabase` 默认是 `false`。只有当当前公网 ACI 部署无法通过私网或预批准网络路径连接 PostgreSQL 时，才显式设为 `true`。
- `acrLoginServer`、`acrUsername`、`acrPassword` 默认留空。只有镜像仓库确实需要由该模板提供 basic pull credential 时才填写。
- 模板会创建 ACI 公网 IP，并要求提供 `dnsNameLabel` 与 `caddyEmail`；公网只开放 Caddy HTTPS `443`。

Azure Files 凭据补充说明：

- Bicep / ARM 可额外传入可选安全参数 `azureFileStorageAccountKey`
- 如果该参数有值，模板直接把它用于 ACI 的 Azure Files 挂载，不再调用 `listKeys`
- 如果该参数为空，模板会回退到 `listKeys`
- 这意味着“手填 key”可以减少对部署发起身份的 key 查询依赖，但并不改变 Azure Files 挂载仍需 shared key 的平台限制

当前限制：这套 ACI 模板没有稳定可选的 ARM64 机型参数，因此当前落地的是最小 PostgreSQL 开发规格默认值，而不是显式 ARM 系列运行时选择。

### 使用 Azure Managed Application 与自定义 UI 部署

如果希望在 Azure Portal 中使用资源选择器，而不是原始参数页，请使用 [../infra/azure_deployment_with_UI](../infra/azure_deployment_with_UI) 里的 Managed Application 包源文件。

这套自定义 UI 现在默认走 PostgreSQL 配置持久化，并暴露数据库服务器名、数据库名、管理员账号和 SKU 选择；只有切换到 Azure Files 时才显示存储相关输入。

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

针对 Model Catalog 声明了 `reasoning` capability 的模型，以及显式携带协议推理字段的请求，代理会在转发到 Foundry 前做一小组高频兼容处理：

- 在推理型 `chat/completions` 请求上把 `max_tokens` 自动升级为 `max_completion_tokens`
- 当客户端只传 `top_logprobs` 而未传 `logprobs` 时，自动补 `logprobs: true`
- `reasoning_effort` 和 `reasoning.effort` 会规范化为小写；`xhigh` 到 `max` 等模型特定别名来自 Model Catalog，未知档位默认继续交给真实上游判断
- `serviceTier` 会规范化为 `service_tier`；`service_tier`、`verbosity`、`top_k` 默认保留，不再根据模型名猜测是否支持
- 如果某个 provider 会拒绝可选字段，可在 `upstreams[].requestPolicy.blockedParams` 中列出；`dropUnsupportedParams: true` 表示删除，否则会明确返回请求错误
- `web_search_preview` 相关 tool spelling 会规范化为 `web_search`；除非显式请求策略阻止，否则由真实上游判断是否支持

代理会在兼容的原生路由上保留 `stream_options`。当 Chat 转换到 Responses 或 Messages 时，代理会消费 `stream_options.include_usage`，并在 `[DONE]` 前生成客户端要求的 Chat usage chunk；未知 stream option 按协议 shim 的有损转换策略处理。

## 协议路由

代理提供三种文本生成协议：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`

模型路由决定上游协议。同协议组合使用近似透传，不同协议组合执行显式的请求、JSON 响应和 SSE 转换。

上游错误默认使用代理统一错误结构。只有原生协议客户端确实依赖 provider 错误体时，才应将 `upstreams[].errorPolicy.nativePassthrough` 或 route profile 的 `nativeErrorPassthrough` 设为 `true`。该选项仅作用于原生路由，并保留安全的 `Content-Type`、`Retry-After` 和代理 request ID；协议 shim 与网络错误仍保持统一包装。

| 客户端协议 | Chat 上游 | Responses 上游 | Messages 上游 |
| --- | --- | --- | --- |
| Chat Completions | 近似透传 | 转换 | 转换 |
| Responses | 转换 | 近似透传 | 转换 |
| Anthropic Messages | 转换 | 转换 | 近似透传 |

近似透传指 typed 语义保真，不是原始字节透传。代理仍会映射模型 ID、执行请求策略和图片处理、替换认证 header、采集 usage，并实施流超时。原生 Responses 保留 Responses item 和事件；原生 Messages 保留有序 Anthropic block 与 SSE 事件，包括 body 中的工具调用/结果和 thinking signature。

跨协议转换覆盖文本、输入图片、函数工具、工具调用/结果、token 上限、停止原因、usage 与流式生命周期。Responses `reasoning.encrypted_content` 会与 Anthropic thinking signature 双向映射，包括流式续接。其他缺少安全等价表达的协议专属字段默认执行尽力转换并记录结构化告警；需要无损边界时可显式开启严格模式。

`compatibility.protocolShim.rejectLossyRequests` 与 `rejectLossyResponses` 默认均为 `false`。兼容模式会写入 `proxy.protocol_shim_lossy_conversion` 结构化告警，包含转换阶段、字段路径、源/目标协议和丢失原因；响应开关同时作用于 JSON 与 SSE。只有明确要求无损边界时才应开启相应严格开关。

```json
{
  "compatibility": {
    "protocolShim": {
      "rejectLossyRequests": false,
      "rejectLossyResponses": false
    }
  }
}
```

配置归一化会把版本 2 升级为版本 3。仅对于 GPT-5.6 Luna、Sol 和 Terra，升级时会删除旧模板生成的精确路由 `{ "*": "responses" }`，使 Chat 与 Responses 请求恢复使用各自的原生接口；版本 3 中保存的路由覆盖均视为显式配置并予以保留。

Microsoft Foundry 的 Claude deployment 应配置上游路由 `messages: "/anthropic/v1/messages"`。代理会自动把 Azure OpenAI resource host 切换为 `*.services.ai.azure.com`，缺省注入 `anthropic-version: 2023-06-01`，API key 模式使用 `x-api-key`，AAD 模式使用 `https://ai.azure.com/.default` scope。

当匹配的 Claude pricing 模板同时提供两种托管模式时，通过 `models[].hostingMode` 记录实际的 `azure` 或 `anthropic` 托管基础设施，用于区域、数据处理与能力元数据，不能据此推断 Responses 支持。当前有文档依据的 Azure-hosted 与 Anthropic-hosted Claude deployment 都使用 Messages，因此客户端 Responses 的 `reasoning.effort` 会转换为 `output_config.effort`，并设置 `thinking.type="adaptive"`。显式 `models[].routes` 覆盖仍具有最高优先级。

### Claude Code

当请求包含 `Anthropic-Version`、使用 `format=anthropic/messages`，或 User-Agent 含 Claude/Anthropic 时，模型端点会返回 Anthropic Models 格式。Claude Code 兼容开启时，Claude Code User-Agent 或 `format=claude-code` 只返回显式标记且原生解析到 Messages 的模型；普通 Anthropic SDK 发现仍保留更广的可访问模型列表。因此可以开启 Claude Code 的网关模型发现：

```bash
export ANTHROPIC_BASE_URL="https://proxy.example.com"
export ANTHROPIC_AUTH_TOKEN="your-proxy-api-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

`compatibility.claudeCode.enabled` 默认开启。在 Messages 路由上，它会安全转发 Claude/Anthropic 与 Stainless 元数据 header 前缀，同时继续阻断客户端凭据。直接 Anthropic 上游会按原顺序保留未知 `anthropic-beta`，以适应后续 Claude Code 版本；Azure/Foundry 上游继续使用下方已审查 allowlist，并通过结构化日志事件 `proxy.anthropic_betas_filtered` 记录被过滤值。

用于 Claude Code 的生产模型必须显式标记并保持原生 Messages 路由。兼容开关开启时，若标记模型解析到其他后端协议，配置加载或保存会失败：

```json
{
  "clientCompatibility": { "claudeCode": true },
  "routes": { "*": "messages" }
}
```

模型 ID 必须唯一，避免模型发现元数据与运行时路由把同一个公开 ID 解析到不同配置项。

代理默认开启 `compatibility.anthropic` 下的三项 Foundry 专属兼容策略：

- `betaAllowlistEnabled`：只转发已审查的 beta token；默认包含细粒度工具流、交错 thinking 与上下文管理。
- `normalizeManualThinkingToolChoice`：仅当 `thinking.type="enabled"` 为手动模式时，把强制 `any` / 指定工具改为 `auto`；adaptive thinking 不受影响。
- `sanitizeCacheControl`：保留合法 ephemeral cache control 以及 Foundry 支持的 `5m` / `1h` TTL，移除不支持的字段和位置。
- `validateThinkingByModel`：Model Catalog 提供 Claude thinking 类型、默认值和别名，但默认采用 passthrough；可在 `thinkingTypesByModel` 中添加 deployment 专属严格列表。完全未知的模型继续透传。
- `effortLevelsByModel`：这是管理员显式严格 override。未配置时使用 Model Catalog 做归一化但不本地拒绝；配置后，不支持的 level 会在调用上游前返回错误。

这些设置只控制请求兼容性，不选择 wire protocol。需要回滚原生 Messages 时，应修改模型 route override，而不是关闭全部兼容策略。

### Codex

`compatibility.codex.enabled` 也默认开启。来自 Codex User-Agent，或带 `format=codex` 的 `/v1/models` 请求会收到 Codex 专用 `{ "models": [...] }` 目录，而不是标准 OpenAI 列表。目录只包含已标记且原生解析到 Responses 的模型：

```json
{
  "clientCompatibility": { "codex": true },
  "routes": {},
  "codex": {
    "contextWindow": 128000,
    "supportedReasoningEfforts": ["low", "medium", "high"]
  }
}
```

Codex 自定义 provider 的 `base_url` 应以 `/v1` 结尾，并设置 `wire_api = "responses"`、`supports_websockets = false`。若标记模型的 Responses 入口解析到 Chat 或 Messages 转换路径，配置校验会拒绝该配置。双协议模型应保持 wildcard route 为空，使非 Codex Chat 客户端继续使用原生 Chat Completions。

流输入支持 LF/CRLF、多条 `data:` 字段和末尾无换行的终态事件。只有源协议提供匹配的终态证据才视为完整：Chat 使用 `[DONE]` 或 EOF 前的最终 `finish_reason`，Responses 使用 `response.completed` 或 `response.incomplete`，Anthropic 必须有 `message_stop`；Responses `response.failed` 和 provider error 事件属于失败终态。关闭 Codex 兼容后，旧版 Responses output-done EOF 兜底仍可使用。提前 EOF 会返回 `UPSTREAM_INCOMPLETE_STREAM`，不会伪造成目标协议成功终止。

并行工具调用在跨协议转换时保留 index 和稳定 call ID。连续 Responses function call 会合并成一个 Chat assistant 工具调用轮次；参数 delta 会等工具 identity 确定后再输出；当最终没有有效工具时会移除工具控制字段。HTTP 200 中携带 provider failed 状态的 payload 仍按失败处理，不会包装成空的成功响应。

客户端取消会贯穿上游响应头等待、重试退避、流读取和非流 body 读取。非成功 error body 有大小与时间限制并可被取消，客户端断开后不会继续占用上游请求或重试循环。

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

把 Claude deployment 路由到原生 Messages 上游：

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-6",
      "upstream": "foundry",
      "targetModel": "claude-sonnet-4-6",
      "clientCompatibility": {
        "claudeCode": true
      },
      "routes": {
        "*": "messages"
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

Anthropic Messages 请求：

- `curl -sS http://127.0.0.1:3000/v1/messages -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H 'x-api-key: CHANGEME' -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"ping"}]}' | jq .`
