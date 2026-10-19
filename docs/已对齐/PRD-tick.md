# PRD · Tick 置顶 Todo 工作台（AI Session）

| 字段    | 内容                                                        |
| ----- | --------------------------------------------------------- |
| 状态    | v0.3 修订中                                                   |
| 版本    | v0.3                                                      |
| 日期    | 2026-10-16                                                |
| 平台    | macOS 优先（Electron）                                         |
| 会话执行层 | AI agent 工具（首期对接 **pi**；后续经 adapter 扩展）；CLI 拉起走 TUI spawn，面板走 **pi-durable**（D13） |
| 原则    | 上层产品我们定义；不违背 pi 的 session / provider / 消息与工具语义              |
| 首版范围  | 本地 Todo + 项目索引 + 拉起 pi（直接投递首条消息）+ 面板对话 + 多会话绑定            |
| 已移除   | **飞书日历相关全部能力（OAuth / 拉日程 / 点选建 todo / 写回）本版不做**          |
| 数据根   | `~/.ticktodo`（会话与数据；**不含任何凭据**——Key 只进系统钥匙串，M3+ 自配 provider 也不进这里）              |

> 本版决策依据与实测事实见 `REVIEW-tick-v0.3.md`（pi 1.2.0 本机核实：会话目录结构、CLI flags、扩展 API）。
> **pi 官方规范实证见 `RESEARCH-pi.md`**（会话格式 / usage 口径 / fork / SDK），
> 本文档涉及 pi 的事实以它为准。
> 多工具会话处理的同行参考见 `RESEARCH-magpie.md`（magpie：60+ agent 接入、16 套会话读取器实证）。

---

## 1. 背景与问题

### 1.1 现状痛点

1. **事后找回难（首要痛点）**：多个 AI 会话并存时只能靠标题/时间猜测对应哪次任务。本机实测已有 **134 个 pi session**、分布在 **9 个项目目录**下——靠人肉定位不现实。
2. **任务与会话割裂**：Todo、项目目录、AI 会话分属不同界面，缺少「选中任务 → 立刻开/回某个会话」的闭环。
3. **开工有摩擦**：换到 AI 工具后要重新交代背景（标题、描述、目录），目录还要自己想。
4. **项目上下文要重建**：做过哪些项目、上次在哪干，全靠记忆——而 pi 的会话目录里其实已经存着这些信息。

### 1.2 机会

把 Todo 做成 **AI 会话的索引层**：

- 从 pi 的 `~/.pi/agent/sessions/` 反推"我做过哪些项目"（每个 session 的 header 里有权威 `cwd`）；
- 一条 todo 可创建/绑定**多个**会话，事后按 todo 直接跳回；
- 拉起 pi 时把任务文案**预填进 pi 输入框**（默认，可审阅，用户回车才发）；设置里可切成 `pi "<文案>"` 直接发送
  ——源码确认那样是**立即发送**（`interactive-mode.js:894` 直接 `session.prompt()`）；预填由 tick-extension 的 `ctx.ui.setEditorText()` 完成；
- **项目（cwd）选填**：系统按「已绑定会话的 cwd → 该 todo 上次用过的目录 → **home（`~`）**」推导默认值，
  用户想换再打开选择器；**默认值不猜**——没有记录时就是主目录，不拿\"最近使用\"去猜用户想去哪；
- 拉起时顺带 `--name <todo 标题>`，让 pi 自己的 session 列表也能读懂；
- `create_todo` 做成 pi 扩展，用户在 pi 里、在面板里用的是同一套工具。

---

## 2. 目标与非目标

### 2.1 目标（首版）

| ID  | 目标                         | 度量                                       |
| --- | -------------------------- | ---------------------------------------- |
| G1  | 从 Todo 到 pi 开始干活，路径最短且可控    | **≤ 2 次点击 + ≤ 5 秒**；默认**预填投递**（可审阅），设置里可切换为**直接发送** |
| G2  | 一个 todo 可绑多个 session，事后能跳回 | **找回一个上周会话 ≤ 10 秒 / ≤ 3 次点击**（硬指标）        |
| G3  | 项目（cwd）**选填**：不点也能直接执行        | 免选路径下 cwd 与按钮上显示的项目名一致；**无记录时默认主目录 ~**，不做猜测     |
| G4  | 在 pi 里、在面板里都能建 todo         | `create_todo` 一份实现，两处可用                   |
| G5  | 置顶悬浮、默认轻量                  | 默认展示 5 条，可展开                             |
| G6  | 不违背 pi 定义                  | 只用 pi 既有 flag 与扩展 API，不自造并行协议             |

### 2.2 非目标（首版不做）

- **飞书日历全部能力**（OAuth / 拉日程 / 点选建 todo / 写回）—— 本版整体移除
- 除 pi 以外的 AI 工具实现（架构预留 `packages/ai/<tool>`）
- 自动双向同步 CLI 会话与面板会话（两者命名空间隔离）
- 内嵌模型 Gateway / 改写各 Agent 全局配置——**"自配 provider"不违反此条**：
  Gateway = 服务多个 agent 的转发层；自配 = Tick 这一个客户端填 endpoint/key 直连上游，方向相反
- 自研业务 CLI；`install.sh` 仅作安装通道
- Windows / Linux（P3）

---

## 3. 用户与场景

日常用 AI 工具干活的个人开发者 / 知识工作者，同时跑多个项目、多个会话。

| 场景              | 流程摘要                                                     |
| --------------- | -------------------------------------------------------- |
| S1 从项目开工        | 选 todo → 直接点「在 **<项目名>** 中打开 pi」（默认主目录，或展开选择器改）→ 文案预填进 pi 输入框 → 回车发送 |
| S2 跳回旧会话        | 打开已绑定 todo → 展开会话列表 → 选一个（默认最近使用）→ `pi --session <id>`  |
| S3 手动建 todo     | 快捷键/面板新建 → 标题必填、内容选填 → 可选再绑 AI                          |
| S4 对话建 todo     | pi 里或面板 Chat 里 → 模型调 `create_todo` → 两边列表都刷新             |
| S5 反向建索引（**首版做**）  | 浏览本机**未绑定**的历史 pi 会话 → 选中一条 → 生成 todo 并绑定（零成本获得"可找回"能力），详解见下 |
| S6 完成           | 勾选完成 → 仅改本地状态；**绑定的 session 保留不清空**                     |

