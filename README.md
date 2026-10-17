# Tick — 置顶 Todo 工作台（AI 会话的索引层）

> **线索（Todo）是索引，agent 会话是被索引对象。**
> 产品文档：`docs/已对齐/PRD-tick.md`（v0.3） · 架构：`docs/已对齐/TECH-ARCH-tick.md` · 设计规范：`docs/已对齐/UI-SPEC-tick.md`

## 快速开始

```bash
pnpm install        # 首次（hoisted 布局，见 .npmrc）
pnpm dev            # 启动置顶面板（apps/desktop，vite + vite-plugin-electron）
pnpm typecheck      # 全仓 tsc --noEmit
```

> 本机环境注意：WorkBuddy 宿主 shell 会带 `ELECTRON_RUN_AS_NODE=1`，dev script 已内置 unset；直接跑 `vite` 时需先 `unset ELECTRON_RUN_AS_NODE`。

## 运行环境（M0 已验证）

| 项 | 状态 |
|---|---|
| Electron | 44.8.0（内置 **Node 24.22.0 ≥ 22.19**，满足 pi-durable 硬约束，无需 sidecar 预案） |
| pi | 1.3.0（已从 1.2.0 升级；CLI flags 与 RESEARCH-pi 基线一致） |
| 语言/运行时 | 全仓 TypeScript + Node（D13 决定：面板 Chat 进程内跑 pi-durable → 运行时必是 Node） |
| 数据根 | `~/.ticktodo`（`TICK_HOME` 可覆盖），`data/` 0700/0600，含自动生成 README.md |
| 终端 | macOS Terminal.app（`open` 走 LaunchServices，不需要「自动化」权限）；拉起 pi 的 TUI 必须有终端 |

## 里程碑进度

- [x] **M0** 仓库脚手架 + 置顶悬浮面板（360×520，min 320×420 / max 480×720，右上贴边 16px）+ Todo CRUD（原子写 + 文件锁 + 业务规则 1/4/5 结构）+ pi 升级 1.3.0
- [x] **M1** ProjectIndex + PiAdapter 实装（**终端拉起 TUI** / `--session-id` / `--session <file>` / `--name` / 版本校验 / verify 绕缓存直读）；2026-10-17 修复：headless spawn、stale cwd、resume cwd
- [x] **M2** `create_todo` extension（CLI + 面板共用，**replay=unsafe + requestId 幂等**）+ 面板 Chat（pi-durable@1.3.0，pin 版本）+ AiPicker（继续 → 项目/投递/接着做 + **pending 绑定对账**）；修复：跨进程锁丢写
- [x] **M3** 多会话绑定 UI + S5 反向建索引 + 快捷键/位置记忆 + 单会话用量（默认关）+ Todo 编辑/归档 + 设置（投递/默认项目）+ 手动项目/失效重定位 + **面板自配 provider**（`CredentialSource` 双来源，Key 只进系统钥匙串 safeStorage）
- [x] **M4** F8 导出（JSON + Markdown，含 `filePath` / `exists` / 可选 `usage`）+ **出包**（electron-builder 产出 `.app` + zip；`scripts/install.sh` 安装到 /Applications）

## 目录

```
tick/
├── apps/desktop/               # Electron 唯一应用
│   └── src/
│       ├── main/               # window · ipc · store(TodoStore) · services/{storage,terminal-launch,launch,chat-host,project-index,sessions,settings-store,export,credential-vault,provider-config}
│       ├── preload/            # contextBridge 白名单
│       └── renderer/           # React：panel · capture-line · thread-row（UI-SPEC 第二轮 Calm Panel）
├── packages/
│   ├── shared/                 # Todo / SessionBinding / CliSessionId / IPC 通道（防漂移的单一来源）
│   ├── ai/core/                # adapter 合同 + mergeProjects + canonicalPath + session-ns（M1 实装）
│   ├── ai/pi/                  # PiAdapter（M0: detect→M1 实装 launch/resume/verify）
│   ├── tick-extension/         # pi extension create_todo/list_todos（M2）
│   └── storage/                # 预留
├── docs/已对齐/                # PRD / TECH-ARCH / REVIEW / RESEARCH-*/ UI-SPEC
└── scripts/
```

## 数据层（`~/.ticktodo`）

| 目录 | 性质 |
|---|---|
| `data/` | ✅ 可同步 · 关键（`todos.json` / `settings.json`；损坏时自动留 `todos.json.corrupt-<ts>` 备份；`todos.json.lock` 是瞬时锁，别同步） |
| `sessions/panel-chat/` | ⚠️ 不建议同步 · 含对话正文（M2 pi-durable store） |
| `cache/` | ❌ 可再生（`projects.json` / `window-state.json` / `launch/*.command` 终端脚本，24h 自动清） |
| `exports/` | F8 手动导出（JSON + Markdown） |

**凭据纪律**：整个数据根不含任何 API Key；自配 provider 的 Key 经 `safeStorage`（系统钥匙串支撑）加密后存
`~/Library/Application Support/Tick/credentials.json`（userData，0600），**不进 `~/.ticktodo`**。

