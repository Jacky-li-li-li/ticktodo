# 评审 · Tick v0.3 决策评审

| 字段 | 内容 |
|------|------|
| 状态 | 已评审，待拍板 |
| 对象 | `PRD-tick.md` v0.2 → v0.3 的本轮产品决策 |
| 日期 | 2026-10-16 |
| 依据 | 本机 pi 1.2.0 实测（`pi --help`、会话目录、扩展 API 类型定义） |

---

## 0. 结论摘要

| # | 本轮决策 | 处置 | 一句话理由 |
|---|---------|------|-----------|
| D1 | cwd 由 AI 工具的 project/sessions 推导，也可添加本地项目 | **采纳，但规则要改写** | "必选"应降级为"默认已推导，用户只确认/改"；且存在目录名反解歧义，必须交叉校验 |
| D2 | `create_todo` 作为 pi 运行层扩展 tool | **采纳，且比原方案更强** | pi 有 `defineTool` + `--extension/-e` + `pi install`，一份实现可同时进 CLI 会话和面板 Chat |
| D3 | 面板 Chat session 落在 `~/.ticktodo` | **采纳，但需加边界** | 会话可以放这里，API Key 不行；点目录会被 dotfiles 同步抓走 |
| D4 | 一个 todo 可创建/绑定多个 session | **采纳，模型要改** | 现模型 `ai?: {sessionId}` 是单值，需改成 1:N，并定义"默认 resume 哪一个" |
| D5 | 飞书相关功能先不考虑 | **采纳，需做全文清理** | 不清理会留下大量 P1 标记和已失效的"5 分钟/次"论据 |
| D6 | UI 视觉源等需求澄清后再更新 | **采纳，先挂状态** | 至少要在 board.html 注释里标注 pending，避免后人当它已存在 |
| D9 | 项目也设为选填（可跳过选择直接执行） | **采纳，补了 3 处** | cwd 本身不可缺省，需 `lastLaunch` 记忆 + 默认值可见 + stale 降级；见 §10 |

**另有一个本轮没提、但影响最大的发现**：pi 支持 `pi "消息"` 作为初始消息（见 §2.2），
**剪贴板投递应降级为兜底方案**。这直接解掉上一轮评审里标记为"最弱一环"的风险。
（第二轮已确认该消息是**预填**而非自动发送，见 §7-Q1。）

> 第二轮追加两条决策：**D7 session 元数据归 adapter**、**D8 凭据复用 pi**，见 §7。
> 第五轮追加：**D9 项目选填**（免选直接执行 + `lastLaunch` 记忆 + 两个设置项），见 §10。
> 第六轮：**多 AI 工具下的项目索引分层**，见 §11（结论：目录做主键、工具做标签；归并必须在 core，不能留到 P2）。

---

## 1. 本机实测事实（pi 1.2.0）

以下均在本机核实，不是推测。库升级后需照 §5 的方法重核一遍。

### 1.1 安装与版本

- 可执行文件：`/Users/jacky/.npm-global/bin/pi`，`pi --version` → `1.2.0`
- 包：`@earendil-works/pi-coding-agent`（`dist/` 下有 `core/extensions/`、`extensions/{codemode,llama,mcp,tool-search}`）
- 配置：`~/.pi/agent/settings.json`（实测内容只有版本、默认 provider/model、主题，**无扩展声明**）

### 1.2 会话存储结构（这是 D1 的数据源）

```
~/.pi/agent/
├── sessions/
│   ├── --Users-jacky-Desktop-tick--/            ← 项目目录：cwd 编码成目录名
│   │   └── 2026-10-15T16-43-43-863Z_01a14072-….jsonl
│   ├── --Users-jacky--/                          ← home 目录也是一个"项目"
│   ├── --Users-jacky-Downloads-材料--/           ← 中文路径 OK
│   └── 031beeab-3259-42ac-8fa6-8633bbb34169.jsonl   ← 顶层散落：无项目归属
├── settings.json / models.json / auth.json / skills/
```

- **目录名编码规则**（实测推断）：`--` + 绝对路径去掉首尾 `/` 后把 `/` 换成 `-` + `--`。
  例：`/Users/jacky/Desktop/tick` → `--Users-jacky-Desktop-tick--`
- **文件命名**：`<UTC 时间戳，`:`→`-`>_<sessionId>.jsonl`，例 `2026-10-15T16-43-43-863Z_01a14072-….jsonl`
- **首行就是 session header**（已实测两个样本）：
  `{ "type": "session", "version": 3, "id": "<uuid>", "timestamp": "…", "cwd": "/Users/jacky/Desktop/pi" }`
  → **cwd 是可靠的权威字段，目录名只是索引**
- 本机规模：**134 个 session 文件、9 个项目目录、31 个顶层散落 jsonl**（散落的这些首行不是合法 JSON，需容错）

### 1.3 CLI flags（`pi --help` 摘录，与本项目相关）

| flag | 实测含义 | 对 Tick 的意义 |
|------|---------|---------------|
| `pi "消息"`（位置参数） | 见 §2.2 | **可直接投递首条消息，剪贴板降级** |
| `--session-id <id>` | 使用指定项目 session ID，**不存在则创建** | 现架构已在用（UUIDv7 预生成） |
| `--session <path\|id>` | 用 session 文件或**部分 UUID** 恢复 | resume 支持模糊 id |
| `--session-dir <dir>` | 指定 session 存储与查找目录 | 面板 Chat 可隔离到独立目录（比靠 pi-durable 自身约定更可控） |
| `--name, -n <name>` | 设置 session 显示名 | **把 todo 标题写进 session 名，直接解决"靠标题猜"** |
| `--resume, -r` / `--continue, -c` | 选择/继续上一个 session | 找回路径 |
| `--print, -p` | 非交互：处理 prompt 后退出 | 不需要 |
| `--extension, -e <path>` | 加载扩展文件（可多次） | **D2 的注入通道之一** |
| `--tools/-t`、`--exclude-tools` | 工具白/黑名单，支持 `mcp__` 前缀 | 可控地只开 `create_todo` |
| `--no-session` | 不落盘（临时会话） | 不需要 |
| `pi install <source>` / `pi list` / `pi remove` | 安装扩展并写入 settings | **D2 的持久注入通道** |

> 注意：实测 `pi --help` 里**没有** `--cwd`。cwd 只能由进程工作目录决定 → Electron 侧用 `spawn` 的 `cwd` 选项，与现架构一致。

### 1.4 扩展 API（决定 D2 怎么写）

从 `dist/core/extensions/types.d.ts` / `dist/index.d.ts` 确认：

- `defineTool<TParams>(tool: ToolDefinition)` → 定义工具
- `createExtensionRuntime()` / `discoverAndLoadExtensions()` / `ExtensionRunner`
- `ExtensionFactory`（`createMcpExtension()`、`createCodemodeExtension()` 就是官方扩展的写法）
- `ExtensionContext` 提供 `cwd`、`sessionManager`（只读）、`modelRegistry`、`ui`、`abort()` 等
- 工具可通过 `replay` 字段声明能否重跑（pi-durable 语义）：**`create_todo` 属于写操作，必须标为非 safe**