#### S5 反向建索引：具体是什么场景

**一句话**：不是"先建 todo 再开会话"（S1），而是**反过来看本机已经存在的 pi 会话，把其中有用的登记成 todo**。

三个真实触发点：

| # | 场景 | 用户心里在想什么 | 没有 S5 时怎么办 |
|---|---|---|---|
| 1 | **首次启动 / 空态** | "我装了 Tick，但列表是空的，我现有的 100 多个会话呢？" | 只能自己一条条新建 todo，等于要重新登记一遍已经存在的工作 |
| 2 | **事后找回**（核心） | "上周三在 `tick` 项目里调过 pi，当时没建 todo，现在想继续" | 只能 `pi -r` 在终端翻列表，靠标题/首条消息猜是哪一条 |
| 3 | **补登记** | "这个会话还在跑，我该把它记成一件待办" | 手动复制标题去新建 todo，再手动绑 session |

**数据源**（已具备，零新增成本）：`adapter.listSessions()` 返回的会话里，
`sessionId` 不在任何 `Todo.bindings[]` 中的那些，就是"未绑定会话"。
本机实测 **103 个有效会话 / 9 个项目**，第一次打开就是满的。

**交互形态**：

```
「从历史会话反向建」
└── 按项目分组（最近使用降序，默认只显示近 30 天）
    ├── tick                                    2 条
    │   └── 2026-10-15 · <session 名或首条消息前 40 字> · 12 条消息
    └── Desktop/pi                             44 条
        └── …
```

- 每条给两个动作：**「建 todo 并绑定」** / **「直接 resume（不建 todo）」**
- 标题默认取 session 名 → 首条 user 消息前 40 字 → 兜底「未命名会话」，**可编辑**
  （首条消息要走 name fallback 链过滤 `<…>` / `# AGENTS.md` / 图片占位）
- **不做批量自动生成**：103 条一下全变成 todo 是灾难。只做**手动挑选**，
  一次点一条。这是"索引"而不是"导入"

**为什么它重要**：移除飞书后，S1（从日历开工）没了，首版剩下的都是"你已经知道要干什么"的场景。
S5 是唯一一个**打开就能产生价值**的入口——不要求用户先建 todo，就能找回旧的会话。

---

## 4. 产品范围

### F1 悬浮 Todo 面板

- Electron 无边框置顶窗；位置记忆
- 默认展示 **5** 条 open todo，可展开/滚动
- 全局快捷键：显隐面板、新建 todo
- 条目：标题、可选摘要、完成态、**已绑会话数徽标**

### F2 Todo 模型与编辑

| 字段    | 规则                                               |
| ----- | ------------------------------------------------ |
| 标题    | **必填**                                           |
| 内容/描述 | **选填**                                           |
| 状态    | `open` / `done`；完成只改状态                           |
| 会话绑定  | **1:N**：`primarySessionId` 指向默认 resume 的那个；详见 §7 |
| 上次启动  | **选填**：`lastLaunch { toolId, projectPath }`，用户显式选过一次后记住（F4-a 优先级 2）；工具与目录一体记，非 session 镜像 |

### F3 项目索引（cwd 推导）

- 扫 `~/.pi/agent/sessions/` 的一级目录 → 反解候选路径 → **用 session 首行 header 的 `cwd` 校验**
  （源码 `session-manager.js:293`：`--${cwd.replace(/^[/\\]/,"").replace(/[/\\:]/g,"-")}--`，有损且 `:`/`-` 同形）
- **pi 不做 git 根归并**（一个 cwd 一个目录）→ 是否按 git 根归并是**我们的产品决定**
- 归一化：`~`、symlink、`/private/var` 等
- 目录已不存在 → 标 `stale`，默认隐藏
- 排序：最近使用降序（只影响列表顺序，**不参与默认 cwd 推导**，见 F4-a）；缓存 `~/.ticktodo/cache/projects.json`
- **只读每个 session 的首行 header，不索引对话正文**
- **路径可被覆盖，不能硬扫**：`$PI_CODING_AGENT_DIR`、`$PI_CODING_AGENT_SESSION_DIR`、
  `settings.json` 的 `sessionDir` 都可能改掉位置（后者还是"所有 session 平铺一个目录"的形态）
- **stale 不该只是隐藏**：目录改名/移动后，历史会话会留在旧路径下"失联"。
  提供**重新定位**——选新目录后只做映射，**不移动 agent 自己的文件**（我们只读不动）
- 兜底：pi 目录不可用 → 退化到"手动添加本地目录"

**多工具下的层级（第二个 AI 工具接入时）**：项目是**工具无关**的概念——
同一个目录被 pi 和别的工具都用过时，用户心里那是一个项目，列表里也只该有一条。
所以：

- 主键是**目录（canonical 路径）**，工具只是这条记录上的**证据标签**（`tools: ["pi","claude"]`）；
- 各 adapter 只吐"原始 cwd + 会话数 + 最近使用"，**归并、上卷、排序统一在 core 做**（详见架构 §6.1）；
- 排序以 **Tick 自己的拉起记录**为准（跨工具唯一可对齐的时钟），工具侧时间只作回退；
- git 根上卷默认开（同仓库多子目录收敛成一条），但保留原始 cwd 可选。
  → 因此第二个工具接入时，只新增一个 adapter，项目列表与 UI 不动。

### F4 AI 拉起（首版 pi；多工具后含 WorkBuddy AI prefill）

- AiPicker 三个字段中只有**工具**是必选的（首版 pi；两个 WorkBuddy 均以 prefill 形式打开新建页）；
  **项目选填**（默认已推导好，可改 / 可添加本地目录）；新建或已有 session 也给出默认值
