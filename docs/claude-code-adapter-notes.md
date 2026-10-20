# Claude Code / Claude Desktop 适配器笔记

> **证据文档**（不是规范）。规范性要求见 `docs/rules/agent-tool-adapter.md`。
> 记录两个新适配器的实测事实、依据等级、未验证项与复测方法。
> 所有本机实测时间为 **2026-10-19**，环境：macOS（Apple Silicon）/ Claude Code CLI `2.1.302` /
> Claude Desktop `1.46388.4`（`/Applications/APP/Claude.app`，bundle `com.anthropic.claudefordesktop`）。

## 0. 一句话结论

| 项 | 结论 | 依据等级 |
| --- | --- | --- |
| CLI 会话存储 | `~/.claude/projects/<编码 cwd>/<uuid>.jsonl`，**没有首行 header** | 官方文档 + 本机实测 |
| CLI 预填输入框 | `--prefill=<text>`（原生，不发送、不落盘） | 本机实测（2.1.302） |
| CLI 直接发送 | 位置参数 `claude "prompt"`；`-` 开头用 `--` 分隔 | 官方文档 + 本机实测 |
| CLI resume | `claude --resume <会话文件绝对路径>` | 官方文档 + 本机实测（TTY 与 `-p` 均通） |
| Desktop 会话（adopt 的 CLI 会话） | **与 CLI 同一份 jsonl**（同一引擎）；正文 `entrypoint` 仍为 `cli`/`sdk-cli`，靠 Desktop 记录里的 `cliSessionId` 关联（双入口见 §3.4） | 官方文档 + app.asar + 本机真实数据 |
| Desktop 自己的会话 | 通常每会话一个 `.claude` home：`<userData>/<kind>/<acct>/<org>/local_<id>/.claude/projects/…`；**正文也可能落全局 store**（见 §3） | app.asar `iFt`/`Gti` + magpie + 本机真实数据 |
| Desktop 新建页 | `claude://code/new?folder=<绝对路径>&q=<URL 编码文案>` | app.asar 逐条核对 |
| Desktop 回到 CLI 会话 | `claude://resume?session=<CLI 会话 UUID>` | app.asar 逐条核对 + 本机 `open` 成功 |
| Desktop 继续最近会话 | `claude://code/continue?session=last` | app.asar 核对（本适配器未使用） |
| Desktop 已登录判定 | `~/Library/Application Support/Claude/{local-agent-mode-sessions,config.json}` 存在 | 本机实测 |

## 1. CLI 会话文件格式（2.1.302 实测）

一份 4.4MB / 800+ 行的真实会话（`44a09b90-…`）行类型分布：

```
assistant 283 · user 182 · attachment 156 · api-request-blob 118 · api-request 108
permission-mode 67 · mode 67 · last-prompt 67 · atis-latch 67 · system 48 · ai-title 47
file-history-snapshot 24 · cost-state 1 · api-request-shape 1
```

要点：

1. **没有 header 行**（与 pi 的 `{"type":"session",…}` 完全不同）。第一行是
   `{"type":"mode",…}` 或 `{"type":"queue-operation",…}`；`cwd` 出现在**第一条带 `cwd` 的
   user/assistant 记录**上。所以 `listSessionInfos` 必须流式扫到第一个可用 cwd，
   不能像 pi 那样「只读首行」。目录名不反解（超过 200 字符会被截断 + 哈希）。
2. **同一条 assistant 消息会写多行**：285 条 assistant 记录只有 **109 个不同的
   `message.id`**（`apiBlockIndex` 分块 + 续写）。逐行相加会把 token 放大 ~2.6 倍。
