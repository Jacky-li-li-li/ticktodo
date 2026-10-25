# Agent 工具接入规范（Tick 适配器）

> **规范性文档（MUST / MUST NOT）**：管「如何给 Tick 接入或修改一个 AI 工具适配器」，不是调研记录。
> 适用代码：`packages/ai/*`、`apps/desktop/src/main/{main.ts,ipc.ts,services/*}`、renderer 的 `ToolIcon`。
> 与 as-built 代码冲突时，**以代码为准，并在同一个 PR 回写本文件**。
> 前置阅读：`CLAUDE.md`（必须保持的不变量）、`docs/已对齐/TECH-ARCH-tick.md` §6、`docs/prd-session-timeline.md`（会话证据合同）。

## 0. 一句话

适配器只做三件事：**只读工具自己的数据** → **吐证据**（cwd / 时间 / 消息 / 状态）→ **把用户送回会话**。
归并、缓存、UI、todo 都不在适配器里。

## 1. 工具身份

**MUST**

- `id` 稳定、小写 kebab（`pi`、`workbuddy`、`workbuddy-ai`）。
- **同一工具的不同发行版 = 两个独立适配器**：各自的数据根目录、App bundle、缓存键、依据等级、`toolId`；不通过切换环境变量/根目录复用同一个适配器（例：国内版 `workbuddy` 与国际版 `workbuddy-ai`）。
- 会话 id 用工具侧原始 id，经 `newCliSessionId` 交给 core；`(toolId, sessionId)` 必须全局唯一，命名空间就靠这个二元组——**不要给 sessionId 加 `toolId:` 前缀**（共享层只做品牌转换；as-built 与 PRD 均已按此收敛）。
- 图标在 `apps/desktop/src/renderer/features/icons/ToolIcon.tsx` 登记，**两条路**：官方有矢量 mark 的用内联 SVG（`ICONS`），只有 App 图标/位图 favicon 的用位图资源（`MARKS` + `assets/`，来源逐条记在 `assets/README.md`）。未登记只显示文字，不要猜图标。
  已登记：`pi`、`workbuddy`、`workbuddy-ai`（两个 WorkBuddy 的官方 mark 相同，国际版图标在官方 mark 上叠 Tick 自加的右下角地球徽标用于区分，不能对外当官方 logo 使用）、`claude` 与 `claude-desktop`（共用 claude.ai 官方星芒 mark；官方没有区分 CLI/Desktop 的图形，区分靠展示名，不另造图形）、`kimi`、`zcode`、`dsh`（三个官方桌面应用的 App 图标）、`qoder` / `qoder-cn`（同一官方 mark）、`cline`、`grok`、`opencode`、`omp`（官方站点/仓库的位图或 hero 图形）。
  **`codex` 没有独立 mark**：用 **OpenAI 官方 blossom**（`developers.openai.com/favicon.svg`，去掉蓝色底圆、按官方单色用法转黑）标识厂商，不自行重绘；来源与理由写在 `assets/README.md`。若将来拿到 Codex 独立 SVG，换成它并回写本条。
- 工具是否安装的展示走 `detect()`，不要在 UI 里猜；2026-10-19 起不做版本校验（装了就按可用处理）。

## 2. 合同最小集（`packages/ai/core/src/index.ts` 的 `AiToolAdapter`）

