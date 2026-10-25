# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

Ticktodo（包名 `tick`）是 macOS 菜单栏常驻的置顶面板：以 Todo（线索）为索引，把同一件事在不同 AI 工具里的多个 AI 会话聚合起来，并能一键回到任意会话继续。面板内置一个基于 pi-durable 的 Chat，用来自然对话并让模型调用 `create_todo`。

适配器已有**十五个实装**（清单与能力位见「当前状态」）：其中只有 `pi` 与 Claude Code CLI（`claude`）能预生成会话 id（`newSessionMode='launch'`）；两个 WorkBuddy（`workbuddy` / `workbuddy-ai`）与 Claude Desktop（`claude-desktop`）是**桌面工具适配**：只读本地数据库/会话文件，只能经深链接回到已有会话，新建走 `newSessionMode='prefill'` + `prefillDelivery='deeplink'`（打开 GUI 新建页并预填，发送/绑定仍由用户完成）；其余 CLI（Qoder / Codex / Cline / Grok / omp / Kimi / OpenCode）走 `prefill` + `terminal-copy`（打开终端 + 文案进剪贴板，不自动发送），ZCode / DeepSeek Harness 是 `none`（只能倒入历史会话）。2026-10-19 起不再做版本校验（装了就开放 prefill / 新建页，版本差异由真实调用失败暴露）。

- 仅 macOS；全仓 TypeScript；Electron 44（内置 Node 24，满足 pi-durable 的 Node ≥ 22.19 硬约束）。
- 权威设计：`README.md`（功能/操作细节）、`docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`。设计文档与代码冲突时，以 as-built 代码为准并同步文档。

## 常用命令

```bash
pnpm install                              # 首次；.npmrc 固定 node-linker=hoisted，勿改 isolated
pnpm dev                                  # 根脚本：先 build tick-extension，再起 Electron（vite dev 5173）
pnpm typecheck                            # 全仓 tsc --noEmit
pnpm verify:agents                        # 逐工具核对「会话检索」真实数据（IMPL/STORE/NOT-INSTALLED/NO-SESSIONS；只读，不吞错）
pnpm review:tool <toolId>                 # 单工具只读探针（detect/list/describe/usage/resume argv），交叉评审用
pnpm selftest:prefill                     # 预填/多工具边界 selftest（esbuild 临时打包 TS 断言，不启动 Electron）
pnpm selftest:update                      # 应用内更新状态机/编排 selftest（不启动 Electron、不联网）
pnpm selftest:timeline                    # 会话时间线（digest 归一 / 三适配器证据 / 派生缓存）selftest
pnpm mcp:check                            # MCP server 回归（真实 stdio 客户端；Tick 未运行时回扫/只读/限流）
pnpm build                                # 全仓构建（desktop = tsc --noEmit + vite build）
pnpm --filter @tick/desktop dev           # 只起桌面 app（不重建 extension）
pnpm --filter @tick/tick-extension build  # esbuild 单文件 → packages/tick-extension/dist/index.js
pnpm --filter @tick/desktop dist:dir      # 本地快速出 .app（apps/desktop/release）
pnpm --filter @tick/desktop dist          # electron-builder 出 dmg/zip（正式发版用 release-local.sh）
bash scripts/install.sh [Tick.app|Tick.dmg]  # 本地安装；不传参则安装 GitHub 最新 Release
UNSIGNED=1 bash scripts/release-local.sh  # 无签名试构建；正式发版去掉 UNSIGNED（签名+公证+SHA256SUMS）
node scripts/session-usage.mjs --top 20   # 按 pi 官方口径统计会话用量（只读，不碰正文）
```

环境与发布约束：

- 宿主 shell 可能带 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy shell 常见），会让 Electron 以 Node 模式启动；`pnpm dev` 已 unset，直接跑 vite 时也要先 unset。
- 不要在 `~/Desktop` 等 iCloud 同步目录里做签名构建（codesign 报 detritus / 静默挂起）；用 `git worktree add ~/tick-build <ref>` 到别处构建。
- 发版时根 `package.json` 与 `apps/desktop/package.json` 版本必须一致，tag 为 `v<version>`；`scripts/install.sh` 与 `site/install.sh` 必须逐字节一致。
- `site/**` 推到 main 会触发 GitHub Pages 部署（`.github/workflows/pages.yml`）。

## 架构

### 进程与信任边界

