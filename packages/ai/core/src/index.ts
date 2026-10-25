/**
 * @tick/ai-core — 工具无关的合同与纯函数。
 *
 * 分层（TECH-ARCH §6.1）：
 *   ai/<tool> adapter → 只吐原始证据（ProjectSource），不做归并
 *   ai/core           → mergeProjects 纯函数：归一化 → git 根上卷 → 合并 → 排序
 *   main              → ProjectIndexService：调度 + 缓存 + 失效 + IPC
 *
 * M0 状态：落合同类型。实装顺序 M1（canonicalPath / mergeProjects / registry）。
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import type { CliSessionId, NewSessionMode, SessionDigest, SessionState, ToolClientId } from '@tick/shared'
import { newCliSessionId as mkId } from '@tick/shared'

/** 便捷出口：从任意字符串安全产出 CliSessionId（品牌类型由 shared 保证） */
export const newCliSessionId = mkId

// ---------- 会话元数据（权威源在工具侧） ----------

export interface SessionInfo {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  name?: string
  /** name 缺失时的回退：首条 user 消息（压成一行）。S5 建 todo 的标题用 */
  firstMessage?: string
  /** 最后一条 user 消息（展开卡片「上次停在哪」用；与 firstMessage 同一次流式扫描） */
  lastMessage?: string
  createdAt: string
  lastUsedAt?: number
  exists: boolean
  /**
   * 会话文件绝对路径（主正文文件；导出/定位默认打开它）。
   * 注意：多文件会话（Codex）的完整清单在 `files`，导出的索引应一并写入 `files`。
   */
  filePath?: string
  /**
   * 多文件会话的全部正文文件（as-built：Codex 一个 thread 恢复后可能续写到新的
   * rollout 文件，文件名带 `_<segment>` 后缀）。缺省 = 只有 `filePath` 一个文件。
   * 顺序按时间升序；`filePath` 应是其中最新的一个（导出/定位默认打开它）。
   * 消费者：导出索引（F8）与诊断；会话读取仍按 `filePath`/`sessionId` 现问 adapter。
   */
  files?: string[]
  /** false = 只读会话，不能 resume */
  resumable: boolean
  /** false = 本机看不到它的文件（远端/网关侧），只能看不能跳 */
  hasLocalFiles: boolean
  /**
   * fork 血缘：对齐 pi header 的 `parentSession`——只在 /fork、/clone、
   * newSession({parentSession}) 时出现，值是源会话文件路径。读首行即得。
   * 用途：标注血缘 + 用量求和时跳过继承段（TECH-ARCH §6.2 陷阱 3）。
   */
  parentSessionPath?: string

  // ---------- 时间线证据（P0-1/P0-3；全部可选：给不出就由 core 走保底） ----------
  /**
   * 最后一条**真实** user 消息原文（adapter 内部已过滤注入/合成消息，见 rules §5）。
   * 与 `lastMessage` 的区别：`lastMessage` 是压成一行的标题回退，这条保留消息原文
   * （服务层再截到 `SESSION_DIGEST_TEXT_MAX` 并标记 truncated）。
   */
  lastUserMessage?: string
  /** 最后一条真实 user 消息的时间（ms） */
  lastUserMessageAt?: number
  /** 会话内最后事件时间（ms）——优先消息自身时间；缺失才回退文件 mtime */
  lastEventAt?: number
  /** 末条是 assistant 终态（不是中断/等待用户）；工具侧能判断才给 */
  endedCleanly?: boolean
  /** 工具自报正在执行（如 WorkBuddy `sessions.status=active`）；不知道就不填 */
  running?: boolean
}

export interface SessionRef {
  toolId: string
  sessionId: CliSessionId
}

