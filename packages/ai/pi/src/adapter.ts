/**
 * PiAdapter — @tick/ai-core 合同的第一份实装。
 *
 * 三条硬纪律（TECH-ARCH §6.2）：
 *  1. spawn 一律固定 argv 数组 + 去掉 ELECTRON_RUN_AS_NODE（WorkBuddy 宿主污染实证）；无 shell 拼接。
 *  2. verify() 绕缓存直读 + size===0 = 未产生（31 个 0 字节僵尸物证，D16）。
 *  3. 探测路径绝不用 pi 的 getDefaultSessionDir()（mkdirSync 副作用）。
 *
 * launch 语义（PRD F4）：
 *  - deliver='argv'：prompt 作为位置参数立即发送（pi 无「仅预填」模式，源码确认）；
 *  - deliver='clipboard'：prompt 进剪贴板（依赖注入 clipboardWrite，避免 ai/pi 反向依赖 Electron），
 *    argv 不带 prompt；'none' 同理不带 prompt。
 *  - sessionId 由调用方预生成（LaunchContext.sessionId），此处只做 uuid 字符集校验。
 */

import { spawn } from 'node:child_process'
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
} from '@tick/ai-core'
import { canonicalPath, newCliSessionId } from '@tick/ai-core'
import {
  collectJsonlFiles,
  findSessionFilesById,
  readFirstLineHeader,
  readSessionName,
  resolveSessionRoots,
  type SessionRoot,
} from './paths'

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

export interface PiAdapterDeps {
  /** 剪贴板投递的出口（Electron main 注入 clipboard.writeText） */
  clipboardWrite?: (text: string) => void
  /** 可执行的查找（默认本机 PATH + 常见安装位置） */
  resolveExe?: () => Promise<string | null>
  /** spawn 注入（测试 dry-run 用） */
  spawnImpl?: typeof spawn
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
    deliverPrompt: ['argv'] as DeliverMode[],
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
      for (const file of collectJsonlFiles(root.dir)) {
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
      for (const file of collectJsonlFiles(root.dir)) {
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

  /** 单会话元数据（含 name —— 需要流式扫 session_info 行，不缓存正文） */
  async describeSession(id: string): Promise<SessionInfo | undefined> {
    const file = this.findFile(id)
    if (!file) return undefined
    let header
    try {
      if (statSync(file).size === 0) return undefined
      header = readFirstLineHeader(file)
    } catch {
      return undefined
    }
    if (!header) return undefined
    let mtime: number | undefined
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      /* 已确认存在，mtime 失败罕见 */
    }
    const name = await readSessionName(file).catch(() => undefined)
    return {
      toolId: this.id,
      sessionId: newCliSessionId(header.id ?? id),
      cwd: header.cwd ?? homedir(),
      name,
      createdAt: header.timestamp ?? (mtime ? new Date(mtime).toISOString() : ''),
      lastUsedAt: mtime,
      exists: true,
      resumable: true,
      hasLocalFiles: true,
      parentSessionPath: header.parentSession,
    }
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
      const file = this.findFile(sessionId)
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

  private findFile(sessionId: string): string | undefined {
    const hits = findSessionFilesById(sessionId, this.roots())
    return hits[0]
  }

  // ---------- 拉起 ----------

  async launch(ctx: LaunchContext): Promise<LaunchResult> {
    return this.spawnSession(ctx, { resume: false })
  }

  async resume(sessionId: string, ctx: LaunchContext): Promise<LaunchResult> {
    // resume 前确认文件还在（业务规则：删除 todo 保留绑定，但会话文件可能已被手删）
    const file = this.findFile(sessionId)
    if (!file) {
      throw new Error(`无法 resume：session 文件不存在（${sessionId}）`)
    }
    return this.spawnSession({ ...ctx, sessionId: newCliSessionId(sessionId) }, { resume: true })
  }

  private async spawnSession(
    ctx: LaunchContext,
    opts: { resume: boolean },
  ): Promise<LaunchResult> {
    const exe = await this.resolveExe()
    if (!exe) throw new Error('pi 未安装或不在 PATH（可设 TICK_PI_PATH）')

    const sessionId = ctx.sessionId
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`sessionId 必须是 UUID，收到「${sessionId}」`)
    }

    if (ctx.cwd) {
      // cwd 只读校验；不存在 = CwdResolver 逻辑在 main，还没兜上 → 显式报错不静默
      if (!existsSync(ctx.cwd)) throw new Error(`cwd 不存在：${ctx.cwd}`)
    }

    const deliver = ctx.deliver === 'argv' ? 'argv' : ctx.deliver === 'clipboard' ? 'clipboard' : 'none'
    if (ctx.deliver === 'clipboard' && !this.deps.clipboardWrite) {
      throw new Error('clipboard 投递需要注入 clipboardWrite（main 进程装配）')
    }

    const argv: string[] = [exe]
    // pi 位置参数 = 启动消息，放最前（RESEARCH-pi §「CLI trips」）；
    // 起头为 '-' 的消息会被当 flag —— 用首段前置保护词避免（约定：加一层空格不可行，直接拒绝并提示改剪贴板）
    const prompt = ctx.promptText
    if (deliver === 'argv') {
      if (!prompt.trim()) throw new Error('argv 投递需要非空 promptText')
      if (prompt.startsWith('-')) {
        throw new Error('消息不能以 "-" 开头（会被 pi 当作命令行 flag）；请改用剪贴板投递')
      }
      argv.push(prompt)
    }
    if (opts.resume) argv.push('--session-id', sessionId)
    else argv.push('--session-id', sessionId)
    if (ctx.name?.trim()) argv.push('--name', ctx.name.trim().slice(0, 80))

    if (deliver === 'clipboard') {
      this.deps.clipboardWrite?.(prompt)
    }

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE // WorkBuddy 宿主污染实证：会让一切子进程变 run-as-node

    const spawnFn = this.deps.spawnImpl ?? spawn
    const child = spawnFn(argv[0] as string, argv.slice(1), {
      cwd: ctx.cwd || homedir(),
      detached: true,
      stdio: 'ignore',
      env,
    })
    child.unref()
    const pid = child.pid

    const verified = await this.verify(sessionId)
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd: ctx.cwd,
      pid,
      delivered: deliver,
      verified,
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
