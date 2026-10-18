# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

Ticktodo（包名 `tick`）是 macOS 菜单栏常驻的置顶面板：以 Todo（线索）为索引，把同一件事在不同 AI 工具里的多个 CLI 会话聚合起来，并能一键在终端里回到任意会话继续。面板内置一个基于 pi-durable 的 Chat，用来自然对话并让模型调用 `create_todo`。当前只实装了 pi 一个适配器。

- 仅 macOS；全仓 TypeScript；Electron 44（内置 Node 24，满足 pi-durable 的 Node ≥ 22.19 硬约束）。
- 权威设计：`README.md`（功能/操作细节）、`docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`。设计文档与代码冲突时，以 as-built 代码为准并同步文档。

## 常用命令

```bash
pnpm install                              # 首次；.npmrc 固定 node-linker=hoisted，勿改 isolated
pnpm dev                                  # 根脚本：先 build tick-extension，再起 Electron（vite dev 5173）
pnpm typecheck                            # 全仓 tsc --noEmit —— 唯一的自动化检查（没有 lint / test runner）
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
   └─ AiToolRegistry → PiAdapter
packages/shared   类型 + IPC 通道常量（main/preload/renderer 单一来源）
packages/ai/core  工具无关合同 + 纯函数（不得依赖任何具体 adapter）
```

组合根是 `apps/desktop/src/main/main.ts`：resolveDirs → ensureDirs(0700) → TodoStore → 装配 adapter/索引/拉起/Chat → 窗口 → IPC → 载入 UI。新增 IPC 通道必须同时改四处：`packages/shared` 的常量、`main/ipc.ts`、`preload/index.ts` 白名单、renderer 的 hook。

### 包分层

- `@tick/shared`：Todo / SessionBinding / CliSessionId / AppSettings 等领域类型与全部 IPC 通道常量。UI 层不反向依赖 ai 包，所以品牌类型 `CliSessionId` 定义在这里。
- `@tick/ai-core`：`AiToolAdapter` 合同、`AiToolRegistry`、`canonicalPath`、`mergeProjects`、`gitRootOf`、会话命名空间。纯函数、无 Electron 依赖。
- `@tick/ai-pi`：唯一适配器实现。负责 detect / 会话目录解析 / listSessionInfos / describeSession / computeUsage / launch / resume / verify。
- `@tick/tick-extension`：pi 扩展 `create_todo` / `list_todos`。领域逻辑只有 `src/todos-file.ts` 一份；`src/index.ts`（coding-agent `registerTool`）与 `src/durable.ts`（pi-durable `defineTool`）是两套不通用 API 的薄适配。esbuild 打包成单文件，因为 pi 用 jiti 在无 node_modules 的目录里执行它；`dist/` 不进 git，首次需 build。
- `@tick/ui`：玻璃材质与设计令牌的唯一来源；desktop 的 `styles.css` 只保留布局/业务 class。材质、按钮和焦点环规范见 `packages/ui/README.md`。
- `@tick/storage`：预留空包，不要往里加逻辑。

### 两条会话通路（不要混）

1. **CLI 拉起**（主路径）：`LaunchService` → `PiAdapter` → `createTerminalLauncher` 生成 `cache/launch/*.command` → `open` 交给 Terminal。launch 预生成 UUID，绑定先写 `pending`，main 每 5s 调 `reconcilePending()` 在会话文件出现后转 `verified`。
2. **面板 Chat**：`ChatAgentHost` 用 pi-durable `Harness` + JSONL storage 落 `sessions/panel-chat/`，注入 `TickDurableExtension`。凭据默认只读 pi 的 `auth.json`（不抢锁、不写），或使用自配 OpenAI 兼容 provider。

面板会话与 CLI 会话是**命名空间隔离**的两套存储；面板 Chat 不参与用量统计，也永不被 resume。

### 数据层（`~/.ticktodo`，`TICK_HOME` 可覆盖）

| 目录 | 语义 |
|---|---|
| `data/` | 可同步、致命：`todos.json`、`settings.json`（损坏先备份 `.corrupt-<ts>` 再继续） |
| `sessions/panel-chat/` | 面板对话正文，不建议同步 |
| `cache/` | 可再生：`projects.json`、`window-state.json`、终端脚本；删掉必须不影响功能 |
| `exports/` | 手动导出产物（JSON + Markdown，只有索引，无正文） |

**凭据纪律**：`~/.ticktodo` 下不存在任何 Key。自配 provider 的 Key 经 Electron `safeStorage` 加密后存 userData（`~/Library/Application Support/Tick/credentials.json`），不降级明文。

### 数据流

- **项目索引**：`PiAdapter` 只贡献原始证据（cwd → 会话数/最近时间）；`mergeProjects` 做 canonicalPath 归一化 + git 根上卷 + 合并排序；`ProjectIndexService` 负责 `(size, mtime)` 文件级增量缓存，再叠加 Tick 侧状态（`lastLaunchedAt`、手动 pin、失效目录 alias）。UI 首帧只读缓存，后台扫完通过 `projects:updated` 推送。
- **Todo 双写方**：Main 的 `TodoStore` 与 pi 扩展都会写同一份 `todos.json`。两边必须使用同名锁文件 `<file>.lock`、`<pid>:<uuid>` 属主 token、原子写（tmp + fsync + rename）。Main 用 `fs.watch(data/)` 感知扩展的写入并推 `todos:changed`。
- **会话绑定**：`Todo.bindings[]` + `primarySessionId` 是 Tick 唯一持久化的会话关系；`cwd`、`name`、`firstMessage`、`lastMessage`、`exists` 等元数据一律向 adapter 现问，不落镜像。

