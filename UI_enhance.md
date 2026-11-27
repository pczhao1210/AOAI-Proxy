# 管理后台 UI 改造调研与方案

> 日期：2026-11-27。状态：渐进实施中；选型和范围决策见 13 节，本轮交付及未完成项见 15 节。
> 1–14 节保留调研时的基线和目标，不代表当前代码状态或全部验收已完成。实施改动涵盖管理端、依赖及必要的只读接口；不修改真实运行配置。参考产品仅用于源码和文档调研，没有部署或复制其界面。

## 0. 结论

**值得大改，但不要推倒重写。** 主要问题不是配色，而是信息架构、实体编辑方式和页面框架：

- 页面按实现模块划分，而不是按管理员任务划分。“Workspace”和“Ops / Diagnostics”都混合了多个不相关领域。
- 上游、模型和 Key 都以卡片网格展示，并在卡片内展开编辑，没有表格、排序、批量操作或详情抽屉。
- 引用型字段仍是自由文本，例如 Key 的 Allowed Models。
- 没有 URL 路由。刷新后回到默认页，也不能链接到某个 Key、渠道或日志。
- [App.jsx](admin-ui/src/App.jsx) 管理几乎全部页面状态，维护成本高。

渠道映射、暴露模型、Key 模型授权和按统一型号统计（见 [渠道计划](github_copilot_channel_plan.md)）本来就要重做“上游与模型”“Key”和“运行时统计”页。因此，UI 重构应与渠道计划合并排期：**先做新外壳和基础组件，再直接用新组件实现这些功能**，避免在旧卡片界面上先实现一遍再重写。

推荐路线：

1. **保留** React 19 + Vite 8、Fastify 静态托管、全局草稿 + 审阅保存 + CAS、中英文 i18n 和 RTL 测试体系。
2. **引入** Tailwind CSS 4，并采用复制进仓库的 shadcn 风格组件（底层 Base UI）；表格用 TanStack Table；路由用 React Router 8 声明式模式；同时引入明暗主题（默认跟随系统）、lucide 图标和 Recharts。截至 2026 年，New API 和 LiteLLM 都已迁到这一类技术栈。选型依据见 1.3 节和 13 节。
3. **借鉴** 两个参考产品的这些交互：列表表格 + 侧滑编辑、URL 化筛选、行内测试、“获取模型 + 可视/JSON 映射”、日志详情抽屉，以及“公开名/底层名”统计切换。
4. **不借鉴** 它们的这些语义：按权重随机选渠道、按关键词自动停用渠道、倍率计费、用户钱包/团队层级、空列表即全部授权，以及逐实体立即保存。原因是这些语义与本项目的不变量冲突。

## 1. 调研方法与证据

### 1.1 本地观测

在临时目录生成配置：以 `config/sample_config.json` 为基础，监听 `127.0.0.1:3917`，上游指向不可达地址，并设置 3 个示例 Key。以该配置启动后端，再用 Playwright（headless Chromium）截图，并统计每页的 DOM 指标。没有使用或修改 `config/config.json`，截图未入库。

主要命令：

```bash
CONFIG_PATH=/tmp/aoai-ui-audit/config.json AOAI_PROXY_ADMIN_PASSWORD=[REDACTED] node src/server.js
# shot.js：1440×900 依次点击 .primary-nav-groups 下 7 个页面按钮，截图并统计；之后切换到 390×844 截取移动端
cd /tmp/aoai-ui-audit/pw && PW=[REDACTED] node shot.js
```

输出（`scrollHeight` 为页面总高度，单位 px）：

```text
workspace {"scrollHeight":1691,"visibleControls":80,"visibleButtons":1,"tables":0,"statCards":4,"details":5}
advanced {"scrollHeight":1393,"visibleControls":1,"visibleButtons":0,"tables":0,"statCards":6,"details":0}
keys {"scrollHeight":923,"visibleControls":43,"visibleButtons":7,"tables":0,"statCards":8,"details":3}
routing {"scrollHeight":900,"visibleControls":47,"visibleButtons":8,"tables":0,"statCards":4,"details":5}
harness {"scrollHeight":1404,"visibleControls":12,"visibleButtons":7,"tables":0,"statCards":4,"details":5}
runtime {"scrollHeight":2237,"visibleControls":2,"visibleButtons":2,"tables":10,"statCards":10,"details":6}
ops {"scrollHeight":1673,"visibleControls":18,"visibleButtons":28,"tables":1,"statCards":22,"details":6}
```

统计口径：
- `visibleControls`/`visibleButtons`：`.tab-content` 中有布局盒子的输入控件和按钮。折叠 `<details>` 内的控件不计入，但首屏以下的控件会计入，所以不代表首屏可见数量。
- `statCards`：整页的 `.stat-card, .summary-card`，包含每页顶部的 4 张全局状态卡。
- 示例数据：2 个上游、3 个模型、3 个 Key。

### 1.2 源码和产物度量

