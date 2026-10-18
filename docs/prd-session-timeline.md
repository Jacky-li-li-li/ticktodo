# PRD · 会话最后一条用户消息 + 一件事的进展时间线

| 字段 | 内容 |
| --- | --- |
| 状态 | 草案，待 Jacky 审阅 |
| 日期 | 2026-10-18 |
| 关联 | `docs/已对齐/PRD-tick.md`（v0.3）、`TECH-ARCH-tick.md` §6、`RESEARCH-magpie.md` |
| 一句话 | 在 todo 的绑定会话页面，每个会话直接显示该会话**最后一条 user 消息原文**，并把这件事在各 AI 工具里的会话按最后事件时间串成时间线，让人一眼看到「每段停在你说的哪一句」，并能点回任意会话继续。 |

**决定（Jacky）**：不做 AI 摘要。这里的「摘要」＝该会话最后一条 user 发的消息原文，不改写、不生成。

## 1. 背景与痛点

产品定位：Ticktodo 以 todo（事情）为中心，把同一件事在不同工具（Claude Code、pi、Cursor 等）里的多个 AI 会话聚到一起。

**痛点**：一件事的工作历史散落在多个工具的多个会话里，只能靠回忆再逐个工具翻找。

**现状（代码核实）**

- 数据模型：`Todo.bindings: SessionBinding[]`（`toolId / sessionId / boundAt / state / filePath`）+ `primarySessionId`（`packages/shared`）。Tick 只存绑定关系，会话元数据权威源在工具侧 adapter。
- 合同：`AiToolAdapter`（`packages/ai/core`）已有 `listSessionInfos / describeSession`，`SessionInfo` 含 `name / firstMessage / lastMessage / createdAt / lastUsedAt / filePath / parentSessionPath`；`SessionService`（`apps/desktop/src/main/services/sessions.ts`）负责拼视图，5s 内存缓存，不落镜像。
- UI：`TodoDetail` 以列表展示绑定会话，「停在哪」仅用 `lastMessage ?? name ?? firstMessage` 的一行文本；可选单会话用量。
- 只有 `PiAdapter` 一个实装；Claude Code / Cursor 尚未接入（`SessionService.fallbackSummaries` 已为第二工具预留）。
- 缺口：① 现有 `lastMessage` 不保证是 user 消息，也无时间、无折叠；② 没有跨会话的时间线视图；③ 会话状态只有 pending/verified，缺「进行中/已停下」等语义；④ 跨工具的字段尚未归一（时间、状态、角色）。

## 2. 目标用户与场景

**用户**：同时用多个 AI 编码工具、一件事会开多个会话的个人开发者（Jacky 本人即典型）。

**场景**

1. 隔了几天回到一件事：看每个会话里我最后说的那句话，就能想起上次做到哪。
2. 一件事先后在 pi、Claude Code、Cursor 里各做了一段：想按时间看完整脉络。
3. 想从某一段接着做：直接回到那个会话（resume）。

**非目标**：不替代各工具的会话查看器；不做团队协作/云同步；不解析代码 diff 级别的细节；不做任何形式的 AI 总结。

## 3. 范围

### P0（本期）

- P0-1 **最后一条 user 消息原文**：todo 的绑定会话页面中，每个会话显示其最后一条 user 消息原文，并带该消息时间。过长默认折叠（如前 N 行/字），点开看全文。
- P0-2 **进展时间线**：todo 详情按会话最后事件时间倒序，跨工具混排，每项显示：工具图标、最后事件时间、状态、最后一条 user 消息（折叠）、操作（回到会话）。
- P0-3 **会话状态归一**：`active / idle / done / missing`（定义见 §4）。
- P0-4 **一键回到会话**：沿用现有 resume；`missing`（文件不在）时置灰并显示原路径。
- P0-5 **缓存与增量**：按 `(filePath, mtime, size)` 缓存，仅变化时重新读取，不阻塞详情打开。
- P0-6 **todo 列表行**：显示最近一个会话的最后一条 user 消息（单行截断，替代当前纯 `lastMessage`）。
- 约束：**纯本地、零外发**。

