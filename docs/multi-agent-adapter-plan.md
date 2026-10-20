# 多工具适配器：现状评估与落地计划

> **决策文档**（不是规范）。回答一个问题：把 magpie 覆盖的会话识别能力**全部**搬到 Tick，值不值得、能不能直接做。
> 依据：`docs/agent-session-storage-map.md`（跨工具的路径/格式/id/resume 对照）+ magpie 源码 + 本机实测。
> 规范约束仍以 `docs/rules/agent-tool-adapter.md` 为准。

## 0. 结论（先看这段）

1. **能全学，但不能全做**——不是技术不够，而是价值上限不同：Tick 的「新建并绑定」需要工具支持**预生成会话 id**，
   目前只有 `pi` 和 `claude` 有（`--session-id`）。其余工具分两类：能打开工具新建入口但**没有草稿 API** 的走
   `newSessionMode='prefill'` + `prefillDelivery='terminal-copy'`（打开终端 + 文案进剪贴板，不自动发送）；
   连新建入口都没有的才是 `newSessionMode='none'`（as-built：zcode / dsh）。
2. **真正卡住的是三处合同假设**，不是解析工作量：
   - 一个会话 = 一个文件（Codex 一个 thread 会续写成多个 rollout）；
   - 会话正文在文件里（OpenCode / ZCode / Cursor CLI / Alma 是 SQLite）；
   - 会话 id 由工具预先生成（其余工具都是「事后才知道 id」）。
3. **已完成的架构动作**：把「Claude 格式家族」参数化成 `ClaudeToolIdentity`（`packages/ai/claude`），
   于是 Qoder / Qoder CN 只写身份配置就能接入（本次已落地，见 §3 T1）。这是把后续同类工具的边际成本
   从「写一个解析器」压到「写 40 行身份」的关键。
4. **落地顺序（2026-10-20 已按此完成，见 §5）**：T1 Qoder×2 → P1 Codex / Grok / Cline / omp →
   P2 Kimi / OpenCode / ZCode → P3 dsh。长期可选：CodeBuddy（同 WorkBuddy 内核）、Droid（本机无数据）；
   Cursor / Alma 不建议（见 §4）。Hermes 只有聚合表、没有逐会话，**不建议**接入。

## 1. magpie 的读取器架构：学什么、不学什么

magpie 的 `internal/sessions` 是一个「**逐行状态机 + 按文件缓存 + 增量续读**」的统一管线：

| 它做的 | 我们学不学 | 理由 |
| --- | --- | --- |
| 每文件 `size/mtime/head` 指纹 + 只读新增部分（`Off`） | **学思路，不学实现** | Tick 会话最多几 MB，`(mtime,size)` 缓存已够；增量解析会把「修订版覆盖」搞复杂 |
| 逐 agent 的行解析器（`claudeFull`/`piParse`/`codexLine`…） | **学字段与过滤规则** | 这是唯一不可替代的知识：`isMeta`/`<synthetic>`/`providerData.usage`/`token_count` 累计值… |
| 统一 `Session` 模型：id/cwd/title/start/last/models/tokens/cost/**resume**/path/carry/subagents | **部分学** | Tick 的 `SessionInfo` 已覆盖 id/cwd/title/first/last/时间/用量；缺 `resume` 命令串（我们用 adapter 的 `resume()` 表达）与 `subagents` |
| `resumeCommand()`：每个工具一条可复制命令（`claude --resume <id>`、`qodercli --resume <id>`…） | **已学** | 落成各 adapter 的 `resume()`；命令矩阵见 §2 |
| 按天分桶（`day`：tokens/prompts/replies/tools/skills/active ms） | **暂不学** | 属于分析/报表需求，Tick 的 `SessionUsage` 只需会话级总量 |
| WSL / MSIX 包目录 / 符号链接根（`walkLinked`） | **暂不学** | Tick 只做 macOS；`window`/MSIX 不在范围 |
| `carry`（把一个工具的会话交给另一个工具继续） | **暂不学** | 需要写工具侧状态，违反「适配器只读」；合同里 `carry` 位保留 |

## 2. 能力矩阵（会话读取 + 能不能从 Tick 新建）

`launch` = 能预生成 id（`--session-id` 类）；`prefill` = 打开工具的新建入口并投递文案（GUI 深链接 `deeplink` 或终端 + 剪贴板 `terminal-copy`，见 `capabilities.prefillDelivery`）；`none` = 只能倒入历史会话。

