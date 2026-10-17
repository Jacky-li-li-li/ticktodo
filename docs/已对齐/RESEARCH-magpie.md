# 调研 · magpie（yetone/magpie）

| 字段 | 内容 |
|------|------|
| 仓库 | https://github.com/yetone/magpie |
| 规模 | Go · 5478 文件 · ~172 MB · 14.1k star · MIT（**不接收外部 PR**） |
| 定位 | 本地模型网关：`Every agent's model. One place.`——把各家模型/订阅收敛成一个本地网关，让任意 agent 切换模型、额度耗尽自动故障转移 |
| 调研日期 | 2026-10-17 |
| 调研动机 | 它虽然是网关，但**接了 60+ 个 agent**，且独立实现了每个 agent 的会话（session）读取——与 Tick 的"多工具会话索引"高度重叠 |
| 主要依据 | `docs/subsystems/gateway-sessions.md`、`docs/session-relocation.md`、`internal/agent/{agent,pi}.go`、`internal/sessions/{sessions,pi,carry,discovery}.go`、`internal/sessions/testdata/`、`README.md` |

---

## 0. TL;DR：对 Tick 的六条结论

1. **magpie 的 session 有 `Cwd` 字段，而且它跟我们一样从 agent 自己的文件里读**——"AI 会话索引层"这个方向被独立验证过，不是我们自己想出来的。
2. **它每个 agent 写一套会话读取器（16+ 个 reader、数百个测试）**，因为要解析正文算 token。**我们只要 `cwd` + 时间戳，只读首行，成本低一个数量级**——这是 Tick 能比它轻的根本原因，别照抄它的实现深度。
3. **两条 P0 缺陷现在就能补**：① pi 的目录/session 目录可被环境变量与 settings 覆盖，硬扫 `~/.pi/agent/sessions/` 会漏；② 目录列表按 mtime 缓存存在 **2 秒 racy 窗口**，刚 spawn 出来的 session 会"看不见"，会让我们的 `verify()` 误判成僵尸绑定。
4. **两个 Tick 完全没考虑的模型事实**：会话有**父子/子代理**（`ParentSession`/`RootSession`/`Subagents`），以及**跨工具接手**（`Carry`：`omp --fork <pi 文件>` 能接着跑，反向不行）。
5. **magpie 是"中间人"，Tick 是"旁路索引"**：网关拿得到 token/成本/路由，但拿不到 `cwd`/`path`/resume（它原话："the agent's own files of them are not on this computer"）；我们只读文件，拿得到 cwd 与 resume，拿不到成本。**互补，不冲突。**
6. **它的取数/冷启动机制可直接裁剪后照抄**（§7）：目录列表缓存 + 2s racy 窗口、`(size, mtime)` 文件级增量、Warm/Ask 两级调度（预热 1/4 核、页面请求即全速，来自真实事故 #1665）、checkpoint 落盘。这四条正好回答我们的 Q8。

---

## 1. 项目画像

**它做什么**：本地起一个网关 `127.0.0.1:3425`，说 OpenAI Chat / Responses / Anthropic Messages / Gemini 四种协议并互转；各 agent 把 base URL 指过来，就能用任意 provider 的模型。核心价值是**选模型、故障转移、成本与用量统计**。

**它不是什么**：它不负责"任务管理"，也不是 Todo。会话（Sessions）在它那里是**用量统计的一个维度**——"Every agent conversation with its cost and title, reopened in your terminal with one click"。

**形态**：菜单栏 App、窗口、TUI、Web UI、CLI、Docker、Termux。桌面端用 Go + 内嵌 WebView（`internal/gui/assets/plugins/…` 是按插件分目录的前端资源）。

---

## 2. 架构分层（与 Tick 对照）

```
magpie                              Tick（对照）
─────────────────────────────       ─────────────────────────────
internal/agent/*.go                 packages/ai/<tool>/
  · 每个 agent 一个文件（108 个）       · 每个工具一个包
  · 只管改配置（模型/base URL）         · 管拉起 + 会话 + 项目（合一）
internal/sessions/*.go              （同一包内）
  · 每个 agent 又一个文件（16 个 reader）
  · 只读 agent 的会话目录
internal/gateway/*                  —（我们不做中间人）
internal/usage/*（ledger）           —（我们不统计成本）
```

**关键差异**：magpie 把"配置"和"会话"拆成两个平行包，同一个 agent（pi）在两边各有一个文件（`agent/pi.go` 管 models.json/enabledModels，`sessions/pi.go` 管 session 文件解析）。
**Tick 按工具合在一个包里更好**——同工具的路径约定、版本、格式演进是耦合的，拆开反而要同步两处。

