# AOAI-Proxy 全局加密设计

> 日期：2026-11-27。状态：设计交接，统一加密尚未实现。
> 本轮已按所有者决定移除 Copilot 单点加密，新凭据过渡为私有明文存储；实际全局加密由后续 session 实施。
> 本文不是 GitHub Device Flow 的要求，不代表当前配置、数据库或凭据已经加密。文中的新环境变量、模块和 CLI 均为拟定接口。

## 1. 目标与已确定的边界

1. 用一套部署级密钥管理、密文格式、存储编解码和迁移工具，覆盖所有 provider 的配置与凭据，不再要求 Copilot 独立配置加密。
2. 优先保护完整配置和独立凭据的静态数据，包括文件、PostgreSQL、本地缓存、兼容导出、待同步记录、配置历史及备份。
3. 不改变公开 JSON/SSE、上游认证、模型路由、配置 schema version 3、ETag/CAS、历史保密、凭据批准/撤销或多实例隔离。
4. 普通部署保留显式关闭模式；启用时统一生效，不能只加密一个 provider，也不能因缺少密钥而悄悄回退明文。
5. 密钥由一次性的部署准备提供，不在登录或每次启动时生成。提供明确的初始化工具，避免让用户自行拼接加密参数。
6. 不增加 Redis、独立服务、远程密钥管理依赖或第二套数据库配置；首版使用 Node 内置密码学及现有持久化设施。

全局指配置/凭据领域的统一加密边界，不等于整个磁盘、所有数据库列或所有网络流量加密。TLS、访问控制、脱敏和安全备份仍必需。

### 1.1 本轮过渡状态

- 普通配置仍以明文 JSON/JSONB 保存；管理 API 和历史中的已识别秘密做脱敏。
- Copilot 新记录为 `{format: "plaintext-v1", ref, secrets}`，文件权限、数据库权限和生命周期保护继续存在。
- `COPILOT_CREDENTIAL_KEY_VERSION` / `COPILOT_CREDENTIAL_KEYS` 已不再读取，原加密实现已移除。
- 老 `{ref, envelope}` 不解密、不自动删除、不视为可用 token。对外错误为 `COPILOT_LEGACY_ENCRYPTION_UNSUPPORTED`。
- 老 active 凭据通过相同账号/身份重新授权、准备候选、保存配置及 apply 替换；发布前原记录保持不变。
- 老 prepared 凭据不能被第二次登录覆盖：先解除活动/保存/待同步配置的引用，再显式断开/丢弃后重新授权。
- 任何能读取当前私有凭据存储的账号都能读取明文 token；不能宣称现有 HMAC 批准证明能抵御存储管理员修改 approval key。

此处的格式与行为以 [凭据存储说明](docs/development/copilot-credential-store.md) 和测试为准。下一轮不要恢复 provider 专用密钥或旧专用解密实现。

## 2. 现有代码入口

| 领域 | 实施入口与必须保留的行为 |
| --- | --- |
| 配置加载/保存 | [src/config.js](src/config.js)：先解码再 normalize/validate；环境和 profile 管理值不能被保存覆盖 |
| 文件/数据库/缓存/待同步 | [src/persistence.js](src/persistence.js)：原 CAS baseline、离线 pending、数据库恢复和权威来源规则 |
| 文件替换 | [src/atomic-file.js](src/atomic-file.js)：私有文件、原子替换；迁移还要验证父目录同步和崩溃恢复 |
| 历史及 revision | [src/config-history.js](src/config-history.js)：12 份脱敏历史；revision 来自逻辑配置，而非随机密文 |
| 管理秘密 | [src/admin-config.js](src/admin-config.js)、[src/server.js](src/server.js)：脱敏、恢复 masked 字段、Basic Auth、CSRF、If-Match |
| Copilot 生命周期 | [src/copilot-credentials.js](src/copilot-credentials.js)：prepared/active、generation、credentialVersion、fence、rotating barrier |
| 凭据后端 | [src/copilot-credential-backends.js](src/copilot-credential-backends.js)：本机 SQLite 单写/主库权威读/事务 |
| 凭据记录 | [src/copilot-credential-record.js](src/copilot-credential-record.js)：有界数据与格式校验，不再承担专用加密 |
| 运行态接入 | [src/copilot-storage.js](src/copilot-storage.js)、[src/copilot-runtime.js](src/copilot-runtime.js)：不向浏览器返回 token，不提前激活候选 |
| 部署/文档 | [README.md](README.md)、[Dockerfile](Dockerfile)、[infra/](infra/)、[配置指南](docs/configuration/feature-flags.zh-CN.md) |