```
Renderer (React, 无 Node)
   │  window.tick（preload contextBridge 白名单）
Main (Electron，全部服务与凭据)
   ├─ TodoStore / SettingsStore / CredentialVault
   ├─ services: launch · chat-host · project-index · sessions · export
   │            terminal-launch · provider-config · update
   └─ AiToolRegistry → 15 个适配器（pi / workbuddy / workbuddy-ai / claude / claude-desktop / qoder×2 / codex / cline / grok / omp / kimi / opencode / zcode / dsh）
packages/shared   类型 + IPC 通道常量（main/preload/renderer 单一来源）
packages/ai/core  工具无关合同 + 纯函数（不得依赖任何具体 adapter）
packages/ai/*     十五个适配器（只吐证据，不做归并/缓存/UI）
```

组合根是 `apps/desktop/src/main/main.ts`：resolveDirs → ensureDirs(0700) → TodoStore → 装配 adapter/索引/拉起/Chat → 窗口 → IPC → 载入 UI。新增 IPC 通道必须同时改四处：`packages/shared` 的常量、`main/ipc.ts`、`preload/index.ts` 白名单、renderer 的 hook。

### 包分层

- `@tick/shared`：Todo / SessionBinding / CliSessionId / AppSettings 等领域类型与全部 IPC 通道常量。UI 层不反向依赖 ai 包，所以品牌类型 `CliSessionId` 定义在这里。
- `@tick/ai-core`：`AiToolAdapter` 合同、`AiToolRegistry`、`canonicalPath`、`mergeProjects`、`gitRootOf`、会话命名空间。纯函数、无 Electron 依赖。
- `@tick/ai-pi`：CLI 工具的参考实现（合同完整语义：detect / 会话目录解析 / listSessionInfos / describeSession / computeUsage / launch / resume / verify；`probe-exe.ts` 负责 GUI 最小 PATH 下的可执行文件定位）。新增 CLI 工具照它写。
- `@tick/ai-workbuddy`：WorkBuddy 国内版适配器（`workbuddy`），同时是**两个发行版共用的只读读取内核**：`paths.ts`（App bundle / 数据根 / cwd 编码 / jsonl 定位）、`sqlite.ts`（`workbuddy.db` 只读 + WAL 复制兜底 + schema 探测）、`transcript.ts`（jsonl 流式解析 + `<user_query>` 抽取）、`base-adapter.ts`（detect / list / discover / describe / resume / launch）、`adapter.ts`（国内版身份常量）。
- `@tick/ai-workbuddy-ai`：WorkBuddy AI 国际版适配器（`workbuddy-ai`），只声明自己的身份常量（App bundle / bundle id / 数据根 / scheme / playground 策略），读取内核复用上一个包。两个发行版是**两个独立工具**：两个 toolId、两份缓存、互不共用配置（国内版吃 `WORKBUDDY_CONFIG_DIR`，国际版不吃）。
- `@tick/ai-claude`：Claude Code CLI 适配器（`claude`）。`paths.ts`（`CLAUDE_CONFIG_DIR` / `~/.claude/projects` 解析、`<uuid>.jsonl` 定位、流式元数据）、`usage.ts`（按 `message.id` 去重 + `cost-state` 快照成本）、`adapter.ts`（detect / list / describe / verify / launch / resume）。CLI 拉起纪律同 pi，但**预填用原生 `--prefill=`**（无需一次性文件与 ack）；resume 用 `--resume <会话文件绝对路径>`。
- `@tick/ai-claude-desktop`：Claude Desktop（Code tab）适配器（`claude-desktop`）。只声明身份（App bundle `com.anthropic.claudefordesktop` / scheme `claude://` / `prefill` 策略），读取内核复用 `@tick/ai-claude`——Desktop 与 CLI **共用同一份 jsonl**，靠正文 `entrypoint`（`claude-desktop` / `claude-desktop-3p`）与 Desktop 记录里的 `cliSessionId` 区分（adopt 会话双入口见「当前状态」）。新建走 `claude://code/new?folder=&q=`（prefill），回到会话走 `claude://resume?session=<CLI 会话 UUID>`。
- `@tick/tick-extension`：pi 扩展 `create_todo` / `list_todos`。领域逻辑只有 `src/todos-file.ts` 一份；`src/index.ts`（coding-agent `registerTool`）与 `src/durable.ts`（pi-durable `defineTool`）是两套不通用 API 的薄适配。esbuild 打包成单文件，因为 pi 用 jiti 在无 node_modules 的目录里执行它；`dist/` 不进 git，首次需 build。
- `@tick/todo-core`：`todos.json` 的**唯一写实现**（锁/原子写/损坏备份/fail-closed/幂等/绑定冲突）。Main 的 `TodoStore` 与 pi extension 都只是它的薄适配；改锁语义只改这里。
- `@tick/session-locators`：只读 locator（`pi` / `workbuddy` / `workbuddy-ai` / `claude`），只回答「扫哪个目录、命中文件里的 sessionId 是什么」，不 import Electron。
- `@tick/probe-scan`：MCP 句柄（`tk_`）的 probe 写入/过期/回扫；命中后写 verified 绑定。MCP server 与（P1）Tick main 共用。
- `@tick/mcp-server`：stdio MCP server（3 个 v1 工具 + resources；`dist/tick-mcp.mjs` 单文件，打包进 app 的 `Resources/mcp/`）。
- `@tick/ui`：玻璃材质与设计令牌的唯一来源；desktop 的 `styles.css` 只保留布局/业务 class。材质、按钮和焦点环规范见 `packages/ui/README.md`。
- `@tick/storage`：预留空包，不要往里加逻辑。

