/**
 * ClaudeAdapter — Claude Code CLI 适配器（toolId = `claude`）。
 *
 * 与 pi 的关系：**同一类工具**（CLI、可在终端里拉起、可 resume、可用量），所以
 * launch/resume 的纪律完全照 `@tick/ai-pi`：交互式 TUI 必须开在终端里（非 TTY 会
 * 静默降级成 `-p` 打印模式），argv 一律数组，resume 用会话文件绝对路径 + header cwd。
 *
 * Claude Code 自己的一套事实（2026-10-19 实测 2.1.302，见 docs/claude-code-adapter-notes.md）：
 *  - 会话正文 `~/.claude/projects/<编码 cwd>/<uuid>.jsonl`，**没有首行 header**：
 *    cwd 来自第一条带 `cwd` 的记录（所以 listSessionInfos 必须流式扫，不能只读首行）。
 *  - `--session-id <uuid>` 可预生成 id（必须合法 UUID）；`--name <n>` 直接给会话起名
 *    （实测第一行就是 `custom-title`）。
 *  - **预填输入框有原生能力**：`--prefill=<text>`（2.1.302 实测：TUI 里文本已填好、
 *    没有 unknown option、不产生会话文件，等用户回车）。比 pi 的「扩展 + 一次性文件 +
 *    ack」简单得多，所以这里不做 ack 协议。
 *  - 直接发送 = 位置参数（`claude "prompt"`），起头 `-` 要用 `--` 分隔。
 *  - resume：`claude --resume <会话文件绝对路径>`（官方文档支持绝对路径，实测能接上原会话）；
 *    cwd 取会话自己的 cwd，**不接受** Tick 侧项目覆盖（否则 Claude 会在新目录里找不到会话）。
 *  - 桌面形态（Claude Desktop 的 Code tab）是**另一个独立工具**：`@tick/ai-claude-desktop`。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AiToolAdapter,
  CarryCapability,
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
import { findCliExecutable, type TerminalOpenSpec } from '@tick/ai-pi'
import {
  collectSessionFiles,
  findSessionFile,
  isDesktopEntrypoint,
  readSessionMeta,
  resolveSessionRoots,
  sessionTitleOf,
  sessionIdOfFile,
  toSessionTitle,
  type ClaudeSessionMeta,
  type ClaudeSessionRoot,
} from './paths'
import { computeUsageFromFile } from './usage'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface ClaudeAdapterDeps {
  /** 剪贴板投递出口（main 注入 clipboard.writeText；ai 包不依赖 Electron） */
  clipboardWrite?: (text: string) => void
  /** 可执行文件定位（默认 findCliExecutable('claude')；测试注入） */
  resolveExe?: () => Promise<string | null>
  /** 在终端里打开（必须注入；main 用 .command + open 实现） */
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** 会话根注入（测试隔离） */
  sessionRoots?: () => ClaudeSessionRoot[]
  /**
   * 安装门控：缺省 true（未安装时列表/项目/详情一律降级为空，rules §4）。
   * 置 false 只给「复用本内核读取、但安装状态由自己判」的适配器用（Claude Desktop 复用
   * 同一份 jsonl，装没装看的是 App bundle，不是 `claude` 可执行文件）。
   */
  gateOnDetect?: boolean
  /**
   * 列表/项目发现的 entrypoint 过滤。
   *
   * 为什么需要：Claude Desktop 的 Code tab 与 CLI **共用同一份 jsonl**，只靠文件系统分不开；
   * 区分依据是每条记录上的 `entrypoint`（Desktop 写 `claude-desktop` / `claude-desktop-3p`，
   * CLI 写 `cli`，SDK/print 写 `sdk-cli`）。缺省时 CLI 适配器排除 Desktop 会话，Desktop 适配器
   * 只收 Desktop 会话，否则同一会话会在「倒入历史会话」里出现两次。
   *
   * 只作用于列表/项目发现：按 id 直查（describeSession / verify / resume）不过滤，
   * 否则旧绑定会因为 entrypoint 缺失而变成「会话不存在」。
   */
  acceptEntrypoint?: (entrypoint: string | undefined) => boolean
  /**
   * 工具身份（「Claude 格式家族」的可配置位）。
   *
   * 为什么需要：Qoder（`qodercli` / `qoderclicn`）等工具**逐字段复用** Claude Code 的
   * `projects/<编码 cwd>/<id>.jsonl` 格式（user/assistant + Anthropic usage + `ai-title`/`summary`），
   * 只有数据根、可执行名、resume 参数与「能不能预生成 id」不同。把它们变成一组配置，
   * 就不用为每个工具复制一份解析器（这是 magpie 用同一个 `ccFiles`/`claudeFull` 的做法）。
   *
   * 缺省 = Claude Code 自己（行为与之前完全一致）。
   */
  identity?: ClaudeToolIdentity
}