---

## 2. 两个改变范围判断的发现

### 2.1 `pi "消息"` 会在启动时自动发送

- `dist/modes/interactive/interactive-mode.d.ts`：`InteractiveModeOptions.initialMessage` 注释为
  "**Initial message to send on startup**"
- `dist/cli/initial-message.js`：`buildInitialMessage()` 把 stdin / `@file` / 第一个 CLI 位置参数拼成 `initialMessage`
- `pi --help` 的示例区明确写了 `pi "List all .ts files in src/"`（Interactive mode with initial prompt）

**含义**：Tick 拉起 pi 时可以直接 `spawn(pi, ["--session-id", id, "--name", todo.title, todoPrompt], { cwd })`，
用户不用再 Cmd+V + 回车。上一轮评审列为 P0 的"剪贴板是最弱一环"因此可以被消除。

**但仍要实测一次**（§5-Q1）：确认消息是"自动提交"还是"填进输入框待发送"。二者差一次回车，
也决定 G1 的度量口径。

### 2.2 项目列表可以直接从 pi 的会话目录推导（D1 可行，但有坑）

数据源已确认存在（`sessions/<项目目录>/` + header 里的 `cwd`）。但实现上有 7 个坑，见 §3.1。

---

## 3. 逐条评审

### 3.1 D1 · cwd 由 project/sessions 推导

**结论：采纳。** 规则从"打开 pi 前 cwd 必选"改为：**cwd 必须有值，但由系统推导默认值，用户只在需要时改。**

建议的 ProjectIndex 机制（对应新增模块）：

1. 扫 `~/.pi/agent/sessions/` 的一级子目录，按 §1.2 规则**反解**成候选路径；
2. **用目录内首个 session 的 header `cwd` 字段校验**——目录名编码有损，不能只靠反解；
3. 校验目录是否仍存在（`fs.stat`），不存在的标 `stale`；
4. 归一化：`~`、`/private/var` vs `/var`、symlink（`fs.realpath`）、大小写；
5. 归并粒度：向上找 `.git` 归到仓库根（否则 `proj/`、`proj/src`、`proj/src/ui` 会炸成三条）；
6. 排序：`lastUsedAt` 降序，冷启动给出 Top N；
7. 缓存写 `~/.ticktodo/projects.cache.json`，扫描结果带 `mtime` 与 `piVersion` 戳。

风险与对策：

| ID | 风险 | 对策 |
|----|------|------|
| R1 | **目录名反解有歧义**（路径里的 `-` 与分隔符 `-` 无法区分） | 目录名只作候选，**以 header 的 `cwd` 为准** |
| R2 | 顶层 31 个散落 jsonl 首行非法 JSON | 只读首行、解析失败即跳过，不进项目列表 |
| R3 | 路径含空格/中文（本机就有实例，`find` 都会分词出错） | 全程用数组传参，禁止 shell 拼接 |
| R4 | **隐私**：扫描会碰到用户全部历史对话 | **只读每个文件的首行 header**，不索引正文、不落缓存正文 |
| R5 | 项目目录不存在（删了/改了） | 标 stale，默认隐藏，可在"管理项目"里清理 |
| R6 | pi 目录结构/版本变化（`--session-dir` 或用户自定义） | 路径发现走 PiAdapter 的 `detect()`，失败降级到"手选目录" |
| R7 | 多 AI 工具后，同一项目在不同工具里各一份 | 归一化后按 canonical path 合并，记录来源工具集合 |

交互建议：AiPicker 默认选中"最近使用的项目"，下方两枚次要入口：「添加本地目录」「在此新建」。
用户手填只在兜底时出现。

### 3.2 D2 · `create_todo` 作为 pi 运行层扩展 tool

**结论：采纳，并且建议把它写成 pi extension，而不是 pi-durable 的 tools。**

理由：一份 `defineTool` 实现可以同时被两处加载——

- CLI 会话：`pi install <本地路径>` 写进 settings，或拉起时 `-e <path>` 临时加载；
- 面板 Chat：pi-durable 侧用 `ExtensionRunner` 加载同一个工厂函数。

这样"在 pi 里建 todo"和"在面板里建 todo"是同一套语义，不会出现两套实现漂移。

需要随之确定的四件事：

1. **写路径**：extension 跑在 pi 进程里，直接读写 `~/.ticktodo/todos.json`。
2. **并发**：面板 UI 也在写同一个文件 → 必须原子写（tmp + rename）+ 文件锁 + 版本号；
   面板侧用 `fs.watch` 感知 CLI 侧的写入并刷新列表。**这是 D2 最容易被低估的工作量。**
3. **replay 语义**：`create_todo` 是写操作，按 pi-durable 约定标为非 safe 重跑，避免崩溃恢复时重复建单；
   建议带幂等键（客户端生成 `clientTodoId`，服务端去重）。
4. **权限**：LLM 能写本地数据，建议首版允许直写但保留"最近删除/撤销"入口。

### 3.3 D3 · 面板 Chat session 落在 `~/.ticktodo`

**结论：采纳为数据根目录，但要划清三件事。**

建议的目录布局：

```
~/.ticktodo/
├── todos.json              # 主数据（原子写）
├── cli-sessions.json       # CLI session 元数据（含 todoId 反查）
├── projects.cache.json     # D1 的项目索引缓存
└── panel-chat/             # 面板会话（pi-durable / jsonl）
```

要点：

- **API Key 不放在这里。** 走 `safeStorage`/Keychain，否则 dotfiles 仓库、Time Machine、网盘同步会把 Key 带走。
  这条必须落地，否则与"Key 只进可信区"的原则冲突。
- **点目录会被同步工具抓走**（`.ticktodo` 在 `~` 下）。建议首版就支持 `TICK_HOME` 环境变量覆盖，
  并在 README 里提示可加到 dotfiles 忽略列表。
- pi-durable 自身有 persistence 约定，落在 `~/.ticktodo/panel-chat/` 需要它支持自定义存储路径
  （或直接用 pi 的 `--session-dir`，实测存在这个 flag）→ §5-Q3。
- 从 Electron `userData` 迁到 `~/.ticktodo` 要有版本化 + 迁移函数，别让老用户丢数据。
- 权限陷阱：以 root 跑过一次会生成 root 属主的文件 → 启动时校验属主/可写性并明确报错。

### 3.4 D4 · 一个 todo 绑定多个 session

**结论：采纳，数据模型必须改。**

v0.2 的 `Todo.ai?: { toolId, sessionId, cwd }` 是单值，与"多个会话"直接冲突。建议：

