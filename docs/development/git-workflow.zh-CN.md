# 多设备多分支协作指南

本文档说明在多个设备、多个分支之间切换时，如何确保 AOAI-Proxy 的目录结构和文件内容始终是最新的，并避免“分支切换成功但工作区还是旧内容”的情况。

## 目标

- 在不同设备上看到一致的分支状态
- 切换分支后，工作区目录和文件内容与目标提交一致
- 降低误操作概率，尤其是本地分支名、tracking 关系和未提交改动带来的混乱

## 先记住这三个原则

1. 每次开始工作前，先 `fetch`，再确认分支，再 `pull --ff-only`。
2. 本地分支名不要带 `origin/` 前缀；`origin/*` 只能代表远端跟踪分支，不应该作为你自己的本地开发分支名。
3. 切分支前先处理未提交改动；否则 Git 可能保留当前工作区文件，导致你误以为切换后的内容不完整。

## 当前主线与 Profile 策略

- `aoai-nextgen` 是唯一长期代码基线。
- 原 `minimum` 范围由同一代码基线上的 `distribution.profile=minimum` 或 `AOAI_PROXY_PROFILE=minimum` 表达，不再通过长期分支删减源码。
- `minimum` 与 `nextgen` 共用协议、路由、测试、镜像以及支持远程更新的 Model Catalog；minimum 只关闭外围管理、数据库 runtime store、预算和 Log Analytics。
- 旧 minimum 分支只用于历史审计。验证 Profile 后应先为旧 tip 建归档 tag，再冻结或删除远端分支；不要把旧分支硬合并回主线。

## 推荐命令

下面这组命令是日常最稳妥的做法。

### 1. 在任意设备上开始工作前

```bash
git fetch origin --prune
git status -sb
git branch -vv
```

看这三个点：

- 当前在哪个本地分支
- 当前分支是否跟踪了正确的远端分支
- 当前分支是否落后于远端

### 2. 切到目标分支

如果本地分支已经存在：

```bash
git switch aoai-nextgen
```

如果本地还没有这个分支，但远端已经有：

```bash
git switch -c aoai-nextgen --track origin/aoai-nextgen
```

不要这样做：

```bash
git checkout -b origin/aoai-nextgen origin/aoai-nextgen
```

这会创建一个名字就叫 `origin/aoai-nextgen` 的本地分支。它看起来像远端分支，但其实是一个普通本地分支，后续很容易和真正的 `origin/aoai-nextgen` 混淆。

### 3. 拉到最新

```bash
git pull --ff-only
```

使用 `--ff-only` 的原因：

- 只接受快进更新
- 避免你在不知情时产生额外 merge commit
- 如果历史分叉，Git 会直接报错，提醒你先处理分支关系

### 4. 最后确认工作区确实是最新内容

```bash
git status -sb
git rev-parse --short HEAD
git log --oneline --decorate -n 3
```

如果你要和远端对比，再看一次：

```bash
git rev-parse --short origin/aoai-nextgen
```

只要本地 `HEAD` 和远端分支提交一致，目录结构和文件内容就应该一致。

## 多设备协作的标准流程

### 场景 A：你在设备 A 上刚做完修改，准备换到设备 B

在设备 A 上：

1. `git status -sb` 确认改动范围
2. 提交本地改动
3. `git push origin <branch>`

在设备 B 上：

1. `git fetch origin --prune`
2. `git switch <branch>`
3. `git pull --ff-only`
4. 用 `git status -sb` 和 `git rev-parse --short HEAD` 确认已同步

核心原则：设备之间同步靠远端仓库，不靠记忆，也不靠“我觉得刚才已经切过分支了”。

### 场景 B：你在设备 A 上还有未提交改动，但想去设备 B 继续

优先顺序：

1. 最好先提交一个小 commit，再 push
2. 如果还不想提交，可以临时 `git stash push -u`
3. 不建议把“只存在某一台机器上的未提交改动”当成协作状态

