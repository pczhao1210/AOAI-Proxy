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

请求头白名单模式下，`proxy.forwardHeaders.allow: []` 不放行普通客户端 header；明确允许的协议元数据仍按既有规则处理，凭据硬过滤始终优先。代理自身生成的上游认证和请求关联 header 不受此空列表影响。

HTTP 状态码重试只依据最终解析出的 `statuses` 列表；显式空列表表示不按 HTTP 状态码重试。未配置时沿用默认列表，模型或上游的显式覆盖仍按原有优先级生效。网络错误重试另受 `classifyNetworkErrorsAsRetryable` 和最大重试次数控制，已向客户端输出后不重试。

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
| `media.inputCompression.enabled` | `false` | 启用所选内联图片处理模式；`preserve` 始终保留原图。 | Workspace；热 |
| `media.inputCompression.progressive` | `false` | JPEG 输出使用 progressive 编码；仅在压缩启用且输出为 JPEG 时有效。 | Workspace；热 |
| `media.inputCompression.useMozJpeg` | `true` | JPEG 输出优先使用 mozjpeg 编码参数。 | Workspace；热 |
| `media.remoteImages.allow` | `false` | 允许向上游透传远程图片 URL，并检查 `allowedHosts`；代理不下载图片，也不验证远端文件的 MIME、大小或像素。 | Workspace；热 |
| `media.generation.enabled` | `true` | 启用图片生成能力；还需要对应 route profile 开启。 | Workspace；热 |
| `media.http.enabled` | `false` | 启用独立音频、图片 multipart 编辑、MAI Speech 原生入口及显式绑定的 Responses Speech 适配器；不改变既有图片生成开关。 | Workspace；热 |
| `media.realtime.enabled` | `false` | 启用 Realtime WebSocket 对话、转写和翻译。 | Workspace；热，仅新连接 |
| `media.webrtc.enabled` | `false` | 启用 WebRTC 建连及所有权校验后的 sideband/hangup；媒体和 data channel 直连 provider。 | Workspace；热，仅新请求 |
| `media.webrtc.allowClientSecrets` | `false` | 允许导出上游短期凭证；还需开启 WebRTC，管理页开启时要求确认。 | Workspace；热 |

文本协议的图片策略只检查正式图片内容块，覆盖 Chat、Responses、Messages 及支持的工具结果图片，不递归处理同名业务字段。关闭压缩仍执行远程 URL 策略和内联字节限制；字节上限按解码后大小计算，在分配图片 Buffer 前校验。`legacy` 模式下合法 Messages 图片仍保留原字节和 MIME；只有显式启用 `adaptive` 才会尝试优化 Messages 的 JPEG。

#### 音频与实时连接限额

以下参数均可在 Workspace 媒体策略中配置，时间单位为毫秒，大小单位为字节。计数和限额按进程生效，不是跨实例配额。默认值分别由 [HTTP 媒体](../../src/proxy/media-body.js)、[WebSocket](../../src/proxy/realtime-policy.js) 和 [WebRTC](../../src/proxy/realtime-calls.js) 定义。

| 配置前缀 | 参数与默认值 | 行为 |
| --- | --- | --- |
| `media.http` | `maxUploadBytes=26214400`、`maxFiles=10`、`maxFields=64`、`maxFieldBytes=65536` | multipart 总上传、文件数量、普通字段数量及单字段限额。模型字段必须唯一。 |
| `media.http` | `maxConcurrentUploads=4`、`maxBufferedUploadBytes=314572800`、`uploadTimeoutMs=60000` | 上传并发、总缓冲预留与上传期限；每次上传按 `maxUploadBytes * 3` 预留容量。 |
| `media.http` | `maxResponseBytes=104857600` | 原生音频、文本、JSON、SSE 响应总字节上限；其他上游超时沿用代理策略。 |
| `media.realtime` | `maxConnections=100`、`maxMessageBytes=8388608`、`maxBufferedBytes=16777216` | 包含等待首配置与握手的连接上限；单消息及发送缓冲上限，超限终止而不重放音频。 |
| `media.realtime` | `handshakeTimeoutMs=10000`、`initialConfigTimeoutMs=10000`、`maxInitialConfigBytes=65536` | 上游握手与转写首配置的时间/大小边界。 |
| `media.realtime` | `idleTimeoutMs=60000`、`maxSessionMs=3600000`、`heartbeatMs=30000` | 空闲、最长连接寿命与 ping/pong 周期。 |
| `media.webrtc` | `maxCalls=100`、`maxSetupBytes=262144`、`maxResponseBytes=262144`、`setupTimeoutMs=15000` | 包含创建中的调用容量；SDP/session 上传、上游结果与创建时间边界。 |
| `media.webrtc` | `callTtlMs=3600000`、`clientSecretTtlSeconds=60` | 调用到期尝试上游挂断；凭证 TTL 为秒，允许 10–7200。凭证过期不终止已建立的 provider 会话。 |

