# Feature Flag 与布尔开关目录

本文是当前用户可配置布尔开关的统一中文索引，适用于配置 schema version 3。它同时列出真正的 Feature Flag、运行策略开关、环境门禁，以及配置中存在但尚未实现的预留字段。

## 去哪里配置

- 管理页：访问 `/admin`。常用开关位于 **Workspace**、**Routing** 和 **Ops**。
- 完整 JSON：管理页的 Advanced JSON Editor，或直接编辑 [`config/sample_config.json`](../../config/sample_config.json) 对应的持久化配置。
- 权威默认值：[`src/config.js`](../../src/config.js) 中的 `DEFAULTS`。
- 环境变量：由容器或进程环境设置，优先于持久化配置。

本文中的“热生效”指通过管理页保存，或编辑持久化配置后调用 `/admin/api/reload`。直接修改磁盘 JSON 不会自动重载。环境变量始终需要重启进程或容器。

标记说明：

- **UI**：管理页有专用控件。
- **JSON**：仅通过 Advanced JSON Editor 或配置文件设置。
- **热**：保存或 reload 后用于后续请求。
- **重启**：涉及进程、容器入口或部署资源，必须重启或重新部署。

## 当前有效开关

### 管理、安全与 Caddy

| 配置项 | 代码默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `admin.auth.enabled` | `false` | 启用管理端 Basic Auth。非回环监听还会执行 fail-closed 安全校验。示例配置为 `true`。 | Workspace；热；可被环境变量覆盖 |
| `admin.security.csrfProtection` | `true` | 要求管理端写请求携带 CSRF header。 | JSON；热 |
| `admin.features.enableLegacyJsonEditor` | `true` | 显示 Advanced JSON Editor；不影响专用表单。 | Workspace；热 |
| `server.trustProxy` | 未设置等同 `false` | 信任受控反向代理提供的转发 IP header。只有 Node 无法被客户端直接访问时才应开启。 | Workspace；热；可被环境变量覆盖 |
| `server.caddy.enabled` | `false` | 生成并 reload Caddyfile。若容器启动时没有运行 Caddy，首次启用仍需重启容器。 | Ops；参数热，启停可能需重启 |

### 代理、超时与请求策略

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `proxy.timeouts.allowPerRequestOverride` | `false` | 允许请求使用 `requestOverrideFields` 中声明的代理超时控制字段，并受对应上限约束。 | JSON；热 |
| `proxy.retries.classifyNetworkErrorsAsRetryable` | `true` | 将支持的网络错误分类为可重试；仍受 retry 次数和“输出前重试”约束。 | JSON；热 |
| `proxy.httpClient.forceIpv4` | `false` | 让上游 Undici 连接优先使用 IPv4。保存后会重建 HTTP client。 | JSON；热 |
| `proxy.forwardHeaders.addRequestIdHeader` | `true` | 向上游注入请求关联 header。 | JSON；热 |
| `proxy.guards.maxRequestBodyBytes` | `52428800` | 公开代理路由的原始请求体策略上限；在解析前统计，实际还受启动时 `BODY_LIMIT` 硬上限约束。 | JSON；热 |
| `proxy.guards.maxResponseBodyBytes` | `52428800` | 需要缓冲的上游 JSON 响应上限；不作为 SSE 总流量上限。 | JSON；热 |
| `proxy.guards.rejectUnknownProxyParams` | `false` | 拒绝未知的代理专属超时控制字段；不是通用 OpenAI 字段白名单。 | JSON；热 |
| `proxy.guards.dropUnsupportedOpenAiParams` | `false` | 将请求策略判定为不允许的 OpenAI 字段静默删除；关闭时返回错误。 | JSON；热 |
| `proxy.guards.sanitizeMeaninglessValues` | `true` | 删除目标协议没有意义的空值，减少上游参数校验失败。 | JSON；热 |
| `models[*].requestPolicy.dropUnsupportedParams` | `false` | 模型级参数策略命中时丢弃字段，而不是拒绝请求。 | JSON；热 |
| `upstreams[*].requestPolicy.dropUnsupportedParams` | `false` | 上游级参数策略命中时丢弃字段，而不是拒绝请求。 | JSON；热 |

