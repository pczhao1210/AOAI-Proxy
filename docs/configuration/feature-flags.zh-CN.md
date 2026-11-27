# Feature Flag 与布尔开关目录

本文是当前用户可配置布尔开关的统一中文索引，适用于配置 schema version 3。它同时列出真正的 Feature Flag、运行策略开关、环境门禁，以及兼容读取但不再生成的弃用字段。

## 去哪里配置

- 管理页：访问 `/admin`（或自定义 `server.adminPath`）。常用开关位于 **设置** 的八个子页；渠道与模型策略位于对应实体的编辑抽屉。下文保留的 Workspace / Routing / Ops 名称对应迁移前的表单分区。
- 完整 JSON：配置中心 → JSON（需开启 `admin.features.enableLegacyJsonEditor`），或直接编辑 [`config/sample_config.json`](../../config/sample_config.json) 对应的持久化配置。
- 权威默认值：[`src/config.js`](../../src/config.js) 中的 `DEFAULTS`。
- 环境变量：由容器或进程环境设置，优先于持久化配置。

本文中的“热生效”指通过管理页保存，或编辑持久化配置后调用 `/admin/api/reload`。直接修改磁盘 JSON 不会自动重载。环境变量始终需要重启进程或容器。

设置页可按字段路径或标签搜索，并筛选已修改项。只读 `/admin/api/runtime` 的
`runtime.configuration.fieldMetadata` 提供已声明字段的来源、环境变量**名称**、
只读标记、profile 或重启要求，不包含环境变量值。页面按最长路径前缀标注对应字段，
环境变量管理和 profile 禁用项不可编辑；保存仍保留持久化原值。
未标明重启的控件显示“保存 / 重载”，这不是全部字段均可立即热生效的承诺，
具体边界以下文及重启检查为准。渠道、模型和 Key 抽屉中的“应用到草稿”不会保存或生效，
仍需全局审阅保存。

JSON 中的所有有效布尔开关及被迁移的旧布尔别名只接受 `true` / `false`。
字符串 `"false"`、数值 `0/1`、`null`、数组不能代替布尔值；保存或重载会返回包含字段路径的错误，
失败时保留原配置和 Model Catalog。下文环境变量的字符串解析规则不适用于 JSON。

标记说明：

- **UI**：管理页有专用控件。
- **JSON**：仅通过 Advanced JSON Editor 或配置文件设置。
- **热**：保存或 reload 后用于后续请求。
- **重启**：涉及进程、容器入口或部署资源，必须重启或重新部署。

## 普通渠道映射、暴露与 Key 权限

以下是 v3 配置的**字段摘录**。实际端点、认证仍属于原上游；没有新增认证方式或凭据。先在上游表格填写部署的准确 ID（Azure 基础模型目录不能代替部署清单），或在该渠道的 JSON 编辑器批量编辑同一数组。JSON 需应用到草稿，最终统一审阅保存。两个部署可以映射到同一 Catalog ID，不允许重复来源、通配符、映射链或按名字猜测。

```json
{
  "upstreams": [{
    "name": "west",
    "channelId": "az-west",
    "modelMappings": [
      {"sourceModelId": "mini-blue", "canonicalModelId": "gpt-5-mini", "enabled": true},
      {"sourceModelId": "mini-green", "canonicalModelId": "gpt-5-mini", "enabled": false}
    ]
  }],
  "models": [{
    "id": "team-mini",
    "canonicalModelId": "gpt-5-mini",
    "selectedBinding": {"channelId": "az-west", "sourceModelId": "mini-blue"}
  }],
  "apiKeys": [{"id": "team", "modelAccessMode": "selected", "allowedModels": ["team-mini"]}]
}
```

