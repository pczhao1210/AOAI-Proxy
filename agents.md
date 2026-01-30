# Requirements

## 功能
- Node.js 实现低延迟 OpenAI 兼容反向代理
- 支持端点：`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations`、`/v1/models`
- 支持 SSE 流式转发
- 支持多模型与多端点映射，通过 JSON 配置驱动
- 支持模型级路由覆盖（`models[].routes`）与上游路由映射（`upstreams[].routes`）
- 支持 Caddy 生成与 TLS 入口（单容器可选）

## 鉴权
- Client→Proxy 使用 API Key（Header 支持 `Authorization: Bearer` 与 `x-api-key`）
- Proxy→Foundry 使用 AAD Bearer Token（DefaultAzureCredential）
- 服务主体与系统分配身份可选，支持在管理页配置并验证

## 管理与配置
- 静态管理页面
- 配置可保存并手动重载
- 统计仪表盘：按模型请求数、token 数、错误数
- 管理页支持 Caddy 域名/TLS 配置并热重载

## 约束
- Azure AI Foundry 使用 v1 接口，无 API 版本
- 上游数据面路径使用 `/openai/v1/*`（例如：`POST {endpoint}/openai/v1/chat/completions`）
- 请求体中的 `model` 是 deployment identifier（配置用 `models[].targetModel` 表示）
- 配置与密钥只在 Proxy 内部保存，不向上游转发
- ACME 证书与 Caddy 状态需持久化（推荐 `/app/data/caddy`）
- ACI 挂载 Azure Files 仍需账号密钥（若禁用 Shared Key 需额外处理）

## 终端使用约束
- 测试时优先使用同一个终端，不要重复新建
- 如需长期运行的进程（例如 Web Server），保持该终端不被中断，另开终端进行连通性测试

## 运维建议
- 默认管理账号与 API Key 必须在生产环境替换
- 证书签发依赖 80/443 或 DNS-01 验证
- 容器重建前确保持久化卷挂载到 `/app/data`
