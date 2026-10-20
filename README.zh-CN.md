<div align="center">
  <img src="./site/icon-rounded.png" width="112" alt="Ticktodo" />
  <h1>Ticktodo</h1>
  <p><strong>一个 todo 的所有 AI 会话，一眼看全。</strong></p>
  <p>
    <a href="https://github.com/Jacky-li-li-li/ticktodo/releases/latest"><img src="https://img.shields.io/github/v/release/Jacky-li-li-li/ticktodo?label=release&color=111" alt="Release" /></a>
    <img src="https://img.shields.io/badge/platform-macOS-111" alt="macOS" />
    <a href="https://github.com/Jacky-li-li-li/ticktodo/stargazers"><img src="https://img.shields.io/github/stars/Jacky-li-li-li/ticktodo?style=flat&color=111" alt="Stars" /></a>
  </p>
  <p>
    <a href="#安装">安装</a> ·
    <a href="#它能做什么">功能</a> ·
    <a href="#支持的工具">支持的工具</a> ·
    <a href="https://ticktodo.cc/">官网</a> ·
    <a href="./README.md">English</a>
  </p>
</div>

> [!TIP]
> **以 todo 为中心**，把属于同一个 todo 的多个 AI 会话聚到一起。<br />
> 回来时不用回忆、不用逐个工具翻找——看到停在哪，点一下就能接着做。

当前版本支持 **15 个工具**：**pi**、**Claude Code**、**Claude Desktop**、**WorkBuddy（国内版）**、**WorkBuddy AI（国际版）**、**Qoder / Qoder CN**、**Codex**、**Cline**、**Grok**、**omp**、**Kimi Code**、**OpenCode**、**ZCode** 与 **DeepSeek Harness**（见下表）。桌面形态的适配器（两个 WorkBuddy、Claude Desktop、ZCode、DeepSeek Harness）都是只读的：从本地存储里索引会话，再用深链接打开。CLI 工具里，pi / Claude Code 用预生成的会话 id 在终端里新建；其余 CLI（Codex / Cline / Grok / omp / Kimi / OpenCode / Qoder）只打开终端里的工具并把文案放进剪贴板——你按 ⌘V 再回车即可。Ticktodo 不会自动发送或绑定：发送与倒入仍是你在工具里的显式动作。

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

**系统要求**：macOS。聚合与「接着做」`pi` 会话需要本机装有 `pi`（也可用 `TICK_PI_PATH` 指定可执行文件）；首次启动会把 `tick-extension` 装到 `~/.pi/agent/extensions/tick/`，用于新会话预填与 `create_todo`/`list_todos`。聚合 WorkBuddy 会话需要装对应的桌面应用（**WorkBuddy** 或 **WorkBuddy AI**）——它们是桌面应用，不是 CLI；装了应用即可使用新建页预填（不再按版本门控）。

安装后 Ticktodo 常驻菜单栏，不占 Dock。

## 快速上手

1. 点菜单栏图标打开面板（或按 `⌘⌥T`）。
2. 在顶部输入一个 todo，回车，得到一条线索。
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

- **继续已有会话**：用会话自己的 cwd 打开终端里的 pi TUI，上下文原样接上。来自 WorkBuddy 桌面应用的会话则用深链接直接在应用里定位到该会话。
- **新建会话**：选项目、写好第一段话；默认**预填到工具输入框**（可审阅，回车才发送）。主按钮右侧有「直接发送」勾选，勾上即本次启动就发送；也可以在设置里改默认值。
- 目录失效时明确提示，并退回主目录，不会静默跑到错误的地方。

### 从历史会话倒入

把本机的历史会话按项目列出来，选中即可「建线索」或「直接打开」，不需要从零整理。

### 面板里直接对话

内建 Chat 可以复用 pi 的凭据，也可以配置任意 OpenAI 兼容 endpoint（自配 provider）。模型还能调用 `create_todo` / `list_todos`，边聊边把要跟进的内容记进 Ticktodo。

### 从外部 Agent 使用 MCP

装好 Ticktodo 后，打开「⋯ → 设置 → Agent 连接（MCP）」，可以一键复制 pi / Claude Code / 通用 JSON 的配置。配置一次后，外部 agent 就能创建线索、查询线索、把当前对话关联到线索；**Ticktodo 不需要常驻运行**，MCP server 会直接写你自己的 `~/.ticktodo`。

- 认证并实测：`pi`、WorkBuddy 国内版 / WorkBuddy AI（会话绑定）；Claude Code 协议兼容。
- 所有匹配都在本机完成，不上传会话正文；设置里可以切「只读」或关闭自动关联。
- 开发模式或没有安装包时，可以用仓库里的 `packages/mcp-server/dist/tick-mcp.mjs`，设置页会显示当前可用的入口。

### 项目自动发现

扫描各工具会话文件的首行 header，取出真实 cwd；路径做 canonical 归一，再按 git 根上卷。同一个仓库的不同子目录不会炸成多个项目。

### 常驻，但不打扰

菜单栏常驻；面板默认置顶，也可以设为失焦自动收起。窗口位置和尺寸会被记住。

### 可选的用量与导出

- 用量默认关闭；开启后按会话显示 tokens / cost（provider 未上报成本时显示 `≥`）。
- 导出「未完成 / 全部」为 JSON + Markdown，只含索引与 `filePath`，不含对话正文。