| 方法 / 字段 | 必填 | 语义与硬要求 |
| --- | --- | --- |
| `id` | MUST | 见 §1；与 `Todo.bindings[].toolId`、图标、依据表一致 |
| `detect()` | MUST | 返回 `installed/reason`；只判「装没装」——不能靠数据目录判断已安装（卸载残留、其他工具会写入数据目录）；2026-10-19 起不探测/校验版本号。**CLI 工具还必须能在 GUI 最小 PATH 下定位可执行文件**：Finder 启动的 .app 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，靠硬编码几个前缀会漏装（npm 自定义 prefix / nvm / fnm / volta / bun / `~/.local/bin`）。参考 `@tick/ai-pi` 的 `probe-exe.ts`：常见前缀 → 进程 PATH → 登录 shell PATH 兜底（带超时），不要用「跑 `--version`」来证明安装 |
| `capabilities` | MUST | 与实现一一对应；任一位为 `true` 就必须实现对应方法，为 `false` 时 UI 不会调用 |
| `capabilities.newSessionMode` | MUST | 三选一（**不统一各工具的 session id 生成方式**）：`launch` = Tick 预生成 id 并拉起（CLI，`launch()` + 绑定/verify）；`prefill` = 只打开 GUI 新建页并预填文案/工作目录（桌面，`openNewSessionPage()`，不自动发送/不绑定）；`none` = 不支持从 Tick 新建。UI 用同一「新建会话」入口，按该模式分流 |
| `launch(ctx)` | MUST | 用 `ctx.sessionId` 预生成 id，不得自行生成；桌面工具没有 CLI 启动时直接抛错 |
| `resume(id, ctx)` | MUST | CLI 用工具自己的 resume 参数；桌面工具走深链（见 §6） |
| `listSessionInfos()` | 列表 UI 必需 | 返回 `SessionSummary[]`，`filePath` 供导出/定位；`exists` 必须是文件系统事实 |
| `describeSession(id,{withName})` | 绑定/详情必需 | `withName:false` 时**只读 header/元数据**，不得扫全文 |
| `verify(id)` | 只有「launch 会新增会话」的工具 | **绕缓存直读**；`size === 0` 不算产生；只能返回 false 表达「没看到」，不得假装 true |
| `discoverProjects()` | 参与项目索引时 | 只吐原始证据（cwd / 会话数 / 最近时间），归并交给 core 的 `mergeProjects` |
| `computeUsage(id)` | `capabilities.usage=true` 时 | 口径写清楚（去重键、cache read/write、成本是否可信）；不可信时设 `costReported=false` |
| `listSessions()` | 旧接口，兼容用 | 新实现优先 `listSessionInfos` |
| `carry` | 可选 | 跨工具接手方向是**有向非对称**的；不可行方向不要在 UI 里暗示可行 |

补充：

- **MUST NOT** 在适配器里做跨工具归并、缓存共享、todo 状态联动。
- **MUST NOT** 让 `packages/ai/*` 依赖 Electron / renderer；需要的外部副作用（剪贴板、终端、时钟）由 main 注入（参考 `PiAdapterDeps`）。
- 合同参考实现：CLI 工具看 `packages/ai/pi/src/adapter.ts`（launch/verify/resume/carry 的完整语义）或 `packages/ai/claude/src/adapter.ts`（无首行 header 的流式元数据 + 原生预填）；桌面工具看 `packages/ai/workbuddy/src/base-adapter.ts`、`packages/ai/claude-desktop/src/adapter.ts`（只读 jsonl/DB + 深链接 resume，`launch()` 直接抛错）。

**不能预生成会话 id 的工具**（没有 `--session-id` 类能力，例如 Codex / Cline / Grok / omp / Kimi / OpenCode / Qoder）：
`launch()` MUST 直接抛错，并按「有没有新建入口」二选一：
`newSessionMode='none'`（没有新建入口；as-built：`zcode` / `dsh`）或
`newSessionMode='prefill'` + `prefillDelivery='terminal-copy'`（能打开工具的新建入口、只把文案放进剪贴板；
as-built：上列 CLI，见 §6）。
它仍然 MUST 提供 `listSessionInfos` / `describeSession` / `resume` /（有的话）`computeUsage`，因为「倒入历史会话 +
回到会话」本身就是产品价值。**MUST NOT** 为了凑出 `launch` 而让 Tick 自己造一个 id（工具侧不认，绑定必然对不上）。

**一会话多文件**：若工具会把同一个会话续写到多个文件（as-built：Codex 的 `rollout-…[_seg].jsonl`），
MUST 在列表层按工具自己的会话 id 归并成**一条**会话，`filePath` 指向最新文件，并用 `SessionSummary.files`
给出全部正文文件；`describeSession` / `computeUsage` 必须把全部文件都算进去（用量按文件基线累加，不能重复计）。