先阅读这些入口及对应测试，不根据旧计划中已废止的加密段落恢复实现。

## 3. 总体架构

```text
受保护的部署 keyring
        |
        v
单例 EncryptionContext（启动期固定）
        |
        v
统一 StorageCodec：encode / decode / classify
        |
        +-- 配置文件、DB config_json、兼容导出、本地缓存
        +-- pending-sync、历史 config 快照
        +-- Copilot/未来 provider 的独立凭据载荷

业务层：始终接收已验证明文对象
管理层：业务对象脱敏后才返回；永远不返回 keyring/凭据 secrets
```

建议最少新增：

- `src/encryption.js`：加载/验证 keyring、AES-GCM、统一错误与密文格式。
- `src/storage-codec.js`：存储类型/身份上下文、明文/密文判别、序列化边界。若与前者合并更清晰，可合并，不为抽象而拆文件。
- 一个现有 `scripts/` 下的部署维护入口，提供初始化、检查、迁移、轮换；只在确有独立职责时拆脚本。

不把加密放在 UI、路由转换器或 provider 登录实现。共用的是编码设施，不是把配置、历史、凭据合并成同一生命周期或事务。

## 4. 部署级设置与密钥初始化

### 4.1 拟定启动接口

```dotenv
AOAI_ENCRYPTION_MODE=required
AOAI_ENCRYPTION_KEY_FILE=/run/secrets/aoai-proxy-keyring.json
```

- `MODE` 仅 `off` / `required`，默认 `off` 兼容当前部署。不要增加 per-provider 加密开关。
- `off`：只允许当前明确支持的明文格式，不通过读取密文而隐式启用加密。
- `required`：配置与凭据存储必须使用统一密文格式；正常运行不自动转换遗留明文。
- key 文件是受保护挂载，不放进普通配置、历史、pending、spool、镜像、Git 或与数据一起公开下载的备份。
- 配置及 keyring 路径/模式属于启动期设置；运行中修改返回明确 restart-required 状态。
- 部署方若用 Key Vault 等系统，可将其结果挂载成同一文件接口；首版不额外实现云 SDK。

拟定 keyring：

```json
{
  "version": 1,
  "deploymentId": "<初始化时生成、部署期间固定的非秘密随机标识>",
  "activeKeyId": "k1",
  "keys": {
    "k1": "<canonical base64，解码为32字节随机密钥>"
  }
}
```

约束：版本/ID/数量/文件大小有界；key ID 唯一且不可改名复用；不能给同一 key ID 换不同字节。初始化生成 32 字节安全随机密钥和固定 deploymentId，只创建新文件，绝不覆盖已有 keyring。

### 4.2 用户体验

- 提供一次性 `encryption init` 维护命令（具体脚本名由实现确定），写入指定私有持久路径并只输出路径/非秘密 key ID，不打印密钥。
- 新部署脚本可以显式调用初始化，再部署；应用每次启动、登录按钮及浏览器不得调用它。
- 现有部署必须先备份、迁移，再切 `required` 并重启；不能仅更改环境变量就声称迁移完成。
- 本机 key 文件拒绝符号链接、非当前服务账号所有、宽松权限和不可信可替换路径；容器只读 secret mount 的权限/UID规则需单独验证并文档化。
- file 模式需持久备份 keyring；数据库多实例共享同一 deploymentId 和 keyring，不能各自初始化。
- 丢失密钥无法从 GitHub、配置历史或数据库推导回来。恢复备份或重新配置/授权，不自动生成新 key 顶替。

### 4.3 启动循环依赖

完整配置可能包含数据库连接信息，不能先读取数据库才能得到解密密钥。

1. 从启动环境读取模式、keyring 路径和现有 `CONFIG_PATH`；独立加载 keyring。
2. 解码本地配置/数据库 bootstrap 文件，得到配置存储方式和连接设置。
3. 按既有权威源规则连接 PostgreSQL，解码数据库配置，再做 normalize/validate/apply。
4. 纯 DB 启动若没有 bootstrap 文件，只能使用现有启动环境提供连接信息，不能创建另一个明文配置备份绕过加密。
5. `required` 冷启动缺少/错误 key、未知格式或迁移未完成，在安装任何 provider/runtime 前明确失败。热重载失败保留原可用快照，不能以空配置或本地旧缓存假成功。

