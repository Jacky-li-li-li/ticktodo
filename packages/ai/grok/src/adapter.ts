/**
 * Grok Build 适配器（toolId = `grok`）。
 *
 * 格式事实（magpie `internal/sessions/grok.go` + 本机实测 2026-10-20）：
 *   `<GROK_HOME>/sessions/<URL 编码 cwd>/<session id>/summary.json`
 *   `<GROK_HOME>/sessions/<URL 编码 cwd>/<session id>/updates.jsonl`   ← 事件流，时间戳是**秒**
 *
 * summary.json：
 *   `info.id` / `info.cwd` / `created_at`（ISO）/ `generated_title` / `session_summary` /
 *   `current_model_id` / `parent_session_id` / `session_kind`（子代理以 "subagent" 开头）
 *
 * updates.jsonl 里的 `turn_completed` 带 `usage.modelUsage`：**input 已含 cachedReadTokens**、
 * **output 已含 reasoning**（magpie 同口径）。本机的两个会话都是空会话（没有 updates.jsonl），
 * 所以「消息/用量」这部分只有第三方实现的依据，代码按「读不到就降级」写。
 *
 * 回到会话：`grok --resume <id>`（magpie 的 resumeCommand），cwd 取 summary 里的 cwd。
 * 没有预生成 id 的能力 → `newSessionMode='prefill'` + `prefillDelivery='terminal-copy'`
 * （打开终端里的 Grok + 文案进剪贴板，不自动发送、不绑定）。
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
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
import { canonicalPath, isExistingDirectory, isRecord, newCliSessionId, num, openTerminalCopyWithClipboard, realUserText, toSessionTitle } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { findCliExecutable, type TerminalOpenSpec } from '@tick/ai-pi'

export { toSessionTitle }

export function resolveGrokHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.GROK_HOME?.trim()
  return override ? path.resolve(override) : path.join(home, '.grok')
}

export interface GrokSession {
  id: string
  dir: string
  summaryPath?: string
  updatesPath?: string
  mtimeMs: number
}

export function collectGrokSessions(grokHome = resolveGrokHome()): GrokSession[] {
  const root = path.join(grokHome, 'sessions')
  let cwdDirs: string[]
  try {
    cwdDirs = readdirSync(root)
  } catch {
    return []
  }
  const out: GrokSession[] = []
  for (const encoded of cwdDirs) {
    const cwdDir = path.join(root, encoded)
    let ids: string[]
    try {
      if (!statSync(cwdDir).isDirectory()) continue
      ids = readdirSync(cwdDir)
    } catch {
      continue
    }
    for (const id of ids) {
      const dir = path.join(cwdDir, id)
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      const summaryPath = path.join(dir, 'summary.json')
      const updatesPath = path.join(dir, 'updates.jsonl')
      const hasSummary = existsSync(summaryPath)
      const hasUpdates = existsSync(updatesPath)
      if (!hasSummary && !hasUpdates) continue
      let mtimeMs = 0
      for (const p of [summaryPath, updatesPath]) {
        try {
          mtimeMs = Math.max(mtimeMs, statSync(p).mtimeMs)
        } catch {
          /* 忽略缺失的那一个 */
        }
      }
      out.push({
        id,
        dir,
        ...(hasSummary ? { summaryPath } : {}),
        ...(hasUpdates ? { updatesPath } : {}),
        mtimeMs,
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

export interface GrokSummary {
  id?: string
  cwd?: string
  createdAt?: string
  generatedTitle?: string
  sessionSummary?: string
  model?: string
  parentSessionId?: string
  /** 以 "subagent" 开头 = 子代理会话 */
  kind?: string
  /** summary 自报的消息数：`0` 且没有 updates 文件 = 空会话（真实数据里就有 2 个） */
  numMessages?: number
}

export function readGrokSummary(file: string): GrokSummary {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const r = raw as Record<string, unknown>
    const info = r.info && typeof r.info === 'object' ? (r.info as Record<string, unknown>) : undefined
    return {
      id: info && typeof info.id === 'string' ? info.id : undefined,
      cwd: info && typeof info.cwd === 'string' ? info.cwd : undefined,
      createdAt: typeof r.created_at === 'string' ? r.created_at : undefined,
      generatedTitle: typeof r.generated_title === 'string' ? r.generated_title : undefined,
      sessionSummary: typeof r.session_summary === 'string' ? r.session_summary : undefined,
      model: typeof r.current_model_id === 'string' ? r.current_model_id : undefined,
      parentSessionId: typeof r.parent_session_id === 'string' ? r.parent_session_id : undefined,
      kind: typeof r.session_kind === 'string' ? r.session_kind : undefined,
      numMessages: typeof r.num_messages === 'number' && Number.isFinite(r.num_messages) ? r.num_messages : undefined,
    }
  } catch {
    return {}
  }
}

/** updates.jsonl 解析结果：首/末 user 文本 + 用量 */
export interface GrokUpdates {
  firstUserText?: string
  lastUserText?: string
  firstUserAt?: number
  lastEventAt?: number
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  model?: string
}

/** 时间戳单位是**秒**（magpie 明确写了；本机无样本可复核） */
function parseSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value * 1000
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

export async function readGrokUpdates(file: string): Promise<GrokUpdates> {
  const out: GrokUpdates = {}
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"turn_completed"') && !line.includes('"user"') && !line.includes('"message"')) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(event)) continue
      const at = parseSeconds(event.timestamp ?? event.time)
      if (at !== undefined) out.lastEventAt = at
      const type = typeof event.type === 'string' ? event.type : undefined

      if (type === 'turn_completed') {
        const usage = isRecord(event.usage) ? event.usage : undefined
        const modelUsage = usage && isRecord(usage.modelUsage) ? usage.modelUsage : undefined
        if (modelUsage) {
          for (const [model, value] of Object.entries(modelUsage)) {
            if (!isRecord(value)) continue
            const cacheRead = num(value.cachedReadTokens)
            const cacheWrite = num(value.cacheWriteTokens)
            totals.input += Math.max(0, num(value.inputTokens) - cacheRead - cacheWrite)
            totals.output += num(value.outputTokens)
            totals.cacheRead += cacheRead
            totals.cacheWrite += cacheWrite
            out.model = out.model ?? model
          }
        }
        continue
      }

      // 用户消息：`{type:"user", message:{content}}` 或 `{type:"message", role:"user", content}`
      const role = typeof event.role === 'string' ? event.role : isRecord(event.message) && typeof event.message.role === 'string' ? event.message.role : type
      if (role !== 'user') continue
      const content = isRecord(event.message) ? event.message.content : event.content
      const text = textOf(content)
      if (!text) continue
      if (out.firstUserText === undefined) {
        out.firstUserText = text
        if (at !== undefined) out.firstUserAt = at
      }
      out.lastUserText = text
    }
  } finally {
    stream.destroy()
  }
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  if (total > 0) out.usage = totals
  return out
}