### 路由与错误透传

`<route>` 可取 `chatCompletions`、`responses`、`messages`、`imageGenerations`。

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `routing.routeProfiles.<route>.enabled` | `true` | 公开路由总闸；关闭后对应入口返回 404。 | Workspace；热 |
| `routing.routeProfiles.<route>.nativeErrorPassthrough` | `false` | 在入口协议与后端协议相同且无需 shim 时，透传上游原生错误 body。 | JSON；热 |
| `upstreams[*].errorPolicy.nativePassthrough` | `false` | 上游级原生错误透传。与 route profile 开关为 OR 关系，仍只适用于原生协议路径。 | JSON；热 |

图片生成还同时受 `media.generation.enabled` 控制；两个开关都为 `true` 时路由才可用。

### 媒体处理

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `media.inputCompression.enabled` | `false` | 压缩请求中的内联图片。 | Workspace；热 |
| `media.inputCompression.progressive` | `false` | JPEG 输出使用 progressive 编码；仅在压缩启用且输出为 JPEG 时有效。 | Workspace；热 |
| `media.inputCompression.useMozJpeg` | `true` | JPEG 输出优先使用 mozjpeg 编码参数。 | Workspace；热 |
| `media.remoteImages.allow` | `false` | 允许代理下载请求中引用的远程图片；仍受 MIME、host、大小和超时限制。 | Workspace；热 |
| `media.generation.enabled` | `true` | 启用图片生成能力；还需要对应 route profile 开启。 | Workspace；热 |

### 日志、Log Analytics 与 Runtime Store

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `observability.logs.redactApiKeyInfo` | `true` | 隐藏 API Key 记录标识等关联信息。API Key secret 无论此值为何都不会明文记录。 | Workspace；热 |
| `observability.logs.includeClientIp` | `true` | 在结构化日志中保留客户端 IP。 | Workspace；热 |
| `observability.logs.includeUsage` | `true` | 在日志中保留 token usage 与费用字段。 | Workspace；热 |
| `observability.logs.includeHeaders` | `false` | 在允许的内容模式下保留经过清洗的 header 信息；凭据仍强制脱敏。 | Workspace；热 |
| `observability.logAnalytics.enabled` | `false` | 启用 Azure Log Analytics 上传 sink；还需要完整 DCE/DCR 配置。 | Workspace；热 |
| `observability.runtimeStore.enabled` | `true` | 启用 PostgreSQL runtime event/rollup store；仅当活动持久化模式使用数据库时有效。 | JSON；热 |

### 持久化与访问治理

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `persistence.compatibilityExport.enabled` | `true` | 允许把规范配置额外导出到兼容路径。 | Workspace；保存时生效 |
| `persistence.compatibilityExport.exportLegacyConfigOnChange` | `true` | 配置变更时执行兼容导出；与上一开关同时为 `true` 才会写出。 | Workspace；保存时生效 |
| `access.defaults.requireApiKey` | `true` | 要求公共代理请求通过已配置的客户端 API Key。 | Workspace；热 |
| `access.budgets.enabled` | `false` | 启用全局预算治理。具有正数独立额度的 Key 仍可进入 Key 级预算逻辑。 | Workspace；热 |