```ts
Todo {
  id, title, body?, status: 'open' | 'done',
  createdAt, updatedAt,
  primarySessionId?: CliSessionId     // 默认 resume 的那一个
}

CliSessionMeta {
  sessionId: CliSessionId, toolId, cwd,
  todoId?: string,                     // 一个 session 只绑一个 todo（建议 1:1 反向）
  name?: string,                       // 拉起时用 pi --name 写入
  createdAt, lastOpenedAt
}
```

配套要定死的语义（不定会在 UI 上打架）：

- **创建 vs 绑定**：新建会话（`--session-id` 新 UUID）／从"未绑定的历史 session"里挑一个绑定；
- **默认 resume 哪个**：最近使用的那个（不是第一个），并允许在条目展开里切换；
- **完成 todo 后**：session 保留，不清空——**事后找回是核心价值**；
- **删除 todo 时**：解绑但保留 `CliSessionMeta`（它本身就是历史索引，删了就失去价值），
  或提供"连同会话一起删"的二次确认。

### 3.5 D5 · 飞书移除的连带修订

移除本身没问题，但**文档层面会留下一具僵尸**。v0.3 已同步清理，处理清单备查：

- §1.1 痛点 1 的"5 分钟/次"论据来自日历场景 → 已换成"会话找回"作为首要痛点（并用本机 134 个 session 作实证）；
- 全文 20+ 处「P1」「飞书」标记、`F3 飞书日历` 整节、`SyncPolicy` / `FeishuAuth` / `FeishuCalendar` 三个模块、
  场景 S1（从日历开工）、验收 P1-1/P1-2、里程碑 M4 → 已删或改写；
- §6 业务规则、§10 开放问题里的飞书条目 → 已清。

建议：**价值主张顺势改写为"AI 会话的任务索引层"**——Todo 是索引，session 是被索引对象。
这比"置顶 Todo 工作台"更准，也更难被替代。同时把"反向建索引"（扫历史 session → 生成/绑定 todo）
提为首版能力，它是移除飞书后唯一能立刻产生可感知价值的入口。

### 3.6 D6 · UI 视觉源

同意等澄清后再补。当前最小动作：把 `docs/ui/board.html` 头部注释里
`视觉源：docs/ui/UI-LOCK.md` 标注为 `（pending：待需求澄清后补）`，避免下一个人按不存在的文件对齐。

---

## 4. 建议同步修订的其他项

| 项 | 现状 | 建议 |
|----|------|------|
| 投递方式 | 剪贴板 | 改 argv（`pi "消息"`）为主，剪贴板降级；`Adapter.capabilities.deliverPrompt` 增加 `'argv'` |
| session 命名 | 无 | 拉起时带 `--name <todo 标题>`，让 pi 的 `--resume` 列表直接可读 |
| 成功标准 | 全定性 | 至少给一条硬指标：找回一个上周会话 ≤ 10 秒 / ≤ 3 次点击 |
| 僵尸绑定 | 未处理 | launch 后校验 session 文件是否真的出现，失败则标记 `unverified` 并提示 |
| 打包 | 未落地 | 保持原建议：M1 之后就打通出包，别攒到 M3 |

---

## 5. 待实测 / 待拍板清单

| ID | 问题 | 怎么验 | 影响 |
|----|------|--------|------|
| ~~Q1~~ | `pi "消息"` 是自动提交还是只填进输入框 | ~~`cd /tmp && pi --session-id tick-test-1 "hi"`~~ | **已确认：预填**，用户回车发送。剪贴板保留为降级通道，G1 口径改为"文案已在输入框、回车即发" |
| Q2 | `--name` 是否写进 session 并在 `--resume` 列表可见 | 建一个带 `--name` 的会话后 `pi -r` 看列表 | 决定"事后找回"的体验上限 |
| Q3 | pi-durable 是否支持自定义存储目录 / 能否直接用 `--session-dir` | 建最小 demo，跑一次写盘看落在哪 | 决定 D3 的实现路径 |
| Q4 | `pi install` 装本地 extension 后，CLI 会话里能否真的调到 `create_todo` | 装一次，`pi --tools` 看工具列表 | 决定 D2 是否要在拉起时额外带 `-e` |
| Q5 | 项目归并粒度用不用 `.git` 根 | 看本机 9 个项目目录是否存在同仓库多子目录 | 决定项目列表会不会炸 |
| Q6 | `~/.ticktodo` 是否同时承载数据与会话 | 产品拍板 | 决定迁移与备份策略 |

> **Q1–Q5 已全部由源码结案**，见 §8（Q6 属产品决策，源码答不了）。
> 其中 **Q1 的源码结论与"预填"的说法相反**，需要你确认走哪条路。

---

## 6. 建议的里程碑调整（v0.3）

| 阶段 | 交付 |
|------|------|
| M0 | 仓库脚手架 + 置顶空壳 + Todo CRUD（数据根 `~/.ticktodo`） |
| M1 | ProjectIndex（扫 pi sessions → 项目列表）+ PiAdapter（argv 投递、`--session-id`、`--name`） |
| M2 | `create_todo` extension（CLI + 面板共用）+ 面板 Chat（session 落 `~/.ticktodo/panel-chat`） |
| M3 | 多 session 绑定 UI（切换/默认 resume）+ 快捷键、位置记忆 |
| M4 | 打通出包（electron-builder + install.sh 草案），按 `release-playbook.md` 验一遍 |
| M5+ | 第二个 `packages/ai/<tool>`（届时 ProjectIndex 需支持多工具合并） |

---

## 7. 追加决策（第二轮评审）

### D7 · 多 session 的元数据归 ai 工具，不进 Tick 模型

**结论：你说得对，我上一版的改法过重。** 原提议把 `cwd` / `name` / `lastOpenedAt` / `verified`
镜像进 `CliSessionMeta`——那是把工具侧的规范复制了一份，session 一旦在 pi 里被改名或删除，镜像立刻腐烂。

修正后的分工：

| 数据 | 归属 | Tick 侧 |
|------|------|---------|
| 有哪些 session、叫什么、在哪个 cwd、活不活跃、是否还存在 | **ai 工具**（adapter 实时读） | 不持久化，只做可丢弃缓存 |
| 哪个 todo 绑了哪些 session、默认 resume 哪一个 | **Tick** | `Todo.bindings[]` + `primarySessionId` |

Adapter 合同因此加了 `listSessions()` / `describeSession()`，**权威源在工具侧**。
这也顺带让"反向建索引"（S5）变得自然：`listSessions()` 返回的未绑定 session 就是 S5 的数据源，
不需要我们额外维护一张 session 表。

所以 v0.3 的模型改动比上一版**更小**：只把 `ai?: { sessionId }` 换成 `bindings[]`，
不是新增一套镜像表。

### D8 · 面板 Chat 复用 pi 的 Key

**结论：可以，而且应该。** 实测依据：