/** 会话列表的轻量元数据（S5 反向建索引 / 多会话绑定 UI） */
export interface SessionSummary {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  name?: string
  firstMessage?: string
  createdAt: string
  lastUsedAt?: number
  filePath: string
  exists: boolean
  /** fork 血缘（前缀条目继承自源文件，用量求和要跳过） */
  parentSessionPath?: string
  /** 多文件会话的全部正文文件（见 SessionInfo.files；缺省 = 只有 filePath） */
  files?: string[]
  /** 文件大小（字节，用于 UI 详情/诊断） */
  size?: number
  /**
   * false = 这条会话在本工具里不能「回到会话」（如 WorkBuddy AI 的 playground 会话，
   * 深链接定位行为未证伪，保守置灰）。缺省 = 可回到。
   */
  resumable?: boolean
}

// ---------- 时间线摘要（P0-1/P0-3/P0-5，纯函数） ----------

/** 活跃窗口：最后事件在此之内 = 进行中（PRD §4 `T_active`） */
export const SESSION_ACTIVE_WINDOW_MS = 10 * 60 * 1000

/** 进 IPC / 派生缓存的消息原文上限：超长只截断（不改写）并标记 truncated */
export const SESSION_DIGEST_TEXT_MAX = 4000

/** 时间线的原始证据（adapter/`SessionInfo` → `buildSessionDigest` 的输入） */
export interface SessionDigestSource {
  toolId: string
  sessionId: CliSessionId
  exists: boolean
  lastUserMessage?: string
  lastUserMessageAt?: number
  lastEventAt?: number
  endedCleanly?: boolean
  running?: boolean
  /** true = `lastUserMessage` 只是旧 `lastMessage` 的回退，不是原文 */
  approximate?: boolean
}

/**
 * 状态归一（PRD §4）：
 *  - `missing`：文件/记录不在；
 *  - `active`：工具自报进行中，或最后事件在活跃窗口内；
 *  - `done`：末条是 assistant 终态且已过活跃窗口；
 *  - 其余 `idle`（中断/等待用户/无证据）。
 *
 * 只读、纯函数：时间线不改动 todo 完成状态。
 */
export function deriveSessionState(
  input: Pick<SessionDigestSource, 'exists' | 'lastEventAt' | 'endedCleanly' | 'running'>,
  now = Date.now(),
): SessionState {
  if (!input.exists) return 'missing'
  if (input.running === true) return 'active'
  if (input.lastEventAt === undefined) return 'idle'
  // 时钟回拨/未来时间戳也按「刚刚有事件」处理，不要把进行中的会话误判成 idle
  if (now - input.lastEventAt <= SESSION_ACTIVE_WINDOW_MS) return 'active'
  if (input.endedCleanly === true) return 'done'
  return 'idle'
}

/** 把 adapter 证据收成可进 IPC / 缓存的摘要（截断 + 状态判定都在这里） */
export function buildSessionDigest(input: SessionDigestSource, now = Date.now()): SessionDigest {
  const raw = input.lastUserMessage?.trim() || undefined
  const truncated = raw !== undefined && raw.length > SESSION_DIGEST_TEXT_MAX
  const message = truncated ? `${raw.slice(0, SESSION_DIGEST_TEXT_MAX)}…` : raw
  return {
    toolId: input.toolId,
    sessionId: input.sessionId,
    state: deriveSessionState(input, now),
    ...(message ? { lastUserMessage: message } : {}),
    ...(input.lastUserMessageAt !== undefined ? { lastUserMessageAt: input.lastUserMessageAt } : {}),
    ...(input.lastEventAt !== undefined ? { lastActiveAt: input.lastEventAt } : {}),
    ...(input.approximate ? { approximate: true } : {}),
    ...(truncated ? { lastUserMessageTruncated: true } : {}),
  }
}

// ---------- 用量（F6-b：只统计工具侧会话，面板不参与） ----------

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

