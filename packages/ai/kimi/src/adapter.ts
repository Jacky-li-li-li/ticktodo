/**
 * KimiAdapter — Kimi Code 适配器（toolId = `kimi`）。
 *
 * 事实与口径见 `paths.ts` 的头注释（magpie + 本机 7 个会话实测）：
 *  - cwd 只在 `session_index.jsonl` 的 `workDir`（`state.json` 没有 cwd）；
 *  - 会话 id = 目录名 `session_<uuid>`；
 *  - 主对话在 `agents/main/wire.jsonl`，子代理 `agents/agent-N/wire.jsonl` 归本会话；
 *  - 用量：`usage.record` 的 `inputOther`（**不含 cache**）+ `inputCacheRead`/`inputCacheCreation`
 *    + `output`（含 thinking），按 `(agent,time,model,usage)` 去重；
 *  - 回到会话：`kimi --session <id>`；没有预生成 id 的能力 → `newSessionMode='none'`。
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
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
  NewSessionPageContext,
  NewSessionPageResult,
} from '@tick/ai-core'
import { canonicalPath, newCliSessionId } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { findCliExecutable } from '@tick/ai-pi'
import type { TerminalOpenSpec } from '@tick/ai-pi'
import {
  collectKimiSessions,
  readKimiIndex,
  readKimiState,
  readKimiWire,
  resolveKimiHome,
  toSessionTitle,
  type KimiSessionDir,
  type KimiWire,
} from './paths'

export interface KimiAdapterDeps {
  /** 剪贴板（CLI 预填：打开终端 + 文案进剪贴板） */
  clipboardWrite?: (text: string) => void
  resolveExe?: () => Promise<string | null>
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** Kimi home 覆盖（测试隔离） */
  kimiHome?: string
  /** 日志出口（读失败时按 key 记一次，不含正文/标题） */
  log?: (key: string, message: string) => void
}

/**
 * 列表用的 wire 前缀读上限（读到首条 user prompt 即停，所以只有「前缀里没有用户提问」的会话会读满）。
 * 为什么是 512KB：本机实测有会话先写 47KB 的 skill 激活记录，真正的用户提问在 303KB 处；
 * 256KB 会漏掉这类标题（13/117），512KB 能覆盖，而「读满」的只有少数会话（最坏 117×512KB ≈ 60MB，
 * 实际停在首条 prompt 时只有几 KB）。
 */
const PREFIX_MAX_BYTES = 512 * 1024
/**
 * 前缀没命中首条用户文本时的兜底上限：真实库 2/117 会话的提问在 512KB 之后（长 context 前置），
 * 对这类少数会话再读到 4MB（命中即停）；仍没有就如实给 undefined（列表还有 state.title 兜底）。
 * 为什么需要兜底：前缀读把「firstMessage」从有变无，而 SessionPicker/TodoDetail 会用它当标题回退。
 */
const PREFIX_FALLBACK_MAX_BYTES = 4 * 1024 * 1024
/** 缓存条目上限（会话数上限内正常用量；超限淘汰最早插入的，防常驻进程只增不减） */
const CACHE_ENTRY_LIMIT = 2000

/** 有上限的 Map：超限淘汰最早插入的键（不值得为这点内存写真 LRU） */
function setCapped<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_ENTRY_LIMIT && !map.has(key)) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
  map.set(key, value)
}

/** ISO 时间 → ms；解析失败返回 0（NaN 会破坏 lastUsedAt 排序） */
function timeOf(value: string | undefined): number {
  if (!value) return 0
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : 0
}

interface CachedWire {
  mtimeMs: number
  wire: KimiWire
}