- **可以完全跳过项目选择**（见 F4-a）：主按钮直接带默认项目名，想改再展开选择器
- 投递：**默认预填**（文案进 pi 输入框 + 提示「已预填，确认后回车发送」，用户可审阅）；
  设置项可切换为 **argv 直接发送**（`pi "<文案>"` 启动即发，省掉回车）。预填由 tick-extension 在
  `session_start` 调 `ctx.ui.setEditorText()` 完成（文案走一次性文件，不进 argv）
- 拉起参数：`--session-id <预生成 UUID>`、`--name <todo 标题>`、进程 `cwd` = 选中项目
- 会话元数据与面板 Agent session **分 ID 存储**，禁止混用
- launch 后由 adapter 校验 session 是否真的产生；失败标 `unverified` 并提示（防僵尸绑定）

### F4-a 项目选填：免选直接执行

**决策**：项目是**选填项**——与「内容/描述选填」同级，不是必填。
但要注意一个事实区分：**cwd 本身从来不是可选的**（pi 没有 `--cwd`，进程一定有工作目录），
所以"选填"指的是**用户不必做选择这个动作**，系统必须自己给出一个确定的 cwd。

默认值推导优先级（自上而下取第一个命中的）：

| 序 | 来源 | 说明 |
|----|------|------|
| 1 | 该 todo 已绑定 session 的 cwd | resume 场景天然免选：cwd 由 adapter 从该 session 读出，不需 Tick 镜像 |
| 2 | 该 todo **上次用的工具 + 目录** | 用户显式选过一次后记住（`Todo.lastLaunch`），避免每次都退回全局默认 |
| 3 | **home（`~`，用户主目录）** | **默认兜底，不做猜测**（D18）。pi 本身也支持：本机 `--Users-jacky--` 下已有 12 个 session |
| 4 | 设置项「默认项目」改成 **最近使用** | 想要"猜一个"的人自己开；「每次必问」则关掉免选 |

> home **不参与 git 根上卷**（`~` 不是"项目"，不向上找 `.git`），在项目列表里作为**固定首项**出现，
> 不参与按 `lastUsedAt` 的排序竞争——否则它会被排到中间，用户找不到"无归属"这个选项。

> **为什么第 3 顺位定为 home 而不是\"最近使用\"**：最近使用是**猜测**，猜错时用户不知道自己跑在哪个目录
> （即便按钮显示了名字，用户也没预期它会变）；home 是**确定的兜底**，用户一眼知道"我没选，所以在主目录"。
> 本机实测 103 个会话里只有 12 条在 home（11.6%）——即 home 多数时候不是用户想要的目录，
> 但"明确地不是"好过"自以为猜对了"。真要猜的人可以在设置里开。

- UI：主按钮**必须带项目名**，例如「在 **tick** 中打开 pi」；兜底为 home 时显示「在 **主目录 ~** 中打开 pi」，
  不能只写"打开 pi"——**可以免选，不可以隐式**；旁边一个「改」入口 → 默认零点击，选择权不丢
- 面板 Chat 同理：默认 home 的 cwd，可切换
- 「添加本地目录」是选填里的选填：只在用户主动打开选择器时出现，不进主路径

**风险（D18 后重新评估）**：默认值不再靠猜，"猜错"这个风险消失了。
但 home 依然是一个**真实的目录**——AI 会在用户主目录里读写文件，且 pi 会 `mkdirSync`
凭空造出 `--Users-jacky--` 下的 session 目录（本机已有 12 条，说明确实会发生）。
所以护栏一条都不能减，第 1 条反而更关键：用户必须一眼看出自己在主目录下。
四条对策：

1. 按钮上永远显示项目名（**默认值必须可见，不能隐式**）；
2. 默认预填投递，让用户还有一次人工审阅机会（与默认 B 是互补的，两者叠加才安全）；
3. 记忆的目录若已 stale（不存在）→ 自动退回**主目录 ~**并提示（D18 口径，不猜"最近可用"）；
4. 优先级 1、2 命中时按钮不冒出兜底痕迹（不会突然显示「主目录 ~」），避免用户误以为是自己选的。

**连带影响（D18 后重新评估）**：默认兜底改成 home 之后，F3 项目索引**不再决定默认值**，
于是它的定位从"主路径地基"回落为两件事：① 选择器与 S5 的数据源；② 手动选择时的候选列表。
好处是**猜错的风险消失了**（默认值不再依赖 `lastUsedAt` 排序与 git 根归并的准确度），
`lastUsedAt` 排序准确性降级为"列表顺序好不好用"，**Q7 因此不再需要升 P1，按\"先不做\"结案**。

### F4-b 设置项（首版只两个开关）

> 2026-10-19 追加：新建会话页底部还可临时勾选「直接发送」，只影响本次拉起、不回写设置；默认投递为 prefill。

| 设置项 | 默认 | 选项 | 说明 |
| --- | --- | --- | --- |
| 拉起时的投递方式 | **预填 pi 输入框**（B） | 预填 / 直接发送 | 直接发送 = `pi "<文案>"` 启动即发；预填 = 扩展 `ctx.ui.setEditorText()` 填输入框、用户回车才发 |
| 默认项目 | **主目录 ~**（不猜） | 主目录 / 最近使用 / **每次必问** | 三态一个开关：想让系统猜就选"最近使用"；不信任默认值就选"每次必问"（回到强制选择） |

> 仍是**两个开关**——"每次必问"并进"默认项目"的三态，没有新增设置项。

其余（快捷键、窗口位置、开机启动等）属 M3，不进首版；**用量统计开关（F6-b）随 M3 引入**，默认关。

### F5 对话与 `create_todo`

- `create_todo`（及 `list_todos`）写成 **pi extension**（`defineTool`），一份实现两处加载：
  - CLI 会话：**安装到 `~/.pi/agent/extensions/`**（pi 的自动发现目录，默认启用，不必 `-e`；备选 `pi install <path>`）
  - 面板 Chat：加载同一份扩展实现（执行层 pi-durable；扩展注入方式 M2 安装 durable 后按官方文档落实，SDK 的 `resourceLoader` 仅为备选链路参考）
