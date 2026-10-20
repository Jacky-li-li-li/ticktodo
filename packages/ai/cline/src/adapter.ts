/**
 * Cline CLI 适配器（toolId = `cline`）。
 *
 * 关键事实（magpie `internal/sessions/cline.go` + 本机实测）：
 *  - 一个会话 = 一个目录里的**两份文件**：manifest（`<id>.json`）与对话（`<id>.messages.json`）；
 *    对话文件是**整份重写**的，不是追加流（缓存只能按 (mtime,size) 失效）。
 *  - 用户文本被包在 `<user_input mode="act">…</user_input>` 里；合成/注入消息按标签剥离后为空即丢弃。
 *  - 用量：assistant 消息的 `metrics`（AI SDK 口径：`inputTokens` **已含** cache、
 *    `outputTokens` 已含 reasoning）→ `input = inputTokens − cacheReadTokens − cacheWriteTokens`。
 *  - 回到会话：`cline --id <id>`；**不能**预生成 id → `newSessionMode='prefill'` +
 *    `prefillDelivery='terminal-copy'`（打开终端 + 文案进剪贴板，不自动发送、不绑定）。
 */

import { createReadStream, existsSync } from 'node:fs'
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
  NewSessionPageContext,
  NewSessionPageResult,
} from '@tick/ai-core'
import { canonicalPath, isExistingDirectory, newCliSessionId, num, openTerminalCopyWithClipboard } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { findCliExecutable, type TerminalOpenSpec } from '@tick/ai-pi'
import {
  collectClineSessions,
  readClineManifest,
  resolveClineSessionDir,
  type ClineSession,
} from './paths'

export interface ClineAdapterDeps {
  /** 剪贴板（CLI 预填：打开终端 + 文案进剪贴板） */
  clipboardWrite?: (text: string) => void
  resolveExe?: () => Promise<string | null>
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** sessions 目录覆盖（测试隔离） */
  sessionDir?: string
}

