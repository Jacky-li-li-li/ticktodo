# 各家 AI 编码工具的会话检索对照表（调研笔记）

> **证据文档**（不是规范）。目的：给 Tick 接新适配器时先看这里——每个工具的会话存在哪、id 怎么来、
> cwd/标题/用量从哪读、能不能 resume。
> 主要来源：**magpie**（yetone/magpie，Go，2026-10 主分支）的 `internal/sessions/*.go` 读取器
> + 各工具官方文档 + Tick 本机实测（见 `docs/claude-code-adapter-notes.md`、
> `docs/workbuddy-adapter-notes.md`）。
> 等级标注：**[官]** 官方文档明确；**[三]** 第三方实现佐证（magpie）；**[测]** 仅本机逆向/实测。

> 想决定「下一个接哪个、要不要改合同、哪些不建议接」→ 看 `docs/multi-agent-adapter-plan.md`（分档 + 合同扩展清单）。

## 0. 一句话对照

| 工具 | 会话存放 | 一会话一文件？ | id 来源 | 能 resume？ | Tick 状态 |
| --- | --- | --- | --- | --- | --- |
| Kimi Code | `~/.kimi-code/sessions/<wd slug>/session_<uuid>/{state.json,agents/main/wire.jsonl}` + `session_index.jsonl`（cwd） | 一会话多 agent 文件 | 目录名 `session_<uuid>` | `kimi --session <id>` | ✅ 已接入（117 条实测） |
| OpenCode | `~/.local/share/opencode/opencode.db`（`session` 行自带 tokens/cost/model） | 否（数据库行） | `session.id`（`ses_…`） | `opencode --session <id>` | ✅ 已接入（61 条实测） |
| ZCode | `~/.zcode/cli/db/db.sqlite`（OpenCode 同表 + `model_usage`） | 否（数据库行） | `session.id` | 无（桌面，只读） | ✅ 已接入（18 条实测，`resumeSession=false`） |
| pi | `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` | 是 | 首行 header `id` | 终端 `--session <path>` | ✅ 已接入 |
| Claude Code | `~/.claude/projects/<enc cwd>/<uuid>.jsonl` | 是 | 文件名 + 记录 `sessionId` | 终端 `--resume <path>` | ✅ 已接入 |
| Codex | `~/.codex/{sessions/<y>/<m>/<d>,archived_sessions}/rollout-<ts>-<threadId>[_seg].jsonl[.zst]` | **否**（一个 thread 可多文件） | 文件名里的 thread id | `codex resume <id>` | ✅ 已接入（`files[]`） |
| Cline | `~/.cline/data/sessions/<id>/{<id>.json,<id>.messages.json}` | 是（两份文件） | 目录名 / manifest `session_id` | `cline --id <id>` | ✅ 已接入 |
| Grok Build | `~/.grok/sessions/<url-enc cwd>/<id>/{summary.json,updates.jsonl}` | 是（目录） | 目录名 / `info.id` | `grok --resume <id>` | ✅ 已接入 |
| omp | `~/.omp/agent/sessions/<enc cwd>/<ts>_<uuid>.jsonl`（首行是 `title`，不是 header） | 是 | 文件名 | `omp --resume <id>`（cwd=~ 时加 `--allow-home`） | ✅ 已接入 |
| Qoder / Qoder CN | `~/.qoder[ -cn]/projects/<enc cwd>/<id>.jsonl`（Claude 同格式） | 是 | 文件名 + 记录 `sessionId` | `qodercli[cn] --resume <id>` | ✅ 已接入（本机未装） |
| Claude Desktop | ①`<userData>/{claude-code-sessions,local-agent-mode-sessions}/<acct>/<org>/local_<id>/.claude/projects/…` ②全局 `~/.claude/projects`（adopt 的 CLI 会话） | 是 | ①`local_<id>` ②CLI uuid | 深链接 `claude://code/continue?session=` / `claude://resume?session=` | ✅ 已接入（Desktop 自有会话 + adopt 的 CLI 会话） |
| Cursor CLI | `~/.cursor/chats/<md5(cwd)>/<chat id>/store.db`（SQLite blob） | 否（库） | 目录名 / meta 行 | `cursor-agent --resume` | 未接入（T4，不建议） |
| WorkBuddy（国内 / 国际） | `~/.workbuddy[ -ai]/projects/<enc cwd>/<id>.jsonl` + `workbuddy.db` 索引 | 是（+ DB 行） | DB 行 id = 文件名 | 深链接 `workbuddy[ -ai]://chat/<id>` | ✅ 已接入（`workbuddy` / `workbuddy-ai`） |
| Factory Droid | `~/.factory/sessions/<enc cwd>/<id>.jsonl` + `<id>.settings.json` | 是 | 首行 `session_start` | `droid --resume` | 未接入（T2 候选） |
| Hermes | SQLite 聚合表 | 否 | 表内 id | — | 不建议（只有聚合表，无逐会话） |

