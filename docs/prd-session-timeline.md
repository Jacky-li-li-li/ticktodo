# PRD · 会话摘要 + 一件事的进展时间线

| 字段 | 内容 |
| --- | --- |
| 状态 | 草案，待 Jacky 审阅 |
| 日期 | 2026-10-18 |
| 关联 | `docs/已对齐/PRD-tick.md`（v0.3）、`TECH-ARCH-tick.md` §6、`RESEARCH-magpie.md` |
| 一句话 | 在 todo 详情里，把这件事在各 AI 工具里的所有会话按时间串起来，每个会话有一句话摘要和状态，让人一眼看到「做过什么、做到哪」，并能点回任意会话继续。 |

## 1. 背景与痛点

产品定位：Ticktodo 以 todo（事情）为中心，把同一件事在不同工具（Claude Code、pi、Cursor 等）里的多个 AI 会话聚到一起。

**痛点**：一件事的工作历史散落在多个工具的多个会话里，只能靠回忆再逐个工具翻找。

**现状（代码核实）**

- 数据模型：`Todo.bindings: SessionBinding[]`（`toolId / sessionId / boundAt / state / filePath`）+ `primarySessionId`（`packages/shared`）。Tick 只存绑定关系，会话元数据权威源在工具侧 adapter。
- 合同：`AiToolAdapter`（`packages/ai/core`）已有 `listSessionInfos / describeSession`，`SessionInfo` 含 `name / firstMessage / lastMessage / createdAt / lastUsedAt / filePath / parentSessionPath`；`SessionService`（`apps/desktop/src/main/services/sessions.ts`）负责拼视图，5s 内存缓存，不落镜像。
- UI：`TodoDetail` 以列表展示绑定会话，「停在哪」仅用 `lastMessage ?? name ?? firstMessage` 的一行文本；可选单会话用量。
- 只有 `PiAdapter` 一个实装；Claude Code / Cursor 尚未接入（`SessionService.fallbackSummaries` 已为第二工具预留）。
- 缺口：① 没有「摘要」，只有首/末条用户消息，无法回答「做过什么」；② 没有跨会话的时间线视图；③ 会话状态只有 pending/verified，缺「进行中/已停下」等语义；④ 跨工具的字段尚未归一（时间、状态、角色）。

## 2. 目标用户与场景

**用户**：同时用多个 AI 编码工具、一件事会开多个会话的个人开发者（Jacky 本人即典型）。

**场景**

1. 隔了几天回到一件事：想知道上次做到哪，而不是重读会话。
2. 一件事先后在 pi、Claude Code、Cursor 里各做了一段：想按时间看完整脉络。
3. 想从某一段接着做：直接回到那个会话（resume），或带摘要开新会话。
4. 汇报/复盘：导出这件事的进展。

**非目标**：不替代各工具的会话查看器；不做团队协作/云同步；不解析代码 diff 级别的细节。

## 3. 范围

### P0（本期）

- P0-1 **会话摘要**：每个绑定会话有 `summary`（≤ 80 字一句话：做了什么/结论）和 `lastState`（停在哪，1 行）。默认走**本地抽取**（见 §5），无需联网。
- P0-2 **进展时间线**：todo 详情新增「进展」视图，按时间倒序列出该 todo 下所有会话（跨工具混排），每项显示：工具图标、起止时间、摘要、状态、操作（回到会话）。
- P0-3 **会话状态归一**：`active / idle / done / missing`（定义见 §4）。
- P0-4 **一键回到会话**：沿用现有 resume；`missing`（文件不在）时置灰并显示原路径。
- P0-5 **缓存与增量**：摘要按 `(filePath, mtime, size)` 缓存，仅变化时重算，不阻塞详情打开。
- P0-6 **todo 级「做到哪」一句话**：汇总最近一个会话的 `lastState`，显示在列表行（替代当前纯 `lastMessage`）。

### P1（后续）

- P1-1 **AI 生成摘要**（opt-in）：对本地抽取不理想的会话，用户点击「用 AI 总结」或开启自动。
- P1-2 接入第二个工具（Claude Code 优先，其会话为本地 JSONL）以验证跨工具归一。
- P1-3 摘要可手动编辑/固定（用户编辑优先，不被覆盖）。
- P1-4 时间线里标注 fork 血缘（`parentSessionPath`）与会话间「接手」关系。
- P1-5 导出（接入现有 F8 导出，加入 summary/timeline）。
- P1-6 全部会话视图里按摘要搜索。

## 4. 用户故事与数据模型