export interface CostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface SessionUsage {
  tokens: TokenUsage
  /** cost 可能缺失/不可信（provider 未上报）→ UI 只能当下限 */
  cost: CostUsage
  byModel: { provider: string; model: string; tokens: TokenUsage; cost: CostUsage }[]
  /** 会话里的消息条数（预留：UI 暂未消费；adapter 能算就给，不再一律填 0） */
  messageCount: number
  computedAt: number
  /** false = 至少一个 provider 有 token 却报 0 成本 → UI 标注「未上报 / ≥」 */
  costReported: boolean
}

// ---------- 项目证据与归并 ----------

/** adapter 输出：只贡献证据，不做任何归并 */
export interface ProjectSource {
  toolId: string
  projects: {
    path: string
    sessionCount: number
    lastUsedAt?: number
    exists: boolean
  }[]
}

/** core 归并后的唯一形态（主键 = canonical 路径，绝不写成 (toolId, path)） */
export interface ProjectEntry {
  path: string
  /** 上卷前的真实 cwd，需要时可细选 */
  children?: string[]
  /** 多值证据标签，不是单值 */
  tools: string[]
  sessionCount: number
  lastUsedAt?: number
  /** Tick 拉起时自写（跨工具唯一可对齐的时钟） */
  lastLaunchedAt?: number
  /** 用户手动添加 → 不参与 stale 清理 */
  pinned: boolean
  exists: boolean
}

// ---------- 投递方式 ----------

/**
 * pi 的 prefill = 启动时把文案预填进 TUI 输入框（扩展 ctx.ui.setEditorText，不发送）；
 * argv = 启动即发送（interactive-mode session.prompt()）；clipboard 仅作旧配置/降级兜底。
 */
export type DeliverMode = 'prefill' | 'argv' | 'clipboard' | 'flag' | 'stdin' | 'none'

// ---------- Adapter 合同 ----------

export interface LaunchContext {
  promptText: string
  cwd: string
  sessionId: CliSessionId
  name?: string
  deliver: DeliverMode
  /** 多客户端工具的入口选择（OpenCode：desktop / cli）；缺省由调用方按 settings 决定 */
  client?: ToolClientId
}

export interface LaunchResult {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  pid?: number
  delivered: 'prefill' | 'argv' | 'clipboard' | 'none'
  /**
   * 只表示「命令已经交给终端」（spawn / open 成功）——**不代表**会话文件已产生。
   * 会话是否真的落盘由 `verify()` 对账（只有 `newSessionMode='launch'` 的工具才有这条通路）。
   * `resume()` 也返回 true：别把它当成「已校验会话存在」。
   */
  verified: boolean
  /** 非致命降级原因（如 prefill 回执超时后已改投剪贴板），由 UI 原样展示 */
  notice?: string
}

/**
 * 桌面工具「打开 GUI 新建页并预填」的入参。
 *
 * 与 launch 的区别：这里**不预生成 sessionId**、不投递、不绑定；只是把用户送到工具自己的
 * 新建会话/任务页，把文案与工作目录填好，发送动作仍由用户在工具里完成。
 */
export interface NewSessionPageContext {
  promptText: string
  /** 必须存在的绝对路径（桌面工具用它选工作空间/项目） */
  cwd: string
  /** 多客户端工具的入口选择（OpenCode：desktop 深链接预填 / cli 终端+剪贴板） */
  client?: ToolClientId
}

export interface NewSessionPageResult {
  ok: boolean
  reason?: string
  /** true = 文案超过深链接安全长度，已截断后才预填 */
  truncated?: boolean
  /**
   * 非致命提示（成功时也给）：例如 CLI 没有草稿 API，文案只能放剪贴板，
   * 由用户在工具里 ⌘V。UI 必须原样展示，不能藏（否则又变成「假预填」）。
   */
  notice?: string
}

/**
 * 跨工具接手是有向、非对称的（F6-a）：
 * pi→pi 换目录 ✅ / omp 读 pi ✅ / pi 读 omp ❌（forkFrom 要求源首行 type:"session"）。
 * UI 只列可行方向，不可行灰掉并说明原因；任何方向都有「摘要作首条投递」保底。
 */