---

## 3. 会话模型（`internal/sessions/sessions.go` 的 `Session`）

```go
type Session struct {
    ReadOnly bool        // 只读，不能 resume
    Gateway  bool        // 只经网关看到，本机没有 agent 的文件
    Agent    string      // magpie 的 agent id
    ID, Cwd, Title, Nickname
    Start, Last time.Time
    Role, ParentSession, RootSession string   // ← 父子 / 子代理链
    ModelEffort, Models, Tokens, Cost, Unpriced
    Resume string        // ← "the command that picks the session up again"
    Path   string        // 主文件
    Carry  []Carry       // ← 别的 agent 能接手这条会话（见 §5）
    Transcript bool
    Subagents []Subagent
    WSL string
}
```

几条值得抄的语义：

- **`Title` 的 fallback 链**：`用户给的名字 → agent 自己的 title → 首条 prompt`。
  首条 prompt 还要**排除 `<…>` 上下文标签、`# AGENTS.md`、图片**，再压成一行——否则标题会是 `[System: ...]` 这种噪音。
  （这与我们的 `--name` 完全同构：pi 侧 `displayText = session.name ?? firstMessage`，我们只覆盖了第一档。）
- **`Resume` 是完整命令字符串**，不是 id：`cd '...' && pi --session <id>`（`inFolder(cwd, cmd)`，Windows 走 PowerShell）。
  adapter 返回"恢复命令"比返回 id 更灵活——不同工具语法不同时，命令由 adapter 组装。
  实证（`sessions.go:1458` `resumeCommand(distro, agent, id, cwd, path)`）：
  `pi --session <id>`、`claude --resume <id>`、`codex resume <id>`、`opencode --session <id>`、
  `cline --id <id>`、`omp --profile <p> --resume <id>`……
  **并且先过 `safeID.MatchString(id)`，不合法直接返回空**——拼 shell 字符串必须先校验字符集。
  （我们用 spawn 数组参数，不需要 shell 转义，但 id 的字符集校验仍然该做。）
- **`Gateway` 会话没有 path、没有 resume、没有 terminal action**：只能看，不能跳。
- **列表上限** `Limit = 200`、`All = 5000`。

---

## 4. 各 agent 的会话存储布局（`internal/sessions/testdata/` 实证）

这是本次调研最有价值的部分——**"项目/目录"在每个 agent 里的编码方式完全不同**：

| agent | 布局（来自 testdata） |
|-------|---------------------|
| pi / omp | `sessions/--work-pi--/2026-09-24T08-00-00-000Z_<uuid>.jsonl` |
| Claude / Qoder | `projects/-work-app/<uuid>.jsonl`（+ `subagents/agent-a1.jsonl`） |
| Codex | `sessions/2026/09/20/rollout-2026-09-20T15-48-28-<uuid>.jsonl` |
| Grok | `sessions/%2Fwork%2Fgrok/<uuid>/{summary,updates}.jsonl`（**URL 编码**） |
| Kimi | `sessions/wd_v14-june-subagent_000000000001/session_<uuid>/{state.json, agents/main/wire.jsonl}` |
| OpenCode | `storage/session/0f3a/ses_<id>.json` + `storage/message/…` + `storage/part/…` |
| WorkBuddy / CodeBuddy | `projects/Users-me-WorkBuddy-launch/<uuid>.jsonl` |
| DSH | `sessions/work-dsh-3f2a/dsh-a/session.v3.jsonl` |
| Cline | `sessions/<ts>_<hash>/<ts>_<hash>.{json,messages.json}` |
| MiniMax | `v2/sessions/2026/10/11/11-16-16-553-session_<base64>/messages.jsonl` |

**结论**：`-`、`%2F`、`wd_`、`Users-me-`、base64……没有统一规则。
→ 直接印证我们 §6.1 定的 **"adapter 只吐原始 `cwd`，归一化和上卷统一在 core"**：如果让每个 adapter 自己反解目录名，就是 magpie 现在这条路——16 套 reader 各写一遍。

**但我们比它轻**：它要解析正文算 token，我们只读首行 header 取 `cwd`，一个 adapter 的核心逻辑可以控制在几十行。

---

## 5. 两个 Tick 完全没考虑的事实

### 5.1 会话有父子（`ParentSession` / `RootSession` / `Subagents`）