- 写操作**标为非 safe 重跑**，带幂等键防重复建单
- CLI 与面板写同一份 `todos.json` → 原子写 + 文件锁 + `fs.watch` 刷新

**面板执行层 = `pi-durable`（D13 定案，见 `RESEARCH-pi.md` §5）**：

- 落盘：`openNodeJsonlStorage("~/.ticktodo/sessions/panel-chat/…")`
- 白拿的能力（原先要自己写）：
  - `harness.resume()` → 崩溃/重启后接着没跑完的 run，长会话生命周期不用自己管
  - `requestId` 幂等 → 重复提交不重复建单，正好配合 `create_todo`
  - `pi.provider` document → 每个会话一个持久 UUIDv7，转发给 pi-ai 做 prompt-cache 亲和
- **两条硬约束**：
  1. **必须 pin 版本 1.3.0** —— README 首行就是 "Experimental. The API changes without notice
     between releases."，不能跟 latest
  2. **Node ≥ 22.19.0**（durable 的 `engines`），Electron 版本要满足
- 本机尚未安装，M2 需装 `@earendil-works/pi-durable@1.3.0`（+ `pi-ai`、`chord`）
- pi SDK（`createAgentSession`）降为备选；CLI 拉起仍走 spawn TUI，不受影响

#### 凭据：**双来源——默认复用 pi，可选自配；Key 只进系统钥匙串**

**来源 1（默认，零配置）：pi 本体**

- 面板 Chat 走 pi 的 provider 凭据（`ExtensionContext.modelRegistry` 做 key 解析 / `pi auth check` 探测就绪）
- 首屏前跑一次 `pi auth check --provider <默认 provider> --json`；未就绪 → 引导用户到 pi 完成登录
  （实测本机默认 provider 当前为 `invalid`，本机实证见 `RESEARCH-pi.md`，所以这个检查不是可选项）
- 好处：pi 用户零配置接入、Key 生命周期与 pi 一致

**来源 2（自配，M3+ 实施、首版只留架构位）：Tick 直连 provider**

- **内置 pi-ai** 本来就是事实（`pi-durable` 依赖链自带，随 Tick 的 package.json 走，不随用户装没装 pi）——
  需要新增的只是**凭据自配**：设置里填 provider（支持 OpenAI 兼容自定义 endpoint + Key + 模型名），
  即可**不依赖 pi 本体**使用面板 Chat
- 这同时是**任何 OpenAI 兼容网关 / API 代理（本地或远程）**的接入点：填进自定义 endpoint 即可经其调用——
  **Tick 只做好自身能力、遵循业界标准协议，不为任何具名应用写专门插件**
  （对接规范是对接方定的，我们说标准话就能被接）
- **Key 存储 = 系统钥匙串**（Electron `safeStorage`）：**永不进 `~/.ticktodo/data/`**
  （避免那层被 dotfiles/网盘同步走）——原则由「不持任何 Key」修订为
  「**Key 只进钥匙串，不进同步层**」
- 首版范围控制：provider 配置 UI + safeStorage + 连接测试 + 模型列表不是首版工作量，
  排 **M3+**；首版只实现来源 1，架构上把「凭据来源」做成可插拔（`CredentialSource`），
  来源 2 与未来逐工具凭据共用这个口子

**Q14（修订）：pi 未安装 / 未就绪时**

- 手动 Todo、添加本地目录、导出（F8）**照常可用**——这些不依赖 pi；
- 面板 Chat：来源 1 不可用 → 引导空态「未检测到 pi，安装登录或自行配置 provider」——
  **降级空态保留，但从"死路"变成"双出口"**（去装 pi，或去自配）；
- CLI 拉起、项目索引 / S5 **随之不可用**——它们硬依赖 pi 的会话目录，没有可读对象，
  这与凭据无关，自配也解不了；
- 定位澄清：首版主用户是**已经在用 pi 的人**；自配 provider 让"还没装 pi 的人"能把 Tick
  当轻量对话+Todo 工具用起来（会话只在 panel-chat、无 CLI 索引、无用量——预期在空态写清楚）；
- 未来多工具（F6）：凭据**逐工具复用**，每个 adapter 声明自己的就绪探测
  （pi 用 `pi auth check`），面板 Chat 的 provider 跟随会话挂载的工具；
  Key 纪律不变：**只在钥匙串，不进同步层**

### F6 多 AI 工具（后续）

- `packages/ai/<tool>` 每工具一个 Adapter；Registry 发现本机安装
- 统一 `launch` / `resume` / `deliverPrompt`（`'prefill' | 'argv' | 'clipboard' | 'flag' | 'stdin' | 'none'`）
- 首版只实现 `ai/pi`；as-built 已扩展为 `ai/pi` + `ai/workbuddy` + `ai/workbuddy-ai`（两个 WorkBuddy 均为 `newSessionMode='prefill'`，只打开 GUI 新建页、不自动绑定）

#### F6-c 对外服务能力（P2+：只做自身能力，不做网关）

- **先划线**：内置 pi-ai ≠ 做 LLM 网关。**Tick 不当模型中间人**（§2.2 非目标不变）——
  转发模型请求已是成熟品类（同行实证见 `RESEARCH-magpie.md`），我们没有差异化，
  还把自己变成所有 agent 的可用性单点。
- 对外的正确形态 = **把 Tick 的数据与工具按标准协议暴露**，让外部宿主应用接的是
  **Tick 的能力**，不是"Tick 冒充一个模型"：
  - `create_todo` / `list_todos`——已经是工具协议（pi extension `defineTool`），同一份实现再挂传输层；
  - todo ↔ 会话**索引只读查询**（F8 导出 JSON 的字段就是天然数据契约，含 `filePath` + `exists`）；
  - 协议选型跟对接方生态走（MCP 类是业界事实标准，候选），**P2+ 时按目标宿主确定**；