| 工具 | 存储 | 会话读取难度 | resume 通道 | 新建 | Tick 落地档位（2026-10-20 更新：CLI 走 `prefill`/terminal-copy） |
| --- | --- | --- | --- | --- | --- |
| pi | `~/.pi/agent/sessions/--cwd--/<ts>_<uuid>.jsonl` | 已做 | `pi --session <path>` | **launch** | 已接入 |
| Claude Code | `~/.claude/projects/<enc>/<uuid>.jsonl` | 已做 | `claude --resume <path>` | **launch**（`--prefill` 也有） | 已接入 |
| Claude Desktop | 每会话 `.claude` home + 全局 store | 已做 | `claude://code/continue` / `claude://resume` | prefill | 已接入 |
| **Qoder / Qoder CN** | `~/.qoder[ -cn]/projects/<enc>/<id>.jsonl`（**Claude 同格式**） | **零**（复用内核） | `qodercli[cn] --resume <id>` | **prefill**（terminal-copy） | ✅ 已接入（T1，本机未装） |
| **Codex** | `~/.codex/{sessions/<y>/<m>/<d>,archived_sessions}/rollout-<ts>-<threadId>[_seg].jsonl[.zst]` | 中高（**一 thread 多文件**、zstd） | `codex resume <id>` | **prefill**（terminal-copy） | **✅ 已接入（T2 + `files[]`，本机 151 条实测）** |
| **Grok Build** | `~/.grok/sessions/<url enc cwd>/<id>/{summary.json,updates.jsonl}` | 中（秒级时间戳、目录型会话） | `grok --resume <id>` | **prefill**（terminal-copy） | **✅ 已接入（本机 2 条空会话，消息口径仅 magpie 证据）** |
| **Cline** | `~/.cline/data/sessions/<id>/{<id>.json,<id>.messages.json}` | 中（**整份重写**，不能按追加读） | `cline --id <id>` | **prefill**（terminal-copy） | **✅ 已接入（本机 1 条实测）** |
| **omp** | 同 pi，多一个 title 行与 artifacts 子代理 | 低（复用 pi 内核） | `omp --resume <id>`（+`--profile`） | **prefill**（terminal-copy） | ✅ 已接入（本机 52 条真实会话） |
| CodeBuddy Code | `~/.codebuddy/projects/<enc>/<id>.jsonl`（WorkBuddy 同格式） | 低（复用 buddy 内核，去掉 DB 依赖） | `codebuddy --resume <id>` | none | T1 候选（本机无数据） |
| Droid | `~/.factory/sessions/<enc cwd>/<id>.jsonl` + `<id>.settings.json` | 中（usage 在 settings，会话级总数） | `droid --resume <id>` | none | T2（本机无数据） |
| **Kimi Code** | `~/.kimi-code/sessions/<slug>/<id>/{state.json,agents/*/wire.jsonl}` + `session_index.jsonl` 的 `workDir` | 中（一会话多 agent 文件，要聚合；**cwd 不在 state.json**） | `kimi --session <id>` | **prefill**（terminal-copy） | ✅ 已接入（本机 117 条实测） |
| **OpenCode** | `~/.local/share/opencode/opencode.db`（`session` 行**自带 tokens/cost/model**） | 低（不用读 message 表就能出用量） | `opencode --session <id>` | **prefill**（terminal-copy） | ✅ 已接入（本机 61 条根会话） |
| ZCode | `~/.zcode/cli/db/db.sqlite`（OpenCode 表结构 + usage 表） | 中（同 OpenCode） | **无**（桌面） | none | ✅ 已接入（本机 18 条；桌面只读、无 resume 通道） |
| Cursor CLI | `~/.cursor/chats/<md5(cwd)>/<id>/store.db`（blob） | 高（cwd 只能靠 md5 反查） | `cursor-agent --resume <id>` | none | T4，**不建议** |
| Alma | `~/Library/Application Support/alma/chat_threads.db` | 高（Electron 库 + 不可 resume） | 无 | none | 不建议 |
| MiniMax Code | `v2/sessions/<y>/<m>/<d>/<ts>-session_<b64 id>/messages.jsonl` | 中（目录名带 base64 id） | 未知 | none | T2 候选 |
| Antigravity (agy) | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl` | 中 | 未知 | none | T2 候选 |
| DeepSeek Harness | `$DSH_HOME/sessions/<project>/<dir>/session[.v<N>].jsonl[.zstd]`（**多帧 zstd 追加**） | 中（按帧切分 + 投影缓存） | **无**（只有 `dsh://open`） | none | ✅ 已接入（本机 39 条顶层会话；**不能回到会话**、MCP 回扫不支持） |
| Hermes | SQLite 聚合表（`session_model_usage`） | — 只有聚合，无逐会话/标题/cwd | 无 | none | **不建议** |

