# Task Log

## 已完成
- 初始化 Node.js 项目结构
- 创建配置文件与管理页面
- 实现 AAD Bearer 获取与缓存
- 实现 OpenAI 兼容端点与 SSE 转发
- 实现统计与模型列表接口

## 备注（长期记忆）
- Client→Proxy 仅使用 API Key；Proxy→Foundry 仅使用 AAD Bearer
- JSON 配置手动重载，失败时保持旧配置
- 管理页为内置静态页面
