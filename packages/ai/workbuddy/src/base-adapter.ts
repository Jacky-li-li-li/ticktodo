/**
 * base-adapter — 两个 WorkBuddy 发行版共享的适配器实现骨架。
 *
 * 分工（rules §1）：**存储内核共用**（同一套 sessions 表与 jsonl 格式），
 * **身份各自独立**（App bundle / bundle id / 数据根 / scheme / playground 策略）。
 * 所以这里只写「怎么读、怎么回到会话」，具体身份由子类通过 `WorkbuddyIdentity` 注入；
 * 两个发行版仍是两个独立适配器、两个 toolId、两份缓存，不互相复用配置。
 *
 * 合同要点：
 *  - 列表/项目发现只读 DB，不扫 jsonl（PRD P0-5、合同 §2）；
 *  - describeSession(withName:false) 只回 DB 元数据，不读消息流正文；
 *  - 只有 describeSession 才读 jsonl，并按 (mtime,size) 缓存；
 *  - 任何读取失败都降级为空/undefined + 一次日志，绝不向 UI 抛（rules §7）；
 *  - sessionId 用工具侧原始 UUID 经 newCliSessionId，不加工具前缀（rules §1）。
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  AiToolAdapter,
  DeliverMode,
  LaunchContext,
  LaunchResult,
  NewSessionPageContext,
  NewSessionPageResult,
  ProjectSource,
  SessionInfo,
  SessionSummary,
} from '@tick/ai-core'
import { newCliSessionId, SESSION_DIGEST_TEXT_MAX } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import {
  appBundleCandidates,
  infoPlistPath,
  readPlistString,
  resolveRootDir,
  resolveTranscript,
} from './paths'
import { readSessionRows } from './sqlite'
import { clipText, collapseText, readTranscriptMeta } from './transcript'
import type {
  WorkbuddyAdapterDeps,
  WorkbuddyDetectResult,
  WorkbuddyIdentity,
  WorkbuddyLog,
  WorkbuddySessionRow,
  WorkbuddyTranscriptMeta,
} from './types'

/** detect() 结果缓存：IPC 会反复问「装没装」，不能每次都去读 Info.plist */
const DETECT_TTL_MS = 30_000
/** 消息流缓存条数上限：超限直接清空（缓存只为 describeSession 的连续调用服务，不占内存） */
const TRANSCRIPT_CACHE_MAX = 500
/** 标题展示截断：PRD §9.4（空白折叠、超 160 字符截断，只影响展示） */
const NAME_MAX = 160
/** firstMessage 兼作标题回退，同标题阈值 */
const FIRST_MESSAGE_MAX = 160
/** lastMessage 是「上次停在哪」的证据；此上限只防 IPC 载荷失控，不是展示阈值 */
const LAST_MESSAGE_MAX = 2000

interface TranscriptCacheEntry {
  mtimeMs: number
  size: number
  meta: WorkbuddyTranscriptMeta
}

export abstract class WorkbuddyAdapterBase implements AiToolAdapter {
  readonly id: string

