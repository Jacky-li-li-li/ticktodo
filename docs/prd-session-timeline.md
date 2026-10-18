# PRD · 会话最后一条用户消息 + 一件事的进展时间线

| 字段 | 内容 |
| --- | --- |
| 状态 | 草案（v2，已同步 Jacky 的决定），待 Jacky 审阅 |
| 日期 | 2026-10-18 |
| 关联 | `docs/已对齐/PRD-tick.md`（v0.3）、`TECH-ARCH-tick.md` §6、`RESEARCH-magpie.md` |
| 一句话 | 在 todo 的绑定会话页面，每个会话直接显示该会话**最后一条 user 消息原文**，并把这件事在各 AI 工具里的会话按最后事件时间串成时间线，让人一眼看到「每段停在你说的哪一句」，并能点回任意会话继续。 |

**已决定（Jacky，2026-10-18）**

1. 不做 AI 摘要：「摘要」＝该会话最后一条 user 发的消息原文，不改写、不生成。
2. 第二个接入工具是**桌面形态的国内版 WorkBuddy（workbuddy.cn）**（不再是 Claude Code），列入 P0 范围；Claude Code / Cursor 降为后续。**国际版 WorkBuddy AI（workbuddy.ai）是独立工具，本期不接入**，列为后续独立适配器（见 §9.8、§10 表 B）。
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
- 合同：`AiToolAdapter`（`packages/ai/core`）已有 `listSessionInfos / describeSession`，`SessionInfo` 含 `name / firstMessage / lastMessage / createdAt / lastUsedAt / filePath / parentSessionPath`；`SessionService`（`apps/desktop/src/main/services/sessions.ts`）负责拼视图，5s 内存缓存，不落镜像。
- UI：`TodoDetail` 以列表展示绑定会话，「停在哪」仅用 `lastMessage ?? name ?? firstMessage` 的一行文本；可选单会话用量。
- 只有 `PiAdapter` 一个实装；第二个接入工具定为 WorkBuddy（桌面形态），Claude Code / Cursor 后续（`SessionService.fallbackSummaries` 已为第二工具预留）。
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
- P0-7 **第二个接入工具：WorkBuddy 适配器**（桌面形态，需求见 §9；依据与风险见 §10）。
- P0-4 **一键回到会话**：pi 沿用现有 resume；desktop 工具（WorkBuddy）用**深链接**拉起应用并定位到会话（§9.6）；`missing`（文件不在）时置灰并显示原路径。
- P0-5 **缓存与增量**：按 `(filePath, mtime, size)` 缓存，仅变化时重新读取，不阻塞详情打开。
- P0-6 **todo 列表行**：显示最近一个会话的最后一条 user 消息（单行截断，替代当前纯 `lastMessage`）。
- 约束：**纯本地、零外发**。

### P1（后续）

- P1-1 **第二个接入工具为 WorkBuddy（P0 范围内，见 P0-7）**；Claude Code / Cursor 降为后续（Claude Code 会话同为本地 JSONL，可在 WorkBuddy 验证归一后复用；Cursor 存储格式待查）。
- P1-1b **国际版 WorkBuddy AI（workbuddy.ai）独立适配器**：与国内版是两个独立工具，不共用适配器与配置；其 scheme、目录、数据格式未验证，需单独验证后另立需求（现状见 §9.8、§10 表 B）。
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
4. 时间线按 `lastActiveAt` 倒序，跨工具混排正确（用 pi + WorkBuddy 适配器夹具/mock 的单测覆盖）。
5. 缓存命中：会话文件变化（mtime/size）后重新打开则刷新；未变化不重读（命中率可在日志中验证）。
6. 抓包/日志验证**无任何外发请求**。
7. 会话文件被删：条目显示 `missing` 并置灰，不报错，不影响其他条目。
8. 「回到会话」：pi 行为与现有一致；WorkBuddy 经深链接拉起并定位（冷/热启动均验证），id 不存在时不调用并提示；`primary` 逻辑不回归。
9. WorkBuddy 适配器：读不到/格式不识别时降级为空（保底文案）且仍可定位；任何情况下不写 WorkBuddy 数据、不读 keyblob/settings。
10. todo 列表行显示最近一个会话的最后一条 user 消息。
11. 单测覆盖 core 层归一逻辑（最后 user 消息识别、状态判定、保底、排序）；`pnpm typecheck` 通过。

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

## 9. WorkBuddy 适配器需求

目标：实现 `AiToolAdapter` 的 WorkBuddy 版本（desktop 形态），输出 `SessionLastUserEvidence`，支持列出会话、取最后一条 user 消息、判断完成状态、拉起定位。实测环境：WorkBuddy 5.8.3（见 `docs/workbuddy-adapter-notes.md`）。

### 9.1 数据源