### 用户故事

- 作为开发者，我打开一件事，**不点进任何会话**就能看到每段工作做了什么、最后停在哪。（P0）
- 作为开发者，我想看这件事在 pi 和 Claude Code 里的会话**按时间排在同一条线上**。（P0）
- 作为开发者，我想**一键回到**最近或任意一个会话继续。（P0）
- 作为注重隐私的开发者，我希望**默认不把会话内容发给任何云端**。（P0）
- 作为开发者，我想在摘要不准时**手动改写**并保持不被覆盖。（P1）
- 作为开发者，我想对重要会话**用 AI 生成更好的摘要**。（P1）

### 数据模型建议

原则沿用 TECH-ARCH §6：会话事实的权威源在工具侧；Tick 只存**派生数据**，且可丢可重建。

在 `packages/ai/core` 新增（工具无关，adapter 只吐证据，归一在 core）：

```ts
/** adapter 输出的原始证据（只读会话文件即可得） */
export interface SessionDigestEvidence {
  toolId: string
  sessionId: CliSessionId
  firstUserMessage?: string
  lastUserMessage?: string
  lastAssistantMessage?: string   // 取末尾一段，截断
  messageCount: number
  toolCallCount?: number
  touchedFiles?: string[]         // 由 tool call 参数中抽取，去重，最多 N 个
  lastEventAt?: number            // 会话内最后事件时间（ms）
  endedCleanly?: boolean          // 末条是 assistant 终态而非中断/等待用户
}

/** core 归一后的唯一形态，缓存于 ~/.ticktodo/data/session-digests.json */
export interface SessionDigest {
  toolId: string
  sessionId: CliSessionId
  summary: string                 // ≤ 80 字
  lastState: string               // 「停在哪」，≤ 60 字
  state: 'active' | 'idle' | 'done' | 'missing'
  startedAt: string               // ISO，来自会话
  lastActiveAt: number            // ms，来自会话内事件时间，非文件 mtime
  source: 'extract' | 'ai' | 'user'   // 优先级 user > ai > extract
  generatedAt: number
  fingerprint: { mtimeMs: number; size: number }   // 缓存键，变化即失效
  stats?: { messageCount: number; toolCallCount?: number; touchedFiles?: string[] }
}

/** 视图：Todo 下的时间线条目 = TodoSessionView + SessionDigest */
export type TimelineItem = TodoSessionView & { digest?: SessionDigest }
```

`AiToolAdapter` 增加可选方法 `extractDigest?(sessionId): Promise<SessionDigestEvidence | undefined>`，由 `SessionService.timelineForTodo(todoId)` 调用并合并。`capabilities.describeSessions` 旁加 `digest: boolean`。

**跨工具归一规则**

| 维度 | 规则 |
| --- | --- |
| 时间 | 一律取会话**内部事件时间**（缺失才回退文件 mtime）；Tick 侧 `lastLaunch.launchedAt` 作为跨工具对齐的辅助时钟 |
| 角色 | 各工具消息统一映射为 user / assistant / tool；system 与思考内容不入摘要 |
| 状态 | `missing`＝文件不在；`active`＝最近 `T_active`（默认 10 分钟）内有事件；`done`＝`endedCleanly` 且超过 `T_active`；其余 `idle`（用户中途停下） |
| 摘要保底 | 无可用文本时回退 `name ?? firstMessage ?? '会话 xxxxxxxx'`，永不空白 |
| 主键 | `(toolId, sessionId)`；一个 sessionId 只属于一个 todo（现有规则不变） |
| 排序 | 时间线按 `lastActiveAt` 倒序；`primary` 仅加徽标，不改排序 |

用户手改的 summary 存 `source:'user'`，重算时跳过。

## 5. 摘要来源方案

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A 本地抽取 | 流式读会话文件，取首/末 user 消息、末 assistant 段、tool call 统计、touched files，按模板拼句 | 零成本、离线、隐私最好、快、可复现 | 质量一般，「做了什么」偏机械 |
| B 调 AI 生成 | 把会话压缩后发给模型总结 | 质量最好 | 会话含代码/密钥/内部信息，外发有隐私风险；有费用与延迟；需要 provider 配置 |
| C 混合（推荐） | 默认 A；用户对单个会话或全局显式开启后用 B；B 的结果缓存，`source` 标注 | 兼顾本地优先与质量 | 实现两条路径 |

**推荐：C，P0 只做 A，P1 加 B（opt-in）。**

隐私与本地优先的约束：