## M2 两件实事（怎么用 / 怎么验）

### 1. `create_todo` 扩展（pi CLI 里也能建线索）

- 实现只有一份领域逻辑：`packages/tick-extension/src/todos-file.ts`（原子写 + O_EXCL 锁，和 Main 共用同一份 `todos.json`）。
  **锁文件名必须两边一致（`todos.json.lock`）**：之前 Main 用 `.todos.json.lock`、extension 用 `todos.json.lock`，
  两个运行时各锁各的，并发写实测 240 次丢 117 条；现在统一并带 `<pid>:<uuid>` 属主 token。
  两个运行时各一层薄适配：`src/index.ts`（pi coding-agent `registerTool`）与 `src/durable.ts`（pi-durable `defineTool`）。
  > 实测发现：两套扩展 API 并不通用（`registerTool` vs `defineTool`），所以"一份实现"指的是领域逻辑，不是注册代码。
- 打包：`pnpm --filter @tick/tick-extension build` → `dist/index.js`（esbuild 单文件，typebox 一起打进去）
- 安装：App 启动时按内容 hash 幂等写入 `~/.pi/agent/extensions/tick/index.js`（pi 自动发现目录，默认启用，不改用户 settings）
- 幂等：同一 pi 会话重复调用只返回既有那条；`requestId` 命中同理、且命中时不重写文件
- 面板侧 `create_todo` 显式 `replay: 'unsafe'`（durable 的 `safe` 含义是「崩溃后允许重跑」= 重复建单），
  并用 `conversationId:callId` 作为 `requestId`，重试同一个工具调用不会建出第二条

### 2. 面板 Chat（pi-durable）

- 执行层 `apps/desktop/src/main/services/chat-host.ts`：`Harness.open(openNodeJsonlStorage(sessions/panel-chat))`
  → `root()` → `resume()`（崩溃续跑）→ `viewState().subscribe()` 把结构视图拍平成消息推给 UI
- 模型/凭据**复用 pi 本体但不写**：`ModelRuntime.create({ credentials: 只读 store })` 直读 `~/.pi/agent/{models,models-store,auth}.json`
  - 只读是刻意的：面板不该抢 `auth.json.lock`，也不该改用户的 pi 凭据；
  - 代价：OAuth 令牌过期时面板会直接报错（续期交给 pi 本体），M3 的自配 provider 是另一个 `CredentialSource` 实现
- 失败一定有反馈：durable 的 `settled.status === 'unanswered'` 会渲染成一条「这轮没答出来：…」
- 面板用量不统计（D15），`pi.usage` 有但不读

### 3. 「继续」→ AiPicker

- `launch:resolve-cwd` 做 cwd 三级推导：绑定会话的 cwd → `todo.lastLaunch` → home（home 显示成 `~`，不写成用户名）
- 主按钮**永远带项目名**（`在 <项目> 中打开 pi` / `接着做`），投递默认「复制文案」，切「直接发送」才走 argv
- **拉起 = 在终端里开 pi TUI**：`PiAdapter` 只把 `{cwd, exe, argv}` 交给注入的 `openTerminal`；
  main 生成 `cache/launch/*.command`（POSIX 单引号转义）再 `open` 到 Terminal。
  （不能在 GUI 进程里 `spawn(pi, {stdio:'ignore'})`：pi 见不到 TTY 会降级成 headless print 模式。）
- **pending 绑定**：剪贴板投递下，pi 要等用户发送第一条消息才写 session 文件；所以 launch 先写
  `SessionBinding.state='pending'`，`reconcilePending()` 每 5s 调 `verify()`，产生文件后转 `verified`。
  0 字节僵尸仍不会被判 verified。
- **stale 目录**：绑定会话的 cwd / `lastLaunch` / 显式目录不存在时，退回 home 并在 UI 提示（`degraded`），不静默跑错目录
- **resume**：`--session <会话文件绝对路径>` + cwd 取会话 header 的 cwd，避免 pi 按当前项目目录找不到会话而静默新建
- `launch` / `resume` 都会回写 `lastLaunch.launchedAt`（Tick 自己的跨工具排序时钟，不用 `Todo.updatedAt`）

### 4. M3 + F8 功能（UI 已按 UI-SPEC 第二轮 Calm Panel 对齐）

- **Todo**：点标题展开为**线索卡片**（焦点卡材质：白 10%→3% + Accent 8%，§3.3）——卡片头可勾选归档、
  「上次停在哪」显示主会话最后一条 user 消息（adapter 流式扫描，不缓存正文）、动作三态（0 会话=新建会话；
  1 会话=「在 <项目> 中打开 pi」；N 会话=接着做 + 查看列表带角标）；卡片内可编辑标题/正文（标题必填）；
  点卡片外空白折叠；首页默认 5 条，超过可「展开全部」；⋯ 菜单进归档页。
- **会话浮层（§4.5）**：查看列表 → 触发按钮正下方右对齐浮层，标签「这条线上的对话」，实心点=已落盘会话 /
  空心点=待发送，每行两行文字（时间+状态 / 上次停在哪），footer「＋ 新建会话 · 认领历史会话」。
