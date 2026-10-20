/**
 * CodexAdapter — Codex CLI / Codex Desktop 的会话适配器（toolId = `codex`）。
 *
 * 关键事实（magpie + 本机 151 个 rollout / 147 个 thread 实测）：
 *  - 一个 thread（= 一个会话）可能写在**多个** rollout 文件里（文件名 `_<segment>` 后缀），
 *    所以列表要按 thread id 归并；`SessionSummary.files` 保留全部正文文件。
 *  - **没有**「预生成会话 id」的能力（Codex 自己生成 id）→ `newSessionMode='prefill'` +
 *    `prefillDelivery='terminal-copy'`：只能「打开终端里的 Codex + 文案进剪贴板」，
 *    **不能**从 Tick 新建并绑定 id；发送后走「倒入历史会话」绑定。
 *  - 回到会话：`codex resume <threadId>`，cwd 用会话自己的 cwd（magpie 同样是先 cd 再 resume）。
 *  - 用量：`token_count` 的 `total_token_usage` 是累计值，且 `input_tokens` 已含 cache →
 *    `input` 要扣掉 `cached_input_tokens` + `cache_write_input_tokens`（magpie `spent()` 同口径）。
 *  - 归档会话（`archived_sessions/`）如实 `resumable=false`：Codex 自己归档过的会话不宜从 Tick 回跳。
 */

import { existsSync, statSync } from 'node:fs'
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
import { canonicalPath, isExistingDirectory, newCliSessionId, openTerminalCopyWithClipboard } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { findCliExecutable, type TerminalOpenSpec } from '@tick/ai-pi'
import {
  collectRollouts,
  groupThreads,
  readRolloutHeader,
  readRolloutMeta,
  resolveCodexHome,
  toSessionTitle,
  type CodexMeta,
  type CodexThread,
  type RolloutHeader,
} from './paths'

export interface CodexAdapterDeps {
  /** 剪贴板（terminal-copy 的「文案进剪贴板」；main 注入 clipboard.writeText） */
  clipboardWrite?: (text: string) => void
  /** 可执行文件定位（默认 findCliExecutable('codex')） */
  resolveExe?: () => Promise<string | null>
  /** 在终端里打开（main 注入；openNewSessionPage 与 resume 用） */
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** codex home 覆盖（测试隔离） */
  codexHome?: string
  /** 时钟（缓存 TTL，测试用） */
  now?: () => number
}

interface CachedMeta {
  mtimeMs: number
  size: number
  meta: CodexMeta
}

interface CachedHeader {
  mtimeMs: number
  size: number
  header: RolloutHeader
}