**同一工具的两个形态：有归属字段才拆成两个适配器**：当桌面 App 与 CLI **共用同一份会话存储**时（as-built：`claude` 与 `claude-desktop` 都读 `~/.claude/projects/<project>/<uuid>.jsonl`），MUST 用工具自己写进正文的归属字段（此处 `entrypoint`）在**列表/项目发现**层互斥——CLI 适配器排除桌面会话、桌面适配器只收桌面会话，否则同一会话会在「倒入历史会话」里出现两次、且 resume 会路由到错误的工具（**被 adopt 的会话例外见下条**）。**按 id 直查（`describeSession` / `verify` / `resume`）不过滤**，否则旧绑定会因为归属字段缺失而变成「会话不存在」。共用的是读取内核（可直接 import 另一个 ai 包的纯函数），**不共用**身份、`toolId`、`capabilities`、缓存与失败模式。反过来，**没有**任何归属字段时不要拆（同一条会话无法路由）——按 §6 的 `capabilities.clients` 表达多入口（as-built：OpenCode 桌面版/CLI 共用 `opencode.db`）。

**as-built 例外：被 adopt 的会话允许双入口各列一次**（与 §6 的多客户端不拆判据一致——都是「同一对话、两个入口」，只是这里入口分属两个 `toolId`）。桌面 App 会**原地 adopt** CLI 会话（as-built：Claude Desktop 的 `adoptCliSession`，正文仍在 `~/.claude/projects`、Desktop 记录里 `cliSessionId=<CLI uuid>`），这类会话在 `claude`（id = CLI uuid，`claude://resume`）与 `claude-desktop`（id = `local_<id>`，`claude://code/continue`）下**各列一次是已知设计**，不违反上面的互斥要求：互斥只约束「同一 `toolId` 内不得重复列」，adopt 会话保留桌面入口必须靠双 id。代价是项目会话数会在两个工具之间各计一次（`mergeProjects` 求和，UI 侧如要消歧按 `filePath` 去重/标注）；`(toolId, sessionId)` 唯一性仍成立，不会跨工具误路由。

## 3. 落地改动面（MUST 清单）

| 位置 | 要做什么 |
| --- | --- |
| `packages/ai/<tool>/` | 新增包：`adapter.ts` + 解析/用量等纯函数 + `index.ts`；tsconfig 走全仓 project references |
| `apps/desktop/src/main/main.ts` | 构造适配器 → `registry.register(...)`；服务装配 |
| `apps/desktop/src/main/services/*` | **as-built 已是多适配器**：`SessionService` / `LaunchService` / `ProjectIndexService` / `ExportService` 都持 `AiToolAdapter[]`（`main.ts` 装配期一次性 `registry.list()` 快照），按 `toolId` 路由——列表/绑定/`resume` 用 `binding.toolId` 精确定位，只有 adapter 不在时才逐个探测；`ProjectIndexService` 只调各 adapter 的 `discoverProjects()` 再把证据交给 `mergeProjects`；Export 用同一份 adapter 列表。新增工具时 MUST 复用这套数组/registry 视图，不要重新让服务持有某个具体 adapter，也不要在服务里硬编码 `toolId === 'pi'` |
| `apps/desktop/src/main/ipc.ts` | 复用现有通道（`ToolsIpc` / `SessionsIpc` / `UsageIpc` / `ProjectsIpc`）；新增能力才加通道 |
| 新增 IPC 通道时 | 四处必须同改：`packages/shared` 常量、`main/ipc.ts`、`preload/index.ts` 白名单、renderer hook |
| `apps/desktop/src/renderer/.../ToolIcon.tsx` | 登记图标；需要显示名时在 main/ipc 或统一映射里加，不要在组件里硬编码分支 |
| `docs/` | 工具笔记（实测/依据等级/未验证项）、PRD §10 依据表、`docs/rules/README.md` 登记（见 §9） |

**MUST NOT**：改 `packages/ai/core` 的合同/纯函数（除非确认是工具无关能力，单独 review）；在 renderer 读文件；把工具元数据镜像进 Tick 存储（权威源在工具侧）。

## 4. 数据源与读取纪律

**MUST**