## 1. 对本项目直接有用的四条结论

1. **「Claude Code 家族」是一族，不是一个工具**：Qoder（`qoder` / `qoder-cn`）、WorkBuddy 的
   jsonl、以及 Claude Desktop 的会话 home 都复用同一套 `projects/<enc cwd>/<id>.jsonl` +
   `type:user/assistant` + `ai-title`/`custom-title` 的格式（[三] magpie 把它们都交给同一个
   `ccFiles`/`claudeFull` 读取器）。所以 **`@tick/ai-claude` 的解析层几乎可以直接复用**给
   Qoder 之类的工具，只要换数据根与会话 id 边界。
2. **同一个工具的两套 id 空间是常态**：Claude Desktop 用 `local_<id>`，它 adopt 的 CLI 会话
   用 uuid；Codex 一个 thread 可能续写成多个 rollout 文件；OpenCode 用数据库行 id。
   Tick 的 `(toolId, sessionId)` 二元组能容下，但 **resume 必须按 id 形状路由**（as-built：
   `claude-desktop` 就是这么做的）。
3. **cwd 一律从记录里读，不从目录名反解**：Claude 系目录名是「非字母数字换 `-`」且超 200 字符
   会截断+哈希；Grok 是 URL 编码；Cursor 是 `md5(cwd)`；Kimi 是 slug。目录名只用于「猜文件在哪」，
   权威值永远是记录字段。
4. **用量口径必须按工具分别写**，不能套一个公式：Claude 系是 `message.id` 去重 + 修订覆盖；
   pi 是逐行累计且 fork 要跳过继承段；Codex 的 input 已含 cache、且 `token_count` 是累计值；
   WorkBuddy 的 usage 在 `providerData.usage` 且「一次回复只报一次」；Droid 直接给会话级总数。

## 2. 每个工具的检索细节

### Claude Code（CLI）——`claude`

- 路径 `~/.claude/projects/<enc cwd>/<uuid>.jsonl`；`<enc cwd>` = 路径里非字母数字换 `-`，
  超 200 字符截断并追加哈希（[官] `/docs/en/sessions`、`/docs/en/claude-directory`）。
- **没有首行 header**；`cwd` 在第一条带 `cwd` 的记录上，所以必须流式扫到第一个可用值（[测]）。
- 子代理：`<uuid>/subagents/*.jsonl`（[三] magpie 读作 `main:false`、共用父会话 id）；
  工作流代理在 `<uuid>/subagents/workflows/<run>/agent-*.jsonl`，同目录的 `journal.jsonl`
  **不是**会话正文。
- 标题：`custom-title`（`/rename`、`-n`）> `ai-title`（自动）> `summary`（压缩摘要）（[三][测]）。
- 用量：一条 assistant 消息按 block 写多行，需按 `message.id` 去重；**同一 id 的后一版是修订**，
  以最后一条为准；`model === "<synthetic>"` 不计（[三] magpie `claude.go`/`claude_usage.go`；
  [测] 本机 285 行 / 109 个 id）。另有 `cost-state` 累计快照（[测]），Tick 优先用它。
- 合成消息过滤：`isMeta`、`isCompactSummary`、`isSidechain`，以及正文命中 `@tick/ai-core` 的
  注入白名单（`isInjectedUserText`：`<environment_context>`、`<local-command-*>`、`<command-*>`、
  `[Request interrupted by user…]`、`Caveat: The messages below were generated` 等）或 Claude 特有的
  `<ide_opened_file>` / `<ide_selection>` / `<ide_diagnostics>` 包装的（[三] magpie `ccPrompt`；
  [测] 2026-10-21 统一到 core 白名单后真实 7 条会话 first/last 无回退）。