## 3. 分档与工作量

### T1 — 零解析成本（Claude 家族 / pi 家族）：~40 行/工具

- **已完成**：`ClaudeToolIdentity` 参数化；`@tick/ai-qoder` 的 `qoder` + `qoder-cn`（两个 toolId、两份缓存、各自 env）。
- **可做**：CodeBuddy Code（WorkBuddy jsonl 内核去掉 DB 依赖）、omp（pi 内核 + `--profile`）。
- 验收：会话列表/详情/用量/回到会话四条通路，加上 `launch()` 明确拒绝；新建能力按有没有入口分别声明
  `newSessionMode='none'`（无入口）或 `prefill` + `terminal-copy`（有入口、无草稿 API）。

### T2 — 纯函数解析器：~150–250 行/工具，**不需要改合同**

Codex（除多文件聚合外）、Grok、Droid、Cline、Kimi、MiniMax、agy、dsh。
共同点：一条工具自己的记录流 → `SessionInfo` + `SessionUsage`；`filePath` 指向主文件（或会话目录里的主 jsonl）。

### T3 — SQLite（Tick 已有先例：`node:sqlite` 只读 + WAL 复制兜底）

OpenCode、ZCode：`session` 表给 id/cwd/title/时间与归档位；正文在 `message`/`part` 表。
用量来源不同：OpenCode 的 `session` 行自带 token/cost，ZCode 的 `session` 行**没有** token 列
→ 取 `model_usage`（缺失时回退 `message.tokens`）。
`filePath` 变成「数据库路径 + session id」（导出只能给 id，不能再给正文文件），需要**文档写清楚**。

### T4 — 需要先动合同

| 需求 | 现在 | 要改成 | 影响面 |
| --- | --- | --- | --- |
| **一个会话多文件** | `SessionSummary.filePath: string` | `filePath` 允许是「主文件」+ 新增可选 `files?: string[]`（或 `threadId`） | 导出（`export.ts` 展示/复制路径）、`SessionService`、UI 的「定位文件」 |
| **会话在数据库里** | 同上 | `filePath` 语义放宽为「可定位的存储」 | 导出不能再假定「读文件拿正文」 |
| **不能 resume** | `capabilities.resumeSession` | 已有（置 false 即可） | 无 |
| **子代理会话** | 不建模 | 可选新增 `parentSessionId` | 时间线/用量归属（PRD P0 相关） |

结论：**T1/T2 现在就能做**；T3 只差「`filePath` 不是 jsonl」这一个文档约定；T4（Codex 多文件、子代理）建议与
`docs/prd-session-timeline.md` 的 P0-1..P0-6（`SessionDigest` / 状态归一）合批做，避免两次改合同。

## 4. 为什么「全部做」不划算（诚实评估）

1. **13 个工具都只能导入、不能新建并绑定**：Tick 的核心卖点是「从 todo 一键开新会话并自动绑定」，
   这条价值只有 pi / claude 能兑现（其余工具能打开新建入口的也只有 `prefill` + `terminal-copy`，
   由用户在工具里按 ⌘V+回车，无法在 Tick 侧绑定）。它们带来的「会话索引 + 回到会话」价值仍在，但边际收益递减。
2. **每接一个就多一份长期维护债**：工具格式无兼容承诺（magpie 自己的注释里就有大量 `#1605`/`#1913`/`#2273`
   这类「某版本变了」的修复）。接 15 个 = 长期跟进 15 份格式。
3. **有明确的高风险低收益项**：Cursor CLI（`md5(cwd)` 反查 + blob 库）、Alma（Electron 私有库、不可 resume）、
   Hermes（只有聚合表）——不建议做。
4. **WSL / Windows / MSIX 一律不做**：Tick 只支持 macOS。

