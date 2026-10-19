# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

Ticktodo（包名 `tick`）是 macOS 菜单栏常驻的置顶面板：以 Todo（线索）为索引，把同一件事在不同 AI 工具里的多个 AI 会话聚合起来，并能一键回到任意会话继续。面板内置一个基于 pi-durable 的 Chat，用来自然对话并让模型调用 `create_todo`。

适配器有三个实装：`pi`（CLI，在终端里拉起 / resume）、WorkBuddy 国内版（`workbuddy`）与 WorkBuddy AI 国际版（`workbuddy-ai`）。两个 WorkBuddy 都是**桌面工具适配**：只读其本地数据库与会话文件，只能经深链接回到已有会话，**不支持从 Tick 直接新建并绑定**。两个 WorkBuddy 均为 `newSessionMode='prefill'`（可打开 GUI 新建页并预填，发送/绑定仍由用户完成）；2026-10-19 起不再做版本校验（装了就开放 prefill / 新建页，版本差异由真实调用失败暴露）。

- 仅 macOS；全仓 TypeScript；Electron 44（内置 Node 24，满足 pi-durable 的 Node ≥ 22.19 硬约束）。
- 权威设计：`README.md`（功能/操作细节）、`docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`。设计文档与代码冲突时，以 as-built 代码为准并同步文档。

## 常用命令

```bash
pnpm install                              # 首次；.npmrc 固定 node-linker=hoisted，勿改 isolated
pnpm dev                                  # 根脚本：先 build tick-extension，再起 Electron（vite dev 5173）
pnpm typecheck                            # 全仓 tsc --noEmit
pnpm selftest:prefill                     # 预填/多工具边界 selftest（esbuild 临时打包 TS 断言，不启动 Electron）
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
   │            terminal-launch · provider-config
   └─ AiToolRegistry → PiAdapter / WorkbuddyAdapter / WorkbuddyAiAdapter
packages/shared   类型 + IPC 通道常量（main/preload/renderer 单一来源）
packages/ai/core  工具无关合同 + 纯函数（不得依赖任何具体 adapter）
packages/ai/*     三个适配器（只吐证据，不做归并/缓存/UI）
```

组合根是 `apps/desktop/src/main/main.ts`：resolveDirs → ensureDirs(0700) → TodoStore → 装配 adapter/索引/拉起/Chat → 窗口 → IPC → 载入 UI。新增 IPC 通道必须同时改四处：`packages/shared` 的常量、`main/ipc.ts`、`preload/index.ts` 白名单、renderer 的 hook。

### 包分层

- `@tick/shared`：Todo / SessionBinding / CliSessionId / AppSettings 等领域类型与全部 IPC 通道常量。UI 层不反向依赖 ai 包，所以品牌类型 `CliSessionId` 定义在这里。
- `@tick/ai-core`：`AiToolAdapter` 合同、`AiToolRegistry`、`canonicalPath`、`mergeProjects`、`gitRootOf`、会话命名空间。纯函数、无 Electron 依赖。
- `@tick/ai-pi`：CLI 工具的参考实现（合同完整语义：detect / 会话目录解析 / listSessionInfos / describeSession / computeUsage / launch / resume / verify；`probe-exe.ts` 负责 GUI 最小 PATH 下的可执行文件定位）。新增 CLI 工具照它写。
- `@tick/ai-workbuddy`：WorkBuddy 国内版适配器（`workbuddy`），同时是**两个发行版共用的只读读取内核**：`paths.ts`（App bundle / 数据根 / cwd 编码 / jsonl 定位）、`sqlite.ts`（`workbuddy.db` 只读 + WAL 复制兜底 + schema 探测）、`transcript.ts`（jsonl 流式解析 + `<user_query>` 抽取）、`base-adapter.ts`（detect / list / discover / describe / resume / launch）、`adapter.ts`（国内版身份常量）。
- `@tick/ai-workbuddy-ai`：WorkBuddy AI 国际版适配器（`workbuddy-ai`），只声明自己的身份常量（App bundle / bundle id / 数据根 / scheme / playground 策略），读取内核复用上一个包。两个发行版是**两个独立工具**：两个 toolId、两份缓存、互不共用配置（国内版吃 `WORKBUDDY_CONFIG_DIR`，国际版不吃）。
- `@tick/tick-extension`：pi 扩展 `create_todo` / `list_todos`。领域逻辑只有 `src/todos-file.ts` 一份；`src/index.ts`（coding-agent `registerTool`）与 `src/durable.ts`（pi-durable `defineTool`）是两套不通用 API 的薄适配。esbuild 打包成单文件，因为 pi 用 jiti 在无 node_modules 的目录里执行它；`dist/` 不进 git，首次需 build。
- `@tick/todo-core`：`todos.json` 的**唯一写实现**（锁/原子写/损坏备份/fail-closed/幂等/绑定冲突）。Main 的 `TodoStore` 与 pi extension 都只是它的薄适配；改锁语义只改这里。
- `@tick/session-locators`：只读 locator（`pi` / `workbuddy` / `workbuddy-ai`），只回答「扫哪个目录、命中文件里的 sessionId 是什么」，不 import Electron。
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
| `cache/` | 可再生：`projects.json`、`window-state.json`、终端脚本、预填一次性 prompt/ack 文件（`launch/*.prefill.json*`，0600，扩展读后即删；App 启动清理 >1h 的 prefill、>24h 的 command）；删掉必须不影响功能 |
| `exports/` | 手动导出产物（JSON + Markdown，只有索引，无正文） |

