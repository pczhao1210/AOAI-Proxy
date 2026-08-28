# aoai-minimum 核心更新审计（2026-08-13）

## 范围

- 对比基线：`aoai-minimum@34b0168`，最后更新于 2026-07-11
- 参考主线：`master@c81ab19`
- 目标：只移植缺陷修复、路由可靠性和必要的协议兼容，不引入较重的 nextgen 管理与观测能力

`aoai-minimum` 与 `master` 在 `88c3400` 后独立演进，不能安全地直接合并或批量 cherry-pick。本轮更新按函数和行为手工移植，并使用 minimal 自己的测试结构验证。

## 已移植

| 项目 | 行为变化 | 参考主线演进 |
| --- | --- | --- |
| 最终 URL 协议校准 | 路径带 query/hash 时仍能识别 `/responses`、`/chat/completions`；最终 URL 与 route key 不一致时按实际 URL 选择 Shim | `f466674` |
| GPT-5.6 条件路由 | Luna、Sol、Terra 的 Chat 请求在上游存在 Responses 路由且没有显式覆盖时自动走 Responses | `da52da9`、`703bd45` |
| Responses 工具描述 | function/custom/namespace/additional tools 缺少描述时使用工具名补齐，避免上游 `400` | `c617fb2`、`09a5a3f` |
| Reasoning effort | Chat→Responses 转换保留 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` | `da52da9` 及后续修正 |
| Chat 工具历史清理 | 删除孤立 tool message、重复结果和未完成的 assistant tool-call 回合，完整回合保持不变 | `2d78b83` |
| Provider 假成功修复 | HTTP 200 中的 `status: failed`、`response.failed` 或结构化 `error` 在映射前返回 `502` | `b35a858` |
| 流完整性检查 | Chat/Responses 流在缺少协议终止证据时返回 `UPSTREAM_INCOMPLETE_STREAM`，不再把提前 EOF 当成功 | `b35a858` 及后续修正 |
| SSE 尾帧解析 | 最后一个事件即使没有末尾换行，也能被解析为有效完成证据 | 后续 stream 修正 |

## 2026-08-28 补充修复

- Responses→Chat 非流式映射不再只读取 `output[0]`；reasoning 位于首项时，会继续扫描后续 message 内容。
- `response.output_item.done` 与 `response.reasoning.done` 不再单独证明 Responses 流完整；缺少 `response.completed`、`response.incomplete` 或协议终止标记时返回 `UPSTREAM_INCOMPLETE_STREAM`，不生成空的成功 Chat 尾帧。
- 已增加 reasoning-first JSON 与 reasoning-only 提前 EOF 回归。生产故障日志包含 minimal 分支不存在的完整 protocol-shim 遥测，部署镜像对齐仍是发布前门禁。

## 路由规则

GPT-5.6 自动提升仅在以下条件全部满足时启用：

1. 客户端调用 `/v1/chat/completions`。
2. 模型 ID 或 `targetModel` 是 `gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`，版本后缀也可识别。
3. 上游配置了 `routes.responses`。
4. 模型没有显式的 Chat 路由或通配路由。

显式配置始终优先。强制原生 Chat：

```json
{
  "routes": {
    "chat/completions": "chat/completions"
  }
}
```

固定走 Responses：

```json
{
  "routes": {
    "chat/completions": "responses"
  }
}
```

## 本轮未移植

| 能力 | 原因 |
| --- | --- |
| React 管理台、运行时治理、Log Analytics 管理 | 超出 minimal 的轻量定位，依赖和代码量较大 |
| Anthropic Messages 完整协议与 encrypted reasoning 状态转换 | 需要大规模 Shim 状态机和模型元数据，不适合作为小修复带入 |
| 自动 web_search 路由提升 | minimal 没有主线的模型能力元数据；全局自动提升可能改变本来支持原生 Chat web search 的模型行为 |
| 新增 Kimi、GLM、Claude 等定价目录 | minimal 不维护主线定价库，和核心代理可靠性无关 |
| 新版 config secret redaction | minimal 在 2026-07-11 的加固提交中已经具备等价的脱敏与恢复逻辑 |
| 主线 Feature Flags 与完整 protocol-shim 有损门禁 | 依赖 nextgen 配置架构；本轮只移植能独立验证的核心行为 |

## 验证

```bash
npm run test:routing-regressions
npm run test:safety
npm run test:routes
npm test
```

`test:routing-regressions` 不启动服务器，直接执行 `proxyRequest` 并 mock 上游，覆盖 GPT-5.6 路由、显式覆盖、query 路径、工具描述、工具历史、provider 失败 payload 和流完整性。