## 5. 统一密文合同

采用 AES-256-GCM：32 字节 key、每次新随机 12 字节 nonce、16 字节 authentication tag。使用 Node 内置 crypto，不自行设计密码算法。

拟定 JSON envelope：

```json
{
  "$format": "aoai-proxy.encrypted",
  "version": 1,
  "algorithm": "aes-256-gcm",
  "keyId": "k1",
  "nonce": "<canonical base64>",
  "tag": "<canonical base64>",
  "ciphertext": "<canonical base64>"
}
```

- 先有界读取/验证 envelope，再查 key、认证解密、验证 UTF-8/JSON 与领域 schema。大小限制沿用各领域预算，不把 Copilot 的 32 KiB 上限套到整份配置。
- 对 `$format` 的未知版本、算法、错误长度、非规范 base64、缺字段、坏 tag 明确报错，不能当普通配置继续 normalize。
- AAD 使用稳定规范编码，包含格式/版本/算法/key ID、deploymentId、purpose、逻辑存储身份。
- 配置 root 的逻辑身份必须能在解密前从 bootstrap 确定；不要把明文内部字段作为唯一解密前置条件。
- DB 使用已知 configKey；历史使用 history ID；凭据使用 namespace/channel/principal/profile/reference/purpose/generation/credentialVersion。
- 不用文件绝对路径、数据库密码或随机 ciphertext 作为不可迁移的唯一 AAD 身份；迁移目录/DSN需保持逻辑身份。
- 加密后的 nonce/tag/ciphertext 都只是编码后的密文，不意味着 base64 本身有保密作用。
- 不承诺 JS 内存中不存在明文、root/进程调试者无法读 key、AEAD 能阻止整个数据库/备份回放或磁盘历史被安全擦除。

## 6. 各持久化路径的接入

| 数据 | 加密粒度 | 兼容与原子性要求 |
| --- | --- | --- |
| 本地完整配置 | 整份 normalized 持久化配置一个 envelope | 解码后才进入现有 schema 校验；禁止嵌套重复加密 |
| PostgreSQL `config_json` | 同一 JSONB 列存 envelope | 解密后计算逻辑 revision；原 version CAS 不变 |
| DB 本地缓存/兼容导出 | 同一完整配置 envelope | 不再旁路写明文；逻辑配置相同但 nonce 可不同 |
| pending-sync 文件 | 整个 pending 对象 envelope | 先原子写 pending，再 cache；包含原 baseline，迁移不能推进 baseline |
| 本地/DB 历史 | 每个 entry 的已脱敏 `config` 快照 envelope | ID/revision/apply 等无秘密元数据保持结构，保留 SQL 的历史 apply 更新合同 |
| 独立凭据 | 每个 active/prepared 的 secrets 载荷 envelope | 外层 lifecycle 元数据保留供事务/lease/CAS；读后才可 admit |
| 备份 | 已加密持久数据或统一加密导出 | keyring 另存；旧明文备份仍敏感，不宣称被自动清除 |

### 6.1 配置业务语义

- 管理 API 仍使用明文 JSON 的脱敏形态，浏览器草稿不改成密文编辑器；无密钥的管理员不能通过 API 下载 key。
- 保存先按既有规则恢复 masked 值、保留环境/profile管理值、validate，再编码写入。
- 配置历史先 `redactConfigSecrets`，再加密快照：加密不能成为把历史变成凭据备份的理由。
- ETag/`If-Match` 和 revision hash 基于规范化逻辑配置，不基于随机 envelope；重加密不能制造用户配置变更。
- `ok`、`apply.proxy`、`apply.caddy`、`apply.persistence` 语义保持；编码/存储失败不能返回已持久化成功。
- PostgreSQL 历史操作目前用 `jsonb_array_elements` / `jsonb_set`：不要把整个 history array 盲目改成密文而破坏更新。逐快照加密，读取路径统一解码。
- export 应继续保持既有脱敏合同；若未来新增原始加密备份下载，必须单独授权、明确用途，不默认返回未脱敏明文。

### 6.2 凭据语义