3. **`cost-state` 是成本与 token 的权威快照**（每轮结束写一行累计值）：
   ```json
   {"type":"cost-state","totalCostUSD":12.9257,"hasUnknownModelCost":true,
    "modelUsage":{"deepseek/deepseek-flash[1m]":{"inputTokens":274695,"outputTokens":89153,
      "cacheReadInputTokens":18498432,"cacheCreationInputTokens":0,"costUSD":12.85}}}
   ```
   键带 provider 前缀与窗口后缀（`[1m]`），**与 `message.model`（`deepseek-flash`）不同名**。
   所以 `byModel` 的键必须用快照里的模型名，不能拿 `message.model` 当键去 merge。
4. `ai-title`（自动生成，可能重复多行）与 `custom-title`（`--name` / `/rename`）都给标题；
   实测 `--name` 会**同时**写 `custom-title` 与 `agent-name`，且出现在第 1–2 行。
5. 合成消息的识别：`isMeta:true`（本地命令输出/注入上下文）、`isCompactSummary:true`
   （压缩摘要）、`isSidechain:true`（子代理）。`<command-name>` / `<local-command-stdout>`
   包装出现在 `message.content` 字符串里。
6. `entrypoint` 取值实测：`cli`（终端）、`sdk-cli`（`-p` / SDK）。Desktop 写
   `claude-desktop` / `claude-desktop-3p`（见 §3）。

## 2. CLI 拉起语义（实测）

| 用法 | 结果 |
| --- | --- |
| `claude --session-id <uuid>`（TTY） | 用指定 UUID 开会话；**未发消息前不落盘**（TTY 下等信任确认时也不落盘） |
| `claude --session-id <uuid> "prompt"`（TTY） | 立刻落盘，文件就是 `<uuid>.jsonl`，首条 user 就是 prompt |
| `claude --session-id <uuid> --prefill="text"`（TTY） | 文本已填在输入框（`TICK-PREFILL-PROBE please review` 实测可见），**没有 unknown option、不落盘**；多行/中文/引号/emoji 均原样传入 |
| `claude --session-id <uuid> --prefill="x"`（`--deep-link-origin` 前缀） | 同上 |
| `claude --session-id <uuid> -- "-dash"`（TTY） | 无 `unknown option` 报错（`--` 生效） |
| `claude --resume <jsonl 绝对路径>`（TTY） | 直接接上原会话（`Accessing workspace` + 原会话上下文，无 `No conversation found`） |
| `claude -p --resume <jsonl 绝对路径> "…"` | 成功返回 `result:"resumed"`，`session_id` 仍是原 id |
| `claude --desktop --resume <id>`（非 TTY） | 报 `--desktop opens the Claude Desktop app and can't run non-interactively`；TTY 下本机因 OAuth 方式（`oauth_token`）报 `--desktop requires signing in with a Claude account`（官方文档：`--desktop` 需要 Claude 订阅登录，API key 不行） |

**未验证**：`--prefill` 与 `--session-id` 组合下，用户回车后落盘的文件名是否仍是该 UUID
（本机所有探针都在发送前退出；按 `--session-id` 的语义应当如此，但**没有实测证据**）。
所以 `launch()` 的 `verified` 在 prefill 投递下恒为 false → `LaunchService` 写 `pending`
绑定并由后台 `reconcilePending()` 对账，不依赖这个假设。

## 3. Desktop 与 CLI 共用会话（关键设计事实）

官方文档（`/docs/en/desktop`，Coming from the CLI）：

> Desktop runs the same underlying engine … Each keeps its own session list … Desktop continues
> the same session rather than a copy, so `claude --resume` in the terminal still finds it afterwards.

app.asar（`1.46388.4`）里的 `importCliSession` / `adoptCliSession` 实现进一步确认：

- 它按 `cliSessionId` 去 `~/.claude/projects/<project>/<cliSessionId>.jsonl` 找正文
  （`resolveProjectDirForSession`），并把 transcript **原地 adopt**（不复制）；
- Desktop 自己的会话 id 是 `local_<uuid>`，但 `cliSessionId` 字段就是 CLI 的 UUID；
- 深度链接 `claude://resume?session=<uuid>` 会先 `importCliSession(uuid)` 再跳转。