### 两条会话通路（不要混）

1. **CLI 拉起**（pi 的主路径）：`LaunchService` → `newSessionMode='launch'` 的 adapter → `createTerminalLauncher` 生成 `cache/launch/*.command` → `open` 交给 Terminal。launch 预生成 UUID，绑定先写 `pending`，main 每 5s 调 `reconcilePending()` 在会话文件出现后转 `verified`。桌面工具（`newSessionMode='prefill'`）没有这条通路：`launch()` 直接抛错，`resume` 走各自深链接。
2. **面板 Chat**：`ChatAgentHost` 用 pi-durable `Harness` + JSONL storage 落 `sessions/panel-chat/`，注入 `TickDurableExtension`。凭据默认只读 pi 的 `auth.json`（不抢锁、不写），或使用自配 OpenAI 兼容 provider。

面板会话与 CLI 会话是**命名空间隔离**的两套存储；面板 Chat 不参与用量统计，也永不被 resume。

### 数据层（`~/.ticktodo`，`TICK_HOME` 可覆盖）

| 目录 | 语义 |
|---|---|
| `data/` | 可同步、致命：`todos.json`、`settings.json`（损坏先备份 `.corrupt-<ts>` 再继续） |
| `sessions/panel-chat/` | 面板对话正文，不建议同步 |
| `cache/` | 可再生：`projects.json`、`window-state.json`、终端脚本、预填一次性 prompt/ack 文件（`launch/*.prefill.json*`，0600，扩展读后即删；App 启动清理 >1h 的 prefill、>24h 的 command）、时间线派生证据 `session-digests.json`（只存证据 + 文件指纹，状态每次现算）；删掉必须不影响功能 |
| `exports/` | 手动导出产物（JSON + Markdown，只有索引，无正文） |

**凭据纪律**：`~/.ticktodo` 下不存在任何 Key。自配 provider 的 Key 经 Electron `safeStorage` 加密后存 userData（`~/Library/Application Support/Tick/credentials.json`），不降级明文。

### 数据流

- **项目索引**：每个 adapter 的 `discoverProjects()` 只贡献原始证据（cwd → 会话数/最近时间），不做归并；`mergeProjects` 做 canonicalPath 归一化 + git 根上卷 + 合并排序；`ProjectIndexService` 负责调度、`cache/projects.json` 落盘与叠加 Tick 侧状态（`lastLaunchedAt`、手动 pin、失效目录 alias），单个工具读取失败只丢它自己的证据。UI 首帧只读缓存，后台扫完通过 `projects:updated` 推送。
- **Todo 多写方**：Main 的 `TodoStore`、pi 扩展、MCP server 都会写同一份 `todos.json`，三边都走 `@tick/todo-core`（唯一锁/原子写实现）；不要再实现第二套。Main 用 `fs.watch(data/)` 感知其他写方的写入并推 `todos:changed`。
- **会话绑定**：`Todo.bindings[]` + `primarySessionId` 是 Tick 唯一持久化的会话关系；`cwd`、`name`、`firstMessage`、`lastMessage`、`exists` 等元数据一律向 adapter 现问，不落镜像。列表/绑定/回到会话都按 `binding.toolId` 路由到对应 adapter（不同工具的会话 id 空间互不相干，不做全局反查猜工具）；`tools:status` 的展示名统一来自 `@tick/shared` 的 `TOOL_DISPLAY_NAMES`。
- **时间线摘要（P0-1..P0-6，2026-10-25 落地）**：adapter 的 `SessionInfo` 只吐可选证据（`lastUserMessage / lastUserMessageAt / lastEventAt / endedCleanly / running`），core 的 `deriveSessionState` / `buildSessionDigest` 做状态归一与截断（`SESSION_ACTIVE_WINDOW_MS` = 10 分钟、`SESSION_DIGEST_TEXT_MAX` = 4000）；`SessionService.forTodo` 把 digest 拼进视图并按 `lastActiveAt` 倒序（`missing` 置底、`primary` 只加徽标），`recentForTodos` 服务首页线索行。派生缓存只在 `cache/session-digests.json` 存「证据 + `(mtimeMs, size, lastUsedAt)` 指纹」，状态每次按当前时钟重算——不要在缓存里存 `active/done` 判定结果。