这三个传输开关在 `minimum` 和 `nextgen` 均默认关闭，必须同时有可用模型绑定和正确上游路径。原生媒体错误保持上游状态和 body，不使用文本协议错误包装开关。已有 WS 与 WebRTC 调用保留创建时的路由和限额快照；关闭开关或修改路由不是挂断全部活动调用的命令。

Responses Speech 同时检查 `routing.routeProfiles.responses.enabled` 和物理路由键 `routing.routeProfiles["audio/transcriptions"].enabled` / `["audio/speech"].enabled`。JSON 请求仍受全局 body limit（默认 50 MiB）和 `proxy.guards.maxRequestBodyBytes` 约束，不绕过 JSON 上传保护。转写只接收一个内联文件，解码后不超过 `maxUploadBytes`；其原始 JSON 结果限额为 `min(maxResponseBytes, 1 MiB)`。Voice 在调用上游前预留音频收集和 base64/JSON 编码容量：原始音频限额为 `min(maxResponseBytes, floor((maxBufferedUploadBytes - 16 * 输入UTF8字节数 - 65536) / 10))`，默认略低于 30 MiB；编码结果另受 `4 * ceil(原始限额 / 3) + 65536` 限额。预留与 multipart 共用并发及总缓冲池，因此同时请求可能收到容量不足错误。原生音频仍直接流式返回，不受 Voice JSON 编码限额影响。详见 [Responses Speech 配置及调用](../protocols/protocol-support.md#responses-speech-profile)。

WebRTC 所有权记录只在进程内保存，必须使用单实例或确保创建、sideband、hangup 落到同一实例。未知/其他 key 的 call ID 返回 404，不尝试其他上游。sideband 断开不释放调用租约；到期挂断未被 provider 确认时仍占用容量，所有者可重试 hangup。重启丢失记录，不承诺恢复活动媒体；停机只尽力挂断，强制退出可能留下 provider 会话。

媒体 usage 按独立 response/item 去重，并按创建/观察时的价格快照计算已知费用，支持分通道及缓存 token、时长、字符单位。单价与预算数字使用 USD 单位；币种配置继续可编辑，但旧标签不影响数值相加，显示统一为 USD，不做汇率转换或历史回填。缺少计数/价格或会话未完整结束时，总费用为 `null`，状态为 `unknown/partial`，保留已知 USD 小计。OpenAI 官方价格不自动用于 Azure；显式覆盖需声明 `billingUnit`，见[媒体计价](../../pricing/README.md#media-usage-pricing)。

结算在 HTTP 完成、WS 清理或 WebRTC call 结束时执行，并使用现有 runtime store 队列；数据库模式保存白名单摘要和已知金额，文件模式不承诺持久化账本。活动会话崩溃可能丢失尚未结算的观察，不能保证 provider 账单完全一致或跨进程恰好一次。数据库媒体摘要/未知计数受明细保留期约束，历史已知金额仍保存在 rollup；管理端金额为已知估算小计。

事后入账不是预留或硬预算，带 TPM 或预算约束的 key 仍前置拒绝；WebRTC 还拒绝有模型白名单的 key。凭证导出进一步拒绝并发受限 key，因为同一凭证可能创建多个会话、改变配置并绕过代理。要求逐事件内容策略的工作负载不能使用 WebRTC 直连。不得在浏览器嵌入代理或上游长期密钥。协议和启用步骤见 [协议支持](../protocols/protocol-support.md)。

#### 输入图片模式与资源预算

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| `media.inputCompression.mode` | `legacy` | `legacy` 保持既有行为；`preserve` 不重编码；`adaptive` 仅尝试优化文本协议内联 JPEG。默认仍为关闭压缩。 |
| `media.inputCompression.minBytes` | `262144` | 自适应模式的单图字节门槛；小图在解码前跳过。 |
| `media.inputCompression.minSavingsRatio` | `0.1` | 输出至少节省 10% 才采用；输出变大或收益不足时保留原字节。 |
| `media.inputCompression.maxPixels` | `40000000` | 自适应解码像素上限；超限则保留原图交给上游，不作为本地协议拒绝理由。 |
| `media.inputCompression.maxConcurrent` | `2` | 每进程并发编码上限，范围 1–32；取消后底层工作未完成时仍占名额。 |
| `media.inputCompression.maxQueue` | `8` | 每进程待处理队列上限，范围 0–256；0 表示不排队，队列满则保留原图。 |
| `media.inputCompression.timeoutMs` | `5000` | 单请求自适应图片准备预算，包含排队，范围 1–60000 ms；预算耗尽后保留剩余原图。 |
| `media.inlineImages.maxImages` | `0` | 正式图片块数量预算，计入 URL、内联和 Responses `file_id`；0 不设新增上限。 |
| `media.inlineImages.maxTotalBytes` | `0` | 单请求全部内联图片累计字节预算，重复出现也计入；0 不设新增上限。 |

自适应模式不下载 URL、不处理图片生成/编辑与 mask，不改变 `detail`、内容顺序或文件 ID。
PNG、WebP、GIF 等非 JPEG 原样保留，不判断截图是否适合有损编码；已经是 JPEG 的文字截图也可能被重编码，OCR 场景建议使用 `preserve`。
JPEG 处理应用 EXIF 方向、等比缩放且不放大、不裁切，转换到 sRGB 并嵌入 ICC；输出仍是 JPEG，忽略旧版 `outputFormat` 选项。
实际质量取 `quality`、`minQuality` 与保守下限 `0.6` 的最大值。编码失败或输入不可解码时保留原图；不会把优化失败伪装为上游成功。
数量或字节预算属于管理员显式策略，超限返回 400，且不访问上游。远程内容大小不在本地累计字节预算内。

自适应编码在治理准入后执行；客户端断开会取消排队、停止后续优化并阻止继续上传。
正在进行的原生编码不保证瞬时中断，Sharp 的执行时限按秒取整，但未结束的工作始终计入并发名额。
请求内重复 JPEG 复用结果，不建立跨请求图片缓存。`proxy.image_optimization` 日志只记录原因、字节、尺寸和耗时，不含图像内容或媒体 URL；实际输出还受日志级别/开关控制。
这些新资源参数只约束 `adaptive`，不会追溯改变 `legacy` 编码路径。字节节省不代表视觉 token 节省或识别质量不变。

可复现样例与合成基线见 [图片基线](../development/image-optimization-baseline.md)。真实照片/OCR 质量和部署负载仍须单独验收后再启用。

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

文本上下文计费不新增布尔开关。`models[].pricing`、`access.pricingCatalog[pricingRef]`
和模型卡 `pricing` 可声明 `tiering.method: "whole-request"`，
按包含缓存的输入总量选择 `[promptTokensAtLeast, promptTokensBelow)` 区间，整次请求
采用该档费率。JSON 和 SSE 均使用上游 usage；不根据输出 delta 推测输入长度。
卡中的 `pricingCatalogEntry: null` 仍然禁用自动计费，仅有 `short/long` 标签不能选档。
活动卡默认省略重复的 `pricingCatalogEntry`；只有明确覆盖 `pricing` 时才保留非空值。
旧版完整卡与每千 token 价格仍可读取；新卡使用每百万 token 单一写法。
详见[分档 schema、缓存和未知费用](../../pricing/README.md#whole-request-text-pricing)。

价格配置保存/reload、有效模型卡同步后对新请求热生效，进行中的请求保留原价格快照。
首次安装计价引擎需构建管理端并部署新容器。区间错误会拒绝配置或目录激活，
不会回退至短档；缺失 usage/费率和本地估算保留未知状态，预算金额只累计已知小计，
不是请求前预付费硬上限。旧统计不回填、不重新计价。

缓存写入与缓存读取分别展示，管理端统计与 PostgreSQL event/rollup 记录写入 token
和写入费用。显式 `0` 与上游未报告不同；缺失计数或费率显示未知，不视为免费。
Chat/Responses 的普通输入量为输入总量减去缓存读取及写入，写入按独立费率收费，
不得再次加入总 token 或重复收取普通输入费用。相关费率可在定价 JSON 中使用
`cacheWritePer1mTokens`、`cacheWrite5mPer1mTokens`、`cacheWrite1hPer1mTokens`，
分档时需在每档独立声明。数据库通过兼容性迁移添加字段；已有历史缺失值不会编造成零。

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