### P1（后续）

- P1-1 接入第二个工具（Claude Code 优先，其会话为本地 JSONL）以验证跨工具归一。
- P1-2 时间线里标注 fork 血缘（`parentSessionPath`）与会话间「接手」关系。
- P1-3 导出（接入现有 F8 导出，加入时间线与最后 user 消息）。
- P1-4 全部会话视图里按最后 user 消息搜索。

### 后续考虑（不在本期，仅占位，不承诺）

- **树状展示该会话的全部 user 消息**：在会话条目下以树状（可含 fork 分支）展开该会话所有 user 消息。目前只是方向占位，不承诺排期、形态与是否实现；本期数据模型与 UI 不为其做额外设计，仅避免堵死。

## 4. 用户故事与数据模型

### 用户故事

- 作为开发者，我打开一件事，**不点进任何会话**就能看到每个会话里我最后说的那句话和时间。（P0）
- 作为开发者，我想看这件事在 pi 和 Claude Code 里的会话**按时间排在同一条线上**。（P0）
- 作为开发者，我想**一键回到**最近或任意一个会话继续。（P0）
- 作为注重隐私的开发者，我希望**会话内容不离开本机**。（P0）

### 数据模型建议

原则沿用 TECH-ARCH §6：会话事实的权威源在工具侧；Tick 只存**派生数据**，且可丢可重建。

在 `packages/ai/core` 新增（工具无关，adapter 只吐证据，归一在 core）：

```ts
/** adapter 输出的原始证据（只读会话文件即可得） */
export interface SessionLastUserEvidence {
  toolId: string
  sessionId: CliSessionId
  lastUserMessage?: string        // 原文（已跳过系统/工具注入消息，见 §8）
  lastUserMessageAt?: number      // 该消息时间（ms）
  lastEventAt?: number            // 会话内最后事件时间（ms）
  endedCleanly?: boolean          // 末条是 assistant 终态而非中断/等待用户
}

/** core 归一后的唯一形态，缓存于 ~/.ticktodo/data/session-digests.json */
export interface SessionDigest {
  toolId: string
  sessionId: CliSessionId
  lastUserMessage?: string        // 原文；缓存是否截断见 §8
  lastUserMessageAt?: number      // ms
  state: 'active' | 'idle' | 'done' | 'missing'
  lastActiveAt: number            // ms，来自会话内事件时间，非文件 mtime
  fingerprint: { mtimeMs: number; size: number }   // 缓存键，变化即失效
}

/** 视图：Todo 下的时间线条目 = TodoSessionView + SessionDigest */
export type TimelineItem = TodoSessionView & { digest?: SessionDigest }
```

`AiToolAdapter` 增加可选方法 `extractLastUserMessage?(sessionId): Promise<SessionLastUserEvidence | undefined>`，由 `SessionService.timelineForTodo(todoId)` 调用并合并。`capabilities.describeSessions` 旁加对应能力位。

**跨工具归一规则**

| 维度 | 规则 |
| --- | --- |
| 时间 | 一律取会话**内部事件时间**（缺失才回退文件 mtime）；Tick 侧 `lastLaunch.launchedAt` 作为跨工具对齐的辅助时钟 |
| 角色 | 各工具消息统一映射为 user / assistant / tool；system、思考内容、工具注入内容不算 user 消息 |
| 状态 | `missing`＝文件不在；`active`＝最近 `T_active`（默认 10 分钟）内有事件；`done`＝`endedCleanly` 且超过 `T_active`；其余 `idle`（用户中途停下） |
| 保底 | 没有可识别的 user 消息时回退 `name ?? firstMessage ?? '会话 xxxxxxxx'`，永不空白 |
| 主键 | `(toolId, sessionId)`；一个 sessionId 只属于一个 todo（现有规则不变） |
| 排序 | 时间线按 `lastActiveAt` 倒序；`primary` 仅加徽标，不改排序 |

