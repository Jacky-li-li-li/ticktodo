# PRD · 会话最后一条用户消息 + 一件事的进展时间线

| 字段 | 内容 |
| --- | --- |
| 状态 | 草案（v2，已同步 Jacky 的决定），待 Jacky 审阅 |
| 实现状态 | P0-7 / P0-8 的 `workbuddy` / `workbuddy-ai` 适配器**已落地**（2026-10-19，as-built 见 §9B.9 与 `docs/workbuddy-adapter-notes.md` §11）；P0-1..P0-6 的「最后一条 user 消息 + 跨工具时间线」**尚未实现**，`SessionDigest` / `state` 归一也尚未进 `ai/core` |
| 日期 | 2026-10-18 |
| 关联 | `docs/已对齐/PRD-tick.md`（v0.3）、`TECH-ARCH-tick.md` §6、`RESEARCH-magpie.md` |
| 一句话 | 在 todo 的绑定会话页面，每个会话直接显示该会话**最后一条 user 消息原文**，并把这件事在各 AI 工具里的会话按最后事件时间串成时间线，让人一眼看到「每段停在你说的哪一句」，并能点回任意会话继续。 |

**已决定（Jacky，2026-10-18）**

1. 不做 AI 摘要：「摘要」＝该会话最后一条 user 发的消息原文，不改写、不生成。
2. 第二个接入工具是**桌面形态的国内版 WorkBuddy（workbuddy.cn）**（不再是 Claude Code），列入 P0 范围；Claude Code / Cursor 降为后续。**国际版 WorkBuddy AI（workbuddy.ai）是与国内版并列的独立工具，本期同样列入 P0，作为第三个适配器**（独立适配器 `workbuddy-ai`，与国内版 `workbuddy` 不共用适配器、配置、依据表；见 §9B、§10 表 B）。
3. 时间线**只读**，不影响 todo 完成状态。
4. 用户消息：用各工具会话记录自带的角色字段（`role: user`）识别，并在**各 adapter 内**过滤合成 user 消息。
5. 完成状态：读各工具会话记录自带字段，不由 Ticktodo 另行推断。
6. 回到会话：用**深链接**拉起 desktop 应用并定位到会话。

> ⚠️ 诚实说明：国内版 WorkBuddy 的存储格式与深链接**大部分不是公开契约**，见 §10「官方规范依据」。

## 1. 背景与痛点

产品定位：Ticktodo 以 todo（事情）为中心，把同一件事在不同工具（pi、WorkBuddy 等；Claude Code、Cursor 为后续）里的多个 AI 会话聚到一起。

**痛点**：一件事的工作历史散落在多个工具的多个会话里，只能靠回忆再逐个工具翻找。

**现状（代码核实）**

- 数据模型：`Todo.bindings: SessionBinding[]`（`toolId / sessionId / boundAt / state / filePath`）+ `primarySessionId`（`packages/shared`）。Tick 只存绑定关系，会话元数据权威源在工具侧 adapter。
- 合同：`AiToolAdapter`（`packages/ai/core`）已有 `listSessionInfos / describeSession`，`SessionInfo` 含 `name / firstMessage / lastMessage / createdAt / lastUsedAt / filePath / parentSessionPath`，列表用的 `SessionSummary` 另带 `resumable?`（缺省=可回到）与 `size?`；`SessionService`（`apps/desktop/src/main/services/sessions.ts`）负责拼视图，5s 内存缓存，不落镜像。
- UI：`TodoDetail` 以列表展示绑定会话，「停在哪」仅用 `lastMessage ?? name ?? firstMessage` 的一行文本；可选单会话用量。
- 已有三个适配器实装：`pi`（CLI）、`workbuddy`（WorkBuddy 国内版，桌面形态）、`workbuddy-ai`（WorkBuddy AI 国际版，桌面形态）；Claude Code / Cursor 仍未接入。桌面适配器只读本地 DB/会话文件、只能经深链接回到会话；新建会话语义由 `capabilities.newSessionMode` 表达（`launch` / `prefill` / `none`），两个 WorkBuddy 均为 `prefill`（可打开 GUI 新建页并预填，但不自动发送/不绑定），`SessionService` 已按 `binding.toolId` 路由到对应 adapter。
- 缺口：① 现有 `lastMessage` 不保证是 user 消息，也无时间、无折叠；② 没有跨会话的时间线视图；③ 会话状态只有 pending/verified，缺「进行中/已停下」等语义；④ 跨工具的字段尚未归一（时间、状态、角色）。

## 2. 目标用户与场景

**用户**：同时用多个 AI 编码工具、一件事会开多个会话的个人开发者（Jacky 本人即典型）。

**场景**

1. 隔了几天回到一件事：看每个会话里我最后说的那句话，就能想起上次做到哪。
2. 一件事先后在 pi、WorkBuddy 里各做了一段：想按时间看完整脉络。
3. 想从某一段接着做：直接回到那个会话（resume）。

**非目标**：不替代各工具的会话查看器；不做团队协作/云同步；不解析代码 diff 级别的细节；不做任何形式的 AI 总结。

## 3. 范围

### P0（本期）

- P0-1 **最后一条 user 消息原文**：todo 的绑定会话页面中，每个会话显示其最后一条 user 消息原文，并带该消息时间。过长默认折叠（如前 N 行/字），点开看全文。
- P0-2 **进展时间线**：todo 详情按会话最后事件时间倒序，跨工具混排，每项显示：工具图标、最后事件时间、状态、最后一条 user 消息（折叠）、操作（回到会话）。
- P0-3 **会话状态归一**：`active / idle / done / missing`（定义见 §4；完成状态读各工具会话记录自带字段）。
- P0-7 **第二个接入工具：WorkBuddy 适配器**（桌面形态，需求见 §9；依据与风险见 §10）。**实现状态（2026-10-19）：适配器已落地**（`@tick/ai-workbuddy`：只读 `workbuddy.db` + jsonl、深链接回到会话；task 深链接未复测，当前 `newSessionMode='none'`（仍可倒入/继续）；as-built 见 notes §11）；本节需求中依赖完成状态归一 / `SessionDigest` 的部分仍未做。
- P0-8 **第三个接入工具：WorkBuddy AI（国际版）适配器**（独立于国内版，需求见 §9B；依据见 §10 表 B）。**实现状态（2026-10-19）：适配器已落地**（`@tick/ai-workbuddy-ai`，复用同一套只读读取内核、独立身份；playground 会话 `resumable=false`；`newSessionMode='prefill'` 仅 5.8.4 实测启用）。已在有真实会话的机器上补测（2026-10-18，5.8.4）：数据格式与国内版同内核、包装细节有差异；第二轮（notes §10.8，唯一会话为 playground）深链冷启动 0/2、回首页（归因未证伪）；第三轮对**单普通会话**冷/热/最小化全成功；第四轮（19:33–19:42 UTC+8）在 **2 个**普通会话间冷启动互跳 4/4、热启动 3/3，与单会话结论一致，故“回到会话”**保持默认开启**（§9B.6、notes §10.9/§10.10）。
- P0-4 **一键回到会话**：pi 沿用现有 resume；desktop 工具（WorkBuddy：`workbuddy://`；WorkBuddy AI：`workbuddy-ai://`，两者独立）用**深链接**拉起应用并定位到会话（§9.6）；`missing`（文件不在）时置灰并显示原路径。
- P0-5 **缓存与增量**：按 `(filePath, size, mtime)` 作快路径判断（as-built）；内容前缀哈希确认「只在尾部追加」仍为后续项，未实现。DB 侧元数据（`status` / `title`）另按 DB 指纹或短 TTL 失效。仅变化时重读，不阻塞详情打开。
- P0-6 **todo 列表行**：显示最近一个会话的最后一条 user 消息（单行截断，替代当前纯 `lastMessage`）。
- 约束：**纯本地、零外发**。