### 客户端兼容与协议 Shim

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `compatibility.claudeCode.enabled` | `true` | 发布 Claude Code 专用模型目录；不会关闭基础 Messages 路由，也不控制 Anthropic header/beta 策略。 | Harness；热 |
| `compatibility.codex.enabled` | `true` | 发布 Codex 专用模型目录；不会关闭基础 Responses 路由，也不改变 Responses 终态校验。 | Harness；热 |
| `compatibility.protocolShim.rejectLossyRequests` | `false` | 默认尽力转换并记录 warning；开启后，跨协议请求无法无损表示时返回 400。 | Workspace；热 |
| `compatibility.protocolShim.rejectLossyResponses` | `false` | 默认尽力转换并记录 warning；开启后，JSON 或 SSE 响应无法无损表示时拒绝/终止转换。 | Workspace；热 |
| `compatibility.anthropic.forwardSdkMetadataHeaders` | `true` | 在 Messages 路径转发安全的 `anthropic-*`、`x-anthropic-*`、`x-claude-*`、`x-stainless-*` 元数据；凭据类 header 始终阻断。 | Workspace；热 |
| `compatibility.anthropic.unknownBetaPolicy` | `allow-direct-anthropic` | `allow-direct-anthropic` 仅对直连 Anthropic 上游保留未知 beta；`allowlist` 对所有上游执行白名单。 | Workspace；热 |
| `compatibility.anthropic.betaAllowlistEnabled` | `true` | 对 Azure/Foundry Messages 上游过滤未审核的 `anthropic-beta`；直接 Anthropic 上游保留未知值。 | Workspace；热 |
| `compatibility.anthropic.normalizeManualThinkingToolChoice` | `true` | 修正 manual thinking 与强制工具选择的不兼容组合。 | Workspace；热 |
| `compatibility.anthropic.sanitizeCacheControl` | `true` | 清理目标 Messages 实现不支持的 `cache_control` 位置或属性。 | Workspace；热 |
| `compatibility.anthropic.validateThinkingByModel` | `true` | 按模型元数据校验 Claude thinking type 与 effort。 | Workspace；热 |
| `models[*].clientCompatibility.claudeCode` | `false` | 将模型纳入 Claude Code 专用目录；模型必须启用、上游可用、公共 Messages 开启且最终原生路由到 Messages。不是访问控制。 | Harness；热 |
| `models[*].clientCompatibility.codex` | `false` | 将模型纳入 Codex 专用目录；模型必须启用、上游可用、公共 Responses 开启、最终原生路由到 Responses，且不是图片生成/编辑模型。不是访问控制。 | Harness；热 |

## 固定安全不变量

下列字段虽然是布尔值，但不能作为 Feature Flag 切换：

| 配置项 | 固定值 | 行为 |
| --- | --- | --- |
| `proxy.retries.retryBeforeFirstChunkOnly` | `true` | 代理只允许在响应输出开始前重试。设置为 `false` 会导致配置校验失败，以防止流式响应或有副作用请求被不安全地重放。 |

Responses 源流始终必须出现顶层 `response.completed` 或 `response.incomplete`；`output_item.done`、其他局部 done 事件或 EOF 不能替代协议终态，此行为不受 Codex 目录开关控制。

## 兼容别名与旧字段

这些字段不应作为新的配置入口：

| 字段 | 状态与替代项 |
| --- | --- |
| `server.adminAuth.enabled` | 由规范字段 `admin.auth.enabled` 重建的运行时兼容镜像。 |
| `server.imageCompression.enabled` | 由 `media.inputCompression.enabled` 重建的旧版兼容镜像。 |
| `persistence.configStore.database.enabled` | 仅当原始配置没有 `persistence.configStore.mode` 时作为旧版启动回退。新配置应设置 `mode`；示例配置已有 `mode` 时切换此 checkbox 不会改变活动模式。 |

## 预留或当前未接线字段

以下字段存在于默认 schema，但当前版本不会按名称提供对应功能。不要依赖它们控制生产行为。

### 启用即被拒绝

- `routing.fallbacks.enabled`（默认 `false`）
- `routing.cooldowns.enabled`（默认 `false`）
- `routing.healthChecks.enabled`（默认 `false`）

这三项是预留能力；设置为 `true` 会被配置校验明确拒绝。

### 当前没有运行时读取点