export interface CarryCapability {
  acceptFrom: { format: string; via: 'fork' | 'import' | 'none' }[]
  exposes: { format: string }[]
}

export interface AiToolAdapter {
  id: string
  /**
   * 就绪探测：只判「装没装」（可执行文件 / App bundle + bundle id）；失败=引导空态双出口（Q14）。
   * 2026-10-19 起不再探测/校验工具版本：装了就按可用处理，版本差异由调用失败如实暴露。
   */
  detect(): Promise<{
    installed: boolean
    reason?: string
  }>
  capabilities: {
    /** 新建会话是否必须有 cwd（预留：当前无消费者，新建页一律先解析出 cwd） */
    needsCwd: boolean
    resumeSession: boolean
    deliverPrompt: DeliverMode[]
    setSessionName: boolean
    discoverProjects: boolean
    describeSessions: boolean
    /** 会话是否自带 usage（pi ✅；面板 Chat 永不参与统计） */
    usage: boolean
    /**
     * 「新建会话」能力，三选一（各工具按自己的设计规范选，不统一 id 生成方式）：
     * - launch：Tick 预生成 sessionId 并拉起工具（CLI，可写 pending 绑定并 verify）；
     * - prefill：只把用户送到工具自己的新建入口并放入文案/工作目录，**不自动发送、不绑定**。
     *   具体怎么放由 `prefillDelivery` 决定（缺省 `deeplink`）：
     *     · `deeplink`      桌面工具：深链接预填 GUI 新建页（WorkBuddy / Claude Desktop）；
     *     · `terminal-copy` CLI 工具：没有草稿 API（启动参数会立刻发送）→ 打开终端里的
     *       工具（argv 不带 prompt）+ 文案进剪贴板，由用户 ⌘V + 回车（Codex/Cline/Grok/omp/…）；
     * - none：连新建入口都没有（as-built：ZCode / DeepSeek Harness）。
     */
    newSessionMode: NewSessionMode
    /** 该工具可用的客户端（>1 时 UI 显示选择器）；缺省 = 只有一个入口 */
    clients?: ToolClientId[]
    /**
     * `newSessionMode='prefill'` 时文案怎么进入工具（缺省 `deeplink`）：
     *  - `deeplink`：深链接把文案预填进 GUI 新建页（WorkBuddy / Claude Desktop）；
     *  - `terminal-copy`：CLI 没有草稿 API（启动参数会立刻发送），只能打开终端里的工具
     *    并把文案放进剪贴板，由用户 ⌘V + 回车确认。
     */
    prefillDelivery?: 'deeplink' | 'terminal-copy'
  }
  discoverProjects?(): Promise<ProjectSource['projects']>
  listSessions?(cwd?: string): Promise<SessionRef[]>
  /** 会话列表（含 name/firstMessage/filePath；S5 与多会话 UI 用） */
  listSessionInfos?(): Promise<SessionSummary[]>
  /** 单会话用量（F6-b；口径由各 adapter 自己算） */
  computeUsage?(sessionId: CliSessionId): Promise<SessionUsage | undefined>
  /** withName=false 时只读 header（cwd 推导等场景不需要全量扫 name，避免读整份会话正文） */
  describeSession?(id: CliSessionId, opts?: { withName?: boolean }): Promise<SessionInfo | undefined>
  /** launch 后校验 session 真的产生：必须绕缓存直读，且 size===0 视为未产生。
   *  只有 `newSessionMode='launch'` 的工具会真正实现；其余工具没有「launch 新增会话」的通路，
   *  实现返回 false 是如实的（不得假装 true）。 */
  verify?(sessionId: CliSessionId, opts?: { retries?: number; intervalMs?: number }): Promise<boolean>
  /**
   * 桌面工具可选：打开自身 GUI 的新建会话页并预填文案/工作目录。
   * 不保证会话 id，也不在 Tick 侧建绑定；发送与否由用户在工具里决定。
   */
  openNewSessionPage?(ctx: NewSessionPageContext): Promise<NewSessionPageResult>
  launch(ctx: LaunchContext): Promise<LaunchResult>
  resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult>
  /** 跨工具接手能力（预留：当前无消费者；新 adapter 不必填） */
  carry?: CarryCapability
}