**凭据纪律**：`~/.ticktodo` 下不存在任何 Key。自配 provider 的 Key 经 Electron `safeStorage` 加密后存 userData（`~/Library/Application Support/Tick/credentials.json`），不降级明文。

### 数据流

- **项目索引**：每个 adapter 的 `discoverProjects()` 只贡献原始证据（cwd → 会话数/最近时间），不做归并；`mergeProjects` 做 canonicalPath 归一化 + git 根上卷 + 合并排序；`ProjectIndexService` 负责调度、`cache/projects.json` 落盘与叠加 Tick 侧状态（`lastLaunchedAt`、手动 pin、失效目录 alias），单个工具读取失败只丢它自己的证据。UI 首帧只读缓存，后台扫完通过 `projects:updated` 推送。
- **Todo 多写方**：Main 的 `TodoStore`、pi 扩展、MCP server 都会写同一份 `todos.json`，三边都走 `@tick/todo-core`（唯一锁/原子写实现）；不要再实现第二套。Main 用 `fs.watch(data/)` 感知其他写方的写入并推 `todos:changed`。
- **会话绑定**：`Todo.bindings[]` + `primarySessionId` 是 Tick 唯一持久化的会话关系；`cwd`、`name`、`firstMessage`、`lastMessage`、`exists` 等元数据一律向 adapter 现问，不落镜像。列表/绑定/回到会话都按 `binding.toolId` 路由到对应 adapter（不同工具的会话 id 空间互不相干，不做全局反查猜工具）；`tools:status` 的展示名统一来自 `@tick/shared` 的 `TOOL_DISPLAY_NAMES`。

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

- `pnpm typecheck` 是提交前的必跑项；`pnpm selftest:prefill` 覆盖预填/多工具关键边界（不启动 Electron、不碰真实数据）。其余 core 纯函数仍可临时用 `node` 跑 `.mjs`（参考 `scripts/session-usage.mjs`）。
- dev 模式 main 会开 CDP `127.0.0.1:9223`：`curl http://127.0.0.1:9223/json` 拿页面 WebSocket，再用 `Runtime.evaluate` 驱动/断言 UI。renderer 的 console 已转发到终端。
- pi 扩展的快速自检：`create_todo` 重复调用应返回既有线索且不重复建单；并发写 `todos.json` 后条目数应守恒。

## 文档地图

- `README.md`（英文，默认）/ `README.zh-CN.md`（简体中文）：面向用户的产品介绍、安装与功能。
- `docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`：产品与架构权威设计（含 pi 的实测事实与陷阱）。
- `docs/已对齐/RESEARCH-pi.md`、`docs/已对齐/RESEARCH-magpie.md`：pi 与本地会话读取器的调研依据。
- `docs/release-playbook.md`：macOS 签名/公证/发版全链路。
- `docs/prd-session-timeline.md`：进行中的「最后一条 user 消息 + 跨工具时间线」PRD（P0 含 WorkBuddy 国内版与国际版适配器）。
- `docs/prd-mcp.md`：MCP 对外能力的设计提案（句柄回扫绑定、2025/2026 双代协议、Tier 0/1 架构、分发与安全）；配套可运行 spike 在 `scripts/mcp-spike/`。
- `docs/mcp-tools-spec.md`：MCP 工具完整合同（6 个工具的 schema/错误码/幂等/回扫算法/测试矩阵）；实现与测试以它为准。
- `docs/workbuddy-adapter-notes.md`：WorkBuddy 存储格式与深链接的只读实测记录；§11 是适配器落地后的 as-built 对照（事实与未验证项不变）。
- `docs/rules/README.md`：规则文档索引（先读这里）；接入/修改 AI 工具适配器前必读 `docs/rules/agent-tool-adapter.md`。两个 WorkBuddy 适配器落地后，规则文档的合同能力位（`capabilities.newSessionMode`）与「多适配器落地改动面」已同 PR 回写。
- `.workbuddy/memory/`：项目长期记忆（含更细的踩坑记录，可作背景参考）。

## 当前状态（2026-10-19）