- **新建会话页（§6.4 整页）**：← 顶栏 → 线索名 → 可编辑的发送内容 → 工具胶囊（检测到 N 个，由用户选；
  检测不到时中性蓝提示卡，§4.6）→ 项目（已推导，可改）→ 底部主按钮「复制文案并打开 pi」（44 高，Spacer 压底）。
- **归档**：列表勾选或卡片勾选 → 立即归档，toast 3 秒「已归档「X」· 撤销」；归档页同构，悬停「恢复」（次胶囊）。
- **设置**（`data/settings.json`，点 ⋯ → 设置）：拉起投递方式（复制文案 / 直接发送）、默认项目（主目录 ~ / 最近使用 / 每次必问）、用量统计开关、打开数据目录、自配 provider。
- **快捷键**：`⌘⌥T` 显隐面板、`⌘⌥N` 新建线索（全局，可在设置里看到说明）。
- **项目**：AiPicker 里「＋ 添加本地目录…」走系统目录选择器并 pin（pi 不可用也能加）；失效项目显示「重新定位…」（只做 old→new 映射，不移动 pi 的文件）；主目录固定首项；低频 Downloads/tmp 目录折叠进「其他」。
- **多会话**：线索详情里列出全部绑定会话 → 「接着做」/「设为默认」/「解绑」；S5 从 ⋯ → 认领历史会话，按项目分组（默认近 30 天、可切全部），选中可「建线索」或「直接打开」，不批量生成。
- **用量**（F6-b，默认关）：设置开启后，详情里的每个会话显示 tokens / cost；provider 未上报成本时显示「≥」；面板 Chat 不参与统计（底部有静态说明）。
- **导出**（F8）：⋯ → 导出未完成 / 导出全部；详情里可「导出」当前线索。产物落 `exports/tick-export-<ts>.json` + `.md`；JSON 含 `filePath`、实时 `exists`、`usage`（未开用量统计时为 `null`），不含正文。
- **面板 Chat**：顶部新增目录行，默认 home，可切换项目（只改 agent cwd，不新建会话）。
- **未做**：跨工具接手（F6-a）、导出再导入（P2+）、Windows 安装（P3）。

### 6. 自配 provider（M3 尾巴）与打包安装（M4）

**自配 provider**（设置 → 面板对话 Provider → 自配）：

- 填 OpenAI 兼容 endpoint（任意网关/代理）+ API Key + 模型名 → 「测试连接」→ 保存
- Key 只经 `safeStorage` 加密存 userData（系统钥匙串支撑）；settings.json 只存 endpoint/模型名/`keyStored` 标记
- 保存后重建面板对话（durable 历史保留）；自配模型直连上游，**不依赖 pi 本体**；
  历史会话（用 pi 模型的）仍复用 pi 只读凭据，没装 pi 时读到空、不影响自配对话
- 面板 Chat 的模型请求带 120s 超时（网络挂起不会让 run 永久 busy 堵住后续消息）

**打包与安装**：

```bash
pnpm --filter @tick/desktop dist        # electron-builder：release/mac-arm64/Tick.app + Tick-0.1.0-arm64-mac.zip
bash scripts/install.sh                 # 退出旧实例 → 覆盖 /Applications/Tick.app → 启动
```

- 产物只有 `dist/` + `dist-electron/`（vite 已全量 bundle pi 依赖链，不打包 node_modules）
- `electronDist` 复用 `node_modules/electron/dist`，跳过 GitHub 下载（无签名，本地安装）

### 5. 2026-10-17 M1/M2 修复记录（可复核）

| 修复 | 口径 |
|---|---|
| 拉起 pi 不可用 | 去掉 `spawn(..., 'ignore')`；终端 `.command` + `open`；`resume` 改 `--session <file>` |
| 剪贴板与 verify 冲突 | 绑定状态 `pending → verified`，后台 5s 对账 |
| CLI/面板并发写丢 todos | 两侧锁统一 `todos.json.lock` + 属主 token；实测 240/240 无丢写 |
| 面板 create_todo 重复建单 | `replay:'unsafe'` + `conversationId:callId` requestId |
| 目录失效静默报错 | `resolveCwd` 检查存在性，退回 home + `degraded` 提示 |
| `lastLaunchedAt` 失效 | 新增 `lastLaunch.launchedAt`；canonical + git 根映射后再 overlay |
| todos.json 损坏静默清空 | 解析失败先备份 `todos.json.corrupt-<ts>` 再继续（可人工恢复） |
| 其余 | 项目缓存 prune、settings.json 按 jsonc 解析、IME 回车、退出 await chat.close、无 pi 不写 `~/.pi`、tsconfig 校正 |

自检小工具：dev 期 main 进程开 CDP（`127.0.0.1:9223`），可用 `curl http://127.0.0.1:9223/json` 连上后 `Runtime.evaluate` 直接驱动 UI；renderer 的 console 也会转发到终端。