interface ClineMessage {
  role?: string
  content?: unknown
  ts?: number
  modelInfo?: { id?: string }
  metrics?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

/** 一条对话的**摘要**（不保留 `messages[]` 正文） */
interface ClineSummary {
  firstUser?: string
  lastUser?: string
  messageCount: number
  /** assistant metrics 累计（已把 cache 从 input 扣掉，见上方口径） */
  usage: ClineTokens
  /** 按模型分组的同一口径（provider 由 manifest 提供） */
  byModel: Record<string, ClineTokens>
}

interface ClineTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

function emptyTokens(): ClineTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function emptySummary(): ClineSummary {
  return { messageCount: 0, usage: emptyTokens(), byModel: {} }
}

/** ISO → 毫秒；缺失或 `Date.parse` 失败一律 undefined（NaN 会污染排序与 UI 时间） */
function timeOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

/** `<user_input mode="act">…</user_input>` 等包装剥离；剥完为空即视为合成消息 */
const WRAPPER_RES = [
  /<user_input[^>]*>([\s\S]*?)<\/user_input>/i,
  /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<environment_details>[\s\S]*?<\/environment_details>/gi,
]

export function userTextOfCline(content: unknown): string | undefined {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  if (!text) return undefined
  const inner = WRAPPER_RES[0]!.exec(text)?.[1]
  if (inner !== undefined) text = inner
  for (const re of WRAPPER_RES.slice(1)) text = text.replace(re, '')
  text = text.trim()
  if (!text) return undefined
  if (/^<[a-z_ -]+>[\s\S]*<\/[a-z_ -]+>$/i.test(text)) return undefined
  return text
}

interface ScanOptions {
  /** 只取首条合格 user 文本就停（列表用：不整份读、也不进缓存） */
  stopAfterFirstUser?: boolean
  /** 读取字符上限（防止「整份没有 user 消息」的巨型会话把列表拖住）。full 扫描不设上限 */
  maxChars?: number
}

/** 列表阶段最多扫这么多字符（首条用户消息通常在最前面；这里只是防病态文件的兜底） */
const LIST_SCAN_MAX_CHARS = 8 * 1024 * 1024

/**
 * 流式扫 `<id>.messages.json`，只产出摘要；**不保留正文**。
 *
 * 为什么不能整份读：这个文件是 pretty-print 的单个 JSON 对象，Cline 会把浏览器截图以
 * base64 塞进消息里（单条可达数十 MB），旧实现 `buffer += line` 再 `JSON.parse` 会把
 * 「整份会话 + systemPrompt」同时留在内存里，未压缩缓存又把 `messages[]` 常驻。
 * 这里做字符级状态机：只在内存里累积**当前这一个** `{…}` 消息对象，解析完即丢。
 *
 * 边界：文件可能被工具正在重写（截断的 JSON）。状态机在 EOF 时直接返回已解析到的部分，
 * 不会像 `JSON.parse(整份)` 那样一坏就整条会话变空。
 */
async function scanConversation(file: string, opts: ScanOptions = {}): Promise<ClineSummary> {
  const summary = emptySummary()
  const maxChars = opts.maxChars
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  let phase: 'seek' | 'body' | 'done' = 'seek'
  let tail = ''
  let buf = ''
  let depth = 0
  let inString = false
  let escaped = false
  let scanned = 0

  const absorb = (raw: string): void => {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return // 坏消息只丢这一条（不让整份会话变空）
    }
    if (!message || typeof message !== 'object') return
    const m = message as ClineMessage
    summary.messageCount += 1
    if (m.role === 'user') {
      const text = userTextOfCline(m.content)
      if (!text) return
      if (summary.firstUser === undefined) summary.firstUser = text
      summary.lastUser = text
      return
    }
    if (m.role !== 'assistant' || !m.metrics) return
    const cacheRead = num(m.metrics.cacheReadTokens)
    const cacheWrite = num(m.metrics.cacheWriteTokens)
    // AI SDK 的 inputTokens 已含 cache → 扣掉，避免重复计
    const input = Math.max(0, num(m.metrics.inputTokens) - cacheRead - cacheWrite)
    const output = num(m.metrics.outputTokens)
    summary.usage.input += input
    summary.usage.output += output
    summary.usage.cacheRead += cacheRead
    summary.usage.cacheWrite += cacheWrite
    const model = m.modelInfo?.id ?? 'unknown'
    const bucket = summary.byModel[model] ?? emptyTokens()
    bucket.input += input
    bucket.output += output
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    summary.byModel[model] = bucket
  }

  try {
    for await (const chunk of stream) {
      scanned += chunk.length
      let i = 0
      if (phase === 'seek') {
        // 键可能跨 chunk：用 tail 拼一下再找 `"messages"` + 数组起点
        const tailLen = tail.length
        const combined = tail + chunk
        const hit = /"messages"\s*:\s*\[/.exec(combined)
        const at = hit && combined[hit.index - 1] !== '\\' ? hit : undefined
        if (!at) {
          tail = combined.slice(-24)
          if (maxChars !== undefined && scanned > maxChars) return summary
          continue
        }
        phase = 'body'
        // combined 里 `[` 之后的位置换算回 chunk 下标（tail 前缀不计）
        i = Math.max(0, at.index + at[0].length - tailLen)
        tail = ''
      }
      for (; i < chunk.length; i += 1) {
        const c = chunk[i] as string
        if (buf.length === 0) {
          if (c === ']') {
            phase = 'done'
            break
          }
          if (c === '{') {
            buf = '{'
            depth = 1
            inString = false
            escaped = false
          }
          continue // 元素之间的空白/逗号
        }
        buf += c
        if (inString) {
          if (escaped) escaped = false
          else if (c === '\\') escaped = true
          else if (c === '"') inString = false
          continue
        }
        if (c === '"') {
          inString = true
          continue
        }
        if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) {
            absorb(buf)
            buf = ''
            if (opts.stopAfterFirstUser && summary.firstUser !== undefined) {
              phase = 'done'
              break
            }
          }
        }
      }
      if (phase === 'done') break
      if (maxChars !== undefined && scanned > maxChars) return summary
    }
  } finally {
    stream.destroy()
  }
  return summary
}