一个会话里起子代理，会生成子会话文件（Claude 的 `subagents/agent-a1.jsonl`、pi/omp 的 `<session>/0-Explore.jsonl`）。
**影响**：绑定到 todo 的应该是 **root**，否则用户会看到一串碎片；UI 上可选展开子会话。
→ `SessionBinding` 需要能标记 `role: 'root' | 'sub'`，或至少 `listSessions()` 返回时过滤掉 sub、只在展开时给。

**好消息（零成本）**：pi 的 **header 首行里就有 `parentSession`**——
```go
// internal/sessions/pi.go:114 piLine
Type string; ID string; Cwd string; ParentSession string; Name string /*session_info*/; Title string /*omp*/ …
```
也就是说我们"只读首行"的约束**刚好能拿到父子关系**，不用多读一个字节。

### 5.2 跨工具接手（`Carry`）

```go
// carry.go：omp --fork <file> 读 pi 的会话文件，写出新的 omp 会话，pi 文件不动
case "pi":
    return []Carry{{Agent: "omp", Command: inFolder(s.Cwd, "omp --fork "+argQuote(s.Path))}}
```

注释里明确了边界：**pi → omp 可以（omp 读得懂 pi 的 v3 格式），反向不行**（pi 只在首行是 session header 时才打开文件，而 omp 首行是 title）。

→ 对 Tick 是多工具下的差异化能力：**"这条 todo 交给另一个工具继续"**。adapter 需要能声明 `carryTo?: { toolId, command }`，且这是**有向**的（不是对称能力）。

---

## 6. 对 Tick 的启示（可执行清单）

### P0 · 现在就补（否则会出 bug）

| # | 启示 | 落到哪 |
|---|------|--------|
| 1 | **pi 的目录可被覆盖**：`$PI_CODING_AGENT_DIR`（agent 目录）、`$PI_CODING_AGENT_SESSION_DIR` 或 `settings.json` 的 `sessionDir`（会话目录）。硬扫 `~/.pi/agent/sessions/` 会漏掉用户自定义的位置 | `PiAdapter.discoverProjects()` 先解析这三个来源（magpie 的 `piFilesIn(dir, sessionDir)` 就是这么做的） |
| 2 | **目录列表缓存有 2 秒 racy 窗口**：mtime 粒度粗，同一 tick 内新增的文件不改变目录 mtime，会"看不见"（magpie 的 `racyDirectory = 2 * time.Second`） | **`verify()` 必须绕过缓存直读**——否则刚 spawn 出来的 session 会被判成"没产生"→ 误标 `unverified`，正是我们想防的僵尸绑定的反面 |
| 3 | **`settings.json` 是 jsonc**（magpie 用 `tidwall/jsonc` 解析） | 读 pi 的 settings 要容忍注释与尾逗号，不能直接 `JSON.parse` |
| 4 | **fork 出来的会话会复制原会话的条目，连时间戳一起** | ~~S5 反向建索引时要按内容/时间去重~~ → **已撤销**：产品拍板「fork 出来就是两个会话，按真实情况，不去重」（`RESEARCH-pi.md` §3）。仅在**用量求和**时需跳过 fork 继承的那一段（`parentSessionPath` 存在时），与去重无关 |

### P1 · 多工具接入时

| # | 启示 | 落到哪 |
|---|------|--------|
| 5 | `SessionInfo` 现在只有 `exists`，不够：需要 `resumable`（`ReadOnly`）、`hasLocalFiles`（`Gateway`=false）、`role`/`parentSessionId` | Adapter 合同的 `describeSession()` 扩字段 |
| 6 | `Resume` 是**命令字符串**而非 id | adapter 返回 `resumeCommand?: string`，跨工具语法差异由 adapter 消化 |
| 7 | `Carry` 是有向的跨工具接手 | adapter 可声明 `carryTo?: {toolId, command}[]` |
| 8 | Title fallback 的第二、三档要过滤 `<…>` 标签 / `# AGENTS.md` / 图片 | 无 `--name` 时的标题生成规则 |

### P2 · 产品层面

| # | 启示 | 说明 |
|---|------|------|
| 9 | **Relocate 项目**（`docs/session-relocation.md`） | 目录改名/移动后，历史会话留在旧编码路径下"失联"。magpie 让用户显式迁移整个项目 store 并把 transcript 顶层 `cwd` 映射到新路径。**Tick 只读不动 agent 的文件**，所以更合适的形态是"标 stale → 提供『重新定位』→ 只做映射，不移动文件" |
| 10 | **隐私默认值**：对话记录开关**默认关**，确认对话框明说"prompt 里可能有你的私有文件和代码"，7 天 + 256 MiB 上限，`0700`/`0600`，一键清除，`KeepOwn` 防止同步/恢复时把它重新打开 | 我们"只读 header"已经更保守；但凡要做正文搜索/预览，必须照抄这套 |
| 11 | **删除 = 进回收站**（`trash/sessions/…`，7 天后真删，可恢复，正在活跃的拒绝删） | Tick 删除 todo 时"保留 session 元数据"，可考虑给绑定关系也做软删除 |
| 12 | **成本数据**：若将来想知道"这条 todo 花了多少钱" | 可以读 magpie 的 usage ledger（若用户装了 magpie）——但那是 P2+，且要它同意 |