## 5. 推荐路线图（2026-10-20 更新）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | Qoder + Qoder CN（T1，复用 Claude 内核） | ✅ 已落地 |
| P1 | **Codex**（T2 + 合同扩展 `files[]`）、**Grok**、**Cline**、**omp** | ✅ 已落地（本机 151/2/1/52 条实测；Codex 多文件归并在夹具里验证） |
| P2 | **Kimi**、**OpenCode**、**ZCode** | ✅ 已落地（本机 117 / 61 / 18 条实测；ZCode 无 resume 通道，`resumeSession=false`） |
| P3 | **dsh**（DeepSeek Harness） | ✅ 已落地并补齐（本机 39 条顶层会话 / 80 个目录；多帧 zstd 切帧 + 投影缓存；列表带首条消息与模型；未压缩会话与多世代也支持；**不能回到会话**、MCP 回扫不支持） |
| P4 | CodeBuddy、Droid、MiniMax、agy、Alma | 未做（CodeBuddy/Droid 本机无数据；Alma 不可 resume） |
| 不做 | Cursor CLI / Hermes / 任何 Windows-WSL 逻辑 | 理由见 `docs/agent-session-storage-map.md` §2 |

**合同扩展已在 P1 落地**：`SessionSummary.files?: string[]` / `SessionInfo.files?: string[]`（缺省 = 只有 `filePath`）。
`filePath` 仍是「最新的主文件」，导出/定位默认打开它；多文件会话（Codex）全部文件都在 `files` 里。

**新增的验证命令**：`pnpm verify:agents`（`scripts/verify-agent-stores.mjs`）——逐个工具跑真实数据，
证据分级 `IMPL`（有适配器，真跑列表/详情/用量）/ `STORE`（无适配器，只核对存储布局）/
`NOT-INSTALLED`（本机没装）/ `NO-SESSIONS`（装了且存储为空）；任一读取抛错都记 FAIL 并以 exit 1 结束。

### 交叉评审（2026-10-20，4 个 subagent）

用 4 个 subagent 分组评审（Claude 家族 / 文件型 CLI / 数据库型 / dsh+pi+WorkBuddy），要求每个工具都用
**与适配器无关的独立方法**（`find|wc`、`jq`、`sqlite3`、`zstd -dc`）核对 10 项不变量。真实发现并已修：

| 工具 | 问题 | 修正 |
| --- | --- | --- |
| omp | 会话目录里的**子代理 transcript**（`ExploreUsageCode.jsonl` 等 109 个）被当作会话列出（161 vs 52） | 主会话只认 `<ts>_<uuid>.jsonl` |
| opencode | 44% 的 user text part 是 `<system-reminder>` 注入，直接进了首/末条消息 | `cleanUserText()` 剥离注入块并丢弃整条注入 |
| opencode | 8 个根会话带子会话，**子代理用量不在父行里**（1 个父 56k < 子 103k） | 子代理用量加回父会话（与 dsh 同口径） |
| zcode | 6/18 个根会话没有 `model_usage` 行 → 用量显示 0 | 回退 `message.tokens` 汇总；子代理同样加回 |
| kimi | `lastUsedAt` 用 `state.updatedAt`，51/117 条比 wire 最后事件早（最多 1 天+） | 取 `max(state.updatedAt, wire.lastEventAt, mtime)` |
| claude-desktop | 「登录过」只查 `Claude`，本机会话在 **Claude-3p** 下 → 误判未登录 | 两个 profile 都查（含 `claude-code-sessions`） |
| qoder / qoder-cn | 未安装时的 resume 文案写死「Claude Code 会话文件不存在」 | 共享内核改用本工具 id |

`pi` / `claude` / `codex` / `cline` / `grok` / `workbuddy` / `workbuddy-ai` / `dsh` 的 10 项核对全部一致
（codex 按 thread 归并与 `token_count` 累计值、dsh 子代理用量加回父、WorkBuddy 软删除/云端过滤均实测吻合）。

每个工具的接入验收都套 `docs/rules/agent-tool-adapter.md` §10 的清单；**额外要求**：
在 `docs/agent-session-storage-map.md` 里把它那一行的「难度/新建能力/证据等级」从推断改成实测。

## 6. 下一步（2026-10-20 的历史记录；Codex 等已落地，见 §5）

> 本节保留当时的决策背景；P1–P3 已在本分支落地，后续候选只剩 P4（CodeBuddy / Droid / MiniMax / agy / Alma）。

P1 里先做 **CodeBuddy Code**（几乎零成本，能立刻验证 T1 模板的复用性），还是直接跳到 **Codex**
（用户基数最大，但要先扩 `filePath` 合同）？我的建议是先把 T1 模板用 CodeBuddy 再跑一遍（半天），
确认「身份配置化」真能覆盖非 Anthropic 家族的 jsonl 变体，再动合同。
