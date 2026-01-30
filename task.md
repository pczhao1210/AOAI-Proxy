# Task Log

## 已完成
- 初始化 Node.js 项目结构
- 创建配置文件与管理页面
- 实现 AAD Bearer 获取与缓存
- 实现 OpenAI 兼容端点与 SSE 转发
- 实现统计与模型列表接口
- 增加 Caddyfile 生成与热重载
- 增加容器内 Caddy 支持与 TLS 入口
- 增加配置/证书持久化路径
- 完善 ACI 持久化与托管身份文档

## 备注（长期记忆）
- Client→Proxy 仅使用 API Key；Proxy→Foundry 仅使用 AAD Bearer
- JSON 配置手动重载，失败时保持旧配置
- 管理页为内置静态页面
- Caddy 配置写入 `server.caddy`，生成 `/app/data/Caddyfile`
- Caddy 证书与 ACME 状态在 `/app/data/caddy`

## 待办（下阶段）
- 增加健康检查说明（/healthz）与常见故障排查
- 为 ACI 更新镜像提供一键重建脚本
- 增加密钥轮换与安全加固清单
- 记录 DNS-01 验证的 Caddy 配置示例