- resume：`claude --resume <transcript 绝对路径>`（[官][测]）。

### Claude Desktop——`claude-desktop`

- **两套存储**（[三] magpie `calls.go` / `desktop_titles.go` + [测] app.asar `iFt`/`Gti` 互相印证）：
  1. Desktop 自己的会话：`<userData>/<kind>/<acct>/<org>/local_<id>/.claude/projects/…/<uuid>.jsonl`
     ——每个会话一个**完整的 `.claude` home**；`kind` 是 `claude-code-sessions`（Code tab）或
     `local-agent-mode-sessions`（Cowork）。
  2. 被 adopt 的 CLI 会话：正文仍在 `~/.claude/projects`（**entrypoint 仍是 `cli`/`sdk-cli`，Desktop 不重写**），Desktop 侧记录里 `cliSessionId=<CLI uuid>`；因此同一对话会在 `claude`（uuid）与 `claude-desktop`（`local_<id>`）下各列一次（双入口，见 notes §3.4 / rules §2 例外）。
- 会话记录 `<local_<id>.json>`：`sessionId`（= `local_<id>`）、`cliSessionId`、
  `unarchivedCliSessionId`、`preClearCliSessionId`、`priorCliSessionIds`、`title`、`isArchived`、
  `cwd`、`createdAt`、`lastActivityAt`（[三] magpie；[测] app.asar `adoptCliSession` 写入同名字段）。
- 深链接（[测] app.asar，本机 `open` 返 0 但未验证 UI 落地）：
  `claude://code/continue?session=local_<id>`（只认 `local_[A-Za-z0-9-]{1,64}` 或 `last`，
  **只找非归档会话**）、`claude://resume?session=<uuid>`（导入 CLI 会话，失败分
  `auth_expired`/`network`/`transcript_missing`）、`claude://code/new?folder=&q=`。

### Codex——已接入（`codex`）

- `~/.codex/{sessions/<y>/<m>/<d>,archived_sessions}/rollout-<ts>-<threadId>[_seg].jsonl[.zst]`：
  `session_meta` 行给 thread id/cwd/来源，`turn_context` 每轮给模型，`token_count` 事件给**累计**总量与
  上一次调用的用量（[三]）。
- 同一个 thread 恢复后可能写到**另一个** rollout 文件 → 一个会话多文件，必须按 thread id 归并，
  不能按文件建会话；as-built 已扩 `SessionSummary.files` 并在列表层归并成一条（`filePath` 指向最新文件）。
- `input` 已包含 cache token（pi/Claude 的 `input` 不含），口径必须单独写。
- **as-built 两点**（2026-10-21 修复轮）：① `role=user` 里大量是**工具注入**——`<environment_context>`/
  `<turn_aborted>`/`<subagent_notification>`/`<skill>`/`<recommended_plugins>`/`<codex_internal_context …>`/
  `# AGENTS.md instructions` 等（本机 1117 条 user 文本里 226 条），首条消息/标题必须按**已知标签白名单**过滤，
  不能只滤 `<…>` 一种；② `archived_sessions/` 里的归档会话 as-built 给 `resumable=false`（行为收紧：
  未实测 `codex resume` 对归档 id 的行为，不提供可能失败/静默新建的入口）。

### OpenCode——已接入（CLI + Desktop 共用一份数据）

- 2026-10-20 读上游源码（`anomalyco/opencode`）核实：**桌面端是 Electron 外壳，跑的是同一个 opencode CLI**——
  `packages/desktop/src/main/service/background-service.ts` 用随包的二进制起 `opencode serve --service` 当 sidecar，
  生产环境**不覆盖** `XDG_DATA_HOME`（只有测试 root 才改），所以桌面端与 CLI 共用
  `~/.local/share/opencode/opencode.db`、同一批 `ses_…` id；`sessions.workspace_id` 实测全为 null，
  也没有 `entrypoint`/client 列 → **无法按客户端归属**，拆两个适配器只会把同一条会话列两次。