### P1（后续）

- P1-1 **第二个接入工具为 WorkBuddy（P0 范围内，见 P0-7）**；Claude Code / Cursor 降为后续（Claude Code 会话同为本地 JSONL，可在 WorkBuddy 验证归一后复用；Cursor 存储格式待查）。
- P1-1b ~~国际版 WorkBuddy AI 独立适配器~~ → 已升为 P0-8（§9B）。
- P1-2 时间线里标注 fork 血缘（`parentSessionPath`）与会话间「接手」关系。
- P1-3 导出（接入现有 F8 导出，加入时间线与最后 user 消息）。
- P1-4 全部会话视图里按最后 user 消息搜索。

### 后续考虑（不在本期，仅占位，不承诺）

- **树状展示该会话的全部 user 消息**：在会话条目下以树状（可含 fork 分支）展开该会话所有 user 消息。目前只是方向占位，不承诺排期、形态与是否实现；本期数据模型与 UI 不为其做额外设计，仅避免堵死。

## 4. 用户故事与数据模型

### 用户故事

- 作为开发者，我打开一件事，**不点进任何会话**就能看到每个会话里我最后说的那句话和时间。（P0）
- 作为开发者，我想看这件事在 pi 和 WorkBuddy 里的会话**按时间排在同一条线上**。（P0）
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
  lastUserMessage?: string        // 原文（已在 adapter 内跳过系统/合成 user 消息，见 §8、§9.2）
  lastUserMessageAt?: number      // 该消息时间（ms）
  lastEventAt?: number            // 会话内最后事件时间（ms）
  endedCleanly?: boolean          // 末条是 assistant 终态而非中断/等待用户
}

/** core 归一后的唯一形态，缓存于 ~/.ticktodo/data/session-digests.json */
export interface SessionDigest {
  toolId: string
  sessionId: CliSessionId
  lastUserMessage?: string        // 原文；缓存是否截断见 §8 开放问题
  lastUserMessageAt?: number      // ms
  state: 'active' | 'idle' | 'done' | 'missing'
  lastActiveAt: number            // ms，来自会话内事件时间，非文件 mtime
  fingerprint: { mtimeMs: number; size: number; prefixHash?: string }   // 缓存键；prefixHash 为已读前缀哈希，用于识别重写/截断
}

/** 视图：Todo 下的时间线条目 = TodoSessionView + SessionDigest */
export type TimelineItem = TodoSessionView & { digest?: SessionDigest }
```

`AiToolAdapter` 增加可选方法 `extractLastUserMessage?(sessionId): Promise<SessionLastUserEvidence | undefined>`，由 `SessionService.timelineForTodo(todoId)` 调用并合并。`capabilities.describeSessions` 旁加对应能力位。

**跨工具归一规则**

| 维度 | 规则 |
| --- | --- |
| 时间 | 一律取会话**内部事件时间**（缺失才回退文件 mtime）；Tick 侧 `lastLaunch.launchedAt` 作为跨工具对齐的辅助时钟 |
| 角色 | 取各工具会话记录自带的角色字段（如 `role: user`）；合成 user 消息（系统通知、压缩摘要、注入上下文）由**各 adapter 内部过滤**，core 只收到已过滤的证据 |
| 状态 | `missing`＝会话文件/记录不在；完成状态**读各工具会话记录自带字段**（adapter 映射为 `endedCleanly`）；`active`＝最近 `T_active`（默认 10 分钟）内有事件或工具自报进行中；`done`＝`endedCleanly` 且超过 `T_active`；其余 `idle`。时间线只读，不改动 todo 完成状态 |
| 保底 | 没有可识别的 user 消息时回退 `name ?? firstMessage ?? '会话 xxxxxxxx'`，永不空白 |
| 主键 | `(toolId, sessionId)`；一个 sessionId 只属于一个 todo（现有规则不变） |
| 排序 | 时间线按 `lastActiveAt` 倒序；`primary` 仅加徽标，不改排序 |

## 5. 数据来源

仅本地：adapter 流式读取会话文件（从尾部向前找最后一条合格 user 消息），在本机主进程完成，缓存仅存本机 `~/.ticktodo`。不调用任何模型、不联网、不新增 provider/密钥配置。

## 6. 交互草图（文字描述）

**列表行（todo）**：标题下一行小字 = 最近会话的最后一条 user 消息（单行截断），右侧显示相对时间与工具图标堆叠（pi · WorkBuddy）。

**todo 详情 → 绑定会话页面 / 「进展」**（位于现有会话列表位置，替换之）：

```
 ─ 进展 · 3 个会话 · 2 个工具 ─────────────
 ● 今天 14:20   [pi]           进行中
   我：先把 resume 的 cwd 推导改掉，再补单测，verify 逻辑
   先别动……                      [展开]    [回到会话]
 │
 ○ 昨天 21:05   [WorkBuddy]    已结束
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
4. 时间线按 `lastActiveAt` 倒序，跨工具混排正确（用 pi + WorkBuddy 适配器夹具脚本 / mock 覆盖；仓库无 test runner，见第 11 条）。
5. 缓存命中：会话文件变化（mtime/size）后重新打开则刷新；未变化不重读（命中率可在日志中验证）。
6. 抓包/日志验证**无任何外发请求**。
7. 会话文件被删：条目显示 `missing` 并置灰，不报错，不影响其他条目。
8. 「回到会话」：pi 行为与现有一致；WorkBuddy 经深链接拉起并定位（冷/热启动均验证），id 不存在时不调用并提示；`primary` 逻辑不回归。
9B. WorkBuddy AI（国际版）适配器：与国内版独立（`toolId=workbuddy-ai`，会话 id 用工具侧原始 UUID），同样满足「读不到/格式不识别时降级」「不写其数据、不读 keyblob/settings」；深链接开关按 §9B.6——普通会话默认开启（本机 5.8.4 已实测冷/热/最小化与双会话互跳），playground 会话与换版本未实测前置灰。
9. WorkBuddy 适配器：读不到/格式不识别时降级为空（保底文案）且仍可定位；任何情况下不写 WorkBuddy 数据、不读 keyblob/settings。
10. todo 列表行显示最近一个会话的最后一条 user 消息。
11. core 归一逻辑（最后 user 消息识别、状态判定、保底、排序）有可复跑的临时 `.mjs` 夹具脚本（仓库无 test runner，见 `CLAUDE.md`）；`pnpm typecheck` 通过。

## 8. 决策与开放问题