- **只读**：不写工具任何文件、不改配置、不读密钥/认证文件（各工具的敏感清单写进自己的 notes）；不联网、不外发。
- 安装探测以 App bundle / 可执行文件为准；**数据目录存在不算已安装**。
- 未安装时适配器**静默禁用**：`detect()` 不通过就不得让该工具的会话/项目进入列表（`listSessionInfos` / `discoverProjects` 返回空、`describeSession` 返回 `undefined`），也不能凭残留数据目录判断「在用」。
- 根目录按工具自己的规则解析（App 内 `product.json`、各自独立目录、用户配置 > 环境变量 > 默认）；**MUST NOT 用环境变量猜版本或猜 build**（两个 build 各自独立路径/ bundle 区分）。
- 安装探测只判 `installed`（App bundle / 可执行文件）；**不再探测/校验版本号**（2026-10-19），版本差异由真实调用失败如实暴露；schema 探测（如 `PRAGMA table_info`）保留，缺列降级为空。
- 数据库只读打开（`mode=ro`）；WAL 场景打开失败再复制 db + `-wal` + `-shm` 到临时目录，**副本用完立即删除**；**MUST NOT 用 `immutable=1`**（会忽略 -wal）；SQL 注意 NULL 三值逻辑（用 `COALESCE` / `IS NULL`）。
- WorkBuddy 系（`workbuddy` / `workbuddy-ai`）的具体实现要求：用 `node:sqlite` 的 `new DatabaseSync(file, { readOnly: true })` 打开 `<root>/workbuddy.db`，**打开后立刻试读一次**（WAL 库缺 `-shm` / 目录不可写时构造成功、首次访问才报错），失败才复制 `db` + `-wal` + `-shm` 到 `mkdtemp` 临时目录并以普通方式打开副本；`node:sqlite` 在 Electron 44.8 / Node 24.22 实测可用，运行时缺失（更老的 Electron/Node）必须降级为空而不是崩。打开后用 `PRAGMA table_info(sessions)` 探测必需列，缺列即视为 schema 不识别、整体降级为空。
- jsonl：按行流式读；容忍末行半行；超长行跳过；未知 `type` 一律忽略；**时间戳单位写进代码注释与 notes**（ms/s）；cwd 以工具侧字段为准，**目录名不反解**。
- 子代理 / rollback / 临时文件按工具语义区分：子代理会话不并入主会话的「最后一条 user 消息」与时间线；`*.ndjson` 等不是消息流。
- 缓存：`size + mtime` 快路径（as-built）；**内容前缀哈希**确认「只在尾部追加」仍为后续项，未实现。DB 元数据（状态/标题）另按 DB 指纹或短 TTL 失效；首帧不得阻塞（预算见 PRD §7：单会话冷读 ≤ 2s，缓存命中 ≤ 100ms）。
- 会话正文 **MUST NOT** 落进 Tick 存储；只存证据/摘要，按 PRD 阈值截断/脱敏。

## 5. 消息与状态语义

- 首条 / 最后一条 user 消息用**同一套过滤规则**；合成消息（后台通知、压缩摘要、注入上下文）必须在 adapter 内过滤，core 不做跨工具启发式（PRD 已决定）。
- 标签包装按工具实测（如 `<user_query>`、带属性的 `<system-reminder data-role=…>`）；正则必须容忍属性，判据写进 notes，不凭记忆。
- 完成/活跃状态 **MUST** 读工具自带字段；**MUST NOT** 由文件 mtime 或猜测推断「完成」；未知取值映射 `idle` 并记录一次原因。
- fork / 子代理：区分父会话消息；用量不重复计；时间线归属按 PRD。
- 找不到合格 user 消息时走 PRD 保底文案，不抛错。
- **时间线证据（P0-1..P0-6，as-built 2026-10-25）**：`SessionInfo` 可选带 `lastUserMessage / lastUserMessageAt / lastEventAt / endedCleanly / running`；adapter 只给证据，状态归一（`active / idle / done / missing`）与消息截断（4000 字）由 core 的 `deriveSessionState` / `buildSessionDigest` 统一做（活跃窗口 10 分钟）。工具自报进行中填 `running: true`，完成态填 `endedCleanly: true`；未知/不识别一律**不填**，不要用文件 mtime 或启发式猜 `done`。派生缓存只存证据 + `(mtimeMs, size, lastUsedAt)` 指纹（`cache/session-digests.json`），状态每次按当前时钟重算。

## 6. 拉起 / 回到会话