- 桌面端（1.19.3）源码里能解析**两个深链接**：`opencode://open-project?directory=` 与
  `opencode://new-session?directory=&prompt=`（`?prompt=` + session handoff）。**但实测不可用**：
  - App 主进程日志会打 `deep link received via open-url`（说明 URL 到了 App），但 renderer 没有处理：
    发一个指向**全新目录**的 `open-project` 后，`opencode.global.dat`（`layout.projects`）没有任何变化；
    `new-session` 也不改路由/草稿；
  - 原因：`handleDeepLinks` 的 `onMount` + `opencode:deep-link` 监听只挂在**旧布局**的 shell 上，
    1.19.3 默认 `newLayoutDesigns=true`（`default.dat`），新布局没有挂这个监听；
    `opencode://` 的 receiver 只是把 URL 转发成 window CustomEvent，没人接就丢了。
- **没有按会话打开的协议**（不存在 `opencode://session/<id>`），深链接也不可用 → 桌面版只能
  **激活 App + 文案进剪贴板**，回到会话只能打开 App 让用户自己点；`opencode --session <id>`（TUI）
  打开的是同一份数据，是唯一能精确定位的通路。
- 因此适配器声明 `capabilities.clients = ['desktop','cli']`：两个入口都是「打开 + 复制」，差别只在
  GUI / 终端；新建默认桌面版（`open -a` 能把它从隐藏/别的 Space 叫回来），回到会话默认 CLI（能定位）。
  用户在新建页选择后会写 `settings.toolClients.opencode` 并同时作用于两者。
- 教训：**「源码里有解析函数」不等于端到端可用**。判定一个深链接可用必须看 App 侧的可观测状态
  （库/设置/路由落盘），不能只看主进程日志。
- 桌面端 packaged 构建会把自带 CLI 安装到 **`~/.opencode/bin/opencode`**（不在 PATH）→ 可执行探测要兜底这里；
  更老的桌面构建（本机 1.19.3）没有装这个副本，App 内的服务在 Electron 主进程里跑。所以「装没装」还要看
  **App bundle `ai.opencode.desktop`**（本机在 `/Applications/APP/OpenCode.app` —— 嵌套目录，静态目录查不到，
  必须 mdfind 兜底）；只有桌面版时数据仍可读，但没有 CLI 就不能按会话打开（Tick 已实现这条降级）。
- **实测一次「CLI 会话 vs 桌面会话」的对照**（2026-10-20，同一小时各开一条）：
  | | CLI 会话 | 桌面会话 |
  | --- | --- | --- |
  | 会话行 | `ses_…` cwd `/Users/<me>`，`path=Users/<me>`，project=`global` | `ses_…` cwd `…/Desktop/<repo>`，`path=""`，project=git 仓库 hash |
  | DB 字段 | 同 schema、`workspace_id=null`、无客户端标记 | 同上 |
  | 输入历史 | `~/.local/state/opencode/prompt-history.jsonl` | `~/Library/Application Support/ai.opencode.desktop/drafts.sqlite`（`opencode.global.dat:prompt-history`） |
  | UI 状态 | 无 | `opencode.window.*.dat`（tabs）/ `opencode.workspace.*.dat`（model-selection、followup）/ drafts |
  | Tick 表现 | 列表/详情/用量/resume 完全一致 | 完全一致 |
  结论：**唯一的差别在 UI 侧的历史与 tab 状态**，会话本体没有客户端归属字段；`path` 是「相对项目根的子目录」
  （在项目根就是空串），不是客户端标记。
- 结论：**一个 `opencode` 适配器**（同一份数据、同一批 id），入口用 `capabilities.clients` 表达：
  `prefillDelivery` 只描述 CLI 分支（terminal-copy）；桌面分支是 deeplink 预填，不另立一个工具。

### OpenCode（旧记录）

- 1.2 起是 SQLite（`opencode.db`：`session`/`message`/`part` 表，message 与 part 是 JSON 文档），
  旧版是 `storage/` 下的 JSON 文件；有数据库时只读数据库（[三]）。
- 子代理是**独立 session**，父 id 指回调用者，用量归到父会话（[三]）。
- 需要 `node:sqlite`（Tick 已有先例：WorkBuddy 用 `DatabaseSync` 只读打开 + 试读一次）。

### Cursor CLI——未接入

- `~/.cursor/chats/<md5(cwd)>/<chat id>/store.db`：两表（`meta`/`value`），meta 行是十六进制
  编码的 JSON（`agentId`/`name`/`createdAt`/`lastUsedModel`/`latestRootBlobId`，子代理另有字段）（[三]）。