---

## 7. 取数与冷启动：magpie 是怎么把数据拉出来的（Q8 的直接依据）

这一节回答的是**我们自己的 Q8**：ProjectIndex 要扫会话目录，面板却要一打开就可用，怎么办。
magpie 处理的是 8.9 GB / 数十万文件规模的同类问题，它的分层我们按量级裁剪后可直接用。

### 7.1 四层缓存，各管一件事

| 层 | 位置 | 缓存什么 | 失效条件 | 我们要不要 |
|---|---|---|---|---|
| **目录列表** | `sessions/discovery.go:33` `readDirectory` | 目录的**条目名字**（不缓存内容） | `mod` 或 `size` 变了；或**距上次列出 < 2s 就重读**（`racyDirectory`） | ✅ 要，含 racy 窗口 |
| **文件元信息** | `sessions.go:410` `stat` | `size` + `mtime`（每次都真 stat） | 不缓存，每次 stat | ✅ 要（便宜） |
| **解析结果（内存）** | `sessions.go:600` `cache map[string]*state` | 每文件的解析产物 | `Size != size \|\| Mod != mtime.UnixNano()` | ✅ 要（同我们的 `(path,mtime,size)` 缓存） |
| **解析结果（落盘）** | `sessions.go:608` `sessions.json` | 同上，跨进程保留 | `cacheVersion` 或 `zone` 变了 → **整体作废** | ✅ 要（我们有 `piVersion` 戳） |

**关键设计：目录缓存只存名字，文件仍逐个 stat。**
注释原话：*"Directory membership changes with the directory's mtime; file contents don't. Keep names only, and always stat candidate files for current size/mtime."*
—— 否则每次刷新都要重读每个项目目录里的每个文件。

### 7.2 racy 窗口（我们已经踩过一次，这里是它的出处）

```go
// discovery.go:26
// racyDirectory is how close to a directory's mtime a listing can't be
// trusted: mtimes are coarse (a Linux kernel tick, a second on some
// filesystems) and a directory's size often doesn't change, so an entry
// added in the same tick as a listing left the mtime as it was and stayed
// hidden.
const racyDirectory = 2 * time.Second
```

命中条件（`discovery.go:41`）：`mod 相同 && size 相同 && 距当时列出已超过 2s`。
**同一 tick 内新增的会话会被缓存藏起来** —— 这跟我们 `verify()` 想防的僵尸绑定正好相反：
刚 spawn 出来的 session 会被判成"没产生"（假阴性）。**`verify()` 必须绕过缓存直读。**

### 7.3 冷启动调度：Warm / Ask 两级（最值得抄的一条）

`quiet.go` 的注释讲了一个真实事故（#1665）：

> 8.9 GB of Claude Code and Codex sessions took ~40 s of CPU, and with twice as many
> readers as cores it held every core for the first ~15 s of magpie's start —
> 用户投诉"每次启动 CPU 就满"。

解法是两级调度：

```go
func quietReaders() int { return max(1, runtime.NumCPU()/4) }  // 预热只用 1/4 核
func Warm(fn func())    // 启动时的后台预热：没人等它，慢慢来
func Ask() (done func()) // 页面真的要数据了：立即恢复全速
func quiet() bool { return warming.Load() > 0 && asking.Load() == 0 }
```

`readSlot()` 在"只有预热在读"时限速（50ms 轮询等槽位），一旦有页面在等就立即放行。
**这条对我们直接可用**：Electron 里就是「Renderer 首帧用缓存渲染 → Main 后台低优先级扫 →
用户打开选择器立即提速 → 扫完 IPC 推送刷新」。我们规模小得多（103 会话 / 49 MB ≈ 1s），
但**接口要按两级预留**，否则以后规模上来会重蹈 #1665。

### 7.4 增量与断点：不要每次全量重读

- **追加式续读**：`callFile.Off` 记录已解析的字节偏移，`scanAt(path, off, …)` 从偏移继续
  （`sessions.go:1252`）。文件只增不改时，第二次扫几乎免费。