## 必须保持的不变量

1. **锁文件名两边一致**：`apps/.../services/storage.ts` 与 `packages/tick-extension/src/todos-file.ts` 都用 `<todos.json>.lock`。历史上两边锁名不同导致并发 240 次写丢 117 条。
2. **会话元数据权威源在工具侧**。新增字段先扩 `AiToolAdapter` / `SessionInfo`，不要在 Tick 里建会话镜像表。
3. **`verify()` 必须绕缓存直读，且 `size === 0` 不算产生**。目录 mtime 粒度会造成 racy 窗口；本机有大量 0 字节僵尸会话。
4. **pi 只能用终端拉起**：它在非 TTY 下会静默降级成 headless print。不要改回 `spawn(pi, { stdio: 'ignore' })`。argv 一律数组；终端脚本用 POSIX 单引号转义。
5. **resume 用 `--session <会话文件绝对路径>`，cwd 取会话 header 的 cwd**。用 `--session-id` + 当前目录会让 pi 找不到会话而静默新建。
6. **pending 绑定是对账出来的**：剪贴板投递时 pi 要等用户发第一条消息才落盘，launch 成功后返回 `pending: true` 是正常语义。
7. **`create_todo` 在 durable 侧必须 `replay: 'unsafe'`**（该 API 的 `safe` 含义是崩溃后可重跑 = 重复建单），并用 `conversationId:callId` 作 requestId；幂等命中时不要写文件。
8. **pi 会话读取纪律**：只读首行 header 拿 cwd/id；name / 首条 user 消息需要流式扫全文，但只保留必要文本，禁止缓存正文。**pi 的** `settings.json` 是 **jsonc**，用 `parseJsonc`，不要 `JSON.parse`。绝不调用 pi 的 `getDefaultSessionDir()`（有 mkdir 副作用）。会话目录可能被 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / settings `sessionDir` 覆盖，不能硬扫默认路径。
9. **面板 Chat 凭据只读**：不写 pi 的 `auth.json`、不抢 `auth.json.lock`；OAuth 续期归 pi 本体。durable 的 `unanswered` 必须渲染成可见失败，不能静默 busy。
10. **进程内 Chat 必须带超时**（当前 120s）；否则网络挂起会让 run 永久 busy、后续消息全部排队。
11. **UI 材质只从 `@tick/ui` 来**：不要在任何 feature 里另写 `backdrop-filter` + 半透明叠层。主按钮金属黑、次按钮石墨、文字/焦点环墨黑、不用蓝色；语义色只保留绿/红。改视觉先看 `packages/ui/README.md`。
12. **窗口保持 `frame: true + titleBarStyle: 'hidden'`**：这是让 Electron 44 的 vibrancy 应用原生圆角 mask 的前提；改 `frame: false` 会让方形毛玻璃从面板圆角外露出。
13. **常驻语义**：关窗 = 隐藏，只有 Cmd+Q / Tray 退出才真正退出；退出前要 await `chat.close()`（有 1.5s 超时兜底）。

## 验证方式

- `pnpm typecheck` 是提交前的必跑项；没有测试框架，需要验证 core 纯函数时可临时用 `node` 直接跑 `.mjs`（参考 `scripts/session-usage.mjs`）。
- dev 模式 main 会开 CDP `127.0.0.1:9223`：`curl http://127.0.0.1:9223/json` 拿页面 WebSocket，再用 `Runtime.evaluate` 驱动/断言 UI。renderer 的 console 已转发到终端。
- pi 扩展的快速自检：`create_todo` 重复调用应返回既有线索且不重复建单；并发写 `todos.json` 后条目数应守恒。

## 文档地图

- `README.md`（英文，默认）/ `README.zh-CN.md`（简体中文）：面向用户的产品介绍、安装与功能。
- `docs/已对齐/PRD-tick.md`、`docs/已对齐/TECH-ARCH-tick.md`：产品与架构权威设计（含 pi 的实测事实与陷阱）。
- `docs/已对齐/RESEARCH-pi.md`、`docs/已对齐/RESEARCH-magpie.md`：pi 与本地会话读取器的调研依据。
- `docs/release-playbook.md`：macOS 签名/公证/发版全链路。
- `docs/prd-session-timeline.md`：进行中的「最后一条 user 消息 + 跨工具时间线」PRD（P0 含 WorkBuddy 国内版与国际版适配器）。
- `docs/workbuddy-adapter-notes.md`：WorkBuddy 存储格式与深链接的只读实测记录。
- `.workbuddy/memory/`：项目长期记忆（含更细的踩坑记录，可作背景参考）。

## 当前状态（2026-10-19）

- M0–M4 已完成：面板/Todo CRUD、项目索引与拉起、面板 Chat、多会话绑定、用量、导出、打包安装。UI 玻璃化分支已合入。
- 代码中只有 `PiAdapter` 一个实装；`docs/prd-session-timeline.md` 规划的 `workbuddy` / `workbuddy-ai` 适配器与跨会话时间线**尚未落地**。新增适配器应实现 `AiToolAdapter` 并只在 `main.ts` 注册，不改 `ai/core`。
- 提交信息沿用中文 `feat(scope): ...` / `fix(scope): ...` 风格；代码注释保持中文并解释「为什么」而非复述「做了什么」。