## 必须保持的不变量

1. **锁只有一份**：`packages/todo-core/src/index.ts` 是 `todos.json` 的唯一锁/原子写实现（`<todos.json>.lock`、`<pid>:<uuid>`、5s 陈旧锁）。Main 的 `TodoStore` 与 pi extension 都只是它的薄适配。历史上两边锁名不同导致并发 240 次写丢 117 条，不要再在别处实现第二套。
2. **会话元数据权威源在工具侧**。新增字段先扩 `AiToolAdapter` / `SessionInfo`，不要在 Tick 里建会话镜像表。
3. **`verify()` 必须绕缓存直读，且 `size === 0` 不算产生**。目录 mtime 粒度会造成 racy 窗口；本机有大量 0 字节僵尸会话。
4. **pi 只能用终端拉起**：它在非 TTY 下会静默降级成 headless print。不要改回 `spawn(pi, { stdio: 'ignore' })`。argv 一律数组；终端脚本用 POSIX 单引号转义。
5. **resume 用 `--session <会话文件绝对路径>`，cwd 取会话 header 的 cwd**。用 `--session-id` + 当前目录会让 pi 找不到会话而静默新建。
6. **pending 绑定是对账出来的**：默认投递是「预填 pi 输入框」，用户回车才落盘；launch 成功后返回 `pending: true` 是正常语义。
7. **`create_todo` 在 durable 侧必须 `replay: 'unsafe'`**（该 API 的 `safe` 含义是崩溃后可重跑 = 重复建单），并用 `conversationId:callId` 作 requestId；幂等命中时不要写文件。
8. **pi 会话读取纪律**：只读首行 header 拿 cwd/id；name / 首条 user 消息需要流式扫全文，但只保留必要文本，禁止缓存正文。**pi 的** `settings.json` 是 **jsonc**，用 `parseJsonc`，不要 `JSON.parse`。绝不调用 pi 的 `getDefaultSessionDir()`（有 mkdir 副作用）。会话目录可能被 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / settings `sessionDir` 覆盖，不能硬扫默认路径。
9. **面板 Chat 凭据只读**：不写 pi 的 `auth.json`、不抢 `auth.json.lock`；OAuth 续期归 pi 本体。durable 的 `unanswered` 必须渲染成可见失败，不能静默 busy。
10. **进程内 Chat 必须带超时**（当前 120s）；否则网络挂起会让 run 永久 busy、后续消息全部排队。
11. **UI 材质只从 `@tick/ui` 来**：不要在任何 feature 里另写 `backdrop-filter` + 半透明叠层。主按钮金属黑、次按钮石墨、文字/焦点环墨黑、不用蓝色；语义色只保留绿/红。改视觉先看 `packages/ui/README.md`。
12. **窗口保持 `frame: true + titleBarStyle: 'hidden'`**：这是让 Electron 44 的 vibrancy 应用原生圆角 mask 的前提；改 `frame: false` 会让方形毛玻璃从面板圆角外露出。
13. **常驻语义**：关窗 = 隐藏，只有 Cmd+Q / Tray 退出才真正退出；退出前要 await `chat.close()`（有 1.5s 超时兜底）。
14. **WorkBuddy 只读纪律**：`workbuddy.db` 用 `node:sqlite` 的 `new DatabaseSync(file, { readOnly: true })` 打开（Electron 44.8 / Node 24.22 实测可用），**打开后立刻试读一次**——WAL 库在缺 `-shm` / 目录不可写时构造成功、首次访问才报错；只有这一步失败才把 `db` + `-wal` + `-shm` 复制到 `mkdtemp` 临时目录、以普通方式打开副本，**用完立即删除**。**禁用 `immutable=1`**（会忽略 `-wal`，实测读到 0 行）。不读 keyblob / device-id / security/ / settings.json / models.json；不写 db/-wal/会话数据（只读 WAL 时 `-shm` 可能由 SQLite 维护读标记，不视为 Tick 写数据）。深链接前必须先校验 DB 里 id 存在且未软删除；`newSessionMode='launch'` 才允许预生成 id 并写绑定，`prefill` 只能打开 GUI 新建页（不自动发送、不写绑定）。**不要统一各工具的 session id 生成方式**（pi 预生成 `--session-id`，WorkBuddy 自己的 GUI 生成）；WorkBuddy 的 `task` 深链接是内部未公开协议，URL 过长必须截断并如实返回 `truncated`；2026-10-19 起不再做版本门控（只按 installed 判断）。
15. **CLI 就绪探测必须在 GUI 最小 PATH 下也成立**：Finder 启动的 .app 只继承 launchd 的 `/usr/bin:/bin:/usr/sbin:/sbin`，不含 Homebrew / npm 全局 / nvm / fnm / volta / bun；pi 又是 `#!/usr/bin/env node` 脚本，所以「跑 `pi --version` 判安装」在打包版里必然失败（dev 从终端跑有全 PATH，看不出来）。定位可执行文件统一走 `@tick/ai-pi` 的 `probe-exe.ts`（`TICK_<TOOL>_PATH` → 常见前缀 → 进程 PATH → 登录 shell PATH 兜底，超时 1.5s 且有 TTL 缓存），并只认「可执行的普通文件」；找不到就如实报未安装，不要退回执行目标文件来猜。