function textOf(content: unknown): string | undefined {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is Record<string, unknown> => isRecord(b))
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  // 注入过滤与 codex/claude/pi 共用一份（`<…>` 包装、AGENTS.md 注入、[Request interrupted…] 等）
  return realUserText(text)
}

/**
 * createdAt 必须是能解析的 ISO：summary 里的 created_at 可能是坏值/空串，
 * 原样透传会让 UI 显示 NaN/Invalid Date（时间线/排序都会随之坏掉）。
 */
function isoOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * `provider` 只作展示，不参与数字：Grok Build 的模型都是 xAI 自家的 `grok-*`。
 * 模型 id 缺失/形态不认识时如实标 `unknown`，不要把所有条目一律说成 xai。
 */
function providerOf(model: string | undefined): string {
  return model && model.startsWith('grok') ? 'xai' : 'unknown'
}
export interface GrokAdapterDeps {
  /** 剪贴板（CLI 预填：打开终端 + 文案进剪贴板） */
  clipboardWrite?: (text: string) => void
  resolveExe?: () => Promise<string | null>
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  grokHome?: string
}

export class GrokAdapter implements AiToolAdapter {
  readonly id = 'grok'

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

  private deps: GrokAdapterDeps
  private resolvedExe: string | null = null
  private summaryCache = new Map<string, { mtimeMs: number; summary: GrokSummary }>()
  private updatesCache = new Map<string, { mtimeMs: number; updates: GrokUpdates }>()

