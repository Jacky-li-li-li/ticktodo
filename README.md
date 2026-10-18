# Tick — 置顶 Todo 工作台（AI 会话的索引层）

> **线索（Todo）是索引，agent 会话是被索引对象。**
> 产品文档：`docs/已对齐/PRD-tick.md`（v0.3） · 架构：`docs/已对齐/TECH-ARCH-tick.md`

## 快速开始

```bash
pnpm install        # 首次（hoisted 布局，见 .npmrc）
pnpm dev            # 启动置顶面板（apps/desktop，vite + vite-plugin-electron）
pnpm typecheck      # 全仓 tsc --noEmit
```

> 本机环境注意：WorkBuddy 宿主 shell 会带 `ELECTRON_RUN_AS_NODE=1`，dev script 已内置 unset；直接跑 `vite` 时需先 `unset ELECTRON_RUN_AS_NODE`。
>
> 窗口层圆角：Electron 44 只会给保留 `NSWindowStyleMaskTitled` 的窗口应用 vibrancy 圆角 mask（9px）；`frame:false` 会让方形毛玻璃层从面板圆角外露出。因此窗口改为 `frame:true + titleBarStyle:'hidden'` 并隐藏红绿灯，外窗圆角为 10px（UI-SPEC §2.3 的 20 是设计稿值，面板内部组件圆角不受影响）。窗口层取舍：保留 macOS 原生 10px 圆角 + vibrancy。
>
> 面板玻璃透明度：底色 `rgba(18,20,31)` 的 alpha 按用户偏好从 0.45 调到 **0.20**，顶部白色渐变同步减淡（0.12→0.05）；UI-SPEC §3.1 的 45% 保留为设计稿值。
>
> 文字：按用户偏好改为**黑色层级**（`--t-*` 用黑透明度），浮层/弹层/Toast 同步换成浅色表面，语义色改用深色变体（`--danger-text` / `--success-text` / `--warn-text`）；UI-SPEC §2.1/§3 的暗色玻璃值保留为设计稿基准。

## 运行环境（M0 已验证）

| 项 | 状态 |
|---|---|
| Electron | 44.8.0（内置 **Node 24.22.0 ≥ 22.19**，满足 pi-durable 硬约束，无需 sidecar 预案） |
| pi | 1.3.0（已从 1.2.0 升级；CLI flags 与 RESEARCH-pi 基线一致） |
| 语言/运行时 | 全仓 TypeScript + Node（D13 决定：面板 Chat 进程内跑 pi-durable → 运行时必是 Node） |
| 数据根 | `~/.ticktodo`（`TICK_HOME` 可覆盖），`data/` 0700/0600，含自动生成 README.md |
| 终端 | macOS Terminal.app（`open` 走 LaunchServices，不需要「自动化」权限）；拉起 pi 的 TUI 必须有终端 |

## 里程碑进度

- [x] **M0** 仓库脚手架 + 置顶悬浮面板（默认 360×520，右上贴边 16px；当前只保留最小宽度 320，高度按最多 5 条线索动态设最小、不设最大值）+ Todo CRUD（原子写 + 文件锁 + 业务规则 1/4/5 结构）+ pi 升级 1.3.0
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
- assistant 消息按 GFM Markdown 渲染（`react-markdown` + `remark-gfm`：标题/列表/表格/代码块/引用/链接）；
  用户消息保持原文。安全口径：原始 HTML 不渲染、远程图片不加载、链接只放行 https 并交给系统浏览器
  （main 的 `setWindowOpenHandler`）；实现见 `renderer/features/panel-chat/MarkdownMessage.tsx`
- 面板用量不统计（D15），`pi.usage` 有但不读
- 注意：面板 Chat 与 CLI 会话是**命名空间隔离**的两套存储；「上次停在哪」只读 Todo 绑定的 CLI 会话文件，不会读取面板 Chat 的消息

### 3. 线索详情 → 新建会话（AiPicker）

- 首页**不再内联展开**：点行 / 右侧圆形箭头图标 → 整页线索详情（标题/描述、元信息、全部会话与操作）
- 双击首页标题 → 原地改标题（Enter/失焦保存，Esc 取消，空标题不保存）
- 详情页主操作「接着做 / 新建会话 / 认领」进入本节的 AiPicker 流程

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