- CLI 交互式：**MUST** 在终端里拉起（非 TTY 会静默降级）；argv 一律数组，**MUST NOT** shell 拼接；终端脚本由 main 侧做 POSIX 单引号转义。
- CLI 预填：**优先用工具自带的预填参数**（as-built：Claude Code 的 `--prefill=<text>`，2026-10-19 实测 2.1.302 可把文案填进输入框且不发送、不落盘），只有工具没有原生能力时才做「一次性文件 + 扩展 + ack」（pi 的路径）。注入面不复用另一个工具的私有协议。
- 桌面工具：用深链接；调用前 **MUST** 校验 id 在工具 DB 里存在且未被软删除（不存在/已删除的 id 不调用；已实测会回落首页或空会话页且无返回码）。`resume()` 前 `detect()` 未通过、id 查不到、或该类型会话已被判定为不可定位（如 WorkBuddy AI 的 `is_playground=1`）时，MUST 直接抛错并给可读原因。
- 桌面工具的 `launch(ctx)` MUST 直接抛错（「桌面应用不能从 Tick 新建会话」），不要返回假的 `LaunchResult`。
- **同一工具多个客户端共用一个数据源**时（as-built：OpenCode 桌面版与 CLI 共用 `opencode.db`），
  不要拆适配器（同一条会话会列两次，且没有归属字段可路由），而是声明
  `capabilities.clients: ToolClientId[]`（当前只有 `'desktop' | 'cli'`）：
  - UI 在该工具下方显示「打开方式」选择器，写 `settings.toolClients[toolId]`；
  - `LaunchContext.client` / `NewSessionPageContext.client` 由 `LaunchService` 解析（请求显式值 > settings >
    操作缺省：新建 `desktop`、回到会话 `cli`），适配器**必须**在两条分支上分别实现，缺省分支不受影响；
  - 数据读取（`listSessionInfos`/`describeSession`/`computeUsage`）**不因 client 改变**——客户端只是入口；
  - 没有「按会话打开」协议的客户端（OpenCode 桌面版）必须如实返回 `notice` 说明「只能打开 App」，
    不能假装定位成功；新建入口若支持真正的预填（不发送）才可用，否则退回「激活 App + 剪贴板」。
  - 判据是**端到端实测**：深链接必须能在 App 侧看到可观测效果（数据库/设置/路由落盘）。
    反例：OpenCode 1.19.3 的 `opencode://new-session` 在源码里能解析、主进程日志也收得到，
    但新布局没挂 renderer 监听 → 什么都不会发生（见 `docs/agent-session-storage-map.md`）。
- `capabilities.newSessionMode='prefill'` 有两种投递形态（`capabilities.prefillDelivery`）：
  - **`deeplink`**（缺省；WorkBuddy 系 / Claude Desktop）：`openNewSessionPage(ctx)` 只做「打开 GUI 新建页 + 深链接预填文案/工作目录」，**不自动发送、不预生成/绑定 sessionId**；`cwd` 必须是存在的绝对路径；深链接超过安全长度时要截断（按码点，不能劈开 emoji）并如实返回 `truncated`；未公开协议不再按版本门控（2026-10-19 移除），但实测版本要写进 notes。
  - **`terminal-copy`**（CLI：Codex / Cline / Grok / omp / Kimi / OpenCode / Qoder 两个发行版）：CLI 没有草稿 API——**它们的启动提示词参数会立刻发送**（实测 `opencode --prompt`、`cline "<prompt>"` 都会当场开跑）。所以 `openNewSessionPage(ctx)` MUST 只做两件事：在终端里打开工具的新会话（argv 不带 prompt），把文案写进剪贴板，并在 `notice` 里说明「⌘V 再回车」；**MUST NOT** 用启动参数把文案塞进去（那等于自动发送），也仍然不预生成/绑定 id。UI 必须原样展示 `notice`，不能写成「已预填」。
- 若 prefill 依赖工具侧扩展（如 pi 的 `session_start` + `setEditorText`），MUST 有消费回执（ack/文件消失）并在超时/失败时降级到剪贴板 + 可见 `notice`；**不得**在未确认时提示「已预填」。
- 深链接 `open` 恒 exit 0，**MUST NOT** 依赖返回值判断成败；失败不重试、不阻塞、给提示；**MUST NOT** 降级到另一个工具的 scheme（例如国际版失败后改调国内版 `workbuddy://` 属错误工具）。
- 深链接属未公开协议时，实测结论要写「样本数 + 版本范围」；不再因版本不在白名单而关闭入口（2026-10-19 起不做版本门控）。
- resume：CLI 按工具自己的 resume 参数（pi 为 `--session <会话文件绝对路径>` + 会话 header 的 cwd）；桌面按深链接。