因此：

1. 全局 store 里两个适配器**读同一份 jsonl**，只能靠 `entrypoint` 区分（`claude-desktop` /
   `claude-desktop-3p`）。`@tick/ai-claude` 的 `ClaudeAdapter` 默认**排除** Desktop 会话，
   `@tick/ai-claude-desktop` 只收 Desktop 会话——保证**同一个 `toolId` 内**不会重复列。
   注意：被 Desktop adopt 的 CLI 会话会同时出现在两个工具里，这是 as-built 的**已知设计**
   （见下面第 4 条），不是重复列。
2. **两套 id 各自有用途**：
   - `local_<id>`（Desktop 自己的会话）→ `claude://code/continue?session=local_<id>`；
   - CLI uuid（被 adopt 的会话）→ `claude://resume?session=<uuid>`。
   Tick 的绑定 id 就是这两者之一，`resume` 按 id 形状路由；列表里两者都出现，互不覆盖。
3. 会话记录 `<acct>/<org>/local_<id>.json` 给出的字段（[测] asar，[三] magpie 同名）：
   `sessionId`（= `local_<id>`）、`cliSessionId`、`unarchivedCliSessionId`、
   `preClearCliSessionId`、`priorCliSessionIds`、`title`、`isArchived`、`cwd`、
   `createdAt`、`lastActivityAt`。归档会话（`isArchived=true`）**深链接打不开**
   （asar 的 `$9t()` 只找非归档），所以列为 `resumable=false`。
4. **as-built：adopt 会话双入口（已知设计，不是 bug）**。被 Desktop adopt 的 CLI 会话正文仍在
   全局 `~/.claude/projects`，Desktop 侧另有一条 `local_<id>` 记录（`cliSessionId=<CLI uuid>`）。
   于是**同一对话**会同时出现在「倒入历史会话」的：
   - `claude`：id = CLI uuid，回到会话走 `claude://resume?session=<uuid>`；
   - `claude-desktop`：id = `local_<id>`，回到会话走 `claude://code/continue?session=local_<id>`。

   两者**互不覆盖**是刻意的：保留 Desktop 入口必须靠双 id。`(toolId, sessionId)` 唯一性仍成立
   （两条绑定的 id 不同），不会跨工具误路由。代价是项目会话数会在两个工具之间各计一次
   （`mergeProjects` 求和后看起来多 1）；UI 侧如要消歧应按 `filePath` 去重或标注「同一会话的
   Desktop 入口」——本轮未做 UI 去重。

**Desktop 原生会话的正文位置**（2026-10-21 复核，取代早期「Desktop 自己的会话不在全局 store」的结论）：

- `app.asar` 的 `iFt(base, sessionId)` 把会话 home 解析成 `<base>/<sessionId>`，`Gti()` 对
  `kind === 'code'` 同时看 `<sessionHome>/.claude/projects` 与全局 `~/.claude/projects`；
  `kind` 目录是 `claude-code-sessions`（Code tab）/ `local-agent-mode-sessions`（Cowork）。
- magpie（`internal/sessions/calls.go` 的 `callDesktopDirs()`、`desktop_titles.go`）读的正是
  `<userData>/local-agent-mode-sessions/*/*/local_*/​.claude/projects/**`，并把会话记录
  `<acct>/<org>/local_<id>.json` 当标题与 id 映射的来源。
- **本机真实数据推翻了「Desktop 自己的会话不在全局 store」**（1.46388.4，3 条 `local_*`
  记录 / 2 条可列会话）：其中 `local_9be1a786-…` 的 per-session home **不存在**，正文就在
  全局 `~/.claude/projects/-Users-jacky-Desktop-tick/3cbd37d2-….jsonl`，22 条记录
  `entrypoint` 全是 `claude-desktop-3p`、记录里也没有 `adoptedFromOtherSurface`。
  所以「Desktop 写过的会话一定有 per-session home」不成立，正文可能落在任一位置。