原因很简单：未提交改动不会自动同步到另一台设备，而且还会干扰分支切换时的文件状态判断。

## 多分支协作的标准流程

### 一条分支只做一类工作

建议：

- `master` 保持稳定可发布
- `aoai-nextgen` 做主线功能开发
- 临时修复或实验功能使用单独 feature branch

不要在一个分支里混做多个主题，否则你很难判断哪些内容应该跟着切换、哪些只是当前实验状态。

### 切换分支前先清空工作区噪音

```bash
git status
```

如果不是干净工作区，先做其中一个：

- 提交
- `git stash push -u`
- 明确放弃你自己刚产生且确认不要的改动

只要带着未提交改动切到另一个分支，就有可能出现：

- 某些文件被保留
- 某些文件无法覆盖
- 你以为分支没切对，实际上是工作区被本地改动污染

### 高频切分支时，优先用独立工作目录

如果你经常在同一台设备同时维护多个分支，建议使用两种方式之一：

1. 每个长期分支一个独立 clone 目录
2. 使用 `git worktree`

例如：

```bash
git worktree add ../AOAI-Proxy-master master
git worktree add ../AOAI-Proxy-nextgen aoai-nextgen
```

这样每个目录固定对应一个分支，避免来回切换时误判“为什么文件结构突然不一样”。

## 推荐日常检查清单

每天开始工作前，执行：

```bash
git fetch origin --prune
git status -sb
git branch -vv
```

切分支后，执行：

```bash
git pull --ff-only
git rev-parse --short HEAD
git log --oneline --decorate -n 3
```

准备切设备前，执行：

```bash
git status -sb
git push origin <branch>
```

## 出现“分支切成功了，但内容不是最新的”时怎么排查

按这个顺序查，最快。

### 1. 先看当前到底在哪个分支

```bash
git branch --show-current
git status -sb
```

如果显示的是奇怪的本地分支名，例如 `origin/aoai-nextgen`，先停下来，因为这通常说明你之前把远端分支名误当成本地分支名创建了。

### 2. 看本地分支是否真的在跟踪远端

```bash
git branch -vv
```

正常情况应该像这样：

```bash
aoai-nextgen 2d78b83 [origin/aoai-nextgen] ...
```

如果没有 `[origin/aoai-nextgen]` 这类 tracking 信息，说明本地分支没有正确关联远端。

### 3. 先更新远端引用

```bash
git fetch origin --prune
```

不先 `fetch`，你看到的远端状态可能本身就是旧的。

### 4. 比较本地 HEAD 和远端提交

```bash
git rev-parse --short HEAD
git rev-parse --short origin/aoai-nextgen
```

如果两个提交不同，本地当然不是最新。

### 5. 用快进方式拉齐

```bash
git pull --ff-only
```

### 6. 如果本地分支名本身就错了，修正它

例如你误建了本地分支 `origin/aoai-nextgen`，可以这样修正：

```bash
git branch -m aoai-nextgen
git branch --set-upstream-to=origin/aoai-nextgen aoai-nextgen
git pull --ff-only
```

## 建议固定下来的操作习惯

- 只用 `git switch` 切分支，不再混用旧的 `git checkout` 语法
- 每次开始工作先 `git fetch origin --prune`
- 每次切到开发分支后立刻 `git pull --ff-only`
- 每次换设备前先 push
- 高频多分支开发尽量使用独立目录或 `git worktree`
- 定期看 `git branch -vv`，确认 tracking 关系没有跑偏

## 一个最小可执行流程

如果你只想记最少的命令，就记下面这套：

```bash
git fetch origin --prune
git switch aoai-nextgen || git switch -c aoai-nextgen --track origin/aoai-nextgen
git pull --ff-only
git status -sb
git rev-parse --short HEAD
```

这套流程可以覆盖绝大多数“多设备 + 多分支”场景，也能最大程度避免目录结构和文件内容停留在旧提交上。