## 验证方式

- `pnpm typecheck` 是提交前的必跑项；`pnpm selftest:prefill` 覆盖预填/多工具关键边界，`pnpm selftest:update` 覆盖应用内更新的状态机与 main 侧编排，`pnpm selftest:timeline` 覆盖时间线（状态归一 / 三适配器证据解析 / 派生缓存 / P0-6）——三者都不启动 Electron、不碰真实数据。其余 core 纯函数仍可临时用 `node` 跑 `.mjs`（参考 `scripts/session-usage.mjs`）。
- `selftest` / `verify` / `review` 的 `.mjs` 入口（`selftest-prefill.mjs` / `selftest-update.mjs` / `selftest-timeline.mjs` / `verify-agent-stores.mjs` / `review-tools.mjs`）共用 `scripts/run-ts.mjs` 做 esbuild 临时打包（入口是各自的 `.ts`）；新增只读 TS 脚本沿用这个套路，不要复制引导代码。
- dev 模式 main 会开 CDP `127.0.0.1:9223`：`curl http://127.0.0.1:9223/json` 拿页面 WebSocket，再用 `Runtime.evaluate` 驱动/断言 UI。renderer 的 console 已转发到终端。
- pi 扩展的快速自检：`create_todo` 重复调用应返回既有线索且不重复建单；并发写 `todos.json` 后条目数应守恒。

## 文档地图

- `README.md`（英文，默认）/ `README.zh-CN.md`（简体中文）：面向用户的产品介绍、安装与功能。
- `docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`：产品与架构权威设计（含 pi 的实测事实与陷阱）。
- `docs/已对齐/RESEARCH-pi.md`、`docs/已对齐/RESEARCH-magpie.md`：pi 与本地会话读取器的调研依据。
- `docs/release-playbook.md`：macOS 签名/公证/发版全链路。
- `docs/prd-session-timeline.md`：「最后一条 user 消息 + 跨工具时间线」PRD（P0 含 WorkBuddy 国内版与国际版适配器；Claude Code / Claude Desktop 已于 2026-10-19 接入；**P0-1..P0-6 已于 2026-10-25 落地**，as-built 与本文提案的差异见 §11）。
- `docs/prd-mcp.md`：MCP 对外能力的设计提案（句柄回扫绑定、2025/2026 双代协议、Tier 0/1 架构、分发与安全）；配套可运行 spike 在 `scripts/mcp-spike/`。
- `docs/mcp-tools-spec.md`：MCP 工具完整合同（6 个工具的 schema/错误码/幂等/回扫算法/测试矩阵）；实现与测试以它为准。
- `docs/workbuddy-adapter-notes.md`：WorkBuddy 存储格式与深链接的只读实测记录；§11 是适配器落地后的 as-built 对照（事实与未验证项不变）。
- `docs/claude-code-adapter-notes.md`：Claude Code CLI 与 Claude Desktop 的实测记录（无首行 header、`--prefill`、`claude://code/new` / `claude://resume` / `claude://code/continue`、两者共用同一份 jsonl、靠正文 `entrypoint` 与 Desktop 记录 `cliSessionId` 区分、adopt 双入口已知设计、Desktop 每会话 `.claude` home、未验证项）。
- `docs/multi-agent-adapter-plan.md`：**多工具适配器现状评估与落地计划**（P1–P3 已落地 Codex/Grok/Cline/omp/Kimi/OpenCode/ZCode/dsh）（能力矩阵、T1/T2/T3/T4 分档、合同扩展清单、推荐顺序与「不建议做」的理由）。
- `docs/agent-session-storage-map.md`：**跨工具的会话检索对照表**（pi / Claude Code / Claude Desktop / Codex / OpenCode / Cursor / Kimi / WorkBuddy / Droid / Grok / Qoder / Cline / Hermes 的路径、id 来源、cwd、标题、用量口径、resume 通道），主要依据 magpie 的读取器 + 官方文档 + 本机实测。接新适配器前先读它。
- `docs/rules/README.md`：规则文档索引（先读这里）；接入/修改 AI 工具适配器前必读 `docs/rules/agent-tool-adapter.md`。两个 WorkBuddy 适配器落地后，规则文档的合同能力位（`capabilities.newSessionMode`）与「多适配器落地改动面」已同 PR 回写。
- `.workbuddy/memory/`：项目长期记忆（含更细的踩坑记录，可作背景参考）。