- 共用 keyring，不共用 credentials 与 configuration revision。
- `prepare` 写加密候选后才返回引用；配置发表和 `activateMany` 之间的恢复顺序不变，不宣称跨文件/DB原子事务。
- 每次新推理入场仍读取权威 active；撤销、rotating refresh barrier、deadline/fence/version 都保留。
- `resolveIdentity` 仅支持可信管理身份核对/撤销，不能因能读元数据就绕过对 secrets 的认证解密。
- 加密 AAD 绑定生命周期/凭据版本；激活或刷新变更相关版本时须按新上下文重加密。
- 原 `plaintext-v1` 是迁移来源，不能在 `required` 下作为临时成功回退。
- 旧 Copilot `{ref, envelope}` 不是统一 envelope，也不是明文。只报告需重新授权；不重新引入旧专用解密代码。

### 6.3 日志、runtime-store 与外部系统

首版必须完成配置与凭据闭环，不因“全局”名称扩大成重写全部 observability：

- 凭据/密钥/整份配置永远禁止进入日志、runtime spool、trace、错误 cause、SQL bind tracing 或第三方系统，即使先加密也不允许旁路输出。
- 使用已有脱敏与 log-content 策略，保持管理查询、usage、governance及只读数据库快照合同。
- 用户启用的请求/响应内容、外部 Log Analytics 内容和非秘密统计数据不在首版静态加密承诺中；部署文档必须明确它们可能仍含敏感业务内容。
- 后续若将内容日志纳入范围，复用同一 codec/keyring，对敏感 payload blob 加密并保留查询所需非秘密字段；必须另做索引、分页、spool重放和性能验收，不能先将整个 event JSON 加密而破坏查询。
- 不通过把 keyring交给第三方日志服务来恢复全文检索，不以加密替代日志最小化。

## 7. 迁移、部署与失败恢复

### 7.1 维护工具

拟定维护入口包含：

1. `init`：只初始化不存在的 keyring。
2. `check` / `dry-run`：列出逻辑存储类型、数量、格式/key ID、版本和阻塞项，不输出秘密、明文或 ciphertext。
3. `migrate`：显式把已验证明文转换为统一 envelope。
4. `rotate`：保留 old keys，逐记录按 active key 重加密。

这些操作属于管理员离线维护，不暴露为未经修订保护的普通登录/保存动作。

### 7.2 从当前明文升级

1. 在隔离副本验证工具；备份配置、历史、pending、凭据及 keyring，备份有私有权限及独立保护。
2. 停止所有写者，包括 server、数据库副本实例、后台续期与维护任务。不能在线修改正在打开的 spool/SQLite。
3. 全量扫描：旧 Copilot 密文、未知格式、错误 JSON、未知 config revision/rotation barrier 都是明确阻塞项，禁止悄悄跳过。
4. 旧密文先按本轮规定重新授权替换；必要时保持该连接停用，不清除轮换/撤销元数据来制造成功。
5. 创建独立 keyring并验证。迁移不得改变逻辑配置、key IDs、credentialRefs、grant、generation、credentialVersion、fence或pending baseline。
6. 文件按专用临时路径写入、校验、fsync、原子替换、同步父目录。多文件无法原子提交，需有有界的维护清单/进度、可重入步骤和恢复路径，不能在部分迁移后启动服务。
7. PostgreSQL 获取维护/advisory lock，并在受控事务或明确可恢复批次中迁移。原始逻辑 version CAS不得被绕过；不得与旧实例混跑。
8. 每个结果按原逻辑身份重新认证解密、schema验证并对比逻辑 hash，确认没有明文 config/pending/credential写入路径遗漏。
9. 切 `required`、挂载 keyring并重启所有实例；通过管理保存/重载/rollback、provider fixture与故障测试后再开放流量。

迁移允许离线工具显式读受支持明文，不意味着正常运行允许密文失败后的明文 fallback。部分失败保留源备份和明确进度，禁止自动清空/生成默认配置。

### 7.3 密钥轮换

- 先向每个实例部署含新旧 key 的同一 keyring，再切 active key并重启；新写入用新 key，旧记录仍可认证读取。
- 重加密保持业务 revision、lifecycle counters及reference；若与业务写入竞争，用既有 version/fence条件拒绝陈旧覆盖。
- 轮换覆盖 active、prepared、配置、历史、cache、pending以及需要保留的备份。未完成前不得移除旧 key。
- 接受不同 nonce导致不同 ciphertext，但逻辑 hash和用户 ETag不变。
- 不把加密轮换当作 GitHub应用 ID变更或账号重新授权，不让纯存储轮换触发网络 token refresh。