## 7. 失败与降级

- `detect()` 失败 → 引导空态；**MUST NOT** 把「未安装」和「没有会话」混为一谈。
- 读不到 / schema 不识别 → 返回空证据，不报错、不影响其他会话；只要能拿到 id 仍应能定位。
- 单会话读取超时/异常必须隔离；日志记录一次原因（不含正文/标题/id）。
- **MUST NOT** 无限重试、把错误吞成成功、让一个工具拖垮整个时间线。

## 8. 安全与隐私（硬边界）

- 不联网、不外发；user 文本只落本机 `~/.ticktodo`，且按 PRD 阈值截断。
- 各工具的敏感文件清单（`keyblob` / `device-id` / `security/` / `settings.json` / `models.json` 等）**不读**；临时副本用完即删（含 `-wal`/`-shm`）；日志不含会话正文/标题/id。
- 凭据纪律见 `CLAUDE.md`：适配器不碰 `~/.ticktodo` 之外的任何密钥，也不读写工具自身凭据。

## 9. 文档交付物（MUST，随 PR 一起）

1. **工具笔记**（如 `docs/workbuddy-adapter-notes.md`）：数据格式、深链、依据等级（官方文档 / 第三方实现 / 仅本机逆向）、样本数、未验证项、复测方法；被推翻的结论**就地改写**，不要叠加「已被 X 取代」的括号注记。
2. **PRD §10 依据表**：逐条登记等级与来源；没有依据的能力不得写成「已决定」。
3. **`docs/rules/README.md` 登记**：新增规则文档必须登记；合同/流程变更同 PR 更新本文件。

## 10. 验证与验收

- `pnpm typecheck` **MUST** 通过；改 core / 适配器时还要跑相关 selftest（`pnpm selftest:prefill`、`pnpm selftest:timeline`）。仓库仍没有通用 test runner：断言写在 `scripts/selftest-*.ts`，由 `scripts/run-ts.mjs` 做 esbuild 临时打包。
- 需要验证纯逻辑/夹具时，用一次性 `.mjs` 或 Node 脚本；夹具必须脱敏，**不得提交真实用户数据**。
- PR 描述里逐条勾验收清单：
  - [ ] `detect()`：已安装 / 未安装 两态（不探测版本）
  - [ ] 列表：空态、单会话、多会话、文件丢失 → `missing`
  - [ ] 最后 user 消息：真实消息、合成消息、压缩摘要、无消息保底
  - [ ] 完成状态：`completed` / `active` / `error` / 未知 → 映射正确
  - [ ] 回到会话：冷启动 / 热启动 / 失败路径；id 不存在时不调用
  - [ ] `newSessionMode` 三态：已安装且 `launch`（可新建并绑定）/ 已安装且 `prefill`（只以「打开新建页」形式出现，发送后倒入绑定）/ `none` 或未安装（置灰 + 原因）；桌面工具调 `launch()` 必须抛错
  - [ ] `prefill` 路径：已安装桌面工具能从 Tick 打开 GUI 新建页并预填 `prompt` + `cwd`；发送前不产生会话/绑定；缺少文案/非法 cwd/未安装/深链接过长要有明确 reason 或 `truncated`
  - [ ] 只读校验：接入前后工具数据目录内容不变（应用自身写日志/DB 除外）
  - [ ] 性能：单会话冷读 ≤ 2s、首帧不阻塞
  - [ ] 文档：笔记 + PRD 依据表 + `docs/rules/README.md` 登记

## 11. 维护

- 适配器要在 notes 记录**实测过的版本范围**（仅作记录，不做门控）；工具升级后按笔记复测并更新（含 schema 探测结果）。
- schema/格式探测失败要降级而不是崩；本文件与合同能力同步变更（同 PR）。
- 新增「工具无关」的通用能力时，先确认它不属于 `ai/core` 纯函数职责，再单独评审。