## 5. 数据来源

仅本地：adapter 流式读取会话文件（从尾部向前找最后一条合格 user 消息），在本机主进程完成，缓存仅存本机 `~/.ticktodo`。不调用任何模型、不联网、不新增 provider/密钥配置。

## 6. 交互草图（文字描述）

**列表行（todo）**：标题下一行小字 = 最近会话的最后一条 user 消息（单行截断），右侧显示相对时间与工具图标堆叠（pi · Claude Code）。

**todo 详情 → 绑定会话页面 / 「进展」**（位于现有会话列表位置，替换之）：

```
 ─ 进展 · 3 个会话 · 2 个工具 ─────────────
 ● 今天 14:20   [pi]           进行中
   我：先把 resume 的 cwd 推导改掉，再补单测，verify 逻辑
   先别动……                      [展开]    [回到会话]
 │
 ○ 昨天 21:05   [Claude Code]  已结束
   我：好，按这个方案应用吧                 [回到会话]
 │
 ○ 10-16 10:30  [pi]           已结束
   我：梳理一下项目索引和会话目录结构       [回到会话]
```

- 最后一条 user 消息过长时折叠，点「展开」看全文；消息旁带该消息时间。
- 点击条目的其他操作：回到会话、设为默认（primary）、解绑。
- 读取中显示骨架占位，不阻塞；失败回退到 `firstMessage`。
- `missing` 条目置灰，显示「会话文件不在本机」和原路径，只可解绑。
- 空态：没有会话时保留现有「开始/绑定会话」入口。

## 7. 验收标准

1. 一条绑定了 ≥ 2 个会话的 todo，打开详情 **≤ 300ms 内渲染出时间线骨架**；缓存命中时最后 user 消息 ≤ 100ms 就位；冷读单会话（50MB 以内）≤ 2s 且不卡 UI。
2. 每个会话条目都显示最后一条 user 消息原文（含时间）与状态；无可识别 user 消息时走保底，不出现空白。
3. 长消息默认折叠，点开可看全文；展示内容与会话原文一致（不改写）。
4. 时间线按 `lastActiveAt` 倒序，跨工具混排正确（用 pi + 一个 mock 第二工具 adapter 的单测覆盖）。
5. 缓存命中：会话文件变化（mtime/size）后重新打开则刷新；未变化不重读（命中率可在日志中验证）。
6. 抓包/日志验证**无任何外发请求**。
7. 会话文件被删：条目显示 `missing` 并置灰，不报错，不影响其他条目。
8. 「回到会话」对 `done/idle` 的会话可 resume，行为与现有一致；`primary` 逻辑不回归。
9. todo 列表行显示最近一个会话的最后一条 user 消息。
10. 单测覆盖 core 层归一逻辑（最后 user 消息识别、状态判定、保底、排序）；`pnpm typecheck` 通过。

## 8. 开放问题

1. **最后一条 user 消息如何识别**：如何跳过系统/工具注入消息（如 system reminder、tool result、slash command 展开、IDE 自动附加上下文、compaction 摘要等）？各工具是否有可靠的角色/来源标记，还是需要启发式规则？
2. **`done` 的判定**：「末条是 assistant 终态」在不同工具里如何识别？是否需要用户手动标「做完了」？
3. **todo 状态联动**：时间线是否影响 todo 的完成状态（如全部会话 done 时提示勾选）？还是严格只读？
4. **第二工具顺序**：Claude Code 与 Cursor 谁先？Cursor 的会话存储（SQLite/私有格式）是否可稳定读取？
5. **派生缓存放哪里**：单 JSON 文件（简单）vs 按会话分文件（并发写友好）？是否需要和现有文件锁方案对齐？缓存里是否存全文（含折叠阈值）？
6. **子会话/fork**：`parentSessionPath` 继承段的 user 消息是否算「最后一条」候选（避免 fork 会话显示父会话的消息）？
7. **多 todo 归属**：一个会话是否允许出现在多个 todo 的时间线里（现为唯一归属）？
