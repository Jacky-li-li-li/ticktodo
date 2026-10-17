# pi 官方规范实证调研

> 目的：Tick 的会话索引层要贴着 **pi 自身的设计规范**实现，不另发明一套。
> 本文只记录**有出处的结论**（官方文档 / 本机 dist 源码行号 / 本机真实会话文件统计），
> 不做推测。凡推测一律标注「待验」。

## 0. 调研对象与版本

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/earendil-works/pi （`packages/coding-agent`） |
| 远端 `package.json` version | **1.3.0** |
| 本机安装 | **1.2.0**（`/Users/jacky/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`） |
| 官方权威文档 | `docs/session-format.md`、`docs/message-types.md`、`docs/sdk.md`、`docs/cli-integration.md`、`docs/cli.md`、`docs/json.md`、`docs/rpc.md` |
| 本机实测样本 | 134 个 session 文件 / 49.2 MB / 9,389 条 assistant 消息 |

**⚠️ 版本差**：本机是 1.2.0，官方文档已是 1.3.0。开发前应升级，并在 `PiAdapter.detect()`
里做版本校验（架构 §6 已有约定）。下文所有官方引用以 main 分支为准。

---

## 1. 会话文件格式（官方 `session-format.md`）

路径：`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`
（`<path>` 去掉前导分隔符，`/` `\` `:` 全部替换为 `-`）

首行是 `SessionHeader`，**不在 id/parentId 树里**：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path/to/project"}
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path/to/project",
 "parentSession":"/path/to/original/session.jsonl"}
```

- `version` 现为 **3**（v1 线性 / v2 树 / v3 把 `hookMessage` 改名为 `custom`），
  加载时自动迁移 → **我们要容错 `version < 3`**，不能假设恒为 3。
- **`parentSession` 是源文件路径**，仅在 `/fork`、`/clone`、`newSession({parentSession})` 时出现。

Entry 类型全表（官方）：`session` / `message` / `model_change` / `thinking_level_change` /
`usage` / `compaction` / `context_edit` / `branch_summary` / `custom` / `custom_message` /
`label` / `session_info`。

与 Tick 相关的三条：

| 类型 | 用途 | Tick 怎么用 |
|---|---|---|
| `session_info` | `{"type":"session_info","name":"..."}`，`/name`、`--name`、`pi.setSessionName()` 写入 | Q2 已确认：选择器里 `displayText = name ?? firstMessage` |
| `session` + `parentSession` | fork 血缘 | F6 跨工具接手的判定依据 |
| `usage` / `compaction` / `branch_summary` | 用量 | 见 §2 |

官方明确：**`"pending"` 的 assistant 消息不会落盘** → 我们扫文件时不会遇到半条消息。
官方明确：**`context_edit` 不改变"raw history / accounting"** → 用量统计不受编辑影响，可以放心。
官方明确：session 可通过**直接删除 `.jsonl` 文件**移除（`/resume` 里 `Ctrl+D` 走 `trash` CLI）。

---

## 2. Usage：pi 会话本身**完整带用量**（回答 Q3）

### 2.1 有，而且是官方一等公民

