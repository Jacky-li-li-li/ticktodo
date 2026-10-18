<div align="center">
  <img src="./site/mascot.png" width="112" alt="Ticktodo" />
  <h1>Ticktodo</h1>
  <p><strong>一个 todo 的所有 AI 会话，一眼看全。</strong></p>
  <p>以 todo 为中心，把属于同一个 todo 的多个 AI 会话聚到一起。<br />
  回来时不用回忆、不用逐个工具翻找——看到停在哪，点一下就能接着做。</p>
  <p>
    <a href="https://github.com/Jacky-li-li-li/ticktodo/releases/latest"><img src="https://img.shields.io/github/v/release/Jacky-li-li-li/ticktodo?label=release&color=111" alt="Release" /></a>
    <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS" />
    <a href="https://github.com/Jacky-li-li-li/ticktodo/stargazers"><img src="https://img.shields.io/github/stars/Jacky-li-li-li/ticktodo?style=flat&color=111" alt="Stars" /></a>
  </p>
  <p>
    <a href="#安装">安装</a> ·
    <a href="#它能做什么">功能</a> ·
    <a href="#它是怎么工作的">架构</a> ·
    <a href="#支持的工具">支持的工具</a> ·
    <a href="#从源码开发">开发</a> ·
    <a href="#文档">文档</a>
  </p>
</div>