// ---------- Registry ----------

export class AiToolRegistry {
  private adapters = new Map<string, AiToolAdapter>()

  register(adapter: AiToolAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): AiToolAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): AiToolAdapter[] {
    return [...this.adapters.values()]
  }
}

// ---------- 适配器共用纯函数（跨工具收拢，避免多份拷贝各自漂移） ----------
//
// 为什么放在 core：codex/cline/grok/omp/qoder 的 `openNewSessionPage`、`toSessionTitle`、
// 注入消息过滤、`isRecord/num` 曾经各写一份，已经出现事实漂移（qoder 绕过注入的 resolveExe、
// 有的 title 滤 `<` 有的不滤 → 见 codex 的 AGENTS.md 注入 bug）。这里只保留纯函数/无 Electron
// 的实现，adapter 传身份与 IO 回调进来。

/** 非数组对象守卫（adapter 解析工具写出的 JSON 时统一用它） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限数字，其它一律 0（NaN / Infinity 会静默污染用量与排序） */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 把首条消息压成一行可用的会话标题（统一 pi / claude / codex / grok 的 4 份拷贝）。
 *
 * 过滤 `#` 标题行、``` 代码围栏行与 `<…>` 包装行：工具写进 `role=user` 的注入上下文恰好
 * 是这两种形态。**必须滤 `<`**：Codex 的 `# AGENTS.md instructions for …` 被滤掉首行后，
 * 第二行正好是 `<INSTRUCTIONS>`，本机 40% 会话标题就是这么变成 `<INSTRUCTIONS>` 的。
 * 但**全被过滤时退回首行**：用户以 `<div>` / `<Button>` 开头提问时也要有标题（注入已在
 * `realUserText` 层过滤，不会把注入正文当标题）。
 */
export function toSessionTitle(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  // 多行消息取第一段「像正文」的：跳过标题行、代码围栏行与注入标签行
  const first = lines.find((line) => !line.startsWith('#') && !line.startsWith('```') && !line.startsWith('<'))
  // 全被过滤时退回首行：用户真的可能以 `<div>` / `<Button>` 开头提问。注入上下文已经在
  // `realUserText` 层被过滤（不会走到这里），所以宁可显示原文，也不要把 firstMessage/标题变空。
  const chosen = first ?? lines[0]
  if (!chosen) return undefined
  return chosen.length > max ? `${chosen.slice(0, max)}…` : chosen
}

/**
 * 已知会被工具**写进 `role=user`** 的注入标签（白名单，不是「以 `<` 开头」）。
 *
 * 为什么必须是白名单：`startsWith('<')` 会把用户真的粘贴的 `<div>…</div>` / JSX / 代码片段
 * 当成注入丢掉——**丢用户内容比漏滤一条上下文严重得多**。这里只认各工具实测会写出的标签；
 * 本机 151 个 codex rollout / 1117 条 user 文本的标签分布全部落在下表
 * （`turn_aborted` / `subagent_notification` / `skill` / `recommended_plugins` 这些「看起来像业务
 * 消息」的注入也是工具写的，必须拦）。新增工具/版本带来新注入标签时，此表要同步补。
 */