1. 默认零外发。摘要在本机主进程算，缓存仅存本机 `~/.ticktodo`。
2. B 必须**显式开启**，首次开启弹说明（发送哪些内容、发往哪个 provider）；默认**逐会话手动触发**，不做后台批量自动发送。
3. B 只发送压缩后的片段（首尾若干条消息 + touched files 名），不发整份会话；在发送前过滤明显的密钥特征（`sk-`、`Bearer`、`.env` 内容等）。
4. 复用现有 `CredentialSource`/provider 配置（Key 只进系统钥匙串）；面板 Chat 的会话本身不参与统计的规则保持不变。
5. 摘要缓存中不得保存原文长段，仅保存 ≤ 80/60 字的结果与统计。

## 6. 交互草图（文字描述）

**列表行（todo）**：标题下一行小字 = 最近会话的 `lastState`（如「卡在 pi adapter 的 resume cwd 校验」），右侧显示相对时间与工具图标堆叠（pi · Claude Code）。

**todo 详情 → 「进展」**（位于现有会话列表位置，替换之）：

```
 ─ 进展 · 3 个会话 · 2 个工具 ─────────────
 ● 今天 14:20   [pi]           进行中
   重写 resume 的 cwd 推导，加了单测
   停在：等你确认是否改 verify 逻辑          [回到会话]
 │
 ○ 昨天 21:05   [Claude Code]  已结束
   定位 stale cwd 导致 resume 失败的原因
   停在：已给出修复方案并应用                [回到会话]
 │
 ○ 10-16 10:30  [pi]           已结束
   梳理项目索引与会话目录结构                [回到会话]
```

- 点击条目展开：显示摘要、首条 / 末条用户消息、touched files、消息数；操作：回到会话、设为默认（primary）、解绑、（P1）编辑摘要 / 用 AI 总结。
- 摘要计算中显示骨架占位，不阻塞；失败回退到 `firstMessage`。
- `missing` 条目置灰，显示「会话文件不在本机」和原路径，只可解绑。
- 空态：没有会话时保留现有「开始/绑定会话」入口。

## 7. 验收标准

1. 一条绑定了 ≥ 2 个会话的 todo，打开详情 **≤ 300ms 内渲染出时间线骨架**；缓存命中时摘要 ≤ 100ms 就位；冷算单会话（50MB 以内）≤ 2s 且不卡 UI。
2. 每个会话条目都有非空 `summary` 与 `state`；无文本可用时走保底，不出现空白。
3. 时间线按 `lastActiveAt` 倒序，跨工具混排正确（用 pi + 一个 mock 第二工具 adapter 的单测覆盖）。
4. 会话文件变化（mtime/size）后重新打开，摘要刷新；未变化不重算（命中率可在日志中验证）。
5. 会话文件被删：条目显示 `missing`，不报错，不影响其他条目。
6. 默认配置下抓包/日志验证**无任何外发请求**；P1 的 AI 摘要未开启时同样无外发。
7. `source:'user'` 的摘要不被自动重算覆盖。
8. 「回到会话」对 `done/idle` 的会话可 resume，行为与现有一致；`primary` 逻辑不回归。
9. `pnpm typecheck` 通过；core 层归一逻辑（状态判定、摘要保底、排序）有单测。

## 8. 开放问题

1. **摘要质量门槛**：本地模板抽取是否够用？需要拿 Jacky 本机 134 个 pi 会话抽样看一遍再定是否把 AI 摘要提前到 P0。
2. **`done` 的判定**：「末条是 assistant 终态」在不同工具里如何识别？是否需要用户手动标「做完了」？
3. **todo 状态联动**：时间线是否影响 todo 的完成状态（如全部会话 done 时提示勾选）？还是严格只读？
4. **第二工具顺序**：Claude Code 与 Cursor 谁先？Cursor 的会话存储（SQLite/私有格式）是否可稳定读取？
5. **AI 摘要用哪个模型**：复用面板自配 provider，还是用工具自身的会话（如让 pi 总结）？费用由谁承担？
6. **派生缓存放哪里**：单 JSON 文件（简单）vs 按会话分文件（并发写友好）？是否需要和现有文件锁方案对齐？
7. **子会话/fork**：`parentSessionPath` 继承段是否要在摘要里去重（避免两个 fork 摘要内容雷同）？
8. **隐私脱敏的范围**：密钥过滤规则做到什么程度才算够？是否允许用户配置排除目录？
9. **多 todo 归属**：一个会话是否允许出现在多个 todo 的时间线里（现为唯一归属）？