### 已决定

1. ~~最后一条 user 消息如何识别~~ → **已决定**：用各工具会话记录自带的角色字段（`role: user`）取用户消息，并在各 adapter 内过滤合成 user 消息（系统通知、压缩摘要、注入上下文等）；core 不做跨工具启发式。
2. ~~`done` 的判定~~ → **已决定**：读各工具会话记录自带的完成字段（WorkBuddy 见 §9.3），不设「手动标做完了」。
3. ~~todo 状态联动~~ → **已决定**：时间线严格**只读**，不影响 todo 完成状态，也不提示勾选。
4. ~~第二工具顺序~~ → **已决定**：第二个接入工具是桌面形态的 **WorkBuddy**（P0 范围内）；Claude Code / Cursor 降为后续。
5. ~~回到会话的方式~~ → **已决定**：用深链接拉起 desktop 应用并定位到会话（WorkBuddy：`workbuddy://chat/<id>`）。
6. ~~摘要形态~~ → **已决定**：不做 AI 摘要，展示最后一条 user 消息原文。

### 仍开放

1. **派生缓存放哪里**：单 JSON 文件（简单）vs 按会话分文件（并发写友好）？是否需要和现有文件锁方案对齐？缓存里是否存全文（含折叠阈值）？user 文本可能含路径等敏感信息，是否截断/脱敏后再落盘？
2. **子会话/fork**：`parentSessionPath` 继承段的 user 消息是否算「最后一条」候选（避免 fork 会话显示父会话的消息）？
3. **多 todo 归属**：一个会话是否允许出现在多个 todo 的时间线里（现为唯一归属）？
4. **WorkBuddy 官方验证**：是否由 Jacky 或团队向 WorkBuddy 官方并行确认存储格式 / 深链接 / hooks 的稳定性承诺（见 §10 结论）？

## 9. WorkBuddy 适配器需求（国内版 `workbuddy`）

目标：实现 `AiToolAdapter` 的 WorkBuddy 版本（desktop 形态），输出 `SessionLastUserEvidence`，支持列出会话、取最后一条 user 消息、判断完成状态、拉起定位。实测环境：WorkBuddy 5.8.3（见 `docs/workbuddy-adapter-notes.md`）。

### 9.1 数据源