| 字段 | 当前状态 |
| --- | --- |
| `admin.auth.allowBasicAuth`、`admin.auth.allowOidc` | Basic Auth 仍由 `admin.auth.enabled` 控制；当前没有 OIDC 实现。 |
| `admin.security.auditAllWrites`、`admin.security.maskSecretsInUi` | 管理写日志和 UI secret 脱敏当前为强制行为。 |
| `admin.features.enableConfigImportExport`、`admin.features.enableDangerousActions` | 当前不控制导入导出、restart API 或对应按钮。 |
| `routing.healthChecks.trackLatency` | 健康检查调度器尚未实现。 |
| `routing.preCallChecks.validateModelCapabilities`、`routing.preCallChecks.validateContextWindow`、`routing.preCallChecks.validateImageInput` | 当前没有 pre-call check 消费路径。 |
| `media.inlineImages.redactInLogs` | 内联二进制日志清洗当前始终强制执行；管理页中的同名 checkbox 不改变行为。 |
| `observability.logs.redactSecrets` | secret 清洗始终强制执行；管理页将其显示为不可关闭。 |
| `observability.metrics.enabled`、`observability.metrics.exposePrometheus`、`observability.metrics.includePerKeyMetrics`、`observability.metrics.includePerModelMetrics` | 当前没有 metrics collector 或 Prometheus 路由。 |
| `observability.audit.enabled`、`observability.audit.recordReadActions`、`observability.audit.recordWriteActions` | 当前没有由这些布尔值控制的审计模块；同组 retention 数值可能被 runtime store 使用。 |
| `access.defaults.enforceUserField`、`access.defaults.rejectClientSideMetadataTags` | 当前没有治理消费路径。 |
| `compatibility.enableLegacyConfigRead`、`compatibility.enableLegacyConfigWrite`、`compatibility.mapServerAdminPathToAdminBasePath`、`compatibility.mapImageCompressionToMediaInputCompression`、`compatibility.mapServerUpstreamToProxyDefaults`、`compatibility.warnOnDeprecatedFields` | 旧配置归一化目前无条件执行，这些开关不改变迁移行为。 |
| `upstreams[*].healthCheck.enabled` | 上游健康检查调度器尚未实现。 |

## 布尔环境门禁

环境变量优先于持久化配置，并在管理页保存时受到保护，不会把环境中的 secret 或有效值写回 JSON。为兼容容器入口，推荐只使用字符串 `true` 或 `false`。

| 环境变量 | 未设置时 | 功能与生效方式 |
| --- | --- | --- |
| `AOAI_PROXY_ADMIN_AUTH_ENABLED`（旧名 `ADMIN_AUTH_ENABLED`） | 不覆盖配置 | 覆盖管理认证；设置管理密码时也会默认启用。重启生效。 |
| `AOAI_PROXY_CADDY_ENABLED`（旧名 `CADDY_ENABLED`） | 不覆盖配置 | 覆盖 Caddy 启停；设置 Caddy domain 时也会默认启用。重启生效。 |
| `AOAI_PROXY_TRUST_PROXY`（旧名 `TRUST_PROXY`） | 不覆盖配置 | 覆盖 `server.trustProxy`。重启生效。 |
| `ALLOW_INSECURE_PUBLIC_ADMIN` | `false` | 跳过非回环监听的管理认证和占位凭据启动门禁。仅用于显式兼容，不建议生产开启。重启生效。 |

Node 配置解析器也接受 `1/0`、`yes/no`、`on/off`，但容器 Caddy 入口的接受范围更窄，因此统一使用 `true/false` 最稳妥。

## 部署期布尔参数

`infra.parameters.allowAzureServicesToDatabase=false` 属于 Azure 部署模板参数，不是代理运行时 Feature Flag。开启后会创建允许 Azure 服务访问 PostgreSQL 的 `0.0.0.0` 防火墙规则，需要重新部署基础设施。

## 维护规则

新增或修改开关时，应同步更新：

1. [`src/config.js`](../../src/config.js) 中的默认值、归一化和校验。
2. [`config/sample_config.json`](../../config/sample_config.json) 中面向用户的示例。
3. 管理页控件与中英文文案（适用时）。
4. 本目录中的用途、默认值、生命周期和实现状态。
5. 至少一个验证开启与关闭行为的测试；预留字段应明确拒绝或标注未接线。
