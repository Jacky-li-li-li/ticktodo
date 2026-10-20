/**
 * omp（oh-my-pi）适配器：目录与文件命名与 pi 完全相同，差异只有四处（magpie `omp.go` + 本机实测）：
 *
 *  1. **首行不是 header**：文件开头有一条定宽的 `{"type":"title",…,"pad":"   "}`，
 *     `{"type":"session",…}` 在它后面（实测第 2 行）。所以不能用 pi 的「只读首行」。
 *  2. 标题不在 header 里：首行物理 `title` 记录才是当前标题（定宽、可原地改写），
 *     `title_change` 只是 append-only 审计历史，仅在旧文件没有 title 记录时兜底。
 *  3. 子代理在会话目录旁（`<ts>_<id>/<agent>.jsonl`），不并入主会话。
 *
 * 其余全部复用 pi 的读取内核：`readSessionMeta`（首/末 user 文本）与
 * `computeUsageFromFile`（pi 形状的 usage；omp 的 `message.usage` 就是 pi 的形状，
 * 实测字段为 input/output/cacheRead/cacheWrite/totalTokens/cost）。
 *
 *  4. **cwd=~ 时 omp 会自动切到临时目录**（避免把整个 home 当项目）——实测从 Tick 在 `~`
 *     开会话时，header 里记的是 `/tmp`，于是会话被归到 `/tmp` 项目下（「仅当前项目」时看不到）。
 *     所以 cwd 恰好是 home 时要显式加 `--allow-home`。
 *
 * 只读：只读 `~/.omp/agent/sessions/**`（或 `OMP_HOME` 指向的根），不碰 `agent.db` 与本机配置。
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
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
import { canonicalPath, isExistingDirectory, newCliSessionId, openTerminalCopyWithClipboard } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import {
  computeUsageFromFile,
  findCliExecutable,
  readSessionMeta,
  toSessionTitle,
  type TerminalOpenSpec,
} from '@tick/ai-pi'

/** omp 的 agent 根：`OMP_HOME` > `~/.omp/agent`（`sessions/` 在其下） */
export function resolveOmpAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.OMP_HOME?.trim()
  return override ? path.join(path.resolve(override), 'agent') : path.join(home, '.omp', 'agent')
}

export interface OmpSessionFile {
  filePath: string
  sessionId: string
  mtimeMs: number
  size: number
}

/**
 * 主会话文件名：`<timestamp>_<uuid>.jsonl`（实测 `2026-07-05T07-34-22-509Z_019f3133-….jsonl`）。
 *
 * 为什么必须按文件名卡住：omp 把**子代理/子任务**的 transcript 写在会话目录里面
 * （`<sessions>/<cwd>/<ts>_<uuid>/<AgentName>.jsonl`，实测 8 个），它们没有
 * `<timestamp>_<uuid>` 前缀。之前只按「目录深度 + .jsonl」收集，把 109 个子代理文件
 * 当成会话列了出来（161 vs 52 条真会话）。
 */
const OMP_SESSION_FILE_RE = /^.+_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

/** 收集 `sessions/<cwd>/<ts>_<uuid>.jsonl`（子目录里的子代理 transcript 不收） */
export function collectOmpSessions(agentDir = resolveOmpAgentDir(), maxDepth = 2): OmpSessionFile[] {
  const root = path.join(agentDir, 'sessions')
  const out: OmpSessionFile[] = []
  const walk = (dir: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = path.join(dir, name)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1)
        continue
      }
      if (st.size === 0) continue // 0 字节 = 还没产生
      const hit = OMP_SESSION_FILE_RE.exec(name)
      if (!hit) continue // 子代理 transcript / 非会话文件
      out.push({ filePath: p, sessionId: hit[1] as string, mtimeMs: st.mtimeMs, size: st.size })
    }
  }
  walk(root, 0)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** 头部（会话 id / cwd / 版本）+ 标题：扫描前若干行，因为 header 未必是第一行 */
export interface OmpHeader {
  id?: string
  cwd?: string
  timestamp?: string
  /** 首行物理 `title` 记录优先；`title_change` 仅作旧文件兜底（见文件头第 2 条） */
  title?: string
}

const HEADER_SCAN_LINES = 8

/**
 * 会话创建时间：`session` 记录的 timestamp 必须是能解析的 ISO 才用，否则退回文件 mtime。
 * 与 codex/cline/grok 同口径——非法值不能让 `createdAt` 变成 Invalid Date / 1970 年。
 */