`docs/message-types.md` L67–90 给出权威定义：

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;   // 是 cacheWrite 的子集（1 小时保留），不要相加
  reasoning?: number;      // 已包含在 output 里，不要重复加
  totalTokens: number;
  cost: { input, output, cacheRead, cacheWrite, total };
}
```

原文：**"Assistant messages always contain usage. Tool results can contain usage when the tool
performed nested model work."**

实测印证：本机 **9,389 / 9,389 条 assistant 消息 100% 带 usage**，零缺失。

### 2.2 官方规定的完整聚合口径（五个来源，缺一不可）

| 来源 | 位置 | 官方文档原话 |
|---|---|---|
| assistant 消息 | `message.message.usage`（role=`assistant`） | "always contain usage" |
| toolResult 消息 | `message.message.usage`（role=`toolResult`） | "contributes to full-session statistics"（嵌套模型工作，非主调用） |
| `type:"usage"` 条目 | `entry.usage` | "Usage entries contribute to session token and cost totals" |
| `type:"compaction"` | `entry.usage` | "included in session token and cost totals" |
| `type:"branch_summary"` | `entry.usage` | "included in session token and cost totals" |

官方还要求：**"Consumers should treat unknown `kind` values as normal usage rather than rejecting
them."**（`usage` 条目的 `kind` 是任意字符串，如 `cache_warm`）

**→ Tick 若做用量统计，必须按这五个来源求和，只算 assistant 会漏。**

### 2.3 本机实测（134 文件 / 49.2 MB）

| 来源 | 条数 | tokens | cost (USD) |
|---|---:|---:|---:|
| assistant | 9,389 | 1,525,136,195 | 39.4934 |
| toolResult | 0 | 0 | 0 |
| `usage` 条目 | 0 | 0 | 0 |
| `compaction` | 0 | 0 | 0 |
| `branch_summary` | 0 | 0 | 0 |
| **合计** | **9,389** | **1,525,136,195** | **39.4934** |

（本机未触发 compaction / cache_warm / 嵌套工具，故后四项为 0；真实用户跑久了会有。）

### 2.4 三个聚合陷阱（都会让我们显示错数字）

**陷阱 1 — `totalTokens` 里 99% 是 cacheRead，别当成"消耗"。**
本机拆解：`input=11,998,903`、`output=3,707,237`、**`cacheRead=1,509,430,055`**、`cacheWrite=0`。
即 15.25 亿 tokens 中 98.9% 来自缓存命中，只花了 $39.49。

> 修正本人上一轮的判断：我曾据单条样例（`input 6498 + output 216`）推断
> "input 是每轮重发的完整上下文、totalTokens 相加无意义"——**错了**。
> 那条样例 cacheRead=0。真实分布下 input 均值只有 1,278，重发部分走的是 cacheRead。
> 结论：**`totalTokens` 相加是有意义的**（模型实际处理量），但要能解释其中缓存占比。

**陷阱 2 — `cost` 不是每个 provider 都上报，它是下限不是实数。**
按 `provider:model` 拆（本机）：

| provider:model | 条数 | tokens | cost | cost=0 占比 |
|---|---:|---:|---:|---:|
| deepseek:deepseek-v4-pro | 4,421 | 796,088,962 | $6.34 | 1% |
| deepseek:deepseek-v4-flash | 3,815 | 629,867,289 | $2.48 | 1% |
| opencode-go:glm-5.2 | 1,018 | 88,027,897 | $30.53 | 3% |
| magpie:opencode-zen-free/… | 59 | 4,707,974 | **$0.00** | **100%** |
| anthropic / moonshotai | 12 | 6,458 | 部分 0 | 80–100% |

→ **UI 上不能无条件显示 `$x.xx`**，必须按 provider 标注「该 provider 未上报成本」，
否则会显示一个明显偏低的假数字。token 是普适指标，cost 是条件指标。

**陷阱 3 — `reasoning` 已含在 `output`、`cacheWrite1h` 是 `cacheWrite` 子集，二者都不要重复加。**

### 2.5 代价：要 usage 就必须全量读文件

usage 挂在 `message` 行里，而正文 `content` 也在同一行 → **I/O 成本躲不掉**
（magpie 实测：58 个共 3GB 的 Claude 会话全量扫要 3–7 秒，见 `RESEARCH-magpie.md`）。

这与我们「只读首行」的轻量原则冲突。折中方案：

- **不常驻扫描**。仅在打开 todo / 项目详情时按需计算；
- 结果按 `(filePath, mtime, size)` 做 key 缓存，文件变了才重算；
- 解析后**只取 `usage` / `provider` / `model` / `role` / `timestamp`，`content` 一律丢弃**——
  I/O 躲不掉，但内存与隐私风险可控；
- 默认**关闭**用量统计（设置项），开了才扫。

> 这仍不破坏「Tick 不读正文」的原则：我们读到了正文所在的字节，但不解析、不缓存、不展示、不外发。

### 2.6 结论

**不需要做网关也能拿到 token / 成本** —— 这推翻了上一轮「网关拿 token、我们拿 cwd」的分工判断。
pi 自己就把账记在会话里了。是否进首版见 §6 决策。

---

## 3. fork：不去重（D1 确认）

### 3.1 pi 的 fork 到底做了什么

`pi --help` L30：`--fork <path|id>  Fork specific session file or partial UUID into a new session`

`dist/core/session-manager.js` L1374–1414 `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, options)`：

```js
const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
const sourceHeader = sourceEntries.find((e) => e.type === "session");
if (!sourceHeader) throw new Error(`Cannot fork: source session has no header: ...`);
const newHeader = { type:"session", version:3, id:newSessionId, timestamp,
                    cwd: resolvedTargetCwd, parentSession: resolvedSourcePath };