- **会话索引**：`<root>/workbuddy.db`（SQLite，WAL）的 `sessions` 表。关键列：`id`（UUID，同为 jsonl 文件名与深链参数）、`cwd`、`title`、`custom_title`、`status`、`created_at / updated_at / last_activity_at`（ms）、`deleted_at`、`transport`（local/cloud）、`is_background_automation`。
- **消息流**：`<root>/projects/<cwd 编码>/<id>.jsonl`，一行一事件。cwd 编码：去掉首个 `/`，其余 `/` `\` `:` 换成 `-`（以实测与第三方实现为准）；找不到时遍历 `projects/*/<id>.jsonl` 兜底。
- 只读访问：DB 用只读方式打开（`mode=ro`），WAL 场景下读不到则复制 db/-wal/-shm 到临时目录再读；jsonl 追加写，按行读，容忍末行半行。
- 范围过滤：仅 `transport='local'` 且 `is_background_automation` 非 1 的会话。

### 9.2 最后一条 user 消息规则

从 jsonl 尾部向前找第一条满足下列条件的事件：

1. `type == "message"` 且 `role == "user"`；
2. `providerData.startsNewUserRequest == true`；
3. 排除 `providerData.isMeta == true`（如后台任务 `<task-notification>`）与 `providerData.isCompacted == true`（上下文压缩摘要，`<cb_summary>` 开头）；
4. 文本 = `content[]` 中 `input_text` 拼接，**抽取 `<user_query>…</user_query>` 内文本**（非贪婪、DOTALL）；无该标签则剥离 `<system-reminder>…</system-reminder>` 后取剩余；
5. 字段容错：`startsNewUserRequest` 缺失时回退为「role=user 且非 isMeta 且非 isCompacted 且含 `<user_query>`」；
6. 消息时间取该事件 `timestamp`（ms）。

找不到则 `lastUserMessage` 为空，走 §4 保底。展示原文，不改写；抽取后的文本不含包装标签。

### 9.3 完成判断

- 首选 `sessions.status`：`completed` → 已完成；`active` → 进行中；`error` → 失败/中断；`Pending` → 未开始。
- 辅助：jsonl 末尾事件为 `message` 且 `role=assistant` 且 `status=completed`，之后无 `function_call` → 本轮完成；末尾为 `function_call/function_call_result` → 仍在执行；assistant `status=incomplete` → 中断。
- **去抖**：DB 为 WAL、`status` 与 jsonl 末尾可能短暂不一致；以两者一致或 `updated_at` 静默 N 秒（默认 5 秒）后才判定 `done`。
- 映射：`endedCleanly = (status=completed) && 末尾 assistant completed`。

### 9.4 标题

取 `custom_title`（用户改名）优先，其次 `title`；均空则回退 jsonl 的 `custom-title` / `ai-title` 事件，再回退 §4 保底。

### 9.5 软删除过滤

`deleted_at IS NULL OR deleted_at <= 0` 才视为有效会话（实测非删除值可为 NULL、-1、0）。已删除会话即使 jsonl 仍在也不展示。

### 9.6 拉起与定位

- 命令：`open "workbuddy://chat/<encodeURIComponent(id)>"`。
- **调用前先校验 id 存在**于 DB 且未软删除：不存在的 id 深链会落到首页且无错误（`open` 恒 exit 0，无法得知成败），故不存在时不调用并提示。
- 前台判断：WorkBuddy 主进程名为 `Electron`，bundle id 为 `com.github.Electron`（不是 `com.tencent.workbuddy.mac`）；以此判断是否已前置，必要时兜底 activate。
- 实测（5.8.3）：冷启动、热启动、窗口最小化三种情形均定位到目标会话（见 notes §8、§8.5）；**未验证**：已删除会话 id、云端会话（transport=cloud）、非本机默认 workspace 未打开的情形。
- 深链接是产品功能但**无公开规范**（§10）；失败（落首页）时给出提示，不重试、不阻塞。

### 9.7 只读工作目录与权限边界

- 只读 `<root>/workbuddy.db`（含 -wal/-shm）与 `<root>/projects/**/*.jsonl`。
- **不读**：`keyblob`、`device-id`、`security/`、`settings.json`、`.workbuddy-key-fallback`、`models.json` 等认证/配置文件；不写 WorkBuddy 任何文件；不改其配置（含 hooks）。
- 不联网、不外发；user 文本只存本机 `~/.ticktodo` 缓存（脱敏策略见开放问题 1）。
- 不接入 `sessions/<pid>.json` 进程心跳与 `traces/`（可选，非本期）。

### 9.8 根目录配置与国际版边界

- 本适配器**仅针对国内版 WorkBuddy**（workbuddy.cn）：数据目录 `~/.workbuddy`，scheme `workbuddy`，bundle `com.tencent.workbuddy.mac`。目录名与 scheme 可做成配置项，但仅作用于国内版。
- 根目录解析优先级：用户配置 > 环境变量 `WORKBUDDY_CONFIG_DIR` > `CODEBUDDY_CONFIG_DIR` > 默认 `~/.workbuddy`。环境变量**仅第三方说法、仅按国内版对待、本机未验证**（§10 #15）。
- **国际版 WorkBuddy AI（workbuddy.ai）是独立工具，本期不接入**：不作为"变体"、不通过切换根目录/scheme/环境变量复用本适配器；后续需另建独立适配器并单独验证。本机观察（未验证）见 §10 表 B 与 notes §9。

### 9.9 容错与版本探测

- jsonl 遇到**未知 `type` 一律忽略**（已知：session-meta、message、function_call、function_call_result、reasoning、file-history-snapshot、ai-title、custom-title、topic、turn-metrics、summary）。
- 版本探测：读 App `Info.plist` 版本（5.8.x）与 `.workbuddy-sqlite-migrations` 最新迁移名；`sessions` 表用 `PRAGMA table_info` 检查所需列是否存在。
- 字段缺失/schema 不识别 → 降级：该能力返回空（最后 user 消息为空 → 保底文案；状态为 `idle`），**不报错、不影响其他会话，且只要 id 可得仍能经深链接定位**；日志记录一次探测失败原因。
- 已知版本范围外（探测到未验证的大版本）时在设置页提示「WorkBuddy 版本未验证」。

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
| 13 | 国内版数据目录：`~/.workbuddy` | 第三方实现佐证 | [F] 记录该目录；本机 [N] 存在（国际版目录不在此列，见表 B） |
| 14 | 国内版 URL scheme `workbuddy`、bundle id `com.tencent.workbuddy.mac` | 仅本机逆向+实测（非公开契约） | [N]（Info.plist 与 app.asar）；官方无文档 |
| 15 | 根目录环境变量 `WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR`（仅按国内版对待） | 第三方实现佐证（本机未验证） | [F]（`$WORKBUDDY_CONFIG_DIR`）、[E]（`CODEBUDDY_CONFIG_DIR`）；官方 [C] 未明确说明 WorkBuddy 是否遵循；对国际版无依据 |
| 16 | 前台应用判断：主进程名 `Electron`、bundle id `com.github.Electron` | 仅本机逆向+实测（非公开契约） | [N] 8.5 实测；依赖打包细节，随版本可能变 |

**等级统计（表 A，国内版，共 16 项）**：官方文档明确 **0**（针对 WorkBuddy；仅 #12 的 CodeBuddy Code hooks 与 #2 的 `projects/` 目录存在性是官方文档，但属 CodeBuddy Code，不能直接担保 WorkBuddy）；官方仅提及功能无规范 **3**（#9、#10、#12）；第三方实现佐证 **6**（#2、#3、#4、#7、#13、#15）；仅本机逆向+实测 **7**（#1、#5、#6、#8、#11、#14、#16）。

**表 B：国际版 WorkBuddy AI（workbuddy.ai）——独立工具，本期不接入，下列均不与表 A 共用依据等级**

| # | 项 | 依据等级 | 来源与说明 |
| --- | --- | --- | --- |
| B1 | 应用与 bundle id：`WorkBuddy AI.app`、`com.workbuddy.workbuddy-ai`，版本 5.8.4 | 仅本机观察（未验证） | Info.plist 只读；版本号与 [I] Changelog 5.8.4 条目一致 |
| B2 | URL scheme `workbuddy-ai` | 仅本机观察（未验证） | Info.plist 声明；路径/参数、定位行为均未测；官方 [I] 无 deeplink 说明 |
| B3 | 数据目录 `~/.workbuddy-ai`（含 `workbuddy.db`；sessions 空、无 `projects/`） | 仅本机观察（未验证） | 仅看文件名；表结构、jsonl 格式、完成字段均未检查；官方 [I] 无存储格式说明 |
| B4 | 根目录环境变量 | 未验证 | 无依据 |
| B5 | 官方文档 | 官方仅有产品用法文档 | [I] Quickstart/Changelog 无 scheme、存储格式、hooks 的说明 |

表 B 的等级不计入下方"等级统计"（统计仅针对表 A）。

### 诚实结论

- 本 PRD 对 WorkBuddy 的依赖，**绝大部分是非公开契约**：没有一项有 WorkBuddy 官方文档给出明确规范；最关键的「会话索引 DB」「过滤标记字段」「完成状态字段」仅来自本机逆向，随时可能随版本变化（官方更新日志多次出现会话存储/回放/迁移的修复，无向后兼容承诺）。深链接是「官方提及有功能、无规范」，实测可用。
- 因此必须：**① 版本探测**（App 版本 + 迁移目录 + `PRAGMA table_info`）；**② 降级策略**——读不到/不识别就显示为空（走保底文案），**仍能凭会话 id 经深链接定位**，不报错、不阻塞；**③ 未知 type 与缺失字段容错**；**④ 深链接调用前校验 id 存在**；**⑤ 适配器与 core 隔离**，格式变更只改 adapter。
- 建议**向 WorkBuddy 官方并行验证**：确认 `workbuddy.db`/jsonl 的稳定性承诺、`providerData` 标记与 `sessions.status` 的语义、深链接 `chat/<id>` 的规范与不存在 id 的行为，以及 WorkBuddy 是否支持 hooks（能否官方拿 session_id + transcript_path）。官方若给出契约，可替换为更稳定的信号源并更新本表等级。