- **会话索引**：`<root>/workbuddy.db`（SQLite，WAL）的 `sessions` 表。关键列：`id`（UUID，同为 jsonl 文件名与深链参数）、`cwd`、`title`、`custom_title`、`status`、`created_at / updated_at / last_activity_at`（ms）、`deleted_at`、`transport`（local/cloud）、`is_background_automation`。
- **消息流**：`<root>/projects/<cwd 编码>/<id>.jsonl`，一行一事件。cwd 编码：去掉首个 `/`，其余 `/` `\` `:` 换成 `-`（以实测与第三方实现为准）；找不到时遍历 `projects/*/<id>.jsonl` 兜底。
- **目录内容边界**：只把 `*.jsonl` 当会话；`<id>.file-rollback.ndjson`、`<id>/tool-results/**` 不是消息流；`<id>/subagents/*.jsonl` 是子代理会话，折叠进父会话，**不参与主会话的「最后一条 user 消息」与时间线**（[M] 同款判据；本机样本暂无 subagents）。
- **cwd 兜底**：优先取 jsonl 行内 `cwd`；行内没有时读同目录 `<id>.meta.json` 的 `cwd`（旧历史导入的会话；[M] 规范，本机样本 0 个，作为兜底）。
- 只读访问：DB 用只读方式打开（`mode=ro`），WAL 场景下读不到则复制 db/-wal/-shm 到临时目录再读；jsonl 追加写，按行读，容忍末行半行。
- 范围过滤：仅 `transport='local'` 且 `is_background_automation` 非 1 的会话。

### 9.2 最后一条 user 消息规则

从 jsonl 尾部向前找第一条满足下列条件的事件：

1. `type == "message"` 且 `role == "user"`；
2. `providerData.startsNewUserRequest == true`；
3. 排除 `providerData.isMeta == true`（如后台任务 `<task-notification>`）与 `providerData.isCompacted == true`（上下文压缩摘要，`<cb_summary>` 开头）；
4. 文本 = `content[]` 中 `input_text` 拼接，**抽取 `<user_query>…</user_query>` 内文本**（非贪婪、DOTALL）；无该标签则剥离 `<system-reminder[^>]*>…</system-reminder>` 后取剩余（外层标签带 `data-role` 属性，正则必须容忍属性）；
5. 字段容错：`startsNewUserRequest` 缺失时回退为「role=user 且非 isMeta 且非 isCompacted 且含 `<user_query>`」；
6. 消息时间取该事件 `timestamp`（ms）。

找不到则 `lastUserMessage` 为空，走 §4 保底。展示原文，不改写；抽取后的文本不含包装标签。

### 9.3 完成判断

- 首选 `sessions.status`：`completed` → 已完成；`active` → 进行中；`error` → 失败/中断；`Pending` → 未开始。
- 辅助：jsonl 末尾事件为 `message` 且 `role=assistant` 且 `status=completed`，之后无 `function_call` → 本轮完成；末尾为 `function_call/function_call_result` → 仍在执行；assistant `status=incomplete` → 中断。
- **去抖**：DB 为 WAL、`status` 与 jsonl 末尾可能短暂不一致；以两者一致或 `updated_at` 静默 N 秒（默认 5 秒）后才判定 `done`。
- 映射：`endedCleanly = (status=completed) && 末尾 assistant completed`。
- 注：`status` 语义**无第三方实现佐证**——[M] 的会话读取器不读 `workbuddy.db`，本项依据等级维持「仅本机逆向+实测」。

### 9.4 标题

取 `custom_title`（用户改名）优先，其次 `title`；均空则回退 jsonl 的 `custom-title` / `ai-title` 事件（[M] 同一优先级：用户改名 > `ai-title` > 首条 prompt），再回退 §4 保底。展示时按空白折叠、超 160 字符截断（[M] 同款；只影响展示，不改原文）。

### 9.5 软删除过滤

`deleted_at IS NULL OR deleted_at <= 0` 才视为有效会话（实测非删除值可为 NULL、-1、0）。已删除会话即使 jsonl 仍在也不展示。

### 9.6 拉起与定位

- 命令：`open "workbuddy://chat/<encodeURIComponent(id)>"`。
- **调用前先校验 id 存在**于 DB 且未软删除：不存在的 id 深链会落到首页且无错误（`open` 恒 exit 0，无法得知成败），故不存在时不调用并提示。
- 前台判断：主进程可执行名为 `Electron`，但**运行态 App bundle id 是 `com.tencent.workbuddy.mac`**（`lsappinfo` 实测，2026-10-19；`com.github.Electron` 是 Electron 框架默认值，本机属于 Tick 自己的 dev Electron，不能作为判据）；判断前置用 bundle id 或可执行路径 `/Applications/WorkBuddy.app/Contents/MacOS/Electron`，必要时兜底 activate。
- 实测（5.8.3）：冷启动、热启动、窗口最小化三种情形均定位到目标会话（见 notes §8、§8.5）；**未验证**：已删除会话 id、云端会话（transport=cloud）、非本机默认 workspace 未打开的情形。
- 深链接是产品功能但**无公开规范**（§10）；失败（落首页）时给出提示，不重试、不阻塞。

### 9.7 只读工作目录与权限边界

- 只读 `<root>/workbuddy.db`（含 -wal/-shm）与 `<root>/projects/**/*.jsonl`。
- **不读**：`keyblob`、`device-id`、`security/`、`settings.json`、`.workbuddy-key-fallback`、`models.json` 等认证/配置文件；不写 WorkBuddy 任何文件；不改其配置（含 hooks）。
- 不联网、不外发；user 文本只存本机 `~/.ticktodo` 缓存（脱敏策略见开放问题 1）。
- 不接入 `sessions/<pid>.json` 进程心跳与 `traces/`（可选，非本期）。

### 9.8 根目录配置与国际版边界

- 本适配器**仅针对国内版 WorkBuddy**（workbuddy.cn）：数据目录 `~/.workbuddy`，scheme `workbuddy`，bundle `com.tencent.workbuddy.mac`，toolId `workbuddy`。
- 根目录解析优先级：用户配置 > 环境变量 `WORKBUDDY_CONFIG_DIR` > 默认 `~/.workbuddy`。`WORKBUDDY_CONFIG_DIR` 有第三方实现佐证（[M]，本机未验证生效）；`CODEBUDDY_CONFIG_DIR` 属 CodeBuddy Code 自己的目录，[M] 未把它用于 WorkBuddy，故不作本适配器依据（§10 #15）。**两个 build 的识别以各自的 App bundle / 数据根目录为准，不用环境变量判断版本**（§10 表 B B9）。
- **国际版 WorkBuddy AI 是并列的独立适配器（§9B）**：不作为"变体"、不通过切换根目录/scheme/环境变量复用本适配器；两者可同时启用，工具图标与 `toolId` 分开，依据表 A/B 各自独立。会话 id 直接用工具侧原始 UUID（经 `newCliSessionId`，**不加 `toolId:` 前缀**——as-built 的命名空间由 `(toolId, sessionId)` 二元组保证）。

### 9.9 容错与版本探测

- jsonl 遇到**未知 `type` 一律忽略**（已知：session-meta、message、function_call、function_call_result、reasoning、file-history-snapshot、ai-title、custom-title、topic、turn-metrics、summary）。
- 安装探测：macOS 上以 App bundle（`/Applications` 或 `~/Applications` 下的 `WorkBuddy.app`，`CFBundleIdentifier = com.tencent.workbuddy.mac`）是否存在判断 `installed`；**数据目录存在不算已安装**——卸载后 `~/.workbuddy` 会残留，其他工具也会往其中写配置（[M] 实测同一结论）。
- 版本探测：读 App `Info.plist` 版本（5.8.x）与 `.workbuddy-sqlite-migrations` 最新迁移名；`sessions` 表用 `PRAGMA table_info` 检查所需列是否存在。
- 字段缺失/schema 不识别 → 降级：该能力返回空（最后 user 消息为空 → 保底文案；状态为 `idle`），**不报错、不影响其他会话，且只要 id 可得仍能经深链接定位**；日志记录一次探测失败原因。
- 已知版本范围外（探测到未验证的大版本）时在设置页提示「WorkBuddy 版本未验证」。

## 9B. WorkBuddy AI（国际版）适配器需求（`workbuddy-ai`，本期 P0，第三个适配器）

目标：与 §9 并列的**独立** `AiToolAdapter`（desktop 形态），输出 `SessionLastUserEvidence`。对象：WorkBuddy AI（workbuddy.ai，`/Applications/WorkBuddy AI.app`，bundle `com.workbuddy.workbuddy-ai`，5.8.4，scheme `workbuddy-ai`，数据目录 `~/.workbuddy-ai`）。实测记录见 `docs/workbuddy-adapter-notes.md` §10。

> ✅ **实测边界（2026-10-18，5.8.4，屏幕已解锁）**：jsonl/`status`/`deleted_at`/最后 user 规则已在普通会话样本上核对；第四轮起普通会话样本数为 **2**（含带 `function_call` 的会话）；`isMeta`/`isCompacted` 字段仍不出现，为 true 的情形未验证。深链接：playground 冷启动 0/2 回首页（归因未证伪）；普通会话单会话矩阵（§10.9）与双会话互跳（§10.10）均稳定。国内版结论只作对照；适配器按“探测到即用、探测不到则降级”实现。

### 9B.1 数据源

- **会话索引**：`<root>/workbuddy.db` 的 `sessions` 表（**已实测存在**，40 列，与国内版同名核心列一致：`id`、`cwd`、`title`、`custom_title`、`status`、`created_at / updated_at / last_activity_at`、`deleted_at`、`transport`、`is_background_automation`、`unread`；另有 `project_id`、`visibility`、`conversation_origin`、`group_id` 等）。`status` 默认值 `Pending`、`deleted_at` 可空（迁移脚本）、云端行以 `deleted_at = -1` 作未删除（迁移 0012）。
- **消息流**：已实测为 `<root>/projects/<cwd 编码>/<id>.jsonl`（cwd 的 `/` 换成 `-`、去首个 `-`，**空格原样保留**；同目录另有 `<id>.file-rollback.ndjson`），与国内版结构一致（1 个样本）。适配器仍须探测 `projects/` 是否存在；不存在或找不到该 id 的 jsonl → 最后 user 消息为空（保底文案）。`<root>/sessions/<pid>.json` 是应用侧会话心跳：本机实测 `kind='interactive'`、`sessionId` 是真实会话 id（存在于 `sessions` 表），**不是「仅预热」**；心跳新鲜只表示应用当前打开/预热了该会话，**不等于正在执行**（实测该会话 `status=completed`），可作辅助信号，不能作为完成判定依据。（`<id>.meta.json`、`<id>/subagents/**`、`.ndjson` 规则同 §9.1。）
- 只读访问：同 §9.1。⚠️ **实测陷阱**：库为 WAL 模式，新建会话先落在 `-wal`；用 `file:…?mode=ro&immutable=1` 打开会**忽略 -wal，查到 0 行**（本轮实测：immutable 读到 0 行，而连同 -wal 复制到临时目录后读到 1 行）。因此适配器**不得使用 immutable=1**，须 `mode=ro` 正常打开，失败时把 db 连同 -wal/-shm 复制到临时目录再读。范围过滤：`transport='local'` 且 `is_background_automation` 非 1；`deleted_at IS NULL OR deleted_at <= 0`。
- 根目录：默认 `~/.workbuddy-ai`，与国内版 `~/.workbuddy` **各自独立**。两个 build 以**各自的 App bundle + 数据根目录**区分：国际版 `WorkBuddy AI.app` / `com.workbuddy.workbuddy-ai` / `~/.workbuddy-ai`，国内版 `WorkBuddy.app` / `com.tencent.workbuddy.mac` / `~/.workbuddy`；**不靠 `WORKBUDDY_CONFIG_DIR` 判断版本**——该变量只用于国内版根目录覆盖（[M] 把两个 build 注册为独立 agent，各管各的目录）。国际版的目录名来自 App 内 `cli/product.json` 的 `dataFolderName`（[M] 对 5.6.2 app.asar 的逆向），解析顺序为「用户配置 > `product.json` > 默认」。

### 9B.2 最后一条 user 消息规则（1 个样本实测，与国内版规则一致、包装不同）

- 规则与 §9.2 同形，已实测可用：`type=="message" && role=="user"`，排除 `providerData.isMeta`/`isCompacted`，优先 `providerData.startsNewUserRequest==true`，抽取 `<user_query>…</user_query>`（非贪婪、DOTALL）。事件字段：`type`（样本中出现 `session-meta`、`message`、`file-history-snapshot`、`ai-title`）、`role`、`content[]`（`{type:"input_text",text}`）。
- **与国内版差异**：①国际版 user 文本**同样有外层 `<system-reminder data-role="…">` 包装**（2026-10-19 复核：4 条真实 user 请求 4/4 都有；标签带属性，不能用无属性的 `<system-reminder>` 字面量匹配），只是**内层标签**与国内版不同：国际版为 `user_info`、`identity_context`、`product_identity`、`project_context`、`project_layout`、`current_time`、`memory_and_skills_reminder`，最后是 `user_query`；抽取以 `<user_query>` 为准，`<system-reminder …>` 剥离只作兜底；②`isMeta`/`isCompacted` 在样本中**均未出现**（真实用户消息只带 `startsNewUserRequest=true`、`agent`、`conversationRequestId`），其语义**未验证**，仍按“缺失视为 false”处理；③user 消息体积较大（含大量上下文标签）。
- 实现要求：`startsNewUserRequest` 缺失时按“role=user 且非 isMeta 且非 isCompacted 且含 `<user_query>`”回退；仍取不到则为空。

### 9B.3 完成判断（1 个样本实测）

- 首选 `sessions.status`。国际版默认 `Pending`；**实测样本（一问一答完成）为 `completed`**，`active/error` 取值**未在国际版验证**；遇到未知取值一律映射为 `idle` 并记录。辅助：jsonl 末尾事件为 `message/assistant` 且 `status=="completed"`（**已实测一致**，国内版同）。去抖同 §9.3。
- 注：`status` 语义无第三方实现佐证（[M] 不读 `workbuddy.db`），同 §9.3。

### 9B.4 标题 / 软删除

`custom_title` 优先，其次 `title`；软删除过滤同 §9B.1。实测：未删除的本地会话 `deleted_at` 为 **NULL**（不是 -1），`transport=local`，`is_background_automation` 为 NULL；jsonl 另有 `ai-title` 事件。软删除（正数时间戳）与云端 `-1` 仍**未验证**，过滤条件保持 `deleted_at IS NULL OR deleted_at <= 0`。

### 9B.5 只读边界

同 §9.7：只读 `<root>/workbuddy.db`（含 -wal/-shm）与 `<root>/projects/**/*.jsonl`；**不读** `keyblob`、`device-id`、`security/`、`settings.json`、`models.json`、`login-device-nonce` 等；不写、不改配置。

### 9B.6 拉起与定位

- 命令：`open "workbuddy-ai://chat/<encodeURIComponent(id)>"`、`open "workbuddy-ai://home"`（`home` 已实测可用；`chat/<id>` 路由已实测会分发到会话页；`open` 恒 exit 0，成败只能靠日志/路由判断）。
- 实测一（18:05–18:10 UTC+8，notes §10.8；当时库里**唯一**会话是 `is_playground=1`）：热启动 4/5，冷启动 0/2（路由短暂切到会话页后回到首页）。
- 实测二（18:49–19:25 UTC+8，5.8.4，屏幕已解锁，notes §10.9；目标为 **`is_playground=0` 的普通会话**）：每次先冷启动，并预置“上次会话”为另一个会话以区分“应用自动恢复”与“深链接定位”（对照：不发链接时应用恢复到预置会话 3/3）。判据：渲染日志 `cloudProjection` 路由最终落到 `/conversation/<目标 id>` 且 10 秒内稳定、`[DeepLink]` 日志、`lsappinfo` 前台 bundle id 为 `com.workbuddy.workbuddy-ai`。**`resetRouterToHome` 不是可用判据**：该标记在国际版全部日志中出现 0 次（同期 `[DeepLink]` 332 条、`cloudProjection` 159 条），「0 次」等于从不写入；验收用路由变化 + 稳定窗口，不要用它。
  - 基线（冷启动，`open` 一次）**6/6**；A) `open` 后 2/4/8 秒补发同链接各 **3/3**；B) `open -a` 后等 `Registered: deeplink` 信号再发 **3/3**、固定等 3 秒 **3/3**、6 秒 **3/3**；C) 监测路由回落并补发：**回落 0 次**（3/3 直接成功，无需补发）；热启动 **3/3**；最小化后 **1/1**。观察窗口内无路由回落，前台均为目标应用。冷启动定位耗时：单会话约 0.2–0.5s；双会话预置场景约 1.6s（主进程暂存，窗口就绪后分发），无需延迟或重发。
  - 与实测一的差异归因（**假设，未单独证伪**）：playground 会话可能被回落首页；普通会话未观察到回落。因此“回到会话”仅对非 playground 会话开启，属**保守产品决定**，不是已证事实。
  - System Events 窗口标题恒为 `WorkBuddy AI`，**不随会话变化，不能用作定位判据**；其进程名 `Electron` 与国内版重名，区分须用 bundle id。
- 实测三（19:33–19:42 UTC+8，notes §10.10；普通会话 **2** 个，占位 `<A>`/`<B>`；无第三会话故未测 `B→C`/`C→A`）：冷启动预置 `<A>`→深链 `<B>` **2/2**、预置 `<B>`→深链 `<A>` **2/2**；热启动停在 `<A>`→深链 `<B>` **3/3**。观察窗口内无路由回落，前台 `com.workbuddy.workbuddy-ai`。与实测二单会话结论一致。
- **开关策略：国际版“回到会话”默认开启并保持**（单普通会话：冷 6/6、热 3/3、最小化 1/1；双普通会话互跳：冷 4/4、热 3/3）。策略：对 `is_playground!=1` 且 `(deleted_at IS NULL OR deleted_at <= 0)` 的会话，**单次** `open "workbuddy-ai://chat/<encodeURIComponent(id)>"`，冷/热/最小化通用，**不需要**延迟、就绪信号或补发。可选加固（非必需）：不增加补发；若日后版本出现回落，再引入“等待 `Registered: deeplink` 后再发”。**降级**：失败时应用停在首页——不报错、不重试；`is_playground=1` 的会话按钮置灰（**回落原因是假设、未复测**，按保守处理）。**不降级为调用 `workbuddy://`**（会拉起国内版，属错误工具）。样本限制：同一台机器、5.8.4、**2 个**普通会话（无第三会话方向）；换版本需复测。
- 调用前一律先校验 id 存在于 DB 且未软删除；不存在 id 不调用（不存在 id 的路由也会切到空会话页或回落首页）。
- 注：[M]（magpie）未实现深链接/打开 App（其 `Resume` 恒为空），本节的深链接能力**没有第三方实现佐证**，等级维持本机实测，不要因新增 [M] 来源上调。