> 当前版本支持 **pi**；WorkBuddy 等更多工具在[路线图](#路线图)中。

## 它解决什么问题

一个 todo 可能推进了好几天，开过很多会话：在 pi 里查资料，在另一个工具里改代码，过几天又回来继续。

这些会话散落在各工具的存储里，彼此没有关联。想接着做时，只能靠回忆，再逐个工具翻找。

Ticktodo 的逻辑很简单：**用 Todo 作为索引，把属于它的会话绑在一起。**

| 你关心的问题 | Ticktodo 的答案 |
|---|---|
| 这个 todo 进展到哪了？ | 打开线索，所有相关会话与最后进展都在一页 |
| 上次停在哪？ | 每个会话显示第一条 / 最后一条 user 消息与时间 |
| 怎么接着做？ | 点会话右侧的滑块，直接在终端里恢复那个会话 |
| 数据在哪？ | 本地 `~/.ticktodo`；会话本体始终留在各工具自己的存储里 |

## Ticktodo 适合你吗？

**适合：**

- 你同时用多个 AI 会话推进同一个 todo，隔几天会回来继续。
- 你不想再靠聊天标题或记忆去找「上次那个会话」。
- 你希望索引在本地、可以自己备份，但不把对话正文上传到任何服务器。

**不适合：**

- 你只开一个会话、从不回看。
- 你需要的是一个 AI 对话客户端，而不是会话索引。

## 安装

### 一行安装

```bash
curl -fsSL https://ticktodo.cc/install.sh | sh
```

脚本会下载最新 Release、校验 `SHA256SUMS.txt`、安装到 `/Applications`（无写权限时退到 `~/Applications`），然后启动。

### 手动下载

- [GitHub Releases](https://github.com/Jacky-li-li-li/ticktodo/releases/latest)：
  `Tick-<version>-arm64.dmg`（Apple Silicon）或 `Tick-<version>-x64.dmg`（Intel）。
- 安装本地构建产物：

```bash
bash scripts/install.sh path/to/Tick.app
```

**系统要求**：macOS。使用会话聚合与「接着做」需要 `pi >= 1.3.0`（也可用 `TICK_PI_PATH` 指定可执行文件）。

安装后 Ticktodo 常驻菜单栏，不占 Dock。

## 快速上手

1. 点菜单栏图标打开面板（或按 `⌘⌥T`）。
2. 在顶部输入一句要做的事，回车，得到一条线索。
3. 点进线索详情，选择「新建会话」，或从「倒入历史会话」绑定已有会话。
4. 以后点会话右侧的滑块（或「接着做」），就能回到那个会话。

| 快捷键 | 作用 |
|---|---|
| `⌘⌥T` | 显示 / 隐藏面板 |
| `⌘⌥N` | 新建线索 |
| `⌘W` | 隐藏面板 |
| `⌘Q` | 退出 Ticktodo |

## 它能做什么

### 一个 todo，一条线索

标题 + 补充上下文，双击就地编辑；勾选即归档，3 秒内可撤销。归档不是删除，随时可以恢复。

### 会话自动聚合

从工具的会话存储中发现会话：工具、所属项目、第一条 user 消息、最后一条消息、时间。同一线索下的会话按项目分组展示，会话文件被删时标为「已不在本机」，不报错。

### 一键接着做

- **继续已有会话**：用会话自己的 cwd 打开终端里的 pi TUI，上下文原样接上。
- **新建会话**：选项目、写好第一段话；默认复制到剪贴板（可审阅），也可以在设置里改为直接发送。
- 目录失效时明确提示，并退回主目录，不会静默跑到错误的地方。

### 从历史会话倒入

把本机的历史会话按项目列出来，选中即可「建线索」或「直接打开」，不需要从零整理。

### 面板里直接对话

内建 Chat 可以复用 pi 的凭据，也可以配置任意 OpenAI 兼容 endpoint（自配 provider）。模型还能调用 `create_todo` / `list_todos`，边聊边把要跟进的内容记进 Ticktodo。

### 项目自动发现

扫描各工具会话文件的首行 header，取出真实 cwd；路径做 canonical 归一，再按 git 根上卷。同一个仓库的不同子目录不会炸成多个项目。

### 常驻，但不打扰

菜单栏常驻；面板默认置顶，也可以设为失焦自动收起。窗口位置和尺寸会被记住。

### 可选的用量与导出

- 用量默认关闭；开启后按会话显示 tokens / cost（provider 未上报成本时显示 `≥`）。
- 导出「未完成 / 全部」为 JSON + Markdown，只含索引与 `filePath`，不含对话正文。

## 它是怎么工作的

一句话：**Todo 是索引，工具自己的会话文件是权威数据。**

```mermaid
flowchart TB
  subgraph Panel["Ticktodo 面板（菜单栏常驻）"]
    UI["线索列表 · 线索详情<br/>内建对话 · 设置"]
  end

  subgraph Main["本机服务 · Electron Main"]
    Todo["TodoStore<br/>线索 + 会话绑定"]
    Index["ProjectIndex<br/>发现 · 归并 · 缓存"]
    Launch["LaunchService<br/>新建 / 接着做"]
    Chat["ChatAgentHost<br/>内建对话"]
    Registry["AiToolRegistry"]
  end

  subgraph Adapters["工具适配器"]
    Pi["PiAdapter"]
    Future["WorkBuddy / …<br/>（接入点）"]
  end

  subgraph ToolData["工具自己的数据（只读）"]
    Sessions[("~/.pi/agent/sessions<br/>会话文件")]
    Auth[("~/.pi/agent/auth.json<br/>凭据")]
  end

  TickData[("~/.ticktodo<br/>线索 · 设置 · 面板对话")]
  Terminal["Terminal.app<br/>pi TUI"]

  UI <-->|IPC| Todo
  UI <-->|IPC| Index
  UI <-->|IPC| Launch
  UI <-->|IPC| Chat
  Todo <--> TickData
  Chat <--> TickData
  Index --> Registry
  Launch --> Registry
  Chat --> Registry
  Registry --> Pi
  Registry -.-> Future
  Pi -.->|只读 header / 消息| Sessions
  Chat -.->|只读凭据| Auth
  Launch -->|打开| Terminal
  Pi -.->|"--session / --session-id"| Terminal
```

### 三条设计原则

1. **会话元数据不落镜像。** cwd、名称、消息、是否存在，都向工具侧现问；Ticktodo 只持久化绑定关系。工具里改名或删除会话后，索引不会腐烂。
2. **项目索引与工具无关。** 适配器只贡献证据（原始 cwd、会话数、最近时间）；归一化、git 根合并、排序都在工具无关的 core 里完成。接第二个工具不需要改主流程。
3. **两条会话通路严格隔离。** CLI 会话由工具创建和持有；面板对话由 Ticktodo 自己存储。两者使用不同的命名空间，互不混用。

### 一次「接着做」发生了什么

```mermaid
sequenceDiagram
  autonumber
  actor U as 你
  participant T as Ticktodo
  participant A as PiAdapter
  participant P as pi（Terminal）
  U->>T: 点「接着做」
  T->>A: describeSession(sessionId)
  A-->>T: cwd / 会话文件 / 是否存在
  T->>A: resume（会话文件绝对路径, cwd = header.cwd）
  A->>P: 在终端打开 pi TUI
  T->>T: 回写 lastLaunch.launchedAt
```

> 必须开在终端里：pi 通过 TTY 判断交互模式，headless 拉起会退化成一次性打印。恢复时使用会话文件绝对路径和会话自己的 cwd，避免 pi 在新目录里静默新建一个空会话。

### 新建会话：pending 绑定

剪贴板投递时，pi 要等用户发出第一条消息才会写会话文件。因此绑定先记为 `pending`，后台对账后再转 `verified`：

```mermaid
sequenceDiagram
  autonumber
  actor U as 你
  participant T as Ticktodo
  participant P as pi
  participant F as 会话文件
  U->>T: 新建会话
  T->>P: 打开终端（预生成 session id）
  T->>T: 绑定状态 = pending
  U->>P: 发出第一条消息
  P->>F: 写入会话
  loop 每 5 秒
    T->>F: verify（绕缓存直读，size 大于 0）
  end
  T->>T: pending → verified
```

### 项目索引：从 cwd 到一条项目

```mermaid
flowchart LR
  A["各工具会话<br/>首行 header.cwd"] --> B["canonicalPath<br/>realpath · 尾斜杠 · worktree"]
  B --> C["按 git 根上卷<br/>同仓库收敛为一条"]
  C --> D["合并证据<br/>tools[] · 会话数 · 最近使用"]
  D --> E["叠加 Ticktodo 状态<br/>最近拉起 · 手动添加 · 路径重定位"]
  E --> F["项目列表<br/>最近拉起优先"]
```

## 支持的工具

| 工具 | 状态 | 会话发现 | 接着做 | 说明 |
|---|---|---|---|---|
| **pi** | ✅ 已支持 | ✅ | 终端 TUI | 需要 `pi >= 1.3.0` |
| WorkBuddy（国内版） | 规划中 | — | 深链接 | PRD 与只读实测已完成，适配器未发布 |
| WorkBuddy AI（国际版） | 规划中 | — | 深链接 | 独立适配器，格式与国内版同内核 |
| Claude Code / Cursor | 后续 | — | — | Claude Code 同为本地 JSONL；Cursor 格式待查 |

接入新工具 = 在 `packages/ai/<tool>` 实现 `AiToolAdapter`，再在 `main.ts` 注册。不需要改 core 或 UI。

## 数据与隐私

Ticktodo 是本地优先的：

- 数据在 `~/.ticktodo`（可用 `TICK_HOME` 覆盖），没有账号、没有云端。
- 读取工具会话时只取需要的元数据；不复制会话文件，不把对话正文写进自己的数据库。
- 导出文件只有索引与路径，不含正文。
- 面板对话的存储与 CLI 会话分离，不会互相读取。

| 目录 | 内容 | 建议 |
|---|---|---|
| `data/` | `todos.json`、`settings.json` | ✅ 可同步；丢了会失去线索 |
| `sessions/panel-chat/` | 面板对话正文 | ⚠️ 不建议同步 |
| `cache/` | 项目缓存、窗口位置、终端脚本 | ❌ 可再生，删掉无妨 |
| `exports/` | 手动导出的 JSON / Markdown | — |

**凭据纪律**：`~/.ticktodo` 下不存任何 API Key。自配 provider 的 Key 经系统钥匙串支撑的 safeStorage 加密后，存于应用的 userData 目录，不会随数据目录被同步走。面板对 pi 的凭据只读——不写 `auth.json`，也不抢它的锁。

## 从源码开发

```bash
pnpm install                              # 首次；使用 hoisted 布局
pnpm dev                                  # 构建 pi 扩展，再启动 Electron 面板
pnpm typecheck                            # 全仓 tsc --noEmit
pnpm build                                # 全仓构建
pnpm --filter @tick/tick-extension build  # 单独构建 pi 扩展
pnpm --filter @tick/desktop dist:dir      # 本地打包出 .app
```

环境要求：Node ≥ 22.19（Electron 44 内置 Node 24）、pnpm、macOS。

几个容易踩的坑：

- 某些宿主 shell 会带 `ELECTRON_RUN_AS_NODE=1`，让 Electron 以 Node 模式启动；`pnpm dev` 已内置 unset，直接跑 `vite` 时也要先 unset。
- 签名构建不要放在 `~/Desktop` 等 iCloud 同步目录，codesign 可能报错或挂起；用 `git worktree` 放到别处构建。
- `packages/tick-extension/dist/` 不进 git，首次开发前需要构建一次。
- 正式发版用 `scripts/release-local.sh`（签名、公证、生成 `SHA256SUMS.txt`），版本号与 tag 必须一致。

### 项目结构

```
apps/desktop/            Electron 应用：main / preload / renderer
packages/shared/         领域类型 + IPC 通道（三端单一来源）
packages/ai/core/        适配器合同 + 项目归并纯函数
packages/ai/pi/          pi 适配器：发现 / 读取 / 拉起 / 恢复
packages/tick-extension/ pi 扩展：create_todo / list_todos
packages/ui/             玻璃材质与设计令牌
scripts/                 安装、发版、用量统计
docs/                    PRD、技术架构、调研笔记
site/                    ticktodo.cc 静态站点
```

### 验证

仓库目前没有 test runner，`pnpm typecheck` 是提交前的必跑项。做 UI 改动时可以在 dev 模式下用 CDP 自检：main 进程监听 `127.0.0.1:9223`，通过 `Runtime.evaluate` 驱动界面；renderer 的 console 会转发到终端。

## 路线图

- [x] 菜单栏置顶面板、线索 CRUD、归档与恢复
- [x] pi 会话发现、绑定、终端恢复、pending 对账
- [x] 内建对话 + `create_todo` / `list_todos`
- [x] 多会话、项目索引、可选用量、导出
- [x] 签名打包与一行安装
- [ ] WorkBuddy（国内版）适配器
- [ ] WorkBuddy AI（国际版）适配器
- [ ] 一个 todo 的跨工具时间线（每个会话的最后一条 user 消息与状态）
- [ ] 跨工具接手、导出再导入
- [ ] Windows

## 文档

| 文档 | 内容 |
|---|---|
| [产品 PRD](docs/已对齐/PRD-tick.md) | 产品范围、交互与验收标准 |
| [技术架构](docs/已对齐/TECH-ARCH-tick.md) | 分层、适配器合同、数据与安全 |
| [会话时间线 PRD](docs/prd-session-timeline.md) | 下一步：最后一条 user 消息与跨工具时间线 |
| [WorkBuddy 适配笔记](docs/workbuddy-adapter-notes.md) | 存储格式与深链接的实测记录 |
| [发版手册](docs/release-playbook.md) | 签名、公证与发布链路 |
| [视觉规范](packages/ui/README.md) | 玻璃材质、按钮与设计令牌 |

---

<div align="center">
  <sub>Made for macOS · 你的数据留在你的电脑上 · <a href="https://ticktodo.cc">ticktodo.cc</a></sub>
</div>