/** 「Claude 格式家族」一个成员的固定身份 */
export interface ClaudeToolIdentity {
  /** toolId（写入 binding，必须稳定 kebab-case） */
  toolId: string
  /** 可执行文件名（`claude` / `qodercli` / `qoderclicn`） */
  exeName: string
  /**
   * resume 的 argv。默认 `['--resume', <会话文件绝对路径>]`（Claude Code 官方支持绝对路径，
   * 且不依赖 cwd）；只有 `--resume <id>` 的工具返回 `['--resume', id]`。
   */
  resumeArgs: (sessionId: string, filePath: string) => string[]
  /** 新建会话能力：支持 `--session-id` 的才是 `launch`，其它一律 `none`（只能倒入/回到会话） */
  newSessionMode: AiToolAdapter['capabilities']['newSessionMode']
  /** 是否支持 `--name`（Claude Code 支持；Qoder 未见证据 → false） */
  setSessionName: boolean
  /** 是否支持原生 `--prefill=` 预填（Qoder 未见证据 → 只有 argv/clipboard） */
  deliverPrompt: DeliverMode[]
}

/** Claude Code 自己的身份（缺省值） */
export const CLAUDE_IDENTITY: ClaudeToolIdentity = {
  toolId: 'claude',
  exeName: 'claude',
  // 官方支持 transcript 绝对路径：比 `--resume <id>` 更稳（不依赖 cwd 的项目目录解析）
  resumeArgs: (_sessionId, filePath) => ['--resume', filePath],
  newSessionMode: 'launch',
  setSessionName: true,
  deliverPrompt: ['prefill', 'argv', 'clipboard'],
}

interface DetectResult {
  installed: boolean
  reason?: string
}

export class ClaudeAdapter implements AiToolAdapter {
  readonly id: string

  readonly capabilities: AiToolAdapter['capabilities']

  readonly carry: CarryCapability

  private identity: ClaudeToolIdentity
  private deps: ClaudeAdapterDeps
  private resolvedExe: string | null = null
  /**
   * meta 缓存：文件 (mtime,size) 没变就不重扫（列表页反复打开）。
   * `partial = true` 表示只扫到 cwd 的轻量结果（withName:false），完整请求要重扫一次。
   */
  private metaCache = new Map<
    string,
    { mtimeMs: number; size: number; meta: ClaudeSessionMeta; partial: boolean }
  >()
  /** 用量缓存：同上口径 */
  private usageCache = new Map<string, { mtimeMs: number; size: number; usage: SessionUsage }>()

  constructor(deps: ClaudeAdapterDeps = {}) {
    this.deps = deps
    this.identity = deps.identity ?? CLAUDE_IDENTITY
    this.id = this.identity.toolId
    this.capabilities = {
      needsCwd: true,
      resumeSession: true,
      deliverPrompt: this.identity.deliverPrompt,
      setSessionName: this.identity.setSessionName,
      discoverProjects: true,
      describeSessions: true,
      usage: true,
      newSessionMode: this.identity.newSessionMode,
    }
    this.carry = {
      // 没有官方 fork 别的工具会话的入口；接受方向留空，不假装可行
      acceptFrom: [],
      exposes: [{ format: 'claude' }],
    }
  }

  // ---------- 就绪探测 ----------