### 9B.7 版本探测与降级

- 安装探测：macOS 上以 `WorkBuddy AI.app`（bundle `com.workbuddy.workbuddy-ai`，`/Applications` 或 `~/Applications`）是否存在判断 `installed`；数据目录存在不算已安装（[M] 同判据）。
- 读 App `Info.plist` 版本（5.8.4）与 `.workbuddy-sqlite-migrations` 最新迁移名（本机为 0017）；`sessions` 表 `PRAGMA table_info` 检查所需列。
- 已验证范围仅 5.8.4；其它版本提示「WorkBuddy AI 版本未验证」。
- 任何探测失败：该能力返回空，不报错、不影响其它工具，状态 `idle`；工具未安装（无对应 App bundle；数据目录存在但无 App 视为未安装）时适配器静默禁用。

### 9B.8 与国内版的并存

两个适配器独立注册：`toolId` = `workbuddy` / `workbuddy-ai`，会话 id 各自用工具侧原始 UUID（命名空间靠 `(toolId, sessionId)`），同一 cwd 下两边都有会话时各自成项；不共用配置、缓存键、依据等级；任一版本未安装不影响另一个。

### 9B.9 实现状态与待补测清单

**适配器实现已完成（2026-10-19）**——这一条不等于「实测项已全部验证」，只说明合同能力已落地、有可复跑的只读冒烟：

