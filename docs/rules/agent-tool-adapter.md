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
- 图标在 `apps/desktop/src/renderer/features/icons/ToolIcon.tsx` 的 `ICONS` 登记；未登记只显示文字，不要猜图标。已登记：`pi`、`workbuddy`、`workbuddy-ai`（两个 WorkBuddy 的官方 mark 相同，国际版图标在官方 mark 上叠 Tick 自加的右下角地球徽标用于区分，不能对外当官方 logo 使用）。
- 工具未安装 / 版本未验证的展示走 `detect()`，不要在 UI 里猜。

## 2. 合同最小集（`packages/ai/core/src/index.ts` 的 `AiToolAdapter`）

| 方法 / 字段 | 必填 | 语义与硬要求 |
| --- | --- | --- |
| `id` | MUST | 见 §1；与 `Todo.bindings[].toolId`、图标、依据表一致 |
| `detect()` | MUST | 返回 `installed/version/reason/usable`；`usable=false` 表示已安装但当前不可用（如版本过低）；不能靠数据目录判断已安装（卸载残留、其他工具会写入数据目录） |
| `capabilities` | MUST | 与实现一一对应；任一位为 `true` 就必须实现对应方法，为 `false` 时 UI 不会调用 |
| `capabilities.newSessionMode` | MUST | 三选一（**不统一各工具的 session id 生成方式**）：`launch` = Tick 预生成 id 并拉起（CLI，`launch()` + 绑定/verify）；`prefill` = 只打开 GUI 新建页并预填文案/工作目录（桌面，`openNewSessionPage()`，不自动发送/不绑定）；`none` = 不支持从 Tick 新建。UI 用同一「新建会话」入口，按该模式分流 |
| `detect().usable` | MUST | `false` = 已安装但当前不可用（如 pi < 1.3.0）。launch/prefill/UI MUST 同时看 installed + usable；只判 installed 会让旧版本静默失效 |
| `newSessionAvailability()` | 可选 | 版本/环境级的新建会话门控（如 WorkBuddy task 深链接只对实测版本开放）。`tools:status` 输出 `newSessionAvailable`/`newSessionReason`；UI MUST 保留「本机已安装」的工具，`false` 时禁用该行并显示 reason，不能隐藏已安装工具 |
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
- 合同参考实现：CLI 工具看 `packages/ai/pi/src/adapter.ts`（含 launch/verify/resume/carry 的完整语义）；桌面工具看 `packages/ai/workbuddy/src/base-adapter.ts`（只读 DB/jsonl + 深链接 resume，launch 直接抛错）。

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
- 版本探测：版本号 + 迁移目录/schema（如 `PRAGMA table_info`）；超出已验证范围要给「未验证」提示。
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

## 6. 拉起 / 回到会话

- CLI 交互式：**MUST** 在终端里拉起（非 TTY 会静默降级）；argv 一律数组，**MUST NOT** shell 拼接；终端脚本由 main 侧做 POSIX 单引号转义。
- 桌面工具：用深链接；调用前 **MUST** 校验 id 在工具 DB 里存在且未被软删除（不存在/已删除的 id 不调用；已实测会回落首页或空会话页且无返回码）。`resume()` 前 `detect()` 未通过、id 查不到、或该类型会话已被判定为不可定位（如 WorkBuddy AI 的 `is_playground=1`）时，MUST 直接抛错并给可读原因。
- 桌面工具的 `launch(ctx)` MUST 直接抛错（「桌面应用不能从 Tick 新建会话」），不要返回假的 `LaunchResult`。
- 桌面工具若声明 `capabilities.newSessionMode='prefill'`，`openNewSessionPage(ctx)` MUST 只做「打开 GUI 新建页 + 预填文案/工作目录」：**不自动发送、不预生成/绑定 sessionId**；`cwd` 必须是存在的绝对路径；深链接超过安全长度时要截断（按码点，不能劈开 emoji）并如实返回 `truncated`；未公开协议 MUST 只对实测版本开放（`taskVerifiedVersions` 类门控），未验证版本默认关闭。
- 若 prefill 依赖工具侧扩展（如 pi 的 `session_start` + `setEditorText`），MUST 有消费回执（ack/文件消失）并在超时/失败时降级到剪贴板 + 可见 `notice`；**不得**在未确认时提示「已预填」。
- 深链接 `open` 恒 exit 0，**MUST NOT** 依赖返回值判断成败；失败不重试、不阻塞、给提示；**MUST NOT** 降级到另一个工具的 scheme（例如国际版失败后改调国内版 `workbuddy://` 属错误工具）。
- 未在目标机器实测通过的深链接开关默认关闭；实测结论要写「样本数 + 版本范围」。
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

- `pnpm typecheck` **MUST** 通过（仓库唯一自动化检查；当前没有 test runner）。
- 需要验证纯逻辑/夹具时，用一次性 `.mjs` 或 Node 脚本；夹具必须脱敏，**不得提交真实用户数据**。
- PR 描述里逐条勾验收清单：
  - [ ] `detect()`：已安装 / 未安装 / 版本未验证 三态
  - [ ] 列表：空态、单会话、多会话、文件丢失 → `missing`
  - [ ] 最后 user 消息：真实消息、合成消息、压缩摘要、无消息保底
  - [ ] 完成状态：`completed` / `active` / `error` / 未知 → 映射正确
  - [ ] 回到会话：冷启动 / 热启动 / 失败路径；id 不存在时不调用
  - [ ] `newSessionMode` 三态：已安装且 `launch`（可新建并绑定）/ 已安装且 `prefill`（只以「打开新建页」形式出现，发送后倒入绑定）/ `none` 或未安装（置灰 + 原因）；桌面工具调 `launch()` 必须抛错
  - [ ] `prefill` 路径：已安装桌面工具能从 Tick 打开 GUI 新建页并预填 `prompt` + `cwd`；发送前不产生会话/绑定；缺少文案/非法 cwd/未安装/深链接过长要有明确 reason 或 `truncated`；未公开协议按版本实测
  - [ ] 只读校验：接入前后工具数据目录内容不变（应用自身写日志/DB 除外）
  - [ ] 性能：单会话冷读 ≤ 2s、首帧不阻塞
  - [ ] 文档：笔记 + PRD 依据表 + `docs/rules/README.md` 登记

## 11. 维护

- 适配器必须记录**已验证的版本范围**；工具升级后按笔记复测并更新（含 schema 探测结果）。
- schema/格式探测失败要降级而不是崩；本文件与合同能力同步变更（同 PR）。
- 新增「工具无关」的通用能力时，先确认它不属于 `ai/core` 纯函数职责，再单独评审。