export class ClineAdapter implements AiToolAdapter {
  readonly id = 'cline'

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

  private deps: ClineAdapterDeps
  private resolvedExe: string | null = null
  /** 只缓存摘要（firstUser/lastUser/messageCount/usage），不缓存正文；有上限、按 mtime 淘汰 */
  private summaryCache = new Map<string, { mtimeMs: number; size: number; summary: ClineSummary }>()
  /** 摘要缓存条数上限：菜单栏常驻进程的内存不能随 Cline 会话数无限增长 */
  private static readonly SUMMARY_CACHE_MAX = 256

  constructor(deps: ClineAdapterDeps = {}) {
    this.deps = deps
  }

  private sessionDir(): string {
    return this.deps.sessionDir ?? resolveClineSessionDir()
  }

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 cline 可执行文件（可设 TICK_CLINE_PATH）' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    this.resolvedExe ??= await findCliExecutable('cline')
    return this.resolvedExe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('Cline 未安装或不在 PATH（可设 TICK_CLINE_PATH）')
    return exe
  }

  private cachedSummary(session: ClineSession): ClineSummary | undefined {
    const cached = this.summaryCache.get(session.messagesPath)
    if (!cached || cached.mtimeMs !== session.mtimeMs || cached.size !== session.size) return undefined
    return cached.summary
  }

  /** 完整摘要（describe withName / computeUsage 用）：流式扫一遍并缓存 */
  private async fullSummaryOf(session: ClineSession): Promise<ClineSummary> {
    const cached = this.cachedSummary(session)
    if (cached) return cached
    const summary = await scanConversation(session.messagesPath).catch(emptySummary)
    this.summaryCache.set(session.messagesPath, { mtimeMs: session.mtimeMs, size: session.size, summary })
    this.pruneSummaryCache()
    return summary
  }

  /** 列表用：只扫到首条合格 user 文本就停；**不进缓存**（避免半份摘要污染用量） */
  private async firstUserOf(session: ClineSession): Promise<string | undefined> {
    const cached = this.cachedSummary(session)
    if (cached) return cached.firstUser
    const summary = await scanConversation(session.messagesPath, {
      stopAfterFirstUser: true,
      maxChars: LIST_SCAN_MAX_CHARS,
    }).catch(emptySummary)
    return summary.firstUser
  }

  /** 缓存超限时按 mtime 淘汰最旧的一半（近似 LRU：Cline 会话的 mtime 就是最近活跃时间） */
  private pruneSummaryCache(): void {
    if (this.summaryCache.size <= ClineAdapter.SUMMARY_CACHE_MAX) return
    const doomed = [...this.summaryCache.entries()]
      .sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)
      .slice(0, Math.floor(ClineAdapter.SUMMARY_CACHE_MAX / 2))
    for (const [key] of doomed) this.summaryCache.delete(key)
  }
  private findSession(id: string): ClineSession | undefined {
    return collectClineSessions(this.sessionDir()).find((s) => s.id === id)
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const session of collectClineSessions(this.sessionDir())) {
      const manifest = readClineManifest(session)
      if (!manifest.cwd || !path.isAbsolute(manifest.cwd)) continue
      const p = canonicalPath(manifest.cwd)
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
    for (const session of collectClineSessions(this.sessionDir())) {
      if (wantCwd) {
        const manifest = readClineManifest(session)
        if (!manifest.cwd || canonicalPath(manifest.cwd) !== wantCwd) continue
      }
      out.push({ toolId: this.id, sessionId: newCliSessionId(session.id) })
    }
    return out
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const session of collectClineSessions(this.sessionDir())) {
      const manifest = readClineManifest(session)
      // manifest.prompt 往往就是首条用户文案：有它就不必读正文（列表只取首条合格 user 文本即可）
      const firstUser = manifest.prompt ? undefined : await this.firstUserOf(session)
      const lastUsedAt = timeOf(manifest.endedAt) ?? session.mtimeMs
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(session.id),
        cwd: manifest.cwd ?? homedir(),
        name: manifest.title,
        // 用 `||` 而不是 `??`：manifest.prompt 可能是空串（readClineManifest 已归一，双保险）
        firstMessage: manifest.prompt || firstUser,
        createdAt: new Date(timeOf(manifest.startedAt) ?? session.mtimeMs).toISOString(),
        lastUsedAt,
        filePath: session.messagesPath,
        exists: existsSync(session.messagesPath),
        size: session.size,
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
    const manifest = readClineManifest(session)
    const withName = opts.withName !== false
    // 规则 §2：withName:false 只读 manifest，不得扫正文
    const summary = withName ? await this.fullSummaryOf(session) : undefined
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd: manifest.cwd ?? homedir(),
      name: withName ? manifest.title : undefined,
      firstMessage: withName ? manifest.prompt || summary?.firstUser : undefined,
      lastMessage: withName ? summary?.lastUser : undefined,
      createdAt: new Date(timeOf(manifest.startedAt) ?? session.mtimeMs).toISOString(),
      lastUsedAt: timeOf(manifest.endedAt) ?? session.mtimeMs,
      filePath: session.messagesPath,
      exists: existsSync(session.messagesPath),
      resumable: true,
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const session = this.findSession(id)
    if (!session) return undefined
    // 流式累加（不把 messages[] 整份留在内存/缓存里）
    const summary = await this.fullSummaryOf(session)
    const totals = summary.usage
    const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
    if (total === 0) return undefined
    const manifest = readClineManifest(session)
    return {
      tokens: { ...totals, totalTokens: total },
      // Cline 不报成本 → 只能显示 token
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      byModel: Object.entries(summary.byModel).map(([model, t]) => ({
        provider: manifest.provider ?? 'cline',
        model: model === 'unknown' ? (manifest.model ?? 'unknown') : model,
        tokens: { ...t, totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      })),
      messageCount: summary.messageCount,
      computedAt: Date.now(),
      costReported: false,
    }
  }

  async verify(): Promise<boolean> {
    return false
  }

  /**
   * CLI 没有草稿 API（`cline "<prompt>"` 会立刻发送，已实测）——走共享的 terminal-copy 实现：
   * 打开终端里的 Cline（新会话页），把文案放进剪贴板，由用户 ⌘V + 回车确认。
   * 不预生成 id、不绑定；发送后用「倒入历史会话」绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    return openTerminalCopyWithClipboard(ctx, {
      displayName: 'Cline',
      detect: () => this.detect(),
      requireExe: () => this.requireExe(),
      ...(this.deps.openTerminal ? { openTerminal: this.deps.openTerminal } : {}),
      ...(this.deps.clipboardWrite ? { clipboardWrite: this.deps.clipboardWrite } : {}),
    })
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('Cline 不能从 Tick 新建会话；请先在 Cline 里开始，再用「倒入历史会话」绑定。')
  }

  /** `cline --id <id>`（magpie 的 resumeCommand），在会话自己的 cwd 里运行 */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const session = this.findSession(sessionId)
    if (!session) throw new Error(`Cline 会话不存在：${sessionId}`)
    const exe = await this.requireExe()
    const manifest = readClineManifest(session)
    // cwd 必须是「真目录」：Cline 自己的 cwd 优先，其次 Tick 侧项目，最后 home
    const cwd = isExistingDirectory(manifest.cwd)
      ? manifest.cwd
      : isExistingDirectory(ctx.cwd)
        ? ctx.cwd
        : homedir()
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    await open({ cwd, executable: exe, args: ['--id', sessionId] })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }
}