- 对接纪律（Q15 定调）：**对接规范是对接方定的，我们遵循业界标准、只做好自身能力，
  不为具名应用写专门插件**——外部应用能配 Tick，靠的是 Tick 说标准话，而不是 Tick 迁就任何一家
- F8 导出是这条路最早的形态（文件契约已带 version，可再导入的口子已留）

#### F6-a 跨工具接手（P1，确认要做）

一个 todo 下的会话可以交给**另一个 AI 工具接着干**。依据是 pi 自己的 `--fork`
（`pi --help` L30）与 `SessionManager.forkFrom(sourcePath, targetCwd)`
——**cwd 可以换**，所以「fork 到另一个项目继续」pi 原生就支持。

- **能力是有向的，不是对称的**（`RESEARCH-pi.md` §4）：
  pi → pi（换目录）✅ / omp 读 pi 会话 ✅ / **pi 读 omp 会话 ❌**
  （`forkFrom` 要求源文件首行是 `type:"session"` 的 header）
- adapter 声明 `acceptFrom` / `exposes`，UI **只列出可行方向**，不可行的灰掉并说明原因
- **降级通道（保底）**：目标工具读不了源格式时，退化为「把摘要作为首条消息投递」，
  摘要优先取 pi 的 `compaction.summary`。任何方向都至少不崩，只是保真度不同
- 排 P1：需要第二个 adapter 才有意义

#### F6-b 用量统计（P1，AI 工具自带数据）

**统计的是「AI 工具自己每个会话」的用量，不是我们面板的用量。**

- **范围只限 CLI 侧**：即 AI 工具（首版 pi）落在本机的会话文件里自带的 usage。
  **面板 Chat 不统计用量**——它只是快速捕获与建 todo 的入口，不是"干活"的地方，
  混进来会让同一个 todo 下的数字含义不一致（面板一轮 vs 工具一段对话）。
- 因此**不存在两套来源要统一**的问题：只有一个来源 = AI 工具的会话文件，
  由 `ai/<tool>` adapter 各自按该工具的口径算（`computeUsage()`）。
  第二个工具接入时，它算它自己的，不合并成"一个总账"。
- **pi 会话里就带完整 usage，不需要做网关**（`RESEARCH-pi.md` §2，官方 `message-types.md` L67–90）。

- 字段：`{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens,
  cost:{input, output, cacheRead, cacheWrite, total}}`
- 覆盖率：assistant 消息 **100%**（本机 9,389 / 9,389 实测）
- **官方规定的完整口径 = 5 个来源求和**：assistant 消息 + toolResult 消息（嵌套模型工作）
  + `type:"usage"` 条目 + `compaction.usage` + `branch_summary.usage`。只算 assistant 会漏
- 三个不能踩的坑：
  1. `totalTokens` 里 **98.9% 是 cacheRead**（本机 15.09 亿 / 15.25 亿）→ 不是"消耗"，
     别拿它吓人；钱看 `cost.total`
  2. **`cost` 不是每个 provider 都上报**（本机实测某 provider 470 万 token 报 $0）→
     UI 必须标注「该 provider 未上报成本」，只能当下限
  3. `reasoning` 已含在 `output`、`cacheWrite1h` 是 `cacheWrite` 子集，**都不重复加**
- **展示口径**：默认关闭（设置项）；开启后按需计算 + 按 `(path, mtime, size)` 缓存；
  解析后只取 usage/provider/model，丢弃 content
- **取数方式**：扫 AI 工具自己的会话文件（pi = jsonl）。**已实现并验证**：
  `scripts/session-usage.mjs`，本机 103 个有效会话、自洽校验 103/103 通过，
  与一份独立实现的 Python 统计数值完全一致
- **`cost` 缺失时不要补算**：不同 provider 单价口径不统一，我们不做价格表，
  缺就标注缺失（见坑 2）
- 失败的尝试也计入——pi-durable 官方口径原话 "Failed and aborted attempts count too"
- **空会话要过滤**：本机 `~/.pi/agent/sessions/` 下有 **31 个 0 字节空文件**（文件名是纯 UUID，
  没有 timestamp 前缀）——spawn 了但一条没写，`verify()` 要判 `size === 0` 视为未产生，列表里过滤掉
- **排期（Q11 已定）**：**M3 只做单会话维度**（打开会话详情时算这一个，默认关）；
  **M4+ 再做跨 todo / 跨项目汇总**。
  理由：单会话是唯一口径确定的单位（本机 103 会话自洽校验全过）；
  汇总口径（一个 todo 下多个会话要不要算 fork 继承段、要不要跨工具）还有产品歧义，先把底座做稳
- UI 落点：用量显示在**会话条目 / todo 详情里的会话列表**上；**面板 Chat 无用量入口**
  （面板底部给一句静态说明「此处对话不计入用量统计」，避免用户以为漏统计）

### F7 安装与分发

- 开发：`pnpm dev`
- 发布：`scripts/install.sh` + `.app`（安装通道，不是业务 CLI）

### F8 导出：todo 关联的会话记录（Q6 定案时提出，首版做最小版）

**导出的是"索引记录"，不是对话内容**——我们不存正文，也不复制 pi 的文件。

```jsonc
{
  "version": 1,
  "exportedAt": "2026-10-17T01:40:00+08:00",
  "tool": "tick",
  "todos": [{
    "id": "…", "title": "…", "body": "…", "status": "open",
    "createdAt": "…", "updatedAt": "…",
    "lastLaunch": { "toolId": "pi", "projectPath": "/Users/jacky/Desktop/tick" },
    "sessions": [{
      "toolId": "pi",
      "sessionId": "…",
      "cwd": "/Users/jacky/Desktop/tick",
      "name": "…",                                  // pi --name，无则取首条消息
      "filePath": "~/.pi/agent/sessions/…/….jsonl",  // **让用户能自己去定位原始会话**
      "exists": true,                                // false = 该会话已不在本机
      "usage": { "totalTokens": 12345, "cost": { "total": 0.0123 } } | null
    }]
  }]
}
```