- `modelMappings[].enabled`（**UI / JSON，热**）只控制可选供给，不会发布模型、修改 Key 或加入 Harness。发布页从并集中批选，多个部署时必须选具体行；公开别名和顺序保存在 `models[]`。运行时先按公开 ID 鉴权，再用固定渠道及原始部署转发。禁用或删除一条正在使用的映射，必须先在同一草稿中切出或取消暴露。没有自动跨渠道重放。
- 行可选 `routes`（协议名到协议目标，不填 URL）、`hostingMode`、`pricing`。具体 URL 仍在 `upstreams[].routes`。迁移利用后端当前 Catalog 匹配，在草稿中保留旧公开 ID、顺序及策略；别名自己的路由/价格等放入带原部署引用的 `bindingOverride`，切回才再次生效。已迁移的模型不要再并列填写旧 `upstream` / `targetModel`。显式 Harness 路由确认由 `confirmedRouteBinding` 绑定到被确认的行；切换后保留成员并重新验证。上游会话、缓存和签名状态不会迁移。
- `channelId` 是稳定身份，改名不要改 ID。只有未迁移的上游沿用旧模型形态。读取不触发迁移；没有模型的已管理渠道可以保存，但不对外提供任何型号。
- 使用 API Key 的 `openai` 渠道若已保存，且地址为 `https://api.openai.com` 或 `https://api.openai.com/v1`（可带末尾 `/`），可点**获取可用型号 ID**。服务端使用已保存的渠道认证获取清单；确认 Catalog ID 后将所选条目添加为停用的草稿映射，不会发布。Azure 及其他普通渠道须手填实际部署名，不能把厂商型号目录当作账号部署清单。
- Key 的授权对象是**公开 ID**。新建 Key 默认 `selected: []`，不能调用任何模型。`all` 包含未来发布且启用的模型，不能与非空名单并用。旧 Key 省略模式时，非空名单按原 ID 限制，省略或空名单依旧不限制。删除被引用的 ID 时必须在 **Key 管理** 中显式修正名单；停用模型仍不可访问。`requireApiKey=false` 允许不带 Key 的匿名身份，不能用于强隔离。
- 保存、重载和回滚复用现有修订及应用流程。降低版本前先转换回旧版能等价表达的配置，尤其不要把 `selected: []` 转为旧版空名单（含义相反，应停用该 Key）。
- 若部署的服务端已配置获准的 Copilot 身份与凭据存储，可在**上游 / 模型 → 新增 GitHub Copilot 渠道**中选择 GitHub Copilot（VS Code）或 OpenCode 身份，在 GitHub 设备授权页面完成登录。查询状态只读；刷新清单是独立管理操作。草稿只接收服务端生成的 `credentialRef`，不填写 token；凭据不可用时不回落到 Azure 认证。
- Copilot 渠道不提供手填型号或映射 JSON。新发现的条目默认不勾选，只能勾选本连接当前可选、具有文本协议证据的准确 ID；名称相似不等于 Catalog 匹配，可显式选择正确的 Catalog ID。清单过期或失败时不能新增绑定，但可以停用映射或切出。变更使用原有全局草稿审阅保存。断开前要先保存解绑或切换；本地断开不会撤销 [GitHub 的 OAuth 授权](https://github.com/settings/applications)。

## 当前有效开关

### Copilot 启动前提（默认不启用）

- 部署方须获得所用应用、组织、账号和用途的授权。`COPILOT_VSCODE_CLIENT_ID`、`COPILOT_OPENCODE_CLIENT_ID` 分别指定**部署方获准使用**、已开启 device flow 的两个独立应用；可只配置获准的一个。代理不自带参考项目的应用 ID，不冒用编辑器标头，不读取机器的 GitHub 登录态。`vscode` 使用 OAuth 换短期推理 token；`opencode` 使用 OAuth 本身。二者不是用户名或账号池。
- 启用管理 Basic Auth。所有授权操作使用现有管理入口，写请求必须带 `x-aoai-admin-csrf: 1`。GitHub 密码、OAuth token、设备码不得放入配置。备份时将外部密钥和加密数据分别保护；详见[凭据存储与故障恢复](../development/copilot-credential-store.md)。
- 启动环境设置 `COPILOT_CREDENTIAL_KEY_VERSION` 和 `COPILOT_CREDENTIAL_KEYS`（版本到 base64 编码 32 字节密钥的 JSON 对象）。文件模式使用配置文件旁的 `.copilot-credentials` 私有目录；可用 `COPILOT_CREDENTIAL_DIRECTORY` 指定本机单写目录。多实例使用配置数据库及相同密钥、schema、configKey；禁止用共享文件目录代替数据库。修改应用、存储或主密钥后重启。
- 服务端只调用固定的 GitHub 设备授权、账号身份、token 交换和推理主机；不跟随重定向或身份返回的任意 URL。若组织需要专属端点或提供商要求代理无权使用的客户端身份，**不要上线该连接**。模型清单必须提供 `supported_endpoints` 中的已识别路径。只有 ID、显示名或模型家族，没有协议证据时不开通推理。
- 冷启动可继续使用已签发的绑定，无需联网重新勾选；未验证的手填绑定不能取得推理凭据。新增/切入须先刷新同一凭据的清单（15 分钟），不会自动切换承接渠道。401 令当前凭据版本失效，不重放已发送请求；403、429 不换账号。未给映射行显式定价时，Copilot 费用未知，不继承 Azure 卡价。
- 同一修订涉及多个新凭据时，`apply.proxy` 在同一个凭据存储事务中激活它们；一项冲突不会只切换部分渠道。冷启动若无法读取凭据，只停用相应运行时模型，不改写保存配置；修复密钥或存储后显式重载。渠道页区分推理凭据到期时间、后台续期能力及最早重试时间；供应商未给出的到期时间显示为未知。

### 管理、安全与 Caddy

| 配置项 | 代码默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `admin.auth.enabled` | `false` | 启用管理端 Basic Auth。非回环监听还会执行 fail-closed 安全校验。示例配置为 `true`。 | Workspace；热；可被环境变量覆盖 |
| `admin.security.csrfProtection` | `true` | 要求管理端写请求携带 CSRF header。 | JSON；热 |
| `admin.features.enableLegacyJsonEditor` | `true` | 显示 Advanced JSON Editor；不影响专用表单。 | Workspace；热 |
| `server.trustProxy` | `false` | 信任受控反向代理提供的转发 IP header。只有 Node 无法被客户端直接访问时才应开启。 | Workspace；热；可被环境变量覆盖 |
| `server.requireConfigRevision` | `false` | 要求配置保存提供 `If-Match` 修订号；缺失时返回 428。管理 UI 自动发送，旧 API 客户端需要先读取配置及 ETag。 | Workspace；热 |
| `server.caddy.enabled` | `false` | 生成并 reload Caddyfile。若容器启动时没有运行 Caddy，首次启用仍需重启容器。 | Ops；参数热，启停可能需重启 |

数据库模式下，同一 PostgreSQL 配置记录使用版本比较写入，跨实例的陈旧保存返回 409。
每个实例必须使用独立的本地配置缓存路径及待同步标记，即使使用共享 Azure Files 也如此。
数据库不可用时配置可先保存到本地；恢复时仅在数据库版本未变化时自动同步。版本冲突或
无法确定原版本时保留本地副本并显示待同步状态，不自动覆盖数据库。管理页可对比变更路径，
并在确认后丢弃待同步的本地副本、从数据库重载；需要保留时请先备份本地配置。
文件模式的 ETag 仅协调同一进程内的保存，不保护多进程或手工文件编辑；切换存储目标不提供跨存储事务。

离线保存先原子写入包含配置全文、原数据库修订和脱敏历史的待同步记录，再更新缓存；
重启以待同步记录为准，缓存写失败不会丢失已经保存的离线编辑。对比最新配置不推进本实例
的 CAS 基线；候选配置验证失败时，不更新活动配置、缓存或基线。

管理页的“配置历史”保留最近 **12** 个脱敏版本（含必要的初始快照）。数据库模式将历史与
配置一起存入同一记录的 `history_json`；文件模式使用相邻 `.history.json`。历史不是不可变
审计日志，也不是凭据备份；仅按现有敏感字段/凭据 header 规则脱敏，不识别任意扩展字符串
中嵌入的秘密。恢复先展示全部变更路径并确认，使用当前 `If-Match` 创建新的回滚修订，
保留当前凭据和整个持久化配置块。API Key 按 ID、上游按名称恢复凭据，不按数组位置借用；
已删除凭据、过期版本或验证失败都会明确拒绝。重启专属变更不能通过回滚热应用。

保存、重载、回滚与分阶段重试在本实例内串行执行。响应的 `ok` 表示保存/加载成功，
不代表所有应用阶段成功；分别查看 `apply.proxy`、`apply.caddy` 和 `apply.persistence`。
界面提示代理/Caddy 应用失败、待同步和缓存/历史副本失败，并可仅重试指定阶段，不重新
保存也不覆盖未保存草稿。Caddy reload 子进程最多执行 10 秒。回滚、阶段重试和显式丢弃
待同步配置均要求修订；丢弃使用比较接口返回的 `X-AOAI-Active-Config-Revision`。

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
| `proxy.guards.sanitizeMeaninglessValues` | `true` | 清理可选控制参数的空值和 `"undefined"` / `"[undefined]"` 占位值；保留正文、工具数据和 JSON Schema 中有意义的原值。 | JSON；热 |
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

图片生成统一由 `routing.routeProfiles.imageGenerations.enabled` 控制，入口位于 Workspace 的路由域；
媒体策略中保留生成参数，不再放置第二个启用 checkbox。旧 `media.generation.enabled` 在归一化时
与旧路由开关按 AND 合并，任意一方为 `false` 都保留关闭状态。

### 媒体处理

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `media.inputCompression.enabled` | `false` | 启用所选内联图片处理模式；`preserve` 始终保留原图。 | Workspace；热 |
| `media.inputCompression.progressive` | `false` | JPEG 输出使用 progressive 编码；仅在压缩启用且输出为 JPEG 时有效。 | Workspace；热 |
| `media.inputCompression.useMozJpeg` | `true` | JPEG 输出优先使用 mozjpeg 编码参数。 | Workspace；热 |
| `media.remoteImages.allow` | `false` | 允许向上游透传远程图片 URL，并检查 `allowedHosts`；代理不下载图片，也不验证远端文件的 MIME、大小或像素。 | Workspace；热 |
| `media.http.enabled` | `false` | 启用独立音频、图片 multipart 编辑、MAI Speech 原生入口及显式绑定的 Responses Speech 适配器；不改变既有图片生成开关。 | Workspace；热 |
| `media.realtime.enabled` | `false` | 启用 Realtime WebSocket 对话、转写和翻译。 | Workspace；热，仅新连接 |
| `media.webrtc.enabled` | `false` | 启用 WebRTC 建连及所有权校验后的 sideband/hangup；媒体和 data channel 直连 provider。 | Workspace；热，仅新请求 |
| `media.webrtc.allowClientSecrets` | `false` | 允许导出上游短期凭证；还需开启 WebRTC，管理页开启时要求确认。 | Workspace；热 |

文本协议的图片策略只检查正式图片内容块，覆盖 Chat、Responses、Messages 及支持的工具结果图片，不递归处理同名业务字段。关闭压缩仍执行远程 URL 策略和内联字节限制；字节上限按解码后大小计算，在分配图片 Buffer 前校验。`legacy` 模式下合法 Messages 图片仍保留原字节和 MIME；只有显式启用 `adaptive` 才会尝试优化 Messages 的 JPEG。

#### 音频与实时连接限额

以下参数均可在 Workspace 媒体策略中配置，时间单位为毫秒，大小单位为字节。计数和限额按进程生效，不是跨实例配额。默认值分别由 [HTTP 媒体](../../src/proxy/media-body.js)、[WebSocket](../../src/proxy/realtime-policy.js) 和 [WebRTC](../../src/proxy/realtime-calls.js) 定义。

| 配置前缀 | 参数与默认值 | 行为 |
| --- | --- | --- |
| `media.http` | `maxUploadBytes=26214400`、`maxFiles=10`、`maxFields=64`、`maxFieldBytes=65536` | multipart 总上传（含边界及头部，chunked 同样受限）、文件数量、普通字段数量及单字段限额。总字节超限立即返回 413，不等待当前 part 或上传结束。模型字段必须唯一。 |
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
| `observability.logs.includeAuthRejected` | `false` | 记录在认证阶段被拒绝的请求，包括缺失或无效的 API Key、管理端 Basic Auth 失败，以及管理端 IP 白名单拒绝。关闭时只累加计数（运维页显示），不写内存、控制台或 Log Analytics；开启后写为 `http.auth_rejected` 事件。此开关只影响新增日志，不清除历史记录；日志页的“隐藏认证拒绝”筛选始终可用，记录状态提示以实际运行配置为准，不随未保存的编辑变化。CSRF 拒绝和其他 4xx 不受影响。 | Workspace；热 |
| `observability.logAnalytics.enabled` | `false` | 启用 Azure Log Analytics 上传 sink；还需要完整 DCE/DCR 配置。 | Workspace；热 |
| `observability.runtimeStore.enabled` | `true` | 启用 PostgreSQL runtime event/rollup store；仅当活动持久化模式使用数据库时有效。 | JSON；热 |

统计 GET 使用独立的只读 `REPEATABLE READ` 事务和最多两个读取连接，不强制排空事件，
不修改真实 Key 的恢复状态。单条统计 SQL 最多执行 5 秒；请求准入仍使用严格的预算恢复
和队列一致性边界。响应包含快照时间、待写入数量以及不完整/内存回退状态；“立即同步”
显式请求写入。内存回退仅代表当前进程累计值，不冒充持久化历史或筛选结果；尚未恢复的
预算显示“尚未加载”，不显示零费用。模型重置会使本实例在途旧快照失效。

spool 使用追加写入和带摘要的 `.offset` 检查点；旧格式、损坏或越界检查点从头幂等重放。
损坏行写入 `.corrupt` 隔离文件并增加 `corruptedEvents`，合法相邻事件继续恢复；损坏行的
用量仍是未知，不能声称已对账恢复。每个实例独占 spool 及其检查点。Runtime Store 激活后，
有效 `observability.runtimeStore.localBufferPath`（含默认路径或环境覆盖）不能热切换，
save/reload 返回 `409 RUNTIME_STORE_RESTART_REQUIRED`。应先排空，或停服迁移积压文件后
修改配置并重启；文件身份改变可能使旧检查点失效并触发安全重放。不要在运行时手工修改 spool。

管理端运行日志默认按内部请求实例汇总为请求列表，并显示客户端 Request ID；复用客户端 Request ID 不会合并不同请求，展开后可查看对应事件时间线。请求、系统与计费事件、HTTP 访问与认证三个视图共用同一套单行紧凑列表：时间显示为 `MM-DD HH:mm:ss.mmm`（完整时间在悬停提示中），“摘要”列显示来源、错误码与消息，点击行末箭头展开详情（请求视图为事件时间线，其余视图为 JSON 载荷），图标按钮可复制摘要，点击 Request ID 可按该请求筛选；各视图仅按内容调整可见列。重试过程中的错误不决定最终结果；重试成功仍显示成功，HTTP 200 中的流式失败仍显示失败。缺少完成或失败证据时显示“未完成 / 未知”，不推断成功或仍在运行。用量与费用取自实际记录，保留明确的零值，缺失值显示为未知。系统与计费事件、HTTP 访问与认证记录分别保留在独立视图；重复的计价不完整告警按模型和原因汇总，同时保留单次事件明细。该页面读取应用内存日志，不包含 Caddy 的独立标准输出访问日志。列表仅覆盖当前进程仍保留的事件，不等于跨重启历史记录；事件被缓冲区淘汰后，请求详情可能不完整。

日志页可通过 `/admin/logs?key=team-a` 深链筛选 Key；其只读 API 参数为
`/admin/api/logs?view=requests&keyId=team-a`。匹配精确且区分大小写，先筛选再限制结果数量，
请求视图保留匹配请求的整个已保留时间线。只使用日志中已记录且未脱敏的身份，
不会绕过 `redactApiKeyInfo`、恢复历史脱敏身份或构造隐藏索引。
运维事件视图 `view=operations` 不支持此筛选，带 `keyId` 时返回 400。
新列表在记录超过 100 条时虚拟化，详情改为抽屉，支持 `j` / `k` 上下条导航；
正文缺失和保留窗口限制不变。

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

缓存写入与缓存读取分别展示。管理端只显示输入总量（含缓存）、缓存读取、缓存写入、
输出四种 token 和参考费用，不再单列总 token 或缓存写入费用。
PostgreSQL event/rollup 仍保留写入 token 和独立费用字段用于内部计费和审计。
显式 `0` 与上游未报告不同；缺失计数保留未知用量，不视为零。
管理端金额只显示已计算的参考小计，不再拼接「未知费用」；无可计算金额时显示 `—`，
确认零费用时仍显示 `0.0000 USD`。模型统计标题下统一注明
「计费估算可能不完整，仅供参考，最终费用以 Azure 后台账单为准」。
参考费用卡片下只显示「费用估算可能不完整」。
后端的 `unknown/partial` 状态、原因、审计事件与预算治理不因展示调整而改变。
Chat/Responses 的普通输入量为输入总量减去缓存读取及写入，写入按独立费率收费，
不得再次加入总 token 或重复收取普通输入费用。相关费率可在定价 JSON 中使用
`cacheWritePer1mTokens`、`cacheWrite5mPer1mTokens`、`cacheWrite1hPer1mTokens`，
分档时需在每档独立声明。数据库通过兼容性迁移添加字段；已有历史缺失值不会编造成零。

缓存命中率在展示时用「缓存读取 token / 输入总量」计算，不存入数据库，
也不平均各请求的百分比。输入为零、字段缺失或读取量大于输入量时显示 `—`。
该比例基于已记录的 token；历史上已经归零的未上报计数无法在读取时还原。

模型展开后按「实际模型 + 请求快照中的 tiers.id」逐行汇总，并直接显示该 ID；
档位计数为已结算请求数，与上层包含失败请求的请求数不同。
GPT 模型卡使用 `short <=272K / long >272K`（272K = 272,000），
Grok 4.3/4.6 使用 `short <200K / long >=200K`。数值区间负责选档，不解析 ID 文本计费。
同一个实际模型的相同 ID 即使历史费率或阈值不同也合并，费用仍累加各请求原有费用；
不同 ID 即使区间相同也分行，不根据当前卡重命名历史记录。
旧汇总若只记录区间、没有 ID，仍按原区间显示；完全缺失档位证据则显示未分类。
不分档价格显示为单独一档；若当前模型卡有分档，原有不分档记录标注为「历史不分档」，
不按当前模型卡或汇总输入量回填短/长档。无法确认的历史结算请求数不伪造成零。

模型名称下对有可执行分档规则的模型卡仅显示「分档计费」，展开后显示已记录的档位统计，
不在主表重复阈值细节。管理端检查所有已配置、可执行分档模型的价格区间，
不限于 GPT 型号。优先级仍为模型级 `models[].pricing`、配置目录 `access.pricingCatalog`、
模型卡价格。导入到配置中的旧价格不会因模型库同步自动更新。
发现配置区间与模型卡不同后，可通过「检查分档价格」预览来源、区间和完整费率，
经确认将列出模型的模型级价格更新到当前卡的完整快照。共享目录、路由和其他模型不变，
不会自动替换自定义价格；须经原有配置检查/保存流程后对新请求生效，历史不重算。

运行总览分为范围指标、周期表和系统状态。周期表显示最后一个有记录的自然小时/日/周桶
及其起始时间，不冒充滚动最近一小时/24 小时/7 天；无周期数据时显示 `—`。
未启用统计数据库时明确显示累计快照，不宣称已按 Key/时间过滤。
系统状态是实例级数据，恢复/同步详情默认折叠；标题和更新时间独立于下方对齐的
Key/时间筛选与同步按钮。「Log Analytics 上传」只表示 Azure 日志上传，不是日志文件导出；
未启用时只显示「未启用」，隐藏上传队列、丢弃、失败计数。后端历史计数和诊断详情保留，
管理台内存日志、控制台日志不受该展示控制；独立的统计数据库「事件队列」仍显示。
输入/输出在概览、周期表、趋势和模型/Key/档位表中统一以 K
显示，`1 K = 1,000 Token`，最多三位小数保留单 Token 精度，悬停可查看原始计数；
缓存读取/写入仍使用原始 Token 单位。表格数字使用千位分隔和右对齐，后端原始统计不变。

模型统计区的「清空模型统计」按钮经确认后重置所有模型及其实际模型/计费档位统计，
不受当前 Key 或时间筛选限制；不清除日志、原始事件、全局/Key/趋势统计或配额。
管理 API 为 `POST {admin.basePath}/api/stats/models/reset`，使用已有管理认证和
`x-aoai-admin-csrf` 保护。数据库模式在现有 runtime meta/rollup 中持久化重置边界，
刷新、重启和待处理旧事件重放都不会恢复边界之前的模型统计；持久化失败则返回错误，
不会报告清空成功。未启用 runtime 数据库时仅清空进程内模型统计，进程重启原本也不保留这些计数。
重置不取消进行中的请求；重置后结算的用量计入新统计，因此可能暂时出现上层请求数为零、
但分档已有结算请求和 token 的情况。清空与分档汇总复用现有表结构，不新增命中率或分档专用列。

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `persistence.compatibilityExport.enabled` | `true` | 保存变更时允许把规范配置额外写到兼容路径；不关闭主配置存储。 | Workspace；保存时生效 |
| `access.defaults.requireApiKey` | `true` | 要求公共代理请求通过已配置的客户端 API Key。 | Workspace；热 |
| `access.budgets.enabled` | `false` | 启用全局预算治理。具有正数独立额度的 Key 仍可进入 Key 级预算逻辑。 | Workspace；热 |

### Runtime 账务恢复与准入

启用 Runtime 数据库时，新事件使用独立 UUID 去重；本地旧缓冲记录在重放前补写稳定 UUID。
汇总累加与事件检查点在同一 PostgreSQL 事务内提交，失败重试不重复计费。
升级自动为事件表增加可空 `event_uid` 列和唯一索引；既有历史记录不重新计价，也不自动修正旧版已产生的重复统计。

首次恢复 Key 历史用量失败不会被当作零余额或恢复成功。后续访问间隔至少 1 秒重试；
恢复期间带 RPM、TPM 或正数硬预算的 Key 返回 `503 / KEY_GOVERNANCE_UNAVAILABLE`，不访问上游。
没有这些历史额度约束的 Key 仍可按本地并发限制运行，事件继续使用原有缓冲机制。
恢复时先持久化待写事件，并保留读取期间新结算的用量；文件模式和 minimum 的内存治理不依赖数据库。
这不新增预算预留，也不承诺跨进程共享配额。

### 客户端兼容与协议 Shim

| 配置项 | 默认值 | 功能 | 入口与生效方式 |
| --- | --- | --- | --- |
| `compatibility.claudeCode.enabled` | `true` | 发布 Claude Code 专用模型目录；不会关闭基础 Messages 路由，也不控制 Anthropic header/beta 策略。 | Harness；热 |
| `compatibility.codex.enabled` | `true` | 发布 Codex 专用模型目录；不会关闭基础 Responses 路由，也不改变 Responses 终态校验。 | Harness；热 |
| `compatibility.protocolShim.rejectLossyRequests` | `false` | 默认尽力转换并记录 warning；开启后，跨协议请求无法无损表示时返回 400。 | Workspace；热 |
| `compatibility.protocolShim.rejectLossyResponses` | `false` | 默认尽力转换并记录 warning；开启后，JSON 或 SSE 响应无法无损表示时拒绝/终止转换。 | Workspace；热 |
| `compatibility.anthropic.forwardSdkMetadataHeaders` | `true` | 在 Messages 路径转发安全的 `anthropic-*`、`x-anthropic-*`、`x-claude-*`、`x-stainless-*` 元数据；凭据类 header 始终阻断。 | Workspace；热 |
| `compatibility.anthropic.unknownBetaPolicy` | `allow-direct-anthropic` | `passthrough` 透传全部 beta 值；`allow-direct-anthropic` 仅对直连 Anthropic 上游保留未知 beta；`allowlist` 对所有上游执行白名单。凭据和 hop-by-hop header 的硬过滤不受影响。 | Workspace；热 |
| `compatibility.anthropic.normalizeManualThinkingToolChoice` | `true` | 修正 manual thinking 与强制工具选择的不兼容组合。 | Workspace；热 |
| `compatibility.anthropic.sanitizeCacheControl` | `true` | 清理目标 Messages 实现不支持的 `cache_control` 位置或属性。 | Workspace；热 |
| `compatibility.anthropic.validateThinkingByModel` | `true` | 按模型元数据校验 Claude thinking type 与 effort。 | Workspace；热 |
| `models[*].clientCompatibility.claudeCode` | `false` | 将模型纳入 Claude Code 专用目录；模型必须启用、上游可用、公共 Messages 开启，且最终路由为原生 Messages（推荐）或已选择协议转换，并且是文本生成模型（图片、语音、转写、Realtime 等模型不可选择）。不是访问控制。 | Harness；热 |
| `models[*].clientCompatibility.codex` | `false` | 将模型纳入 Codex 专用目录；模型必须启用、上游可用、公共 Responses 开启，最终路由为原生 Responses（推荐）或已选择协议转换，且是文本生成模型（文生图/文生视频、TTS、ASR/转写、Realtime、Embedding 等一律不可选择，覆盖原生路由与协议转换）。不是访问控制。 | Harness；热 |
| `models[*].clientNativeRoute.claudeCode` | 未设置 | Harness 原生路由覆盖：仅当模型同时是 Claude Code 成员时，`messages` 请求强制使用原生 Messages 路由，优先于 `models[].routes`，并跳过 Catalog 对该路由的接口检查；上游仍需配置 `messages` 路由。移出 Harness 后失效。 | Harness；热 |
| `models[*].clientNativeRoute.codex` | 未设置 | 同上，作用于 Codex 与 `responses`（含 `responses/compact`）；上游仍需配置 `responses` 路由。 | Harness；热 |
| `models[*].clientConversion.claudeCode` | 未设置 | Harness 协议转换确认：仅当模型同时是 Claude Code 成员、且最终路由为其他文本协议（如 Chat）时，允许该模型通过资格检查；不改变路由解析，被 `clientNativeRoute.claudeCode` 压过；`compatibility.protocolShim.rejectLossyRequests` 开启时不可用。移出 Harness 后失效。 | Harness；热 |
| `models[*].clientConversion.codex` | 未设置 | 同上，作用于 Codex；转换成员的 Codex 目录条目不声明 freeform `apply_patch` 与托管搜索。 | Harness；热 |

Harness 会分别展示草稿成员、已保存成员和运行时生效目录；资格只代表静态配置符合原生路由要求，不代表已验证上游、CLI 或工具调用。资格刷新失败、加载中或结果过期时不能选择模型；仍可移除具有唯一 ID 的成员。“选择模型”窗口为多选：已是成员的模型直接显示为勾选，状态筛选为“全部模型 / 可选择 - 原生协议 / 可选择 - 需转换 / 不可选择”（默认“可选择 - 原生协议”），并支持搜索、完整阻断原因及配置跳转；确认后一次性应用新增与移除，修改仍需统一审阅保存。

Model Catalog 未声明原生 `messages` / `responses` 的模型（例如 DeepSeek V4.1 Flash 接入 Codex）如果只因“最终上游路由使用了其他协议”或“无法解析原生路由”被阻断，且上游已配置对应的原生路由，则同样属于“可选择”：勾选并确认后自动写入 `clientNativeRoute.<client>=true`，取消勾选或移除时自动删除，之后恢复 `models[].routes` 与 Catalog 的规则。该覆盖对模型的该公共路由整体生效，不修改 `models[].routes`、`upstreams[].routes` 或 Model Catalog。

上游没有对应原生端点（例如 DeepSeek 没有 `/responses`）时，模型归入“可选择 - 需转换”：勾选并确认后写入 `clientConversion.<client>=true`，`responses` / `messages` 请求由 shim 转换为最终路由的协议（如 Chat）。转换沿用 shim 的既有边界：Codex 不转发 `prompt_cache_key`、`include`、`reasoning.summary`、`previous_response_id` 和 `custom` / `web_search` 工具，Claude Code 不转发 `thinking`、`metadata`、`cache_control`，`responses/compact` 与 `messages/count_tokens` 不可用，丢失字段记录 `proxy.protocol_shim_lossy_conversion` 警告。`compatibility.protocolShim.rejectLossyRequests` 开启时这类请求会被拒绝，因此该分类不可选（原因 `CONVERSION_BLOCKED_BY_POLICY`）。分类依据配置证据：“原生协议”表示已配置的路由本身解析为客户端协议（Catalog 接口或已启用的覆盖）；Catalog 未声明但可转换的模型归入“需转换”，即使上游已声明原生路由（上游声明路由不等于服务商支持该模型），此时可在成员卡片上一键切换为原生路由覆盖。仅当转换不可用（如严格模式）而覆盖可用时，才把覆盖归入“原生协议”。

上游路由（`upstreams[].routes`）目前不在结构化表单中编辑：如需原生端点，进入“JSON 编排”为该上游添加 `responses` / `messages` 路由（例如 `"responses": "/openai/v1/responses"`）后再选择模型。

客户端接入向导需要显式填写公共代理地址，只生成带凭据占位符的 Bash/Zsh 或 Codex TOML，不读取密钥、不发起真实请求。Codex 高级区编辑已有 `models[].codex` 元数据覆盖；留空恢复继承，清除按钮仅移除界面列出的字段。推理档位列表在离开输入框时应用。预览与公开目录共用后端解析器，标记配置、Catalog 与既有回退来源；默认优先级随消费者权限过滤后的顺序变化。以上不新增 Feature Flag，也不改变既有配置校验和请求策略。

### 能力元数据不是功能开关

上游/模型页面展示后端 Catalog 计算的有效能力、来源及上游并集，并区分当前生效配置与未保存草稿。模型卡提供的能力只读；不同的已存储模型标签保留但不覆盖 Catalog，旧配置回退值仍可编辑。预览信息不写入配置，旧 `upstreams[].capabilities` 仍只是派生兼容字段。

模型卡的 `protocolProfiles["chat/completions"].request.outputTokenParameter` 是有证据的协议参数规则，不是新增配置开关或 schema 升级；未迁移卡保留旧兼容路径。模型卡文件编辑需要显式重载，远程同步在原子激活 Catalog 后生效；旧运行时应先升级再接收新字段。详见[模型卡能力与参数说明](../../pricing/README.md#runtime-consumers-and-omitted-capabilities)。

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
| `persistence.configStore.database.enabled` | 仅在原始配置缺少或为空的 `persistence.configStore.mode` 时迁移为 `database` / `file`；显式 mode 优先。UI 只保留模式选择，保存后移除旧字段。 |
| `media.generation.enabled` | 与原路由开关按 AND 迁移到 `routing.routeProfiles.imageGenerations.enabled`，随后移除旧字段。 |
| `persistence.compatibilityExport.exportLegacyConfigOnChange` | 与原 `enabled` 按 AND 迁移到 `persistence.compatibilityExport.enabled`；原来关闭的额外导出不会被开启。 |
| `compatibility.anthropic.betaAllowlistEnabled` | 原值 `false` 迁移为 `unknownBetaPolicy: "passthrough"`；`true` 保留原来的策略。旧布尔值随后移除，新编辑不再被旧字段覆盖。 |

## 弃用与未实现字段

以下字段不再进入新默认配置。读取旧字段会在运行状态的
`configuration.deprecatedFlags` 中报告路径、是否迁移及替代字段，并记录
`config.deprecated_flags` warning；管理页 Workspace 显示相同提示，不记录旧字段值。
归一化后可编辑配置不含这些字段，但不会仅因普通 v3 重载而改写原文件；
检查并保存后才持久化清理。v2 和已有的必要结构修复仍遵循原来的升级写入流程。
`configuration.cleanupRequired` 标记旧 v3 文件是否仍待规范化；即使没有普通编辑差异，
管理页也提供「配置规范化待保存」的检查/保存入口，弹窗列出弃用路径与替代字段。
已在保存或升级中写入规范配置时不再提示待保存，但保留本次迁移说明直到重载。
失败的保存/重载不替换旧配置、旧 Catalog 或原弃用提示。

### 启用即被拒绝

- `routing.fallbacks.enabled`
- `routing.cooldowns.enabled`
- `routing.healthChecks.enabled`

这三项不再生成默认块。旧配置设置为 `true` 仍被明确拒绝；
关闭或未启用的旧块会带提示移除，不会补做 fallback、cooldown 或健康检查。

### 保留行为、移除无效开关

| 字段 | 当前状态 |
| --- | --- |
| `admin.auth.allowBasicAuth`、`admin.auth.allowOidc` | Basic Auth 仍由 `admin.auth.enabled` 控制；当前没有 OIDC 实现。 |
| `admin.security.auditAllWrites`、`admin.security.maskSecretsInUi` | 管理写日志和 UI secret 脱敏当前为强制行为。 |
| `admin.features.enableConfigImportExport`、`admin.features.enableDangerousActions` | 当前不控制导入导出、restart API 或对应按钮。 |
| `routing.healthChecks`、`routing.preCallChecks` | 健康检查和 pre-call check 调度器没有实现；不能据此宣称会校验模型能力、上下文或图片。 |
| `media.inlineImages.redactInLogs` | 内联二进制日志清洗始终强制执行；UI 改为不可关闭的说明。 |
| `observability.logs.redactSecrets` | secret 清洗始终强制执行；管理页将其显示为不可关闭。 |
| `observability.metrics` | 当前没有 metrics collector 或 Prometheus 路由，移除整个预留块。 |
| `observability.audit.enabled`、`observability.audit.recordReadActions`、`observability.audit.recordWriteActions` | 当前没有由这些布尔值控制的审计模块；同组 `retentionDays` 仍保留给原有 runtime store 兼容路径。 |
| `access.defaults.enforceUserField`、`access.defaults.rejectClientSideMetadataTags` | 当前没有治理消费路径。 |
| `compatibility.enableLegacyConfigRead`、`compatibility.enableLegacyConfigWrite`、`compatibility.mapServerAdminPathToAdminBasePath`、`compatibility.mapImageCompressionToMediaInputCompression`、`compatibility.mapServerUpstreamToProxyDefaults`、`compatibility.warnOnDeprecatedFields`、`compatibility.failOnDeprecatedFieldsAfterVersion` | 旧配置兼容归一化继续执行，不再生成不生效的控制字段。 |
| `upstreams[*].healthCheck` | 上游健康检查调度器尚未实现，移除预留块并提示路径。 |

`minimum/nextgen` 仍是同一代码基线的运行 Profile。minimum 禁用的 Log Analytics、
Runtime Store 和预算只作用于运行时克隆，保存时仍保留对应持久化配置。
环境管理的值和 secret 也不会因规范化或 UI 保存而回写；新媒体入口与凭据导出仍默认关闭。

部署时先升级支持这些迁移的 runtime 和管理端，再检查/保存规范配置。
`unknownBetaPolicy: "passthrough"` 是新增取值，旧 runtime 不接受；
若需回滚到旧版本，应同时恢复升级前的配置备份，不能只回滚容器镜像。

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