- cwd 只能从 `chats/<md5>/` 反查已知工作目录，或读 meta；**不能**从目录名直接解码。

### pi——已接入

- `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl`，首行 header 给 id/cwd/timestamp/parentSession；
  `$PI_CODING_AGENT_SESSION_DIR` / settings `sessionDir` 可覆盖成「所有会话平铺一个目录」（[测]）。
- 子代理正文在 `<session>/<0-name>.jsonl`；顶层的 0 字节 `<uuid>.jsonl` 是僵尸，**size=0 不算产生**。
- 用量逐行累计（assistant / toolResult / `usage` / compaction / branch_summary 五类来源），
  fork 的继承段要跳过（[测] 本项目 `scripts/session-usage.mjs` 已自洽校验）。

### WorkBuddy（国内 / 国际）——已接入（`workbuddy` / `workbuddy-ai`）

- `~/.workbuddy[ -ai]/projects/<enc cwd>/<id>.jsonl` + `workbuddy.db` 的 `sessions` 行；
  目录名编码 = 去开头 `/`，其余 `/ \ :` → `-`，**空格保留**（[测]）。
- 消息是 OpenAI Agents SDK 的 item（`message`/`function_call`/…）；用户原文包在
  `<user_query>` 里（可能带外层 `<system-reminder data-role=…>`），合成消息由
  `providerData.isMeta`/`isCompacted`/`startsNewUserRequest` 区分（[测]）。
- 用量在 `providerData.usage`，按 `providerData.messageId` 一次回复只报一次（[三]）。
- 桌面应用：没有任何终端 resume，只能深链接（[测]）。

### Factory Droid——未接入

- `~/.factory/sessions/<enc cwd>/<id>.jsonl`（旧版直接放 sessions 根），首行 `session_start`
  给 id/title/cwd/父会话/调用者；`<id>.settings.json` 里有会话级 `tokenUsage`（**一个会话一个总数**，
  不是逐调用）——按 Tick 的 `SessionUsage` 能对，但不能算时间线增量（[三]）。

### Grok Build——已接入（`grok`）

- `~/.grok/sessions/<url 编码 cwd>/<session id>/summary.json`（id/cwd/创建时间/生成标题/
  `parent_session_id`/`session_kind`）+ `updates.jsonl`（事件，时间戳**秒**）（[三]）。
- cwd 目录名是 URL 编码，但**权威值在 summary.json**。
- as-built：`session_kind=subagent` 的子代理会话不列；`num_messages=0` 且无 `updates.jsonl` 的空会话也过滤。

### DeepSeek Harness (dsh)——已接入

- `$DSH_HOME/sessions/<project>/<session dir>/session[.v<N>].jsonl[.zstd]`：**每批追加一个 zstd 帧**，
  本机最大文件 10MB → 23,331 帧 / 26MB 解压；`session.v<N>` 是新代际，老文件留在原地，只读最新。
- 首行 header：`{type:"session", id, createdAt(ms), cwd, delegationDepth, parentSession?}`；
  **目录名与 id 不一定相同**（本机两种都有），所以 id 取 header。
- 事件：`{type, seq, time, data}`。用户输入是 `user/message` 且 `data.source.kind === "user"`
  （其余 `agent-instructions` / `plugin` / `skill-catalog` / `subagent-settled` 都是注入）；
  标题是 `session/title`；模型与用量在 `assistant/message` 的 `data.usage`
  （`inputTokens` 不含 cache、`outputTokens` 含 reasoning，另有 `reasoningTokens`）。
- **投影缓存** `storages/session_projcache/sessions/<dir>.json`：`record.rows.<key>.val`
  里已有 `title` / `sessionListMetadata.lastPromptAt` / `tokenUsage.totals` / `subagent`，
  所以列会话与用量**不用碰正文**（这是 dsh 自带的能力，不是我们推算的）。