- **改了的文件整体重读**：`(size, mtime)` 任一变了就重解析（`sessions.go:757`）。
- **消失的文件从缓存删除**：`refresh()` 里比对 `all` 集合，`gone = true` 才触发落盘。
- **大文件优先**：`sort.Slice` 按剩余字节降序——*避免最后剩一个长文件单跑*。
- **并发上限**：`min(max(8, 2*NumCPU), 32, len(todo))`，*读盘会等 I/O，所以给 2 倍核数*。

### 7.5 checkpoint：中途退出不能白扫

```go
// sessions.go:878
// checkpointEvery is how often a long read of changed files keeps what it
// has read so far on disk.
var checkpointEvery = 5 * time.Second
```

理由写在注释里：*"a magpie quit before the end (its CPU full, #1665) kept nothing of it,
so the next start read it all again"*。
我们扫 49 MB 只要约 1 秒，可以简化为"扫完即存"，**但落盘接口要预留 periodic checkpoint**。

### 7.6 落盘：后台 goroutine + 折叠 + 原子替换

- 写盘在后台跑，**连续多次保存折叠成最新一次**（`saving.next` 覆盖）；
- 因为"放进 cache 的解析结果**永不再改**（新的解析从 clone 开始）"，所以 `maps.Clone` 就是快照；
- 落盘用 `CreateTemp` + `Rename`（`writeCalls`，`sessions.go:428`）——和我们的原子写一致；
- `cacheVersion` 写在**目录名/文件里**，旧版本缓存永不读取（`pruneCalls` 直接 `RemoveAll` 旧目录）。

### 7.7 一个独立印证

`List()`（`sessions.go:1016`）有这条注释：

> the keys are not truncated yet: assemble below drops an empty session, and a nonempty
> one must take its place rather than the page going short — **an empty file is not a session**（#1320）

我们扫出的 **31 个 0 字节 jsonl**（纯 UUID 文件名、无 timestamp 前缀）正是同一现象。
magpie 独立得出"空文件不算会话"——**僵尸会话是真实存在的，不是我们的误判**。

### 7.8 对 Tick 的取舍

| magpie 机制 | 我们照做？ | 理由 |
|---|---|---|
| 目录列表缓存 + 2s racy 窗口 | ✅ **照做** | `verify()` 必须绕缓存，否则假阴性 |
| 文件级 `(size, mtime)` 增量 | ✅ **照做** | 已在 PRD §9 缓存口径里 |
| Warm / Ask 两级调度 | ✅ **照做（接口）** | 现在量小，但要按"可能变大"设计 |
| checkpoint 落盘 | ⚠️ 预留接口 | 1 秒级扫描暂不需要 |
| 64 路 IO 锁 / 分片 gob 缓存 / 16384 上限清空 | ❌ 不抄 | 我们只读首行、不拼正文，用不上 |
| `zone` 时区戳 | ❌ 不抄 | 我们不按日聚合 |

---

## 8. 不要抄的

- **不要自己编 session id**。magpie 的原则是 "never makes up an id for a request without one"——因为"an id nothing lists couldn't be opened"。
  我们预生成 `--session-id` 是安全的（pi 确实用它创建文件），但**必须 `verify()`**：不 verify 就等于编了个可能打不开的 id。这条反向佐证了我们之前的决策。
- **不要解析正文**。magpie 为了 token/成本必须读全文，还要做字节预过滤（`mayHold`：取查询最长词、1 MiB chunk、只解码命中行）才能让 58 个 3 GB 的 Claude 会话在 3–7 秒内搜完。我们不读正文，就不需要这套复杂度——**这是我们保持轻量的关键，别为了"也能看内容"破例**。
- **不要做网关/中间人**。magpie 的价值在路由与故障转移；Tick 的价值在索引与找回。两者互补：它可以知道每个会话花了多少钱，但不知道会话在哪个目录、不能 resume；我们反之。

---

## 9. 成本提醒

magpie 用 **16+ 个会话读取器、数百个测试文件**（光 `internal/sessions/` 就 277 个文件）证明了：**多 agent 会话索引的成本是 O(工具数 × 存储格式数)**。

所以 Tick 的多工具路线要清醒：

- 只做 pi 时，核心是几十行（glob + 首行 header）；
- 每加一个工具，成本取决于它的存储是否规整（Claude/Codex/Qoder 是 jsonl，OpenCode 是文件树 + SQLite，Cursor 是 SQLite + `-wal`）；
- **我们比 magpie 便宜的唯一原因是不读正文**——这个约束要写进纪律，不能逐步放松。
