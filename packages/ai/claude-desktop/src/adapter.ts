/**
 * ClaudeDesktopAdapter — Claude Desktop（Code tab + Cowork）适配器，toolId = `claude-desktop`。
 *
 * 为什么它是**独立工具**而不是 `claude` 的一个开关（rules §1）：
 *  - 身份不同：App bundle `com.anthropic.claudefordesktop`、scheme `claude://`、展示名不同；
 *  - 新建语义不同：Desktop 没有「预生成 id 再拉起」的入口 → `newSessionMode='prefill'`；
 *  - 回到会话的通道不同：Desktop 用深链接，CLI 用终端 `--resume`；
 *  - 缓存/依据/失败模式都不同（Desktop 还多一层登录态前置条件）。
 *
 * 两套会话 id（都有实测依据，见 docs/claude-code-adapter-notes.md §3、§4）：
 *  1. **`local_<id>`**（Desktop 自己的会话，正文在
 *     `<userData>/<kind>/<acct>/<org>/local_<id>/.claude/projects/…/<uuid>.jsonl`）：
 *     打开用 `claude://code/continue?session=local_<id>`（asar 侧只认 `local_[A-Za-z0-9-]{1,64}`
 *     且**只找非归档会话**）；
 *  2. **CLI 的 uuid**（CLI 会话被 Desktop adopt，正文仍在 `~/.claude/projects/…`）：
 *     打开用 `claude://resume?session=<uuid>`。
 * 列表里两者都会出现，绑定/回到会话按 id 形状路由——不猜、不混用。
 *
 * 合同要点：
 *  - `detect()` 只判 App bundle（装没装），不读版本、不读配置内容；
 *  - `launch()` 直接抛错（桌面工具没有「从 Tick 新建并绑定」的通路）；
 *  - `openNewSessionPage()` 只打开 `claude://code/new` 并预填，不发送、不绑定、不预生成 id；
 *  - 归档会话（`isArchived=true`）列为 `resumable=false`（深链接打不开，如实置灰）。
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
  SessionUsage,
} from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { toolDisplayName } from '@tick/shared'
import {
  ClaudeAdapter,
  computeUsageFromFile,
  findSessionFile,
  isDesktopEntrypoint,
  readSessionMeta,
  resolveSessionRoots,
  sessionTitleOf,
  toSessionTitle,
  type ClaudeSessionMeta,
  type ClaudeSessionRoot,
} from '@tick/ai-claude'
import { canonicalPath, newCliSessionId } from '@tick/ai-core'
import {
  CLAUDE_DESKTOP_IDENTITY,
  appBundleCandidates,
  buildNewSessionUrl,
  buildResumeUrl,
  buildContinueUrl,
  desktopLooksSignedIn,
  findAppBundleByBundleId,
  infoPlistPath,
  isUsableDirectory,
  readPlistString,
} from './paths'
import {
  collectDesktopSessions,
  findTranscriptInHome,
  isLocalSessionId,
  type DesktopSessionRecord,
} from './desktop-store'

/** detect 缓存：IPC 会反复问「装没装」，不能每次都读 Info.plist */
const DETECT_TTL_MS = 30_000
/**
 * 记录收集上限：Desktop 记录 + 正文的 stat 属于轻量操作，但要有天花板防止异常目录拖死首帧。
 * 上限下沉到 `collectDesktopSessions`（解析阶段生效），不是读完再 slice。
 */
const MAX_RECORDS = 500

export interface ClaudeDesktopAdapterDeps {
  /** 打开深链接的出口（main 注入 shell.openExternal）；open 恒 exit 0，只能靠 Promise 拒绝表达失败 */
  openUrl?: (url: string) => Promise<void> | void
  /** App bundle 搜索目录覆盖（测试隔离） */
  appDirs?: string[]
  /** 会话根覆盖（测试隔离；默认与 CLI 同一份 `~/.claude/projects`） */
  sessionRoots?: () => ClaudeSessionRoot[]
  /** home 覆盖（测试隔离：登录态 / Desktop userData / 会话 store 判定） */
  home?: string
  /** 时钟注入（detect 缓存 TTL） */
  now?: () => number
  /** 读取失败的一次性日志出口（文案不含会话 id/标题/正文） */
  log?: (key: string, message: string) => void
}

