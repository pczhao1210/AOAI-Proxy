# Planning

## 目标
构建一个 OpenAI 兼容反向代理，前端暴露标准 OpenAI API，后端使用 AAD Bearer Token 与 Azure AI Foundry v1 通讯。提供静态管理页面用于配置、重载与统计。

## 关键需求
- Node.js 实现，低延迟优先
- 支持 `/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/models`
- SSE 流式转发
- JSON 配置保存与手动重载
- 管理页面配置鉴权模式（Service Principal / System Assigned）并验证 AAD
- Client→Proxy 使用 API Key，多 Key 支持
- Proxy→Foundry 使用 AAD Bearer Token
- 统计看板：按模型请求数、token 数、错误数

## Foundry v1 上游约定（关键）
- 上游数据面路径使用 `/openai/v1/*`（例如：`POST {endpoint}/openai/v1/chat/completions`）。
- `api-version` 为可选参数；不指定时默认为 `v1`。
- 请求体中的 `model` 是 deployment identifier；代理侧通过 `models[].targetModel` 映射到上游 deployment。

## 架构概述
- Fastify 作为 HTTP 服务器
- @azure/identity 获取 AAD Bearer Token
- 配置文件驱动模型与端点映射
- 静态管理页通过管理 API 保存/重载配置

## 运行时与部署
- 单容器模式：Node.js + Caddy 同容器（TLS 入口默认 443）
- 配置与证书持久化：`/app/data/config.json`、`/app/data/Caddyfile`、`/app/data/caddy/`
- 管理页面保存配置后触发 Caddyfile 生成与热重载

## 配置规范
- `server.caddy` 控制 Caddyfile 生成与 TLS 入口
- `models[].routes` 支持路由覆盖（如 chat → responses）
- `upstreams[].routes` 统一定义上游路径模板

## 关键运行路径
- 客户端请求 → API Key 鉴权 → 代理请求上游
- AAD Token 获取与缓存 → 上游请求
- 统计累积：按模型请求数 / token / 错误计数
- 管理页保存 → 配置校验 → 写入持久化配置 → 生成 Caddyfile → `caddy reload`

## 实施步骤
1. 初始化 Node.js 项目结构与依赖
2. 实现配置读取/保存/重载模块
3. 实现 AAD Bearer 获取与缓存
4. 实现 OpenAI 兼容代理与 SSE 转发
5. 实现管理 API 与静态管理页
6. 增加统计与模型列表接口

## 验收清单
- 管理页可保存/重载配置
- AAD Bearer 验证成功
- 支持三类端点与 SSE
- API Key 鉴权生效
- 模型统计可视化

## 风险与注意事项
- ACI 挂载 Azure Files 仍需账户密钥；密钥禁用需另行处理
- ACME 证书依赖 80/443 或 DNS-01 验证
- Caddy 数据目录未持久化将导致证书重复申请
- 生产环境需替换默认管理员账号与 API Key

## 后续演进
- 统一日志面板（含 Caddy/ACME 状态）
- 指标导出（Prometheus/OpenTelemetry）
- 管理接口 RBAC（更细粒度权限）