// Copy all non-header entries from source
```

三条硬事实：

1. **必须有 `type:"session"` 首行**，否则报错 → 印证 magpie 的「跨工具接手是有向的」；
2. **`cwd` 可以换**（`targetCwd`）→ 「把这条会话 fork 到另一个项目继续干」pi 原生支持；
3. **复制源的所有非 header 条目** → 新会话文件自带一整份历史副本，**包含 usage**。

### 3.2 决策：不去重，按真实

用户拍板：**fork 出来就是两个会话，不做内容去重，按真实情况展示。** 采纳。

据此撤销 `RESEARCH-magpie.md` 里「fork 要按内容去重」的建议（见该文件修订记录）。

**但保留一条技术提醒（不是去重，是记账）**：
因为 fork 复制了源的全部条目（含 usage），对「一个 todo 下所有 session 的用量求和」时，
fork 链会把同一段历史算多次。处理：

- 会话**列表**不去重 —— 按真实；
- 用量**求和**时，`SessionInfo.parentSessionPath` 存在即标注「fork 自 …」，
  默认**只统计 fork 之后新增的条目**（源文件条目数 N → 本文件跳过前 N 条即可，无需读正文）。
- 该切分是 P1，首版若不做用量统计则不需要。

---

## 4. 跨工具接手：确认要做（D2）

### 4.1 能力是有向的，不是对称的

| 方向 | 可行 | 依据 |
|---|---|---|
| pi → pi（换目录） | ✅ | `forkFrom(sourcePath, targetCwd)`，cwd 可改 |
| omp → 读 pi 会话 | ✅（magpie 实证） | `omp --fork <pi文件>` |
| pi → 读 omp 会话 | ❌ | `forkFrom` 要求首行是 session header，omp 首行是 title |
| 任意 → 任意 | ❌ | 各工具存储格式无公共子集 |

**→ 接手不能设计成"任意互转"，必须是有向能力矩阵。**

### 4.2 Adapter 合同扩展

```ts
interface CarryCapability {
  /** 本工具能否从"源会话文件"接手；sources 为空表示只支持自家格式 */
  acceptFrom: { format: string; via: 'fork' | 'import' | 'none' }[]
  /** 本工具的会话文件能否被别的工具接手（供 UI 提示"这条可被 X 接手"） */
  exposes: { format: string }[]
}

fork?(source: { toolId: string; sessionId: CliSessionId; filePath?: string },
      targetCwd: string): Promise<LaunchResult>