- 包：`@tick/ai-workbuddy`（国内版 + 共用读取内核）、`@tick/ai-workbuddy-ai`（国际版身份）；两版各自 `detect / listSessionInfos / discoverProjects / describeSession / resume`，`launch()` 直接抛错、两版 `capabilities.newSessionMode='prefill'`（`openNewSessionPage()` 负责打开 GUI 新建页并预填，发送后仍由用户倒入绑定）。
- 读取：`workbuddy.db` 只读打开 + WAL 复制兜底 + `PRAGMA table_info` 必需列探测（禁用 `immutable=1`）；列表/项目发现只读 DB，只有 `describeSession` 才流式读 jsonl 并按 `(mtime,size)` 缓存。
- 消息：`<user_query>` 抽取 + `isMeta` / `isCompacted` 过滤 + `startsNewUserRequest` 缺失回退；首条/末条 user 消息用同一套规则。
- 回到会话：`resume` 前查 DB 校验 id 存在且未删除；国际版 `is_playground=1` 置 `resumable=false` 并拒绝；失败不重试、不降级到另一 scheme。
- 实测记录（2026-10-18）：jsonl 位置/文件名、`type`/`role`、`user_query`、`startsNewUserRequest`、末尾 assistant `completed`、`status=completed`、`deleted_at=NULL`、前台 bundle id；普通会话深链接单会话矩阵（§10.9）与双会话互跳（§10.10，2 个普通会话）；`function_call`/`function_call_result` 形态已在样本中见到；“回到会话”已默认开启（普通会话）。
- as-built 细节见 `docs/workbuddy-adapter-notes.md` §11。仍是未验证、也不在本次实现范围内的是：`SessionDigest` / `state: active|idle|done|missing` 的 core 合同与时间线本身（P0-1..P0-6）。

**实测未验证项（仍待补测，不因实现完成而关闭）**：

1. `isMeta=true` / `isCompacted=true` 的实际形态（字段目前在样本中均不出现）；三会话及以上互跳（本机仅 2 个普通会话）；
2. `status` 的 `active/error` 取值与软删除（正数 `deleted_at`）、云端 `-1` 语义；
3. 深链接：已删除会话 id、playground 回落原因的独立证伪；热启动偶发回落的触发条件（普通会话复测中未再现）。

## 10. 官方规范依据

依据等级：**官方文档明确** / **官方仅提及功能无规范** / **第三方实现佐证** / **仅本机逆向+实测（非公开契约）**。

来源：
[A] 更新日志 https://www.workbuddy.cn/docs/workbuddy/Changelog
[B] CodeBuddy hooks https://www.codebuddy.ai/docs/cli/hooks
[C] codebuddy-dir https://www.codebuddy.ai/docs/cli/codebuddy-dir
[D] REST API https://cloud.tencent.com/document/product/1831/137064
[E] codeg https://github.com/xintaofei/codeg/blob/main/src-tauri/src/parsers/codebuddy.rs
[F] deja-vu https://vshulcz.github.io/deja-vu/registry/codebuddy.html
[G] workbuddy-mcp https://github.com/ZhaoXiangyu99/workbuddy-mcp
[M] magpie（yetone/magpie）https://github.com/yetone/magpie —— 第三方会话读取器：`internal/sessions/workbuddy.go`、`internal/agent/workbuddy.go`、`internal/sessions/calls_workbuddy.go`；两个 build 注册为独立 agent（`workbuddy` / `workbuddy-ai`），**不读 `workbuddy.db`**。仅作第三方实现佐证，非官方契约（部分注释基于 5.6.2 app.asar 逆向）。
[N] 本机笔记 `docs/workbuddy-adapter-notes.md`（只读调研 + 实测，国内版 WorkBuddy 5.8.3）
[I] 国际版 WorkBuddy AI 官网文档 https://www.workbuddy.ai/docs/workbuddy/Changelog 、https://www.workbuddy.ai/docs/workbuddy/Quickstart（仅用于表 B）

**表 A：国内版 WorkBuddy（workbuddy.cn）——本期接入对象**