- **macOS 纯菜单栏模式**：`app.dock.hide()` + 打包 `LSUIElement=true`，不显示 Dock 图标；常驻 Tray 模板图标（左键显隐面板，右键菜单：显示/隐藏、新建线索、退出；悬停 tooltip 显示 `Ticktodo-<open 线索数>个`）；图标源 `build/trayTemplate.svg`，打包时经 `extraResources` 带进 App。
- **应用图标**：源文件 `apps/desktop/build/icon.svg`（深色玻璃 squircle + 图钉云豆 mascot；浅色备选 `icon-light.svg`），
  产物 `icon.png`（1024）与 `icon.icns`；electron-builder 默认从 `build/` 取 `icon.icns`（无需额外配置），dev 下 main 会把 Dock 图标指到 `icon.png`。
- **首页顶栏**：右侧对话入口改为 14×14 会话气泡图标（去掉不存在的「⌘对话」假快捷键；`⋯` 仍是归档/设置/导出菜单）；左侧品牌位为「小尺寸云豆+图钉图标 + Ticktodo」（归档页仍显示「归档」；图标来源见 `build/icon.svg`，UI 组件 `features/brand/TickMark.tsx`）。
- **Todo（重构 2026-10-18）**：首页行不再展开 —— 点行或右侧圆形箭头进**线索详情整页**；双击标题原地改名；
  行悬停显示箭头（替代原「继续」胶囊）。**详情页标题收到顶栏**：`‹ 返回 + 状态灯 + 标题（超长省略）`，
  已归档时标题右侧带「已归档」标签；标题前状态灯（进行中=绿色呼吸灯 / 已归档=静态灰点，不再放归档勾选，
  归档/恢复在「其他」里）；**悬停标题**浮层显示来源/创建/更新/最近拉起（绝对时间，不占版面），双击标题可改。
  正文从描述开始，不再重复标题行。
  详情页其余：描述（双击或「编辑」可改）、主操作（接着做 / 新建会话 / 认领）、全部绑定会话（工具图标、时间、
  默认/待发送/不在本机标记、最后一条 user 消息、**每个会话自己的项目名与路径**，以及「接着做 / 设为默认 / 解绑」；
  设置开启时显示单会话用量）、其他操作（归档或恢复 / 编辑 / 导出 / 删除二次确认）。
  首页默认 5 条，超过可「展开全部」；⋯ 菜单进归档页。
- **归档页**：与首页同构；点行/箭头进详情，悬停「恢复」，双击标题可改名。
- **会话列表**：会话直接列在详情页内（不再有「查看列表」浮层）；工具图标 + 时间 + 默认/待发送/已不在本机标记 +
  最后一条 user 消息 + 每个会话自己的项目名与路径；每行「接着做 / 设为默认 / 解绑」。
- **新建会话页（§6.4 整页）**：← 顶栏 → 线索名 → 可编辑的发送内容 → 工具单选列表（检测到 N 个，由用户选；
  检测不到时中性提示卡，§4.6）→ 项目（已推导，可改）→ 底部主按钮「复制文案并打开 pi」（44 高，Spacer 压底）。
- **归档**：列表勾选或详情页勾选 → 立即归档，toast 3 秒「已归档「X」· 撤销」；归档页同构，悬停「恢复」（次胶囊）。
- **设置**（`data/settings.json`，点 ⋯ → 设置）：拉起投递方式（复制文案 / 直接发送）、默认项目（主目录 ~ / 最近使用 / 每次必问）、用量统计开关、打开数据目录、自配 provider。
- **窗口尺寸**：只保留最小宽度 320；最小高度按当前 open 线索数动态计算（最多默认展示 5 条），无最大尺寸；新增线索时若窗口低于所需高度会自动向下扩展，但不会自动缩。
- **置顶开关**：顶栏图钉按钮；开 = `alwaysOnTop(floating)`；关 = 取消置顶并开启「失焦立即收起」（点到其它 app/桌面就隐藏到菜单栏，Tray / 快捷键可再唤出）。状态存 `cache/window-state.json` 的 `pinned`；鼠标在 Tray 上或打开目录选择器期间临时豁免，避免菜单栏点击竞态。
- **焦点环**：鼠标点击不显示 focus ring（避免 macOS 系统 accent 橙框挂在按钮上）；键盘 Tab 为墨色 2px 焦点环（统一 UI 后不再用蓝色）。
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
