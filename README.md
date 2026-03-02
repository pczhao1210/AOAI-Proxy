# AOAI Foundry Proxy

> OpenAI-compatible reverse proxy for Azure AI Foundry / Azure OpenAI with SSE streaming, Caddy TLS, and ACI-friendly persistence.

[English](README.en.md)

## 关键词 / Keywords
OpenAI proxy, Azure AI Foundry, Azure OpenAI, SSE streaming, Caddy TLS, ACME, ACI, Fastify

## 推荐 Topics（在 GitHub 仓库设置中添加）
`openai` `azure` `azure-openai` `azure-ai` `proxy` `caddy` `acme` `sse` `fastify` `aci`

## 概述
- OpenAI 兼容反向代理（chat/completions、responses、images）
- Client→Proxy 使用 API Key
- Proxy→Foundry 使用 AAD Bearer Token（DefaultAzureCredential）
- 静态管理页用于配置与统计

## 端点
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `GET /v1/models`

## 本地运行
1. 复制示例配置并修改：
   - `cp config/sample_config.json config/config.json`
2. 编辑 `config/config.json`：
   - 将 `upstreams[].baseUrl` 替换为真实 Foundry/AOAI 资源域名
   - 将 `models[].targetModel` 设置为 deployment identifier
   - 按需修改 `apiKeys`、`server.adminAuth`
3. 启动服务：
   - `npm install`
   - `npm run start`

## 管理页面
- 打开 `/admin`，在页面中编辑并保存配置

### 管理登录（HTTP Basic）
通过 `server.adminAuth` 配置；启用后保护范围：`/admin` 及 `/admin/api/*`。

## 统计说明
- 统计为内存累计，服务重启会清零。
- `usage` 来自上游响应：非流式 JSON 的 `usage`，以及流式 `data:` 事件中的 `usage` 或 `response.usage`。
- 若上游返回 `prompt_tokens_details.cached_tokens` 或 `input_tokens_details.cached_tokens`，会统计为 Cached Tokens。
- 代理会剔除请求中的 `stream_options` 以避免 Foundry v1 `unknown_parameter`。

## Docker
镜像内会把 `config/sample_config.json` 复制为默认配置文件 `/app/config/config.json`，并默认开启管理登录（`admin/admin`）。
容器启动时会将默认配置复制到 `/app/data/config.json`（可挂载持久化卷）。
镜像包含 Caddy，并在检测到 `/app/data/Caddyfile` 时启动 TLS 入口（默认 443）。
证书与 ACME 状态保存在 `/app/data/caddy`，需随 `/app/data` 一起持久化。

ACI 部署与持久化：见 [aci_persist_vol.md](aci_persist_vol.md)

构建：
- `docker build -t aoai-proxy:latest .`

运行（端口映射 + 持久化数据卷）：
- `docker run --rm -p 3000:3000 -p 443:443 -v $(pwd)/data:/app/data aoai-proxy:latest`

说明：容器里仍使用 `DefaultAzureCredential`，请按你的运行环境提供 AAD 凭据（环境变量/托管身份等）。

大尺寸图片请求可通过环境变量调整请求体限制（字节）：
- `BODY_LIMIT=52428800`（默认 50MB）

## 图片压缩（全量流量）
服务端会在转发前压缩请求中的图片数据（仅处理 `data:image/*` 或 `image_base64` 字段）。可在配置中调整：

```json
"imageCompression": {
   "enabled": true,
   "maxSize": 1600,
   "quality": 0.85,
   "format": "jpeg"
}
```

## Caddy TLS（入口端口 443）
可在管理页的「域名与 TLS（Caddy）」中配置域名/邮箱/端口。保存后服务会自动生成 Caddyfile，并尝试热重载 Caddy。

1. 在管理页配置并保存（会写入 `server.caddy` 并生成 Caddyfile）。
2. 启动 Caddy：
   - `caddy run --config /app/data/Caddyfile --adapter caddyfile`

如遇到 `spawn caddy ENOENT`，请确认容器内已安装 Caddy，或设置 `CADDY_BIN=/usr/sbin/caddy`。

注意：ACME 证书签发通常需要 80/443 可达用于校验（HTTP-01/TLS-ALPN-01）。
如果你的环境只开放 3001，请改用 DNS-01 验证并配置对应的 DNS 提供商凭据。

### Caddy 主动健康检查 + 鉴权（401/503 排障）
如果你启用了 `reverse_proxy` 的主动健康检查（例如 `health_uri /healthz`），同时 `/healthz` 受代理 API Key 保护，可能看到：
- `status code out of tolerances`、`status_code: 401`、`host: 127.0.0.1:3000`
- `no upstreams available`