| # | 依赖的功能 / 假设 | 依据等级 | 来源与说明 |
| --- | --- | --- | --- |
| 1 | 读会话索引：`workbuddy.db` 的 `sessions` 表 | 仅本机逆向+实测（非公开契约） | [N]。官方 [A] 只在 4.10.4、5.0.4、5.1.0/5.1.1 提到「会话历史索引」「数据库 WAL 修复/静默丢失检测」，无库路径与 schema；[D] 的 `GET /api/v1/sessions` 属 CodeBuddy Code 服务模式，非桌面端 |
| 2 | 读消息：`projects/<cwd 编码>/<id>.jsonl`，一行一个 Responses 风格 item | 第三方实现佐证 | [E][F] 一致（路径与 item 类型）；[C] 官方仅说 `projects/` 存每项目会话 `.jsonl`、自动维护、不建议手动操作，**无格式承诺**（且为 CodeBuddy Code，非 WorkBuddy）；本机 [N] 与之一致 |
| 3 | cwd 编码规则（`/ \ :` → `-`、去开头 `-`） | 第三方实现佐证 | [E][F]；[B] 示例 `transcript_path` 路径形态与之相符；官方无规则说明 |
| 4 | 角色字段：`type=message` 的 `role=user/assistant` | 第三方实现佐证 | [E][F] 记录 message 含 role；本机实测一致 [N]。官方无字段规范 |
| 5 | 合成 user 消息过滤标记：`providerData.isMeta / isCompacted / startsNewUserRequest`，及 `<user_query>` 包装 | 仅本机逆向+实测（非公开契约） | [N]。[E][F] 均未记录这些字段；官方无文档。最易随版本变化，字段容错重点 |
| 6 | 完成状态字段：`sessions.status`（completed/active/error/Pending）、`unread` | 仅本机逆向+实测（非公开契约） | [N]。官方 Task-Management 文档只描述 UI 状态（进行中/已完成/失败/待处理/规划中/已归档），未公开字段与枚举 |
| 7 | 完成辅助：jsonl 末尾 assistant `status=completed` | 第三方实现佐证 | [E][F] 记录 assistant `status:"completed"`；「末尾无后续 function_call 即本轮完成」是本机推断 [N] |
| 8 | 标题字段：`sessions.title / custom_title`；jsonl `ai-title / custom-title` | 仅本机逆向+实测（非公开契约） | DB 列仅 [N]；jsonl 的 `ai-title / custom-title` type 见 [E][F]（第三方），但 DB 取标题为主路径，按保守等级记 |
| 9 | 深链接 `workbuddy://chat/<id>` 打开指定会话 | 官方仅提及功能无规范 | [A]：5.1.0「页面 deeplink 直达导航，支持外部链接一键打开任务/项目/待办」、5.3.7「修复 Deeplink 工作目录未正确设置」；**无 scheme/路径/参数规范**。[G] 第三方记录 `workbuddy://chat/<id>`；本机 app.asar 字符串分析 + 实测定位成功 [N] |
| 10 | 冷启动 / 前置 / 最小化行为 | 官方仅提及功能无规范 | [A]：5.3.12「修复专家深链在冷启动期间无法打开」、4.22.15「外部协议链接偶发错误唤起」——说明有历史缺陷、无稳定性承诺。冷/热/最小化三种行为为本机实测 [N]；不存在 id 落首页亦为实测 |
| 11 | 软删除语义：`deleted_at IS NULL OR <=0` | 仅本机逆向+实测（非公开契约） | [N]（样本里非删除值为 NULL/-1/0，且曾见 active 会话带正数 deleted_at，语义需继续验证）；官方无文档 |
| 12 | hooks 获取会话 id / transcript 路径 | 官方仅提及功能无规范（对 WorkBuddy）；CodeBuddy Code 为官方文档明确 | [B]：CodeBuddy Code 官方文档明确 hook stdin 含 `session_id / transcript_path / cwd / hook_event_name`，事件含 SessionStart/SessionEnd/PreToolUse 等。**WorkBuddy 侧**：[A] 5.3.5 仅一行「WorkBuddy 扩展插件 Hook」、4.22.4「修复套件市场 hooks 内容无法显示」，无配置/事件文档。本机只读检查（2026-10-18）：`~/.workbuddy/settings.json` 仅 key 名检查，顶层无 `hooks` 键（键为 enabledPlugins、claw、sandbox 等）；app.asar 字符串含 `SessionStart`/`PreToolUse`，说明内核含 hook 机制但 WorkBuddy 用法未确认。**结论：WorkBuddy 是否支持 CodeBuddy 同款 hooks 未证实，本期不依赖** |
| 13 | 国内版数据目录：`~/.workbuddy` | 第三方实现佐证 | [F] 记录该目录；本机 [N] 存在；[M] 以 `$WORKBUDDY_CONFIG_DIR` 或该目录读同一套 `projects/`（国际版目录不在此列，见表 B） |
| 14 | 国内版 URL scheme `workbuddy`、bundle id `com.tencent.workbuddy.mac` | 仅本机逆向+实测（非公开契约） | [N]（Info.plist 与 app.asar）；[M] 以同一 bundle 识别该 build；官方无文档 |
| 15 | 根目录环境变量 `WORKBUDDY_CONFIG_DIR`（仅国内版） | 第三方实现佐证（本机未验证） | [F]/[M] 均按 `$WORKBUDDY_CONFIG_DIR` 覆盖根目录；`CODEBUDDY_CONFIG_DIR` 属 CodeBuddy Code 自己的目录，[M] 未把它用于 WorkBuddy，故不作本适配器依据；官方 [C] 未说明 |
| 16 | 前台应用判断：可执行名 `Electron`、运行态 bundle id `com.tencent.workbuddy.mac`（不是 `com.github.Electron`） | 仅本机逆向+实测（非公开契约） | [N] 2026-10-19 `lsappinfo` 实测：该进程启动于 10-18 16:36（正是 §8.2 实验时刻），bundleID 为 `com.tencent.workbuddy.mac`；`com.github.Electron` 是 Electron 框架默认值，本机属于 Tick 的 dev Electron。官方无文档 |
| 17 | 安装检测：macOS 以 App bundle 判断 installed，数据目录存在不算 | 第三方实现佐证 | [M] `workbuddy_app_test.go`：只有 `~/.workbuddy` 与其写入的 `models.json` 时 `installed=false`，以 `CFBundleIdentifier` 判 App；官方无文档 |
| 18 | 旧历史会话的 cwd 兜底：`<id>.meta.json` | 第三方实现佐证（本机未观测） | [M] `workbuddyMeta`：行内无 `cwd` 时读 `<id>.meta.json` 的 `cwd`；本机样本 0 个 meta.json [N] |
| 19 | 标题兜底：jsonl `custom-title` > `ai-title`；空白折叠、160 字截断 | 第三方实现佐证 | [M] `workbuddyLine` / `assemble` / `title()`；本机 [N] 见 `ai-title` 事件。DB `custom_title/title` 为主路径仍按 #8 |
| 20 | 子代理文件 `<id>/subagents/*.jsonl` 折叠进父会话、不单列；`*.ndjson` 不是会话 | 第三方实现佐证（本机未观测） | [M] `buddyFiles` / `subagentsOf`：子代理以父 id 为 key（`main=false`），只贡献时间/用量，不贡献标题与首条消息；本机样本暂无 subagents |
| 21 | 「回到会话」没有终端 resume：桌面 app 无 CLI resume 命令 | 第三方实现佐证（不能作为深链接佐证） | [M] `resumeCommand` 无 workbuddy 分支、测试断言 `Resume == ""`，`workbuddy.go` 注释「桌面 app，终端无法 resume」；深链接仍仅本机实测（#9/#10） |
| 22 | 用量口径（若本期展示用量）：`providerData.usage` 按 `messageId` 去重、同 id 后行覆盖前行；`input = inputTokens − cached_tokens − cacheCreationTokens`；旧历史用 `input_tokens/output_tokens` | 第三方实现佐证 | [M] `calls_workbuddy.go` 与 `TestWorkBuddyCalls`；若不展示用量，置 `capabilities.usage=false` |

**等级统计（表 A，国内版，共 22 项）**：官方文档明确 **0**（针对 WorkBuddy；仅 #12 的 CodeBuddy Code hooks 与 #2 的 `projects/` 目录存在性是官方文档，但属 CodeBuddy Code，不能直接担保 WorkBuddy）；官方仅提及功能无规范 **3**（#9、#10、#12）；第三方实现佐证 **12**（#2、#3、#4、#7、#13、#15、#17–#22）；仅本机逆向+实测 **7**（#1、#5、#6、#8、#11、#14、#16）。

**表 B：国际版 WorkBuddy AI（workbuddy.ai）——本期 P0 第三个适配器，独立依据，不与表 A 共用等级**

