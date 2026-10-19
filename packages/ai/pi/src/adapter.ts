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
 *  - deliver='prefill'：prompt 写一次性文件（不进 argv），pi 扩展在 session_start 读到后
 *    调 ctx.ui.setEditorText() 预填输入框；用户确认后自己回车，不自动发送；
 *  - deliver='argv'：prompt 作为位置参数立即发送；
 *  - deliver='clipboard'：prompt 进剪贴板（依赖注入 clipboardWrite，避免 ai/pi 反向依赖 Electron），
 *    argv 不带 prompt，仅作旧配置/降级兜底；'none' 同理不带 prompt。
 *  - sessionId 由调用方预生成（LaunchContext.sessionId），此处只做 uuid 字符集校验。
 *  - launch 只做一次**即时** verify；预填/剪贴板模式下会话文件要等用户发送第一条消息才出现，
 *    因此返回 verified=false 是正常语义，由 LaunchService 写成 pending 绑定并在后台对账。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
import { findCliExecutable } from './probe-exe'
import { computeUsageFromFile, inheritedEntriesOf } from './usage'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
/** 与 tick-extension 的读取上限保持一致；超限直接降级 clipboard，避免「写了但被删」 */
const PREFILL_MAX_BYTES = 200_000
/** 等扩展回执：session_start 正常 <2s；超时降级 clipboard 并如实提示 */
const PREFILL_ACK_TIMEOUT_MS = 3_000
/** 扩展 ack 的 reason 是稳定英文码；UI 文案统一映射成中文 */
const PREFILL_REASON_TEXT: Record<string, string> = {
  'too-large': '文案过长',
  'invalid-payload': '预填数据无效',
  'empty-prompt': '文案为空',
  'session-mismatch': '会话不匹配',
  'editor-unavailable': 'pi 输入框不可用',
  'set-editor-failed': 'pi 输入框写入失败',
  'read-failed': '读取预填文件失败',
  unknown: '未知原因',
}

/** 交给 main 进程在终端里打开的命令（ai 包不依赖 Electron / Terminal） */
export interface TerminalOpenSpec {
  cwd: string
  executable: string
  args: string[]
  /**
   * 追加到终端脚本的环境变量（键必须是合法 shell 变量名）。
   * 预填投递用 `TICK_LAUNCH_FILE` 把「一次性 prompt 文件」交给 pi 扩展：
   * prompt 不进 argv（ps 不可见、无 ARG_MAX 限制），扩展在 session_start 读取并预填输入框。
   */
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
  /**
   * 预填投递的一次性 prompt 文件目录（main 注入 cache/launch）。
   * 文件只含「待预填的文案」；pi 扩展在 session_start 读取后立即删除。
   */
  prefillDir?: string
  /** 等 pi 扩展回执的上限（测试注入小值；缺省 3s） */
  prefillAckTimeoutMs?: number
}

interface DetectResult {
  installed: boolean
  reason?: string
}