### 7.4 回退与错误合同

- `off` 不能直接读取已迁移密文；旧二进制也不能理解统一 envelope。回退必须停止写者并使用已验证的独立备份/显式维护转换，不自动解密到普通目录。
- 拟定稳定错误：`ENCRYPTION_KEY_UNAVAILABLE`、`ENCRYPTION_FORMAT_UNSUPPORTED`、`ENCRYPTION_AUTH_FAILED`、`ENCRYPTION_MIGRATION_REQUIRED`、`ENCRYPTION_MODE_MISMATCH`、`ENCRYPTION_RESTART_REQUIRED`。
- 只有配置/输入冲突用既有409/4xx合同；加载或存储不可用按既有503及启动错误路径。错误只带 code、非秘密逻辑目标和必要阶段，不带底层payload/密钥/cause。
- 热加载失败不得改变 active config、缓存、数据库 baseline或凭据版本。cold `required`不能安装不完整配置。
- ciphertext/旧备份整体回放、恶意存储管理员、失去密钥等限制要文档化；AEAD不提供跨存储防回滚或绝对安全删除。

## 8. 实施拆分与验收

### P0：全局基础与纯 codec

- 实现单一 keyring、明确模式、统一 envelope、AAD和固定错误；部署 init只生成一次，拒绝覆盖。
- 聚焦测试：往返、错误/缺失key、未知版本、非规范编码、坏tag、上下文/不同部署替换、大小边界；不只断言常量。
- 冻结无密钥/off的现有明文行为，确保没有 provider 专用分支。

### P1：完整配置持久化与迁移

- 接入 file/DB/cache/export/pending/history全部路径，不改公开配置 schema。
- 验证 bootstrap、环境覆盖、profile限制、If-Match/ETag、保存/重载/rollback、历史apply更新、DB离线pending和拒绝陈旧同步。
- 加入文件多步骤崩溃恢复、DB迁移拒绝并发写者、重复迁移幂等和keyring独立恢复。

### P2：独立凭据及部署闭环

- Copilot和未来provider共用codec；保留metadata-only身份/撤销与准入区分。
- 冻结prepared/active、同账号重授权、legacy refusal、批量激活事务、30并发刷新、late401、lease/fence、rotating crash barrier及断开竞争。
- 更新 sample/配置指南/部署模板/README；环境设置是启动期，不直接写普通配置。只有实际需要UI修改时才构建admin资产。
- 在新部署与现有部署分别演练init/migrate/required启动/轮换/恢复；不得复用开发固定key。

### 执行命令

先用已有focused套件并按需要增加对应行为测试，例如：

```bash
node --test test/copilot-credentials.test.js test/copilot-provider.test.js
node --test test/config-environment.test.js test/config-history.test.js
npm run test:unit
npm run test:routes
```

实现前确认现有配置持久化/历史/并发套件的准确文件名，组合最窄selector，不凭本文例子创建重复套件。

数据库、多实例和性能验收只使用 `RUNTIME_MEDIA_TEST_DATABASE_URL` 指向的可销毁loopback PostgreSQL。记录未运行门禁；mock不证明真实GitHub授权、账单或延迟。

### 完成标准

- `required` 下所有配置/凭据持久化副本都无秘密明文，且真实读取、重启、保存、重载、rollback、断开和恢复可工作。
- 用户只准备一套全局keyring；Copilot登录没有专用加密参数、fallback key或独立加密开关。
- 加密失败/未知格式/旧密文没有成功形fallback，没有破坏原数据、CAS基线或当前有效快照。
- 轮换不改变用户修订和渠道生命周期，也不使过期/已撤销凭据复活。
- 文档明确当前模式、保护范围、外部内容日志边界、部署步骤和恢复限制。
- 最后提交仍遵守 `aoai-nextgen` 工作流；不包含密钥、运行态配置、迁移副本或无关admin构建产物。

## 9. 下一轮 session 起点

先确认本轮变更是否已提交、查看 `git status --short --branch`，阅读本文第1节和实际记录格式；不要直接运行初始化/迁移去修改正在运行的实例。

优先落实 P0/P1 后再迁移凭据，不以再次加一个 Copilot AES helper当作完成“全局加密”。本轮没有重启手动实例、生成真实密钥或调用GitHub；后续需要实际部署验证时另行确认操作范围。
