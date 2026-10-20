/**
 * DshAdapter — DeepSeek Harness 适配器（toolId = `dsh`）。
 *
 * 事实与口径见 `paths.ts` / `zstd-frames.ts`（magpie + 本机 80 个会话实测）：
 *  - **列会话不整份解压**：标题 / cwd / 最近活动 / 累计用量都来自 dsh 自己的投影缓存
 *    `storages/session_projcache/sessions/<dir>.json`；header（id / delegationDepth / parentSession）
 *    只解首帧（实测 147–207 字节）；首条用户消息与模型来自**前 32 帧**的快路径
 *    （实测首条 user 在 2–6 帧内、首个带 model 的 assistant 在 2–9 帧内）。
 *    39 条会话：首次 121ms，缓存后 26ms。
 *  - **子代理**（`delegationDepth > 0`）不单独列；它们的用量在缓存里是独立的，**加回父会话**
 *    （父会话的 `tokenUsage.totals` 只含自己），这样总量与 dsh 自己的口径一致。
 *  - `describeSession` 才读正文：按帧解压（最大会话 26MB / 23k 帧，实测 ~0.5s），
 *    用户文本只取 `user/message` 且 `data.source.kind === 'user'`（其余是
 *    `agent-instructions` / `plugin` / `skill-catalog` / `subagent-settled`，都是注入）。
 *  - **不能回到会话**：`dsh://` 深链接只有 `dsh://open`（聚焦主窗口），没有按会话打开的协议；
 *    官方也没有按 id 恢复的命令（magpie 同结论）→ `resumeSession=false`。
 *
 * 只读：不读 `.credentials.yaml` / `.env` / `llm-deepseek/` / `profiles/`。
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AiToolAdapter,
  DeliverMode,
  LaunchContext,
  LaunchResult,
  ProjectSource,
  SessionInfo,
  SessionRef,
  SessionSummary,
  SessionUsage,
} from '@tick/ai-core'
import { canonicalPath, newCliSessionId } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import {
  bundleIdOf,
  collectDshSessions,
  dshSessionsStamp,
  exists,
  resolveDshHome,
  toSessionTitle,
  type DshCache,
  type DshSession,
} from './paths'
import { readFrameLines, readPlainLines } from './zstd-frames'

/** Desktop app：`/Applications|~/Applications/DeepSeek Harness.app`（bundle `com.deepseek.dsh`） */
export const DSH_APP_NAME = 'DeepSeek Harness.app'
export const DSH_BUNDLE_ID = 'com.deepseek.dsh'

export interface DshAdapterDeps {
  /** 数据根覆盖（测试隔离） */
  dshHome?: string
  /** App bundle 搜索目录覆盖（测试隔离；缺省查 /Applications 与 ~/Applications + mdfind） */
  appDirs?: string[]
  /** home 覆盖（测试） */
  home?: string
  /** 日志出口（读失败时按 key 记一次原因；不含正文/标题/会话 id） */
  log?: (key: string, message: string) => void
}