export class PiAdapter implements AiToolAdapter {
  readonly id = 'pi'

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    resumeSession: true,
    deliverPrompt: ['prefill', 'argv', 'clipboard'] as DeliverMode[],
    setSessionName: true,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    // pi 是 CLI：Tick 预生成 UUID 并传 --session-id；pi 也支持自生成 UUIDv7，
    // 但这里保留预生成 id 才能确定性地写 pending 绑定 / verify（不统一 id 生成方式）。
    newSessionMode: 'launch',
  }

  readonly carry: CarryCapability = {
    acceptFrom: [{ format: 'pi', via: 'fork' }],
    exposes: [{ format: 'pi' }],
  }

  private deps: PiAdapterDeps
  private resolvedExe: string | null = null
  /** 用量缓存：key=file，value 带 (mtime,size)，文件变了才重算 */
  private usageCache = new Map<string, { mtimeMs: number; size: number; usage: SessionUsage }>()
  /** name/first/last 元数据缓存：会话正文可能很大，文件没变就不重复流式扫 */
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>()

  constructor(deps: PiAdapterDeps = {}) {
    this.deps = deps
  }

  // ---------- 就绪探测 ----------

  /**
   * 只判「装没装」：可执行文件能定位到就算 installed。
   * 2026-10-19 起不再跑 `pi --version`、也不比较版本：版本差异交给真实调用去暴露，
   * 避免 UI 在工具选择处先把旧版本硬拦掉。
   */
  async detect(): Promise<DetectResult> {
    const exe = await this.resolveExe()
    if (!exe) return { installed: false, reason: '未检测到 pi 可执行文件' }
    return { installed: true }
  }

  private async resolveExe(): Promise<string | null> {
    if (this.resolvedExe && existsSync(this.resolvedExe)) return this.resolvedExe
    if (this.deps.resolveExe) {
      const exe = await this.deps.resolveExe()
      this.resolvedExe = exe
      return exe
    }
    // GUI（Finder）启动的 .app 拿不到用户 shell 的 PATH，硬编码几个前缀会漏安装位置：
    // 交给 probe-exe 先查常见前缀、再退回登录 shell 的 PATH（详见该文件头注释）。
    const exe = await findCliExecutable('pi')
    this.resolvedExe = exe
    return exe
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

  /**
   * 会话列表（S5 / 多会话 UI）：一次扫描所有根，读 header + name/firstMessage。
   * 只取元数据，不缓存正文；0 字节僵尸与无 header 文件跳过（D16）。
   */
  async listSessionInfos(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = []
    for (const root of this.roots()) {
      for (const file of collectJsonlFiles(root.dir)) {
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
    const meta = await readSessionMeta(file).catch(() => ({}))
    this.metaCache.set(file, { mtimeMs, size, meta })
    return meta
  }

  /** 单会话元数据（含 name/lastMessage —— 流式扫，按 mtime 缓存） */
  async describeSession(id: string, opts: { withName?: boolean } = {}): Promise<SessionInfo | undefined> {
    const file = this.findFile(id)
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
    const file = this.findFile(id)
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
    const exe = await this.requireExe()
    const sessionId = ctx.sessionId
    if (!UUID_RE.test(sessionId)) {
      throw new Error(`sessionId 必须是 UUID，收到「${sessionId}」`)
    }
    const cwd = ctx.cwd || homedir()
    if (!existsSync(cwd)) throw new Error(`cwd 不存在：${cwd}`)

    const deliver: LaunchResult['delivered'] =
      ctx.deliver === 'prefill'
        ? 'prefill'
        : ctx.deliver === 'argv'
          ? 'argv'
          : ctx.deliver === 'clipboard'
            ? 'clipboard'
            : 'none'
    if (deliver === 'clipboard' && !this.deps.clipboardWrite) {
      throw new Error('clipboard 投递需要注入 clipboardWrite（main 进程装配）')
    }

    const prompt = ctx.promptText
    const argv: string[] = []
    // 预填：文案不进 argv，写一次性文件交给 pi 扩展，在 session_start 填进输入框（不发送）
    let prefillFile: string | undefined
    let delivered: LaunchResult['delivered'] = deliver
    let notice: string | undefined
    if (deliver === 'prefill') {
      if (!prompt.trim()) throw new Error('prefill 投递需要非空 promptText')
      // 与扩展的 200KB 上限对齐：超限不写文件（写了也会被扩展删掉），直接落剪贴板
      if (Buffer.byteLength(prompt, 'utf8') > PREFILL_MAX_BYTES) {
        delivered = 'clipboard'
        notice = '文案过长（超过 200KB），已改为复制到剪贴板；请在 pi 里手动粘贴'
        this.deps.clipboardWrite?.(prompt)
      } else {
        prefillFile = this.writePrefillFile(sessionId, cwd, prompt)
      }
    }
    // argv 位置参数 = 启动即发送；起头 '-' / '@' 会被 pi 当 flag / @file（预填不受此限制）
    if (deliver === 'argv') {
      if (!prompt.trim()) throw new Error('argv 投递需要非空 promptText')
      if (prompt.startsWith('-') || prompt.startsWith('@')) {
        throw new Error('消息不能以 "-" 或 "@" 开头（会被 pi 当作 flag / 文件参数）；请改用预填投递')
      }
      argv.push(prompt)
    }
    argv.push('--session-id', sessionId)
    if (ctx.name?.trim()) argv.push('--name', ctx.name.trim().slice(0, 80))

    if (deliver === 'clipboard') this.deps.clipboardWrite?.(prompt)

    const ackFile = prefillFile ? `${prefillFile}.ack` : undefined
    const env = prefillFile
      ? { TICK_LAUNCH_FILE: prefillFile, ...(ackFile ? { TICK_LAUNCH_ACK: ackFile } : {}) }
      : undefined
    try {
      await this.openTerminal(cwd, exe, argv, env)
    } catch (err) {
      // 终端没接走：删掉 prompt 文件，避免把正文留在 cache 里
      if (prefillFile) rmSync(prefillFile, { force: true })
      if (ackFile) rmSync(ackFile, { force: true })
      throw err
    }

    if (prefillFile && ackFile) {
      // 等扩展回执：只有它确认 setEditorText 成功，才敢对 UI 说「已预填」。
      const ack = await this.waitForPrefillAck(ackFile, this.deps.prefillAckTimeoutMs ?? PREFILL_ACK_TIMEOUT_MS)
      if (!ack || ack.ok !== true) {
        // 扩展没装/旧版/文案被拒/输入框不可用：不能假成功，降级到剪贴板并如实说明
        rmSync(prefillFile, { force: true })
        rmSync(ackFile, { force: true })
        delivered = 'clipboard'
        notice = ack?.reason
          ? `预填未生效（${PREFILL_REASON_TEXT[ack.reason] ?? ack.reason}），已改为复制到剪贴板`
          : '预填未确认（pi 扩展未响应），已改为复制到剪贴板；请检查 tick-extension 是否已安装'
        this.deps.clipboardWrite?.(prompt)
      } else {
        // 扩展正常情况下已删正文；这里再兜一次，避免 ack 成功但正文残留
        rmSync(ackFile, { force: true })
        rmSync(prefillFile, { force: true })
      }
    }

    // 只做一次即时检查：预填/剪贴板都要等用户发送第一条消息，这里必然 false（正常）
    const verified = await this.verify(sessionId, { retries: 0, intervalMs: 0 })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered,
      verified,
      ...(notice ? { notice } : {}),
    }
  }

  /** 轮询扩展回执；ack 文件由扩展在 setEditorText 后写，atomic-ish 小文件 */
  private async waitForPrefillAck(
    ackFile: string,
    timeoutMs: number,
  ): Promise<{ ok?: boolean; reason?: string } | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const raw = JSON.parse(readFileSync(ackFile, 'utf8')) as { ok?: boolean; reason?: string }
        return raw
      } catch {
        await delay(50)
      }
    }
    return undefined
  }

  /**
   * 写「待预填文案」一次性文件。刻意用 0600 + 独立文件名：
   *  - 文案不进 argv（ps 不可见），也不走剪贴板（不污染用户剪贴板）；
   *  - 扩展在 session_start 读取后立刻删除；文件名带 sessionId，便于扩展核对不是别的会话。
   */
  private writePrefillFile(sessionId: string, cwd: string, promptText: string): string {
    const dir = this.deps.prefillDir
    if (!dir) throw new Error('prefill 投递需要注入 prefillDir（main 进程装配 cache/launch）')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // 上次 pi 没启动/扩展没跑成功时，正文会留在 cache；超过 1 小时的旧文件视为无主，清掉
    const staleBefore = Date.now() - 60 * 60 * 1000
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.prefill.json')) continue
        const old = path.join(dir, name)
        try {
          if (statSync(old).mtimeMs < staleBefore) rmSync(old, { force: true })
        } catch {
          /* 忽略：清理失败不阻塞这次拉起 */
        }
      }
    } catch {
      /* 目录不可读时交给后面的 writeFileSync 报错 */
    }
    const file = path.join(dir, `${sessionId}.prefill.json`)
    writeFileSync(
      file,
      JSON.stringify({ version: 1, mode: 'prefill', sessionId, cwd, promptText }),
      { encoding: 'utf8', mode: 0o600 },
    )
    return file
  }

  async resume(sessionId: string, ctx: LaunchContext): Promise<LaunchResult> {    // resume 前确认文件还在（业务规则：删除 todo 保留绑定，但会话文件可能已被手删）
    const file = this.findFile(sessionId)
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
  return new Promise((r) => setTimeout(r, ms))
}