- 子代理：`delegationDepth > 0` + `parentSession`；**缓存里没有父 id**，要读子会话首帧才知道父是谁。
- **不能回到会话**：`dsh://` 只处理 `dsh://open`（聚焦主窗口），官方也没有按 id 恢复的命令。
- **MCP 回扫不支持**：`probe-scan` 只做「原始字节里找句柄」，而 dsh 的正文是压缩帧，句柄不会以字面量出现。
  要支持得给 `SessionLocator` 加一个「按工具解容器」的钩子（当前没有），所以 dsh 的会话只能手动倒入。
- as-built（`packages/ai/dsh`）：列表读投影缓存 + 首帧 + 前 32 帧快路径（首条 user / 模型），
  39 条会话首次 121ms、缓存后 26ms；`describeSession` 才整份解帧（最大 26MB / 23k 帧，~0.36s）；
  子代理用量加回父会话；`resumeSession=false`。

### Qoder / Qoder CN——已接入（`qoder` / `qoder-cn`）

- `~/.qoder[ -cn]/projects/<proj>/<id>.jsonl`，**与 Claude Code 同格式**（user/assistant +
  Anthropic usage + `ai-title`/`summary`），子代理在 `<id>/subagents/agent-<id>.jsonl`（[三]）。
- as-built：`@tick/ai-qoder` 只声明身份（数据根 + `resume` 参数 `qodercli[cn] --resume <id>`）并复用
  `@tick/ai-claude` 的解析内核；它没有原生预填参数，新建入口走 `prefill` + `terminal-copy`（终端 + 剪贴板）。

### Cline——已接入（`cline`）

- `~/.cline/data/sessions/<id>.json`（manifest：cwd/开始时间/首条 prompt/标题）+
  `<id>.messages.json`（**整份重写**，不能按追加读）（[三]）。
- 子代理是父会话目录里的 `<agent id>.messages.json`。

### Hermes / 其它

- Hermes 的 SQLite 是**聚合表**（`session_model_usage` 等），不存逐请求用量；只能给会话级总量。
- magpie 还读了 MiniMax、Kimi、DeepSeek Harness（zstd 帧）、zcode、agy、alma、dsh 等——共同规律：
  **越新的工具越倾向 SQLite 或「整份重写」的文件**，按「只追加的 jsonl」写读取器会踩坑。

## 2.5 本机实测快照（2026-10-20，`node scripts/verify-agent-stores.mjs`）

> 下表是 2026-10-20 的**当日快照**；会话数会随使用增长（2026-10-21 复跑：pi 135 / claude 6 / claude-desktop 2 /
> opencode 63 / dsh 41）。实时数字与证据分级以 `pnpm verify:agents` 输出为准（IMPL / STORE / NOT-INSTALLED / NO-SESSIONS）。