const INJECTED_TAG_PREFIXES = [
  // codex 自己写进对话的环境/系统上下文
  '<environment_context',
  '<user_instructions',
  '<permissions instructions',
  '<system', // <system> / <system-reminder> / <system_instructions>…
  '<codex_internal_context', // 带 source 属性（goal 等）
  '<turn_aborted', // 用户中断上一轮后的系统事件
  '<subagent_notification', // 子代理完成通知
  '<skill', // skill 正文注入
  '<recommended_plugins', // 插件推荐上下文
  '<external_codex_apps_open_page',
  // claude / pi 写进对话的本地命令包装（claude 会先剥一层，这里是兜底）
  '<local-command-caveat',
  '<local-command-stdout',
  '<local-command-stderr',
  '<command-name',
  '<command-message',
  '<command-args',
]

/**
 * 非标签形态的合成消息。用**完整前缀**而不是 `startsWith('[Request interrupted')` /
 * `startsWith('Caveat:')`：用户完全可能以「[Request interrupted] 之后我改了…」开头提问。
 */
const INJECTED_TEXT_PREFIXES = [
  '# AGENTS.md instructions',
  '[Request interrupted by user',
  'Caveat: The messages below were generated',
]

/**
 * user 文本是否是工具写进来的注入上下文（不是用户说的）。
 *
 * 各工具都会把自己的环境说明/系统提示当 `role=user` 落盘，形态各异：
 *  - `<environment_context>` / `<system…>` / `<turn_aborted>` / `<subagent_notification>` /
 *    `<skill>` / `<recommended_plugins>` / `<codex_internal_context …>`（codex）
 *  - `# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>…`（codex；本机 151 个 rollout 里 65 条）
 *  - `[Request interrupted by user…]` / `Caveat: The messages below were generated…`（claude / pi）
 *  - `<local-command-*>` / `<command-*>` 包装（claude / pi）
 *
 * 判据：**已知标签/已知句子前缀**（白名单），不再「以 `<` 开头一律当注入」。这样用户粘贴的
 * HTML/JSX/代码（`<div>`、`<Button>`…）以及「`<INSTRUCTIONS> 只是一段字符串`」不会被误杀。
 * 注意 `# AGENTS.md instructions` 的正文虽然含 `<INSTRUCTIONS>`，但注入文本以该标题行开头，
 * 由上面第一条前缀拦截——不需要再把「含 `<INSTRUCTIONS>`」当成判据（那会误杀引用该标签的提问）。
 */
export function isInjectedUserText(text: string | undefined | null): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  for (const tag of INJECTED_TAG_PREFIXES) {
    if (startsWithTag(lower, tag)) return true
  }
  for (const prefix of INJECTED_TEXT_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true
  }
  return false
}

/**
 * `text` 是否以完整标签名（小写）开头——要求标签名后是边界（`>` / 空白 / 属性等），
 * 避免前缀"碰巧"匹配：`<system` 不能吞掉用户写的 `<systematic review of …`。
 */
function startsWithTag(text: string, tag: string): boolean {
  if (!text.startsWith(tag)) return false
  const next = text.charAt(tag.length)
  return next === '' || !/[a-z0-9_]/.test(next)
}

/** 真实用户文本：注入上下文返回 undefined，否则返回 trim 后的原文 */
export function realUserText(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!trimmed || isInjectedUserText(trimmed)) return undefined
  return trimmed
}