因此 `claude-desktop` 适配器**两套都读**：每会话 home（id = `local_<id>`）+ 全局 store 里
`entrypoint` 属于 Desktop 的正文。全局 store 的正文如果有对应记录（`cliSessionId` 命中文件名
uuid）仍归一成 `local_<id>`（与 UI 一致），只有**没有任何记录**的才用 CLI uuid。
MCP 侧的 `createClaudeDesktopLocator` 也按同一优先级找（先 home、再按
`record.cliSessionId === 文件名 uuid` 认领全局 store），避免同一对话在 UI 与回扫侧得到两个 id。
结构夹具见 `scripts/selftest-prefill.ts`，真实样本见本机上述路径。

## 4. Desktop 深链接（asar 逐条核对）

来自 `app.asar` 的 `claudeURLHandler`（`.vite/build/index.chunk-CMJVFTis.js`）：

| URL | 行为 | 备注 |
| --- | --- | --- |
| `claude://code/new?folder=<abs>&q=<enc>` | Code tab 新建页，`folder` 选项目、`q` 预填输入框 | `q`/`prompt` 都认；`q` 在 Desktop 侧按 **14336 码元** slice（`OA=14336`）；`folder` 有值时加 `src=external`；**不发送** |
| `claude://resume?session=<uuid>` | 把 CLI 会话导入并打开 | session 必须是 UUID（`_F` 正则）；失败 toast 分 `auth_expired` / `network` / `transcript_missing` / `other` |
| `claude://code/continue?session=last` | 继续最近一条 Code 会话 | `session` 也接受 `local_<id>` |
| `claude://code/needs-input?session=<id>` | 打开等待输入的那条 | 只认 Desktop 自己的 `local_` id |
| `claude://code/<cse\|session>_<id>` | 打开云会话（bridge viewer） | 与本地会话无关 |

工程结论：

- `open` 恒 exit 0，失败只能在 App 里以 toast 表现 → **调用前必须自己校验**
  （App 装了 / 会话 jsonl 在本机 / 已登录过），否则用户只会看到一句英文 toast。
- URL 过长会静默失败（LaunchServices 限制）→ Tick 侧先按码点截断到
  `DESKTOP_URL_MAX=12000` 并如实返回 `truncated`；极端情况下 `folder` 本体就超长时返回
  `overLimit` / 失败原因，不发一条注定被丢弃的链接。
- 不降级到别的 scheme（`claude-cli://` 是**另一个** handler，见 §5）。
- **隐私**：`claude://code/new?folder=…&q=<全文>` 会把 todo 文案与项目路径交给
  LaunchServices / Claude.app 处理，可能出现在系统或 App 日志；Tick 自身不记录这些内容
  （与 WorkBuddy task 深链接同口径）。

## 5. `claude-cli://` 是另一条通路（本适配器未使用）

官方文档 `/docs/en/deep-links`：CLI 自己注册 `claude-cli://open?q=&cwd=&repo=`，由一个
`~/Applications/Claude Code URL Handler.app` 处理，**在终端里**开一个新的 Claude Code 会话并
预填 prompt（同样不发送）。注册发生在「第一次在交互式会话里发消息之后」。

它与 `--prefill` 的区别：走 LaunchServices + 用户默认终端，Tick 无法控制窗口/会话 id。
本实现选 `--prefill`，因为 Tick 已经自己生成终端脚本（`cache/launch/*.command`），
能确定性控制 cwd、argv 与会话 id，不需要依赖用户是否注册过 handler。

## 6. 未验证项 / 已知风险