## 支持的工具

| 工具 | 状态 | 会话发现 | 接着做 | 说明 |
|---|---|---|---|---|
| **pi** | ✅ 已支持 | ✅ | 终端 TUI | 需要本机装有 `pi` |
| WorkBuddy（国内版） | ✅ 已支持 | ✅ | 深链接 | 只读其本地数据库 / 会话文件；需要 WorkBuddy 桌面应用。可打开预填好的新建任务页；发送/绑定仍在应用里完成 |
| WorkBuddy AI（国际版） | ✅ 已支持 | ✅ | 深链接 | 独立适配器（独立身份、同一只读读取内核）；需要 WorkBuddy AI 桌面应用。可打开预填好的新建任务页；发送/绑定仍在应用里完成 |
| **Claude Code** | ✅ 已支持 | ✅ | 终端 TUI | 需要本机装有 `claude` CLI。新建会话用原生 `--prefill=` 预填输入框（不需要扩展）；回到会话用 `--resume <会话文件绝对路径>`。读 `~/.claude/projects`（认 `CLAUDE_CONFIG_DIR`） |
| **Qoder** / **Qoder CN** | ✅ 已支持 | ✅ | 终端 TUI | 两个独立适配器（`qoder` / `qoder-cn`）。Qoder 的会话就是 Claude Code 的格式，复用同一套只读读取内核，只声明自己的身份（`$QODER_CONFIG_DIR` / `$QODERCN_CONFIG_DIR`）。回到会话用 `qodercli[cn] --resume <id>`；**新建会话**会在终端里打开它并把文案放进剪贴板（⌘V 后回车；它没有草稿参数，提示词参数会立刻发送） |
| **Codex** | ✅ 已支持 | ✅ | 终端 TUI | 一个会话可能写在多个 `rollout-*.jsonl` 里（同一 thread id），全部文件都在 `SessionSummary.files`。用量取 `token_count` 累计值（input 含 cache，已扣除）。**新建会话**：在终端里打开 Codex 并把文案复制到剪贴板（Codex 没有草稿参数，提示词参数会立刻发送）——⌘V 后回车，不会自动发送 |
| **Cline** | ✅ 已支持 | ✅ | 终端 TUI | manifest + `messages.json`（整份重写）。用量取每条 assistant 消息的 AI SDK `metrics`。**新建会话**：在终端里打开 Cline，文案在剪贴板（⌘V 后回车，不会自动发送） |
| **Grok** | ✅ 已支持 | ✅ | 终端 TUI | 一个会话一个目录（`summary.json` + `updates.jsonl`，时间戳是秒）。子代理会话不列。**新建会话**：在终端里打开 Grok，文案在剪贴板（⌘V 后回车） |
| **omp** | ✅ 已支持 | ✅ | 终端 TUI | 与 pi 同布局，但首行是定宽 `title` 记录（session header 在第二行）；物理 `title` 记录才是当前标题（`title_change` 只是审计历史）。项目就是 home 时 Tick 会传 `--allow-home`（否则 omp 把会话落到 `/tmp`）。**新建会话**：在终端里打开 omp，文案在剪贴板（⌘V 后回车） |
| **Kimi Code** | ✅ 已支持 | ✅ | 终端 TUI | cwd 只在 `session_index.jsonl`（`state.json` 里没有）；主对话在 `agents/main/wire.jsonl`，子代理 wire 的用量计入同一会话。**新建会话**：在终端里打开 Kimi Code，文案在剪贴板（⌘V 后回车） |
| **OpenCode** | ✅ 已支持 | ✅ | 终端 TUI | 会话是 `opencode.db` 里的行（`session` 行自带 token/cost/model），所以 `filePath` 指向数据库。子代理会话不列。桌面版与 CLI 共用同一份数据、没有客户端归属字段 → 一个适配器提供两个入口（`capabilities.clients`）：桌面版只激活 App，CLI 能精确定位。**新建会话**：在终端里打开 OpenCode，文案在剪贴板（⌘V 后回车） |
| **ZCode** | ✅ 已支持 | ✅ | — | 与 OpenCode 同表结构，但 `session` 行没有 token 列（用量取 `model_usage`），且是桌面应用：**不能回到会话**，只读 |
| **DeepSeek Harness** | ✅ 已支持 | ✅ | — | 会话是**多帧 zstd**（本机一个文件 = 23,331 帧），Tick 自己按 zstd 块头切帧；标题与 token 总量取 dsh 自己的投影缓存，列会话只解压开头若干帧（取 header / 首条消息），不整份解压正文。**无法回到会话**：`dsh://` 只处理 `dsh://open` |
| **Claude Desktop** | ✅ 已支持 | ✅ | 深链接 | 独立适配器。读两套会话：Desktop 自己的会话（`<userData>/claude-code-sessions/…/local_<id>/.claude/projects`，用 `claude://code/continue` 打开）与被 Desktop adopt 的 CLI 会话（同一份 `~/.claude/projects`，用 `claude://resume` 打开）。可打开预填好的 `claude://code/new` 新建页。需要装 Claude 桌面版且登录过 |
| Cursor | 后续 | — | — | 存储格式待查 |

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

---

<div align="center">
  <sub>本地优先 · 你的数据井井有条地留在你的电脑上 · <a href="https://ticktodo.cc">ticktodo.cc</a></sub>
</div>
