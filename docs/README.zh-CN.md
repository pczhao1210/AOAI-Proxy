# AOAI Foundry Proxy

> 面向 Azure AI Foundry / Azure OpenAI 的 OpenAI 兼容反向代理，支持 SSE 流式转发、可配置 Caddy TLS，以及部署时可选的持久化方式。

[English](../README.md) | [简体中文](README.zh-CN.md) | [Docs Index](README.md)

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fpczhao1210%2FAOAI-Proxy%2Fazure-deploy%2Finfra%2Fazuredeploy.json)

## 概述

- OpenAI 兼容端点：`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/models`
- Client -> Proxy 使用 API Key 鉴权
- Proxy -> Azure AI Foundry / Azure OpenAI 使用 `DefaultAzureCredential`
- 静态管理页支持配置编辑、AAD 验证、统计查看
- 支持 `models[].routes` 与 `upstreams[].routes` 做模型级和上游级路由映射

## 部署资产

- Bicep 模板：[../infra/main.bicep](../infra/main.bicep)
- ARM 模板：[../infra/azuredeploy.json](../infra/azuredeploy.json)
- 参数文件：[../infra/parameters/dev.json](../infra/parameters/dev.json)、[../infra/parameters/prod.json](../infra/parameters/prod.json)

说明：Deploy to Azure 按钮指向 ARM JSON 模板，因为 Azure Portal 的远程模板按钮当前不直接支持远程 Bicep 文件。

## 持久化方式

当前支持在部署时选择持久化方式。

### `azureFile`

- 保留当前 ACI + Azure Files 挂载 `/app/data`
- 适合需要文件系统语义的配置、Caddyfile 与 Caddy 状态持久化
- ACI 挂载本身仍依赖存储账号密钥

### `blob`

- 使用 Blob SDK 在应用层保存和读取配置文件
- 通过 `DefaultAzureCredential` 和托管身份访问 Blob
- 不替代 `/app/data` 的 Azure Files 挂载语义，只解决配置读写与恢复问题

### 关键约束

ACI 原生 Azure Files 挂载目前仍依赖 Shared Key。托管身份可以用于 Blob SDK 的应用层访问，但不能把 Azure Files 卷挂载直接改造成 AAD-only 认证。如果你的目标是“完全禁用 Key Authentication 且仍保留 `/app/data` 挂载语义”，需要评估 ACA、AKS 或 VM 等替代平台。

## 超时模型

当前默认值已经调整为更适合长响应和流式场景：

```json
"server": {
  "upstream": {
    "connectTimeoutMs": 5000,
    "requestTimeoutMs": 300000,
    "firstByteTimeoutMs": 45000,
    "idleTimeoutMs": 360000,
    "maxRetries": 2,
    "retryBaseMs": 800,
    "retryMaxMs": 8000
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

## 本地运行

1. 复制示例配置：
   - `cp config/sample_config.json config/config.json`
2. 编辑 `config/config.json`：
   - 将 `upstreams[].baseUrl` 替换为真实 Foundry 或 Azure OpenAI 资源域名
   - 将 `models[].targetModel` 设置为 deployment identifier
   - 替换默认 API Key 和管理账号密码
3. 安装依赖并启动：
   - `npm install`
   - `npm run start`

## 环境变量

### 通用

- `CONFIG_PATH`：本地缓存配置路径，默认 `./config/config.json`
- `BODY_LIMIT`：请求体大小限制，默认 `52428800`
- `CADDY_BIN`：可选的 Caddy 可执行文件路径覆盖

### 持久化模式

- `PERSISTENCE_MODE=azureFile|blob`
- `AZURE_STORAGE_ACCOUNT_URL=https://<storage>.blob.core.windows.net`
- `CONFIG_BLOB_CONTAINER=<container-name>`
- `CONFIG_BLOB_NAME=config/config.json`

在 `blob` 模式下，应用会优先从 Blob 读取配置；如果 Blob 中还没有配置文件，则回退到本地缓存配置。

## 管理页

访问 `/admin` 进入管理页。

当前管理页已支持：

- Caddy 连接超时
- Caddy 响应头超时
- Caddy keepalive
- 运行时持久化模式摘要，直接显示当前部署使用的是 `azureFile` 还是 `blob`

### 管理登录

通过 `server.adminAuth` 控制，启用后会保护 `/admin` 与 `/admin/api/*`。

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
- Storage Account
- `persistenceMode=azureFile` 时的 Azure Files 共享
- `persistenceMode=blob` 时的 Blob Container
- `blob` 模式下的 `Storage Blob Data Contributor` 角色授权
- 面向目标 Azure OpenAI 资源的 `Cognitive Services OpenAI User` 角色授权

## ACI 持久化与 RBAC

- Azure Files 指南：[aci_persist_vol.md](aci_persist_vol.md)
- English version: [aci_persist_vol.en.md](aci_persist_vol.en.md)

## Caddy TLS

在管理页配置域名、邮箱、上游和传输超时后，保存配置会自动重写 Caddyfile 并尝试热重载。

如果启用了主动健康检查，同时 `/healthz` 需要 API Key，建议在 Caddy 中增加 `health_headers`，或关闭 `health_uri`，否则可能出现 401/503 的误判。

## Foundry v1 说明

- 数据面路径前缀为 `/openai/v1/*`
- `api-version` 可省略，默认按 v1 行为处理
- 请求体里的 `model` 必须是 deployment identifier

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