```

pi 侧填：`acceptFrom: [{ format: 'pi', via: 'fork' }]`、`exposes: [{ format: 'pi' }]`。

### 4.3 降级通道（保底，一定可行）

目标工具读不了源格式时，退化为：**把源会话的摘要（不是全文）作为首条消息投递给新工具**。
摘要来源优先级：① pi 的 `compaction.summary`（官方存在，最省事）② 我们生成的前 N 条消息摘要。
这样"接手"在任何方向都至少不崩，只是保真度不同。

### 4.4 UI 表达

Todo 详情的会话列表里，已绑定 session 提供「用另一个工具接手」入口，
**只列出 4.1 矩阵中可行的方向**，不可行的灰掉并说明原因（"该工具无法读取 pi 会话"）。

---

## 5. 集成路径与面板执行层选型（**D13 已定：pi-durable**）

`docs/sdk.md` 与 `docs/cli-integration.md` 显示 pi 提供**四条集成路径**：

| 路径 | 形态 | 适合 |
|---|---|---|
| Interactive | TUI | **CLI 拉起（我们的主路径）** |
| Print | stdout 一次性 | 脚本 |
| JSON | JSONL 事件流 | 进程间结构化输出 |
| RPC | 长驻进程、双向 | 自动化 / 精细控制 |
| **SDK** | **进程内 `createAgentSession()`** | 备选 |

SDK 关键能力（`sdk.md`，留作备选与未来自动化参考）：

```ts
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
await session.prompt("...");
session.subscribe((event) => { /* message_update / message_end / agent_settled */ });
```

- `SessionManager.inMemory()` —— 不落盘也能跑；
- 官方原话：**"`cwd` selects the workspace used for project resource discovery, context files,
  session grouping, and built-in tool paths"** → 面板 Chat 也能挂项目；
- `AgentSessionRuntime` 提供 `newSession()` / `switchSession()` / **`fork()`** / **`importFromJsonl()`**；
- `resourceLoader` 可注入 extensions → **`create_todo` 一份实现，CLI 与面板共用同一加载点**；
- 事件里 `message_end` 是权威消息，`agent_settled` 表示本轮不会再自动继续。

### 5.1 D13 定案：面板 Chat 用 **pi-durable**

`@earendil-works/pi-durable@1.3.0`（`packages/durable`），定位
**"Durable conversation, task, and document runtime for Pi"**——
比原先以为的"会话存储库"重得多，它是完整的持久执行运行时。

| 能力 | 说明 | 对 Tick 的价值 |
|---|---|---|
| 内置 `pi.usage` document | 每个 conversation 自带 token/cost 账本；`harness.usage(ctx)` 汇总整 Session | 面板侧有账本，但**我们不统计面板用量**（D15），不用它 |
| 崩溃恢复 | `harness.resume()` 接着上次没跑完的 run 继续 | 解决"面板长会话生命周期自己管"的问题 |
| Durable task | 每个 task 每步存 checkpoint | 面板里跑长任务不怕中断 |
| `pi.provider` doc | 每个 conversation 一个持久 UUIDv7，转发给 pi-ai 做 prompt-cache / session 亲和 | 面板会话也有稳定 id |
| 存储后端 | `openNodeSqliteStorage(path)` / `openNodeJsonlStorage(dir)` / `MemoryStorage` | 落 `~/.ticktodo/sessions/panel-chat/` |
| requestId 幂等 | 同 `requestId` 重复提交返回既有 submission | 防重复建单，正好配合 `create_todo` |

**⚠️ 一条必须记住的风险**：README 第一行就是
**"Experimental. The API changes without notice between releases."**
→ **必须 pin 版本**（1.3.0），升级前先跑一遍我们自己的集成测试，不能跟着 latest 走。

**⚠️ 环境要求**：`engines: node >= 22.19.0`（Electron 的 Node 版本要 ≥ 这个）。

### 5.2 意外收获：durable 官方佐证了我们"fork 不继承用量"的处理

`src/harness/usage.ts` 里 `UsageDoc` 的定义：

```ts
export const UsageDoc = defineDoc<UsageState>({
  kind: "pi.usage", version: 1, scope: "conversation",
  history: "latest",
  fork: "initial",        // ← fork 出来的会话，用量账本从空开始，不继承
  initial: () => ({ models: {}, tools: {} }),
  checkpointWhen: () => true,
});
```

**`fork: "initial"`** 正是我们 §3.2 的做法（跳过 fork 继承段）——官方独立得出了同一结论。

### 5.3 官方的用量聚合实现（可直接翻译）

`src/harness/usage.ts` 的 `addUsage()`：

```ts
total.input += usage.input;
total.output += usage.output;
total.cacheRead += usage.cacheRead;
total.cacheWrite += usage.cacheWrite;
total.totalTokens += usage.totalTokens;
if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
total.cost.{input,output,cacheRead,cacheWrite,total} += ...;
```

确认三件事：`cacheWrite1h` / `reasoning` **单独累加、不进 `totalTokens`**；
`models` 按 `provider/modelId` 分桶、`tools` 按工具名分桶（tool result usage 无 model identity）；
README 另有一句关键口径——**"Failed and aborted attempts count too"**（失败的尝试也计入）。

我们扫描 **pi CLI 会话**时用的是同一套口径（见 §8 脚本）。

---

## 6. 用量计算：实现与验证（"先拿到正确的每个会话的用量"）

### 6.0 范围：只算 AI 工具自己的会话，**面板 Chat 不统计**

用户明确口径：*统计的是 AI 工具每个对话自己的用量，所以与 CLI 不一样*（面板不是统计对象）。

- 唯一来源 = **工具侧的会话文件**（pi 的 jsonl），由 `ai/<tool>` adapter 的 `computeUsage()` 计算；
- **面板 Chat 不出现用量**：它是"快速捕获 + 建 todo"的入口，不是干活的会话。
  混进来会让同一 todo 下的数字含义不一致（面板一轮 vs 工具一段对话）；
- 因此 durable 的 `pi.usage` document **我们不用**（有但不读），
  也不需要 `source: 'cli' | 'panel'` 的统一层；
- **不做跨工具总账**：各工具 token 口径与 provider 单价不同，加在一起没有意义。
  汇总只在同一工具内做：单会话 → 同 todo 下该工具的会话 → 同项目下该工具的会话。

脚本：`scripts/session-usage.mjs`（Node，无依赖，`node scripts/session-usage.mjs --top 20 --json out.json`）

它做四件事：
1. 解析会话目录（`$PI_CODING_AGENT_SESSION_DIR` > settings.json `sessionDir` > `~/.pi/agent/sessions`），
   settings 按 **jsonc** 解析；
2. 逐文件全量扫描，按 §5.3 的官方 `addUsage` 聚合五个来源；
3. **fork 继承段跳过**（`parentSession` 指向源文件时，跳过源文件条目数 N 条）；
4. 自洽校验 `totalTokens === input + output + cacheRead + cacheWrite`。

### 本机实测结果（2026-10-17）

```
有效会话: 103    扫描耗时: 1034ms
跳过: 空文件 31（0 字节 = 僵尸会话）、首行无 header 0