interface CachedTexts {
  mtimeMs: number
  first?: string
  last?: string
  /** 正文里出现过 `session/title`（缓存缺失时的标题兜底） */
  title?: string
  /** 正文口径的用量（缓存缺失时兜底） */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** 快路径（只读开头若干帧）：首条用户消息 + 模型/提供方，用于列表与用量标注 */
interface Peek {
  mtimeMs: number
  first?: string
  model?: string
  provider?: string
}

/**
 * 快路径读多少帧。实测（本机 25 个会话）：
 *  - 首条用户消息在前 **2–6** 帧内（p50=4）；
 *  - 首条带 model 的 assistant 消息在前 **2–9** 帧内（p50=6）。
 * 取 32 帧留足余量；解压上限 512KB 兜底异常会话。
 */
const PEEK_FRAMES = 32
const PEEK_MAX_BYTES = 512 * 1024
/**
 * peek 只读压缩文件的前缀：32 帧压缩后实测 < 512KB；给 1MB 留余量。
 * 为什么不能整份读：`readFrameLines` 旧实现第一步就 `readHead(file, size)`，本机 41 个根会话
 * 一次列表白读 69.5MB。
 */
const PEEK_PREFIX_BYTES = 1024 * 1024
/** 缓存条目上限（会话数上限内的正常用量；超限按插入顺序淘汰最旧，防常驻进程只增不减） */
const CACHE_ENTRY_LIMIT = 2000
/** 收集结果缓存 TTL：目录 mtime 不随文件内容变化，短 TTL 兜底「同一目录被追加新内容」 */
const SESSIONS_CACHE_TTL_MS = 3000
/**
 * computeUsage「无投影缓存」回退时，子会话解压的预算：单文件 4MB 压缩、整轮合计 16MB。
 * 为什么限制：回退要逐帧解压整份文件，真实父 + 9 子实测 713ms / 14MB；子会话再大就可能卡住详情页。
 * 超预算的子会话跳过并记一次日志（总量为下限），父会话本身不受限（详情页必须能出数）。
 */
const CHILD_FALLBACK_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024
const CHILD_FALLBACK_TOTAL_BYTES = 16 * 1024 * 1024

/** 有上限的 Map：超限时淘汰最早插入的键（按访问更新的真 LRU 不值得为这点内存写） */
function setCapped<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_ENTRY_LIMIT && !map.has(key)) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** `user/message` 的正文；`source.kind !== 'user'` 是注入（instructions/plugin/skill/subagent 汇报） */
function userTextOf(event: Record<string, unknown>): string | undefined {
  const data = isRecord(event.data) ? event.data : undefined
  if (!data) return undefined
  const source = isRecord(data.source) ? data.source : undefined
  if (source && typeof source.kind === 'string' && source.kind !== 'user') return undefined
  const content = data.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim()
  if (!text) return undefined
  // 整条只有一个标签的（`<system-reminder>…`）也是注入
  if (/^<[a-z_ -]+>[\s\S]*<\/[a-z_ -]+>$/i.test(text)) return undefined
  return text
}