- `pi auth --help`：`print-api-key` / `print-bearer-token`（会刷新 OAuth）/ `check [--json]`
- `pi auth check --provider magpie --json` 实测 → `{"status":"invalid","reason":"invalid_state"}`
  （本机默认 provider 凭据当前不可用）
- `ExtensionContext.modelRegistry` 的注释就是 "Model registry for **API key resolution**"

推荐做法（**不要**去读 `~/.pi/agent/auth.json`，那是 pi 私有格式、版本易变）：

1. 解析 key：`ExtensionContext.modelRegistry`，Tick 全程不接触明文；
2. 就绪性探测：`pi auth check --provider <p> --json`（不加 `--credentials`，不打印凭据）；
3. 未就绪 → 引导用户回 pi 完成登录，**不在 Tick 里再收一份 Key**。

收益：零配置接入（装了 pi 就能聊）、Key 生命周期与 pi 一致、safeStorage 那条需求直接消失，
`~/.ticktodo` 下没有任何凭据文件。

代价与要注意的：

- 面板可用模型 = 用户在 pi 里配过的那些，不能承诺"任意 provider"；
- 计费/配额归属用户的 pi 账号（合理，但要在设置里说明）；
- 默认 provider 可能处于 invalid（本机就是）→ 首屏必须探测，别等用户发第一条消息才报错。

---

## 8. 源码定论（第三轮：读 pi 1.2.0 与 pi-durable 1.3.0 源码）

包名 `@earendil-works/pi-coding-agent`（本机 1.2.0，dist 含未打包的模块化 ESM，可直接读）；
`pi-durable` 本机未装，取 npm 上 **1.3.0** 的 tarball 读类型定义。

### Q1 · `pi "消息"` 是自动发送，不是预填 ⚠️ 与"预填"说法相反

调用链有完整源码证据：

1. `dist/main.js:734` — `const { initialMessage } = await prepareInitialMessage(parsed, stdinContent)`
   （`prepareInitialMessage` → `cli/initial-message.js:buildInitialMessage()`，把 stdin / `@file` / **第一个位置参数**拼成 `initialMessage`）
2. `dist/main.js:777-789` — 交互模式把 `initialMessage` 传给 `new InteractiveMode(runtime, {…initialMessage…})`
3. `dist/modes/interactive/interactive-mode.js:894-896` —
   ```js
   if (initialMessage) {
     await this.session.prompt(initialMessage, { images: initialImages });
   }
   ```
   之后才进入 `while (true) { getUserInput() }` 主循环。

**即：位置参数会被立即 `prompt()` 发出去，不经过输入框、不需要回车。**
`InteractiveModeOptions.initialMessage` 的注释 "Initial message **to send on startup**" 与代码一致。

**而且 pi 没有"只预填不发送"的中间模式**：要么传消息（自动发送），要么不传（那就只剩剪贴板）。
所以"预填、等我回车"这个行为 **pi 不提供**，要就得我们绕开 argv 走剪贴板。

需要你定（这是产品选择，不是技术问题）：

| 选项 | 行为 | 代价 |
|------|------|------|
| A 自动发送（pi 原生） | spawn 即开跑，路径最短 | AI 未经你过目就开始消耗 token、可能动文件 |
| B 剪贴板（回到旧方案） | 你自己 Cmd+V + 回车，有审阅机会 | 多两步、剪贴板会被后续复制覆盖 |
| C 默认 A + 设置项 B | 设置里给"拉起时仅复制到剪贴板" | 多一个开关，实现成本很小 |

**已定：默认 B（剪贴板），设置可切 A（自动发送）。**
理由成立：B 保留了"发出去之前我自己看一眼"的机会，而 A 一旦触发就开始烧 token、可能动文件。
副作用是首版 G1 的"零粘贴"主张要让位给"可控"——这是有意的取舍，度量口径已在 PRD 里改掉。

### 配套影响：默认 B 之后，"免选项目"变得更重要

B 模式下用户还要手动粘贴一次，如果每次都得先选项目，摩擦是叠加的。所以"免选项目直接执行"
（见 §9）应当与默认 B 一起做，而不是二选一。

### Q2 · `--name` 在 `pi -r` 列表里可见 ✅ 确定，但有实现代价

- `dist/core/session-manager.js:913-921` — `appendSessionInfo(name)` 往 jsonl 追加一条
  `{type:"session_info", name}`（会 sanitize 掉换行），**不是写进 header**
- `session-manager.js:515-517` — 读取时"取最新的 `session_info` 条目"（支持显式清空）
- `dist/modes/interactive/components/session-selector.js:390` —
  `const displayText = session.name ?? session.firstMessage`

**结论**：设过 `--name` 的 session，在 `pi -r` 列表里**显示的就是这个名字**；没设的显示首条消息。
这条完全支持"用 todo 标题命名 session"的方案。

**代价**：name 在文件后半段的 `session_info` 行里，
**只读首行 header 拿不到 name**。要显示名字/首条消息预览，就得像 pi 自己那样 readline 全量扫
（`buildSessionInfo` 就是这么干的，并且会拼出 `allMessagesText`——把整个对话正文读进内存）。
我们的取舍：

- ProjectIndex 只要 cwd → **继续只读首行**，快且不涉及正文；
- session 列表要名字 → adapter 全量读，**但只取 `name` / 首条 user 消息 / `messageCount` / `modified`，
  绝不缓存 `allMessagesText`**（隐私 + 体积）。缓存是派生的，随时可失效重建。

### Q3 · pi-durable 可以指定存储目录 ✅ 确定

`@earendil-works/pi-durable@1.3.0` 的 `dist/storage/`：

- `storage/jsonl/node.d.ts` — `openNodeJsonlStorage(directory: string, context, options?)`
- `storage/sqlite/node.d.ts` — `openNodeSqliteStorage(path: string, options?)`

**结论**：面板 Chat 的会话可以直接落在 `~/.ticktodo/panel-chat/`（JSONL 或 SQLite 任选），
不依赖 pi-durable 的默认约定，也不需要 `--session-dir`。
注：本机目前**没装** pi-durable（`node_modules/@earendil-works/` 下只有 `pi-coding-agent`），M2 需要装 1.3.0。

### Q4 · 本地扩展不必每次 `-e` ✅ 确定，且有更省事的通道

`dist/core/package-manager.js`：

- L2012 — `userDirs.extensions = join(globalBaseDir, "extensions")` → **`~/.pi/agent/extensions/` 是自动发现目录**
- L73 — extensions 资源匹配 `.ts` / `.js`
- `resolveLocalExtensionSource()`（L1067-1080）— 本地文件/目录源 `addResource(..., true)`，即**默认启用**
- L741-742 — 内置扩展由 settings 的 `extensions` 覆盖列表控制开关

**结论**：两条通道都行，**都不需要每次 `-e`**：

1. **推荐**：Tick 安装时把 `tick-extension` 复制到 `~/.pi/agent/extensions/`（自动加载，不碰用户 settings）；
2. `pi install <本地路径>` → 写进 `settings.json` 的 `extensions`，同样默认启用。

