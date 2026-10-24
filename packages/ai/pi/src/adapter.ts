/**
 * PiAdapter — @tick/ai-core 合同的第一份实装。
 *
 * 四条硬纪律（TECH-ARCH §6.2 / §7）：
 *  1. **交互式 TUI 必须开在终端里**：pi 用 `process.stdin/stdout.isTTY` 判定模式，非 TTY 会静默
 *     降级成 print（headless）模式——`spawn(..., {stdio:'ignore'})` 拉不出用户能继续用的 pi。
 *     所以这里只把「终端 + 命令」交给注入的 openTerminal（main 进程写 .command 脚本 + `open`）。
 *  2. argv 一律数组、无 shell 拼接；终端脚本由 main 侧做 POSIX 单引号转义后再交给 shell。
 *  3. verify() 绕缓存直读 + size===0 = 未产生（31 个 0 字节僵尸物证，D16）。
 *  4. 探测路径绝不用 pi 的 getDefaultSessionDir()（mkdirSync 副作用）。
 *
 * launch 语义（PRD F4）：
 *  - deliver='argv'：prompt 作为位置参数立即发送（pi 无「仅预填」模式，源码确认）；
 *  - deliver='clipboard'：prompt 进剪贴板（依赖注入 clipboardWrite，避免 ai/pi 反向依赖 Electron），
 *    argv 不带 prompt；'none' 同理不带 prompt。
 *  - sessionId 由调用方预生成（LaunchContext.sessionId），此处只做 uuid 字符集校验。
 *  - launch 只做一次**即时** verify；剪贴板模式下会话文件要等用户发送第一条消息才出现，
 *    因此返回 verified=false 是正常语义，由 LaunchService 写成 pending 绑定并在后台对账。
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
import {
  collectJsonlFiles,
  findSessionFilesById,
  readFirstLineHeader,
  readSessionMeta,
  resolveSessionRoots,
  toSessionTitle,
  type SessionMeta,
  type SessionRoot,
} from './paths'
import { computeUsageFromFile, inheritedEntriesOf } from './usage'

export const MIN_PI_VERSION = '1.3.0'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 交给 main 进程在终端里打开的命令（ai 包不依赖 Electron / Terminal） */
export interface TerminalOpenSpec {
  cwd: string
  executable: string
  args: string[]
  /** 需要随脚本 export 的环境变量（如 TICK_HOME：Tick 用自定义数据根时 extension 必须看到同一个根） */
  env?: Record<string, string>
}

export interface PiAdapterDeps {
  /** 剪贴板投递的出口（Electron main 注入 clipboard.writeText） */
  clipboardWrite?: (text: string) => void
  /** 可执行的查找（默认本机 PATH + 常见安装位置） */
  resolveExe?: () => Promise<string | null>
  /**
   * 在终端里打开 pi（必须注入；main 用 .command + open -a Terminal 实现）。
   * 测试可注入 fake 来断言 argv，不会再真的起进程。
   */
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /** 会话根注入（测试隔离） */
  sessionRoots?: () => SessionRoot[]
}

interface DetectResult {
  installed: boolean
  version?: string
  reason?: string
}

export class PiAdapter implements AiToolAdapter {
  readonly id = 'pi'

  readonly capabilities = {
    needsCwd: true,
    resumeSession: true,
    deliverPrompt: ['argv', 'clipboard'] as DeliverMode[],
    setSessionName: true,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
  }

  readonly carry: CarryCapability = {
    acceptFrom: [{ format: 'pi', via: 'fork' }],
    exposes: [{ format: 'pi' }],
  }

  private deps: PiAdapterDeps
  private resolvedExe: string | null = null
  private resolvedVersion: string | null = null
  /** 用量缓存：key=file，value 带 (mtime,size)，文件变了才重算 */
  private usageCache = new Map<string, { mtimeMs: number; size: number; usage: SessionUsage }>()
  /** name/first/last 元数据缓存：会话正文可能很大，文件没变就不重复流式扫 */
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>()

  constructor(deps: PiAdapterDeps = {}) {
    this.deps = deps
  }