四条规则：

1. **`filePath` 必须给**——它是这份导出的价值所在：拿到记录就能找到原始会话；
2. **`exists` 要实时判定**（`describeSession()`）——会话可能已被用户删掉，
   导出时标 false，别让清单看着像都还在；
3. **不含对话正文**（隐私原则一致），也不复制 pi 的文件；
4. `usage` 仅在用户开启用量统计时有值，否则 `null`。

**形态**：设置里「导出…」→ 选范围（全部 / 仅未完成 / 当前 todo）→ 落
`~/.ticktodo/exports/tick-export-<时间戳>.json`。
同时给一份 **Markdown** 伴生文件（人可读，可贴进笔记/周报）：
`# todo 标题` + 每条会话一行 `工具 · 项目 · 名字 · 路径`。

首版只做**手动触发 + JSON/Markdown**，不做自动导出、不做再导入。
（再导入留作后续：有 `filePath` 与 `sessionId` 就能反推绑定，数据结构已经留好口。）

---

## 5. 信息架构与界面

```
悬浮面板
├── 列表（默认 5）
│   ├── 条目 → 展开详情 / 会话列表切换 / 完成 / 打开 AI
│   └── 空态 → 新建 / 从历史会话反向建（S5）
├── 新建/编辑
├── 项目选择（默认已推导 · 可添加本地目录）
├── AI 选择（工具 / 项目 / 新会话或已有会话）
└── 面板 Chat（可折叠区域或独立视图）
```

交互要点：

- 主按钮默认形如「在 **tick** 中打开 pi」，**一次点击直接执行**（项目选填，不必进选择器）；
  选择器是"想改"的入口，不是必经步骤
- 投递后：argv 成功不打扰；预填时提示「已预填，确认后回车发送」；降级到剪贴板时提示「已复制，到 pi 粘贴」
- 完成 todo 不清理绑定会话

---

## 6. 业务规则

1. 标题为空不可保存。
2. **项目选填**：用户不必选项目即可执行；但 cwd 必须有值（pi 无 `--cwd`，进程工作目录即 cwd），
   由系统按 F4-a 优先级推导，**且按钮上必须显示项目名**——可以免选，不可以隐式。
3. 面板 Chat 的 session id 与 CLI `pi --session` id **命名空间隔离**。
4. 一个 session 最多绑一个 todo；一个 todo 可绑多个 session（绑定关系由 Tick 持有）。
5. 完成 todo **不清空**绑定；删除 todo 时默认解绑。
6. **Key 只进系统钥匙串，不进数据同步层**：默认复用 pi 凭据；M3+ 自配 provider 的 Key 经 safeStorage 存储，永不出现在 `data/`（见 F5）。
7. 项目索引只读 session 首行 header，**不读取、不缓存对话正文**。
8. spawn 参数固定数组，禁止 shell 字符串拼接（路径含空格/中文）。
9. Adapter 不得违背对应工具的官方 CLI/配置语义；pi 路径尤甚。

---

## 7. 数据模型（产品级）

**分工**：session 的"规范"（有哪些、叫什么、在哪、活不活跃）**归 ai 工具自己**；
Tick 只持有**绑定关系**这一件事，其余都是运行时从 adapter 读、可丢弃的缓存。

```ts
// —— Tick 自持：只有绑定关系 ——
Todo {
  id, title, body?, status: 'open' | 'done',
  createdAt, updatedAt,
  bindings: SessionBinding[],          // 1:N
  primarySessionId?: CliSessionId,     // 默认 resume 的那一个（指向 bindings 中的一项）
  lastLaunch?: { toolId: string, projectPath: string }  // 上次用哪个工具 + 哪个目录（F4-a 优先级 2）
}                                      // 两者是一体的，拆开会在切工具时选错；纯 UI 记忆，不是 session 镜像

SessionBinding {
  toolId: 'pi' | string,
  sessionId: CliSessionId,             // 只作引用，不镜像任何元数据
  boundAt
}

// —— 权威源在工具侧：由 ai/<tool> adapter 提供，Tick 只做短期缓存 ——
SessionInfo {                          // adapter.describeSession(id)
  toolId, sessionId, cwd, name?, createdAt, lastUsedAt, exists
}

ProjectEntry {                         // adapter.discoverProjects()（缓存进 cache/projects.json）
  path, source: 'pi' | 'user', exists, lastUsedAt, sessionCount
}

PanelAgentSession { /* 落在 ~/.ticktodo/sessions/panel-chat，与 CliSessionId 命名空间隔离 */ }
```

不镜像 `cwd` / `name` / `lastUsedAt` 的理由：session 会被用户在 pi 里改名、删除、移动，
镜像一份立刻就会腐烂。列表渲染要这些字段时向 adapter 要，缓存只用于提速，随时可失效重建。

`Todo.lastLaunch` **不属于镜像**：它记的是"用户上次为这个 todo 选了哪个工具、哪个目录"，
是用户意图而非工具状态；session 被删掉后它依然有意义，反而正因缺失 session 才需要它。
工具与目录必须**一起记**——只记目录的话，下次会用默认工具打开，用户换过工具就白选了。
同理它不参与任何 adapter 逻辑，只喂给 F4-a 的默认值推导。

存储布局：