  /**
   * 桌面工具：不能由 Tick 预生成/发送会话；只能打开 GUI 新建页做 prefill。
   * 2026-10-19 起不再按版本门控（`taskVerifiedVersions` 已移除）：装了就开放「新建页」入口。
   */
  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: false,
    resumeSession: true,
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: false,
    newSessionMode: 'prefill',
  }

  protected readonly identity: WorkbuddyIdentity
  protected readonly deps: WorkbuddyAdapterDeps

  private detectCache?: { at: number; value: WorkbuddyDetectResult }
  /** key = 会话 jsonl 绝对路径；文件 (mtime,size) 变了才重扫 */
  private transcriptCache = new Map<string, TranscriptCacheEntry>()
  /** 同一原因只记一次日志（IPC 高频调用不刷屏） */
  private warned = new Set<string>()

  constructor(identity: WorkbuddyIdentity, deps: WorkbuddyAdapterDeps = {}) {
    this.identity = identity
    this.deps = deps
    this.id = identity.toolId
  }

  // ---------- 就绪探测 ----------

  async detect(): Promise<WorkbuddyDetectResult> {
    const now = this.now()
    const cached = this.detectCache
    if (cached && now - cached.at < DETECT_TTL_MS) return cached.value

    let value: WorkbuddyDetectResult
    try {
      value = await this.probeInstallation()
    } catch (e) {
      this.warnOnce('detect', `安装探测失败：${errorText(e)}`)
      value = { installed: false, reason: `${this.identity.displayName} 安装探测失败` }
    }
    this.detectCache = { at: this.now(), value }
    return value
  }

  /**
   * 安装判定只看 App bundle + Info.plist 的 CFBundleIdentifier（数据目录存在不算已安装：
   * 卸载残留、其他工具写配置都会留下目录，PRD §9.9 / §9B.7）。
   * 不再读版本号：2026-10-19 起移除版本探测，版本差异由真实调用失败如实暴露。
   */
  private async probeInstallation(): Promise<WorkbuddyDetectResult> {
    const candidates = appBundleCandidates(this.identity, this.deps)
    const expectedBundleId = this.identity.bundleId
    let sawBundle = false

    for (const bundle of candidates) {
      if (!existsSync(bundle)) continue
      sawBundle = true
      const plist = infoPlistPath(bundle)
      const bundleId = await readPlistString(plist, 'CFBundleIdentifier')
      if (bundleId !== expectedBundleId) {
        if (bundleId === undefined) this.warnOnce('plist', 'Info.plist 无法读取 CFBundleIdentifier')
        continue
      }
      return { installed: true }
    }

    return {
      installed: false,
      reason: sawBundle
        ? `检测到 ${this.identity.appBundleName} 但 bundle id 不是 ${expectedBundleId}`
        : `未检测到 ${this.identity.appBundleName}（期望 bundle id ${expectedBundleId}）`,
    }
  }

  // ---------- 会话列表 / 项目证据（只读 DB） ----------

  /**
   * 工具未安装时静默禁用（PRD §9.9 / §9B.7）：数据目录可能是卸载残留（别的工具也会往里写配置），
   * 只凭 `workbuddy.db` 存在不能当作「这个工具在用」。detect 自带 30s 缓存，读取路径上代价可忽略。
   */
  private async installedNow(): Promise<boolean> {
    const detected = await this.detect().catch(() => undefined)
    return detected?.installed === true
  }

  /** 会话列表：DB 一条查询，不扫 jsonl；filePath 用 DB cwd 编码推出，exists 是 stat 事实 */
  async listSessionInfos(): Promise<SessionSummary[]> {
    if (!(await this.installedNow())) return []
    const rootDir = this.rootDir()
    const rows = await this.readRows(rootDir)
    const summaries: SessionSummary[] = []
    for (const row of rows) {
      const transcript = resolveTranscript(rootDir, row.cwd, row.id)
      summaries.push({
        toolId: this.id,
        sessionId: newCliSessionId(row.id),
        // DB cwd 为空/不绝对时，resolveTranscript 会用 <id>.meta.json 兜底（PRD §9.1）
        cwd: transcript.cwd ?? row.cwd,
        name: this.nameOf(row),
        createdAt: isoTimestamp(row.createdAt, row.updatedAt),
        lastUsedAt: this.usedAt(row),
        filePath: transcript.filePath,
        exists: transcript.exists,
        size: transcript.size,
        resumable: this.isResumable(row),
      })
    }
    summaries.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return summaries
  }

  /**
   * 项目发现：只吐原始证据（cwd / 会话数 / 最近时间）。
   * 不 canonicalize、不做 git 根上卷、不合并——归并是 core 的 mergeProjects 职责（rules §0/§2）。
   */
  async discoverProjects(): Promise<ProjectSource['projects']> {
    if (!(await this.installedNow())) return []
    const rootDir = this.rootDir()
    const rows = await this.readRows(rootDir)
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number }>()
    for (const row of rows) {
      // 非绝对路径的 cwd 不能直接当项目证据：先看 <id>.meta.json 能否兜底，仍不行就跳过
      const projectPath = path.isAbsolute(row.cwd)
        ? row.cwd
        : resolveTranscript(rootDir, row.cwd, row.id).cwd
      if (!projectPath || !path.isAbsolute(projectPath)) continue
      const entry = byPath.get(projectPath) ?? { sessionCount: 0 }
      entry.sessionCount += 1
      const usedAt = this.usedAt(row)
      if (usedAt !== undefined && (entry.lastUsedAt === undefined || usedAt > entry.lastUsedAt)) {
        entry.lastUsedAt = usedAt
      }
      byPath.set(projectPath, entry)
    }
    return [...byPath.entries()].map(([projectPath, entry]) => ({
      path: projectPath,
      sessionCount: entry.sessionCount,
      lastUsedAt: entry.lastUsedAt,
      exists: existsSync(projectPath),
    }))
  }

  // ---------- 单会话 ----------

  /**
   * 单会话元数据：DB 取有效行（id 不存在/已删除 → undefined），
   * `withName:false` 只回 DB 元数据；否则读 jsonl 拿首/末 user 消息与标题兜底。
   */
  async describeSession(
    sessionId: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    // 未安装 = 静默禁用：不把残留数据当作可展示/可绑定的会话（resume 另有「未安装」报错）
    if (!(await this.installedNow())) return undefined
    const rootDir = this.rootDir()
    const rows = await readSessionRows(rootDir, { log: this.log, id: sessionId })
    const row = rows.find((item) => item.id === sessionId)
    if (!row) return undefined

    const transcript = resolveTranscript(rootDir, row.cwd, row.id)
    let meta: WorkbuddyTranscriptMeta = {}
    if (
      opts.withName !== false &&
      transcript.exists &&
      transcript.mtimeMs !== undefined &&
      transcript.size !== undefined
    ) {
      meta = await this.transcriptMeta(transcript.filePath, transcript.mtimeMs, transcript.size)
    }

    // 完成状态：DB `sessions.status` 是首选（completed/active/error/Pending，逆向证据）；
    // 状态缺失时才回退到消息流末条 assistant 的 status。未知值一律当「不知道」，不猜 done。
    const toolStatus = row.status.trim().toLowerCase()
    const running = toolStatus === 'active'
    const endedCleanly =
      toolStatus === 'completed' || (toolStatus === '' && meta.lastAssistantStatus === 'completed')

    return {
      toolId: this.id,
      sessionId: newCliSessionId(row.id),
      cwd: transcript.cwd ?? row.cwd,
      name: this.nameOf(row) ?? clipText(collapseText(meta.title), NAME_MAX),
      firstMessage: clipText(collapseText(meta.firstUserText), FIRST_MESSAGE_MAX),
      lastMessage: clipText(collapseText(meta.lastUserText), LAST_MESSAGE_MAX),
      // 时间线证据（P0-1/P0-3）：原文 + 消息时间 + 事件时间 + 完成证据
      lastUserMessage: clipText(collapseText(meta.lastUserText), SESSION_DIGEST_TEXT_MAX),
      lastUserMessageAt: meta.lastUserAt,
      lastEventAt: meta.lastEventAt ?? row.lastActivityAt ?? row.updatedAt,
      endedCleanly: endedCleanly || undefined,
      running: running || undefined,
      createdAt: isoTimestamp(row.createdAt, row.updatedAt),
      lastUsedAt: this.usedAt(row),
      filePath: transcript.filePath || undefined,
      exists: transcript.exists,
      resumable: this.isResumable(row),
      hasLocalFiles: transcript.exists,
    }
  }

  // ---------- 拉起 / 回到会话 ----------

  /**
   * 打开 GUI 的「新建任务」页并预填文案 + 工作目录（内部 task 深链接）。
   *
   * 与 launch 的区别：不预生成 sessionId、不自动发送、不产生 Tick 绑定；发送仍由用户
   * 在 WorkBuddy 里完成，之后可用「倒入历史会话」绑定（PRD §9/§9B 的范围扩展）。
   *
   * 该协议是 App 内部实现、**没有官方公开规范**，已在本机 5.8.4 实测：
   * 会 goHome + 把 prompt 预填进输入框、把 cwd 当作工作空间；不新增 DB 会话。
   * 为了不把「打开失败」伪装成成功，openUrl 抛错会原样转成 reason。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    const detected = await this.detect()
    if (!detected.installed) {
      return { ok: false, reason: `${this.identity.displayName} 未安装，无法打开新建页` }
    }
    const openUrl = this.deps.openUrl
    if (!openUrl) return { ok: false, reason: '未注入 openUrl（main 进程需装配 shell.openExternal）' }

    const rawPrompt = (ctx.promptText ?? '').trim()
    if (!rawPrompt) return { ok: false, reason: '需要非空文案才能预填' }
    const cwd = (ctx.cwd ?? '').trim()
    if (!cwd || !path.isAbsolute(cwd)) return { ok: false, reason: '项目路径无效（需要绝对路径）' }
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { ok: false, reason: '项目路径不存在或不是目录' }
      }
    } catch {
      return { ok: false, reason: '项目路径不可读' }
    }

    // App 侧 prompt 上限 8000；但整条 URL 超过 ~6000 时部分平台可能唤不起来（renderer 原话）。
    // 手工 encodeURIComponent：空格编码为 %20（比 URLSearchParams 的 + 对第三方解析器更稳）。
    // 截断按 Unicode 码点，避免把 emoji/surrogate pair 劈成 �。
    const MAX_URL_LEN = 6000
    const build = (prompt: string): string =>
      `${this.identity.scheme}://task?action=start&prompt=${encodeURIComponent(prompt)}&cwd=${encodeURIComponent(cwd)}`
    const chars = Array.from(rawPrompt)
    let take = chars.length
    let url = build(chars.join(''))
    let truncated = false
    if (url.length > MAX_URL_LEN) {
      truncated = true
      take = Math.max(1, Math.floor(chars.length * (MAX_URL_LEN / url.length)) - 2)
      url = build(`${chars.slice(0, take).join('')}…`)
      while (url.length > MAX_URL_LEN && take > 0) {
        take = Math.max(0, take - 10)
        url = build(`${chars.slice(0, take).join('')}…`)
      }
    }
    if (url.length > MAX_URL_LEN) {
      return { ok: false, reason: '项目路径过长，无法安全打开新建页' }
    }

    try {
      await openUrl(url)
    } catch (e) {
      return { ok: false, reason: `打开 ${this.identity.displayName} 新建页失败：${errorText(e)}` }
    }
    return { ok: true, truncated }
  }

  /** 桌面工具没有任何「从 Tick 预生成并发送」的入口：直接抛错（rules §2、PRD §9） */
  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error(this.identity.launchErrorText)
  }

  /**
   * 回到会话：先校验 id 在 DB 且未删除/非 playground，再用深链接定位。
   * `open` 恒 exit 0，失败=停在应用首页（PRD §9.6 / §9B.6）→ 单次、不重试、不降级到另一 scheme。
   */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    const detected = await this.detect()
    if (!detected.installed) throw new Error(`${this.identity.displayName} 未安装，无法回到会话`)

    const rootDir = this.rootDir()
    const rows = await readSessionRows(rootDir, { log: this.log, id: sessionId })
    const row = rows.find((item) => item.id === sessionId)
    if (!row) throw new Error('会话不存在或已删除，无法回到会话')
    if (this.identity.playgroundUnresumable && row.isPlayground) {
      throw new Error(
        `${this.identity.displayName} 的 playground 会话深链接定位行为未验证，暂不支持从 Tick 回到该会话`,
      )
    }

    const openUrl = this.deps.openUrl
    if (!openUrl) throw new Error('未注入 openUrl（main 进程需装配 shell.openExternal）')
    await openUrl(`${this.identity.scheme}://chat/${encodeURIComponent(row.id)}`)

    return {
      toolId: this.id,
      sessionId: newCliSessionId(row.id),
      cwd: resolveTranscript(rootDir, row.cwd, row.id).cwd ?? (row.cwd || ctx.cwd),
      delivered: 'none',
      verified: true,
    }
  }

  // ---------- 内部 ----------

  protected rootDir(): string {
    return resolveRootDir(this.identity, this.deps)
  }

  /** sqlite/transcript 层共用的一次性日志出口（文案不含会话 id/标题/正文） */
  private readonly log: WorkbuddyLog = (key, message) => {
    this.warnOnce(key, message)
  }

  private warnOnce(key: string, message: string): void {
    const dedupeKey = `${this.id}:${key}`
    if (this.warned.has(dedupeKey)) return
    this.warned.add(dedupeKey)
    this.deps.log?.(dedupeKey, message)
  }

  private async readRows(rootDir: string): Promise<WorkbuddySessionRow[]> {
    return readSessionRows(rootDir, { log: this.log })
  }

  /** jsonl 元数据缓存：同一文件 (mtime,size) 不变就不重扫（会话文件可能上百 KB~MB） */
  private async transcriptMeta(
    filePath: string,
    mtimeMs: number,
    size: number,
  ): Promise<WorkbuddyTranscriptMeta> {
    const cached = this.transcriptCache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.meta
    let meta: WorkbuddyTranscriptMeta
    try {
      meta = await readTranscriptMeta(filePath)
    } catch (e) {
      // 不拼 errorText：Node fs 错误会带完整 jsonl 路径（含 cwd/sessionId），违反日志不含 id 的约定
      this.warnOnce('transcript', '会话消息流读取失败（已降级为空元数据）')
      meta = {}
    }
    if (this.transcriptCache.size >= TRANSCRIPT_CACHE_MAX) this.transcriptCache.clear()
    this.transcriptCache.set(filePath, { mtimeMs, size, meta })
    return meta
  }

  /** 标题：custom_title（用户改名）> title，空白折叠 + 160 截断 */
  private nameOf(row: WorkbuddySessionRow): string | undefined {
    return clipText(collapseText(row.customTitle) ?? collapseText(row.title), NAME_MAX)
  }

  /** 最后活跃时间：DB `last_activity_at` 优先，缺失回退 `updated_at`（PRD §9.1） */
  private usedAt(row: WorkbuddySessionRow): number | undefined {
    if (row.lastActivityAt !== undefined) return row.lastActivityAt
    return row.updatedAt > 0 ? row.updatedAt : undefined
  }

  /** 能否回到会话：国际版 playground 会话保守置灰（PRD §9B.6），其余可回到 */
  private isResumable(row: WorkbuddySessionRow): boolean {
    return this.identity.playgroundUnresumable ? !row.isPlayground : true
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** ms 时间戳 → ISO；缺失时用 updated_at 兜底，仍缺失则 epoch（信号是「未知」而不是「现在」） */
function isoTimestamp(primary: number, fallback: number): string {
  const value = primary > 0 ? primary : fallback
  return new Date(value > 0 ? value : 0).toISOString()
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