  // ---------- 就绪探测 ----------

  async detect(): Promise<DetectResult> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 pi 可执行文件' }
    try {
      const version = await this.readVersion(exe)
      if (compareVersions(version, MIN_PI_VERSION) < 0) {
        return { installed: true, version, reason: `pi ${version} 低于要求的 ${MIN_PI_VERSION}，请升级` }
      }
      return { installed: true, version }
    } catch (e) {
      return { installed: false, reason: `pi 版本探测失败：${String((e as Error).message ?? e)}` }
    }
  }

  private async readVersion(exe: string): Promise<string> {
    if (this.resolvedVersion) return this.resolvedVersion
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)(exe, ['--version'])
    const version = stdout.trim().split(/\s+/).pop() ?? ''
    if (!version) throw new Error('pi --version 无输出')
    this.resolvedVersion = version
    return version
  }

  private async resolveExe(): Promise<string | null> {
    if (this.resolvedExe && existsSync(this.resolvedExe)) return this.resolvedExe
    if (this.deps.resolveExe) {
      const exe = await this.deps.resolveExe()
      this.resolvedExe = exe
      return exe
    }
    const custom = process.env.TICK_PI_PATH
    const candidates = [
      ...(custom ? [custom] : []),
      `${homedir()}/.npm-global/bin/pi`,
      '/usr/local/bin/pi',
      '/opt/homebrew/bin/pi',
      'pi', // PATH 兜底（dev 终端启动的进程通常带全 PATH）
    ]
    for (const candidate of candidates) {
      if (candidate.includes('/') && !existsSync(candidate)) continue
      try {
        const version = await this.readVersion(candidate)
        this.resolvedExe = candidate
        void version
        return candidate
      } catch {
        continue
      }
    }
    return null
  }

  // ---------- 会话目录 ----------

  /** 会话根（多来源），project-index 复用同一解析与 (size,mtime) 缓存决策面 */
  sessionRoots(): SessionRoot[] {
    if (this.deps.sessionRoots) return this.deps.sessionRoots()
    return resolveSessionRoots()
  }

  private roots(): SessionRoot[] {
    return this.sessionRoots()
  }

  /**
   * 项目发现（F3）：扫所有根 → size>0 → 首行 header.cwd → canonical 归并证据。
   * 只读首行，不碰正文。0 字节僵尸与无 header 文件直接跳过。
   */
  async discoverProjects(): Promise<ProjectSource['projects']> {
    const byPath = new Map<
      string,
      { sessionCount: number; lastUsedAt?: number; exists: boolean }
    >()
    for (const root of this.roots()) {
      for (const file of await collectJsonlFiles(root.dir)) {
        let st
        try {
          st = statSync(file)
        } catch {
          continue
        }
        if (st.size === 0) continue // 僵尸（D16）
        const header = readFirstLineHeader(file)
        if (!header?.cwd) continue
        const p = canonicalPath(header.cwd)
        if (!path.isAbsolute(p)) continue
        let entry = byPath.get(p)
        if (!entry) {
          entry = { sessionCount: 0, exists: existsSync(p) }
          byPath.set(p, entry)
        }
        entry.sessionCount += 1
        const mt = st.mtimeMs
        if (entry.lastUsedAt === undefined || mt > entry.lastUsedAt) entry.lastUsedAt = mt
      }
    }
    return [...byPath.entries()].map(([p, e]) => ({
      path: p,
      sessionCount: e.sessionCount,
      lastUsedAt: e.lastUsedAt,
      exists: e.exists,
    }))
  }

  /** 会话列举：全部有效会话（cwd 过滤可选），mtime 降序 */
  async listSessions(cwd?: string): Promise<SessionRef[]> {
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    const out: { ref: SessionRef; mtime: number }[] = []
    for (const root of this.roots()) {
      for (const file of await collectJsonlFiles(root.dir)) {
        try {
          if (statSync(file).size === 0) continue
        } catch {
          continue
        }
        const header = readFirstLineHeader(file)
        if (!header?.cwd || !header.id) continue
        if (wantCwd && canonicalPath(header.cwd) !== wantCwd) continue
        try {
          const mtime = statSync(file).mtimeMs
          out.push({ ref: { toolId: this.id, sessionId: newCliSessionId(header.id) }, mtime })
        } catch {
          continue
        }
      }
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.map((o) => o.ref)
  }

  /**
   * 会话列表（S5 / 多会话 UI）：一次扫描所有根，读 header + name/firstMessage。
   * 只取元数据，不缓存正文；0 字节僵尸与无 header 文件跳过（D16）。
   */
  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const root of this.roots()) {
      for (const file of await collectJsonlFiles(root.dir)) {
        let st
        try {
          st = statSync(file)
        } catch {
          continue
        }
        if (st.size === 0) continue
        const header = readFirstLineHeader(file)
        if (!header?.cwd || !header.id) continue
        const meta: SessionMeta = await this.sessionMeta(file, st.mtimeMs, st.size)
        out.push({
          toolId: this.id,
          sessionId: newCliSessionId(header.id),
          cwd: header.cwd,
          name: meta.name,
          firstMessage: toSessionTitle(meta.firstUserText),
          createdAt: header.timestamp ?? new Date(st.mtimeMs).toISOString(),
          lastUsedAt: st.mtimeMs,
          filePath: file,
          exists: true,
          parentSessionPath: header.parentSession,
          size: st.size,
        })
      }
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  /** name/first/last 元数据：按 (mtime,size) 缓存，文件没变就不重复扫正文 */
  private async sessionMeta(file: string, mtimeMs: number, size: number): Promise<SessionMeta> {
    const cached = this.metaCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.meta
    try {
      const meta = await readSessionMeta(file)
      this.metaCache.set(file, { mtimeMs, size, meta })
      return meta
    } catch {
      // 读失败（文件正被截断/重写）不缓存：缓存空 meta 会让 name/lastMessage 在文件
      // 下次变化前一直是空的（缓存投毒）
      return {}
    }
  }

  /** 单会话元数据（含 name/lastMessage —— 流式扫，按 mtime 缓存） */
  async describeSession(id: string, opts: { withName?: boolean } = {}): Promise<SessionInfo | undefined> {
    const file = await this.findFile(id)
    if (!file) return undefined
    let st
    try {
      st = statSync(file)
    } catch {
      return undefined
    }
    if (st.size === 0) return undefined
    let header
    try {
      header = readFirstLineHeader(file)
    } catch {
      return undefined
    }
    if (!header) return undefined
    // name/first/lastMessage 需要全量扫；调用方只要 cwd 时（withName:false）别白读 MB 级正文
    const meta: SessionMeta = opts.withName === false ? {} : await this.sessionMeta(file, st.mtimeMs, st.size)
    return {
      toolId: this.id,
      sessionId: newCliSessionId(header.id ?? id),
      cwd: header.cwd ?? homedir(),
      name: meta.name,
      firstMessage: toSessionTitle(meta.firstUserText),
      lastMessage: toSessionTitle(meta.lastUserText),
      createdAt: header.timestamp ?? new Date(st.mtimeMs).toISOString(),
      lastUsedAt: st.mtimeMs,
      filePath: file,
      exists: true,
      resumable: true,
      hasLocalFiles: true,
      parentSessionPath: header.parentSession,
    }
  }

  /** 单会话用量（F6-b；默认关，UI 打开且设置开启时才调） */
  async computeUsage(id: string): Promise<SessionUsage | undefined> {
    const file = await this.findFile(id)
    if (!file) return undefined
    let st
    try {
      st = statSync(file)
    } catch {
      return undefined
    }
    if (st.size === 0) return undefined
    const cached = this.usageCache.get(file)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.usage
    const header = readFirstLineHeader(file)
    const usage = computeUsageFromFile(file, inheritedEntriesOf(header?.parentSession))
    if (usage) this.usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, usage })
    return usage
  }

  /**
   * launch 后校验：绕一切缓存直读文件系统；
   * size===0（或文件从未出现）= 未产生。轻量轮询吸收「pi 刚写 header」竞态。
   */
  async verify(
    sessionId: string,
    opts: { retries?: number; intervalMs?: number } = {},
  ): Promise<boolean> {
    const retries = opts.retries ?? 4
    const intervalMs = opts.intervalMs ?? 700
    for (let i = 0; i <= retries; i++) {
      const file = await this.findFile(sessionId)
      if (file) {
        try {
          if (statSync(file).size > 0) return true
        } catch {
          /* 文件看过一眼就没了：继续等 */
        }
      }
      if (i < retries) await delay(intervalMs)
    }
    return false
  }

  private async findFile(sessionId: string): Promise<string | undefined> {
    const hits = await findSessionFilesById(sessionId, this.roots())
    return hits[0]
  }

  // ---------- 拉起 ----------

  async launch(ctx: LaunchContext): Promise<LaunchResult> {
    const exe = await this.requireExe()
    const sessionId = ctx.sessionId
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`sessionId 必须是 UUID，收到「${sessionId}」`)
    }
    const cwd = ctx.cwd || homedir()
    if (!existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`)

    const deliver: LaunchResult['delivered'] =
      ctx.deliver === 'argv' ? 'argv' : ctx.deliver === 'clipboard' ? 'clipboard' : 'none'
    if (deliver === 'clipboard' && !this.deps.clipboardWrite) {
      throw new Error('clipboard 投递需要注入 clipboardWrite（main 进程装配）')
    }

    // pi 位置参数 = 启动消息，放最前（RESEARCH-pi §「CLI trips」）；
    // 起头为 '-' / '@' 的消息会被当 flag / @file —— 直接拒绝并提示改剪贴板
    const prompt = ctx.promptText
    const argv: string[] = []
    if (deliver === 'argv') {
      if (!prompt.trim()) throw new Error('argv 投递需要非空 promptText')
      if (prompt.startsWith('-') || prompt.startsWith('@')) {
        throw new Error('消息不能以 "-" 或 "@" 开头（会被 pi 当作 flag / 文件参数）；请改用剪贴板投递')
      }
      argv.push(prompt)
    }
    argv.push('--session-id', sessionId)
    if (ctx.name?.trim()) argv.push('--name', ctx.name.trim().slice(0, 80))

    await this.openTerminal(cwd, exe, argv)
    // 剪贴板在终端确实打开后才写：open 失败时不清掉用户剪贴板里的原内容
    if (deliver === 'clipboard') this.deps.clipboardWrite?.(prompt)
    // 新造的 UUID 此刻不可能已有会话文件，不做即时 verify（死代码）；
    // 剪贴板/argv 两种投递都靠 LaunchService 的 pending 绑定 + 后台对账收敛
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: deliver,
      verified: false,
    }
  }

  async resume(sessionId: string, ctx: LaunchContext): Promise<LaunchResult> {
    // resume 前确认文件还在（业务规则：删除 todo 保留绑定，但会话文件可能已被手删）
    const file = await this.findFile(sessionId)
    if (!file) {
      throw new Error(`无法 resume：session 文件不存在（${sessionId}）`)
    }
    const exe = await this.requireExe()
    const header = readFirstLineHeader(file)
    // resume 的 cwd 必须来自会话自身 header（工具侧权威值）；renderer 选过的项目不能覆盖它，
    // 否则 pi 会按「当前 cwd 的项目目录」找不到 session，转而在新 cwd 下静默新建一个同 id 会话。
    const sessionCwd = header?.cwd && existsSync(header.cwd) ? header.cwd : undefined
    const fallbackCwd = ctx.cwd && existsSync(ctx.cwd) ? ctx.cwd : homedir()
    const cwd = sessionCwd ?? fallbackCwd

    // 用 --session <绝对路径> 而不是 --session-id：直接打开文件，不依赖 cwd 的项目目录解析
    await this.openTerminal(cwd, exe, ['--session', file])
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }

  private async requireExe(): Promise<string> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('pi 未安装或不在 PATH（可设 TICK_PI_PATH）')
    return exe
  }

  private async openTerminal(cwd: string, executable: string, args: string[]): Promise<void> {
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    await open({ cwd, executable, args })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