/** 一条 Desktop 会话的解析结果（列表/详情/用量共用） */
interface ResolvedSession {
  /** 绑定用的 id：`local_<id>`（Desktop 自己的会话）或 CLI 的 uuid（被 adopt 的会话） */
  sessionId: string
  filePath: string
  /** 正文里的 CLI 会话 id（记录里可能缺失） */
  cliSessionId?: string
  record?: DesktopSessionRecord
  meta?: ClaudeSessionMeta
}

export class ClaudeDesktopAdapter implements AiToolAdapter {
  readonly id = CLAUDE_DESKTOP_IDENTITY.toolId

  readonly capabilities: AiToolAdapter['capabilities'] = {
    needsCwd: true,
    resumeSession: true,
    deliverPrompt: [] as DeliverMode[],
    setSessionName: false,
    discoverProjects: true,
    describeSessions: true,
    usage: true,
    // 只打开 GUI 新建页并预填；不自动发送、不预生成/绑定 sessionId
    newSessionMode: 'prefill',
  }

  private deps: ClaudeDesktopAdapterDeps
  private detectCache?: { at: number; value: { installed: boolean; reason?: string } }
  /** 读取内核复用 CLI 适配器（同一份 jsonl 格式）；只借它的只读方法，不注册它 */
  private reader: ClaudeAdapter
  private logged = new Set<string>()