## 当前状态（2026-10-25）

- **v0.3.1（2026-10-23）已发布**：修复 0.3.0 里 Cline / OpenCode 图标破图（CSP 缺 `img-src`，Vite 内联的 data: PNG 被拦）；0.3.0 带来 15 个适配器 + 应用内自动更新。签名（Developer ID: Jackyli Li / R2RCTK2PM3）+ Apple 公证 + staple 通过，产物含 arm64/x64 的 dmg、zip、blockmap、`latest-mac.yml`、`SHA256SUMS.txt`，Release 为 latest；官网已切到 0.3.0。发版流程：版本号 → tag → `scripts/release-local.sh` → `gh release create --verify-tag` → 改 `site` 的 `TICK_SITE`。
- M0–M4 已完成：面板/Todo CRUD、项目索引与拉起、面板 Chat、多会话绑定、用量、导出、打包安装。UI 玻璃化分支已合入。
- **应用内自动更新（2026-10-22 落地）**：`electron-updater` 6.8.9 放 dependencies、由 vite 内联进 `dist-electron/main` 的 chunk（不依赖 app 内 node_modules；`files` 排除 node_modules 不影响）。main 的 `UpdateService`（`services/update.ts`）是唯一状态源，纯状态机在 `services/update-state.ts`；出口只有设置页「应用更新」与 Tray 动态菜单。`autoDownload=false`（用户确认才下载）+ `autoInstallOnAppQuit=true`（ready 后普通 ⌘Q 也安装），安装前先 `prepareQuit` 关 chat 再 `quitAndInstall`。能力判定全在 main：dev（未打包）/ 未签名（codesign 无 Developer ID Application）/ 缺 `app-update.yml` / AppTranslocation 一律如实 `unsupported`，绝不崩；错误状态只含白名单文案。包已下好但交给 Squirrel.Mac 失败（拉取/验签）会从 ready 转成 `error{scope:'download',code:'handoff'}`，给「重试下载 / 重新检查」两个出口，不再停在假「已下载」。`pnpm selftest:update` 覆盖状态机与编排（31 PASS / 0 FAIL）。签名两版本 + 本地 generic feed 的端到端已实测：old 0.2.1 检查到 0.2.2、下载、ShipIt 替换后版本号变为 0.2.2。发版仍是 `scripts/release-local.sh`（dmg+zip+latest-mac.yml），更新源来自 `publish` 写入的 `app-update.yml`。
- **会话时间线（P0-1..P0-6，2026-10-25 落地，未发版）**：详情页「会话」改为「进展」时间线——按会话内最后事件时间跨工具混排（`missing` 置底、`primary` 只加徽标），每项显示状态点 / 状态文案（`active / idle / done / missing`）、消息时间、项目名、最后一条 user 消息原文（>90 字符可点开全文；>4000 字截断并标「消息已截断」），旧 adapter 只有 `lastMessage` 时标「标题回退」；首页线索行第二行显示最近会话的最后一句（首屏 + 30s + 窗口 focus 刷新；与标题逐字相同时不重复渲染，信息改挂悬停提示），行高 44→56（`main.ts` 的 `ROW_H` 与 CSS 同步）。证据从 adapter 的 `SessionInfo` 现问，状态归一/截断在 `@tick/ai-core`（`deriveSessionState` / `buildSessionDigest`）；派生证据 + 文件指纹缓存在 `cache/session-digests.json`（状态每次现算，上限 500 条、落盘去抖 1.2s）。已提供证据的三个适配器：`pi`（`message.timestamp` + `stopReason`）、`claude`（ISO `timestamp` + assistant `stop_reason`）、`workbuddy` / `workbuddy-ai`（jsonl 事件时间 + DB `sessions.status` / 末条 assistant `status`）；其余 11 个工具暂未提供 → 回退 `lastMessage` 并标 `approximate`，状态只按文件是否存在如实给 `idle` / `missing`，不猜 `done`。新 IPC `sessions:recent` 已按「`packages/shared` 常量 / `main/ipc.ts` / `preload` / renderer」四处同改。回归：`pnpm typecheck`、`selftest:timeline` 16 PASS、`selftest:prefill` 86 PASS、`selftest:update` 31 PASS。
- 适配器已有**十五个**实装：`pi`、`workbuddy`、`workbuddy-ai`、`claude`、`claude-desktop`、`qoder` / `qoder-cn`、`codex`、`cline`、`grok`、`omp`、`kimi`、`opencode`、`zcode`、`dsh`（DeepSeek Harness）。除 `pi` / `claude` 外全部是 `newSessionMode='none'` 或 `'prefill'`（只能倒入历史会话 + 回到会话 + 用量），因为**只有 pi 与 Claude Code 支持预生成会话 id**。`codex` 是第一个「一会话多文件」的工具：`SessionSummary.files` 保留同一个 thread 的全部 rollout，`filePath` 指向最新那个；`opencode` / `zcode` 是第一批「会话在 SQLite 里」的工具（`filePath` 指向数据库，`zcode` 没有 resume 通道）；`omp` 的 cwd=~ 时会被 omp 自动切到临时目录（`--allow-home` 才允许以 home 为项目）→ Tick 必须在 home 启动/恢复时补这个 flag，否则新会话落到 `/tmp` 项目下；它的首行 `title` 物理记录才是当前标题（`title_change` 只是审计历史）。`dsh` 的正文是**多帧 zstd**（本机 10MB = 23,331 帧，必须按块头切帧；`zstdDecompressSync` / 一次 `end()` 都只解第一帧），标题与用量改读 dsh 自己的投影缓存（`storages/session_projcache`），且**没有按会话打开的通道**。main 侧 `SessionService` / `LaunchService` / `ProjectIndexService` / `ExportService` 已收敛到 `AiToolAdapter[]` 并按 `toolId` 路由；`ProjectIndexService` 只调各 adapter 的 `discoverProjects()`。两个 WorkBuddy 适配器通过真实数据只读冒烟：国内版 6 条有效会话（DB 10 行，4 行被软删除/云端/后台自动化过滤），国际版 4 条（其中 2 条 playground 会话 `resumable=false`）；全套回归以 `pnpm selftest:prefill` 为准（当前 86 PASS / 0 FAIL，数字随用例增删变化）。
- **多客户端工具**：`capabilities.clients: ToolClientId[]`（当前只有 OpenCode 声明 `['desktop','cli']`）。OpenCode 桌面版与 CLI 共用 `~/.local/share/opencode/opencode.db`、同一批 `ses_…` id，**没有归属字段** → 不拆适配器；新建页在该工具下方显示「打开方式」选择器，写 `settings.toolClients[toolId]`，`LaunchService` 解析后透传 `ctx.client`（请求 > settings > 缺省：新建 `desktop`、回到会话 `cli`）。桌面深链接**实测不可用**：`opencode://new-session?directory=&prompt=` 与 `opencode://open-project?directory=` 虽然在 renderer 源码里能解析、App 主进程日志也收得到，但 1.19.3 的新布局没挂 `opencode:deep-link` 监听（只有旧 shell 挂了），发完 URL 后 `opencode.global.dat`/路由/草稿都没有任何变化 → 桌面入口只做「`open -a` 激活 App + 文案进剪贴板」，回到会话只打开 App 并如实给 `notice`；`prefillDelivery` 只描述 CLI 分支（terminal-copy），不另立工具。教训：源码里有解析函数不等于端到端可用，判据要落在 App 侧可观测状态。
- 新建会话语义统一为 `capabilities.newSessionMode`（`launch` / `prefill` / `none`）+ `capabilities.prefillDelivery`（`deeplink` / `terminal-copy`），但**不统一 session id 生成方式**：pi 走 `launch`（Tick 预生成 UUID + `--session-id`，可 pending 绑定/verify）；默认 `deliver='prefill'`：文案写 `cache/launch/<sessionId>.prefill.json`（0600），终端脚本用 `TICK_LAUNCH_FILE`/`TICK_LAUNCH_ACK` 传给 tick-extension，扩展在 `session_start` 调 `ctx.ui.setEditorText()` 预填 pi 输入框、读后即删并写 ack；主进程等 ack（3s），失败/超时降级剪贴板并给 `notice`，**不自动发送**；勾选「直接发送」才走 argv。`ToolStatus` 只按 `installed` 判断（2026-10-19 起移除 `version`/`usable` 与版本门控，`detect()` 不再跑 `pi --version`、WorkBuddy 不再读 `CFBundleShortVersionString`）；新建会话页列出**本机已安装**的所有工具，`newSessionMode='none'` 的行禁用并显示原因。WorkBuddy（国内版 / 国际版）与 Claude Desktop 走 `prefill` + `deeplink`（`openNewSessionPage()` 打开 GUI 新建页并预填；不自动发送、不预生成/绑定 sessionId）。**CLI 工具（Codex / Cline / Grok / omp / Kimi / OpenCode / Qoder 两个发行版）走 `prefill` + `terminal-copy`**：它们没有草稿 API（实测 `opencode --prompt`、`cline "<prompt>"`、`grok --prompt` 都会**立刻发送**），所以只「在终端里打开工具（argv 不带 prompt）+ 文案进剪贴板」，`notice` 明确要求用户 ⌘V 再回车；`ZCode` / `DeepSeek Harness` 是桌面应用且没有带 prompt 的新建深链接 → 仍是 `none`。WorkBuddy 的 task 协议是 App 内部实现、无官方公开规范（国内版 5.8.3 / 国际版 5.8.4 均实测；2026-10-19 起不再按版本门控），超长文案按 URL 长度截断并返回 `truncated`；prompt/cwd 会进入深链接 URL（可能出现在 LaunchServices/App 日志，Tick 自身不记录）。
- **Claude Code / Claude Desktop（2026-10-19 接入）**：`claude` 为 CLI 适配器（`newSessionMode='launch'`，预生成 UUID + `--session-id`；**预填用原生 `--prefill=`**，无扩展/无 ack；直接发送用位置参数，`-` 开头用 `--` 分隔；resume 用 `--resume <会话文件绝对路径>` + 会话自己的 cwd；用量按 `message.id` 去重（同 id 取最后修订）、跳过 `<synthetic>`、成本优先取 `cost-state` 快照；标题 `custom-title` > `ai-title` > `summary`）。`claude-desktop` 为桌面适配器（`newSessionMode='prefill'`：`claude://code/new?folder=&q=`），读**两套**会话：① Desktop 自己的会话（`<userData>/{claude-code-sessions,local-agent-mode-sessions}/<acct>/<org>/local_<id>/.claude/projects/…`，id = `local_<id>`，resume 走 `claude://code/continue?session=`；归档会话 `resumable=false`）；② 被 Desktop adopt 的 CLI 会话（仍在 `~/.claude/projects`，id = CLI uuid，resume 走 `claude://resume?session=`）。全局 store 里 CLI 适配器排除 `entrypoint=claude-desktop/3p` 的 Desktop 会话；**被 Desktop adopt 的 CLI 会话（正文 entrypoint 仍是 `cli`/`sdk-cli`，Desktop 记录里 `cliSessionId=<uuid>`）会以双 id 各列一次**（`claude` 用 CLI uuid、`claude-desktop` 用 `local_<id>`）——保留 Desktop 入口的已知设计，不是重复计数。调用前校验 App 已装 / 正文在本机 / 已登录过。实测事实与未验证项见 `docs/claude-code-adapter-notes.md`。
- **MCP 对外能力**：设计提案 `docs/prd-mcp.md` + 可运行 spike `scripts/mcp-spike/`（协议断言 19/19、并发 5/5、pi 1.3.0 与 Claude Code 2.1.302 真机接入；两者都走 legacy 2025-11-25，都不提供 session id）。Jacky 已定：允许 Tick 未运行时直写并由 MCP server 自回扫完成绑定、接受「只记不跳」、允许只读扫描本机会话文件做 handle 匹配、实现以官方 build-server 文档为准；认证客户端跟随项目现有工具（pi / workbuddy / workbuddy-ai），`list_todos` 默认不带 body，v1 主分发用 app 内置 shim。工具合同已完整设计（`docs/mcp-tools-spec.md`：3 个 v1 工具 + 3 个 P1 预设计、错误码、扫描算法、测试矩阵）。**P0 已落地**：`@tick/todo-core`（唯一写实现，Main/extension 改为薄适配）、`@tick/session-locators`、`@tick/probe-scan`、`@tick/mcp-server`；`node scripts/mcp-check.mjs` 119 PASS/0 FAIL（2026-10-21 实测；含 Tick 未运行时 pi/WorkBuddy/Claude 回扫、启动补扫、过期 probe、损坏 fail-closed、只读、限流、stdin EOF、modern 2026-07-28、resources；数字随用例增删变化，以命令输出为准）；app 内置 shim `Resources/mcp/tick-mcp.sh` + `electronFuses.runAsNode=true` 已从打包 app 实测握手。**设置页「Agent 连接（MCP）」已落地**（安装包 shim 状态、pi/Claude/JSON 复制、只读与扫描开关）。回扫用例已覆盖 `claude`：无首行 header 的会话能绑上、`entrypoint=claude-desktop` 的不会被 `claude` 抢。**P1 未做**：Tier 1 bridge、`get_todo`/`complete_todo`/`list_sessions`、来源角标/手动补绑、npm/MCPB 分发。
- 提交信息沿用中文 `feat(scope): ...` / `fix(scope): ...` 风格；代码注释保持中文并解释「为什么」而非复述「做了什么」。
