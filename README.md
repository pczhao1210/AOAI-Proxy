# AOAI Foundry Proxy

[English](README.en.md)

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

## Caddy TLS（入口端口 443）
可在管理页的「域名与 TLS（Caddy）」中配置域名/邮箱/端口。保存后服务会自动生成 Caddyfile，并尝试热重载 Caddy。

1. 在管理页配置并保存（会写入 `server.caddy` 并生成 Caddyfile）。
2. 启动 Caddy：
   - `caddy run --config /app/data/Caddyfile --adapter caddyfile`

注意：ACME 证书签发通常需要 80/443 可达用于校验（HTTP-01/TLS-ALPN-01）。
如果你的环境只开放 3001，请改用 DNS-01 验证并配置对应的 DNS 提供商凭据。

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