export class KimiAdapter implements AiToolAdapter {
  readonly id = 'kimi'

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    resumeSession: true,
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    newSessionMode: 'prefill',
    prefillDelivery: 'terminal-copy',
  }

  private deps: KimiAdapterDeps
  private resolvedExe: string | null = null
  private wireCache = new Map<string, CachedWire>()
  /** 列表用的「前缀 wire」缓存（只读到首条用户消息，与 full wire 缓存分开） */
  private prefixCache = new Map<string, CachedWire>()
  private logged = new Set<string>()

  constructor(deps: KimiAdapterDeps = {}) {
    this.deps = deps
  }

  /** 日志：按 key 去重（列表会被反复调用），文案里不带正文/标题/会话 id */
  private log = (key: string, message: string): void => {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.deps.log?.(`kimi.${key}`, message)
  }

  private kimiHome(): string {
    return this.deps.kimiHome ?? resolveKimiHome()
  }

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 kimi 可执行文件（可设 TICK_KIMI_PATH）' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    this.resolvedExe ??= await findCliExecutable('kimi')
    return this.resolvedExe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('Kimi Code 未安装或不在 PATH（可设 TICK_KIMI_PATH）')
    return exe
  }

  /** 一个会话的全部 wire（主 + 子代理）合并：首条取主，末条取最新，用量相加 */
  private async wireOf(session: KimiSessionDir): Promise<KimiWire> {
    const merged: KimiWire = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageKeys: new Set<string>(),
    }
    const wires: { agent: string; file: string }[] = []
    if (session.mainWirePath) wires.push({ agent: 'main', file: session.mainWirePath })
    for (const file of session.subWirePaths) {
      wires.push({ agent: path.basename(path.dirname(file)), file })
    }
    let firstFromMain: KimiWire | undefined
    for (const { agent, file } of wires) {
      let mtimeMs = 0
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch {
        continue
      }
      const cached = this.wireCache.get(file)
      const emptyWire = (): KimiWire => ({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        usageKeys: new Set<string>(),
      })
      const wire =
        cached && cached.mtimeMs === mtimeMs
          ? cached.wire
          : await readKimiWire(file, agent).catch(() => {
              // 规则 §7：读失败要能诊断；不含路径/正文
              this.log('wire', 'Kimi 有 wire 读取失败（该会话的标题/时间/用量降级）')
              return emptyWire()
            })
      if (!cached || cached.mtimeMs !== mtimeMs) setCapped(this.wireCache, file, { mtimeMs, wire })

      merged.cwd ??= wire.cwd
      merged.createdAt ??= wire.createdAt
      merged.model ??= wire.model
      merged.tokens.input += wire.tokens.input
      merged.tokens.output += wire.tokens.output
      merged.tokens.cacheRead += wire.tokens.cacheRead
      merged.tokens.cacheWrite += wire.tokens.cacheWrite
      merged.lastEventAt = Math.max(merged.lastEventAt ?? 0, wire.lastEventAt ?? 0) || undefined
      if (agent === 'main') {
        firstFromMain = wire
        merged.firstUserText = wire.firstUserText
        merged.firstUserAt = wire.firstUserAt
      }
      // 子 wire 也可能带用户文本：按**时间**取最新（旧实现按数组顺序覆盖，子代理后处理会抢走 lastMessage）
      if (wire.lastUserText && (wire.lastUserAt ?? 0) >= (merged.lastUserAt ?? 0)) {
        merged.lastUserText = wire.lastUserText
        merged.lastUserAt = wire.lastUserAt
      }
      if (!merged.firstUserText && wire.firstUserText) merged.firstUserText = wire.firstUserText
    }
    // 主 wire 缺失时退回子代理的首条（罕见，但不丢信息）
    if (!merged.firstUserText && !firstFromMain) merged.firstUserText = undefined
    return merged
  }

  private findSession(id: string): KimiSessionDir | undefined {
    return collectKimiSessions(this.kimiHome(), 2000, this.log).find((s) => s.id === id)
  }

  /** `session_index.jsonl`：每次 collect 只读一次（旧实现 cwdOf 在循环里逐会话重读 24KB） */
  private index(): Map<string, string> {
    return readKimiIndex(this.kimiHome())
  }

  /**
   * 列表/首条标题用的前缀读：只读到首条用户消息（最多 `PREFIX_MAX_BYTES`）就停，按 mtime 缓存。
   * 为什么：本机冷启 `listSessionInfos` 全文重扫 wire 实测 1455ms；首条 prompt 通常在最前面。
   */
  private async prefixWireOf(session: KimiSessionDir): Promise<KimiWire | undefined> {
    const file = session.mainWirePath
    if (!file) return undefined
    let mtimeMs = 0
    let size = 0
    try {
      const st = statSync(file)
      mtimeMs = st.mtimeMs
      size = st.size
    } catch {
      return undefined
    }
    const cached = this.prefixCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs) return cached.wire
    let wire: KimiWire
    try {
      wire = await readKimiWire(file, 'main', {
        maxBytes: PREFIX_MAX_BYTES,
        stopAfterFirstUser: true,
      })
      // 512KB 里没有合格 user 文本：对这类少数会话再向后读一段（命中即停），避免 firstMessage 无故消失。
      // 只在前缀确实短于文件时兜底，文件本来就更小说明已经读完。
      if (wire.firstUserText === undefined && size > PREFIX_MAX_BYTES) {
        wire = await readKimiWire(file, 'main', {
          maxBytes: PREFIX_FALLBACK_MAX_BYTES,
          stopAfterFirstUser: true,
        })
      }
    } catch {
      this.log('wire', 'Kimi 有 wire 读取失败（该会话的标题/时间降级）')
      return undefined
    }
    setCapped(this.prefixCache, file, { mtimeMs, wire })
    return wire
  }

  /**
   * cwd：index（权威）> 前缀 wire 的 `config.update.cwd`。
   * **不整份读 wire**：`describeSession({withName:false})` 与 resume 前都会调这里，旧实现每次都全文扫。
   */
  private async cwdOf(
    session: KimiSessionDir,
    ctx: { wire?: KimiWire; index?: Map<string, string> } = {},
  ): Promise<string | undefined> {
    const indexed = (ctx.index ?? this.index()).get(session.id)
    if (indexed) return indexed
    const wire = ctx.wire ?? (await this.prefixWireOf(session))
    return wire?.cwd
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    const index = this.index()
    for (const session of collectKimiSessions(this.kimiHome(), 2000, this.log)) {
      const cwd = await this.cwdOf(session, { index })
      if (!cwd || !path.isAbsolute(cwd)) continue
      const p = canonicalPath(cwd)
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: existsSync(p) }
      entry.sessionCount += 1
      if (entry.lastUsedAt === undefined || session.mtimeMs > entry.lastUsedAt) entry.lastUsedAt = session.mtimeMs
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
    const out: SessionRef[] = []
    const index = this.index()
    for (const session of collectKimiSessions(this.kimiHome(), 2000, this.log)) {
      if (wantCwd) {
        const sessionCwd = await this.cwdOf(session, { index })
        if (!sessionCwd || canonicalPath(sessionCwd) !== wantCwd) continue
      }
      out.push({ toolId: this.id, sessionId: newCliSessionId(session.id) })
    }
    return out
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    const index = this.index()
    for (const session of collectKimiSessions(this.kimiHome(), 2000, this.log)) {
      const state = readKimiState(session)
      // 列表只要首条用户消息：前缀读到首条 prompt 即停，不整份读 wire（10.6MB 级会话也不怕）
      const wire = await this.prefixWireOf(session)
      const cwd = (await this.cwdOf(session, { wire, index })) ?? homedir()
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(session.id),
        cwd,
        // 用户改的名优先（`isCustomTitle` + `custom.title`），否则用 Kimi 自己的标题
        name: state.customTitle ?? state.title,
        firstMessage: toSessionTitle(wire?.firstUserText),
        // state.createdAt 可能是坏值：用 timeOf 校验，坏了退回 wire.createdAt / 文件 mtime
        createdAt: new Date(
          timeOf(state.createdAt) || wire?.createdAt || session.mtimeMs,
        ).toISOString(),
        // state.updatedAt 可能落后于 wire（实测 51/117 条更早，最多差 1 天以上）→ 取两者最大值
        lastUsedAt: Math.max(timeOf(state.updatedAt), wire?.lastEventAt ?? 0, session.mtimeMs),
        // 正文是 wire.jsonl（会话目录里可能还有 state.json / logs）
        filePath: session.mainWirePath ?? session.dir,
        exists: true,
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
    // cwd 来自 index、时间来自 state+mtime → withName:false 完全不读 wire（合同 §2 要求不扫全文）
    const state = readKimiState(session)
    const wire = withName ? await this.wireOf(session) : undefined
    const cwd = (await this.cwdOf(session, { wire })) ?? homedir()
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd,
      name: withName ? (state.customTitle ?? state.title) : undefined,
      firstMessage: withName ? toSessionTitle(wire?.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(wire?.lastUserText) : undefined,
      // 同上：坏 ISO 不透传给 UI（否则显示 Invalid Date）
      createdAt: new Date(
        timeOf(state.createdAt) || wire?.createdAt || session.mtimeMs,
      ).toISOString(),
      lastUsedAt: Math.max(timeOf(state.updatedAt), wire?.lastEventAt ?? 0, session.mtimeMs),
      filePath: session.mainWirePath ?? session.dir,
      exists: true,
      resumable: true,
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const session = this.findSession(id)
    if (!session) return undefined
    const wire = await this.wireOf(session)
    const { input, output, cacheRead, cacheWrite } = wire.tokens
    const total = input + output + cacheRead + cacheWrite
    if (total === 0) return undefined
    const tokens = { input, output, cacheRead, cacheWrite, totalTokens: total }
    return {
      tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      byModel: [
        {
          provider: 'moonshot',
          model: wire.model ?? 'unknown',
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

  /**
   * CLI 没有草稿 API（启动参数会立刻发送，已实测）——所以这里只做两件事：
   * 打开终端里的 Kimi Code（新会话页），把文案放进剪贴板，由用户 ⌘V + 回车确认。
   * 不预生成 id、不绑定；发送后用「倒入历史会话」绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    const detected = await this.detect()
    if (!detected.installed) return { ok: false, reason: detected.reason ?? 'Kimi Code 未安装' }
    // 顶层已 import path/existsSync：旧实现在函数里又动态 import 一次，遮蔽了顶部导入（易踩坑）
    if (!ctx.cwd || !path.isAbsolute(ctx.cwd) || !existsSync(ctx.cwd)) {
      return { ok: false, reason: '项目路径不存在或不是目录' }
    }
    const exe = await this.requireExe()
    const open = this.deps.openTerminal
    if (!open) return { ok: false, reason: '未注入终端拉起实现（main 进程装配 openTerminal）' }
    await open({ cwd: ctx.cwd, executable: exe, args: [] })
    // 剪贴板不可用时不宣称「已复制」：只打开终端，并如实说明要手动输入
    const clipboardOk = Boolean(this.deps.clipboardWrite)
    if (this.deps.clipboardWrite) this.deps.clipboardWrite(ctx.promptText)
    return {
      ok: true,
      notice: clipboardOk
        ? '已打开 Kimi Code；文案已复制 —— 在终端里 ⌘V 再回车发送，发送后用「倒入历史会话」绑定'
        : '已打开 Kimi Code；剪贴板不可用，请手动输入文案（发送后用「倒入历史会话」绑定）',
    }
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('Kimi Code 不能从 Tick 新建会话；请先在 Kimi 里开始，再用「倒入历史会话」绑定。')
  }

  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const session = this.findSession(sessionId)
    if (!session) throw new Error(`Kimi Code 会话不存在：${sessionId}`)
    const exe = await this.requireExe()
    // cwd 走 index（缺了才前缀读），不为了一个 cwd 把 10MB wire 读一遍
    const cwd = (await this.cwdOf(session, { index: this.index() })) ?? undefined
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    const finalCwd =
      cwd && existsSync(cwd) ? cwd : ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : homedir()
    await open({ cwd: finalCwd, executable: exe, args: ['--session', sessionId] })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd: finalCwd,
      delivered: 'none',
      verified: true,
    }
  }
}