export class DshAdapter implements AiToolAdapter {
  readonly id = 'dsh'

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    // 没有按会话打开的通道（dsh://open 只聚焦窗口）
    resumeSession: false,
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    newSessionMode: 'none',
  }

  private deps: DshAdapterDeps
  private detectCache?: { at: number; value: { installed: boolean; reason?: string } }
  private textsCache = new Map<string, CachedTexts>()
  private peekCache = new Map<string, Peek>()
  /** `collectDshSessions` 的结果缓存：一次列表/用量/项目刷新共用，别每次重读 87 个 header */
  private sessionsCache?: { key: string; at: number; sessions: DshSession[] }
  private logged = new Set<string>()

  constructor(deps: DshAdapterDeps = {}) {
    this.deps = deps
  }

  /** 日志：按 key 去重（列表会被反复调用），文案里不带正文/标题/会话 id */
  private log = (key: string, message: string): void => {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.deps.log?.(`dsh.${key}`, message)
  }

  private dshHome(): string {
    return this.deps.dshHome ?? resolveDshHome()
  }

  private home(): string {
    return this.deps.home ?? homedir()
  }

  // ---------- 就绪探测 ----------

  /**
   * 装没装看 **App bundle + bundle id**（`com.deepseek.dsh`）。
   * 静态目录没命中再问 LaunchServices（`mdfind`）；数据目录存在不算已安装。
   */
  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const now = Date.now()
    if (this.detectCache && now - this.detectCache.at < 30_000) return this.detectCache.value
    const value = await this.probeInstall()
    this.detectCache = { at: now, value }
    return value
  }

  private async probeInstall(): Promise<{ installed: boolean; reason?: string }> {
    const dirs = this.deps.appDirs ?? ['/Applications', path.join(this.home(), 'Applications')]
    const { existsSync } = await import('node:fs')
    const check = async (bundle: string): Promise<boolean> =>
      existsSync(bundle) && (await bundleIdOf(bundle)) === DSH_BUNDLE_ID
    for (const dir of dirs) {
      const bundle = path.join(dir, DSH_APP_NAME)
      if (await check(bundle)) return { installed: true }
    }
    if (!this.deps.appDirs) {
      const found = await new Promise<string | undefined>((resolve) => {
        // 动态 import，避免在纯 Node 测试里拖着 child_process
        import('node:child_process').then(({ execFile }) => {
          execFile(
            '/usr/bin/mdfind',
            [`kMDItemCFBundleIdentifier == '${DSH_BUNDLE_ID}'`],
            { timeout: 1500, maxBuffer: 1 << 20 },
            (error, stdout) => {
              if (error || !stdout) return resolve(undefined)
              resolve(
                stdout
                  .split('\n')
                  .map((line) => line.trim())
                  .find((line) => line.endsWith('.app') && existsSync(line)),
              )
            },
          )
        })
      })
      // 二进制 plist 也要认（bundleIdOf 会走 plutil）；否则「App 在但 plist 是二进制」= 适配器消失
      if (found && (await bundleIdOf(found)) === DSH_BUNDLE_ID) return { installed: true }
    }
    return { installed: false, reason: '未检测到 DeepSeek Harness（bundle com.deepseek.dsh）' }
  }

  // ---------- 会话 ----------

  private sessions(): DshSession[] {
    const home = this.dshHome()
    const now = Date.now()
    const cached = this.sessionsCache
    const stamp = dshSessionsStamp(home)
    if (cached && now - cached.at < SESSIONS_CACHE_TTL_MS && cached.key === stamp) return cached.sessions
    const sessions = collectDshSessions(home, 5000, this.log)
    this.sessionsCache = { key: stamp, at: now, sessions }
    return sessions
  }

  private findSession(id: string): DshSession | undefined {
    return this.sessions().find((session) => session.id === id)
  }

  /** 父会话 id → 子代理会话（用同一次 collect 建表，避免每条用量都重新扫描） */
  private childrenMap(sessions: DshSession[] = this.sessions()): Map<string, DshSession[]> {
    const map = new Map<string, DshSession[]>()
    for (const session of sessions) {
      const parent = session.header.parentSession
      if (!parent) continue
      const list = map.get(parent) ?? []
      list.push(session)
      map.set(parent, list)
    }
    return map
  }

  /** cwd 口径：投影缓存优先（dsh 自己的 cwd 快照），残缺时退回 header */
  private cwdOf(session: DshSession): string | undefined {
    return session.cache?.cwd ?? session.header.cwd
  }

  private totalsOf(
    session: DshSession,
    includeChildren: boolean,
    children?: Map<string, DshSession[]>,
  ): DshCache['totals'] | undefined {
    const own = session.cache?.totals
    let totals = own ? { ...own } : undefined
    if (!includeChildren) return totals
    for (const child of children?.get(session.id) ?? []) {
      const childTotals = child.cache?.totals
      if (!childTotals) continue
      totals ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      totals.input += childTotals.input
      totals.output += childTotals.output
      totals.cacheRead += childTotals.cacheRead
      totals.cacheWrite += childTotals.cacheWrite
    }
    return totals
  }

  /** 正文里的首/末用户消息（按帧解压；缓存按 mtime 失效） */
  private async textsOf(session: DshSession): Promise<CachedTexts> {
    const cached = this.textsCache.get(session.filePath)
    if (cached && cached.mtimeMs === session.mtimeMs) return cached
    const out: CachedTexts = { mtimeMs: session.mtimeMs }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const result = this.readLines(session, {
      onLine: (line) => {
        if (!line.includes('"user/message"') && !line.includes('"session/title"') && !line.includes('"usage"')) return
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (!isRecord(event)) return
        if (event.type === 'user/message') {
          const text = userTextOf(event)
          if (!text) return
          if (out.first === undefined) out.first = text
          out.last = text
          return
        }
        if (event.type === 'session/title') {
          const data = isRecord(event.data) ? event.data : undefined
          if (data && typeof data.title === 'string' && data.title) out.title = data.title
          return
        }
        if (event.type === 'assistant/message') {
          const data = isRecord(event.data) ? event.data : undefined
          const usage = data && isRecord(data.usage) ? data.usage : undefined
          if (!usage) return
          tokens.input += num(usage.inputTokens)
          tokens.output += num(usage.outputTokens)
          tokens.cacheRead += num(usage.cacheReadTokens)
          tokens.cacheWrite += num(usage.cacheWriteTokens)
        }
      },
    })
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0) out.tokens = tokens
    // 文件在但一帧都没读出来（不可读 / 超过上限 / 格式不认识）→ 记一次原因，别让空标题无处可查
    if (result.frames === 0 && result.bytes === 0) {
      this.log('read', 'dsh 有会话正文没读出内容（文件不可读或超过解压上限），已降级为空')
    }
    setCapped(this.textsCache, session.filePath, out)
    return out
  }

  /** 按是否压缩选择读取器（dsh 可以关掉压缩：`session.jsonl`） */
  private readLines(
    session: DshSession,
    opts: Parameters<typeof readFrameLines>[1],
  ): ReturnType<typeof readFrameLines> {
    const reader = session.compressed ? readFrameLines : readPlainLines
    return reader(session.filePath, opts)
  }

  /** 快路径：只读开头若干帧，取首条用户消息与模型（列表/用量标注用；按 mtime 缓存） */
  private peekOf(session: DshSession): Peek {
    const cached = this.peekCache.get(session.filePath)
    if (cached && cached.mtimeMs === session.mtimeMs) return cached
    const peek: Peek = { mtimeMs: session.mtimeMs }
    this.readLines(session, {
      maxFrames: PEEK_FRAMES,
      maxDecompressedBytes: PEEK_MAX_BYTES,
      prefixBytes: PEEK_PREFIX_BYTES,
      onLine: (line) => {
        if (!line.includes('"user/message"') && !line.includes('"assistant/message"')) return
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch {
          return
        }
        if (!isRecord(event)) return
        if (event.type === 'user/message') {
          const text = userTextOf(event)
          if (text && peek.first === undefined) peek.first = text
          return
        }
        if (event.type === 'assistant/message' && peek.model === undefined) {
          const data = isRecord(event.data) ? event.data : undefined
          const message = data && isRecord(data.message) ? data.message : undefined
          const source = message && isRecord(message.source) ? message.source : undefined
          if (source && typeof source.model === 'string' && source.model) peek.model = source.model
          if (source && typeof source.provider === 'string' && source.provider) peek.provider = source.provider
        }
      },
    })
    setCapped(this.peekCache, session.filePath, peek)
    return peek
  }

  private lastUsedOf(session: DshSession): number | undefined {
    return session.cache?.lastPromptAt ?? session.header.createdAt ?? session.cache?.createdAt ?? session.mtimeMs
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const session of this.sessions()) {
      if ((session.header.delegationDepth ?? 0) > 0) continue
      const cwd = this.cwdOf(session)
      if (!cwd || !path.isAbsolute(cwd)) continue
      const p = canonicalPath(cwd)
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: exists(p) }
      entry.sessionCount += 1
      const at = this.lastUsedOf(session)
      if (at !== undefined && (entry.lastUsedAt === undefined || at > entry.lastUsedAt)) entry.lastUsedAt = at
      byPath.set(p, entry)
    }
    return [...byPath.entries()].map(([p, e]) => ({
      path: p,
      sessionCount: e.sessionCount,
      lastUsedAt: e.lastUsedAt,
      exists: e.exists,
    }))
  }

  async listSessions(cwd?: string): Promise<SessionRef[]> {
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    return this.sessions()
      .filter((session) => (session.header.delegationDepth ?? 0) === 0)
      .filter((session) => {
        if (!wantCwd) return true
        const sessionCwd = this.cwdOf(session)
        return Boolean(sessionCwd && canonicalPath(sessionCwd) === wantCwd)
      })
      .map((session) => ({ toolId: this.id, sessionId: newCliSessionId(session.id) }))
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const session of this.sessions()) {
      if ((session.header.delegationDepth ?? 0) > 0) continue // 子代理不单独列
      const peek = this.peekOf(session)
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(session.id),
        cwd: this.cwdOf(session) ?? homedir(),
        name: session.cache?.title,
        // 不整份解压：只读开头若干帧拿首条用户消息（作为无标题时的回退）
        firstMessage: peek.first ? toSessionTitle(peek.first) : undefined,
        createdAt: new Date(session.header.createdAt ?? session.cache?.createdAt ?? session.mtimeMs).toISOString(),
        lastUsedAt: this.lastUsedOf(session),
        filePath: session.filePath,
        exists: true,
        // 没有按会话打开的通道 → 列表里就置灰，别让用户点了才弹「不支持」
        resumable: false,
      })
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  async describeSession(
    id: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    const session = this.findSession(id)
    if (!session) return undefined
    const withName = opts.withName !== false
    const texts = withName ? await this.textsOf(session) : undefined
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd: this.cwdOf(session) ?? homedir(),
      name: withName ? (session.cache?.title ?? texts?.title) : undefined,
      firstMessage: withName ? toSessionTitle(texts?.first) : undefined,
      lastMessage: withName ? toSessionTitle(texts?.last) : undefined,
      createdAt: new Date(session.header.createdAt ?? session.cache?.createdAt ?? session.mtimeMs).toISOString(),
      lastUsedAt: this.lastUsedOf(session),
      filePath: session.filePath,
      exists: true,
      resumable: false, // 没有按会话打开的通道
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    // 一次 collect 同时拿会话与 childrenMap（旧实现 findSession + childrenMap 各 collect 一次 = 双倍 IO）
    const sessions = this.sessions()
    const session = sessions.find((item) => item.id === id)
    if (!session) return undefined
    const children = this.childrenMap(sessions)
    const peek = this.peekOf(session)
    const totals = this.totalsOf(session, true, children)
    if (totals) return this.usageFrom(totals, peek)
    // 缓存缺失（dsh 没写过投影）：退回正文口径。父 + 子都要计，与缓存路径口径一致。
    // ⚠️ 子会话兜底要按帧解压整个文件：真实父 + 9 子实测 713ms / 14MB。所以子会话只在「文件不大」时
    // 才兜底，超过上限就跳过（不阻塞详情页），并在日志里说明总量是下限（不含 id/正文）。
    const texts = await this.textsOf(session)
    const fallback = texts.tokens
      ? { ...texts.tokens }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let hasAny = Boolean(texts.tokens)
    let childBudget = CHILD_FALLBACK_TOTAL_BYTES
    let skipped = 0
    for (const child of children.get(session.id) ?? []) {
      let childTotals = child.cache?.totals
      if (!childTotals) {
        let size = Number.POSITIVE_INFINITY
        try {
          size = statSync(child.filePath).size
        } catch {
          size = Number.POSITIVE_INFINITY
        }
        if (size > CHILD_FALLBACK_MAX_COMPRESSED_BYTES || size > childBudget) {
          skipped += 1
          continue
        }
        childBudget -= size
        childTotals = (await this.textsOf(child)).tokens
      }
      if (!childTotals) continue
      hasAny = true
      fallback.input += childTotals.input
      fallback.output += childTotals.output
      fallback.cacheRead += childTotals.cacheRead
      fallback.cacheWrite += childTotals.cacheWrite
    }
    if (skipped > 0) {
      this.log(
        'usage',
        `dsh 有 ${skipped} 个子会话超过回退解压上限，未计入本次用量（总量为下限；投影缓存恢复后即可精确）`,
      )
    }
    return hasAny ? this.usageFrom(fallback, peek) : undefined
  }

  private usageFrom(
    totals: { input: number; output: number; cacheRead: number; cacheWrite: number },
    peek: Peek,
  ): SessionUsage | undefined {
    const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    if (total === 0) return undefined
    const tokens = { ...totals, totalTokens: total }
    return {
      tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      byModel: [
        {
          // 投影缓存不按模型汇总 → 模型/提供方取正文首条 assistant 消息（快路径，不解整份）
          provider: peek.provider ?? 'deepseek',
          model: peek.model ?? 'unknown',
          tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      ],
      messageCount: 0,
      computedAt: Date.now(),
      costReported: false,
    }
  }

  async verify(): Promise<boolean> {
    return false
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('DeepSeek Harness 不能从 Tick 新建会话；请先在应用里开始，再用「倒入历史会话」绑定。')
  }

  /**
   * 没有按会话打开的通道：`dsh://open` 只聚焦主窗口（asar 里唯一处理的深链接）。
   * 直接抛错，**不做 findSession**：capabilities.resumeSession=false，LaunchService 根本不会调；
   * 旧实现在抛错前先全量扫一遍 sessions 树（含 55MB header IO），纯属浪费。
   */
  async resume(_sessionId: CliSessionId, _ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error(
      'DeepSeek Harness 没有按会话打开的深链接或命令（只有 dsh://open 聚焦窗口），无法从 Tick 直接回到该会话',
    )
  }
}