选 1 的理由：不修改用户 settings，卸载时删文件即可，不会和用户的扩展配置打架。
（本机 `~/.pi/agent/extensions/` 目前不存在，Tick 需要自己创建。）

### Q5 · pi 不做 git 根归并 ✅ 确定，归并是我们自己的事

`dist/core/session-manager.js:290-294`：

```js
function getDefaultSessionDirPath(cwd, agentDir) {
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolvedAgentDir, "sessions", safePath);
}
```

- 编码规则确认：**去掉首个 `/`，把 `/`、`\`、`:` 全替换成 `-`，前后加 `--`**（`:` 也替换 → 兼容 Windows 盘符）
- **一个 cwd 一个目录，pi 不会向上找 git 根** → 同仓库的 `proj/`、`proj/src/ui` 就是两个目录，
  Tick 侧要不要按 git 根归并，**是我们自己的产品决定**，pi 不帮忙
- 反解歧义确认存在（原路径里的 `-` / `:` 与分隔符同形）→ **必须以 header 的 `cwd` 为准**
- 顺带：`getDefaultSessionDir()`（L296-302）在目录不存在时会 `mkdirSync`，
  所以我们"试错式"访问不会留下垃圾，但**spawn 时 cwd 传错会凭空造出一个新项目目录**

---

## 9. 免选项目直接执行（第四轮）

### 9.1 先纠正一个前提：cwd 从来不是可选的

pi **没有 `--cwd`**（`pi --help` 全量确认），工作目录只能由进程继承。
所以"不选项目"的真实含义不是"没有 cwd"，而是"**cwd 的默认值从哪来**"。

可以不要"选择"这个动作，但不可能不要 cwd 这个事实。

### 9.2 三条免选路径

| 路径 | cwd 来源 | 是否需要用户操作 |
|------|---------|----------------|
| resume 已有会话 | **该 session 自己的 cwd**（adapter 读 header） | 零操作，最干净 |
| 新建会话 | 默认项目 = 最近使用的项目；无记录则 home | 零操作（除非要改） |
| 明确"与目录无关" | home | 显式点一次（pi 自己也这么做，本机 `--Users-jacky--` 下已有 12 个 session） |

**resume 那条是最优解**，值得单独说：已绑定 todo 上有 session，cwd 本来就在 session header 里，
adapter 一读就有——这种情况根本不该弹选择器，直接 resume 即可。

### 9.3 建议的默认值优先级

1. 已绑定 session 的 cwd（resume）
2. 用户显式选的项目
3. **默认项目 = 最近使用**；无记录 → home
4. 设置项「每次必问」→ 关掉免选（给不信任默认值的用户）

### 9.4 风险：cwd 错误的代价被低估了

- AI 会在错误的目录里读写（不是"跑错一次"那么轻）
- 更隐蔽的一条：`getDefaultSessionDir()` 会 `mkdirSync`——**cwd 传错会在 `~/.pi/agent/sessions/` 下凭空造出一个项目目录**，
  而且它随后会出现在 Tick 的项目列表里，污染推导结果

对策（已写进 PRD F4-a）：

- 主按钮**必须显示项目名**，如「在 **tick** 中打开 pi」，不隐式；
- 默认剪贴板投递保留最后一次人工审阅机会（**默认 B 与免选项目是互补的，不是二选一**）；
- 默认项目若 stale（目录已不存在）→ 自动退回最近可用项目并在按钮上提示。

### 9.5 待定

- Q7：默认项目取"最近使用"够不够准？要不要加"跟随前台 Finder / 编辑器目录"？
  macOS 上能拿到（`osascript` 取 Finder 的 insertion location，或 frontmost app 的文档路径），
  但引入 AppleScript 依赖与新 failure mode，建议**留到 P1 验证需求后再加**。
  → **项目转为选填后，Q7 从"延后"升为 P1**：默认值的准确度现在是主路径体验的决定项。

---

## 10. 第五轮：项目改为选填（D9）

用户拍板：**项目选填**（与"内容/描述选填"同级）。据此收口如下。

### 10.1 一个要分清的事实

| 说法 | 对不对 | 说明 |
|------|-------|------|
| "项目可以不选" | ✅ | 用户不必做选择这个**动作** |
| "可以没有 cwd" | ❌ | pi 无 `--cwd`，进程一定有工作目录 |

所以"选填"的实现含义是：**默认值必须可靠**，而不是"留空"。这也是为什么项目一变选填，
F3 项目索引就从辅助功能升级为主路径地基。

### 10.2 定案的优先级（写进 PRD F4-a）

1. 该 todo **已绑定 session 的 cwd**（adapter 读，权威值，resume 场景天然免选）
2. 该 todo 的 **`lastLaunch { toolId, projectPath }`** ← 本轮新增（第六轮从"只记目录"升级为"工具+目录"）
3. **最近使用项目**（ProjectIndex，stale 则跳到下一个）
4. home
5. 设置项「项目每次必问」= 开 → 跳过 2/3，强制走选择器

**为什么加 `lastLaunch`**：没有它，第 2 顺位会直接落到"全局最近使用"，
于是"为 A 任务选了 X 目录 → 再开 A 任务时却变成了 Y 目录"（因为中间用过别的），
这是选填方案最常见的抱怨。`lastLaunch` 记的是**用户意图**而非工具状态，
所以不违反 D7 的"不镜像 session 元数据"原则——session 被删后它依然有效。
（第六轮修正：只记目录不够，换过工具就白选了，故升级为 `{ toolId, projectPath }`。）

### 10.3 新增的两个设置项（首版只留这两个）

| 设置项 | 默认 |
|--------|------|
| 投递方式：剪贴板 / 自动发送 | 剪贴板（B） |
| 项目每次必问：关 / 开 | 关（免选） |

### 10.4 风险与对策（四条，PRD F4-a 已采纳）

1. **默认值必须可见**：按钮恒显示项目名，「在 **tick** 中打开 pi」——免选可以，隐式不行
2. **保留一次人工审阅**：默认剪贴板（B）。**默认 B 与项目选填是互补的，不是二选一**——
   两者都默认"不确认"，叠加起来摩擦是相乘的，安全兜底也是相乘的
3. **stale 自动降级 + 提示**：默认项目目录已删除 → 退回最近可用项目并说明，不静默跑错
4. **冷启动不阻塞**：ProjectIndex 后台扫、首帧用缓存（新增 Q8）

### 10.5 新增待定

- **Q8**：面板打开即需默认项目 → ProjectIndex 冷启动策略
  （建议：启动后台扫 + `projects.cache.json` 带 mtime 戳 + 首帧用缓存 + 缓存不可用退 home 并提示）
- Q7 升级为 P1（见 9.5）

---

### 还没答案的（2026-10-17 第十轮更新）

| # | 问题 | 状态 |
|---|---|---|
| ~~Q11~~ | 用量统计要不要进首版 | ✅ **已定：M3 只做单会话维度**，M4+ 再做汇总 |
| ~~Q6~~ | `~/.ticktodo` 是否同时承载数据与会话 | ✅ **已定：放一个目录 + 分层**（没采纳我"拆到 Application Support"的建议，见 14.1）+ **新增 F8 导出** |
| Q7 | 默认项目是否跟前台目录 | 升 P1，建议先不做（见 9.5） |
| Q8 | ProjectIndex 冷启动 | 建议缓存优先 + 后台刷新（见 10.5） |
| Q9 | git 根上卷默认开关 | **本机实测零差异**（9 条上卷后仍是 9 条）→ 默认开风险很低 |
| **Q13** | **同名目录消歧**（本机两个都叫 `pi`） | 🆕 本轮新增，比 Q9 更实际，见下 |
| ~~S5~~ | 反向建索引是否进首版 | ✅ **已定：首版做**，排进 **M3**（依赖 M1 的 `listSessions()` + M3 的绑定 UI） |
| ~~Q9~~ | git 根上卷默认开关 | ✅ **已定：默认开**（本机 9 条上卷后仍是 9 条，零差异） |
| ~~Q13~~ | 同名目录消歧 | ✅ **已定：降为 UI 实现约束**（见 13.2，用户指出"路径不同呀"——确实，只要不只用 basename 显示就没歧义） |

### 13.1 Q9 的实证答案：本机上卷前后都是 9 条

扫了本机 9 个项目目录 / 103 会话，逐个跑 `git rev-parse --show-toplevel`：

```
/Users/jacky/Desktop/pi        44 条   （非 git 仓库）
/Users/jacky/Projects/pi       26 条   （git 根就是自己）
/Users/jacky/.proma/…/workspace-file  13 条
/Users/jacky                   12 条   （home）
/Users/jacky/Desktop/Newbo      3 条
/Users/jacky/Desktop/tick       2 条
其余 4 条各 1 条（含 Downloads 下的临时目录）
```

**每个目录自己就是根，没有一条被收敛**。原因是实际习惯在仓库根开会话，
很少 `cd` 到子目录再开 → 上卷开着也没损失，还能防未来。所以 Q9 可以按"默认开"收口。

## 14. 第十一轮：Q6 / Q9 / S5 / Q13 四条拍板

### 14.1 Q6：一个目录 + 分层（我原建议被否，但分层把它救回来了）

我原建议拆到 `~/Library/Application Support/Tick/`，用户定的是**放一个目录，但做层级设计**，
并要求**支持导出 todo 关联 sessions 的记录**。

这个决定比我的更好：拆目录的真实诉求是"同步时能只取其一"，而**分层同样达得到**——
`data/`（可同步）/ `sessions/`（不建议同步）/ `cache/`（可再生）/ `exports/`。
用户只要同步 `~/.ticktodo/data/` 就行，不必把数据挪到系统目录里（那样反而更难找）。

代价是"一次性全同步"的默认值仍然有风险（整个 `~/.ticktodo` 进 dotfiles 会带走正文），
所以用自动生成的 `README.md` 在目录里写明每层用途来兜底。

**顺带新增 F8 导出**——这是 Q6 讨论里长出来的需求，我认为它比 Q6 本身更有价值：
导出的是**索引记录**（todo + 它绑定的 session，含 `filePath`、`exists`），**不含对话正文**。
给了 `filePath` 用户就能自己定位原始会话，这也是"不做网关、不复制文件"原则的延续。
导出结构里预留了再导入所需的全部字段（有 `filePath` 与 `sessionId` 就能反推绑定）。

### 14.2 S5 进首版，但排 M3 而不是更早

理由是依赖：S5 要"点一下就建好 todo 并绑定"，需要 M1 的 `listSessions()` 与 M3 的多会话绑定 UI。
提前做只能给一个只读列表，价值打折。验收加了 9 / 10 两条来卡它。

### 14.3 Q13 降到 UI 实现约束

用户一句"但是路径不同呀"是对的——路径本来就不同，**这不构成产品歧义**。
我把它当成了待拍板问题，其实它是"别只渲染 basename"的实现要求。
真正的实现价值在第二条：临时目录（`Downloads` 下 1 条会话）不该占主列表。

### 13.2 但扫出一个更要紧的问题 → Q13

**两条都叫 `pi`，而且都是高频**（44 / 26 条）。只显示 basename 时用户完全分不清。
另有一类噪音：`/Users/jacky/Downloads/小智AI教程最新教程下载电脑先解压文档 0826`（1 条）——
**Downloads 这类临时目录也会进项目列表**。

对策三条都不贵：① 条目显示父目录片段（`Desktop/pi` vs `Projects/pi`）；
② hover 给完整路径；③ 低频（≤1 条会话）+ 位于 `Downloads`/`tmp` 的默认折叠进「其他」。

这类问题只有真扫一遍真实数据才会发现，光看设计稿看不出来。

---

## 11. 第六轮：多 AI 工具下的项目索引分层

问题：接入第二个 AI 工具后，项目目录在层级上怎么设计？

### 11.1 结论：目录做主键，工具只做证据标签

项目（"我在哪个目录干活"）是**工具无关**的；session 才是工具私有的。
所以主键必须是 canonical 路径，**不能是 `(toolId, path)`**——
同一目录被 pi 和 claude 都用过时，用户心智里是一个项目，拆两条就是噪音。

由此定三层：

| 层 | 职责 | 不做的事 |
|----|------|---------|
| `ai/<tool>` adapter | 吐 `ProjectSource`：原始 cwd + 会话数 + 最近使用 | **不做归并、不做归一化** |
| `ai/core` | `mergeProjects()` 纯函数：归一化 → git 根上卷 → 按路径合并 → 排序 | 不依赖任何具体 adapter |
| main `ProjectIndexService` | 调度各 adapter、分段缓存、失效重建、IPC | 不含归并逻辑 |

### 11.2 三处会在第二个工具接入时炸掉的地方（现在就要改）

1. **`source: 'pi' | 'user'` 单值** → 语义冲突（pi 来源还是用户来源？）。改 `tools: string[]` + `pinned`。
2. **`Todo.lastProjectPath` 只记目录** → 换工具就白选了。改 `lastLaunch { toolId, projectPath }`。
3. **CwdResolver 直接拿 sessionId 去问 pi** → 单工具期的隐性假设。
   必须先 `registry.get(binding.toolId)` 再 `describeSession`。

### 11.3 排序要用 Tick 自己的时钟，不是工具的

各工具 `lastUsedAt` 口径不同（pi = jsonl mtime），且会偏斜：上周密集用 A、近三天只用 B，
`max()` 也排不对。所以 **`lastLaunchedAt`（Tick 拉起成功时回写）> adapter 的 `lastUsedAt` > 目录 mtime**。

**这条是 P0 就要做的**：第二个工具接入后再补历史就没有数据了，到时候跨工具排序永远不准。
代价只是一次回写，收益是唯一可对齐的跨工具时钟。

### 11.4 为什么归并不能留到 P2

原演进表把"跨工具项目合并"写在 P2（第 2 个 adapter 时）。
但 `mergeProjects` 从 P0 就按工具无关实现，成本几乎为零；留到 P2 的代价是：
P0 写的 `source` 单值、`lastProjectPath`、直接问 pi 的 CwdResolver **都要返工**，
而且用户已经积累的单工具数据模型要迁移。已把演进表 P2 改为"只新增 adapter，不动 core 与 UI"。

### 11.5 其他已定

- `canonicalPath` 集中在 core：realpath / `/private/var` / 大小写 / trailing slash / worktree（`.git` 为文件时不向上归并）
- git 根上卷**默认开**，保留 `children[]` 可细选（monorepo 自动收敛）→ 开放问题 Q9
- 类型留口：`ProjectRef = {kind:'dir'} | {kind:'remote'}`，别把项目写死成目录
  （第二个工具可能是云端/Web 型，没有 cwd 概念）

---

## 12. 第六轮：**不做网关，贴着 pi 自身的规范走**

你的三条定调 + 一个提问，逐条结论如下（完整实证见新增的 `RESEARCH-pi.md`）。

### 12.1 「不做网关，只借鉴设计方法，不脱离 AI 工具自身规范」——同意，并且有两条硬收益

不做网关不只是定位选择，实测上也不必要：**pi 自己就把 token/成本写在会话里**（12.3）。
我们原本以为"成本只有网关拿得到"，这条假设被推翻了。

### 12.2 D10 fork 不去重 —— 采纳，并按你的口径改

`SessionManager.forkFrom`（`session-manager.js` L1374–1414）证实：fork **复制源的全部非 header 条目**。
你拍板"本来就是两个会话，按真实" → **撤销**上一轮从 magpie 抄来的"按内容去重"建议。

只保留一条**记账**性质的处理（与去重无关）：fork 复制的条目含 usage，
所以「一个 todo 下所有会话用量求和」时会重复计一段。用 `parentSessionPath` 跳过继承段即可。
已在 `RESEARCH-magpie.md` §7-P0-4 标注撤销。

另外顺手纠正一个此前的字段误解：`parentSession` 是 **fork 血缘**（值 = 源会话**文件路径**），
与"子代理会话"是两回事——子代理是 `<session>/0-Explore.jsonl` 这类**独立子文件**，不在该字段里。

### 12.3 Q3：pi 会话里带 usage 吗？——**带，而且官方给了完整口径**

有。`docs/message-types.md` L67–90 定义 `Usage{input, output, cacheRead, cacheWrite,
cacheWrite1h?, reasoning?, totalTokens, cost{...}}`，原文 **"Assistant messages always contain
usage"**，本机实测 **9,389/9,389 条 100% 覆盖**。

官方要求 **五个来源求和**（只算 assistant 会漏）：assistant + toolResult（嵌套模型工作）
+ `type:"usage"` 条目 + `compaction.usage` + `branch_summary.usage`。

**顺带修正我上一轮的一个误判**：我曾据单条样例（`input 6498 + output 216 = totalTokens`）
推断"totalTokens 相加无意义、是每轮重发的上下文"。**错了**——全量统计后
`cacheRead` 占 98.9%（15.09 亿 / 15.25 亿），input 均值仅 1,278。
重发部分走的是缓存，被计在 cacheRead 而非 input。所以 `totalTokens` **可以相加**，
只是要能解释其中缓存占比；钱看 `cost.total`（本机 15.25 亿 tokens = $39.49）。

**另一个必须知道的坑**：`cost` 不是每个 provider 都上报（本机 magpie provider 470 万 token 报 $0），
所以它只能是**下限**，UI 上要标注，不能显示成实数。

### 12.4 D11 跨工具接手 —— 确认做，但**必须是有向矩阵**

pi 侧 `pi --fork <path|id>`（`--help` L30）+ `forkFrom(source, targetCwd)` 说明：
**cwd 可换** → "fork 到另一个项目继续"pi 原生支持（这条之前没注意到，比预想更强）。

但 `forkFrom` 要求源文件首行是 `type:"session"` header，否则抛错 →
**pi 读不了 omp 会话**，而 omp 能读 pi 的。所以接手是**有向**的，不能设计成任意互转。
adapter 改为声明 `carry: { acceptFrom, exposes }`，UI 只列可行方向。
**降级通道**：任何方向退化为"摘要作为首条消息投递"（摘要优先取 `compaction.summary`），保证不崩。

### 12.5 面板执行层候选：pi SDK vs pi-durable

读官方 `sdk.md` 发现 pi 另有进程内 SDK：`createAgentSession({ sessionManager })`，
`SessionManager.inMemory()` / 自管落盘，`AgentSessionRuntime` 还有 `fork()`、`importFromJsonl()`。
另：`cli-integration.md` 显示 pi 有 Interactive / Print / JSON / RPC 四模式 + `RpcClient`。

我当时的建议是走 SDK（共用同一包与 extension）。

### 12.6 **D13 你定了 pi-durable** —— 读完源码后我认为这个选择更好，理由是我此前低估了它

`packages/durable` 不是"会话存储库"，是完整的 **durable execution runtime**
（"Durable conversation, task, and document runtime for Pi"）。三条我此前没看到的白拿能力：

1. **内置 `pi.usage` document** —— 每个 conversation 自带 token/cost 账本，
   `harness.usage(ctx)` 汇总整个 Session。面板侧若要用量本来不用扫文件，
   但**按 D17 面板不统计用量**，所以这个 doc 我们不读（留而不用）；
2. **`harness.resume()`** —— 崩溃/重启后接着没跑完的 run 继续。
   这正是我担心的"SDK 进程内长会话要自己管生命周期"，durable 直接解决了；
3. **`requestId` 幂等** —— 同 id 重复提交返回既有 submission，正好配合 `create_todo` 防重复建单。

**两条必须写死的约束**：
- README 首行就是 **"Experimental. The API changes without notice between releases."**
  → **pin 1.3.0**，不能跟 latest，升级前跑集成测试；
- `engines: node >= 22.19.0` → Electron 的 Node 版本要满足。

### 12.7 意外收获：durable 官方独立印证了我们"fork 不继承用量"

`src/harness/usage.ts` 的 `UsageDoc` = `{kind:"pi.usage", scope:"conversation", history:"latest",
**fork:"initial"**}` → fork 出来的会话用量账本**从空开始**。
与我们 §12.2 的处理（跳过继承段）完全一致，等于官方背书。

同时它给出了**权威聚合实现** `addUsage()`：
`input/output/cacheRead/cacheWrite/totalTokens` 直加，
`cacheWrite1h` 与 `reasoning` **单独累加、不进 totalTokens**，`cost.*` 逐项加。
README 另有一句关键口径：**"Failed and aborted attempts count too"**。

### 12.8 用量计算已实现并验证（`scripts/session-usage.mjs`）

按官方 `addUsage` + 五个来源写的 Node 脚本，本机实测：

```
有效会话 103（另有 31 个 0 字节空文件）  扫描 1034ms
tokens 1,525,136,195（cacheRead 占 99.0%）  cost $39.4934（下限，1 个 provider 未上报）
自洽校验 totalTokens === input+output+cacheRead+cacheWrite → 103/103 通过
```

**交叉验证**：另写一份独立 Python 统计（不同实现、只算 assistant），
总量 **1,525,136,195 / $39.4934 完全一致** → 口径可信。

### 12.9 顺带挖到的物证：31 个 0 字节空会话

`~/.pi/agent/sessions/` 顶层 31 个 `.jsonl`，文件名是**纯 UUID**（无 `timestamp_` 前缀）、**0 字节**。
这就是我们讨论了三轮却一直没有实据的**僵尸绑定**的物证。
→ `verify()` 要加 `size === 0` 判定；列表要过滤。已写入 D16。

### 12.10 一个操作提醒

**本机 pi 是 1.2.0，官方已是 1.3.0。** 且官方 `session-format.md` 明确 session `version` 现为 3、
旧版本加载时自动迁移 → 我们的读取器**不能假设 version 恒为 3**。已写入 M0：开发前升级。

### 12.11 还剩待定

- **Q11**：用量统计进不进首版？（建议 M3 只做单会话维度、默认关）
- **Q12 已结案（D17）**：~~面板用量与 CLI 用量两套来源如何合并展示？~~
  → **面板 Chat 不统计用量**。用户口径："我们统计的都是 ai 工具每个对话自己的用量"。
  所以只有一个来源 = 工具侧会话文件，由 adapter 的 `computeUsage()` 负责；
  取消我上一轮设计的 `source: 'cli' | 'panel'` 统一层。

  这个修正比我原方案更对：面板一轮对话和 pi 里一段会话不是同一种东西，
  把它们相加得到的数字无法解释。durable 虽然有 `pi.usage` doc，**有但不读**。
  连带：不做跨工具总账（token 口径与 provider 单价不同），汇总只在同一工具内做。
- 遗留待验：durable 在 Electron 内的 SQLite/JSONL 写权限与并发（面板与 extension 同时写）

---

## 15. 第九轮：**默认项目 = 主目录 ~**（D18）+ Q8 照抄 magpie 的取数机制

### 15.1 D18：默认 cwd 落到 home，不再"猜最近使用"

用户口径：*"默认项目就是：不选具体 cwd 就是用户本机的根目录 ~"*。

F4-a 优先级因此从「已绑 session → `lastLaunch` → **最近使用** → home」改为
「已绑 session → `lastLaunch` → **home**」，"最近使用"降级为设置项里的可选项。

**这条比我原来的"最近使用"更好，理由是可预期性**：

| | 最近使用（原） | home（现） |
|---|---|---|
| 性质 | **猜测** | **确定的兜底** |
| 猜错时 | 用户不知道自己跑在哪个目录，也没有预期它会变 | 用户一眼知道"我没选，所以在主目录" |
| 依赖 | `lastUsedAt` 排序、git 根归并、stale 检测的质量 | 无依赖，永远存在 |

本机实测佐证了"home 多数时候不是想要的目录"：103 会话里只有 12 条在 home（11.6%）。
**但"明确地不是"好过"自以为猜对了"** —— 后者正是我在 D9 里自己担心的
"我明明选过 X 目录，怎么变成 Y 了"的放大版。

配套三处：

1. `CwdResolver` 返回值加 `source: 'session' | 'lastLaunch' | 'home'`，UI 据此渲染按钮文案；
2. 兜底时按钮显示「在 **主目录 ~** 中打开 pi」，**不能只写"打开 pi"**（可以免选，不可以隐式）；
3. 设置项"默认项目"改成三态：主目录（默认）/ 最近使用 / 每次必问——
   **仍是两个开关**，没有新增设置项。

### 15.2 一个连带后果：Q7 可以彻底结案了

我此前把 Q7（默认项目是否跟随前台 Finder 目录）**升到 P1**，理由是"项目选填后 F3 的准确性
直接决定默认项目准不准"。默认改成 home 之后，这个前提消失了：
**默认值不再依赖任何猜测**，F3 只服务于"选择器候选"与 S5 数据源。

于是 Q7 按**不做**结案——跟随前台目录还要引入 osascript 依赖与新的失败模式，收益不成立。

### 15.3 Q8：照抄 magpie 的取数与冷启动（已读源码，不是猜）

读了 magpie 的 `sessions/discovery.go`、`sessions.go`（`refresh`/`loadCache`/`saveCache`/`List`）、
`quiet.go`、`call_cache.go`，完整实证写进 `RESEARCH-magpie.md` §7。四条照做：

| 机制 | 出处 | 落到 Tick |
|---|---|---|
| 目录列表缓存 + **2s racy 窗口** | `discovery.go:26` `racyDirectory` | `verify()` 必须绕缓存直读（与 PRD 验收 4.3 同源） |
| 文件级 `(size, mtime)` 增量 | `sessions.go:757` | 已有；消失的条目要主动从缓存删除 |
| **Warm / Ask 两级调度** | `quiet.go`：`quietReaders() = NumCPU/4` | 首帧用缓存 → 后台低优先级扫 → 用户打开选择器即提速 → 扫完 IPC 推送 |
| checkpoint 落盘 | `sessions.go:878` `checkpointEvery = 5s` | 我们规模小（≈1s）可扫完即存，**接口预留** |

**最有价值的是 Warm/Ask**，它来自一个真实事故（#1665）：8.9 GB 会话预热用了 ~40s CPU、
占满所有核 15 秒，用户投诉"每次启动 CPU 就满"。解法是**预热没人等就慢慢来（1/4 核），
一旦页面真的在等就立即全速**。这条对我们 Electron 完全适用，而且现在量小、以后可能变大，
**接口必须按两级预留**，否则将来重蹈覆辙。

不抄的：64 路 IO 锁、分片 gob 缓存、16384 条上限直接清空、`zone` 时区戳——
都是为"解析全文 + 按日聚合"服务的，我们只读首行，用不上。

### 15.4 一个独立印证（关于僵尸会话）

`List()` 的注释（#1320）：*"an empty file is not a session"*，
空会话要被丢弃并让后面的补位。我们此前扫出的 **31 个 0 字节 jsonl** 正是同一现象——
**僵尸会话是真实存在的，不是我们的解析误判**。

### 15.5 开放问题清零

至此 Q1–Q13 全部结案，S5 已定进 M3，F8 已定。**没有阻塞项，可以开工 M0。**