  /**
   * 只判「装没装」：能定位到可执行的 `claude` 就算装。
   * 不跑 `claude --version`（GUI 最小 PATH 下 node 都可能不在，探测阶段不该依赖它），
   * 也不做版本门控（2026-10-19 起的统一口径）。
   */
  async detect(): Promise<DetectResult> {
    const exe = await this.resolveExe()
    if (!exe) {
      return {
        installed: false,
        reason: `未检测到 ${this.identity.exeName} 可执行文件（可设 TICK_${this.identity.exeName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PATH）`,
      }
    }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.resolvedExe && existsSync(this.resolvedExe)) return this.resolvedExe
    if (this.deps.resolveExe) {
      const exe = await this.deps.resolveExe()
      this.resolvedExe = exe
      return exe
    }
    // 复用 pi 的 GUI 定位器：常见前缀 → 进程 PATH → 登录 shell PATH 兜底
    const exe = await findCliExecutable(this.identity.exeName)
    this.resolvedExe = exe
    return exe
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error(`${this.identity.toolId} 未安装或不在 PATH（可设 TICK_${this.identity.exeName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PATH）`)
    return exe
  }

  /**
   * detect() 门控：未安装时不得让残留数据目录里的会话/项目进入列表（rules §4）。
   * 「未安装」与「没有会话」必须分开表达；detect 只做 exe 定位（有 TTL 缓存），成本可接受。
   */
  private async installed(): Promise<boolean> {
    if (this.deps.gateOnDetect === false) return true
    const detected = await this.detect().catch(() => ({ installed: false }))
    return detected.installed
  }

  // ---------- 会话目录 ----------

  sessionRoots(): ClaudeSessionRoot[] {
    if (this.deps.sessionRoots) return this.deps.sessionRoots()
    return resolveSessionRoots()
  }

  private roots(): ClaudeSessionRoot[] {
    return this.sessionRoots()
  }

  /**
   * 项目发现：扫 `projects/<project>/*.jsonl` → 读 cwd（流式到第一条带 cwd 的行）→ 证据。
   * 0 字节文件、读不到 cwd 的文件直接跳过（不猜目录名）。
   */
  async discoverProjects(): Promise<ProjectSource['projects']> {
    if (!(await this.installed())) return []
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const root of this.roots()) {
      for (const file of collectSessionFiles(root.dir)) {
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (stat.size === 0) continue
        const meta = await this.metaOf(file, stat.mtimeMs, stat.size)
        if (!this.acceptMeta(meta)) continue
        if (meta.idMismatch) continue
        if (!meta.cwd) continue
        const p = canonicalPath(meta.cwd)
        if (!path.isAbsolute(p)) continue
        const entry = byPath.get(p) ?? { sessionCount: 0, exists: existsSync(p) }
        entry.sessionCount += 1
        if (entry.lastUsedAt === undefined || stat.mtimeMs > entry.lastUsedAt) {
          entry.lastUsedAt = stat.mtimeMs
        }
        byPath.set(p, entry)
      }
    }
    return [...byPath.entries()].map(([p, entry]) => ({
      path: p,
      sessionCount: entry.sessionCount,
      lastUsedAt: entry.lastUsedAt,
      exists: entry.exists,
    }))
  }

  /** 会话列举（旧接口）：cwd 过滤可选 */
  async listSessions(cwd?: string): Promise<SessionRef[]> {
    if (!(await this.installed())) return []
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    const out: { ref: SessionRef; mtime: number }[] = []
    for (const root of this.roots()) {
      for (const file of collectSessionFiles(root.dir)) {
        const id = sessionIdOfFile(file)
        if (!id) continue
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (stat.size === 0) continue
        const meta = await this.metaOf(file, stat.mtimeMs, stat.size)
        if (!this.acceptMeta(meta)) continue
        if (meta.idMismatch) continue
        if (wantCwd && (!meta.cwd || canonicalPath(meta.cwd) !== wantCwd)) continue
        out.push({ ref: { toolId: this.id, sessionId: newCliSessionId(id) }, mtime: stat.mtimeMs })
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.map((o) => o.ref)
  }

  /** 会话列表（S5 / 多会话 UI）：一次扫描，读 cwd + 标题 + 首/末 user 文本 */
  async listSessionInfos(): Promise<SessionSummary[]> {
    if (!(await this.installed())) return []
    const out: SessionSummary[] = []
    for (const root of this.roots()) {
      for (const file of collectSessionFiles(root.dir)) {
        const id = sessionIdOfFile(file)
        if (!id) continue
        let stat
        try {
          stat = statSync(file)
        } catch {
          continue
        }
        if (stat.size === 0) continue
        const meta = await this.metaOf(file, stat.mtimeMs, stat.size)
        if (!this.acceptMeta(meta)) continue
        if (meta.idMismatch) continue
        out.push({
          toolId: this.id,
          sessionId: newCliSessionId(id),
          // cwd 未知时给空串（合同要求 string）：绝不塞 homedir() 把会话虚假归属到 ~
          cwd: meta.cwd ?? '',
          name: sessionTitleOf(meta),
          firstMessage: toSessionTitle(meta.firstUserText),
          createdAt: new Date(meta.firstUserAt ?? stat.birthtimeMs ?? stat.mtimeMs).toISOString(),
          lastUsedAt: meta.lastEventAt ?? stat.mtimeMs,
          filePath: file,
          exists: true,
          size: stat.size,
        })
      }
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  /**
   * meta 缓存：只按 (mtime,size) 失效；不缓存正文（meta 里也没有正文）。
   *
   * `light=true` = 扫到 cwd 即停（`withName:false` / resume 只要 cwd，不读标题/末条消息）；
   * 轻量结果命中不了完整请求（partial 标记），完整结果则可以直接服务轻量请求。
   */
  private async metaOf(
    file: string,
    mtimeMs: number,
    size: number,
    opts: { light?: boolean } = {},
  ): Promise<ClaudeSessionMeta> {
    const cached = this.metaCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size && (opts.light || !cached.partial)) {
      return cached.meta
    }
    const meta = await readSessionMeta(file, opts.light ? { stopAfterCwd: true } : {}).catch(() => ({}))
    this.metaCache.set(file, { mtimeMs, size, meta, partial: opts.light === true })
    return meta
  }

  /** entrypoint 过滤（只作用于列表/项目发现；按 id 直查不过滤） */
  private acceptMeta(meta: ClaudeSessionMeta): boolean {
    const accept = this.deps.acceptEntrypoint
    if (accept) return accept(meta.entrypoint)
    // 默认：CLI 适配器不列 Desktop 的 Code tab 会话（两者共用同一份 jsonl，靠 entrypoint 分）
    return !isDesktopEntrypoint(meta.entrypoint)
  }

  /**
   * 单会话元数据。`withName=false` 只回 cwd（LaunchService 推导 / pending 对账用），
   * 走「扫到 cwd 即停」的轻量读取，不扫全文；文件名的 id 与记录里的 sessionId 不一致时
   * 一律不当成这条会话（与 MCP locator 用同一判据：不猜）。
   */
  async describeSession(id: string, opts: { withName?: boolean } = {}): Promise<SessionInfo | undefined> {
    if (!(await this.installed())) return undefined
    const file = findSessionFile(id, this.roots())
    if (!file) return undefined
    let stat
    try {
      stat = statSync(file)
    } catch {
      return undefined
    }
    if (stat.size === 0) return undefined // 0 字节 = 还没产生（不变量 3）
    const withName = opts.withName !== false
    const meta = await this.metaOf(file, stat.mtimeMs, stat.size, withName ? {} : { light: true })
    if (meta.idMismatch) return undefined
    return {
      toolId: this.id,
      sessionId: newCliSessionId(id),
      // cwd 未知时给空串：resume 会退回调用方 cwd（adapter.resume 里的降级），不假装属于 ~
      cwd: meta.cwd ?? '',
      name: withName ? sessionTitleOf(meta) : undefined,
      firstMessage: withName ? toSessionTitle(meta.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(meta.lastUserText) : undefined,
      createdAt: new Date(meta.firstUserAt ?? stat.birthtimeMs ?? stat.mtimeMs).toISOString(),
      lastUsedAt: meta.lastEventAt ?? stat.mtimeMs,
      filePath: file,
      exists: true,
      resumable: true,
      hasLocalFiles: true,
    }
  }

  /** 单会话用量（F6-b；口径见 usage.ts） */
  async computeUsage(id: string): Promise<SessionUsage | undefined> {
    if (!(await this.installed())) return undefined
    const file = findSessionFile(id, this.roots())
    if (!file) return undefined
    let stat
    try {
      stat = statSync(file)
    } catch {
      return undefined
    }
    if (stat.size === 0) return undefined
    // 与 list/describe 同判据：文件名的 id 与记录里的 sessionId 不一致时不是这条会话，
    // 不能把它的用量算到这条会话上（light 读只扫到 sessionId/cwd，足够判 idMismatch）
    const meta = await this.metaOf(file, stat.mtimeMs, stat.size, { light: true })
    if (meta.idMismatch) return undefined
    const cached = this.usageCache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.usage
    // 单会话读取异常必须隔离成「无证据」：文件可能在 stat 之后被清理/无权限，
    // 不能让流的 error 冒成 IPC reject（rules §7）
    const usage = await computeUsageFromFile(file).catch(() => undefined)
    if (usage) this.usageCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, usage })
    return usage
  }

  /**
   * launch 后校验：绕缓存直读文件系统，size===0 不算产生。
   * 注意：`--prefill` 下会话文件要等用户回车才出现，这里必然 false —— 由 LaunchService
   * 写成 pending 绑定并在后台对账，这是正常语义。
   */
  async verify(
    sessionId: string,
    opts: { retries?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const retries = opts.retries ?? 4
    const intervalMs = opts.intervalMs ?? 700
    for (let i = 0; i <= retries; i++) {
      const file = findSessionFile(sessionId, this.roots())
      if (file) {
        try {
          if (statSync(file).size > 0) return true
        } catch {
          /* 看过一眼就没了：继续等 */
        }
      }
      if (i < retries) await delay(intervalMs)
    }
    return false
  }

  // ---------- 拉起 ----------

  async launch(ctx: LaunchContext): Promise<LaunchResult> {
    // 只有支持预生成 id 的工具才能走 launch（Qoder 这类只有 --resume 的工具是 'none'）
    if (this.identity.newSessionMode !== 'launch') {
      throw new Error(`${this.id} 不支持从 Tick 新建会话；请先在工具里开始，再用「倒入历史会话」绑定。`)
    }
    const exe = await this.requireExe()
    const sessionId = ctx.sessionId
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`sessionId 必须是 UUID，收到「${sessionId}」`)
    }
    const cwd = ctx.cwd || homedir()
    if (!existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`)

    const supported = this.capabilities.deliverPrompt
    const deliver: LaunchResult['delivered'] =
      ctx.deliver === 'prefill' && supported.includes('prefill')
        ? 'prefill'
        : ctx.deliver === 'argv' && supported.includes('argv')
          ? 'argv'
          : ctx.deliver === 'clipboard'
            ? 'clipboard'
            : 'none'
    if (deliver === 'clipboard' && !this.deps.clipboardWrite) {
      throw new Error('clipboard 投递需要注入 clipboardWrite（main 进程装配）')
    }

    const prompt = ctx.promptText ?? ''
    const argv: string[] = ['--session-id', sessionId]
    if (ctx.name?.trim() && this.identity.setSessionName) argv.push('--name', ctx.name.trim().slice(0, 80))

    if (deliver === 'prefill') {
      if (!prompt.trim()) throw new Error('prefill 投递需要非空 promptText')
      // 原生预填：文案进 argv（`--prefill=` 单参数），TUI 启动后已填在输入框里，用户回车才发送。
      // 超长文案由 argv 的 ARG_MAX 兜底（macOS 单参数上限 ~256KB），超过就明确失败而不是截断用户内容。
      if (Buffer.byteLength(prompt, 'utf8') > 200_000) {
        throw new Error(`文案过长（超过 200KB），${this.id} 无法作为启动参数预填；请改用剪贴板投递`)
      }
      argv.push(`--prefill=${prompt}`)
    } else if (deliver === 'argv') {
      if (!prompt.trim()) throw new Error('argv 投递需要非空 promptText')
      // 位置参数 = 启动即发送；起头 '-' 会被当成 flag，用 `--` 分隔
      if (prompt.startsWith('-')) argv.push('--')
      argv.push(prompt)
    } else if (deliver === 'clipboard') {
      if (!prompt.trim()) throw new Error('clipboard 投递需要非空 promptText')
      this.deps.clipboardWrite?.(prompt)
    }

    await this.openTerminal(cwd, exe, argv)

    // 即时检查一次：预填/剪贴板下必然 false（等用户回车），正常
    const verified = await this.verify(sessionId, { retries: 0, intervalMs: 0 })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: deliver,
      verified,
    }
  }

  /**
   * 回到会话：`claude --resume <会话文件绝对路径>`。
   * cwd 用会话自己的 cwd（工具侧权威值）；会话文件不在时抛错（不猜、不新建）。
   */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const file = findSessionFile(sessionId, this.roots())
    // 文案用本工具的身份（`claude` / `qoder` / …）——这个内核被多个工具复用，
    // 写死「Claude Code」会让 Qoder 的错误提示指向别的工具。
    if (!file) throw new Error(`无法 resume：${this.id} 的会话文件不存在（${sessionId}）`)
    const exe = await this.requireExe()
    // resume 只需要会话自己的 cwd：走轻量读取（扫到 cwd 即停），不把大文件整份再扫一遍；
    // 与 describeSession(withName:false) 共用同一个 (mtime,size) 缓存
    let meta: ClaudeSessionMeta = {}
    try {
      const st = statSync(file)
      meta = await this.metaOf(file, st.mtimeMs, st.size, { light: true })
    } catch {
      /* stat 失败：退回调用方 cwd / homedir，terminal 会如实暴露 */
    }
    const sessionCwd = meta.cwd && existsSync(meta.cwd) ? meta.cwd : undefined
    const fallbackCwd = ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : homedir()
    const cwd = sessionCwd ?? fallbackCwd
    await this.openTerminal(cwd, exe, this.identity.resumeArgs(sessionId, file))
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }

  private async openTerminal(
    cwd: string,
    executable: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    await open({ cwd, executable, args, ...(env ? { env } : {}) })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