function isoOf(value: string | undefined, fallbackMs: number): string {
  if (value) {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return new Date(ms).toISOString()
  }
  return new Date(fallbackMs).toISOString()
}

export async function readOmpHeader(file: string): Promise<OmpHeader> {
  const header: OmpHeader = {}
  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let n = 0
  try {
    for await (const line of lines) {
      if (!line) continue
      if (n++ > 400) break // 新格式首行就是物理 title；只有旧文件才需要往前找 title_change，给 400 行上限
      if (line.includes('"type":"session"')) {
        try {
          const parsed = JSON.parse(line) as { type?: string; id?: unknown; cwd?: unknown; timestamp?: unknown }
          if (parsed.type === 'session') {
            // 逐字段做运行时校验：JSON 里的类型不可信（timestamp 写成数字/坏串会让
            // createdAt 变成 Invalid Date，污染列表排序与时间线）
            if (typeof parsed.id === 'string' && parsed.id) header.id = parsed.id
            if (typeof parsed.cwd === 'string' && parsed.cwd) header.cwd = parsed.cwd
            if (typeof parsed.timestamp === 'string' && parsed.timestamp) header.timestamp = parsed.timestamp
          }
        } catch {
          /* 坏行忽略 */
        }
        continue
      }
      if (line.includes('"title_change"') || line.includes('"type":"title"')) {
        try {
          const parsed = JSON.parse(line) as { type?: string; title?: string }
          const title = typeof parsed.title === 'string' && parsed.title ? parsed.title : undefined
          // 官方格式：物理 title 记录是「当前标题」，title_change 只是 append-only 审计历史。
          // 所以 title 记录一旦非空就以它为准，title_change 只作兜底（旧文件没有 title 记录）。
          if (parsed.type === 'title') {
            if (title) header.title = title
          } else if (parsed.type === 'title_change' && title && !header.title) {
            header.title = title
          }
        } catch {
          /* 坏行忽略 */
        }
        continue
      }
      // 找到 header 且已经有标题就可以停（后面的行不会再有 session header）
      if (header.id && header.title && n > HEADER_SCAN_LINES) break
    }
  } finally {
    stream.destroy()
  }
  return header
}

export interface OmpAdapterDeps {
  /** 剪贴板（CLI 预填：打开终端 + 文案进剪贴板） */
  clipboardWrite?: (text: string) => void
  /** 可执行文件定位（默认 findCliExecutable('omp')） */
  resolveExe?: () => Promise<string | null>
  /** 在终端里打开（main 注入） */
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** agent 根覆盖（测试隔离） */
  agentDir?: string
  /** home 覆盖（测试隔离；用于判断 cwd 是否就是 ~） */
  home?: string
}

