<div align="center">
  <img src="./site/icon-rounded.png" width="112" alt="Ticktodo" />
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
    <a href="#支持的工具">支持的工具</a> ·
    <a href="#文档">文档</a>
  </p>
</div>

> 当前版本支持 **pi**；WorkBuddy 等更多工具正在接入中。

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