| 工具 | 实测 | 说明 |
| --- | --- | --- |
| pi | 119 条会话 | 目录/header/用量与文档一致 |
| Claude Code | 5 条 | 无首行 header、`--prefill` 已实测 |
| Claude Desktop | 1 条 `local_…`（`Claude-3p/claude-code-sessions/<acctUuid>/<orgUuid>/`） | **adopt 的 CLI 会话**：记录 `adoptedFromOtherSurface:true`，正文仍在全局 store（不在每会话 home）——这条真实数据推翻了我最初「local_ 一定有独立 home」的假设，适配器已加全局兜底 |
| Codex | **151 条**（147 active + 4 archived） | 文件名即 thread id（151/151），`token_count` 累计值口径与文件逐字对得上 |
| Cline | 1 条 | manifest + `messages.json`；用户文本在 `<user_input mode="act">` 里 |
| Grok | 2 条（都空会话，无 `updates.jsonl`） | 只能验 `summary.json` 与目录布局；消息/用量的口径仍只有 magpie 证据 |
| omp | **52 条**（交叉评审修正：原先 161 条里有 109 个是会话目录里的**子代理 transcript**；2026-10-21 又 +1 条在 `--private-tmp--/`） | 首行是 `{"type":"title"}`（不是 header）→ pi 的「只读首行」在这里会失败；主会话只认 `<ts>_<uuid>.jsonl`（子代理文件叫 `ExploreUsageCode.jsonl` 之类）。**cwd=~ 时 omp 会自动切到临时目录**（实测记成 `/tmp`，会话被归到 `/tmp` 项目）→ Tick 在 home 启动/恢复时必须补 `--allow-home`。官方格式里 `title` 物理记录才是**当前标题**，`title_change` 只是 append-only 审计 → 解析要以 title 记录为准（**样本**：2026-10-21 共 53 条，其中 2 条能验证「title 记录更新更晚」；若某版 omp 只 append `title_change`，走兜底取最后一条） |
| Kimi | **117 条** | `state.json` **没有 cwd**；cwd 来自 `session_index.jsonl` 的 `workDir`；子代理在 `agents/agent-N/`，主对话在 `agents/main/` |
| OpenCode | **61 条**（`session` 表 75 行，14 行是子代理） | **session 行自带 token/cost/model**，不必读 message 表就能出用量；`tokens_reasoning` 要并入 output；**子代理用量不在父行里**（8 个根会话带子会话，其中 1 个父 < 子之和）→ 必须自己加回；44% 的 user text part 是 `<system-reminder>` 注入，必须过滤 |
| ZCode | **18 条** | 同表结构但 `session` 行**没有** token/cost 列 → 用量取 `model_usage`（含重试行）；**6/18 个根会话没有 model_usage 行**（message 里有 tokens）→ 需要 message 兜底；子代理用量同样要加回；**没有 resume 通道** |
| **dsh** | **39 条**顶层会话（80 个目录，41 个是子代理） | 10MB 文件含 **23,331 个 zstd 帧**；`zstdDecompressSync` 只解第一帧、`createZstdDecompress` 一次 `end()` 也只解第一帧 → 必须按 zstd 块头自己切帧（Tick 已实现，0.49s/26MB）。**列会话不需要解压正文**：标题/cwd/`lastPromptAt`/`tokenUsage.totals` 都在 dsh 自己的投影缓存里（39 条列表 121ms）；子代理用量是独立的，要加回父会话 |
| Alma | db 存在（19MB） | `chat_threads`/`chat_messages` |
| Droid / CodeBuddy / Cursor / Qoder | 无数据/未安装 | 按 magpie 设计；Cursor 目录都不存在 |

## 3. 落地到 Tick 时该怎么做（判据）

1. **接新工具前先回答四个问题**：会话是文件还是库？一个会话是否可能多文件（Codex）或多会话
   共用一文件（无）？id 的权威源在哪（文件名/记录/DB）？能否 resume，走什么通道？
2. **合同层面**：现有 `SessionSummary/SessionInfo` 假设「一文件一会话、`filePath` 可定位」。
   接 Codex（多 rollout 一 thread）或 OpenCode/Cursor（DB）之前，需要先扩 `ai/core`
   （例如允许 `filePath` 指 DB、增加 `threadId`/`childOf` 语义），不要在 adapter 里硬塞。
3. **解析层复用**：Claude 家族的格式（Claude Code / Qoder / WorkBuddy 的 jsonl / Desktop 的
   home）可以共用 `@tick/ai-claude` 的 `readSessionMeta` / `computeUsageFromFile`；
   其它格式各写一个纯函数模块，保持「只读 + 不缓存正文」。
4. **永远不要**：从目录名反解 cwd、把 `size=0` 当产生、把子代理消息并进主会话、
   把「整份重写」的文件当追加流读、用文件 mtime 推断完成状态。

## 4. 本机可核对的样本

```bash
# Claude Code：无 header、cwd 在第一条带 cwd 的行
jq -c 'select(.cwd!=null) | {type,cwd,sessionId,entrypoint}' ~/.claude/projects/*/*.jsonl | head -3

# 同一条 assistant 消息多行（去重前/后行数）
f=$(ls -t ~/.claude/projects/*/*.jsonl | head -1)
echo "lines: $(wc -l < "$f")  unique message ids: $(jq -r 'select(.type=="assistant")|.message.id' "$f" | sort -u | wc -l)"

# Claude Desktop：会话记录与每会话 home（需登录并使用过 Code tab / Cowork）
find ~/Library/Application\ Support/Claude -maxdepth 5 -name 'local_*.json' | head
find ~/Library/Application\ Support/Claude -maxdepth 8 -path '*/.claude/projects/*' -name '*.jsonl' | head

# WorkBuddy / pi / Codex 的会话根存在性
ls ~/.pi/agent/sessions 2>/dev/null | head -3
ls ~/.workbuddy/projects 2>/dev/null | head -3
ls ~/.codex/sessions 2>/dev/null | head -3
```