| # | 项 | 依据等级 | 来源与说明 |
| --- | --- | --- | --- |
| B1 | 应用与 bundle id：`WorkBuddy AI.app`、`com.workbuddy.workbuddy-ai`，版本 5.8.4，可执行名 `Electron` | 仅本机逆向+实测（非公开契约） | Info.plist 只读；版本号与 [I] Changelog 5.8.4 条目一致；[M] 以同一 bundle 识别该 build（两 build 各注册一个 agent） |
| B2 | URL scheme `workbuddy-ai` 已注册 | 仅本机逆向+实测（非公开契约） | Info.plist 声明（实测）；官方 [I] 无 deeplink 说明；[M] 未实现深链接，不能佐证 |
| B3 | 深链接 `workbuddy-ai://home` / `chat/<id>` 的拉起与定位 | 仅本机逆向+实测（非公开契约）；普通会话定位稳定；playground 回落为**假设、未复测** | 2026-10-18 实测：scheme 未被忽略；`home` 稳定；playground 冷启动 0/2、回首页（归因未证伪）；第三轮单普通会话冷 6/6、热 3/3、最小化 1/1；第四轮 **2 个**普通会话互跳冷 4/4、热 3/3，无回落；窗口标题不随会话变化；官方 [I] 无 deeplink 说明。**[M] 未实现深链接/打开 App，本项无第三方佐证**。结论：对普通会话默认开启“回到会话”，playground **保守置灰** |
| B4 | 数据目录 `~/.workbuddy-ai` 与 `workbuddy.db`（WAL 模式） | 仅本机逆向+实测（非公开契约） | 目录与库存在；有会话后实测为 WAL，**immutable=1 读不到 -wal 内的新会话（0 行）**；[M] 两 build 根目录：国内版可被 `WORKBUDDY_CONFIG_DIR` 覆盖，国际版固定 `~/.workbuddy-ai`；官方 [I] 无存储说明 |
| B5 | `sessions` 表结构（40 列，核心列与国内版一致，含 `status` 默认 `Pending`、`deleted_at`、`transport`、`unread`） | 仅本机逆向+实测（非公开契约） | 只读 `PRAGMA table_info` + 迁移脚本；官方无；[M] 不读该库 |
| B6 | 实际 `status` 取值 / `deleted_at` 语义 | 仅本机逆向+实测（非公开契约）；`active/error`、软删除**未验证** | 普通会话 2 + playground 2：普通均 `status=completed`、`deleted_at=NULL`、`is_playground=0`；官方无；**[M] 不读 `workbuddy.db`，不能佐证完成状态** |
| B7 | 消息流 `projects/<cwd>/<id>.jsonl` 及 type/role、`user_query` 包装、`startsNewUserRequest` | 仅本机逆向+实测（非公开契约）；普通会话 jsonl 中 `isMeta`/`isCompacted` 字段**均不出现**（=缺省，含工具调用的会话也无），为 true 的情形仍**未验证** | ≥2 个普通会话样本：路径、`type=message`/`role`、`<user_query>`、`startsNewUserRequest=true` 与国内版一致；**两版都有外层 `<system-reminder data-role=…>` 包装、内层标签不同**（2026-10-19 复核 4/4）；`function_call` 已见到；`isMeta`/`isCompacted` 未出现；[M] 两 build 使用同一 reader（仅根目录不同），标题/cwd/子代理规则一致 |
| B8 | 完成判定（`status` + jsonl 末尾） | 仅本机逆向+实测（非公开契约）；多样本均为 completed | 2 个普通会话样本：`status=completed` 且末尾 assistant `status=completed`，二者一致；进行中/出错未验证；**[M] 不读 `workbuddy.db`，不能佐证完成判定** |
| B9 | 工具/版本识别：以各自独立的 App bundle 与数据根目录区分（国际版 `com.workbuddy.workbuddy-ai` / `~/.workbuddy-ai`；国内版 `com.tencent.workbuddy.mac` / `~/.workbuddy`），**不靠环境变量判断 overseas/cn**；`WORKBUDDY_CONFIG_DIR` 只覆盖国内版根目录 | 第三方实现佐证（本机可核 app bundle 与目录） | [M] 两 build 注册为独立 agent（`workbuddy` / `workbuddy-ai`），国际版根目录来自 `product.json` 的 `dataFolderName`；本机 [N] 两个 App 与两个目录共存。旧逆向「app 以 `WORKBUDDY_CONFIG_DIR` 是否含 `workbuddy-ai` 判断版本」**不采用**（与 [M] 冲突） |
| B10 | 官方文档 | 官方仅提及功能无规范（仅产品用法） | [I] Changelog 5.8.4 提到“scheduled task … result navigation”，**无 deeplink/scheme、存储格式、hooks 说明**；hooks 对国际版无任何依据，本期不依赖 |
| B11 | 安装检测：以 `WorkBuddy AI.app` / bundle `com.workbuddy.workbuddy-ai` 判断 installed，数据目录存在不算 | 第三方实现佐证 | [M] `workbuddy_app_test.go`（两个 build 各按自己的 bundle id）；官方 [I] 无说明 |

**等级统计（表 B，共 11 项）**：官方文档明确 **0**；官方仅提及功能无规范 **1**（B10，且仅为产品用法）；第三方实现佐证 **2**（B9、B11）；仅本机逆向+实测 **8**（B1–B8；其中 B3 深链接对普通会话稳定，单机、**2 个**普通会话样本；B6/B7/B8 多样本均为 completed，异常分支未验证）；未验证 **0**（残余未验证子项见 §9B.9）。

> [M] 只覆盖「文件读取 + 安装检测 + 标题/cwd/用量口径」；深链接、完成状态、软删除/`transport`/`playground` 语义**没有第三方佐证**，等级不因新增 [M] 上调。

表 B 的等级不计入表 A 的统计，两表独立。

### 诚实结论

- 本 PRD 对 WorkBuddy 的依赖，**绝大部分是非公开契约**：没有一项有 WorkBuddy 官方文档给出明确规范；最关键的「会话索引 DB」「过滤标记字段」「完成状态字段」仅来自本机逆向，随时可能随版本变化（官方更新日志多次出现会话存储/回放/迁移的修复，无向后兼容承诺）。深链接是「官方提及有功能、无规范」，实测可用。
- 因此必须：**① 版本探测**（App 版本 + 迁移目录 + `PRAGMA table_info`）；**② 降级策略**——读不到/不识别就显示为空（走保底文案），**仍能凭会话 id 经深链接定位**，不报错、不阻塞；**③ 未知 type 与缺失字段容错**；**④ 深链接调用前校验 id 存在**；**⑤ 适配器与 core 隔离**，格式变更只改 adapter。
- 建议**向 WorkBuddy 官方并行验证**：确认 `workbuddy.db`/jsonl 的稳定性承诺、`providerData` 标记与 `sessions.status` 的语义、深链接 `chat/<id>` 的规范与不存在 id 的行为，以及 WorkBuddy 是否支持 hooks（能否官方拿 session_id + transcript_path）。官方若给出契约，可替换为更稳定的信号源并更新本表等级。