tokens   1,525,136,195
  input       11,998,903
  output       3,707,237
  cacheRead 1,509,430,055  (99.0%)
  cacheWrite            0
cost     $39.4934

⚠️ 1 个会话有 provider 未上报成本 → cost 是下限
   涉及: magpie/opencode-zen-free/...

自洽校验: 103/103 通过
```

**正确性交叉验证**：另写了一份独立的 Python 统计（不同实现、只算 assistant），
总量 **1,525,136,195 tokens / $39.4934 与脚本完全一致** → 口径可信。

### 顺带挖出一个物证：31 个 0 字节空会话

`~/.pi/agent/sessions/` 顶层有 31 个 `.jsonl`，文件名是**纯 UUID**（没有 `timestamp_` 前缀），
大小 **0 字节**——spawn 出来了但一条都没写进去。

这正是我们此前担心却没有实据的**僵尸绑定**的物证。直接推论：

- `verify()` 除了"绕过缓存直读"，**还要判 `size === 0`**：文件存在但为空 = 没真正产生；
- 项目索引 / 会话列表应过滤掉它们，否则用户会看到一串空会话；
- 也说明 `launch` 预生成 `--session-id` 的做法确实会留下垃圾，兜底清理要有。

---

## 7. 决策落地

| # | 决策 | 状态 |
|---|---|---|
| D10 | fork 会话**不去重**，按真实展示 | ✅ 已定（§3） |
| D11 | 跨工具接手**要做**，按有向能力矩阵 | ✅ 已定（§4），排 P1（需第二个 adapter 才有意义） |
| D12 | usage **pi 自带且完整**，可不做网关就拿到 | ✅ 已定（§2）；是否进首版待定 |
| D13 | 面板 Chat 用 **pi-durable**（非 pi SDK） | ✅ **已定**（§5.1）。须 **pin 1.3.0**（Experimental，API 会变）、Node ≥ 22.19 |
| D14 | 开发前升级 pi 到 **1.3.0**，adapter 校验版本 | ⏳ 建议（§0） |
| D15 | 用量计算照抄官方 `addUsage`；**只有一套来源**（工具侧会话文件），**面板 Chat 不统计** | ✅ 已定（§6） |
| D17 | 用量是 **adapter 能力**（`computeUsage()`），不是统一服务；不合并跨工具总账 | ✅ 已定（§6） |
| D16 | `verify()` 增加 `size === 0` 判定；会话列表过滤空会话 | ✅ 已定（§6 末，31 个空文件物证） |

### 待定：用量统计进不进首版

| 方案 | 收益 | 代价 |
|---|---|---|
| 首版不做 | 保持"只读首行"的轻量，零风险 | 放弃一个真实的差异化（见 §2.6） |
| 首版做（默认关 + 按需 + 缓存） | Todo 详情能显示"这个任务花了多少/用了哪个模型" | 全量扫的 I/O、缓存失效逻辑、provider cost 标注 |
| 首版只做**单会话**统计（打开详情时算这一个） | 成本最小，量级可控 | 无跨 todo / 跨项目汇总 |

建议 **M3 做单会话维度**，M4+ 再做汇总。

---

## 8. 引用

- 会话格式：https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md
- 消息类型（Usage 定义）：…/docs/message-types.md
- SDK：…/docs/sdk.md ；CLI 集成：…/docs/cli-integration.md
- fork 实现：`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` L1374–1414
- Usage 类型：`dist/core/usage-totals.d.ts`（`UsageTotals { input, output, cacheRead, cacheWrite, cost }`）
- 统计脚本口径：本文数字由本机 `~/.pi/agent/sessions` 全量扫描得出（134 文件）