| 项 | 状态 | 影响 |
| --- | --- | --- |
| `--prefill` + `--session-id` 回车后是否沿用该 UUID | 未验证 | prefill 下 `verified=false` 是设计内的（pending 对账），不影响正确性 |
| Desktop 自己的会话存储 | 2026-10-21 本机有真实样本（3 条 `local_*` 记录 / 2 条会话；正文可能落 per-session home，也可能落全局 store，见 §3） | 结构已由 asar + magpie + 真实数据三方印证；极端字段变体仍可能漏列 |
| Desktop 的 MCP clientInfo 名称 | 未验证 | `createClaudeDesktopLocator.matches` 只认 `claude-desktop`，不确定时回扫会跳过它（不会误绑） |
| `--prefill` 的最大长度 | 未验证 | 本实现上限 200KB（超限明确报错，不截断用户内容） |
| `--name` + `--session-id` + `--prefill` 三者组合 | 未验证（只实测过 2.1.302 的 `--name` 与 `--prefill` 单项） | 旧版本 CLI 若没有 `--name`，launch 会以 `unknown option` 失败（Tick 冒泡成可读错误；不做版本门控，也未做自动降级重试） |
| 会话保留期 | 官方 30 天（`cleanupPeriodDays`） | 文件消失按 `exists=false` 表达，不猜 |
| 多账号 / `CLAUDE_CONFIG_DIR` 切换 | 只测了默认根 | 根解析走 env，切账号后需重开面板（`detect` 有 30s 缓存） |

## 7. 复测方法（不需要写代码）

```bash
# 1) 会话文件格式：确认没有首行 header、cwd 在哪一行
jq -c 'select(.cwd!=null) | {type,cwd,sessionId,entrypoint}' \
  ~/.claude/projects/*/*.jsonl | head -3

# 2) 预填是否生效（会开一个 TUI；确认输入框里有文本后 Ctrl+C 退出）
claude --session-id "$(uuidgen | tr A-Z a-z)" --prefill="复测预填 $(date +%s)"

# 3) resume 是否认绝对路径
claude --resume ~/.claude/projects/-Users-jacky-Desktop-tick/<uuid>.jsonl

# 4) Desktop 新建页（应打开 Code tab 且项目/文案已填，不发送）
open "claude://code/new?folder=$PWD&q=复测"

# 5) Desktop 打开 CLI 会话（应出现该会话，或至少不报 transcript_missing）
open "claude://resume?session=<cli-uuid>"

# 6) 用量口径自洽：adapter 的结果应与最后一条 cost-state 快照一致
jq -s '[.[]|select(.type=="cost-state")]|last|{totalCostUSD,mu:.modelUsage}' \
  ~/.claude/projects/*/<uuid>.jsonl
```

## 7.5 本文件用到的外部实现

- **magpie**（yetone/magpie，Go）的 `internal/sessions/claude.go`、`claude_usage.go`、
  `calls.go`、`desktop_titles.go`：Claude Code 的行模型、`<synthetic>`、修订覆盖、
  `summary` 标题兜底、Desktop 每会话 home 的布局。它是**第三方实现**（非官方契约），
  但与 `app.asar` 的结论一致，故并列引用；它**不做** Desktop 深链接，深链接部分仍只有 asar 证据。
- 更完整的跨工具会话检索对照见 `docs/agent-session-storage-map.md`。

## 8. 与 pi 适配器的差异一览

| 维度 | pi | Claude Code |
| --- | --- | --- |
| 首行 header | 有（`type:"session"`） | **没有**（流式找第一个 cwd） |
| 会话 id 来源 | header `id` + 文件名 `<ts>_<uuid>` | 文件名 `<uuid>` + 记录 `sessionId` |
| 预填投递 | 扩展 `setEditorText` + 一次性文件 + ack | 原生 `--prefill=`（无 ack） |
| 会话名 | `session_info.name` | `custom-title` / `ai-title` |
| 用量 | 逐行累计（fork 继承段要跳过） | 按 `message.id` 去重 + `cost-state` 快照 |
| 成本可信度 | 由 provider 上报决定 | 快照 `hasUnknownModelCost` |
| 桌面形态 | 无 | 独立工具 `claude-desktop`（同一份 jsonl，深链接） |