- M0–M4 已完成：面板/Todo CRUD、项目索引与拉起、面板 Chat、多会话绑定、用量、导出、打包安装。UI 玻璃化分支已合入。
- 适配器已有三个实装：`pi`、`workbuddy`（WorkBuddy 国内版）、`workbuddy-ai`（WorkBuddy AI 国际版）。main 侧 `SessionService` / `LaunchService` / `ProjectIndexService` / `ExportService` 已收敛到 `AiToolAdapter[]` 并按 `toolId` 路由；`ProjectIndexService` 只调各 adapter 的 `discoverProjects()`（不再持有 pi 专属的 `sessionRoots()`，也删掉了文件级增量缓存）。两个 WorkBuddy 适配器通过真实数据只读冒烟：国内版 6 条有效会话（DB 10 行，4 行被软删除/云端/后台自动化过滤），国际版 4 条（其中 2 条 playground 会话 `resumable=false`）；集成断言 26/26 PASS（含未安装时静默禁用的 4 项降级断言）。
- 新建会话语义统一为 `capabilities.newSessionMode`（`launch` / `prefill` / `none`），但**不统一 session id 生成方式**：pi 走 `launch`（Tick 预生成 UUID + `--session-id`，可 pending 绑定/verify）；默认 `deliver='prefill'`：文案写 `cache/launch/<sessionId>.prefill.json`（0600），终端脚本用 `TICK_LAUNCH_FILE`/`TICK_LAUNCH_ACK` 传给 tick-extension，扩展在 `session_start` 调 `ctx.ui.setEditorText()` 预填 pi 输入框、读后即删并写 ack；主进程等 ack（3s），失败/超时降级剪贴板并给 `notice`，**不自动发送**；勾选「直接发送」才走 argv。`ToolStatus` 只按 `installed` 判断（2026-10-19 起移除 `version`/`usable` 与版本门控，`detect()` 不再跑 `pi --version`、WorkBuddy 不再读 `CFBundleShortVersionString`）；新建会话页列出**本机已安装**的所有工具，`newSessionMode='none'` 的行禁用并显示原因。WorkBuddy（国内版 / 国际版）走 `prefill`（由 `openNewSessionPage()` 打开 `workbuddy[ -ai]://task?action=start&prompt=…&cwd=…`，把文案与项目预填进 GUI 新建任务页；不自动发送、不预生成/绑定 sessionId，发送后仍用「倒入历史会话」绑定）。WorkBuddy 的 task 协议是 App 内部实现、无官方公开规范（国内版 5.8.3 / 国际版 5.8.4 均实测；2026-10-19 起不再按版本门控），超长文案按 URL 长度截断并返回 `truncated`；prompt/cwd 会进入深链接 URL（可能出现在 LaunchServices/App 日志，Tick 自身不记录）。
- `docs/prd-session-timeline.md` 的 P0-1..P0-6（最后一条 user 消息展示、跨工具时间线）**仍未落地**：`SessionInfo` 还没有归一化的 `status`/`state` 字段（时间线依赖它），`SessionDigest` 合同也尚未实现。适配器侧已具备 `lastMessage` / `resumable` / `discoverProjects`，时间线应在 core 合同扩展 + `SessionService` 上做。
- **MCP 对外能力**：设计提案 `docs/prd-mcp.md` + 可运行 spike `scripts/mcp-spike/`（协议断言 19/19、并发 5/5、pi 1.3.0 与 Claude Code 2.1.302 真机接入；两者都走 legacy 2025-11-25，都不提供 session id）。Jacky 已定：允许 Tick 未运行时直写并由 MCP server 自回扫完成绑定、接受「只记不跳」、允许只读扫描本机会话文件做 handle 匹配、实现以官方 build-server 文档为准；认证客户端跟随项目现有工具（pi / workbuddy / workbuddy-ai），`list_todos` 默认不带 body，v1 主分发用 app 内置 shim。工具合同已完整设计（`docs/mcp-tools-spec.md`：3 个 v1 工具 + 3 个 P1 预设计、错误码、扫描算法、测试矩阵）。**P0 已落地**：`@tick/todo-core`（唯一写实现，Main/extension 改为薄适配）、`@tick/session-locators`、`@tick/probe-scan`、`@tick/mcp-server`；`node scripts/mcp-check.mjs` 112 PASS/0 FAIL（含 Tick 未运行时 pi/WorkBuddy 回扫、启动补扫、过期 probe、损坏 fail-closed、只读、限流、stdin EOF、modern 2026-07-28、resources）；app 内置 shim `Resources/mcp/tick-mcp.sh` + `electronFuses.runAsNode=true` 已从打包 app 实测握手。**设置页「Agent 连接（MCP）」已落地**（安装包 shim 状态、pi/Claude/JSON 复制、只读与扫描开关）。**P1 未做**：Tier 1 bridge、`get_todo`/`complete_todo`/`list_sessions`、来源角标/手动补绑、npm/MCPB 分发。
- 提交信息沿用中文 `feat(scope): ...` / `fix(scope): ...` 风格；代码注释保持中文并解释「为什么」而非复述「做了什么」。