/** cwd 校验：必须存在且**真的是目录**（只判 existsSync 会把同名文件放过，报错却说「不是目录」） */
export function isExistingDirectory(dir: string | undefined): dir is string {
  if (!dir || !path.isAbsolute(dir)) return false
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 终端拉起入参的最小形状（与 `@tick/ai-pi` 的 TerminalOpenSpec 结构兼容；core 不依赖具体 adapter） */
export interface TerminalOpenSpecLike {
  cwd: string
  executable: string
  args: string[]
}

/** `terminal-copy` 新建页的依赖：adapter 只注入自己的身份与 IO 回调 */
export interface TerminalCopyDeps {
  /** 工具展示名（写进 notice，如 "Codex" / "Qoder CN"） */
  displayName: string
  /** 就绪探测（adapter 自己的 detect；未安装时如实返回原因） */
  detect: () => Promise<{ installed: boolean; reason?: string }>
  /** 已确认存在的可执行文件；**必须与 detect 用同一套解析**（否则测试注入的路径在这条分支失效） */
  requireExe: () => Promise<string>
  openTerminal?: (spec: TerminalOpenSpecLike) => Promise<void> | void
  clipboardWrite?: (text: string) => void
  /** 追加 argv（如 omp 在 cwd=~ 时要 `--allow-home`）；缺省 [] */
  extraArgs?: string[]
}

/**
 * CLI 工具的「新建会话」实现（`prefill` + `terminal-copy`）。
 *
 * CLI 没有草稿 API——把 prompt 放进 argv 会**立刻发送**（codex/cline/grok/omp/qoder 均实测），
 * 所以只做两件事：① 在终端里打开工具本体（argv 不带 prompt）；② 文案进剪贴板，由用户 ⌘V + 回车。
 * 不预生成 id、不写绑定；用户发送后用「倒入历史会话」绑定。
 *
 * 契约：**本函数不抛异常**——就绪探测 / 可执行文件 / 开终端任何一步失败都返回
 * `{ ok: false, reason }`，让 UI 原样展示原因（而不是靠调用方逐层 try/catch 拼笼统文案）。
 *
 * 已知缺陷在这里一次修掉（原先 5 份拷贝各犯一遍）：
 *  - cwd 用 `isExistingDirectory` 判目录，而不是 `existsSync`（文案说「不是目录」就得真判目录）；
 *  - 剪贴板没注入 / 写入抛错时，notice 不再宣称「已复制」（否则用户等一个不会来的 ⌘V）；
 *  - `requireExe` / `openTerminal` 抛错时返回可读 reason（原来异常一路抛给 main，UI 只看到
 *    「打开 X 新建页失败」这种没信息量的兜底文案）。
 */
export async function openTerminalCopyWithClipboard(
  ctx: { promptText: string; cwd: string },
  deps: TerminalCopyDeps,
): Promise<NewSessionPageResult> {
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  let detected: { installed: boolean; reason?: string }
  try {
    detected = await deps.detect()
  } catch (e) {
    return { ok: false, reason: `${deps.displayName} 就绪探测失败：${errText(e)}` }
  }
  if (!detected.installed) return { ok: false, reason: detected.reason ?? `${deps.displayName} 未安装` }
  if (!isExistingDirectory(ctx.cwd)) return { ok: false, reason: '项目路径不存在或不是目录' }
  const open = deps.openTerminal
  if (!open) return { ok: false, reason: '未注入终端拉起实现（main 进程装配 openTerminal）' }
  let exe: string
  try {
    exe = await deps.requireExe()
  } catch (e) {
    // 各 adapter 的 requireExe 已有可读文案（如「可设 TICK_CODEX_PATH」）→ 原样透出
    return { ok: false, reason: errText(e) || `${deps.displayName} 的可执行文件不可用` }
  }
  try {
    await open({ cwd: ctx.cwd, executable: exe, args: deps.extraArgs ?? [] })
  } catch (e) {
    return { ok: false, reason: `打开 ${deps.displayName} 终端失败：${errText(e)}` }
  }
  let copied = false
  if (deps.clipboardWrite) {
    try {
      deps.clipboardWrite(ctx.promptText)
      copied = true
    } catch {
      copied = false // 终端已经打开了：只降级文案，不把整体判成失败
    }
  }
  return {
    ok: true,
    notice: copied
      ? `已打开 ${deps.displayName}；文案已复制 —— 在终端里 ⌘V 再回车发送，发送后用「倒入历史会话」绑定`
      : `已打开 ${deps.displayName}；但文案未能写入剪贴板 —— 请在终端里手动输入，发送后用「倒入历史会话」绑定`,
  }
}

export * from './canonical-path'
export * from './project-merge'
export * from './session-ns'