```
**Q6 已定：放一个目录，但做层级设计**——"放哪"不再是问题，
"哪一层能同步、哪一层能删、哪一层能导出"才是。用层级把性质分开：

```
~/.ticktodo/
├── README.md             # 自动生成：说明各层用途与同步建议（人打开目录就能看懂）
├── data/                 # ✅ 可同步 · 关键数据（几十 KB，丢了致命）
│   ├── todos.json              # 原子写 + 文件锁；Todo + bindings/primarySessionId（唯一持久化关系，不另建镜像）
│   └── settings.json
├── sessions/             # ⚠️ 不建议同步 · 含对话正文（MB 级，丢了可承受）
│   └── panel-chat/             # pi-durable store
├── cache/                # ❌ 无需同步 · 可再生（删了自动重建）
│   └── projects.json
└── exports/              # 手动产物，见 F8
```

三层语义要写进 README 并落到 UI：

| 层 | 丢了会怎样 | 同步 | 清理 |
|---|---|---|---|
| `data/` | 致命（todo 全没） | ✅ 建议 | 永不自动删 |
| `sessions/` | 可承受（面板只是捕获入口） | ⚠️ 不建议（dotfiles/网盘会顺走正文） | 提供「清除面板历史」 |
| `cache/` | 无所谓（重扫即重建） | ❌ 不需要 | 可随时删 |

→ 这样即便同一个目录，"只同步 `data/`"也是一句可执行的话，不必搬家到 Application Support。
设置里给「打开数据目录」入口，并标注该备份哪个文件夹。

---

## 8. 成功标准（首版验收）

| #   | 验收项                                                     |
| --- | ------------------------------------------------------- |
| 1   | 置顶面板可显隐；列表默认 5 条可展开                                     |
| 2   | 手动新建：标题必填、内容选填、完成只改状态                                   |
| 3   | 打开选择器时项目列表**可用**（首帧来自 `cache/projects.json`，后台扫描完 IPC 推送刷新，Top 为最近使用；缓存缺失也不阻塞，见 4.4），可添加本地目录；**不打开也能执行** |
| 4   | 拉起 pi：**文案已预填进输入框**（设置切 A 时为已发出），cwd 与按钮上显示的项目名一致，`--name` 为 todo 标题 |
| 4.1 | 项目选填：**单次点击**即可执行；cwd 来源符合 F4-a 优先级（已绑 todo 用其 session 的 cwd；该 todo 用过则沿用；**否则主目录 ~**，不猜最近使用） |
| 4.2 | 按钮上始终显示项目名（兜底时显示「主目录 ~」）；记住/选定的目录若已失效 → 退回主目录**并提示**，不静默跑错目录 |
| 4.3 | spawn 后**绕过缓存直读**确认 session 真的产生（目录缓存有约 2 秒 racy 窗口）；失败标 `unverified` 并提示 |
| 4.4 | 面板打开即渲染（不等 ProjectIndex 扫描）：首帧用 `cache/projects.json`，扫完 IPC 推送刷新；缓存缺失时首帧即为「主目录 ~」，不阻塞、不空白 |
| 5   | 已绑定 todo 可 `--session` 跳回；**一个 todo 多个会话可切换**            |
| 6   | `create_todo` 在 pi CLI 会话与面板 Chat 中均可用，且写入同一份 todos.json |
| 7   | 找回一个上周会话 ≤ 10 秒 / ≤ 3 次点击                                |
| 8   | 代码结构：`packages/ai/pi` 为实现，`ai/core` 为注册，无内嵌 Gateway      |
| 9   | **S5 反向建索引**：能浏览未绑定历史会话（按项目分组），选中可「建 todo 并绑定」或「直接 resume」；**不批量自动生成** |
| 10  | 首屏装的不是空列表：首次启动即可看到本机历史会话入口（本机实测 103 条可列） |
| 11  | **F8 导出**：能导出 todo + 关联 session 记录（JSON + Markdown），含 `filePath` 与 `exists`，**不含对话正文** |
| 12  | 项目条目可区分同名目录（`Desktop/pi` vs `Projects/pi`）；临时目录不占主列表 |
| 13  | **pi 未安装时产品不崩**：Todo / 手动目录 / 导出可用；面板 Chat 显示引导空态（去装 pi 或去自配，自配属 M3+）；首版全流程不出现 Key 输入框 |

---

## 9. 里程碑

| 阶段  | 交付                                                            |
| --- | ------------------------------------------------------------- |
| M0  | 仓库脚手架 + 置顶空壳 + Todo CRUD（数据根 `~/.ticktodo`）；**开发前把 pi 升到 1.3.0**（本机 1.2.0） |
| M1  | ProjectIndex + PiAdapter（argv 投递 / `--session-id` / `--name`；版本校验已于 2026-10-19 移除，detect 只判 installed） |
| M2  | `create_todo` extension（CLI + 面板共用）+ 面板 Chat（**pi-durable@1.3.0，pin 版本**） |
| M3  | 多会话绑定 UI + **S5 反向建索引** + 快捷键、位置记忆 + 用量统计（单会话维度，默认关，口径已验证）+ **面板自配 provider**（凭据来源 2，可滑到 M4） |
| M4  | 打通出包（electron-builder + install.sh 草案）+ **F8 导出（JSON + Markdown）** |
| M5+ | 第二个 `packages/ai/<tool>` + **跨工具接手（F6-a）**；导出再导入（结构已留口）     |

> **S5 排进 M3 而不是更早**：它依赖 M1 的 `listSessions()` 和 M3 的多会话绑定 UI，
> 两样齐了才是"点一下就建好 todo 并绑定"，提前做只能是个只读列表。

---

## 10. 开放问题

- ~~Q2：`--name` 是否在 `pi -r` 列表中可见？~~ → **是**：`session-selector.js:390` `displayText = session.name ?? firstMessage`；name 存在 `session_info` 行（非 header），要读全文件才拿得到
- ~~Q3：pi-durable 是否支持自定义存储目录？~~ → **支持**：1.3.0 有 `openNodeJsonlStorage(dir)` / `openNodeSqliteStorage(path)`（本机尚未安装）
- ~~Q4：本地扩展是否每次要 `-e`？~~ → **不用**：`~/.pi/agent/extensions/` 自动发现（推荐），或 `pi install` 写 settings，均默认启用
- ~~Q5：项目归并是否用 git 根？~~ → **pi 不管**（一个 cwd 一个目录），归并由我们定
- ~~Q1 投递取向~~ → **已定：默认预填（B），设置可切直接发送（A）**。预填走 tick-extension `ctx.ui.setEditorText()`（pi 无 CLI 预填 flag，但扩展 API 支持）
- ~~Q7：默认项目要"跟随前台 Finder/编辑器目录"吗？~~ → **已定：不做**。
  默认兜底改为 home（D18）后，默认值不再依赖任何猜测，"猜不准"这个前提消失了；
  跟随前台目录还要引入 osascript 依赖与新的失败模式，收益不成立。按**不做**结案。
- ~~Q8：ProjectIndex 冷启动怎么办？~~ → **已定：三层渐进 + Warm/Ask 调度**，方案取自 magpie 实证
  （`RESEARCH-magpie.md` §7），要点：
  1. **首帧不等扫描**：Renderer 用 `cache/projects.json` 立即渲染；缓存缺失时首帧就是「主目录 ~」；
  2. **后台扫、低优先级**（magpie `quiet.go` 的 `Warm`：预热只用 1/4 核，理由是 8.9 GB 会话预热
     会占满 CPU 15 秒被用户投诉 #1665）；用户一旦真的打开选择器（`Ask`）立即提速；
  3. **目录列表缓存带 racy 窗口**（`discovery.go`：mtime 粒度粗 + 目录 size 常不变 →
     2 秒内新增的文件会被缓存藏起来）→ 这与 4.3 的 `verify()` 是同一个坑，必须绕缓存直读；
  4. **文件级增量按 `(size, mtime)` 判定**，消失的条目从缓存删除；
  5. **扫描中途 checkpoint 落盘**（magpie `checkpointEvery = 5s`）：防止用户中途退出导致白扫一遍。
     我们规模小得多（103 会话 / 49 MB，全扫约 1 秒），可简化为"扫完即存"，**但接口要预留**。
- ~~Q6：`~/.ticktodo` 是否同时承载数据与会话~~ → **已定：放一个目录，但做层级设计**。
  `data/`（可同步·关键）/ `sessions/`（不建议同步·含正文）/ `cache/`（可再生）/ `exports/`，
  详见 §7 存储布局。并**支持导出 todo 关联 sessions 的记录**（新增 **F8**，首版做最小版）。
  这样"只同步 `data/`"是一句可执行的话，不必搬家。
- ~~Q9：git 根上卷默认开启是否合适？~~ → **已定：默认开**。
  上卷 = 向上找最近 `.git` 把 `proj`、`proj/src/ui`、`proj/packages/core` 收敛成一条
  （`children[]` 保留真实 cwd 可细选）。本机实测 9 条上卷后仍是 9 条（零差异），风险很低。
- ~~Q13：两个都叫 `pi` 的目录怎么消歧？~~ → **已定：这不是产品决策，是 UI 实现约束**。
  路径本来就不同，只要**不只用 basename 显示**就没有歧义。落为两条硬要求：

  1. 项目条目**至少显示父目录片段**（`Desktop/pi` vs `Projects/pi`），
     完整路径 hover / 展开可见；**禁止只渲染 basename**；
  2. 低频（≤1 条会话）+ 位于 `Downloads` / `tmp` 的临时目录**默认折叠进「其他」**
     （本机 `/Users/jacky/Downloads/小智AI教程…` 这类 1 条会话的目录不该占主列表）。

- ~~S5 反向建索引是否进首版~~ → **已定：首版做**。详见 §3 场景 S5 详解，排进 **M3**。
  验收新增 9 / 10 两条，见 §8。
- ~~Q10：面板 Chat 用 pi SDK 还是 pi-durable？~~ → **已定：pi-durable**（D13，见 F5）。
  遗留待验：Electron 内 SQLite/JSONL 后端的写权限与并发（面板与 extension 同时写）
- ~~Q11：用量统计要不要进首版？~~ → **已定：M3 只做单会话维度**（见 F6-b）。
  口径已由 `scripts/session-usage.mjs` 验证通过（官方 `addUsage`，103 会话自洽校验全过）。
  跨 todo / 跨项目汇总留到 M4+，等单会话维度跑顺、看到真实使用模式再决定聚合粒度
- ~~Q12：面板用量与 CLI 用量两套来源如何合并展示？~~ → **已结案：不做面板用量**。
  统计对象就是「AI 工具每个会话自己的用量」，唯一来源是工具侧的会话文件，
  由 `ai/<tool>` adapter 各自计算，不设跨来源的统一层。面板 Chat 不出现用量
- ~~Q14：用户**没装 / 没用过 pi**，面板 Chat 的 provider 从哪来？~~ → **已定（修订）：凭据双来源**（见 F5）。
  来源 1 = pi 本体（默认零配置）；来源 2 = **自配 provider**（内置 pi-ai 直连上游，支持 OpenAI 兼容
  自定义 endpoint；各类网关/代理由此接入，Tick 不写具名应用插件），Key 只进系统钥匙串。
  没 pi 时引导空态双出口：装 pi 或去自配（自配实施排 M3+）；CLI 拉起与项目索引仍不可用
  （依赖 pi 会话目录，与凭据无关）
- ~~Q15：对外能力如何让外部宿主应用接入？~~ → **已定方向，P2+ 实施**（见 F6-c）。
  不做 LLM 网关（Tick 不当模型中间人），只把数据/工具按标准协议暴露（MCP 类候选）；
  协议选型等第一个真实目标宿主确定后定案

---

## 11. 文档与仓库对照

- 架构细节：`TECH-ARCH-tick.md`（同目录）
- 决策评审：`REVIEW-tick-v0.3.md`（同目录）
- 外部调研：`RESEARCH-magpie.md`（多 agent 会话网关，印证与反证）、
  **`RESEARCH-pi.md`（pi 官方规范实证：会话格式 / usage 口径 / fork / SDK，本文档的 pi 事实以此为准）**
- 目录：`apps/desktop`（`src/main` · `src/preload` · `src/renderer/features`）+ `packages/shared` + `packages/ai/{core,pi,…}`
- UI：`docs/ui/board.html`（视觉源 `UI-LOCK.md` 待需求澄清后补，当前标注 pending）