export class OmpAdapter implements AiToolAdapter {
  readonly id = 'omp'

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    resumeSession: true,
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    // omp 不能预生成 id（`omp --resume` 只接受已有 id）→ 新建走 terminal-copy：
    // 打开终端里的 omp（argv 不带 prompt，带了会立刻发送）+ 文案进剪贴板
    newSessionMode: 'prefill',
    prefillDelivery: 'terminal-copy',
  }

  private deps: OmpAdapterDeps
  private resolvedExe: string | null = null
  private headerCache = new Map<string, { mtimeMs: number; size: number; header: OmpHeader }>()
  private usageCache = new Map<string, { mtimeMs: number; size: number; usage: SessionUsage }>()

  constructor(deps: OmpAdapterDeps = {}) {
    this.deps = deps
  }

  /**
   * cwd=~ 时 omp 默认会切到临时目录（`--allow-home` 才允许以 home 为项目）。
   * Tick 的项目模型是「cwd 就是项目」，不补这个 flag 会让新会话落到 `/tmp` 项目下。
   */
  private homeArgs(cwd: string | undefined): string[] {
    if (!cwd) return []
    const home = this.deps.home ?? homedir()
    return canonicalPath(cwd) === canonicalPath(home) ? ['--allow-home'] : []
  }

  private agentDir(): string {
    return this.deps.agentDir ?? resolveOmpAgentDir()
  }

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 omp 可执行文件（可设 TICK_OMP_PATH）' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    this.resolvedExe ??= await findCliExecutable('omp')
    return this.resolvedExe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('omp 未安装或不在 PATH（可设 TICK_OMP_PATH）')
    return exe
  }

  private async headerOf(file: OmpSessionFile): Promise<OmpHeader> {
    const cached = this.headerCache.get(file.filePath)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.header
    const header = await readOmpHeader(file.filePath).catch(() => ({}))
    this.headerCache.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size, header })
    return header
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const file of collectOmpSessions(this.agentDir())) {
      const header = await this.headerOf(file)
      if (!header.cwd || !path.isAbsolute(header.cwd)) continue
      const p = canonicalPath(header.cwd)
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: existsSync(p) }
      entry.sessionCount += 1
      if (entry.lastUsedAt === undefined || file.mtimeMs > entry.lastUsedAt) entry.lastUsedAt = file.mtimeMs
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
    for (const file of collectOmpSessions(this.agentDir())) {
      if (wantCwd) {
        const header = await this.headerOf(file)
        if (!header.cwd || canonicalPath(header.cwd) !== wantCwd) continue
      }
      out.push({ toolId: this.id, sessionId: newCliSessionId(file.sessionId) })
    }
    return out
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const file of collectOmpSessions(this.agentDir())) {
      const header = await this.headerOf(file)
      const meta = await readSessionMeta(file.filePath).catch(() => undefined)
      out.push({
        toolId: this.id,
        sessionId: newCliSessionId(file.sessionId),
        cwd: header.cwd ?? homedir(),
        name: header.title,
        firstMessage: toSessionTitle(meta?.firstUserText),
        createdAt: isoOf(header.timestamp, file.mtimeMs),
        lastUsedAt: file.mtimeMs,
        filePath: file.filePath,
        exists: true,
        size: file.size,
      })
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  private findFile(id: string): OmpSessionFile | undefined {
    return collectOmpSessions(this.agentDir()).find((f) => f.sessionId === id)
  }

  async describeSession(
    id: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    const file = this.findFile(id)
    if (!file) return undefined
    const header = await this.headerOf(file)
    const withName = opts.withName !== false
    const meta = withName ? await readSessionMeta(file.filePath).catch(() => undefined) : undefined
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      cwd: header.cwd ?? homedir(),
      name: withName ? header.title : undefined,
      firstMessage: withName ? toSessionTitle(meta?.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(meta?.lastUserText) : undefined,
      createdAt: isoOf(header.timestamp, file.mtimeMs),
      lastUsedAt: file.mtimeMs,
      filePath: file.filePath,
      exists: true,
      resumable: true,
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const file = this.findFile(id)
    if (!file) return undefined
    const cached = this.usageCache.get(file.filePath)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached.usage
    const usage = await computeUsageFromFile(file.filePath)
    if (usage) this.usageCache.set(file.filePath, { mtimeMs: file.mtimeMs, size: file.size, usage })
    return usage
  }

  async verify(): Promise<boolean> {
    return false
  }

  /**
   * CLI 没有草稿 API（启动参数会立刻发送，已实测）——走共享的 terminal-copy 实现：
   * 打开终端里的 omp（新会话页，cwd=~ 时补 `--allow-home`），把文案放进剪贴板，
   * 由用户 ⌘V + 回车确认。不预生成 id、不绑定；发送后用「倒入历史会话」绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    return openTerminalCopyWithClipboard(ctx, {
      displayName: 'omp',
      detect: () => this.detect(),
      requireExe: () => this.requireExe(),
      extraArgs: this.homeArgs(ctx.cwd),
      ...(this.deps.openTerminal ? { openTerminal: this.deps.openTerminal } : {}),
      ...(this.deps.clipboardWrite ? { clipboardWrite: this.deps.clipboardWrite } : {}),
    })
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error('omp 不能从 Tick 新建会话；请先在 omp 里开始，再用「倒入历史会话」绑定。')
  }

  /** `omp --resume <id>`（magpie 的 resumeCommand；有 profile 时先加 `--profile`） */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const file = this.findFile(sessionId)
    if (!file) throw new Error(`omp 会话不存在：${sessionId}`)
    const exe = await this.requireExe()
    const header = await this.headerOf(file)
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    const cwd = isExistingDirectory(header.cwd)
      ? header.cwd
      : isExistingDirectory(ctx.cwd)
        ? ctx.cwd
        : homedir()
    await open({ cwd, executable: exe, args: ['--resume', sessionId, ...this.homeArgs(cwd)] })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }
}