export class CodexAdapter implements AiToolAdapter {
  readonly id = 'codex'

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    resumeSession: true,
    // Codex 没有预填/直接发送的启动入口：这些位只表达合同能力，launch() 一律抛错
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    // 不能预生成 id → 不能从 Tick 新建并绑定；但仍可「打开终端里的 Codex + 文案进剪贴板」
    newSessionMode: 'prefill',
    prefillDelivery: 'terminal-copy',
  }

  private deps: CodexAdapterDeps
  private resolvedExe: string | null = null
  private metaCache = new Map<string, CachedMeta>()
  /** 只含 session_meta 的轻量缓存（withName:false / resume / 项目发现用，不读正文） */
  private headerCache = new Map<string, CachedHeader>()
  /** thread 归并结果的短缓存（列表页反复打开时不重复 readdir 全树） */
  private threadsCache?: { at: number; threads: CodexThread[] }

  constructor(deps: CodexAdapterDeps = {}) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private codexHome(): string {
    return this.deps.codexHome ?? resolveCodexHome()
  }

  // ---------- 就绪探测 ----------

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 codex 可执行文件（可设 TICK_CODEX_PATH）' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    this.resolvedExe ??= await findCliExecutable('codex')
    return this.resolvedExe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('Codex 未安装或不在 PATH（可设 TICK_CODEX_PATH）')
    return exe
  }

  // ---------- 会话枚举 ----------

  /** thread 列表（5s 缓存；归并是纯文件系统操作，成本在读 meta，不在这里） */
  private threads(force = false): CodexThread[] {
    const now = this.now()
    if (!force && this.threadsCache && now - this.threadsCache.at < 5_000) {
      return this.threadsCache.threads
    }
    const threads = groupThreads(collectRollouts(this.codexHome()))
    this.threadsCache = { at: now, threads }
    return threads
  }

  private async metaOf(thread: CodexThread): Promise<CodexMeta> {
    // 一个 thread 的多个文件：按时间顺序把 meta 合并（首条取最早文件，末条取最新文件）
    let merged: CodexMeta = {}
    for (const file of thread.files) {
      const meta = await this.metaOfFile(file)
      merged = mergeMeta(merged, meta)
    }
    return merged
  }

  /** 每个 rollout 只读 session_meta（cwd / 起点 / provider），不扫正文 */
  private async headerOf(thread: CodexThread): Promise<RolloutHeader> {
    const merged: RolloutHeader = {}
    for (const file of thread.files) {
      let st
      try {
        st = statSync(file.filePath)
      } catch {
        continue
      }
      const cached = this.headerCache.get(file.filePath)
      let header: RolloutHeader
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        header = cached.header
      } else {
        header = await readRolloutHeader(file)
        this.headerCache.set(file.filePath, { mtimeMs: st.mtimeMs, size: st.size, header })
      }
      merged.sessionId ??= header.sessionId
      merged.cwd ??= header.cwd
      merged.modelProvider ??= header.modelProvider
      if (header.createdAt !== undefined && (merged.createdAt === undefined || header.createdAt < merged.createdAt)) {
        merged.createdAt = header.createdAt
      }
    }
    return merged
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const thread of this.threads()) {
      // 只要 cwd：走 session_meta 快路径，不把整份 rollout 读一遍
      const header = await this.headerOf(thread)
      const cwd = header.cwd
      if (!cwd || !path.isAbsolute(cwd)) continue
      const p = canonicalPath(cwd)
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: false }
      entry.sessionCount += 1
      if (entry.lastUsedAt === undefined || thread.latest.mtimeMs > entry.lastUsedAt) {
        entry.lastUsedAt = thread.latest.mtimeMs
      }
      byPath.set(p, entry)
    }
    return [...byPath.entries()].map(([p, entry]) => ({
      path: p,
      sessionCount: entry.sessionCount,
      lastUsedAt: entry.lastUsedAt,
      exists: existsSync(p),
    }))
  }

  async listSessions(cwd?: string): Promise<SessionRef[]> {
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    const out: SessionRef[] = []
    for (const thread of this.threads()) {
      if (wantCwd) {
        const header = await this.headerOf(thread)
        if (!header.cwd || canonicalPath(header.cwd) !== wantCwd) continue
      }
      out.push({ toolId: this.id, sessionId: newCliSessionId(thread.threadId) })
    }
    return out
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const thread of this.threads()) {
      const meta = await this.metaOf(thread)
      const files = thread.files.map((f) => f.filePath)
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(thread.threadId),
        cwd: meta.cwd ?? homedir(),
        // Codex 没有会话名（magpie 的 title 也只来自首条 prompt）→ 用首条 user 文本
        firstMessage: toSessionTitle(meta.firstUserText),
        createdAt: new Date(meta.firstUserAt ?? thread.files[0]?.mtimeMs ?? thread.latest.mtimeMs).toISOString(),
        lastUsedAt: meta.lastEventAt ?? thread.latest.mtimeMs,
        filePath: thread.latest.filePath,
        files,
        // exists 用扫描时的 stat 结果（rollout 已经 stat 过；缓存窗口内可能与磁盘有一点点滞后）
        exists: existsSync(thread.latest.filePath),
        // 归档会话（archived_sessions/）**有意**置 resumable=false：Codex 自己把它移出活跃列表后，
        // `codex resume <id>` 是否能命中没有实测（本机 4 条 archived，无 CLI 实验）。与其让 UI 提供
        // 一个可能失败/可能静默新建的入口，不如如实置灰（规则：不能假装定位成功）；用户在 Codex
        // 里 unarchive 之后，下一次扫描自然恢复可回。
        resumable: !thread.archived,
        size: thread.files.reduce((sum, f) => sum + f.size, 0),
      })
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  private threadById(id: string): CodexThread | undefined {
    return this.threads().find((thread) => thread.threadId === id)
  }

  async describeSession(
    id: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    const thread = this.threadById(id)
    if (!thread) return undefined
    const withName = opts.withName !== false
    // 规则 §2：withName:false 只读 header，不得扫全文（resume 前必调这条，长会话会线性退化）
    const meta: CodexMeta = withName ? await this.metaOf(thread) : {}
    const header = withName ? undefined : await this.headerOf(thread)
    const files = thread.files.map((f) => f.filePath)
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd: meta.cwd ?? header?.cwd ?? homedir(),
      name: undefined, // Codex 没有会话名
      firstMessage: withName ? toSessionTitle(meta.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(meta.lastUserText) : undefined,
      createdAt: new Date(
        // 快路径只有 session_meta 的 timestamp；全量扫还能更精确到首条 user
        meta.firstUserAt ?? header?.createdAt ?? thread.files[0]?.mtimeMs ?? thread.latest.mtimeMs,
      ).toISOString(),
      lastUsedAt: meta.lastEventAt ?? thread.latest.mtimeMs,
      filePath: thread.latest.filePath,
      files,
      exists: existsSync(thread.latest.filePath),
      // 同 listSessionInfos：归档会话如实不可回（有意收紧，见该处注释）
      resumable: !thread.archived,
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const thread = this.threadById(id)
    if (!thread) return undefined
    // 逐文件算「最后 total − 基线」，再相加：计数器按 thread 累计或按文件重新累计都对
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let model: string | undefined
    let provider: string | undefined
    for (const file of thread.files) {
      const meta = await this.metaOfFile(file)
      provider = meta.modelProvider ?? provider
      if (!meta.usage) continue
      totals.input += meta.usage.input
      totals.output += meta.usage.output
      totals.cacheRead += meta.usage.cacheRead
      totals.cacheWrite += meta.usage.cacheWrite
      model = meta.model ?? model
    }
    if (totals.input + totals.output + totals.cacheRead + totals.cacheWrite === 0) return undefined
    const tokens = { ...totals, totalTokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite }
    return {
      tokens,
      // Codex 的 rollout 不报成本 → 只能显示 token；costReported=false 表示「未上报」
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      byModel: [
        {
          // provider 来自 session_meta.model_provider；缺失才退回 openai（不能一律当 openai）
          provider: provider ?? 'openai',
          model: model ?? 'unknown',
          tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      ],
      messageCount: 0,
      computedAt: this.now(),
      costReported: false,
    }
  }

  private async metaOfFile(file: CodexThread['files'][number]): Promise<CodexMeta> {
    let st
    try {
      st = statSync(file.filePath)
    } catch {
      return {}
    }
    const cached = this.metaCache.get(file.filePath)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta
    const meta = await readRolloutMeta(file)
    this.metaCache.set(file.filePath, { mtimeMs: st.mtimeMs, size: st.size, meta })
    return meta
  }

  /** Codex 没有「launch 会新增会话」的通路（newSessionMode='prefill'）：verify 恒 false，
   *  如实表达「看不到会话产生」，不假装 true（合同允许返回 false）。 */
  async verify(): Promise<boolean> {
    return false
  }

  /**
   * CLI 没有草稿 API（`codex "<prompt>"` 会立刻开始会话，实测）——走共享的 terminal-copy 实现：
   * 打开终端里的 Codex（新会话页），把文案放进剪贴板，由用户 ⌘V + 回车确认。
   * 不预生成 id、不绑定；发送后用「倒入历史会话」绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    return openTerminalCopyWithClipboard(ctx, {
      displayName: 'Codex',
      detect: () => this.detect(),
      requireExe: () => this.requireExe(),
      ...(this.deps.openTerminal ? { openTerminal: this.deps.openTerminal } : {}),
      ...(this.deps.clipboardWrite ? { clipboardWrite: this.deps.clipboardWrite } : {}),
    })
  }

  // ---------- 拉起 / 回到会话 ----------

  /** 不能预生成 id → 不能从 Tick 新建（rules §2 的「无 id 能力」分支） */
  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('Codex 不能从 Tick 新建会话；请先在 Codex 里开始，再用「倒入历史会话」绑定。')
  }

  /**
   * 回到会话：`codex resume <threadId>`，在会话自己的 cwd 里运行。
   * （magpie 的 resumeCommand 也是 `cd <cwd> && codex resume <id>`。）
   */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const thread = this.threadById(sessionId)
    if (!thread) throw new Error(`Codex 会话不存在：${sessionId}`)
    const exe = await this.requireExe()
    // 只要 cwd：走 session_meta 快路径，不在回会话前扫正文
    const header = await this.headerOf(thread)
    const sessionCwd = isExistingDirectory(header.cwd) ? header.cwd : undefined
    const fallbackCwd = isExistingDirectory(ctx.cwd) ? ctx.cwd : homedir()
    const cwd = sessionCwd ?? fallbackCwd
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    await open({ cwd, executable: exe, args: ['resume', sessionId] })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }
}

/** 合并同一 thread 多个文件的 meta（首条取最早、末条取最新；用量按文件各自算，不在这里合并） */
function mergeMeta(into: CodexMeta, from: CodexMeta): CodexMeta {
  return {
    sessionId: into.sessionId ?? from.sessionId,
    cwd: into.cwd ?? from.cwd,
    modelProvider: into.modelProvider ?? from.modelProvider,
    model: from.model ?? into.model,
    firstUserText: into.firstUserText ?? from.firstUserText,
    lastUserText: from.lastUserText ?? into.lastUserText,
    firstUserAt: into.firstUserAt ?? from.firstUserAt,
    lastEventAt: Math.max(into.lastEventAt ?? 0, from.lastEventAt ?? 0) || undefined,
  }
}