  constructor(deps: ClaudeDesktopAdapterDeps = {}) {
    this.deps = deps
    this.reader = new ClaudeAdapter({
      sessionRoots: () => this.sessionRoots(),
      // 全局 store 里只收 Desktop 写过的会话（CLI 会话归 `claude`）
      acceptEntrypoint: (entrypoint) => isDesktopEntrypoint(entrypoint),
      // 装没装由本适配器按 App bundle 判定；不能因为本机没装 `claude` CLI 就把 Desktop
      // 的全局 store 会话全藏掉
      gateOnDetect: false,
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * home 的统一来源：注入值 > `os.homedir()`。
   *
   * 旧实现 detect 走 `process.env.HOME`、登录态判定走 `os.homedir()`；两者在 Electron 里
   * 通常一致（POSIX 上 os.homedir 也读 $HOME），但测试注入/环境被改时会分裂。统一到一个函数，
   * 所有 home 相关读取（Desktop userData / 登录态 / App 搜索目录）都走它。
   */
  private home(): string {
    return this.deps.home ?? homedir()
  }

  private warnOnce(key: string, message: string): void {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.deps.log?.(key, message)
  }

  private sessionRoots(): ClaudeSessionRoot[] {
    return this.deps.sessionRoots?.() ?? resolveSessionRoots()
  }

  // ---------- 就绪探测 ----------

  /**
   * 只判 App bundle：找到 `.app` 且 `CFBundleIdentifier` 对得上才算装。
   * 数据目录存在不算已安装（卸载残留会留下 `~/Library/Application Support/Claude`）。
   */
  async detect(): Promise<{ installed: boolean; reason?: string }> {
    const cached = this.detectCache
    if (cached && this.now() - cached.at < DETECT_TTL_MS) return cached.value

    let value: { installed: boolean; reason?: string }
    try {
      value = await this.probeInstallation()
    } catch (e) {
      this.warnOnce('detect', `安装探测失败：${(e as Error).message}`)
      value = { installed: false, reason: 'Claude Desktop 安装探测失败' }
    }
    this.detectCache = { at: this.now(), value }
    return value
  }

  private async probeInstallation(): Promise<{ installed: boolean; reason?: string }> {
    let sawBundle = false
    // home 也注入（测试隔离）：没注入 appDirs 时不要在真实 ~/Applications 里扫
    const candidates = [...appBundleCandidates(this.deps.appDirs, this.home())]
    for (const bundle of candidates) {
      if (!existsSync(bundle)) continue
      sawBundle = true
      const bundleId = await readPlistString(infoPlistPath(bundle), 'CFBundleIdentifier')
      if (bundleId === CLAUDE_DESKTOP_IDENTITY.bundleId) return { installed: true }
    }
    // 静态目录没命中（装在 `/Applications/APP/`、外置盘、用户自定义位置）：问 LaunchServices。
    // 注入 appDirs 时（测试/隔离）不做这一步，避免扫到真实机器上的 App。
    if (!this.deps.appDirs) {
      const found = await findAppBundleByBundleId(CLAUDE_DESKTOP_IDENTITY.bundleId)
      if (found) {
        const bundleId = await readPlistString(infoPlistPath(found), 'CFBundleIdentifier')
        if (bundleId === CLAUDE_DESKTOP_IDENTITY.bundleId) return { installed: true }
      }
    }
    return {
      installed: false,
      reason: sawBundle ? 'Claude.app 的 bundle id 不匹配（可能不是官方 Desktop）' : '未检测到 Claude Desktop',
    }
  }

  // ---------- 会话解析（两套 id 空间） ----------

  /** Desktop 自己的记录（`local_<id>.json`）；读不到就当没有，不抛 */
  private records(): DesktopSessionRecord[] {
    return collectDesktopSessions(this.home(), MAX_RECORDS)
  }

  /**
   * 记录 → 正文。两处都要找（实测两种都真实存在）：
   *  1. 会话自己的 home（`<homeDir>/.claude/projects/…`）——Desktop 原生会话；
   *  2. **全局 `~/.claude/projects`**——CLI 里建的会话被 Desktop adopt 后，记录里有
   *     `adoptedFromOtherSurface: true`、`local_<cliUuid>` 形式的 id，但正文仍留在全局 store。
   *
   * 两处都按**记录里的 CLI id** 找；一条都对不上就返回 undefined（不拿 home 里 mtime 最新的
   * 正文顶替——那会把别的会话挂到这条记录上，见审查 P1 与 `findTranscriptInHome` 注释）。
   */
  private resolveRecord(record: DesktopSessionRecord): ResolvedSession | undefined {
    const hit = findTranscriptInHome(record.homeDir, record)
    if (hit) {
      return { sessionId: record.localId, filePath: hit.filePath, cliSessionId: hit.sessionId, record }
    }
    const wanted = [record.cliSessionId, ...record.priorCliSessionIds].filter(
      (id): id is string => typeof id === 'string' && Boolean(id),
    )
    for (const cliId of wanted) {
      const file = findSessionFile(cliId, this.sessionRoots())
      if (file) return { sessionId: record.localId, filePath: file, cliSessionId: cliId, record }
    }
    return undefined
  }

  /** `local_<id>` → 记录（找不到返回 undefined） */
  private recordByLocalId(localId: string): DesktopSessionRecord | undefined {
    return this.records().find((record) => record.localId === localId)
  }

  /** CLI uuid → 记录（Desktop 记录里记着它用过哪条 CLI 正文） */
  private recordByCliId(cliId: string): DesktopSessionRecord | undefined {
    const lower = cliId.toLowerCase()
    return this.records().find(
      (record) =>
        record.cliSessionId?.toLowerCase() === lower ||
        record.priorCliSessionIds.some((id) => id.toLowerCase() === lower),
    )
  }

  /**
   * 任意 id → 正文。优先级：
   *  1) `local_<id>`：Desktop 记录 → 会话 home 里的正文；
   *  2) CLI uuid：先看是否有 Desktop 记录曾用它（home 里的正文），否则看全局
   *     `~/.claude/projects`（CLI 会话被 adopt 的情况）。
   */
  private async resolveSession(id: string): Promise<ResolvedSession | undefined> {
    if (isLocalSessionId(id)) {
      const record = this.recordByLocalId(id)
      return record ? this.resolveRecord(record) : undefined
    }
    const record = this.recordByCliId(id)
    const fromRecord = record ? this.resolveRecord(record) : undefined
    if (fromRecord && fromRecord.cliSessionId?.toLowerCase() === id.toLowerCase()) {
      // 命中的正文确实是这条 CLI 会话：保留 CLI uuid 作为 id（`claude://resume` 可用）
      return { ...fromRecord, sessionId: id }
    }
    const file = findSessionFile(id, this.sessionRoots())
    // 记录里那条正文是**别的** id 的（prior 会话）：不能拿它顶替这条 CLI 会话，
    // 本机没有它的正文就如实返回 undefined
    if (!file) return undefined
    return { sessionId: id, filePath: file, cliSessionId: id }
  }

  /**
   * 会话元数据。`withName=false` 只需要 cwd（resume / 项目发现），走「扫到 cwd 即停」的
   * 轻量读取；`withName=true` 才扫头 + 尾拿标题与首/末 user 消息。
   */
  private async metaOf(session: ResolvedSession, withName: boolean): Promise<ClaudeSessionMeta> {
    if (session.meta && !withName) return session.meta
    const meta = await readSessionMeta(session.filePath, withName ? {} : { stopAfterCwd: true }).catch(
      () => ({} as ClaudeSessionMeta),
    )
    session.meta = meta
    return meta
  }

  /** 一条 Desktop 会话 → `SessionSummary`（列表用） */
  private async toSummary(session: ResolvedSession): Promise<SessionSummary | undefined> {
    let stat
    try {
      stat = statSync(session.filePath)
    } catch {
      return undefined
    }
    if (stat.size === 0) return undefined // 0 字节 = 还没产生
    const meta = await this.metaOf(session, true)
    // 与 claude 适配器同判据：正文文件名里的 id 与记录内 sessionId 不一致 → 不是这条会话
    if (meta.idMismatch) return undefined
    const archived = session.record?.archived === true
    const title = session.record?.title?.trim()
    return {
      toolId: this.id,
      sessionId: newCliSessionId(session.sessionId),
      cwd: meta.cwd ?? session.record?.cwd ?? '',
      name: title || sessionTitleOf(meta),
      firstMessage: toSessionTitle(meta.firstUserText),
      createdAt: new Date(
        meta.firstUserAt ?? session.record?.createdAt ?? stat.birthtimeMs ?? stat.mtimeMs,
      ).toISOString(),
      lastUsedAt: session.record?.lastActivityAt ?? meta.lastEventAt ?? stat.mtimeMs,
      filePath: session.filePath,
      exists: true,
      // 归档会话深链接打不开（asar: `$9t()` 只找非归档）→ 如实置灰
      resumable: !archived,
      size: stat.size,
    }
  }

  // ---------- 合同实现 ----------

  /**
   * 项目发现：Desktop 会话的 cwd 优先取正文（记录缺失时也能贡献证据）。
   *
   * 计数纪律：**按正文文件去重**。同一条正文可能既被 record 解析到、又出现在全局 store
   * （entrypoint=claude-desktop）里；旧实现两段各自 +=，真实数据同一 cwd 数成 3（实际 2 条），
   * 合并到项目卡片后 7 vs 实际 5。所以这里和 `listSessionInfos` 一样维护 `covered` Set，
   * 改成按 `reader.listSessionInfos()` 的每条正文（带 filePath）逐条计数，而不是直接加总和。
   */
  async discoverProjects(): Promise<ProjectSource['projects']> {
    const detected = await this.detect()
    if (!detected.installed) return []
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    const add = (cwd: string | undefined, at: number | undefined): void => {
      if (!cwd || !path.isAbsolute(cwd)) return
      // 归一化路径（与 claude 适配器同口径）：否则 /var/... 与 /private/var/... 会出现两条证据
      const canonical = canonicalPath(cwd)
      const entry = byPath.get(canonical) ?? { sessionCount: 0, exists: existsSync(canonical) }
      entry.sessionCount += 1
      if (at !== undefined && (entry.lastUsedAt === undefined || at > entry.lastUsedAt)) {
        entry.lastUsedAt = at
      }
      byPath.set(canonical, entry)
    }

    const covered = new Set<string>()
    for (const record of this.records()) {
      const resolved = this.resolveRecord(record)
      if (!resolved) {
        // 记录还在、正文没了（被清理）：按记录里的 cwd 贡献一条证据，但没有正文可去重
        add(record.cwd, record.lastActivityAt)
        continue
      }
      if (covered.has(resolved.filePath)) continue // 同一条正文只计一次
      covered.add(resolved.filePath)
      const meta = await this.metaOf(resolved, false)
      if (meta.idMismatch) continue // 同 claude：id 不一致的正文不贡献项目证据
      add(meta.cwd ?? record.cwd, record.lastActivityAt ?? meta.lastEventAt)
    }
    // 全局 store 里 Desktop 写过的会话（reader 已按 entrypoint 过滤），排除已被记录覆盖的正文
    for (const summary of await this.reader.listSessionInfos()) {
      if (covered.has(summary.filePath)) continue
      covered.add(summary.filePath)
      add(summary.cwd, summary.lastUsedAt)
    }
    return [...byPath.entries()].map(([p, entry]) => ({
      path: p,
      sessionCount: entry.sessionCount,
      lastUsedAt: entry.lastUsedAt,
      exists: entry.exists,
    }))
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const detected = await this.detect()
    if (!detected.installed) return []

    const out: SessionSummary[] = []
    const covered = new Set<string>() // 已被 Desktop 记录覆盖的正文，避免重复
    for (const record of this.records()) {
      const resolved = this.resolveRecord(record)
      if (!resolved) continue // 记录还在、正文没了（被清理）：视为不存在，不列
      covered.add(resolved.filePath)
      const summary = await this.toSummary(resolved)
      if (summary) out.push(summary)
    }
    // 全局 store 里 Desktop 写过的会话（entrypoint 判定在 reader 内），排除已覆盖的正文
    for (const summary of await this.reader.listSessionInfos()) {
      if (!covered.has(summary.filePath)) out.push({ ...summary, toolId: this.id })
    }
    out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  async describeSession(
    id: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    const detected = await this.detect()
    if (!detected.installed) return undefined
    const session = await this.resolveSession(id)
    if (!session) return undefined
    let stat
    try {
      stat = statSync(session.filePath)
    } catch {
      return undefined
    }
    if (stat.size === 0) return undefined // 0 字节 = 还没产生（不变量 3）
    const withName = opts.withName !== false
    const meta = await this.metaOf(session, withName)
    if (meta.idMismatch) return undefined // 同 claude：id 不一致不是这条会话
    const record = session.record
    return {
      toolId: this.id,
      sessionId: newCliSessionId(session.sessionId),
      cwd: meta.cwd ?? record?.cwd ?? '',
      name: withName ? record?.title?.trim() || sessionTitleOf(meta) : undefined,
      firstMessage: withName ? toSessionTitle(meta.firstUserText) : undefined,
      lastMessage: withName ? toSessionTitle(meta.lastUserText) : undefined,
      createdAt: new Date(meta.firstUserAt ?? record?.createdAt ?? stat.birthtimeMs ?? stat.mtimeMs).toISOString(),
      lastUsedAt: record?.lastActivityAt ?? meta.lastEventAt ?? stat.mtimeMs,
      filePath: session.filePath,
      exists: true,
      resumable: record?.archived !== true,
      hasLocalFiles: true,
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    const detected = await this.detect()
    if (!detected.installed) return undefined
    const session = await this.resolveSession(id)
    if (!session) return undefined
    // 与 list/describe 同判据：id 不一致的正文不把用量算到这条会话上
    const meta = await this.metaOf(session, false)
    if (meta.idMismatch) return undefined
    // 单会话读取异常隔离成「无证据」（文件可能在 stat 之后被清理），不冒成 IPC reject
    return computeUsageFromFile(session.filePath).catch(() => undefined)
  }

  /**
   * 桌面工具没有「launch 会新增会话」的通路，所以这里**恒 false**（不是「未实现」）。
   * 合同允许缺失，但 `LaunchService.reconcilePending()` 对任何 pending 绑定每 5s 会调一次；
   * 保留实现让这条路径有明确答案，而不是 undefined。
   */
  async verify(): Promise<boolean> {
    return false
  }

  // ---------- 拉起 / 回到会话 ----------

  /** 桌面 App 不能由 Tick 预生成 id 并发送：直接抛错（rules §2） */
  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error(
      `${toolDisplayName(this.id)} 是桌面应用，不能从 Tick 新建会话；请用「打开新建页」或先在应用里开始，再用「倒入历史会话」绑定。`,
    )
  }

  /**
   * 回到会话。按 id 形状路由：
   *  - `local_<id>` → `claude://code/continue?session=<id>`（归档会话打不开，直接给原因）；
   *  - CLI uuid → `claude://resume?session=<uuid>`（Desktop 会把它导入并打开）。
   *
   * 调用前三道校验（都不依赖深链接的静默失败）：App 装了 / 正文在本机 / Desktop 登录过。
   */
  async resume(sessionId: CliSessionId, _ctx: LaunchContext): Promise<LaunchResult> {
    const detected = await this.detect()
    if (!detected.installed) {
      throw new Error(detected.reason ?? 'Claude Desktop 未安装，无法回到会话')
    }
    const openUrl = this.deps.openUrl
    if (!openUrl) throw new Error('未注入 openUrl（main 进程需装配 shell.openExternal）')

    const session = await this.resolveSession(sessionId)
    if (!session) {
      throw new Error(
        `在 Claude Desktop 的本地记录里找不到这条会话（${sessionId}）；只能打开本机已有的会话`,
      )
    }
    if (session.record?.archived === true) {
      throw new Error('这条会话已在 Claude Desktop 里归档，深链接无法打开；请先在应用里取消归档')
    }
    if (!desktopLooksSignedIn(this.home())) {
      throw new Error('Claude Desktop 还没有登录过；请先在应用里登录，再回到会话')
    }
    // 与 list/describe 同判据：正文与记录 id 对不上时不能假装能回到这条会话
    const meta = await this.metaOf(session, false)
    if (meta.idMismatch) {
      throw new Error('这条会话的正文与记录里的 id 不一致，无法确认是哪一条；请在 Claude Desktop 里打开')
    }

    const url = isLocalSessionId(session.sessionId)
      ? buildContinueUrl(session.sessionId)
      : buildResumeUrl(session.sessionId)
    try {
      await openUrl(url)
    } catch (e) {
      throw new Error(`打开 Claude Desktop 失败：${(e as Error).message}`)
    }
    return {
      toolId: this.id,
      sessionId: newCliSessionId(session.sessionId),
      cwd: meta.cwd ?? session.record?.cwd ?? '',
      delivered: 'none',
      verified: true,
    }
  }

  /**
   * 打开 Desktop 的 Code 新建页并预填文案 + 项目。
   * 不自动发送、不预生成 sessionId、不写绑定（发送后仍用「倒入历史会话」绑定）。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    const detected = await this.detect()
    if (!detected.installed) {
      return { ok: false, reason: detected.reason ?? 'Claude Desktop 未安装，无法打开新建页' }
    }
    const openUrl = this.deps.openUrl
    if (!openUrl) return { ok: false, reason: '未注入 openUrl（main 进程需装配 shell.openExternal）' }

    const prompt = (ctx.promptText ?? '').trim()
    if (!prompt) return { ok: false, reason: '需要非空文案才能预填' }
    if (!isUsableDirectory(ctx.cwd)) {
      return { ok: false, reason: '项目路径无效（需要存在且可读的绝对目录）' }
    }

    const { url, truncated, overLimit } = buildNewSessionUrl(prompt, ctx.cwd)
    // cwd 本体过长时 q 已经裁到 0 仍超限：URL 会被 LaunchServices 静默丢弃，
    // 必须如实失败（不能宣称「已预填」）
    if (overLimit) {
      return {
        ok: false,
        reason: '项目路径过长，深链接超过安全长度；请把项目移到更短的路径后再试',
      }
    }
    try {
      await openUrl(url)
    } catch (e) {
      return { ok: false, reason: `打开 Claude Desktop 新建页失败：${(e as Error).message}` }
    }
    return { ok: true, truncated }
  }
}
