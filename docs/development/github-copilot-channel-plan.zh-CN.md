# 渠道模型映射、模型暴露与 GitHub Copilot 接入计划

> 修订：2026-11-27。工作区已包含普通渠道映射与可信发现、固定绑定、批量暴露、Key 权限、两种 Copilot 凭据流程、发现与批准、运维记录和渠道历史统计。实施及部署边界见[配置指南](../configuration/feature-flags.zh-CN.md#aoai-proxy-启用-copilot-渠道的部署前提)。
> 加密设计变更：所有者要求移除 Copilot 单点加密及专用密钥配置，新凭据过渡为受限权限的明文存储。旧密文明确报错并保留，通过同一身份重新授权和配置发布替换，不自动解密/删除。下文原有“加密凭据/主密钥”内容是历史方案，已被此移除决定取代；[全局加密设计](encryption-design.zh-CN.md)已暂停实施，版本/CAS、lease、隔离与发布边界不变。
> 真实授权、供应商验收和灰度未执行，也未读取本机登录态或迁移线上配置。双 profile 用固定版本参考项目核对流程，以离线替身验证；按所有者决定，选择身份即带出参考项目的公开应用 ID 与客户端标头（可用环境变量覆盖），不宣称这些应用或私有上游接口对本部署已获批准。下列矩阵是上线门槛，不是实网测试报告。

## 1. 目标、已确认需求与边界

管理员依次回答四个不同的问题：**这个渠道能提供什么型号？要暴露哪些模型？这个 Key 可以用其中哪些？一次调用实际上由哪个渠道承接？** 前三项通过现有配置审阅/保存/应用；最后一项由请求事件记录，不根据当前配置反推。

### 1.1 已确认需求

1. 在现有上游管理中创建 Copilot 渠道，不要求手工填写 token 或常规 API 地址。
2. 登录时可选择 **GitHub Copilot** 或 **OpenCode** 客户端身份；首版包含两种身份，不把其中一种留到后续阶段。
3. 授权后自动发现该连接的模型，管理员勾选并保存可用型号；初始全部未勾选。
4. **只有该连接已勾选的型号，才可以在新建/修改公开模型时绑定或切换到该 Copilot 渠道。** 后端也必须校验，不能仅靠 UI 隐藏。
5. 同一个公开模型保留各渠道自己的目标型号、路由和相关配置。管理员切换渠道后，客户端无需修改公开模型 ID。
6. 渠道创建后，由后台检查 token、提前刷新和管理缓存；不依赖管理页面保持打开。
7. 登录、授权失效、刷新、模型清单变化、渠道切换和请求执行均有可关联记录，但不记录凭据。
8. 所有操作进入现有运维体系，不增加独立 Copilot 服务、管理控制台、日志系统、账号池或保存流程。
9. 所有渠道均从上游页维护「原始型号 → 统一目标型号」；表格与 JSON 编辑同一份数据。普通渠道支持手动维护，有可信发现接口时可获取；Copilot 保留登录发现与逐项勾选门槛。
10. 模型页改为「暴露的模型」，从各渠道已启用映射的并集中批量选子集。**Key 的模型权限只在「Key 管理 → 添加 Key / 修改 Key」表单配置**，从已暴露的公开模型中选择。上游页、模型页均不提供 Key 授权控件。统计首页按统一目标型号聚合，展开看渠道消耗。

### 1.2 首版范围

- GitHub 设备码授权、两种客户端身份、连接级凭据与模型清单。
- 已有或经正常流程补齐 Catalog 定义的文本模型；JSON 和 SSE 均需验收。
- 一个连接对应一个 GitHub 授权主体和一种客户端身份；可手工创建多个连接，逐条显式选择。
- 手动绑定和切换，不做账号轮询、自动换身份、故障跨渠道转移或规避配额。
- 保留现有消费者 API Key、模型访问权限、限流、预算和 Harness 规则。
- 不扩展音频、图片生成、Realtime/WebRTC，不搭建 Copilot 订阅账单系统。
- 真实调用仍须符合所选 OAuth 应用、账号/组织授权和服务条款；不能把一个个人订阅自动解释为面向所有消费者的服务资格。

**“Claude 5.5”必须落实到准确型号。** Opus 5.5 与 Sonnet 5.5 不能互相替代；示例公开 ID 为 `claude-opus-5-5`，Copilot 目标 ID 必须取自实际发现结果，不从显示名称推导。

## 2. 当前实现与融合位置

| 现有能力 | 代码依据 | 本功能如何接入 |
| --- | --- | --- |
| 上游/模型编辑、统一草稿与审阅保存 | [RoutingTab](../../admin-ui/src/components/RoutingTab.jsx)、[App](../../admin-ui/src/App.jsx)、[Harness 多选](../../admin-ui/src/components/HarnessTab.jsx) | 上游编辑清单和映射，模型页批量勾选公开条目，不新增独立保存按钮 |
| 每 Key 发现过滤与请求准入 | [治理](../../src/governance.js)、[KeysTab](../../admin-ui/src/components/KeysTab.jsx)、[公开目录](../../src/server.js) | 复用 `apiKeys[].allowedModels`，把自由文本改为从公开 ID 多选；发现和实际请求共用权限判定 |
| 管理认证、CSRF、自定义管理路径 | [server](../../src/server.js)、[api](../../admin-ui/src/api.js) | 新接口沿用相同保护和 URL 构造，不另开管理端口 |
| 配置默认值与校验 | [config](../../src/config.js) | 增加渠道和绑定字段校验，保留 v3 配置及旧模型形态的兼容入口 |
| 修订冲突、离线待同步、配置恢复 | [persistence](../../src/persistence.js)、[config-history](../../src/config-history.js) | 渠道勾选和切换继续走现有 CAS、历史与回滚 |
| 配置应用阶段 | [config-application](../../src/config-application.js)、[server](../../src/server.js) | 渠道运行时挂入 `apply.proxy`，不新增平行的 `apply.copilot` |
| 上游认证与 HTTP 调度 | [auth](../../src/auth.js)、[http](../../src/http.js)、[proxy](../../src/proxy.js) | 补充明确的 Copilot 认证分支和 provider 边界，不误用 AAD 或静态 API Key |
| 路由、协议及流式处理 | [routing](../../src/proxy/routing.js)、[upstream-headers](../../src/proxy/upstream-headers.js)、[shim](../../src/proxy/shim.js)、[stream](../../src/proxy/stream.js)、[reliability](../../src/proxy/reliability.js) | 解析有效渠道后复用原链路，保留原生透传及错误/终止语义 |
| Catalog、模型验证和 Harness | [model-catalog](../../src/model-catalog.js)、[model-validation](../../src/model-validation.js)、[codex-models](../../src/codex-models.js) | 统一消费有效渠道描述符，不能只改请求转发而留下错误的发现/验证元数据 |
| 运维诊断、日志与代理测试 | [OpsTab](../../admin-ui/src/components/OpsTab.jsx)、[LogTable](../../admin-ui/src/components/LogTable.jsx) | 加入渠道状态、筛选及修复入口，复用已有模型验证和请求测试 |
| 运行状态、统计及治理 | [RuntimeTab](../../admin-ui/src/components/RuntimeTab.jsx)、[stats](../../src/stats.js)、[runtime-store](../../src/runtime-store.js)、[governance](../../src/governance.js) | 增加渠道维度，继续使用同一套请求/用量结算和只读快照 |
| 结构化日志与 Log Analytics | [logs](../../src/logs.js)、[Log Analytics 指南](../observability/log-analytics-dce.zh-CN.md) | 复用 memory/console/Log Analytics sinks、脱敏、队列和保留策略 |

当前上游认证不是通用 OAuth 凭据服务；配置历史也不是凭据库。本功能仍需增加加密凭据、版本隔离及刷新协调能力，但它们是现有后端和持久化设施的扩展，不是第二套产品或运维系统。

## 3. 对象和状态：避免一个“已连接”掩盖所有问题

| 对象 | 含义 | 不能与什么混为一谈 |
| --- | --- | --- |
| Copilot 连接/渠道 | 现有 `upstreams[]` 中的一项，关联客户端身份与凭据引用 | 不是公开模型，也不是消费者账号 |
| 登录身份 `authProfile` | `vscode` 对应 UI 的 GitHub Copilot；`opencode` 对应 OpenCode | 与下游客户端是 Claude Code/Codex 无关 |
| 已发现模型 | 该授权主体、身份和端点在某个时间点返回的清单 | 不代表管理员启用、协议支持已验证或已发布 |
| 渠道原始型号 `sourceModelId` | Azure deployment name、Copilot 返回的准确 ID 等；发往该渠道的值 | 不是外部授权标识；不能拿部署名访问未暴露型号 |
| 统一目标型号 `canonicalModelId` | 映射后的 target model name，使用有证据的 Catalog 型号 ID；跨渠道归并与统计主键 | **不是**旧 `models[].targetModel`（旧字段是发给上游的值），也不是价格或返回的 actual model |
| 暴露模型 `models[].id` | 客户端唯一可用的公开 ID，默认等于统一目标型号，可保留已有公开别名 | Key 授权只认公开 ID；相同 Catalog 型号不授予另一个公开别名 |
| 已启用渠道映射 | 一个渠道的原始型号映射到一个统一型号，且经管理员勾选 | 不自动暴露、授予 Key、加入 Harness 或承诺原生协议支持 |
| 渠道当前运行状态 | token、发现缓存、存储及最近错误 | 不替代配置保存/应用状态 |

UI 分开显示以下维度：

- **配置**：草稿、已保存、当前实例已应用、待数据库同步、应用失败。
- **授权**：未登录、等待授权、有效、刷新中、暂时异常、需要重新授权、已断开。
- **发现**：未加载、加载中、有效、过期、失败；另显示上次成功时间、发现数和勾选数。
- **可选择资格**：允许绑定或明确原因码；“未知/过期”不能显示为允许。
- **连通性**：未测试、测试通过/失败及时间；与静态资格分别显示。

`ready` 不能仅由“有 token”得出；同时展示持久化与缓存新鲜度等子状态。模型清单暂时过期不等于既有请求必须停止。

## 4. 管理员完整使用流程

```text
上游页：普通渠道手动维护或获取型号；Copilot 选择身份、设备授权、自动发现
  -> 确认「渠道原始型号 → 统一目标型号」并勾选可用条目
  -> 暴露的模型：从跨渠道并集多选，存在多个候选时指定承接条目
  -> 如需配置权限，另到「Key 管理 → 添加 Key / 修改 Key」选择可访问的公开模型
  -> 统一审阅差异、保存、apply.proxy 应用；也可分次提交
  -> 现有运维验证和测试请求
  -> 现有运行统计、日志与配置历史追踪
```

### 4.1 创建、授权和启用型号

1. 在上游列表选择 GitHub Copilot 类型，填写唯一渠道名称，选择客户端身份。
2. 点击登录；页面展示 GitHub 验证 URL、一次性用户码和超时倒计时。密码仅输入 GitHub 页面，代理不收集 GitHub 密码。
3. 后端按设备流要求轮询，包括 `authorization_pending`、`slow_down`、拒绝、取消、过期等状态；页面查询状态不直接触发对 GitHub 的轮询。
4. 授权成功只得到待发布连接，不立即改变当前配置或流量。后端准备可持久化的加密凭据引用，并立即发现模型。
5. 基础 URL 和协议路径由 provider 配置规则生成并在 UI 显示。参考默认主机为 `https://api.githubcopilot.com`；如实际授权提供受支持的端点信息，先验证再采用，不能任意跟随 URL 或重定向。
6. 模型选择器展示准确 ID、名称、来源/厂商、可解释的协议元数据、发现时间及 Catalog 匹配情况；支持搜索、多选和已勾选筛选。
7. 初始及新发现型号均不勾选。明确不可选择的上游条目不可勾选；Catalog 尚未匹配的条目可展示但不能批准绑定，提供补齐 Catalog 的指引。
8. 勾选结果只修改现有 App 草稿，通过全局审阅保存。保存前明确提示：启用渠道型号不会创建公开模型或加入 Harness。
9. 放弃草稿或授权过期时清理临时授权会话；尚未发布的凭据按受控生命周期回收，不留下可供任意模型使用的孤立凭据。

### 4.2 上游配置与批量暴露

1. **上游页维护供给。** 普通渠道可手填/批量粘贴准确型号，或点击「从上游获取」。获取动作由后端使用渠道凭据和受信任端点执行；显示来源、时间和差异，只将管理员选中的条目带回草稿。Azure 的模型目录不等于账号部署列表：无相应部署查询权限或无法可靠枚举时，明确提示手填 deployment name；不拿基础模型名冒充部署名。Copilot 不开放手填绕过发现。
2. **映射编辑。** 借鉴 New API 的[渠道配置](https://github.com/QuantumNous/new-api/blob/81c1fd20efade39a5d5692c8018dfef4cfb30e1d/web/src/features/channels/components/drawers/sections/channel-models-section.tsx)和[可视化/JSON 编辑器](https://github.com/QuantumNous/new-api/blob/81c1fd20efade39a5d5692c8018dfef4cfb30e1d/web/src/features/channels/components/model-mapping-editor.tsx)的交互，不照搬其配置语义。表格列固定为「上游实际发送值 → 统一目标型号、启用、来源/差异」；JSON 使用第 5 节同一数组。支持批量勾选、JSON 回填、逐行错误、应用前预览。无效 JSON 保留编辑文本并阻止提交，不清空原映射。禁止映射链、通配符、重复来源和按相似名自动合并型号。
3. **模型页只管理暴露。** 像 Harness 选择器一样按统一型号去重展示所有渠道候选，支持搜索、已选/未选/不可选筛选、批量选入/移除。每行可展开查看渠道、原始型号、协议和不可选原因。只选一个候选时可预填；多个可用候选且无既有绑定时必须明确选一项，不取数组首项。保留现有公开 ID、顺序、策略和 Harness 设置，不逐个重建模型。高级别名仍需唯一、显式公开。
4. **编辑入口分开，保存流程共用。** 配置上游、发布模型或切换渠道不需要编辑 Key，也不改写任何 Key 的权限配置。若管理员还要调整授权，切到添加/修改 Key 表单即可继续编辑同一草稿，再统一审阅保存。后端验证完整候选配置；导入、API 和回滚遵守同样规则。
5. **移除前只读提示影响。** 若待取消暴露的公开 ID 仍被某个 Key 的指定名单引用，提示受影响的 Key 并提供前往对应 Key 编辑表单的导航；不得在模型页直接撤权或自动清理名单。返回时保留草稿，引用未解决则拒绝保存。Key 表单须允许移除待取消暴露的旧授权，不能因该型号已不在候选列表而隐藏它。默认模型及 Harness 引用也需处理。取消暴露不删除上游清单；过期的 Copilot 发现不可批准新增或切入，但可切出。

### 4.3 同一公开模型切换渠道

以 `claude-opus-5-5` 为例：

| 时间 | 公开 ID | 当前渠道 | 实际发送的目标 |
| --- | --- | --- | --- |
| 切换前 | `claude-opus-5-5` | Azure | 该绑定保存的 Azure 部署名 |
| 编辑时 | 不变 | 仍为 Azure，Copilot 是草稿 | 流量不变 |
| 保存且当前实例应用后 | 不变 | 指定 Copilot 连接 | 该连接已发现、已勾选并绑定的目标 ID |
| 切回并应用后 | 不变 | Azure | 恢复原 Azure 绑定，不要求重新输入部署名 |

- 审阅界面列出渠道、目标、最终协议、计价来源、Harness 资格及已知兼容性变化。
- 每个请求固定自己的配置修订、绑定和 Catalog/计价快照；保存期间已开始的请求不会被中途换路由。
- 新请求采用应用后的绑定；客户端成功响应仍恢复公开模型 ID。
- 不承诺跨渠道迁移服务端会话、`previous_response_id`、缓存或签名 thinking。携带这些状态时继续执行已有协议不变量；需要新会话时在切换预览中提示。
- 流式已经输出后禁止刷新并重放请求，也不允许失败时自动改投 Azure。

### 4.4 刷新模型清单和取消勾选

- 手动/定时刷新仅更新发现缓存，不改管理员勾选，不写配置历史。
- 成功刷新保留仍存在的选择；新增型号默认不勾选。已下架但曾勾选的条目保留并标记“上游清单已缺失”，禁止新增或切入，不静默删除既有配置。
- 刷新失败保留上一成功清单及选项，标记过期和错误；不能显示成“成功发现 0 个模型”。
- 取消勾选时检查**提交后的候选配置**。仍有公开模型以该连接/型号作为当前绑定时拒绝，返回受影响模型；允许在同一保存中先切出/移除绑定再取消勾选。
- 渠道映射可保留为未启用，便于对照和重新启用；它不是备用路由，重新勾选并验证后才可选。
- 列表变化本身不构成任意能力字段的运行时拒绝规则。已运行请求由实际上游结果决定，禁止根据清单缺失自动切模型。

### 4.5 重登、换身份、断开和删除

- 相同账号、相同身份的重登准备新凭据代次，成功后原子替换；旧任务不得覆盖新代次。
- 账号或客户端身份变化视为新的授权边界：推荐新建连接，再发现、勾选和迁移绑定。不允许仅改 `authProfile` 标签复用旧 token/勾选证据。
- 重登流程失败不覆盖仍有效的原凭据；确认原授权撤销则立即标记需要重登，不能继续使用该凭据。
- 普通断开/删除先检查引用，提示切出或解绑；显式断开后的新请求不能读取旧缓存。远端撤销不是可阻止事件，应即时进入失效状态。
- 删除引用和删除加密凭据分开处理，避免配置保存失败却先销毁凭据。凭据清理不能破坏其他实例仍使用的配置或在途请求所需状态。
- 本地断开不等于 GitHub 端撤销应用授权；UI 说明两者差别及远端撤销入口。

## 5. 配置与有效绑定设计

以下为建议字段契约，实施前在 P0 冻结；**不是当前运行时已支持的配置示例**。

### 5.1 连接配置

在现有 `upstreams[]` 上扩展。渠道 ID 和清单对所有 provider 通用；只有授权属性是 Copilot 专属：

| 字段 | 规划用途 |
| --- | --- |
| `name`、`provider`、`status` | 沿用现有上游身份、类型及启停；建议 provider 值为 `github-copilot` |
| `auth.mode` | 增加明确的 `githubCopilot` 模式，不能回落到 AAD |
| `auth.credentialRef` | 服务端生成的不可猜测引用；引用不是凭据，单凭该值不能授权 |
| `channelId` | 稳定的内部渠道 ID，显示名可改，ID 不复用。对 Copilot 也是运维日志里的 `connectionId`，不再存第二份 ID |
| `copilot.authProfile` | `vscode` / `opencode`，UI 使用友好标签 |
| `modelMappings[]` | 每行保存 `sourceModelId`、`canonicalModelId`、`enabled`；渠道级已启用清单直接从这些行派生，不再保存一份 Copilot 专属勾选数组 |
| `baseUrl`、`routes` | 自动生成可审阅的端点配置；常规 UI 不要求手填，不能覆盖已有管理员路由而不提示 |

凭据引用必须绑定连接不可变内部 ID、授权主体和 profile；不能用数组位置或可改名的显示名称恢复凭据。名称变更更新模型引用，但不改变授权主体。

### 5.2 一份渠道清单、一份发布选择

以下是**拟议配置的相关字段摘录**，不含凭据或路由，不可直接部署。`copilot-id-from-discovery` 只是示例，实际值必须来自该连接并经管理员确认。每个渠道对象中的 `modelMappings` 数组也就是该渠道 JSON 编辑器的内容。

```json
{
  "upstreams": [
    {"channelId": "az-eu", "name": "Azure Europe", "modelMappings": [
      {"sourceModelId": "team-opus-prod", "canonicalModelId": "claude-opus-5-5", "enabled": true}
    ]},
    {"channelId": "gh-work", "name": "Work Copilot", "modelMappings": [
      {"sourceModelId": "copilot-id-from-discovery", "canonicalModelId": "claude-opus-5-5", "enabled": true}
    ]}
  ],
  "models": [
    {"id": "team-claude", "canonicalModelId": "claude-opus-5-5",
     "selectedBinding": {"channelId": "az-eu", "sourceModelId": "team-opus-prod"}}
  ],
  "apiKeys": [
    {"id": "team-a", "modelAccessMode": "selected", "allowedModels": ["team-claude"]}
  ]
}
```

配置映射方向是 `team-opus-prod → claude-opus-5-5`。推理方向则是 `team-claude → 授权 → 选定 az-eu 的映射行 → 实际发送 team-opus-prod`。切换只改 `selectedBinding` 引用；切回时原部署仍在上游清单。授权对象始终是 `team-claude`；统计主行始终是 `claude-opus-5-5`。

- 映射行的唯一键为 `(channelId, sourceModelId)`，原始 ID 在本渠道内精确匹配。同渠道两个不同部署可以映射到同一统一型号，因此只选渠道名有时不够，必须明确选择部署行。其他渠道出现同一原始 ID 不冲突。服务器从选定行验证其 `canonicalModelId` 与发布项一致；不尝试靠倒转字典猜部署。
- 渠道内的部署路由、hosting 和计价差异随映射行保存；具体 URL 路径仍属 `upstreams[].routes`。公开项持有公开 ID、展示/顺序、模型级策略、默认值和 Harness 成员。既有每公开模型显式覆盖继续只对原发布项有效，不把某别名的策略、价格或 Harness 路由确认传播给所有共享部署的别名。切换时重新校验，不跨渠道继承旧价格或原生协议确认。
- 编译候选配置时生成两个只读索引：`统一型号 → 候选映射行` 供选择；`公开 ID → 当前有效绑定` 供推理、目录、Harness、验证和计价。两者不额外持久化；发布项不再复制一张 `channelBindings` 映射表。
- **兼容迁移**：旧 `models[].targetModel`（缺省时旧公开 ID）是原始部署名；统一型号取现有已解析 Catalog 定义，不依据部署名称猜测。旧 `id`、顺序及默认选择、消费者权限不变。首次显式迁移时预览生成的渠道行和发布引用；已有多条公开别名可引用同一行。若同渠道同原始 ID 有相互矛盾的型号、路由或价格，不做 last-write-wins：保留可表示的发布项覆盖，否则阻止迁移并逐项列出差异。旧/新形态不可相互覆盖；老配置读入不写盘。
- 同一公开 ID 在使用中不得静默改指不同统一型号。确需更换时以新公开 ID 发布并重新审阅 Key/Harness 权限；仅换同型号的渠道不改变 Key 授权。先升级 runtime/admin 再写新配置。降级必须先在新版本把配置转换回可等价表示的旧形态，不能让旧版忽略绑定或空授权语义。

**渠道策略建议：首版固定绑定，不做优先级负载均衡。** 优先级是主备选择，不等于流量均摊。Azure/Copilot 的协议、上下文状态、数据驻留、成本和配额不一定等价。单一显式绑定便于预判行为、验证 Harness 和核算成本；不可用时展示原因，管理员可手动切换。暂不设计权重或自动跨账号重试。

若以后确有可用性需求，再独立评审**每个公开模型显式 opt-in 的有序主备**：只在发送前从已批准且满足协议、地域、计价等策略的候选中选择；有服务端会话/签名状态时固定原绑定；授权失败、限流、请求可能已被处理或下游已有输出时均不跨渠道重放。日志要能解释选路，不能把故障转移当作同一请求多次计费。此项不在首版验收范围。

### 5.3 选择许可的统一规则

新增/切入 Copilot 的判定可表达为：

```text
allowed =
  candidate connection is enabled
  AND credential subject/profile matches that connection
  AND selected (channelId, sourceModelId) mapping exists and is enabled
  AND mapping.canonicalModelId matches the published model's canonicalModelId
  AND discovery evidence is fresh and matches connection/profile/endpoint
  AND sourceModelId is present and selectable in that evidence
  AND exact Catalog binding and final route are valid
  AND existing explicit policies/Harness requirements are satisfied
```

这是管理端绑定许可，不是对所有实时请求重新探测上游的公式。持久化的勾选许可和静态路由约束用于请求准入；发现缓存暂时过期不自动撤销已保存许可。

选择预览携带连接身份、端点摘要、发现代次、Catalog 代次和草稿标识。提交时后端重验，旧成功响应晚到不能批准新配置；静态校验不持有配置写锁等待网络探测。

建议管理端原因码包括 `COPILOT_MODEL_NOT_ENABLED`、`COPILOT_DISCOVERY_STALE`、`COPILOT_CREDENTIAL_MISMATCH`、`COPILOT_AUTH_REQUIRED`、`COPILOT_MODEL_IN_USE` 和 `COPILOT_STATE_UNAVAILABLE`。返回关联连接/模型和修复入口，UI 不解析英文错误字符串推断资格。

### 5.4 Key → 公开模型列表：发现与执行必须一致

**现状**：[模型发现过滤和请求校验](../../src/governance.js)已按 `model.id` 匹配 `apiKeys[].allowedModels`；[文本代理](../../src/proxy.js)在选路前调用准入校验，[各格式目录](../../src/server.js)使用消费者过滤。[Key 页](../../admin-ui/src/components/KeysTab.jsx)目前是列表输入，且旧配置空数组/省略都表示不限制。不能只加下拉框，也不能直接反转空数组的含义。

| 配置状态（拟议） | 发现与调用的有效集合 |
| --- | --- |
| 旧配置无 `modelAccessMode` | 保留旧含义：非空列表按原公开 ID 限制；省略/空列表为全部已暴露且启用的模型。显式迁移前展示实际效果 |
| `modelAccessMode: "selected"` | `已暴露且启用的公开 ID ∩ allowedModels`；新 Key 默认此模式，`[]` 表示无权使用任何模型，不随新发布自动扩权 |
| `modelAccessMode: "all"` | 明确授权全部已暴露及未来新增的模型；仅限管理员主动选择并确认，与非空限制列表混用时拒绝保存 |

1. 在添加 Key 和修改 Key 表单中使用同一多选控件：添加时默认「指定模型」且不预选；修改时回显该 Key 的有效模式与原名单。实际保存的是公开 ID，统一型号和当前渠道仅供辨认。表单预览新增/撤销权限及未来模型的影响；删除最后一个指定项仍是 `selected: []`。上游映射表格和渠道 JSON 编辑器、暴露模型选择器都不编辑 `modelAccessMode` 或 `allowedModels`。
2. 认证成功后，目录返回 `该 Key 的有效集合 ∩ 当前目录的协议/Harness 资格`。改变目录格式不会放宽 Key。请求从该协议规定的输入位置（或既有默认模型）得到公开 ID，精确查找发布项，走同一 Key 判定，**通过后才解析渠道映射、获取上游凭据和发起请求**。不把原始 ID、Catalog 别名、大小写近似、客户端供应的渠道名当备选查找路径。默认值也必须通过授权。
3. 保留现有语义：无效/停用 Key 为 401；已发布但 Key 无权用为 403 `MODEL_ACCESS_DENIED`；未暴露、停用或未知 ID 为 404 `MODEL_NOT_FOUND`；缺少必填模型按协议报错。日志依既有脱敏策略关联 requestId 和安全原因，不记 Key 值；拒绝时无上游流量。授权名单不是模型目录的 UI 筛选器。
4. 所有接受模型的入口都执行同一规则，包括 JSON/SSE 三种文本协议、原生辅助端点、已开启的媒体、Realtime 的主/次模型与会话更新，以及 WebRTC 控制。不同位置给出冲突模型时按路由契约拒绝歧义。无法在直连媒体/导出凭据后强制策略的路径，对任何 `selected` Key 拒绝（含空列表），不能仅检查 `.allowedModels.length`。不为此开启新协议。
5. 已启用 Key 隔离的部署必须要求 Key；若保留 `requireApiKey=false` 的匿名入口，移除 Key 会改变身份。保留旧部署的匿名语义并明确警告；实施强隔离须先关闭匿名或显式限制匿名可见集合，不能将“匿名全开放”宣称为强隔离。权限随配置在本实例应用生效；不承诺追溯撤回已返回内容或已完成请求。

## 6. 持久化、版本与现有配置应用

### 6.1 三类数据分开，但沿用一套基础设施

| 数据 | 存储方式 | 版本/恢复 |
| --- | --- | --- |
| 连接配置、勾选清单、模型绑定 | 现有 file/database 配置存储 | 现有 ETag、CAS、待同步记录及最近 12 份脱敏历史 |
| OAuth 凭据与短期 token | 同一部署的受控加密持久化扩展；数据库复用现有 PostgreSQL 连接设施，文件模式使用受限权限的加密 sidecar | 独立凭据版本及连接生命周期版本，不因续期改变配置修订 |
| 非敏感运行状态、发现缓存、操作/请求记录 | 运行态缓存及现有 runtime-store/log sinks；必要的连接元数据进入同一持久化扩展 | 状态标记时间、来源、实例和代次；事件使用现有稳定 UID/重放去重机制 |

不引入 Redis、独立任务服务或另一套数据库配置。凭据不得进入 runtime-event spool、普通日志、配置历史、配置导出或浏览器存储。

加密主密钥从部署环境/受保护挂载注入，带 key version，不存进同一配置或备份明文。缺失/错误密钥明确使 Copilot 凭据不可用，不生成临时密钥伪装可持久化；其他既有上游保持可运行。密钥位置、加密存储位置和跨实例协调设置属于启动期配置。

### 6.2 授权准备与配置发布

1. 登录成功先持久化加密的“待引用”凭据，成功后才向 UI 返回引用。
2. 全局保存校验引用归属、凭据状态、勾选许可和发现证据，然后执行原有配置 CAS。
3. 引用随配置提交后，`apply.proxy` 安装经过验证的渠道快照和后台调度；不能在凭据尚未可靠落盘时返回完整连接成功。
4. 配置保存失败时不激活该绑定；临时凭据可供该操作重试，不能成为任意其他连接可领取的凭据。
5. 回收只针对确认未被已保存/活动/待同步配置及进行中发布操作引用的对象。跨文件/存储无法做原子事务时，以“先准备、再引用、最后安全回收”恢复，不宣称跨存储原子提交。

### 6.3 保存、应用、重载与回滚

- 继续使用现有 `If-Match` 冲突语义：缺少必要修订为 `428 CONFIG_REVISION_REQUIRED`，陈旧提交为 `409 CONFIG_REVISION_CONFLICT`。
- 渠道调度器接入 `apply.proxy`，保证重复应用幂等；不能每次保存再启动一组定时器。
- `ok` 仍只表示保存/加载层面的成功；UI 分别展示 `apply.proxy`、`apply.caddy`、`apply.persistence`。连接授权健康另列，不能把网络探测成功作为配置保存成功的替代。
- 安装新快照失败时保留前一可用渠道快照，显示已保存与已应用修订差异；不能出现一半绑定已切换、一半元数据仍旧的状态。
- 外部上游暂时不可达不必令整个 proxy 应用失败：本地配置可安装，渠道健康显示 degraded，并按实际错误处理请求。
- 继续沿用现有 Caddy 阶段；内部 Copilot 端点无需新公开路由或专用 Caddy 配置。
- 阶段重试只重跑指定阶段，不重做登录，不自动提交/覆盖 UI 草稿。
- 回滚恢复勾选和绑定配置，保留当前凭据，重新执行许可与路由校验。引用已删除或授权主体不匹配时明确拒绝/要求重新配置，绝不从历史复活旧 token。
- 凭据正常续期不是配置变更，不占用 12 份历史，不触发 Caddy reload。

### 6.4 数据库离线与多实例

- 配置离线保存继续沿用现有 authoritative pending record、原数据库修订和人工冲突处理，不以登录/刷新结果推进配置 CAS 基线。
- 数据库不可用时，不批准需要新持久化凭据的连接发布或授权轮换。单实例在能够确认连接未被撤销时，可在安全期限内使用已有内存凭据；多实例另受下述共享状态检查约束。不可把没保存成功的新凭据报告为刷新完成。
- 恢复数据库后先读当前凭据代次再 CAS 更新，禁止旧实例的延迟刷新覆盖新登录或远端断开。
- 多实例共享数据库时，用连接级 lease/CAS 协调刷新；租约带 fencing token，超时旧持有者不能写回。
- 多实例在请求准入时读取共享的凭据代次/撤销状态，不能只依赖当前实例的 token 缓存。共享状态不可读时停止新的该渠道请求并显示状态存储异常，不以“token 尚未到期”绕过撤销检查；已开始的请求遵守既定在途规则。后续若改为有界状态 lease，必须另行声明/验证撤销窗口，不能引入无界本地缓存。
- 文件/Azure Files 模式仅支持单写实例；共享文件挂载不构成分布式锁。数据库模式的每实例配置缓存、pending marker、spool/checkpoint 仍保持私有。
- 配置应用仍是每实例状态，不宣称一次保存已自动推广到整个集群；运维按现有逐实例重载/发布方式收敛。

## 7. 两种客户端身份的授权与 token 管理

### 7.1 Profile 差异

| UI 身份 | 内部值 | 参考仓库行为 | 实施要求 |
| --- | --- | --- | --- |
| GitHub Copilot | `vscode` | GitHub OAuth token 换短期 Copilot token | 分别管理长期授权和短期 token；根据真实交换结果刷新 |
| OpenCode | `opencode` | 直接使用 OAuth token | 依据实际 OAuth 有效期/刷新能力处理，不能套用 Copilot token exchange |

两种 profile 的 OAuth 应用、scope、身份 headers、token 模式均由服务端决定，下游客户端不能覆盖。不能只改 User-Agent 就宣称完成身份切换。所有者已决定完全参考固定版本参考项目：`vscode` 默认使用 `Iv1.b507a08c87ecfe98` 及 VS Code Copilot Chat 标头，`opencode` 默认使用 `Ov23li8tweQw6odWQebz` 及 OpenCode 标头；`COPILOT_VSCODE_CLIENT_ID`、`COPILOT_OPENCODE_CLIENT_ID` 只作覆盖。这些应用属于 GitHub 与 OpenCode，条款与账号风险由部署方确认，离线测试不能证明其可用于本部署。

有效 `expires_at` / `expires_in` / `refresh_in` 需要按对应接口解释并检查单位。短期 Copilot token 若缺失必要有效期证据，报告异常，不照搬参考代码的固定 25 分钟兜底。

OpenCode 的 OAuth 缺少有效期时标记“有效期未知”，缺少可用续期机制时另标记“无自动续期能力”，两者分别判断。定期验证及处理上游失效，不能伪造到期时间或承诺永久自动续期。没有续期能力且 token 失效时必须重新授权。

### 7.2 后台检查与请求兜底

下列时间为首版建议内部默认值，P0 验证接口约束后冻结；不是上游 SLA，也不需要全部做成 UI 开关。

| 项目 | 建议规则 |
| --- | --- |
| 后台有效期巡检 | 最长每 30 秒一次，无页面访问也运行 |
| 提前刷新 | 安全提前量取 `min(120 秒, 已知 token 生命周期的 20%)`；有合法 `refresh_in` 时取更早的计划时间 |
| 分散调度 | 刷新时点增加有界、只提前的抖动，不能延后到安全截止时间之后 |
| 请求可用性 | 已知到期 token 至少保留 5 秒安全余量；不足时等待一次受超时约束的合并刷新或明确失败 |
| 并发控制 | 同一连接/凭据代次最多一个刷新；请求和定时任务复用同一 in-flight promise，多实例再受 lease 保护 |
| 网络超时与重试 | 使用现有 HTTP/取消机制；临时故障采用有上限的指数退避和抖动，尊重 `Retry-After` |
| 重试结束 | 持久失败转 degraded/re-auth-required，显示下次允许重试时间，不无限循环 |

- 刷新成功顺序：验证响应及有效期 -> 加密存储 CAS 成功 -> 原子替换运行缓存 -> 发布状态/事件。
- 若实际 OAuth 使用一次性轮换的 refresh token，远端轮换成功但本地保存失败时不能假定旧 refresh token 仍可用；保留受保护的恢复状态并明确告警，无法安全恢复则要求重登。
- 新 token 生命周期过短或元数据非法时停止密集调度并报告具体错误，避免 0 延迟自旋。
- 刷新中的旧 token 若仍满足安全期限可继续服务；已被确认撤销的旧 token 不能再使用。
- 上游明确 401 时失效对应缓存；仅当存在真实续期路径、尚无下游可见输出且符合既有重试政策时，最多额外鉴权重试一次，并计入同一总尝试预算。
- 403 不自动等同 token 过期：区分权限、组织策略、型号资格；429 不触发换账号/身份，沿用限流退避。
- 已经输出的 SSE 失败走原客户端协议的错误帧，不重放、不制造成功终止。

### 7.3 三种缓存互不混用

| 缓存/状态 | Key 与寿命 | 失效/失败行为 |
| --- | --- | --- |
| Token 缓存 | 连接内部 ID + profile + 凭据代次 + 端点代次；已知有效期限制 | 重登、断开、删除、确认 401、端点/身份变化时失效；不落普通缓存明文 |
| 模型发现缓存 | 连接 + 授权主体/profile + 端点 + 授权代次；建议 15 分钟新鲜期，刷新合并 | 登录后、周期和手动刷新；失败保留上次成功结果但不可批准新绑定 |
| 管理员勾选 | 持久配置，不是缓存 | 仅通过明确的配置保存/回滚变更；刷新永不自动新增勾选 |

同一授权主体下仅短期 token 轮换不清空已发现模型；授权主体/profile/端点改变必须换发现代次。缓存数量、响应体大小和清单条数有界；格式错误或超限显式报错，不能截断后冒充完整清单。

## 8. 启动、重载与关闭

1. 启动时先加载配置、解密可用凭据、恢复非敏感状态，再为启用的连接建立调度器。
2. 后台任务并发和超时有界；Copilot 上游不可达不能阻止其他渠道启动。健康检查 `/healthz` 保持进程存活语义，具体渠道失败放入受保护 runtime 状态。
3. 重载后按稳定连接身份增删调度器；没有变化的连接不重复登录、不创建重复 timer。
4. 停用连接时停止巡检和发现，新请求受现有上游状态检查约束；普通停用不等于销毁授权。
5. 优雅关闭时先停止新后台任务，取消 OAuth 轮询/发现/刷新，阻止迟到写回，再按现有顺序排空运行事件、刷新日志并关闭共享连接池。
6. 主密钥、存储路径或实例协调模式变化需要重启；连接状态、勾选和绑定按既有热应用流程处理。
7. `minimum` 与 `nextgen` 共用实现。`minimum` 不为此重新启用被 profile 禁用的 runtime-store/Log Analytics；相应运维记录显示为有限的当前进程日志，不伪装为持久历史。

## 9. 路由、Catalog、协议与计价

### 9.1 渠道事实与模型事实分层

- 账号模型发现不替代现有 Model Catalog，也不是“从 GitHub 同步 pricing cards”。
- 每个公开模型仍必须命中 Catalog；没有定义的型号显示为待映射/补齐，不通过猜测厂商、limits、价格或能力偷偷创建完整卡片。
- 同一 Claude 模型经 Copilot 承接时，不能继续把 Azure/Anthropic hosting、原生接口或价格直接当作该渠道事实。
- 在现有 Catalog 编译路径中加入有来源和代次的渠道部署描述符，统一供路由、发现、验证、UI 和计价使用。提供商证据、账号发现与管理员覆盖分别标注，不改写通用模型卡来迎合单个账号。
- `GET /models` 的可见性不是每个型号支持 Messages/Responses、工具、流式和特定参数的证明；未知保持未知。
- 不因缺少某个能力标签就增加通用请求字段拒绝；显式管理员许可、路由不变量和实际上游拒绝仍是边界。

### 9.2 路由和协议要求

- 最终 URL 决定后端协议；参考仓库使用的 `/chat/completions`、`/v1/responses`、`/v1/messages` 仅是待验证路径，不默认对每个型号全部启用。
- 同协议走现有原生透传，不经 Chat 中间表示；跨协议继续走已有方向性 shim 和 strict/loss 策略。
- 受信任的 provider headers 由后端组装，客户端不能覆盖认证和客户端身份。继续阻断 credential-like/hop-by-hop headers，沿用允许的协议 metadata。
- 端点与重定向遵守现有凭据防泄露边界，不把授权发送到任意 URL。自动发现地址也必须经过同样校验。
- `messages/count_tokens`、`responses/compact` 仍只走各自已验证的原生端点；没有证据不从普通请求模拟。
- Harness 始终从当前有效绑定计算资格；切换导致既有成员不合格时，要求管理员在同一草稿中修正/移除或采用现有显式确认机制，不静默取消成员。
- 缺失终止事件、空流、早 EOF、断连与各协议错误帧继续执行现有可靠性规则。

### 9.3 统计与成本

- 沿用同一请求计数、实际模型、usage、错误、限流和预算结算，不建立独立 Copilot 用量账本。
- **主行按 `canonicalModelId`（统一 target model name）聚合，点击展开按 `channelId` 看消耗**；详情保留公开 ID、原始部署名、上游实际返回型号、协议和现有计费分档。给定同一 Key、时间范围及统计重置边界，主行和子行均展示请求/错误、输入/输出/总 token、缓存读写、可估算成本及未知计价笔数。保留现有按公开模型的兼容数据，不把旧 API 的 modelId 偷换成统一型号。
- 请求选定绑定时冻结 `modelId`（公开 ID）、`canonicalModelId`、`channelId`、`sourceModelId`、协议和配置修订；`actualModelName` 用于记录实际上游结果，不代替逻辑分组。将相同的维度从请求传到 error/usage 事件、内存计数、spool 和数据库 rollup；读端增量提供 `统一型号 → 渠道` 细分。token 到期、展示名或短期凭据版本不参与分组。
- **读表示例**（示意，非实测）：Azure 的两个公开别名合计 12,000 输入 / 3,000 输出；Copilot 同型号有 8,000 / 2,000。`claude-opus-5-5` 主行应为 **20,000 / 5,000**；展开仅两条渠道行，分别为上述数字。别名与计费 tier 都是查看明细的维度，不与主行重复相加。相同输入口径下缓存读写是细分，不再加到输入总数；上游报告与估算使用现有标记。
- 既有稳定事件 UID 去重；一次请求计一次，attempt 不算多次用户请求。授权拒绝或选路前错误不虚构承接渠道。历史事件若无当时的统一型号或渠道证据，保留原统计，并单列未知维度；不可用当前映射回填。新配置改名、切换、重置以及库离线 fallback 后，均不得重复结算或将未知记成零。
- 登录、刷新和发现是控制操作，不计作模型请求、usage 或消费者预算，不增加匿名 key 的请求/错误行。
- Copilot 订阅/配额、premium multiplier、厂商 token 单价是不同计量，不互相换算。无可靠渠道计价时走现有 unknown/partial 成本语义，不显示免费，不套用 Azure 单价。
- 显式管理员价格覆盖仅作用于相应渠道并标明来源；渠道切换不重算旧历史，仍冻结每请求计价快照。
- 未知计价继续触发现有治理的 unmetered 提示/政策，不能因为 Copilot 是订阅渠道就绕过已有预算和访问规则。

## 10. 融入现有 UI 与管理 API

### 10.1 页面职责

| 现有页面 | 增量内容 | 仍由原流程负责 |
| --- | --- | --- |
| 上游页 | 手动/获取清单、映射表格和 JSON、逐行启用；Copilot 身份与发现状态 | 全局草稿、差异审阅和保存 |
| 暴露的模型页 | 统一型号并集的批量发布选择器、候选部署比较与固定渠道选择 | 已有公开模型策略、Harness、审阅与应用反馈 |
| Key 管理 → 添加 Key / 修改 Key | 唯一的 Key 模型授权表单：从已暴露模型中多选，明确“全部/指定/指定为空”，预览权限变化 | 原 Key 身份、限流、预算、脱敏及统一保存 |
| 运维页 | 渠道授权/发现摘要、最近失败、手动刷新、重新登录/配置跳转 | 已配置模型验证、代理测试、统一日志筛选 |
| 运行页 | 统一目标型号主行、展开渠道消耗；渠道运行摘要、token 到期/刷新时间、清单新鲜度 | 同一快照、key/time 过滤、未知状态及 Sync Now |
| 配置历史 | 渠道选择、勾选、绑定的前后差异和应用结果 | 最近 12 个脱敏版本、CAS 回滚；不是授权备份 |
| Workspace/部署配置 | 必要 provider 设置说明、密钥/存储是否就绪 | 既有环境覆盖、profile 限制和 restart-required 提示 |

所有新 UI 文案进入中英文 i18n。异步结果按请求序号和快照代次 fencing；跳转上游、模型、日志和历史不丢未保存草稿。

### 10.2 API 形态

以下为实施时拟增加的资源，均通过现有管理 base path 和 `api.js` 访问，不新增公开代理端点：

| 用途 | 建议资源/复用接口 | 性质 |
| --- | --- | --- |
| 开始设备授权 | `POST /api/upstreams/copilot/auth/start` | 返回受保护操作 ID、用户码和验证 URL；创建有时限的授权操作 |
| 查看/取消授权 | `GET /api/upstreams/copilot/auth/:operationId`；`POST .../:operationId/cancel` | GET 只读；取消使迟到授权结果失效 |
| 查看连接发现快照 | `GET /api/upstreams/copilot/:connectionId/models` | 返回缓存、来源、时间和代次，不隐式触发 GitHub 写/网络刷新 |
| 通用渠道型号获取 | 管理端按 `channelId` 触发发现的 POST，由对应 provider 执行；Copilot 复用同一份发现缓存和刷新操作 | 不支持枚举时明确返回“不支持”，可手填的渠道保留手填入口；不改公共 `/v1/models` |
| 手动刷新 token/模型 | `POST /api/upstreams/copilot/:connectionId/refresh`，明确 target | 单连接有界操作，复用后台 single-flight；不能替换全局保存 |
| 断开授权 | `POST /api/upstreams/copilot/:connectionId/disconnect` | 引用检查、明确确认和凭据版本条件；不静默改模型配置 |
| 保存渠道映射/发布/指定渠道/Key 许可 | 现有 `PUT /api/config` | 全局配置 CAS、历史、应用，不增加局部自动保存 |
| 运行状态 | 扩展现有 `GET /api/runtime` | 在原结果中增加脱敏连接状态，保持只读 |
| 资格/连通性验证 | 现有模型验证和 Harness 预览机制 | 静态预览不发真实推理；真实探测明确提示可能消耗额度 |
| 运维记录与统计 | 现有 `GET /api/logs`、`GET /api/stats` | 增量筛选/字段，保持旧调用兼容 |

- 敏感授权接口强制管理认证、CSRF、连接归属检查、无缓存响应及有界 body；URL/查询参数不携带 token 或 device code。
- 新建草稿的授权操作绑定服务端草稿身份；不能凭 `credentialRef` 给另一连接领取授权。
- 凭据操作使用独立 `expectedCredentialVersion` / 生命周期版本；不伪造全局配置 ETag。涉及配置引用的动作还需核对当前配置，防止检查后被并发绑定。
- 沿用管理端 `error/code` 和 HTTP 状态风格；运行时错误仍通过现有客户端协议分类，不把所有鉴权失败返回成功。
- `runtime/sync` 仍负责现有持久化/事件同步，不偷偷触发全部连接重登、token 刷新或付费模型探测。

## 11. 运维日志、操作记录与关联

### 11.1 同一记录链路，不把历史当审计

1. 所有结构化事件经现有 `appendStructuredLog` / Pino capture 进入同一 memory、console、Log Analytics 管道。
2. 渠道关键操作另以拟新增的 `operation` 事件类型进入现有 runtime-store 的事件/spool/保留流程；不把整个日志系统再复制进数据库。
3. `operation` 必须在聚合入口排除请求/错误/usage/预算汇总，避免凭据刷新污染统计。持久记录沿用 event UID 去重和重放。
4. 现有 `/logs` 的事件视图增加记录来源与连接/操作筛选；读取持久操作历史时使用同一管理入口及只读查询，显示来源、捕获时间与保留边界。若合并内存/数据库结果，按稳定 event UID 去重。
5. runtime-store 关闭时不创建另一套 JSON 审计文件；提供现有有限内存/console/可用 Log Analytics 记录，并明确“持久操作历史未启用”。
6. 配置历史仍只有 12 份恢复快照；日志和 runtime-store 也有淘汰/保留限制，都不宣称不可篡改、永久或零丢失审计。

关键操作记录包括登录终态、断开/撤销、刷新失败/恢复、发现型号变化、勾选差异、绑定切换及应用结果；逐次轮询和缓存命中不持久化为操作历史。

### 11.2 建议事件词汇

以下新增名称需同步日志标签和测试，沿用既有 `admin.*` / `proxy.*` 命名：

| 事件 | 常规级别 | 关键内容/归属 |
| --- | --- | --- |
| `admin.copilot_auth_started` | info | operationId、连接、profile；不含授权码 |
| `admin.copilot_auth_completed` | info | 授权代次、是否待发布、状态变化 |
| `admin.copilot_auth_failed` / `admin.copilot_auth_cancelled` | warn/info | 安全原因码、操作终态、可采取动作 |
| `proxy.copilot_token_refresh_succeeded` | info | 连接、有效期、耗时、凭据版本、触发来源 |
| `proxy.copilot_token_refresh_failed` | warn/error | 安全失败分类、下一重试时间、是否仍有可用 token |
| `proxy.copilot_auth_required` / `proxy.copilot_auth_recovered` | warn/info | 进入重登状态/恢复，仅在状态转换时记录 |
| `proxy.copilot_models_refreshed` | info | 发现代次、数量、新增/缺失数量；无变化时降低日志噪声 |
| `proxy.copilot_models_refresh_failed` | warn | 上次成功时间、是否 stale、安全错误 |
| `admin.channel_mappings_changed` / `admin.model_exposure_changed` | info | 渠道映射启停/更名及发布增删的有界差异、配置修订、historyId；不限定 provider |
| `admin.key_model_access_changed` | info | 模式与公开 ID 许可变化，遵守 Key 信息脱敏，不记密钥；实际拒绝走已有治理/代理拒绝事件 |
| `admin.model_channel_changed` | info | 公开模型、旧/新绑定、修订；区分 persisted 与 applied |
| `admin.copilot_disconnected` | info/warn | 主动断开/检测到撤销、操作者类型、受影响连接 |
| 既有 `admin.config_*`、`proxy.request_*`、`proxy.usage_recorded` 等 | 沿用 | 扩充渠道上下文，不生成第二份请求完成或用量事件 |

重复失败按连接、错误分类和时间窗口合并，保留首次/恢复及累计次数；不能每次轮询刷屏，也不能完全吞掉错误。

### 11.3 关联字段和脱敏

通用事件建议包含：

- `eventUid`、`ts`、`source`、`event`、`level`。
- `operationId`（后台控制操作）、`requestId`（实际 HTTP 请求）、`trigger`（manual/scheduled/request）。
- `upstream`、`connectionId`、`provider`、`authProfile`、安全的配置/凭据代次。
- `modelId`、`canonicalModelId`、`channelId`、`sourceModelId`、`actualModelName`、最终路由、`configRevision`、`historyId`（存在时）。
- `outcome`、`errorCode`、脱敏 `failureReason`、`latencyMs`、`nextRetryAt`、`stateBefore/stateAfter`。

后台任务不制造消费者 requestId 或会话 ID；请求触发刷新时可关联两者，但只能记录一次请求/usage。操作者沿用现有管理身份能力，并标注 `admin` 或 `system`；共享管理账号不能被包装成已识别的个人审计身份。

禁止记录 OAuth/Copilot token、refresh token、device code、user code、完整授权响应、凭据密文和授权头；不为 token 生成日志指纹。`credentialVersion` 只是安全版本号。

扩展现有敏感字段清洗以覆盖 provider 命名和嵌套错误；即使启用 Full 内容日志也不能绕过。设备码只在受保护的当前授权界面显示，不进入 localStorage、复制诊断摘要或通用响应日志。

现有 Log Analytics schema 已有 `FieldsJson` / `EntryJson`，首版把扩展关联字段放入该结构，不为 Copilot 新建表/DCR 或强制更换所有列契约。

示例运维查询（用于未来实现后的验证，不代表现在已有这些事件）：

```kusto
AOAIProxyLogs_CL
| where TimeGenerated > ago(24h)
| extend Fields = parse_json(FieldsJson)
| where tostring(Fields.connectionId) == "<connection-id>"
| project TimeGenerated, Level, Event, RequestId, ModelId, ErrorCode,
          OperationId=tostring(Fields.operationId),
          Profile=tostring(Fields.authProfile),
          State=tostring(Fields.stateAfter)
| order by TimeGenerated asc
```

按事件/连接定位后，可以跳转同一配置修订的历史差异和相同 requestId 的现有请求事件链，不需要在两个控制台之间手工拼接。

### 11.4 状态与告警

现有 runtime 摘要增加：授权状态、已知到期时间或未知标记、上次/下次刷新、连续失败次数、发现更新时间/stale、勾选数、依赖的公开模型数、持久化状态、当前实例及快照时间。

在现有日志/Log Analytics 告警方式下建议关注：进入需要重登、过期且无可用 token、持续刷新失败、发现长时间 stale、401/403/429、凭据持久化/CAS/lease 失败，以及现有 spool/log queue 丢弃告警。不能为该功能启动另一套通知守护进程。

### 11.5 一次切换的预期记录链

以下为验收场景，不是实际运行日志：

| 步骤 | 操作和当前状态 | 应能找到的记录 |
| --- | --- | --- |
| T0 | 公开 Opus 模型正在使用 Azure，配置修订 R10 | 原模型请求/用量记录显示 Azure 渠道 |
| T1 | 以 OpenCode 身份登录 Copilot，尚未保存 | 授权 operation O1 的 started/completed、发现代次 D1；配置仍为 R10 |
| T2 | 勾选 Opus 并统一保存，模型尚未切换 | 配置历史 R11、`admin.channel_mappings_changed`；Copilot 渠道可选但原模型流量仍为 Azure |
| T3 | 切换模型并保存 R12，但 proxy 阶段安装失败 | 历史 R12 与 `admin.config_apply_failed`；运行页明确仍使用旧绑定，不能显示已切换成功 |
| T4 | 仅重试 proxy 阶段并成功 | 同修订 R12 的应用结果更新，不生成另一次登录或重复保存；新请求可进入 Copilot |
| T5 | 发送一条请求 Q1 | 原有 Q1 请求/usage/终止事件带 Copilot、OpenCode、准确目标 ID 和 R12，统计只计一次 |
| T6 | 后台刷新失败，随后自动恢复 | 操作 O2 的失败/恢复、有效期及状态变化；配置保持 R12，没有新的配置历史 |

管理员从模型页跳到 Q1，从 Q1 定位连接及 O2，再从 R12 查看切换差异和应用结果；所有查看入口均属于现有管理页面。若事件已被保留策略淘汰，界面明确提示，不用当前状态伪造历史。

## 12. 故障处理手册

| 现象 | 在现有页面/记录检查 | 处置及不可做的事 |
| --- | --- | --- |
| GitHub 授权等待/超时 | 上游授权状态及 operationId | 超时后重新发起；不反复提交旧 device code |
| 登录成功但无法发现模型 | 发现错误、连接身份、端点、组织策略 | 重试发现/修正资格；不显示空清单成功，不套其他连接结果 |
| 模型页找不到 Copilot 选项 | 未勾选、Catalog 未映射、stale 或路由阻断原因 | 跳转对应上游修复并保存；不能用手填 ID 绕过 |
| Key 看不到或无法调用某型号 | 先查已暴露 ID，再查 Key 模式/许可、状态、目录资格和当前应用修订 | 修正相应交集；不改上游 deployment name 来“修复”权限，不把空名单改成全部 |
| 401 | token 有效期、刷新结果、授权代次 | 有续期能力则受控刷新；否则重登，不循环重试或换身份 |
| 403 | 实际错误分类、组织政策、目标型号 | 修正权限/许可；不把所有 403 当作 token 过期 |
| 429 | 既有请求日志、Retry-After 和渠道并发 | 等待/调整现有配额；不自动换账号 |
| 已保存但未切换 | `apply.proxy`、当前实例修订、pending sync | 重试失败阶段或按现有冲突流程处理；不重复保存覆盖草稿 |
| 数据库离线 | 运行页 persistence/runtime-store/凭据子状态 | 保留安全有效缓存；恢复后 CAS 对齐，禁止直接覆盖数据库 |
| 主密钥丢失/不匹配 | 凭据存储错误、key version | 从受保护备份恢复正确密钥，或重新授权；配置历史无法恢复密钥 |
| 清单删除了已选型号 | 发现变化事件及引用模型列表 | 选择替代渠道/明确停用；不静默改目标型号 |
| SSE 中途失败 | 同 requestId 的重试/错误/终止事件 | 保留客户端协议错误终止；不刷新后重放或伪造完成 |
| 操作历史/统计不完整 | 记录来源、profile、保留期、队列丢弃、fallback 状态 | 修复既有持久化/日志链路；未知不是零请求/零成本 |
| 多实例显示不一致 | 各实例配置修订、凭据代次、lease 和状态时间 | 按现有部署流程收敛配置；不共享本地 spool 或凭据明文缓存 |

## 13. 实施阶段、依赖与交付门槛

P0–P4 的通用渠道、连接、绑定门禁和可观测性实现纳入离线测试；P5 将本地 CLI + mock、临时 PostgreSQL/Caddy 与真实订阅验收分别记录。后者应由拥有获准应用和试点账号的部署方执行，不能用前者代替。

**本轮隔离验收（2026-11-27）**

| 门槛 | 结果与边界 |
| --- | --- |
| 全量单元与集成测试 | 临时 PostgreSQL 16 和 Caddy 开启，最终 `npm run test:unit` 为 **904 通过、0 失败、0 跳过**；同一测试集串行执行也通过。早先的并行轮次有临时代理启动失败，未放宽断言或关闭 gate。 |
| 协议和客户端 | **44/44** 路由契约通过。未改动的矩阵客户端连接临时代理：**36/36**（12 原生、24 转换），每格均以代理日志核对实际后端。普通 Chat、Responses、两类图片冒烟及 Claude Code 2.1.226、Codex 0.153.2 使用本地模拟上游通过。未访问真实推理服务。 |
| 管理与用量 | 发布用管理界面完成构建；Chromium 验证迁移真实形态的部署名、跨页保留草稿、全局保存和重载，原有 Key 配置与可见模型不变。双渠道历史用量合计输入 **20,000**、输出 **5,000**，不按当前绑定重算。 |
| 性能与静态检查 | 最终 `test:perf:offline` 达标：首 token P99 **132.50 ms**、事件循环 P99 **76.55 ms**、冷统计 P95 **107.24 ms**、spool 写放大 **1.00**。合成图片及 Chat/Responses 延迟检查完成。88 张活跃模型卡格式通过，元数据 0 错误、87 项既有待复核；依赖审计 0 项漏洞。 |

真实 Copilot 登录、账号/组织许可、线上模型协议和计费仍未经验证；未迁移生产配置或部署灰度。部署方须按第 15 节验收后才启用试点。

| 阶段 | 内容 | 依赖 | 完成门槛 |
| --- | --- | --- | --- |
| P0：契约和证据 | 冻结原始 ID、统一型号、公开 ID、映射/发布/Key 迁移与分组口径；分别核验两种 OAuth profile | 无 | 离线冻结旧目录顺序、权限和渠道选择；真实授权是 Copilot 上线门槛，不阻塞普通渠道设计 |
| P1：连接运行时 | 凭据加密、设备流、版本/CAS、刷新合并、lease、启动关闭和状态记录 | P0 | 无页面时续期；重启可恢复；失效/撤销/并发和故障注入通过 |
| P2：上游清单/映射 | 普通渠道手填、按能力发现、表格/JSON 同源；Copilot 连接发现与勾选门禁 | 通用部分仅需 P0；Copilot 接入需 P1 | 映射往返无损、重复/歧义不发布、跨连接不借用许可 |
| P3：暴露与授权 | 批量发布子集、固定绑定、所有发现与推理入口统一 Key 判定、旧配置迁移 | P2 通用契约；Copilot 切换验收需 P1/P2 | 同公开 ID 往返；未授权请求零上游调用；无意外授权扩张 |
| P4：现有管理/运维整合 | 统一审阅历史、日志/操作记录、按统一型号展开渠道的用量统计 | P1–P3 | 请求、错误、usage 及渠道维度可对账；无第二套控制台/保存流程 |
| P5：回归与灰度发布 | 协议矩阵、持久化/并发/回滚、真实账号和 CLI 验收、运行手册及部署说明 | P4 | 必测门槛全部通过并记录未测限制，再启用试点渠道 |

日志和错误契约从 P1 开始实现，P4 是统一展示/查询验收，不是前期无记录运行。各阶段的数据库/文件迁移必须可恢复且不会破坏原配置。

### 13.1 预计代码触点

- 后端：配置、认证、provider 生命周期、共享有效绑定、Catalog、现有协议链路、模型验证、持久化、脱敏、日志及统计。
- 新增 provider/credential 模块只承载不可复用的新逻辑；公共校验、HTTP、CAS、atomic-file 和日志设施继续复用。
- UI：[RoutingTab](../../admin-ui/src/components/RoutingTab.jsx)、[KeysTab](../../admin-ui/src/components/KeysTab.jsx)、[HarnessTab](../../admin-ui/src/components/HarnessTab.jsx)、[App](../../admin-ui/src/App.jsx)、[OpsTab](../../admin-ui/src/components/OpsTab.jsx)、[RuntimeTab](../../admin-ui/src/components/RuntimeTab.jsx)、[LogTable](../../admin-ui/src/components/LogTable.jsx)、[api](../../admin-ui/src/api.js)、[i18n](../../admin-ui/src/i18n.jsx)。
- 文档：实施时同步 [README](../../README.md)、[配置指南](../configuration/feature-flags.zh-CN.md)、[协议说明](../protocols/protocol-support.md)、[测试指南](../../test/README.md)、[Harness 要求](claude-code-codex-requirements.md)和相关部署/日志指南。
- 运行状态不手工写进本地生产配置、spool 或生成资产；本计划不修改这些文件。

## 14. 验收矩阵

| 编号 | 必测场景 | 可判定结果 |
| --- | --- | --- |
| A1 | 两种 profile 分别完成设备流 | 身份、OAuth/token 模式、headers 正确且互不串用；无密码/token 进入前端或日志 |
| A2 | pending、slow_down、拒绝、取消、过期及迟到成功 | 轮询遵循间隔；取消/过期后的结果不能发布 |
| A3 | 无页面访问，模拟时钟推进到预刷新时间 | 在计划窗口发起刷新，30 秒巡检上限可测，不靠请求触发才刷新 |
| A4 | 30 个并发请求与定时器同时发现需刷新 | 同连接只发生一次刷新；等待者共享结果且均有超时 |
| A5 | 两实例刷新、lease 过期和旧写回 | 只有当前 fencing/CAS 版本可提交；跨实例断开按声明的一致性规则生效 |
| A6 | token 刷新失败/过期/元数据非法 | 安全有效旧 token 可继续；过期或撤销不可使用；不伪造到期或无限自旋 |
| A7 | OpenCode 无 refresh 能力 | 到期/失效明确要求重登，不调用错误的 token exchange |
| M1 | 发现 Opus/Sonnet，仅勾选 Opus | Opus 可绑定；Sonnet 在 UI/API/高级 JSON 均不可绑定，拒绝时无推理上游请求 |
| M2 | 同账号不同 profile/连接 | 勾选、缓存、凭据完全隔离，不复用另一连接的资格 |
| M3 | 新增、缺失、失败、超限清单和旧响应晚到 | 新型号不自动勾选；失败非空成功；过期结果不能批准新绑定 |
| M4 | 同一次保存勾选并绑定/切出并取消勾选 | 基于候选配置正确通过；仍引用则拒绝并返回模型清单 |
| M5 | 手填 Azure 部署；同渠道两个部署、另一渠道一个型号均映射到同一统一型号 | 暴露选择器只列一个统一型号，展开列三条；必须选具体映射行，实际 URL/body 使用该行原始 ID |
| M6 | 表格 → JSON → 表格；输入坏 JSON、重复来源、失效行或删除依赖项 | 合法数据语义无损；失败定位到行且原草稿可恢复；拒绝未处理引用，不部分发布 |
| E1 | 跨渠道批量暴露 A/B 中仅 A，再刷新发现 C | 公开目录无 B/C；不自动授权、加入 Harness 或改变绑定；撤销 A 显示依赖并允许同批修复 |
| K1 | 两把 `selected` Key 分别允许 A/B，另有 `selected: []`、旧空列表与显式 `all` | 各种模型目录和直接推理一致；旧语义不变，新空列表拒绝全部。未授权已暴露 ID 返回 403，无上游调用 |
| K2 | 受限 Key 请求未授权公开别名（即使对应同一统一型号）、未暴露型号、部署名，以及未授权默认模型 | 不靠 UI 过滤；不经映射回退/放宽，无上游推理请求；同时验证允许的公开 ID 能正常执行 |
| K3 | 启用的媒体/Realtime/辅助端点、次级模型、会话更新和 WebRTC 直连；停用 Key 及匿名策略 | 同一准入/保持更严限制；受限 Key 无法通过直连使用其他模型。启用强隔离后不提供匿名旁路 |
| C1 | 原有单绑定配置及添加第二绑定 | 旧配置/隐藏设置/零值保持；迁移只在审阅后保存，不产生两份权威字段 |
| C2 | Azure -> Copilot -> Azure，包含保存期间的 SSE | 公开 ID 不变；三次 URL/body/headers 精确匹配；在途请求不换渠道；原绑定完整恢复 |
| C3 | 冲突保存、proxy/Caddy 失败和仅阶段重试 | 既有状态码、apply 子结果、草稿保护和历史行为保持 |
| C4 | 离线 pending、失败缓存写、重启和恢复冲突 | 不推进错误基线、不覆盖远端；未可靠保存凭据不报告发布/刷新完成 |
| C5 | 回滚到有/无可用凭据的版本 | 恢复配置而非旧 token；权限/路由非法或缺凭据明确处理，不能复活已撤销授权 |
| P1 | 每个支持的 source -> target，分别测 JSON/SSE | 原生对象/帧、模型映射、工具/usage/终止语义保持；共享改动扩展 3x3 矩阵 |
| P2 | 401、403、429、早 EOF、空流、取消及下游输出后失败 | 重试条件/上限正确，无跨渠道转移；各客户端错误帧符合现有协议 |
| P3 | count_tokens、compact、Harness 与受限 key 模型发现 | 只开放真实原生支持；成员与公开目录资格一致，消费者权限继续过滤 |
| O1 | 登录 -> 保存 -> 切换 -> 请求 -> 刷新失败 -> 重登 -> 恢复 | 一条连接链路可由 operationId/configRevision/requestId 联查，有前中后状态 |
| O2 | Full 日志、HTTP 错误、设备流响应及诊断复制 | 所有敏感字段/授权码均不泄露；既有请求分组不把后台操作当推理请求 |
| O3 | 同模型两渠道、unknown 成本、重复事件重放及统计重置 | 渠道维度可区分；不双计数、不按现价重写历史；未知费用不是免费 |
| O6 | 第 9.3 节双公开别名、双渠道固定用量，切换/改名，再按 Key 和时间查询 | 主行输入 20,000 / 输出 5,000，子行之和相同；数据库与内存同口径，未知旧记录不按当前配置追溯归属 |
| O4 | 操作事件/计数大量生成 | 不增加消费者请求、匿名 key 行或预算；队列有界并显式报告丢弃 |
| O5 | minimum/nextgen、file/database、只读统计/日志 GET | profile 限制不被绕过；读取不触发刷新/flush；持久化缺失明确可见 |
| U1 | 中英文、长名称、键盘操作、切页及旧异步结果 | 不丢草稿、不选错实体；只有最新匹配结果授权操作 |
| U2 | 添加 Key、修改已有 Key、切换模型渠道、取消暴露一个被指定名单引用的 ID | 添加/修改表单可配置权限；上游/模型页无授权控件且操作不改变 Key 配置。移除受阻时可跳到对应 Key 编辑表单解决引用，返回仍保留草稿 |

### 14.1 执行方式

- 使用 [现有测试指南](../../test/README.md) 的 Node runner、临时代理、mock 上游和 [管理表单 harness](../../test/lib/admin-workspace-form.js)，不新增测试框架。
- 新行为先补失败回归；认证/缓存用可控时钟和 mock 响应，避免为计时测试等待真实 token 过期。
- 共享认证/路由/错误/统计改动必须覆盖旧 Azure 等上游，不能只测试 Copilot happy path。
- 数据库 gate 仅在显式 disposable loopback PostgreSQL 上运行；严禁连接生产或修改运行服务状态。
- 实现时聚焦检查后按现有要求执行 `npm run test:unit` 和 `npm run test:routes`；共享运行时变更追加既有 offline performance gate。
- UI 编译先使用现有 Vite 临时 outDir 检查；仅在有意发布 admin 实现时更新受版本控制的构建资产。
- 卡片若需补齐，另执行 `cards:check`、`cards:validate` 及相关 Catalog/导入/同步测试，不能用账户发现替代证据。
- 真实授权、原生协议、CLI 及计费/部署验收单独记录；mocks 不证明真实账号资格、供应商价格或延迟。
- 渠道相关离线测试入口见[测试指南](../../test/README.md)；临时 PostgreSQL 验证凭据、配置冲突和历史用量，不能替代真实上游或账号授权验收。

## 15. 上线、运维交接与退出路径

1. 先发布兼容新配置的 runtime/admin，再由管理员创建试点连接；未配置 Copilot 时无后台轮询，原上游行为不变。
2. 上线前确认加密存储、密钥备份、网络访问、OAuth 应用许可及 file/database 部署拓扑。密钥与数据备份分别保护并实际演练恢复。
3. 先发现/勾选一个准确型号，用测试公开模型走既有运维验证及 JSON/SSE 请求；不要立即切换所有生产模型。
4. 确认身份、目标、协议、日志关联、token 续期和 unknown 成本展示后，再按现有审阅流程切换指定公开模型。
5. 发布窗口观察刷新失败、401/403/429、流式终止、请求错误率、时延以及既有事件/日志队列状态。
6. 功能退出优先在当前版本切回原渠道，保存/应用并停用 Copilot；停止任务但不自动删除恢复所需信息。
7. 如需二进制回退，先转换回旧版本支持的配置形态并验证原渠道，再部署旧版本。不能让旧代码读取未知认证模式/多绑定字段后静默选择错误后端。
8. 删除连接前确认引用和恢复需求；远端撤销与本地清理分别执行。配置历史不是凭据备份，日志也不是账单或永久审计。

### 上线前必须定案/核实的事项

- 两种客户端身份的 OAuth 应用授权、scope、允许部署方式及实际返回的有效期/续期能力。
- 每个首发型号在对应连接下的准确 ID、真实协议路径和 CLI/Harness 所需边界；不承诺账号一定存在 Claude Opus/Sonnet 5.5。
- 凭据主密钥注入、轮换/恢复和数据库多实例一致性策略；未通过跨实例验收的部署不能宣称支持共享凭据。
- 第 5、7 节建议字段/时间参数与迁移规则定稿，保持最少设置和兼容行为，不引入不必要开关。
- 是否存在可验证的渠道计价；没有则按 unknown 发布，而不是阻塞所有功能或套用其他渠道价格。

上述事项是实现/上线门槛；已确认的双身份、发现勾选、后台续期和统一运维需求不重新降级为可选项。

## 16. 参考依据

- 当前仓库：[README](../../README.md)、[项目约束](../../AGENTS.md)、[配置指南](../configuration/feature-flags.zh-CN.md)、[协议支持](../protocols/protocol-support.md)、[测试指南](../../test/README.md)。
- 参考仓库固定版本：[`pczhao1210/ghcp-pool-proxy-codebase@401a3dce4ed0992aa6bd0da5b7d832550af7616d`](https://github.com/pczhao1210/ghcp-pool-proxy-codebase/tree/401a3dce4ed0992aa6bd0da5b7d832550af7616d)。
- 参考[认证/Profile/模型发现](https://github.com/pczhao1210/ghcp-pool-proxy-codebase/blob/401a3dce4ed0992aa6bd0da5b7d832550af7616d/internal/provider/copilot/auth.go)、[token 刷新与并发协调](https://github.com/pczhao1210/ghcp-pool-proxy-codebase/blob/401a3dce4ed0992aa6bd0da5b7d832550af7616d/internal/provider/copilot/token_source.go)、[推理端点](https://github.com/pczhao1210/ghcp-pool-proxy-codebase/blob/401a3dce4ed0992aa6bd0da5b7d832550af7616d/internal/provider/copilot/provider.go)。
- [官方 Copilot SDK 认证说明](https://github.com/github/copilot-sdk/blob/main/docs/auth/README.md)用于区分身份与服务端授权方式；不据此声称参考仓库的内部 HTTP 接口具有同样支持保证。

本计划参考行为和边界，不复制参考项目的实现；客户端身份常量（应用 ID、身份标头值及设备授权请求格式）按所有者决定与参考项目保持一致。参考仓库未提供已核实的许可信息，代码复用前需要另行确认；内部 token 接口与客户端身份集成均需实际授权验证。