原因：
- Caddy 的健康检查默认不会携带你的代理 API Key。
- 当 `/healthz` 需要鉴权时，健康检查会返回 401；Caddy 会把上游标记为 unhealthy，客户端随后收到 503。

可选处理方式（任选其一）：
1. 在 Caddyfile 为健康检查补充鉴权头（推荐）：
```caddyfile
reverse_proxy 127.0.0.1:3000 {
  health_uri /healthz
  health_interval 30s
  health_headers {
    Authorization "Bearer <YOUR_PROXY_API_KEY>"
  }
}
```
2. 临时移除 `health_uri`（关闭主动健康检查），避免因 401 被误判为上游不可用。

说明：
- 管理页保存配置会重新生成 Caddyfile。若你手工改过 Caddyfile，下一次保存后请再次确认健康检查相关配置。

## ACI 更新镜像
参考官方文档：通过重新执行 `az container create`（同名）进行更新。若你的 CLI 不支持 `az container update`，请按以下方式更新：

1. 导出或维护一份容器创建参数（推荐使用 YAML 或脚本）。
2. 修改镜像（建议使用 digest）。
3. 重新执行 `az container create`（同名），容器会重建并拉取新镜像。

示例（请替换占位符）：

```bash
az container create \
   -g <resource-group> \
   -n <container-name> \
   --image <registry>/<image>@sha256:<digest> \
   --registry-login-server <registry> \
   --registry-username <username> \
   --registry-password <password> \
   --cpu 1 --memory 2 \
   --ports 3000 443 \
   --dns-name-label <dns-label> \
   --azure-file-volume-account-name <storage-account> \
   --azure-file-volume-account-key <storage-key> \
   --azure-file-volume-share-name <share> \
   --azure-file-volume-mount-path /app/data \
   --os-type Linux
```

## 上游（Foundry v1）要点
- Foundry v1 的数据面路径前缀是 `/openai/v1`（例如：`POST {endpoint}/openai/v1/chat/completions`）。
- `api-version` 是可选的；不指定时默认为 `v1`。
- 请求体里的 `model` 字段是“模型部署标识符（deployment identifier）”，不是模型家族名；本项目用 `models[].targetModel` 表示要转发到的 deployment。

## 模型级路由覆盖（models[].routes）
有些客户端只会调用 `POST /v1/chat/completions`，但部分模型/后端可能只支持 `responses`。可以在模型配置里用 `routes` 覆盖“后端实际使用的路由”。

支持两种写法：
- **映射到另一个 routeKey**：值为 `responses` / `chat/completions` / `images/generations`
- **直接指定后端路径**：值以 `/` 开头（可包含 `{deployment}`）

示例（客户端打 chat，但后端走 responses）：

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

说明：这里仅影响“后端请求的 URL 路由选择”，不会自动把 `chat/completions` 的请求体转换成 `responses` 的请求体字段。

### 推荐配置形态
- `upstreams[].baseUrl`：
   - `https://<your-resource-name>.openai.azure.com/`
   - 或 `https://<your-resource-name>.services.ai.azure.com/`
- `upstreams[].routes`：
   - `chat/completions`: `/openai/v1/chat/completions`
   - `responses`: `/openai/v1/responses`
   - `images/generations`: `/openai/v1/images/generations`

## curl 示例
列出模型：
- `curl -sS http://127.0.0.1:3000/v1/models -H 'authorization: Bearer CHANGEME' | jq .`

调用 chat：
- `curl -sS http://127.0.0.1:3000/v1/chat/completions -H 'content-type: application/json' -H 'authorization: Bearer CHANGEME' -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"ping"}]}' | jq .`

### 推荐配置形态
- `upstreams[].baseUrl`：
   - `https://<your-resource-name>.openai.azure.com/`
   - 或 `https://<your-resource-name>.services.ai.azure.com/`
- `upstreams[].routes`：
   - `chat/completions`: `/openai/v1/chat/completions`
   - `responses`: `/openai/v1/responses`
   - `images/generations`: `/openai/v1/images/generations`


### 更新历史
- 2026-03-02: Caddy 连接复用/协议优化；新增 `health_uri + 鉴权` 场景的 401/503 排障说明
- 2026-02-25: Cached Tokens 统计、Responses 流式 usage 统计完善、默认剔除 stream_options
- 2026-02-10: 全量流量图片压缩、管理页压缩占位符、ACI 更新说明
- 2026-02-04: Caddy 状态面板与热重载、ACME 日志输出、i18n 支持