| 项目 | 数值 | 来源 |
| --- | --- | --- |
| 前端依赖 | React 19.2、Vite 8、react-hot-toast；无组件库、图标库、路由或图表库 | [package.json](package.json) |
| `App.jsx` | 1,885 行，57 个 `useState`、12 个 `useEffect` | [App.jsx](admin-ui/src/App.jsx) |
| 页面 props | `OpsTab` 52 个，`RuntimeTab` 27 个 | [App.jsx](admin-ui/src/App.jsx#L1794) |
| 样式 | `styles.css` 2,138 行，约 407 条类规则；22 处 `font-weight` ≥ 600；JSX 中有 30 处内联 `style={{}}` | [styles.css](admin-ui/src/styles.css) |
| 主题 | 只有 `color-scheme: dark`；字体栈首选 IBM Plex Sans，但未打包字体文件（无 `@font-face`） | [styles.css](admin-ui/src/styles.css#L1) |
| i18n | 单文件 2,352 行 | [i18n.jsx](admin-ui/src/i18n.jsx) |
| 入口包体 | JS 406,214 B（gzip 127,331 B）；CSS 28,678 B（gzip 6,394 B）；价格库懒加载块 261,329 B | `public/admin-app/assets/` |
| 管理端测试查询 | `getByRole` 162、`getByLabelText` 53、`getByText` 68、`querySelector` 79（含 `.left-nav`、`.status-strip`、`.save-dock`、`.model-breakdown`、`.harness-candidate` 等类名） | `test/admin-*.test.js` |
| 路由 | `activeTab` 只存在于内存，默认值为 `"workspace"` | [App.jsx](admin-ui/src/App.jsx#L148) |
| 服务端深链 | 已构建管理端时，`/admin/*`（`/admin/api/` 除外）回退到 `index.html`；自定义 `server.adminPath` 由 `rewriteAdminUrl` 改写为 `/admin` | [server.js](src/server.js#L82)、[server.js](src/server.js#L1217) |
| CSP | 管理端响应没有 `Content-Security-Policy` 头（本地 `curl -D -` 只看到 `cache-control: public, max-age=0`） | 本地观测 |

`curl` 对 `/admin/channels` 和 `/admin/keys/team-a` 都返回 `200 text/html; charset=utf-8`。因此引入 history 模式路由不需要修改部署。自定义 `server.adminPath` 下的 basename 需要少量服务端配合，见 5.3 节。

### 1.3 组件原语与路由选型 spike

在 `/tmp/ui-spike` 中进行，没有修改仓库依赖，完成后已删除。

**版本**（`npm view`，2026-11-27）：

| 包 | 版本 | peer 依赖与说明 |
| --- | --- | --- |
| `@base-ui/react` | 1.9.0 | `react` ^17–^19；自带 Combobox，并提供 `Chips`、`Chip`、`ChipRemove`、`Clear`、`Empty`、`Group`、`Status` 等部件 |
| `radix-ui` | 1.8.1 | `react` ≥16.8；没有 Combobox，shadcn 用 Popover + cmdk 组合 |
| `react-router` | 8.5.3 | `react`/`react-dom` **≥19.2.7**；7.x 最新版 7.18.7 的 peer 为 ≥18 |
| `@tanstack/react-router` | 1.170.46 | `react` ≥18 |
| `tailwindcss` / `@tailwindcss/vite` | 4.3.5 | 插件 peer 包含 Vite `^8` |
| `react` / `react-dom` | 仓库安装 19.2.6；已发布 19.2.9 和 19.3.1 | spike 使用 19.3.1、`@testing-library/react` 16.3.3、jsdom 30.1.3 |

**包体**：每个样例只导入并渲染对应组件。使用 `esbuild --bundle --minify --format=esm`，`react`、`react-dom`、`react/jsx-runtime` 设为外部依赖，结果用 `gzip -9c | wc -c` 计算（单位 B）。

| 样例 | Base UI | Radix |
| --- | --- | --- |
| 同一组 8 个原语（Dialog、Popover、Select、Tabs、Menu/DropdownMenu、Tooltip、Switch、Checkbox） | 89,893 | 46,741 |
| 外壳组（Dialog、Menu、Tooltip） | 68,621 | 36,110 |
| 仅 Dialog | 23,850 | 14,228 |
| 多选 Combobox | 51,951（原生 Combobox） | 29,873（Popover + cmdk） |
| 8 个原语 + Combobox | 104,299 | — |

| 路由样例 | gzip |
| --- | --- |
| React Router 8 声明式模式（`BrowserRouter`、`Routes`、`Route`、`Link`、`useSearchParams`） | 15,414 |
| React Router 8 数据模式（`createBrowserRouter`、`RouterProvider`、`lazy`） | 33,988 |
| TanStack Router（代码路由、`lazyRouteComponent`、`useSearch`） | 28,478 |

参照值：
- `react` + `react-dom` 19.3.1 生产构建（不设外部依赖）为 68,897 B。
- 当前 [i18n.jsx](admin-ui/src/i18n.jsx) 同时包含中英文字典，单独打包为 40,928 B，现在全部计入入口。
- 当前入口为 127,331 B。

Base UI 的固定开销较大，但增加组件的边际开销较小：外壳组再加 5 个原语只增加约 21 KB。

**jsdom 冒烟测试**：`smoke.mjs` 用 `@testing-library/react/pure.js` 测 4 个用例：
- Dialog 的 role 和名称；
- Select 打开并选择；
- Menu 打开并点击菜单项；
- 多选 Combobox 输入过滤并选择。

环境变量 `POLYFILLS` 选择测试环境的初始化方式：

- `visual`：`new JSDOM(..., { pretendToBeVisual: true })`，提供 `requestAnimationFrame`/`cancelAnimationFrame`。
- `all`：按 global-jsdom 的做法，把 jsdom `window` 上而 `globalThis` 没有的属性全部复制到全局。
- `events`：用 jsdom 的 `Event`、`CustomEvent`、`EventTarget`、`AbortController`、`AbortSignal` 覆盖 Node 自带的同名对象。
- `ro`：`ResizeObserver` 空实现。
- `pointer`：`hasPointerCapture`、`setPointerCapture`、`releasePointerCapture`、`scrollIntoView` 空实现，以及 `PointerEvent`。

```bash
CB_CLICK=1 POLYFILLS=<组合> node smoke.mjs base   # 或 radix；CB_CLICK=1 表示先点击组合框再输入
```

输出节选（每行原样保留；同一配置下的其余用例行省略）：

```text
== base POLYFILLS=<none> CB_CLICK=1
FAIL dialog role+name: Element is not defined
== radix POLYFILLS=<none> CB_CLICK=1
FAIL dialog role+name: getComputedStyle is not defined
FAIL select open+choose: HTMLFormElement is not defined
== base visual,all CB_CLICK=1
PASS dialog role+name
PASS select open+choose
PASS menu open+item
PASS combobox multi filter+choose
== radix visual,all,ro,pointer
FAIL dialog role+name: AggregateError :: Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'. | Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.
== radix POLYFILLS=visual,all,events CB_CLICK=1
TypeError: target.hasPointerCapture is not a function
FAIL select open+choose: Unable to find role="option" and name "claude"
FAIL combobox multi filter+choose: ResizeObserver is not defined
== radix POLYFILLS=visual,all,events,ro,pointer CB_CLICK=1
PASS dialog role+name
PASS select open+choose
PASS menu open+item
PASS combobox multi filter+choose
```

结论：

- 现有测试 helper 只向全局暴露 7 个 jsdom 对象（[admin-workspace-form.js](test/lib/admin-workspace-form.js#L24)），两个库在这种环境下都无法渲染。
- **Base UI** 只需要 `visual,all`。在 jsdom 中只触发输入不会打开组合框弹层（`FAIL combobox multi filter+choose: Unable to find role="option"`），先点击输入框再输入即可通过。本次没有在真实浏览器中验证这一行为。
- **Radix** 还需要 `events`、`ro`、`pointer`。cmdk 输入框同时带有 `aria-label` 和指向 cmdk 内部标签的 `aria-labelledby`，可访问名称取自后者，所以按 `{ name: "Allowed models" }` 查询失败；去掉名称条件后测试通过。这是样例写法问题，不是库缺陷。

## 2. 现状诊断

### 2.1 问题清单

| 编号 | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| D1 | 信息架构按实现划分 | Workspace 同时包含监听地址、管理路径、Key 请求头、超时、默认限额、预算开关、JSON 编辑开关、价格覆盖、持久化、日志、媒体和路由域；Ops 同时包含价格库同步、模型验证、Caddy/AAD/重启、日志和代理测试 | 模型相关操作分散在 4 页（上游与模型、Harness、Ops 的价格/验证、Workspace 的价格覆盖），用户难以找到入口 |
| D2 | 实体以卡片网格展示，并在卡片内编辑 | [EntityCard](admin-ui/src/components/ui.jsx#L108) 基于 `<details>`，同组只展开一张卡（`handleSingleOpenToggle`）；展开区的 “Delete” 直接修改草稿，Keys 和上游/模型页都没有确认 | 没有排序、列、批量操作或行内状态；双列网格展开后高度不一致；实体多时难以扫描 |
| D3 | 引用型字段是自由文本 | Key 的 `allowedModels` 用 [ListInput](admin-ui/src/components/KeysTab.jsx#L98)；上游 `provider` 和模型 `pricingRef` 也是自由文本输入（[RoutingTab.jsx](admin-ui/src/components/RoutingTab.jsx#L159)） | 模型 ID 打错时，Key 无法访问该模型，而 UI 不会提示 |
| D4 | 授权语义显示错误 | 后端空列表表示不限制（[governance.js](src/governance.js#L480)），但卡片显示 “Allowed Models: 0”（[KeysTab.jsx](admin-ui/src/components/KeysTab.jsx#L60)）；统计卡说明写 “budget or model restrictions”，计数却只统计预算（[KeysTab.jsx](admin-ui/src/components/KeysTab.jsx#L19)） | 管理员可能把“不限制”误读成“无权限”。渠道计划需要明确区分全部、指定和指定为空 |
| D5 | 全局框架占用空间，且操作含义含糊 | 每页顶部都有 4 张状态卡（约 85 px 高）；顶栏 “Refresh Data” 与 “Reload Stored Config” 的区别不清楚；Key 页在列表前还有 4 张统计卡，整页共 8 张 | 1440×900 下 Key 卡片从约 575 px 处开始，首屏只放得下 2 行（约 4 个 Key） |
| D6 | 视觉密度和层级失衡 | 所有按钮字重 600；输入框 `padding: 0.8rem 0.9rem`；Ops 页共 22 张统计卡（含全局 4 张）；代理测试卡把 `/v1/chat/completions` 断成 `/v1/chat/compl` + `etions` | 信息密度低，重点不突出，不像现代管理控制台 |
| D7 | 页面结构不一致 | Harness 页没有页面级标题，内容区首行直接是 “Saved configuration” 和 “Refresh eligibility” 按钮 | 用户在各页之间切换时难以定位 |
| D8 | 移动端布局损坏 | 390×844 下语言选择框压住 Logo 和标题，“Refresh Data” 与 “Configuration history” 按钮文本重叠，状态卡被横向截断 | 无法在手机上紧急查看状态 |
| D9 | 没有 URL 状态 | 页面、分节、筛选、展开项都不进入 URL | 刷新会丢失位置；不能分享日志或 Key 的链接；浏览器后退无效 |
| D10 | 前端状态集中在一个组件 | 57 个 `useState` 集中在 App；Ops 页需要 52 个 props | 任何页面变化都要修改 App；新页面难以独立测试 |

### 2.2 必须保留的现有优点

- **全局草稿与审阅保存：** 草稿 → “Review & Save” → ETag/`If-Match` CAS；冲突时可对比；`apply.proxy`、`apply.caddy` 和 `apply.persistence` 分阶段反馈并重试。
- **配置保护：** 最近 12 个脱敏历史版本；待同步数据库保护；密钥脱敏往返，不覆盖凭据。
- **i18n：** 中英文双字典；`updateConfig`/`updateField` 保留隐藏字段和数值 0。
- **页面能力：** 页面懒加载；Harness 的多选模态框和资格预览可作为“批量暴露模型”的现成样板。
- **测试：** 以 role/label 查询为主的可访问性测试，迁移后仍然可用。

## 3. 参考产品调研

### 3.1 New API

版本：`QuantumNous/new-api` `main` @ [`81c1fd20`](https://github.com/QuantumNous/new-api/tree/81c1fd20efade39a5d5692c8018dfef4cfb30e1d/web)（2026-11-26）。

- **技术栈：** React 19、TypeScript、Rsbuild、Tailwind 4，以及 shadcn 风格的 Base UI 组件；TanStack Router、Query、Table 和 Virtual；Zustand；react-hook-form + zod；VChart 和 Recharts；i18next（7 种语言）；next-themes。主题抽屉可调整明暗、圆角、密度、侧栏样式等。
- **前端历史：** 原 Semi Design 的 classic 前端已在 `31d70fca`（2026-07-20）移除。`337169e0`（2026-07-11）曾回滚一次大型设计系统重构，说明一次性大改有风险。
- **导航：** Chat（Playground、Chat）、General（Overview、Dashboard、API Keys、Usage/Audit/Task Logs）、Personal（Wallet、Profile、Security & Access）和 Admin（Channels、Models、Users、Redemption Codes、Subscriptions、System Info、Plugins、Request processing、System Settings）。System Settings 进入二级侧栏（`web/src/hooks/use-sidebar-data.ts`）。
- **渠道列表：**
  - 表格：列显示/隐藏和列宽（桌面端）持久化到 localStorage；可切换卡片视图；筛选写入 URL。
  - 行组织与批量：标签聚合行；批量启用、停用、设标签和删除（删除需确认）。
  - 行内操作：测试、启用/停用、刷新余额；可拖拽调整优先级。
  - 来源：`features/channels/components/channels-table.tsx`、`data-table-bulk-actions.tsx`。
- **渠道编辑：** 使用宽 Sheet，分为 4 个标签：连接与模型、路由与映射、请求与响应、其他。每个标签带完成状态图标。模型字段支持“从上游获取”“填入相关模型”“复制/清空”。映射编辑器可在可视和 JSON 之间切换（`drawers/channel-mutate-drawer.tsx`，约 5,000 行；另有 `model-mapping-editor.tsx` 和 `upstream-model-selection.tsx`）。
- **模型：** 分为 Models、Vendors 和 Deployments。“Missing Models”列出尚无元数据的模型；同步元数据时先预览再应用。
- **路由逻辑：** `Ability(group, model, channel)` 按优先级分层，层内按权重随机选择，重试时进入下一层（`model/channel_cache.go`、`model/ability.go`）。
- **Token：** Sheet 分为 Basic Information、Quota Settings 和 Advanced Settings 三段；高级段包含 Model Limits 和 IP 白名单（`features/keys/components/api-keys-mutate-drawer.tsx`）。不允许的模型由中间件返回 403（`middleware/distributor.go`）。
- **统计与日志：** Dashboard 包含图表和 Sankey 流向图（管理员视角包含渠道层）。日志表只对管理员显示渠道列；详情对话框展示计费拆分、重试链和策略决策。没有独立的按渠道报表。

### 3.2 LiteLLM

版本：`BerriAI/litellm` `main` @ [`97176d84`](https://github.com/BerriAI/litellm/tree/97176d84/litellm/ui/litellm-dashboard)（2026-11-27）。

- **技术栈：** Next.js 16 静态导出、React 19、Tailwind 4，以及 shadcn 风格的 Base UI 组件；TanStack Query、Table 和 Virtual；react-hook-form + zod；nuqs（URL 状态）；Recharts；next-themes；cmdk 命令面板；sonner；react-i18next（en/zh-CN）。antd 已在 `7b574b9df6`（2026-08-19）移除；迁移期间各页面样式并不完全一致。
- **导航：** AI Gateway、Observability、Access Control、Developer Tools 和 Settings 五组，约 30 项；按角色过滤，并带面包屑（`src/components/LeftNav.tsx`）。
- **Model Management：** 共 10 个 URL 同步标签：All Models、Add Model、Auto Routers、LLM Credentials、Pass-Through、Health、Retry Settings、Model Group Alias、Access Group Budgets、Price Data（`src/app/(dashboard)/models-and-endpoints/page.tsx`）。表格有 “Source（DB/Config）” 徽标；由配置文件定义的模型不能在 UI 中编辑。
- **Add Model：** 使用卡片表单，包括 provider、底层模型名和 “Public Model Name ↔ LiteLLM Model Name” 映射表；凭据可选择已有命名凭据或现填；表单内有 “Test Connect” 按钮（`components/add_model/AddModelForm.tsx`）。相同公开名的多条部署组成负载均衡组。
- **Router Settings：** 集中配置路由策略、Fallbacks 和重试；来自配置文件的项显示 “Set in config.yaml”。
- **Virtual Key：** 列表使用表格、筛选抽屉和批量编辑；在对话框中创建 Key，组件约 96 KB。模型多选包含 “All Team Models” 和 “All Proxy Models”，空列表表示全部。Key 详情页包含 Overview、Activity、Settings 等标签。
- **Usage：** 提供视图选择器，日期范围同步到 URL。Model Activity 可在 **公开模型名和底层模型名** 之间切换（`ModelViewToggle`）。按 Provider 的花费可导出 JSON/PDF。
- **Logs：** 表格列丰富，支持筛选抽屉、时间预设、CSV 导出，以及每 15 秒刷新的 Live Tail。右侧 Sheet 详情支持键盘切换上一条/下一条，并包含路由决策卡和成本拆分（`components/logs/detail/LogDetailsDrawer.tsx`、`RoutingDecisionCard.tsx`）。

### 3.3 共同趋势

两者都在 2026 年从传统组件库（Semi、antd + Tremor）迁到 **Tailwind 4 + 复制进仓库的 shadcn/Base UI 组件 + TanStack Table**。它们都把页面、标签和筛选放进 URL，用“表格 + 侧滑面板/详情页”编辑实体，并提供明暗主题和可调密度。同时两者也暴露了同一类问题：导航和表单过度膨胀（约 30 个导航项、10 个模型标签、5,000 行抽屉、96 KB 建 Key 表单）。

### 3.4 借鉴取舍

| 模式 | 来源 | 结论 | 在本项目中的形式 |
| --- | --- | --- | --- |
| 列表表格 + 侧滑编辑 | 两者 | **采用** | 渠道、暴露模型、Key 统一使用 DataTable + Sheet；卡片只用于 KPI |
| 筛选、标签、选中项进入 URL | 两者 | **采用** | 支持深链、刷新保持和浏览器前进/后退 |
| 列显示、列宽持久化、批量模式 | New API | **采用** | 批量启用/停用/删除只修改草稿，进入统一审阅 |
| 编辑表单分标签，并显示完成或错误状态 | New API | **采用** | 渠道抽屉分 4–5 个标签；未通过校验的标签标红 |
| 获取模型 + 可视/JSON 映射 | New API | **采用** | 只编辑渠道计划规定的 `modelMappings`，不照搬其映射语义 |
| Missing Models | New API | **改造** | 改为“Catalog 未匹配 / 映射未启用”清单，并引导补全 |
| 预览再应用的同步向导 | New API | **采用** | 用于价格库同步和模型清单刷新的差异预览 |
| 敏感信息遮罩开关 | New API | **采用** | 表格中隐藏 URL、Key 片段等，便于截图和共享屏幕 |
| 行内 Test Connect | LiteLLM | **采用** | 在渠道行和抽屉中测试；明确使用已保存配置还是草稿 |
| Source / Set in config 徽标 | LiteLLM | **改造** | 显示“环境变量覆盖”“profile 禁用”“需重启”“热更新” |
| 公开名/底层名统计切换 | LiteLLM | **采用** | 在公开模型 ID 与统一型号之间切换，可展开渠道 |
| 日志详情抽屉、键盘切换、成本拆分、路由决策 | LiteLLM | **采用** | 展示 Key → 公开 ID → 统一型号 → 渠道 → 原始型号 → 最终协议 |
| 命名凭据复用 | LiteLLM | **暂缓** | 与渠道凭据生命周期和加密存储相关，跟随渠道计划设计 |
| 命令面板 | LiteLLM | **不采用** | 已确认不需要（13 节）；页面跳转依靠侧栏和 URL 深链 |
| 优先级分层 + 权重随机 / 自动 fallback | 两者 | **不采用** | 渠道计划首版只做固定绑定，避免静默改变计费、数据驻留和协议行为 |
| 按错误关键词自动停用渠道 | New API | **不采用** | 自动改变路由属于策略决策，需要显式管理员策略 |
| 倍率/分组倍率计费 | New API | **不采用** | 使用 Catalog 和 pricing 单价；未知仍显示为未知 |
| 钱包、兑换码、用户、团队、组织 | 两者 | **不采用** | 本项目是单管理员的代理控制台，不是多租户平台 |
| 空模型列表表示全部 | LiteLLM | **不采用到新 Key** | 新 Key 使用显式的“全部 / 指定”；只为旧 Key 保留“空即不限制”的兼容含义 |
| 逐实体立即保存 | 两者 | **不采用** | 保留全局草稿 + CAS + 历史 + 分阶段应用 |
| 30 项导航、超大表单 | 两者 | **避免** | 一级导航不超过 14 项；抽屉按标签拆分，单个组件不超过约 600 行 |

## 4. 方案选择

| 方案 | 做法 | 收益 | 成本与风险 | 结论 |
| --- | --- | --- | --- | --- |
| A. 只换皮 | 调整颜色、字号、间距，增加浅色主题 | 改动小 | 无法解决 D1–D4、D9 和 D10；渠道计划仍需重写这些页面 | 不推荐 |
| **B. 渐进重构** | 先建新外壳、路由和组件，旧页面先挂在新外壳内，再逐页替换 | 每阶段可发布；与渠道计划共用工作量；测试持续可用 | 过渡期存在两套样式，需要隔离 | **推荐** |
| C. 重写 | 新建 Next.js 或 Rsbuild 应用，或新建仓库，一次性替换 | 架构最干净 | 改变静态托管和 basePath；全部测试重写；长时间不能发布；New API 曾回滚类似重构 | 不推荐 |

## 5. 目标信息架构

### 5.1 导航

一级导航 13 项，按任务分为 6 组：

```text
概览
模型服务
  渠道              /channels      上游连接、认证（含 Copilot 登录）、模型清单与映射、协议路由
  暴露的模型        /models        从渠道清单中批量选择公开模型、固定渠道绑定
  客户端接入        /clients       Claude Code / Codex（现 Harness）
  模型目录          /catalog       价格库与同步、Catalog 未匹配、价格覆盖
访问控制
  API Keys          /keys          Key 列表、添加/修改 Key（唯一的模型授权入口）
观测
  用量统计          /usage         公开 ID / 统一型号 → 渠道、按 Key、趋势、治理信号
  请求日志          /logs          表格 + 详情抽屉
  运行状态          /health        持久化、运行存储、spool、Log Analytics、渠道凭据状态
工具
  Playground        /playground    代理测试请求
  诊断              /diagnostics   已配置模型验证、Harness 资格诊断入口
系统
  设置              /settings/*    二级导航
  配置中心          /config/*      历史与回滚、待同步、JSON 高级编辑
```

### 5.2 旧位置到新位置的映射

迁移时逐项核对，确保没有功能丢失。

| 现有位置 | 新位置 |
| --- | --- |
| 顶部 4 张状态卡 | 概览 KPI；顶栏状态胶囊 |
| 顶栏 Refresh Data / Reload Stored Config / Configuration history | 顶栏“配置状态”菜单：“刷新运行数据”“从存储重新加载”（有未保存草稿时先确认）“配置中心 → 历史” |
| Workspace → Core：profile、host/port、admin path、Basic Auth、trust proxy、强制 revision、JSON 编辑开关 | 设置 → 服务与安全 |
| Workspace → Core：超时 | 设置 → 代理与超时 |
| Workspace → Core：Key header、强制 API Key、默认 RPM/TPM/并发、预算开关 | 设置 → 访问默认值 |
| Workspace → Core：Pricing Catalog JSON | 模型目录 → 价格覆盖 |
| Workspace → Persistence & Cache（含数据库连接测试） | 设置 → 持久化 |
| Workspace → Logging & Analytics（含 LA 初始化） | 设置 → 日志与 Log Analytics |
| Workspace → Media Policy | 设置 → 媒体与实时 |
| Workspace → Routing Domain | 设置 → 协议与路由域 |
| Advanced JSON | 配置中心 → JSON |
| Keys | API Keys |
| Upstream / Model → Upstreams | 渠道 |
| Upstream / Model → Models、模板选择对话框 | 暴露的模型（模板创建并入“从渠道/目录添加”） |
| Harness | 客户端接入 |
| Runtime → 概要、周期统计、系统健康 | 概览；用量统计 |
| Runtime → 持久化/日志运行态、历史 rollup | 运行状态 |
| Runtime → 预算告警与拒绝原因 | 概览“需要关注”；用量统计 → 治理信号 |
| Runtime → Key 治理运行态 | API Keys 列表中的用量/预算列；用量统计 → 按 Key |
| Runtime → 模型统计、应用卡片价格、重置统计 | 用量统计 → 按模型（“应用卡片价格”标注为草稿修改） |
| Ops → Overview | 概览 |
| Ops → Model Validation | 诊断；渠道和暴露模型行内提供单项验证入口 |
| Ops → Pricing Library | 模型目录 |
| Ops → Caddy & Service、AAD、重启 | 设置 → 网关与服务 |
| Ops → Runtime Logs | 请求日志 |
| Ops → Proxy Test | Playground |
| 待同步数据库横幅与对比 | 全局告警区；配置中心 → 同步 |

### 5.3 URL 约定

```text
/admin/overview
/admin/channels?status=active&q=foundry
/admin/channels?edit=foundry&tab=models
/admin/models?group=canonical
/admin/keys?edit=team-a&tab=access
/admin/usage?range=7d&key=team-a&by=canonical
/admin/logs?requestId=...&outcome=error
/admin/settings/persistence
/admin/config/history
```

- **basename 不能写死为 `/admin`**，因为管理员可以配置 `server.adminPath`，服务端再把它改写为 `/admin`（[server.js](src/server.js#L82)）。
  - 现有 [getAdminBasePath](admin-ui/src/api.js#L29) 在路径不以 `/admin` 开头时，把整个页面路径当作管理端根路径。没有深链时这没有问题。引入路由后，在 `/console/keys/team-a` 这样的地址，API 会被拼成 `/console/keys/team-a/api/...`。
  - 只靠客户端推导也有歧义。例如 `adminPath` 为 `/ops/logs` 时，`/ops/logs` 既可能是管理端根路径，也可能是 `/ops` 下的日志页。
  - **U1 方案：** 服务端在返回 `index.html` 时（[server.js](src/server.js#L1214) 和 [server.js](src/server.js#L1225) 的两处 `sendFile`）注入生效的管理路径，例如 `<meta name="aoai-admin-base" content="/console">`。路由 basename 和 `adminApiUrl` 都读取这个值；没有该值时回退到现有逻辑。
  - 新路由不能使用 `legacy` 段，因为服务端会把 `/admin/legacy/*` 重定向到管理端根路径。
- `edit` 参数使用实体的稳定标识。草稿中重命名实体时，同步更新 URL。指向不存在的实体时，显示“未找到”并保留列表。
- 切换页面不丢失未保存草稿；只有离开整个应用时提示（`beforeunload`）。
- 声明式路由没有 `useBlocker`，浏览器后退会通过 URL 关闭 Sheet。Sheet 中还没“应用到草稿”的修改，按实体标识保存在内存中，关闭时提示“修改已保留”，重新打开同一实体时恢复。点击“取消”才丢弃这些修改。

## 6. 全局框架与交互模型

### 6.1 外壳

- **侧栏：** 可折叠；宽屏完整显示，900–1280 px 显示图标栏，900 px 以下改为抽屉。页面有未保存修改时，在对应菜单项显示圆点。
- **顶栏：** 面包屑；分发 profile 徽标（`nextgen`/`minimum`）；配置状态胶囊（短 revision、已应用、部分应用、待同步、需重启）；语言切换；主题切换（跟随系统、浅色、深色；默认跟随系统）。
- **全局告警区：** 将现有分散横幅统一放在顶栏下，包括应用失败（可重试对应阶段）、待同步数据库、弃用字段清理和需重启项。
- **页面头：** 每页使用相同结构，依次为标题、一句说明、主操作、可选标签。Harness 页也遵守该结构。
- **保存坞：** 保留。审阅对话框改为**按实体分组的结构化差异**（渠道、暴露模型、Key、设置），并可展开原始 JSON diff。单独列出需重启、被环境变量覆盖而不会生效、以及 profile 禁用的项目。保存后按 `apply.proxy`、`apply.caddy` 和 `apply.persistence` 分别显示结果。

### 6.2 三类动作必须在 UI 上区分

| 类型 | 例子 | 行为 |
| --- | --- | --- |
| **配置编辑**（进入全局草稿） | 编辑渠道、映射、暴露模型、Key、设置；表格行内启用/停用；批量操作 | Sheet 编辑的是**实体完整副本**（保留未知字段和数值 0）。点击“应用到草稿”后整对象写回；“取消”丢弃副本；关闭时如有未应用修改，需要确认。行内开关直接改草稿，并在行上标“未保存”，**不会立即生效**。这与 New API 不同，界面必须写明。删除前检查引用（Key → 模型、Harness、默认模型）；删除操作可通过放弃草稿撤销 |
| **即时操作**（直接调用 API，不进草稿） | 测试连接、获取模型、Copilot 登录/刷新、同步价格库、模型验证、数据库测试、LA 初始化、重启、统计同步/重置 | 使用带图标的次级按钮，并说明“立即执行”。界面写明作用于已应用配置还是当前草稿；实体有未保存修改时提示差异。危险操作二次确认；结果显示 toast，并能跳转到相关日志 |
| **只读查询** | 用量、日志、运行状态、资格预览 | 筛选写入 URL；支持自动刷新开关。异步结果沿用请求序号和快照代次 fencing，旧响应不能覆盖新筛选的结果 |

### 6.3 状态表达

- **未知不是 0：** 未知计价、未加载预算、缺失 usage 都显示“未知/部分”，不能显示 `0` 或 `$0`。
- **授权文案明确：** Key 的模型权限只显示三种状态：“全部已暴露模型”“指定 N 个”“无（指定为空）”。旧 Key 的空列表显示“全部（旧版未限制）”。
- **字段来源徽标：** 热更新、需重启、环境变量管理（只读）、当前 profile 禁用，与配置指南保持一致。
- **新鲜度：** 数据快照、模型清单和资格预览都显示获取时间。资格预览区分“已应用配置”和“草稿预览”，失败或过期时不能用于批准新增模型。

### 6.4 响应式

- **≥ 1280 px：** 完整布局；Sheet 宽度为 640–960 px，按页面设置。
- **< 900 px：** 表格保持表格形式，在容器内横向滚动，并固定首列（名称和状态）；不做卡片视图。Sheet 全屏；顶栏次要操作收进菜单。页面不能重叠，除表格容器外不能出现横向滚动。
- **移动端范围（已确认）：** 只保证查看和紧急操作。
  - 查看：概览、运行状态、日志和用量。
  - 紧急操作：启用/停用 Key 和渠道，重试失败的应用阶段。停用仍然走草稿和审阅保存，所以保存坞和审阅对话框必须能在窄屏上使用。
  - 映射、暴露模型、设置和 Playground 等复杂编辑，在窄屏上提示改用宽屏，但布局不能损坏。

## 7. 设计系统

### 7.1 视觉规范

- **主题：** 使用语义化 CSS 变量（`--background`、`--card`、`--border`、`--foreground`、`--muted-foreground`、`--primary`、`--success`、`--warning`、`--destructive`、`--info`），分浅色和深色两套。正文对比度满足 WCAG AA（4.5:1）。
  - 默认跟随系统：没有用户选择时由 `prefers-color-scheme` 媒体查询决定，不需要脚本。
  - 用户在顶栏选择浅色或深色后，选择存入 localStorage，并在入口模块渲染前写入 `<html data-theme>`。不使用内联脚本，以免影响以后启用严格 CSP。
- **密度：** 控件高 32–36 px，表格行高约 40 px；正文 14 px，表格 13 px，页面标题 20 px。字重只用 400、500、600；正文和按钮默认不加粗。数字使用 `tabular-nums`。
- **布局：** 以 8 px 为间距单位；表单内容最大宽度约 960 px，表格占满宽度；卡片只用于 KPI 和摘要，不用于实体列表。
- **字体：** 系统字体栈，中文回退到 Noto Sans SC 或系统中文字体，不加载远程字体，以兼容内网和离线部署。
- **图标：** 使用 lucide。状态同时用颜色、图标和文字表达，不只依赖颜色。

### 7.2 组件清单

| 类别 | 组件 |
| --- | --- |
| 框架 | AppShell、Sidebar、Topbar、Breadcrumb、PageHeader、AlertRegion、SaveDock、ReviewDialog |
| 数据 | DataTable（排序、筛选、列显示、行选择、批量栏、空/加载/错误态、窄屏横向滚动与固定首列）、VirtualTable（日志）、StatCard、Chart 封装、KeyValue 列表 |
| 编辑 | Sheet（标签页、校验状态、底部“应用到草稿/取消”）、Field（标签、提示、来源徽标、错误）、Switch、Select、Combobox/MultiSelect（chips，显示失效项）、MappingEditor（可视/JSON 同源）、JSON 文本编辑（校验失败时保留原文本）、SecretField（遮罩、复制走专用 API） |
| 反馈 | Badge/StatusPill、Tooltip、Toast（保留 react-hot-toast）、ConfirmDialog（危险操作需输入名称确认）、EmptyState、CopyButton |

所有组件保留语义 role 和 label，使现有 `getByRole`/`getByLabelText` 测试继续可用。

### 7.3 技术选型

| 领域 | 建议 | 理由 | 需在 U0 验证 |
| --- | --- | --- | --- |
| 构建与托管 | 保留 Vite 8 + React 19，产物仍输出到 `public/admin-app/` | Fastify 静态托管、容器复制资产和 CI 临时目录编译都不变 | — |
| 样式 | Tailwind CSS 4 + CSS 变量主题 | 两个参考都采用；生成静态 CSS，不需要运行时样式注入，以后加严格 CSP 也更容易 | 与 Vite 8 插件的兼容性；preflight 与旧全局样式的冲突 |
| 组件原语 | **Base UI**（`@base-ui/react`）；shadcn 风格组件以 JSX 复制进 `components/ui/`，页面只依赖这一层 | 原生多选 Combobox（chips、清除、空状态、读屏状态），直接满足 Key 模型授权、暴露模型和渠道模型勾选；两个参考都使用基于 Base UI 的 shadcn 变体，可直接对照；jsdom 下需要的测试补丁更少（1.3 节） | 真实 Vite 构建的入口包体（见下方预算）；Tailwind preflight 与弹层的配合 |
| 表格 | TanStack Table；日志用 TanStack Virtual | 排序、筛选、列控制和选择都不需要自造 | — |
| 路由 | **React Router 8 声明式模式**（`BrowserRouter` + `Routes` + `useSearchParams`，页面继续用 `React.lazy`） | 实测最小（15.4 KB gzip；TanStack Router 28.5 KB，React Router 数据模式 34.0 KB）；本项目是 JS，TanStack Router 的类型化搜索参数优势基本用不上；数据加载继续由带 fencing 的领域 hooks 负责，不需要 loader；草稿跨页面保留，不需要只有数据模式才提供的 `useBlocker`，离开应用时用 `beforeunload` 提示 | `react`/`react-dom` 补丁升级到 `^19.2.9`（peer 要求 ≥19.2.7）后管理端测试通过；basename 注入（5.3 节） |
| 服务端状态 | 先抽成按领域的 hooks；只读资源可选 TanStack Query | 减少 App 中的状态和 props；必须保留现有 fencing | 与 `runtime-loader` 的配合 |
| 配置草稿 | `ConfigDraftProvider`（context + reducer/外部 store），统一提供 `updateConfig`、`dirty`、diff 和保存 | 把草稿逻辑移出 App；页面直接读取 | 现有保存、冲突和重试测试保持通过 |
| 表单 | 受控的本地实体副本 + 共享校验函数；不强制引入 react-hook-form | 全局草稿模型下，额外表单状态层收益有限 | — |
| 图表 | Recharts，只在概览和用量页懒加载 | 两参考均有使用 | 包体 |
| i18n | 保留 `useI18n`；字典按领域拆分文件；增加双语缺失 key 检查 | 迁移到 i18next 收益小、改动大 | — |

**包体预算（按选型调整）：** 首屏入口 JS 不超过 **200 KB gzip**（当前 127,331 B）。

- **估算：** React 约 69 KB、React Router 声明式约 15 KB、Base UI 外壳组约 69 KB、单一语言字典约 20 KB，再加上外壳、草稿和 API 代码，约 185 KB。同口径下 Radix 方案约 150 KB。
- **措施：**
  - 所有页面按路由懒加载。
  - Select、Combobox、Tabs 等非外壳原语只在用到它们的页面块中加载。
  - i18n 字典按语言拆分，只加载当前语言。
  - 图表、JSON 编辑、价格库和日志虚拟列表按路由懒加载。
- **回退条件：** U0 用真实 Vite 构建确认。如果采取以上措施后入口仍超过 200 KB，就改用 Radix（同口径外壳组 36.1 KB gzip），多选改用 Popover + cmdk。由于页面只依赖 `components/ui/`，替换范围限于该目录和测试初始化。

### 7.4 新旧样式共存

`styles.css` 直接为 `button`、`input`、`select` 等元素设置了全局样式，会与新组件冲突。过渡期要求：

1. 旧页面整体包在 `.legacy-page` 中，并把旧规则改为该作用域下的规则，或放入较低优先级的 `@layer legacy`。
2. 旧样式移除前，关闭 Tailwind preflight，或只对新组件作用域启用。
3. 每迁完一页，就删除对应旧规则。U5 结束时，`styles.css` 只保留 tokens 和必要的全局样式。
4. 旧样式只适配深色：根节点写死 `color-scheme: dark`，并有 102 处硬编码颜色（64 处 `rgb()`/`rgba()`，38 处十六进制），只有 112 处使用 `var(--…)`。U1 把这些颜色替换为主题 tokens，使挂在新外壳中的旧页面在浅色主题下也可读；不能为了兼容旧页面而把新外壳锁定为深色。

## 8. 页面方案

### 8.1 概览

- **KPI：** 请求数、错误率、输入/输出 token、参考成本（标注“可能不完整”）。
- **趋势和 Top 列表：** 趋势图使用数据库 rollup；没有运行存储时显示“需要数据库统计”空状态和设置入口，不伪造曲线。Top 模型和 Top Key 只显示前 5，并链接到用量统计。
- **“需要关注”列表：**
  - 配置和运维：应用失败、待同步、需重启、上次模型验证失败。
  - 渠道和模型：渠道凭据即将过期或需要重登（渠道计划 P1 后）、Catalog 未匹配模型。
  - 治理：预算预警、近期拒绝原因。

### 8.2 渠道

- **表格：** 列为名称、类型/provider、状态开关、Base URL（可遮罩）、认证方式、已启用映射数/清单数、最近测试结果与时间、操作。支持按类型、状态和关键字筛选。
- **行操作：** 编辑、测试、获取模型、复制、删除（检查引用）。Copilot 渠道额外提供“重新登录”“刷新清单”。
- **编辑 Sheet 标签：**
  1. **连接与认证：** 名称、类型（固定选项，不再自由输入）、Base URL、认证方式、密钥。Copilot 渠道在这里选择身份、完成设备码登录并查看状态。
  2. **模型与映射：** 显示清单来源和获取时间。表格视图的列为“原始型号 → 统一型号 → 启用 → 来源/差异”，可切换到 JSON 视图。支持批量勾选、获取差异预览，以及标记未匹配 Catalog 的条目。
  3. **路由与协议：** 编辑 `upstreams[].routes`，并显示每个接口最终 URL 推导出的协议。
  4. **请求与错误策略：** `requestPolicy`、`errorPolicy` 等。
  5. **高级：** 优先级等不常用字段，以及未在表单中呈现的字段（只读 JSON 视图，保证不丢失）。
- **测试结果和清单数据：** 测试结果写入运行时状态，不写入配置。获取模型只把选中条目带回草稿，**不会**发布模型或改变 Key 权限。

### 8.3 暴露的模型

- **默认视图：** 按统一型号分组。每行显示公开 ID、当前绑定（渠道 / 原始型号）、默认路由、状态、Harness 成员标记和 Catalog 匹配状态。
- **“从渠道添加”：** 打开类似 Harness 的多选器，候选集是所有渠道已启用映射的并集，按统一型号去重。支持搜索和已选/未选/不可选筛选；可展开查看候选渠道和不可选原因。有多个候选时，必须显式选择渠道。
- **编辑 Sheet：** 包括公开 ID、显示名、绑定选择、路由覆盖、`clientNativeRoute`/`clientConversion`（只读，并链接到客户端接入）、只读能力和价格来源，以及访问标签。
- **移除检查：** 被 Key 指定名单、Harness 或默认模型引用时，**只读列出影响项**，并提供跳转到对应 Key 编辑 Sheet 的入口。模型页不能直接撤销 Key 权限。
- **兼容期：** 渠道计划 P2/P3 完成前，本页先用表格 + Sheet 承载现有 `models[]` 字段，不引入新语义。

### 8.4 客户端接入

保留现有 Harness 逻辑和测试语义：发布开关、选择器、资格预览与 fencing、原生路由优先和转换确认。只做三项改动：

- 统一页面头；“Saved configuration”和“Refresh eligibility”移到页面头操作区。
- 两个客户端改为并列摘要卡，包含成员数、发布状态和资格新鲜度，各自配有“选择模型”入口。
- 保留可折叠的连接指南和现有复制按钮（[HarnessSetup.jsx](admin-ui/src/components/HarnessSetup.jsx)）。

### 8.5 API Keys

- **表格：** 列为名称/ID、所有者、状态开关、模型权限摘要（全部 / 指定 N / 无 / 旧版未限制）、RPM/TPM/并发、预算使用率进度条（未加载时显示未知）、最近使用时间（治理运行态 `lastSeenAt`，未加载时显示未知）、标签。支持搜索、按状态筛选和批量启用/停用。
- **添加/修改 Sheet：**
  1. **基础：** ID、显示名、所有者、状态。新建时可在浏览器内生成随机 Key（使用 `crypto.getRandomValues`）。保存前完整显示并可复制；保存后只按现有脱敏和复制接口处理。
  2. **模型权限（唯一的授权入口）：**
     - 用单选决定“全部已暴露模型（包括以后新增）”还是“指定模型”。新建 Key 默认“指定模型”，且不预选任何模型；选择“全部”需要二次确认。指定模型时，从已暴露公开 ID 中多选，列表同时显示统一型号和当前渠道，便于辨认。修改 Key 时回显实际生效的模式和原名单。
     - 失效引用（模型已不再暴露）单独列出并标警告，允许删除。
     - 显示权限变化预览，包括新增和撤销的模型，以及以后新增模型是否会自动获得授权。
     - 渠道计划 P3 提供 `modelAccessMode` 之前，空列表在后端仍表示不限制。因此 UI **必须阻止保存“指定但为空”**，并提示原因，不能让它被解释成全部授权。P3 之后，“指定为空”保存为 `modelAccessMode: "selected"` + `[]`，表示无任何模型权限（见渠道计划第 5 节）。
  3. **限流：** RPM、TPM、并发、窗口。为 0 时显示“不限制”或“继承默认”，具体以后端语义为准。
  4. **预算：** 额度、币种和窗口。
  5. **备注与标签。**
- **行内入口：** 每行提供“查看用量”“查看日志”，直接跳转到按该 Key 过滤的用量统计和日志页，不另建详情页。

### 8.6 用量统计

- **筛选：** 时间范围、Key，以及分组方式（公开模型 ID / 统一型号，参考 LiteLLM 的切换）。
- **“按模型”表：** 主行可展开渠道子行（统一型号维度在渠道计划 P4 后提供），再展开可查看原始型号、公开 ID 和计费 tier。列包括请求、错误、输入/输出/缓存 token、参考成本和未知计价笔数。缺少维度的历史数据单列为“未知渠道”。
- **其他标签：** 按 Key（预算使用率、拒绝次数）、趋势（rollup）、治理信号（预算预警、拒绝原因）。
- **配置类动作：** “应用卡片价格”属于配置编辑，必须标注它会写入草稿。“重置统计”属于即时操作，需要二次确认。

### 8.7 请求日志

- **列表：** 虚拟滚动表格，筛选项包括时间、级别、结果、事件、模型、Key、Request ID 和关键字；可隐藏认证拒绝；支持自动刷新。
- **详情 Sheet：**
  - 支持上一条/下一条（键盘 `j`/`k`）和复制 Request ID。
  - **路由链：** Key → 公开 ID → 统一型号 → 渠道 → 原始型号 → 最终 URL 协议 → 上游实际返回型号。
  - **用量和成本：** 显示 usage 与成本拆分（缓存读写分开显示，未知要明确）。
  - **错误和相关事件：** 显示错误分类；列出同一 Request ID 的相关事件。
  - 正文显示遵循 `messageContentMode`，没有记录正文时说明原因。

### 8.8 运行状态

只读展示配置存储模式与健康状态、待同步记录、运行存储与 spool（隔离记录数）、rollup 新鲜度、Log Analytics sink 和 Caddy 状态。渠道计划 P1 之后，再加入渠道凭据状态（有效期、下次刷新、清单新鲜度，不含任何 token）。所有修改操作都链接到设置页，本页不提供编辑。

### 8.9 Playground 与诊断

- **Playground：** 保留端点选择、测试 Key、payload 编辑、图片压缩和占位符插入。使用双栏布局：左侧请求，右侧响应；流式响应逐帧显示终止事件。
- **诊断：** 提供已配置模型的批量验证，并提示真实探测可能产生费用。结果表可跳转到对应渠道或模型的 Sheet。另提供 Harness 资格诊断入口。

### 8.10 设置

- 参考 New API 的二级导航，按 5.2 节拆成：服务与安全、代理与超时、访问默认值、持久化、日志与 Log Analytics、媒体与实时、协议与路由域、网关与服务。
- 每个字段显示来源徽标（热更新、需重启、环境变量管理、profile 禁用）。环境变量管理的字段为只读，并说明来源。
- 提供设置搜索和“只看已修改”筛选。
- Realtime、WebRTC、媒体编辑等默认关闭的能力单独标注风险说明，并说明需要的部署条件，例如单实例或会话亲和。

### 8.11 配置中心

- **历史：** 列出最近 12 个版本的时间、revision 和变更摘要；可查看分组 diff；回滚会创建新 revision，并说明不会热应用需重启的项目。
- **同步：** 显示待同步数据库记录，提供对比、从存储重新加载或放弃待同步记录。这些操作沿用现有 CAS 和确认流程。
- **JSON：** 仅当 `admin.features.enableLegacyJsonEditor` 开启时显示。解析失败时保留编辑文本，阻止应用。

## 9. 前端代码结构调整

```text
admin-ui/src/
  app/            AppShell、路由表、主题、全局告警、保存坞
  lib/            api.js、config-draft（Provider + diff + 保存/冲突/重试）、fencing 工具、url-state
  components/ui/  设计系统组件（shadcn 风格、基于 Base UI、JSX、复制进仓库）
  features/
    overview/ channels/ models/ clients/ catalog/ keys/
    usage/ logs/ health/ playground/ diagnostics/ settings/ config/
  i18n/           按领域拆分的 zh-CN / en 字典 + 缺失 key 检查
```

- **App 拆分：** App 只负责外壳和路由。保存、冲突和重试逻辑整体迁入 `config-draft`，行为和测试保持不变。
- **业务逻辑复用：** `utils.js` 中的业务函数（diff、模板、价格、日志摘要等）按领域拆到 `features/*/lib`，并保持导出兼容，直到所有调用方迁移完毕。
- **工作流规则：** 每页迁移时只做该页面，不修改协议、配置 schema 或后端 API。语义变化（映射、暴露、Key 模式）由渠道计划的对应阶段负责。

## 10. 实施阶段

| 阶段 | 内容 | 依赖 | 退出门槛 |
| --- | --- | --- | --- |
| **U0 基线与验证** | 记录截图基线（1440×900 和 390×844）和包体基线；`react`/`react-dom` 补丁升级到 `^19.2.9`；在分支中安装 Tailwind 4、`@base-ui/react`、`react-router` 8，用真实 Vite 构建测量入口；把 jsdom 初始化抽成共享 helper（`pretendToBeVisual` + 补齐 `window` 全局对象，见 1.3 节），供 [admin-workspace-form.js](test/lib/admin-workspace-form.js)、[admin-runtime-stats.test.js](test/admin-runtime-stats.test.js) 和 [text-cost-observability.test.js](test/text-cost-observability.test.js) 共用；定稿 tokens 和 5.2 节映射表 | 无 | 管理端测试在新初始化下全部通过；在临时目录中的 Vite 构建通过，入口 ≤ 200 KB gzip，否则按 7.3 节改用 Radix 并记录原因 |
| **U1 外壳与路由** | AppShell、侧栏、顶栏状态、告警区、主题（默认跟随系统）、URL 路由和 basename 注入（5.3 节）；旧样式颜色改为 tokens（7.4 节）；旧页面在 `.legacy-page` 中原样挂到新路由；保存坞和分组审阅；抽出 `config-draft` | U0 | 所有旧功能都能从新导航到达；刷新保持页面；自定义 `server.adminPath` 下深链和 API 都可用；旧页面在浅色和深色主题下都可读；保存、冲突和重试测试通过；更新依赖类名的测试选择器 |
| **U2 基础组件 + API Keys** | DataTable、Sheet、MultiSelect、SecretField、StatusPill；Key 表格与 Sheet；模型权限改为多选；旧 Key 显示“全部（旧版未限制）” | U1；“指定为空”依赖渠道计划 P3 | Key 往返无损（隐藏字段、0、脱敏密钥）；失效引用可见、可删；不会把“指定为空”保存为全部授权 |
| **U3 渠道与暴露模型** | 渠道表格与 Sheet；可视/JSON 映射；获取模型预览；暴露模型分组表与批量选择器；Catalog 未匹配清单；Copilot 登录区块 | U2；映射和暴露随渠道计划 P2/P3；Copilot 随 P1 | 与渠道计划 14 节对应用例合并验收 |
| **U4 观测** | 概览、用量（分组切换、可展开渠道）、日志虚拟表格与详情 Sheet、运行状态 | U1；统一型号维度随渠道计划 P4 | 数字与现有 `/api/stats`、`/api/logs` 一致；未知不显示为 0；筛选可深链 |
| **U5 设置、配置中心与工具** | 拆分 Workspace；来源徽标；配置中心；Playground 与诊断；删除旧样式 | U1 | 5.2 节逐项核对通过；`styles.css` 只剩 tokens 和必要全局样式 |
| **U6 打磨（可选）** | 列显示和列宽偏好持久化；浏览器视觉回归（1440×900 和 390×844 截图对比） | U2–U5 | 按需执行 |

U2/U3 的前端工作可以与渠道计划 P1–P3 的后端工作并行。语义尚未落地时，页面先承载现有字段，不提前暴露新开关。

## 11. 验收标准

1. **功能完整：** 5.2 节每一行都能在新界面找到并正常操作。保存往返测试证明隐藏字段、数值 0、脱敏密钥和环境变量管理的值不变。
2. **保存语义不变：** CAS 冲突、`428`/`409`、分阶段应用和重试、待同步保护、历史回滚的现有测试全部通过。即时操作不产生配置 revision。
3. **URL：** 刷新后保留页面、标签、筛选和打开的 Sheet；浏览器后退可用；自定义 `server.adminPath` 下深链可用。
4. **视觉：** 浅色和深色主题都满足 WCAG AA；默认跟随系统，手动选择在刷新后保持。1440×900 下渠道和 Key 列表首屏至少显示 10 行。
5. **窄屏：** 390×844 下没有重叠，除表格容器外没有横向滚动；可以查看概览、运行状态、日志和用量；可以完成启用/停用 Key 或渠道并审阅保存。
6. **语义表达：** 旧 Key 的空授权列表不再显示为 “0”；未知成本、预算和维度都不显示为 0。
7. **i18n：** 中英文字典没有缺失 key，新文案同时加入两种语言。
8. **工程：** `npm run test:unit` 通过，CI 在临时目录编译管理端成功，首屏入口 JS ≤ 200 KB gzip。只有在有意提交管理端变更时，才重新生成 `public/admin-app/`。

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 范围膨胀，长期无法发布 | 按页迁移；旧页面先挂到新外壳；每个阶段都可独立发布。New API 回滚大型重构的例子说明不能一次性切换 |
| 新旧样式冲突 | 旧样式加作用域或 `@layer`；暂缓 preflight；逐页删除旧规则 |
| Sheet 破坏全局草稿语义 | Sheet 只编辑完整副本并整对象写回；增加隐藏字段往返测试；不做自动保存 |
| 即时操作与草稿编辑混淆 | 按 6.2 节区分视觉和文案，并标明作用于已应用配置还是草稿 |
| 测试依赖类名 | 优先使用 role/label；在 U1 集中替换 79 处 `querySelector` 中的类名耦合 |
| 包体增长 | Base UI 的固定开销约为 Radix 的 1.9 倍（外壳组 68.6 KB 对 36.1 KB gzip）。入口预算为 200 KB gzip；页面、非外壳原语、图表、编辑器和价格库都懒加载；字典按语言拆分；超出预算时按 7.3 节改用 Radix |
| 组件原语在 jsdom 中无法渲染 | U0 提供共享测试初始化（1.3 节）；组合框测试先点击再输入；只使用 role 和 label 查询，不依赖库的内部属性 |
| 旧页面在浅色主题下不可读 | U1 把旧样式中的硬编码颜色改为 tokens（7.4 节），并在两种主题下截图核对 |
| React 补丁升级 | 只升到 `^19.2.9`，不升小版本；U0 跑完整管理端测试后再继续 |
| 照搬参考产品的复杂度 | 以 3.4 节“不采用”为边界；一级导航不超过 14 项，单个 Sheet 组件约 600 行以内 |
| 新 UI 隐含了尚未实现的后端语义 | 页面只呈现后端已支持的字段；新语义随渠道计划阶段上线 |

## 13. 已确认决策（2026-11-27）

| # | 问题 | 决策 | 对方案的影响 |
| --- | --- | --- | --- |
| 1 | 默认主题 | **跟随系统**，同时提供浅色和深色手动切换 | 6.1、7.1 节；U1 把旧样式颜色改为 tokens（7.4 节） |
| 2 | 是否引入 Tailwind | **引入 Tailwind CSS 4** | 不再考虑“CSS 变量 + CSS Modules + 无样式原语”的替代方案 |
| 3a | 组件原语 | **Base UI** | 理由：原生多选 Combobox 直接对应 Key 授权和暴露模型选择；两个参考都基于它；测试补丁更少。代价：首屏比 Radix 多约 33 KB gzip。入口预算放宽到 200 KB gzip，超出时回退 Radix（7.3 节） |
| 3b | 路由 | **React Router 8 声明式模式** | 实测最小；需要把 React 补丁升级到 `^19.2.9`；basename 由服务端注入（5.3 节）。没有选择 TanStack Router（JS 项目中优势有限，体积更大）和 React Router 数据模式（不需要 loader 和 `useBlocker`） |
| 4 | 移动端 | **只保证查看和紧急操作** | 不做卡片视图，表格在容器内横向滚动；复杂编辑在窄屏上提示改用宽屏（6.4 节、11 节第 5 条） |
| 5 | 命令面板和 CSV 导出 | **都不需要** | 已从 3.4 节、8.7 节和 U6 中移除 |

## 14. 参考

- New API 前端：<https://github.com/QuantumNous/new-api/tree/81c1fd20efade39a5d5692c8018dfef4cfb30e1d/web>
  - 侧栏：`web/src/hooks/use-sidebar-data.ts`
  - 渠道：`web/src/features/channels/components/channels-columns.tsx`、`channels-table.tsx`、`drawers/channel-mutate-drawer.tsx`
  - Key：`web/src/features/keys/components/api-keys-mutate-drawer.tsx`
  - 选路与授权：`model/channel_cache.go`、`model/ability.go`、`middleware/distributor.go`
- LiteLLM 前端：<https://github.com/BerriAI/litellm/tree/97176d84/litellm/ui/litellm-dashboard>
  - 侧栏：`src/components/LeftNav.tsx`
  - 模型：`src/app/(dashboard)/models-and-endpoints/page.tsx`、`src/components/add_model/AddModelForm.tsx`
  - Key：`src/components/organisms/create_key_button.tsx`
  - 日志：`src/components/logs/detail/LogDetailsDrawer.tsx`、`src/components/logs/detail/RoutingDecisionCard.tsx`
  - 文档：<https://docs.litellm.ai/docs/proxy/model_management>、<https://docs.litellm.ai/docs/proxy/ui_logs>
- 选型文档：Base UI Combobox <https://base-ui.com/react/components/combobox>；React Router 模式对比 <https://reactrouter.com/start/modes> 和 `useBlocker` 的模式支持 <https://reactrouter.com/api/hooks/useBlocker>；Tailwind 4 Vite 安装 <https://tailwindcss.com/docs/installation/using-vite>；shadcn `components.json` <https://ui.shadcn.com/docs/components-json>
- 本项目：[渠道计划](github_copilot_channel_plan.md)、[配置指南](docs/configuration/feature-flags.zh-CN.md)、[测试指南](test/README.md)、[App.jsx](admin-ui/src/App.jsx)、[ui.jsx](admin-ui/src/components/ui.jsx)、[styles.css](admin-ui/src/styles.css)

## 15. 实施状态与验收记录

本轮采用可独立交付的新外壳 + 逐页迁移，不宣称 U0–U5 全部结束。
原有渠道、Copilot 身份与清单 fencing、暴露模型、Harness 资格及配置保存语义继续保留。
用户另行批准两项最小只读 API 扩展：精确 Key 日志筛选和配置字段来源元数据；
没有新增配置 schema 或改变协议转换行为。

| 阶段 | 本轮交付 | 尚未结束的范围 |
| --- | --- | --- |
| U0 | React 补丁与选定组件栈、共享 jsdom 初始化、基线截图、生产编译和入口预算检查 | 无新增基础选型 |
| U1 | 13 个主页面、八个设置子页、响应式侧栏、主题、basename 注入、全局草稿、分组审阅；保存/冲突/重试抽入 `lib/config-draft.jsx` | App 仍协调部分领域加载和旧页面；尚非“仅外壳与路由” |
| U2 | Key 表格、完整副本 Sheet、模型多选、失效引用、指定为空、限额零值、批量状态、用量/日志入口 | 可选列宽/列偏好持久化未做 |
| U3 | 渠道/模型表格、统一型号分组、来源/状态筛选、Sheet 标签、映射可视/JSON 复用、暴露选择器、绑定范围路由/策略、Copilot 状态与引用保护 | 独立 Catalog 未匹配工作清单、完整同步差异展示、复制及单渠道测试结果列仍未完成；部分编辑继续复用原表单 |
| U4 | 概览 KPI/Top 列表、真实 rollup 趋势及空态、用量分组/标签、URL 筛选、虚拟日志与详情抽屉、只读运行状态 | “需要关注”还不是所有渠道凭据/预算信号的统一聚合；未做完整无障碍审计 |
| U5 | 设置搜索/已修改/字段来源、配置历史页内列表与分组 diff、同步/JSON、Playground 双栏、诊断跳转与费用提示 | 旧页面样式已 token 化并放入低优先级 layer，但尚未逐项删除；领域 hooks/工具函数尚未全部拆分 |
| U6 | 桌面/窄屏、深浅主题的本轮浏览器回归 | 列偏好及长期视觉快照门禁未实现 |

实现细节与边界：

- 实际用量分组参数为 `group=canonical` / `group=public`，替代 5.3 节草案中的 `by`。
- Sheet 的应用、取消和关闭分开；关闭/后退保留内存副本，刷新只恢复 URL 位置，不恢复未保存内容。未应用副本会阻止所有配置保存入口。
- Key 日志链接使用 `key`，API 使用 `keyId`。已脱敏/淘汰的身份不可恢复；运维事件视图不支持 Key 筛选。
- 字段来源来自后端明确声明的 `runtime.configuration.fieldMetadata`，不按控件文案猜测，不返回环境变量值。普通控件标“保存 / 重载”，不能把它解释成所有设置均可热更新。
- 主题文字 tokens 的采样对比度检查不是完整 WCAG AA 认证；模拟 API 浏览器验证不证明真实上游、数据库或部署接受度。

验收结果：

- `node --test test/admin-shell.test.js test/admin-runtime-stats.test.js`：38 项通过。
- `npm run test:unit`：913 项，905 通过、8 跳过、0 失败。跳过项为需要可丢弃 PostgreSQL 的门禁；未提供数据库，未运行离线性能门禁或真实上游测试。
- `npm run test:routes`：44 条 mock 路由通过。
- 临时目录 Vite 编译与 `npm run build:admin` 均通过，已更新有意交付的 `public/admin-app/`。
- `npm audit --audit-level=moderate`：0 漏洞。
- 完整入口静态依赖图加当前语言：英文 160,802 B gzip、中文 163,263 B gzip，均低于 200,000 B；15 个 JS 文件与交付产物逐字节一致。路由、图表和 Catalog 的懒加载下载另计。
- Headless Chromium：22 条路径 × 两种宽度（1440 / 390）× 两种主题全部无文档横向溢出；桌面 Key 首屏 12 行，渠道和 Key 均达到至少 10 行。
- 窄屏完成模型权限多选、Key/渠道批量停用、审阅保存，验证保存前仍为草稿及 `If-Match` / CSRF 请求头。
- 深链 Key 日志筛选、设置搜索/只读来源、Sheet 刷新、主题持久化通过；300 条日志只挂载 29 行，末行可达，`j` / `k` 导航通过。
- 语义文字 tokens 采样最小对比度：浅色 4.87:1，深色 8.03:1。

以上浏览器结果使用模拟 API，不修改生产配置；没有自动提交或推送。

### 手动验收反馈后的修复（2026-11-27）

此前逐 URL 加载的检查没有覆盖“切换标签再返回”和实际映射编辑，不能视为完整交互验收。
本轮针对反馈增加失败回归后修复：

- 设置：选中分区直接显示表单，不再复用可能保留关闭状态的旧 `<details>`；
  服务/代理/访问默认值使用各自标题，移除多余的工作区外层标题。
- 渠道：仅保留“新增上游”，先选择 Azure / GitHub Copilot / OpenAI Compatible / Anthropic，
  再进入配置。Copilot 登录和模型发现分区展示，保留既有身份/新鲜度 fencing。
  选项不再来自模型卡厂商列表，旧配置的 provider 和路由不会被静默改写。
- 模型入口：渠道行直接进入“模型与映射”；旧版上游展示真实绑定清单及公开模型编辑链接，
  而不是显示 `0 / 0`；明确映射、发布与 Key 授权是三个不同步骤。
- 编辑布局：去掉 Sheet 中重复的页面/上游卡片嵌套；普通映射、Copilot 和 OpenAI
  清单改成对齐表格，空态和操作说明可见；保留无效 JSON 文本和未知旧映射值。
- 整体检查还修复了隐藏内容被布局规则覆盖、窄屏 KPI 横向排列以及治理子表撑宽页面。
  表格内部可横向滚动，文档本身不靠裁剪掩盖溢出。

浏览器交互覆盖四种渠道创建、模拟 Copilot 登录/选择/审阅保存、旧绑定模型跳转、
两种宽度下各 11 次设置页切换、17 类任务视图的双主题布局，以及中文窄屏导航。
真实 GitHub 授权和上游推理仍需用户账户测试；未宣称全部剩余 UI 迁移或无障碍审计完成。

本轮修复后的验收：

- 相关表单聚焦测试 65 项通过；完整 `test:unit` 915 项，907 通过、8 个数据库门禁跳过。
- `test:routes` 44 条 mock 路由通过；`build:admin` 已更新交付产物。
- 上述浏览器检查在临时构建和最终 Fastify 交付产物上均通过；写操作全部拦截到模拟 API，
  检查了审阅保存的 `If-Match` / CSRF 和不自动发布模型，不写入用户测试配置。
- 入口静态依赖图加当前语言：英文 161,259 B gzip、中文 163,765 B gzip，
  各 15 个 JS 文件，与最终产物逐字节一致，均低于 200,000 B。

### 第二轮反馈：文字居中、渠道模型与 JSON 托底

- “上下居中”指表格文字/控件在单元格内垂直居中，不是整页布局。移除上一轮错误的
  `vertical-align: top`，统一表头/表格单元格居中；移除用量标签导航的下外边距，
  与旁边的分组选择器对齐。
- 渠道模型列表接受手输或选择 Model Card ID。同名部署自动建立等值绑定，无需填写映射；
  自定义部署名称通过“部署 ID → Model Card ID”映射后，目标可一次批量加入渠道模型列表。
  部署名称不受卡片名称限制，渠道模型 ID 和映射目标仍须在 Catalog 中。
  继续使用既有 `modelMappings` / `enabled` 格式，不改请求路由、发布或 Key 权限语义。
- 可解析的旧渠道使用相同编辑界面，首次编辑才升级草稿中的绑定；保留公开 ID、独立路由、
  零价格覆盖和权限。Catalog 预览不可用时保留只读旧绑定，不使用过期事实进行迁移。
- Copilot 保留 Device Flow 与服务端本地凭据存储。`COPILOT_ADMIN_AUTH_REQUIRED`
  是独立的管理端认证前置条件，不是 GitHub 登录失败；新增明确提示、设置链接及管理端
  用户名/密码字段，不移除后端认证保护。
- “设置 → 配置 JSON”与原“配置中心 → JSON”提供完整脱敏配置的托底编辑。
  原文草稿独立保存，切换标签不丢失；明确审阅/确认后整份提交替换，不逐字段合并。
  仅语法解析不宣称配置有效；最终服务端校验、CAS、凭据恢复、环境覆盖和重启要求均保留。
  无效根节点、服务端拒绝和冲突保留输入；待保存 JSON 阻止其他保存入口覆盖它。

最终验证：

- 聚焦表单/绑定/认证测试通过；完整单测 919 项，911 通过、8 个数据库门禁跳过，
  44 条 mock 路由通过。
- Headless Chromium 测量单元格内容中心偏差不超过 3px，桌面用量控件中心偏差不超过 1px；
  1440/390 宽度、双主题通过。中文验收环境补齐 CJK 字体，检查实际中文排版而非缺字方框。
- 浏览器验证同名模型、映射复用/批量加入、JSON 错误/冲突/整份替换与凭据遮罩；
  最终 Fastify 产物再次通过，所有配置写操作均为模拟 API。
- 经用户确认，隔离实例通过独立的本机 600 权限环境文件启用管理认证，原隔离配置内容不变。
  实际未认证配置请求返回 401，已认证 Copilot 状态查询返回 200/idle；没有代用户发起 GitHub 授权。
- 最终入口静态依赖图加当前语言：英文 162,212 B gzip、中文 164,805 B gzip，
  各 15 个 JS 文件与生产产物一致，低于 200,000 B。已重建管理端交付资源。

### 第三轮反馈：用量标签首屏内容与入口去重

- “统一目标型号”改为“目标模型 ID”。上游 ID 与目标 ID 相同可以不手动映射，也允许
  显式同名映射；回归断言两种方式生成相同有效绑定，不重复添加或自动发布模型。
- 实例实测：用量标签会更新 URL/选中状态，但内容被共同概览推到约 1308px，首屏看不出变化。
  现将概览折叠为可展开摘要，筛选器独立可见；选中内容从约 318px 开始展示。
  目标模型分组表归入“模型”标签，趋势图/空态归入“趋势”，选中按钮有明确样式。
- JSON 只保留“设置 → 配置 JSON”入口。配置中心移除 JSON 标签，旧 URL 重定向到设置，
  Harness 的 JSON 跳转同步更新；编辑/覆盖保存流程不变。
- 49 项聚焦测试通过；完整单测 921 项，913 通过、8 个数据库门禁跳过；44 条 mock 路由通过。
  临时构建及最终认证实例的浏览器检查覆盖逐个点击、首屏可见性、目标模型分组、
  Key/时间筛选保留、后退/刷新、窄屏和 JSON 入口去重。检查只读取测试配置，不提交写入。
- 最终入口依赖图加语言 gzip：英文 162,270 B、中文 164,837 B；各 15 个 JS 文件与交付产物一致。