  constructor(deps: GrokAdapterDeps = {}) {
    this.deps = deps
  }

  private grokHome(): string {
    return this.deps.grokHome ?? resolveGrokHome()
  }

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 grok 可执行文件（可设 TICK_GROK_PATH）' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    this.resolvedExe ??= await findCliExecutable('grok')
    return this.resolvedExe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('Grok 未安装或不在 PATH（可设 TICK_GROK_PATH）')
    return exe
  }

  private summaryOf(session: GrokSession): GrokSummary {
    if (!session.summaryPath) return {}
    let mtimeMs = 0
    try {
      mtimeMs = statSync(session.summaryPath).mtimeMs
    } catch {
      return {}
    }
    const cached = this.summaryCache.get(session.summaryPath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.summary
    const summary = readGrokSummary(session.summaryPath)
    this.summaryCache.set(session.summaryPath, { mtimeMs, summary })
    return summary
  }

  private async updatesOf(session: GrokSession): Promise<GrokUpdates> {
    if (!session.updatesPath) return {}
    let mtimeMs = 0
    try {
      mtimeMs = statSync(session.updatesPath).mtimeMs
    } catch {
      return {}
    }
    const cached = this.updatesCache.get(session.updatesPath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.updates
    const updates = await readGrokUpdates(session.updatesPath)
    this.updatesCache.set(session.updatesPath, { mtimeMs, updates })
    return updates
  }

  private findSession(id: string): GrokSession | undefined {
    return collectGrokSessions(this.grokHome()).find((s) => s.id === id)
  }

  /** 子代理会话（`session_kind` 以 subagent 开头）不参与列表：它们归父会话 */
  private isSubagent(summary: GrokSummary): boolean {
    return typeof summary.kind === 'string' && summary.kind.startsWith('subagent')
  }

  /**
   * 空会话：summary 自报 0 条消息且没有 updates 文件（本机真实数据里 2/2 就是这形态）。
   * 与其它适配器的「空/僵尸会话不算」口径一致（codex `size===0`、omp `size===0`、cline messages 非空）；
   * 否则列表里会出现无名空条目、`/` 这种根路径还会被贡献成项目。
   */
  private isEmptySession(session: GrokSession, summary: GrokSummary): boolean {
    return !session.updatesPath && summary.numMessages === 0
  }

  /** 列表/项目发现共用的「这条算不算会话」判定 */
  private isListable(session: GrokSession, summary: GrokSummary): boolean {
    return !this.isSubagent(summary) && !this.isEmptySession(session, summary)
  }

  /** 会话的主正文文件（updates 是事件流；只有 summary 的旧会话退回 summary） */
  private fileOf(session: GrokSession): string {
    return session.updatesPath ?? session.summaryPath ?? session.dir
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const session of collectGrokSessions(this.grokHome())) {
      const summary = this.summaryOf(session)
      if (!this.isListable(session, summary)) continue
      if (!summary.cwd || !path.isAbsolute(summary.cwd)) continue
      const p = canonicalPath(summary.cwd)
      // 根路径（`/`）不是项目：本机就有 cwd="/" 的会话，点进去什么都没有
      if (p === path.parse(p).root) continue
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: false }
      entry.sessionCount += 1
      if (entry.lastUsedAt === undefined || session.mtimeMs > entry.lastUsedAt) entry.lastUsedAt = session.mtimeMs
      byPath.set(p, entry)
    }
    return [...byPath.entries()].map(([p, e]) => ({
      path: p,
      sessionCount: e.sessionCount,
      lastUsedAt: e.lastUsedAt,
      exists: existsSync(p),
    }))
  }

  async listSessions(cwd?: string): Promise<SessionRef[]> {
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    const out: SessionRef[] = []
    for (const session of collectGrokSessions(this.grokHome())) {
      const summary = this.summaryOf(session)
      if (!this.isListable(session, summary)) continue
      if (wantCwd && (!summary.cwd || canonicalPath(summary.cwd) !== wantCwd)) continue
      out.push({ toolId: this.id, sessionId: newCliSessionId(session.id) })
    }
    return out
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const session of collectGrokSessions(this.grokHome())) {
      const summary = this.summaryOf(session)
      if (!this.isListable(session, summary)) continue
      const updates = await this.updatesOf(session)
      const filePath = this.fileOf(session)
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(session.id),
        cwd: summary.cwd ?? homedir(),
        // 标题：`generated_title` > `session_summary`（magpie 同序）> 首条 user
        name: summary.generatedTitle || summary.sessionSummary || undefined,
        firstMessage: toSessionTitle(updates.firstUserText),
        createdAt: isoOf(summary.createdAt) ?? new Date(session.mtimeMs).toISOString(),
        lastUsedAt: updates.lastEventAt ?? session.mtimeMs,
        filePath,
        exists: existsSync(filePath),
        // 空会话已被过滤，剩下的都能 `grok --resume <id>`
        resumable: true,
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
    const summary = this.summaryOf(session)
    const withName = opts.withName !== false
    const updates = withName ? await this.updatesOf(session) : {}
    const filePath = this.fileOf(session)
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd: summary.cwd ?? homedir(),
      name: withName ? summary.generatedTitle || summary.sessionSummary || undefined : undefined,
      firstMessage: withName ? toSessionTitle(updates.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(updates.lastUserText) : undefined,
      createdAt: isoOf(summary.createdAt) ?? new Date(session.mtimeMs).toISOString(),
      lastUsedAt: updates.lastEventAt ?? session.mtimeMs,
      filePath,
      exists: existsSync(filePath),
      // 空会话（num_messages=0 且无 updates）如实不可回：resume 回去也是空会话
      resumable: !this.isEmptySession(session, summary),
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const session = this.findSession(id)
    if (!session) return undefined
    const updates = await this.updatesOf(session)
    if (!updates.usage) return undefined
    const { input, output, cacheRead, cacheWrite } = updates.usage
    const tokens = { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }
    const summary = this.summaryOf(session)
    const model = summary.model ?? updates.model
    return {
      tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      byModel: [
        {
          provider: providerOf(model),
          model: model ?? 'unknown',
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
   * CLI 没有草稿 API（启动参数会立刻发送，已实测）——走共享的 terminal-copy 实现：
   * 打开终端里的 Grok（新会话页），把文案放进剪贴板，由用户 ⌘V + 回车确认。
   * 不预生成 id、不绑定；发送后用「倒入历史会话」绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    return openTerminalCopyWithClipboard(ctx, {
      displayName: 'Grok',
      detect: () => this.detect(),
      requireExe: () => this.requireExe(),
      ...(this.deps.openTerminal ? { openTerminal: this.deps.openTerminal } : {}),
      ...(this.deps.clipboardWrite ? { clipboardWrite: this.deps.clipboardWrite } : {}),
    })
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('Grok 不能从 Tick 新建会话；请先在 Grok 里开始，再用「倒入历史会话」绑定。')
  }

  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const session = this.findSession(sessionId)
    if (!session) throw new Error(`Grok 会话不存在：${sessionId}`)
    const exe = await this.requireExe()
    const summary = this.summaryOf(session)
    // cwd 必须是真目录：summary 里的 cwd 优先，其次 Tick 侧项目，最后 home
    const cwd = isExistingDirectory(summary.cwd)
      ? summary.cwd
      : isExistingDirectory(ctx.cwd)
        ? ctx.cwd
        : homedir()
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    await open({ cwd, executable: exe, args: ['--resume', sessionId] })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }
}
