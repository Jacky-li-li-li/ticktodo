/**
 * OpenCodeAdapter — OpenCode 系工具的适配器（OpenCode / ZCode 共用，身份参数化）。
 *
 * 事实与口径见 `store.ts` 与 `sqlite.ts` 的头注释（magpie + 本机实测）。
 * 关键点：
 *  - 会话在 SQLite 里，**不是文件**：`filePath` 指向数据库本身（导出只能给 id + db 路径，拿不到正文文件）；
 *  - 子代理会话（`parent_id` 非空）不列：用量已计入父会话；
 *  - OpenCode 的 `session` 行自带 token/cost，ZCode 要读 `model_usage`（由 identity 决定）；
 *  - 回到会话：OpenCode 用 `opencode --session <id>`；ZCode 是桌面应用，**没有** resume 通道；
 *  - 没有预生成 id 的能力 → `newSessionMode='prefill'`（terminal-copy），见下。
 *
 * **OpenCode Desktop 不单独建适配器**（2026-10-20 读源码核实）：
 *  - 桌面端是 Electron 外壳，跑的是**同一个** opencode CLI：`opencode serve --service` 当 sidecar
 *    （`packages/desktop/src/main/service/background-service.ts`），生产环境**不改** XDG 数据根，
 *    所以桌面端与 CLI 共用 `~/.local/share/opencode/opencode.db`、同一批 session id；
 *  - 数据里**没有客户端标记**（`session.workspace_id` 全为 null、没有 entrypoint 列）→ 没法按客户端拆分，
 *    拆成两个适配器只会让同一条会话在列表里出现两次；
 *  - 桌面端**深链接不可用**（2026-10-21 本机 1.19.3 实测）：renderer 源码里能解析
 *    `opencode://new-session?directory=&prompt=` 与 `opencode://open-project?directory=`，
 *    但新布局没有挂那个 `opencode:deep-link` 监听（`handleDeepLinks` 只在旧 shell 里 onMount）；
 *    实测发深链接后 App 主进程日志有记录、而 `opencode.global.dat`/路由状态没有任何变化
 *    （用一个全新项目路径做探针也没有被写入）。所以桌面入口**只做两件事**：把 App 激活到前台 +
 *    文案进剪贴板；回到会话也只能打开 App（没有按会话定位的通道）。
 *    CLI 的 `opencode --session <id>` 才是可靠通路（同一份数据）→ capabilities 声明
 *    `clients: ['desktop','cli']`，由用户选入口。
 *  - 桌面端会把自带的 CLI 装到 `~/.opencode/bin/opencode`（不在 PATH）→ 可执行探测要额外看这里；
 *    更老的桌面构建没有这份副本（服务在 Electron 主进程里跑），所以「装没装」还要看 App bundle
 *    `ai.opencode.desktop`（本机在 `/Applications/APP/OpenCode.app`，嵌套目录 → 必须 mdfind 兜底）。
 *    只有桌面版时数据仍可读，但没有 CLI 就不能按会话打开（给出可读原因，不假装能跳）。
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
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
import { canonicalPath, isExistingDirectory, newCliSessionId } from '@tick/ai-core'
import type { CliSessionId } from '@tick/shared'
import { findCliExecutable, isExecutableFile, type TerminalOpenSpec } from '@tick/ai-pi'
import type { ToolClientId } from '@tick/shared'
import type { OpenCodeIdentity, OpenCodeSessionRow } from './store'
import { findDesktopApp } from './paths'
import { listSessionRows, openStore, readSessionRow, readUserTexts } from './store'
import type { OpenCodeLog } from './sqlite'

export type { OpenCodeIdentity } from './store'

export interface OpenCodeAdapterDeps {
  resolveExe?: () => Promise<string | null>
  /** 剪贴板（CLI 预填：打开终端 + 文案进剪贴板） */
  clipboardWrite?: (text: string) => void
  openTerminal?: (spec: TerminalOpenSpec) => Promise<void> | void
  /**
   * 数据库路径覆盖（测试隔离 / 延迟解析）。
   * 传函数时**每次读取都重新求值**：main 在启动后才 resolve（`() => resolveOpenCodeDbPath()`），
   * 运行中安装/改环境无需重启 Tick。string 形态保持向后兼容。
   */
  dbPath?: string | (() => string)
  /** home 覆盖（测试隔离：`~/.opencode/bin/opencode` 兜底探测） */
  home?: string
  /** 可执行文件查找的注入点（默认 `findCliExecutable`；测试用来模拟 PATH 无命中） */
  findExe?: (name: string, opts: { home: string }) => Promise<string | null>
  /** 桌面 App 搜索目录覆盖（测试隔离） */
  appDirs?: string[]
  /**
   * 把桌面 App 带到前台（main 注入 `open -a <App>`）。
   * 不依赖深链接：1.19.3 的 renderer 里虽然能解析 `opencode://new-session`，实际不会处理
   * （见文件头注释），所以桌面入口 = 激活 App + 剪贴板。
   */
  activateApp?: (appPath: string) => Promise<void> | void
  /** 日志出口（读取失败时记一次原因，不含正文） */
  log?: OpenCodeLog
}

/**
 * OpenCode Desktop 自带的 CLI 安装位置：`<home>/.opencode/bin/<exe>`。
 *
 * 桌面端 packaged 构建会把随包的 opencode 装机到用户目录（不是 PATH），
 * 所以只查 PATH/常见前缀会漏掉「只用桌面版」的机器。
 */
export function desktopBundledExe(home: string, exeName: string): string {
  return path.join(home, '.opencode', 'bin', exeName)
}

function toSessionSummary(
  identity: OpenCodeIdentity,
  dbPath: string,
  resumable: boolean,
  row: OpenCodeSessionRow,
): SessionSummary {
  return {
    toolId: identity.toolId,
    sessionId: newCliSessionId(row.id),
    cwd: row.cwd ?? homedir(),
    name: row.title,
    // 标题之外不再读正文（列表要快）；「上次停在哪」由 describeSession 提供
    createdAt: new Date(row.createdAt ?? Date.now()).toISOString(),
    lastUsedAt: row.updatedAt,
    // 正文在数据库里：给 db 路径作为「可定位存储」
    filePath: dbPath,
    exists: true,
    // 归档会话不能回到会话（CLI 分支会拒）；ZCode 没有 resume 通道 → 列表里直接置灰
    resumable,
  }
}

export class OpenCodeAdapter implements AiToolAdapter {
  readonly id: string
  readonly capabilities: AiToolAdapter['capabilities']
  readonly carry = { acceptFrom: [], exposes: [] }

  private identity: OpenCodeIdentity
  private deps: OpenCodeAdapterDeps
  private resolvedExe: string | null = null
  private logged = new Set<string>()

  constructor(identity: OpenCodeIdentity, deps: OpenCodeAdapterDeps = {}) {
    // getter 形态**不能**在构造时求值（main 可能启动后才解析数据根），读的时候再问
    this.identity = typeof deps.dbPath === 'string' ? { ...identity, dbPath: deps.dbPath } : identity
    this.deps = deps
    this.id = this.identity.toolId
    this.capabilities = {
      needsCwd: true,
      resumeSession: Boolean(this.identity.exeName && this.identity.resumeArgs),
      // OpenCode 桌面版与 CLI 共用同一份会话 → 两个入口都可用
      // （桌面版：激活 App + 剪贴板，**没有**按会话定位的深链接；CLI：终端 `--session`）
      // 只有「既有 CLI 又有桌面版」才是多客户端；ZCode 是纯桌面应用（没有 CLI）→ 不给选择器
      ...(this.identity.desktopBundleId && this.identity.exeName
        ? { clients: ['desktop', 'cli'] as ToolClientId[] }
        : {}),
      deliverPrompt: [] as DeliverMode[],
      setSessionName: false,
      discoverProjects: true,
      describeSessions: true,
      usage: true,
      // OpenCode 有 TUI：打开终端 + 文案进剪贴板，由用户 ⌘V 确认（启动参数会立刻发送）
      newSessionMode: this.identity.exeName ? 'prefill' : 'none',
      ...(this.identity.exeName ? { prefillDelivery: 'terminal-copy' as const } : {}),
    }
  }

  private log: OpenCodeLog = (key, message) => {
    // 同一类失败只记一次（列表会被反复调用）
    const id = `${this.id}:${key}:${message}`
    if (this.logged.has(id)) return
    this.logged.add(id)
    this.deps.log?.(`${this.id}.${key}`, message)
  }

  /** 当前数据库路径：deps.dbPath 是 getter 时每次重新求值（延迟解析数据根） */
  private dbPathNow(): string {
    const override = this.deps.dbPath
    return typeof override === 'function' ? override() : (override ?? this.identity.dbPath)
  }

  /** 带上当前 dbPath 的身份视图（openStore/摘要的 filePath 都用它） */
  private identityNow(): OpenCodeIdentity {
    const dbPath = this.dbPathNow()
    return dbPath === this.identity.dbPath ? this.identity : { ...this.identity, dbPath }
  }

  async detect(): Promise<{ installed: boolean; reason?: string }> {
    if (this.identity.exeName) {
      const exe = await this.resolveExe()
      if (exe) return { installed: true }
      // 只有桌面版也算「装了」：会话数据同一份、仍可读；只是没有 CLI 就不能按会话打开
      if (this.identity.desktopBundleId && this.identity.desktopBundleName) {
        const app = await this.desktopApp()
        if (app) return { installed: true }
      }
      return { installed: false, reason: `未检测到 ${this.identity.exeName} 可执行文件（也未检测到桌面版）` }
    }
    // 桌面应用（ZCode）：**只看 App bundle**（rules §4「数据目录存在不算已安装」）。
    // 有数据但没 App 是卸载残留；reason 里区分开，别让用户以为「Tick 找不到数据」。
    if (this.identity.desktopBundleId && this.identity.desktopBundleName) {
      const app = await this.desktopApp()
      if (app) return { installed: true }
      const hasData = existsSync(this.dbPathNow())
      return {
        installed: false,
        reason: hasData
          ? `检测到 ${this.identity.displayName} 的会话数据，但没找到 ${this.identity.desktopBundleName}（应用可能已卸载）`
          : `未检测到 ${this.identity.desktopBundleName}`,
      }
    }
    return { installed: false, reason: `未检测到 ${this.identity.displayName}（没有可探测的 App bundle）` }
  }

  /** 找桌面 App 的 bundle 路径（只有声明了 desktopBundleId 的工具才有） */
  private async desktopApp(): Promise<string | undefined> {
    const id = this.identity.desktopBundleId
    if (!id) return undefined
    return findDesktopApp(id, this.identity.desktopBundleName ?? 'OpenCode.app', {
      ...(this.deps.home ? { home: this.deps.home } : {}),
      ...(this.deps.appDirs ? { appDirs: this.deps.appDirs } : {}),
    })
  }

  private async resolveExe(): Promise<string | null> {
    if (this.deps.resolveExe) return this.deps.resolveExe()
    if (!this.identity.exeName) return null
    if (this.resolvedExe && existsSync(this.resolvedExe)) return this.resolvedExe
    // 1) PATH / 常见前缀 / 登录 shell PATH（GUI 最小 PATH 兜底在 findCliExecutable 里）
    const home = this.deps.home ?? homedir()
    const find = this.deps.findExe ?? ((name, opts) => findCliExecutable(name, opts))
    const found = await find(this.identity.exeName, { home })
    if (found) {
      this.resolvedExe = found
      return found
    }
    // 2) OpenCode Desktop 自带的 CLI：安装到 `~/.opencode/bin/opencode`，通常不在 PATH 上。
    //    只认「可执行的普通文件」；找不到就如实报未安装。
    const bundled = desktopBundledExe(home, this.identity.exeName)
    if (isExecutableFile(bundled)) {
      this.resolvedExe = bundled
      return bundled
    }
    return null
  }

  private async withStore<T>(
    fn: (rows: OpenCodeSessionRow[]) => T,
    identity: OpenCodeIdentity = this.identityNow(),
  ): Promise<T | undefined> {
    const opened = await openStore(identity, this.log)
    if (!opened) return undefined
    try {
      const rows = listSessionRows(opened.db, identity, this.log)
      return fn(rows)
    } finally {
      opened.cleanup()
    }
  }

  async discoverProjects(): Promise<ProjectSource['projects']> {
    const rows = (await this.withStore((r) => r)) ?? []
    const byPath = new Map<string, { sessionCount: number; lastUsedAt?: number; exists: boolean }>()
    for (const row of rows) {
      if (!row.cwd || !row.cwd.startsWith('/')) continue
      const p = canonicalPath(row.cwd)
      const entry = byPath.get(p) ?? { sessionCount: 0, exists: existsSync(p) }
      entry.sessionCount += 1
      if (row.updatedAt !== undefined && (entry.lastUsedAt === undefined || row.updatedAt > entry.lastUsedAt)) {
        entry.lastUsedAt = row.updatedAt
      }
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
    const rows = (await this.withStore((r) => r)) ?? []
    const wantCwd = cwd ? canonicalPath(cwd) : undefined
    return rows
      .filter((row) => !wantCwd || (row.cwd && canonicalPath(row.cwd) === wantCwd))
      .map((row) => ({ toolId: this.id, sessionId: newCliSessionId(row.id) }))
  }

  async listSessionInfos(): Promise<SessionSummary[]> {
    const identity = this.identityNow()
    const rows = (await this.withStore((r) => r, identity)) ?? []
    return rows.map((row) =>
      toSessionSummary(identity, identity.dbPath, this.capabilities.resumeSession && !row.archived, row),
    )
  }

  /** 详情：标题 + 首/末条用户文本（读 message/part；子代理消息不计入） */
  async describeSession(
    id: CliSessionId,
    opts: { withName?: boolean } = {},
  ): Promise<SessionInfo | undefined> {
    const identity = this.identityNow()
    const opened = await openStore(identity, this.log)
    if (!opened) return undefined
    try {
      // 详情不返回用量：跳过用量查询（ZCode 的 message 兜底是全表扫，别为标题付这份钱）
      const row = readSessionRow(opened.db, identity, id, this.log, { withUsage: false })
      if (!row) return undefined
      const withName = opts.withName !== false
      // message/part schema 不识别时正文能力已关闭；列表/用量仍可用
      const texts = withName && opened.bodyReadable ? readUserTexts(opened.db, id, this.log) : {}
      return {
        toolId: this.id,
        sessionId: newCliSessionId(id),
        cwd: row.cwd ?? homedir(),
        name: withName ? row.title : undefined,
        firstMessage: withName ? texts.first : undefined,
        lastMessage: withName ? texts.last : undefined,
        createdAt: new Date(row.createdAt ?? Date.now()).toISOString(),
        lastUsedAt: row.updatedAt,
        filePath: identity.dbPath,
        exists: true,
        resumable: this.capabilities.resumeSession && !row.archived,
        hasLocalFiles: true,
      }
    } finally {
      opened.cleanup()
    }
  }

  async computeUsage(id: CliSessionId): Promise<SessionUsage | undefined> {
    // 单行查询（含子代理聚合）：不再为一条会话列全表 + 逐行解析 message
    const identity = this.identityNow()
    const opened = await openStore(identity, this.log)
    if (!opened) return undefined
    let row: OpenCodeSessionRow | undefined
    try {
      row = readSessionRow(opened.db, identity, id, this.log)
    } finally {
      opened.cleanup()
    }
    if (!row) return undefined
    const own = row.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const total = own.input + own.output + own.cacheRead + own.cacheWrite
    // session 行的 cost 只含本会话自己（实测恰等于自身 message 之和）→ 子代理成本必须加回，
    // 否则 token 已含子代理、钱没含，同一张卡片两个口径。
    const totalCost = (row.cost ?? 0) + (row.childCost ?? 0)
    // token 全 0 但子代理有 cost（某些网关/免费模型只报钱不报 token）：不能因为「没 token」丢掉成本
    if (total === 0 && totalCost === 0) return undefined
    const tokens = { input: own.input, output: own.output, cacheRead: own.cacheRead, cacheWrite: own.cacheWrite, totalTokens: total }
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost }
    return {
      tokens,
      cost,
      byModel: [
        {
          provider: row.providerId ?? this.id,
          model: row.modelId ?? 'unknown',
          tokens,
          cost,
        },
      ],
      messageCount: 0,
      computedAt: Date.now(),
      // 有 token 却报 0 成本的会话行（自己或子代理）→ 合并后的钱只能当下限，UI 打「≥」
      costReported: totalCost > 0 && !row.costUnreported,
    }
  }

  async verify(): Promise<boolean> {
    return false
  }

  /**
   * CLI 没有草稿 API（`opencode --prompt` 会立刻提交，实测）——打开终端里的 OpenCode，
   * 文案放剪贴板，由用户 ⌘V + 回车确认；不预生成 id、不绑定。
   */
  async openNewSessionPage(ctx: NewSessionPageContext): Promise<NewSessionPageResult> {
    // 桌面版入口：只有「既有 CLI 又有桌面版」的工具才有这个分支（ZCode 没有 CLI，走末尾的 none 提示）。
    // 深链接在 1.19.3 的新布局里不会被处理（见文件头）→ 只激活 App + 文案进剪贴板。
    let desktopFallbackNotice: string | undefined
    if (ctx.client === 'desktop' && this.identity.exeName && this.identity.desktopBundleId) {
      const detected = await this.detect()
      if (!detected.installed) return { ok: false, reason: detected.reason ?? `${this.identity.displayName} 未安装` }
      if (!isExistingDirectory(ctx.cwd)) {
        return { ok: false, reason: '项目路径不存在或不是目录' }
      }
      const app = await this.desktopApp()
      // 桌面版没装（只有 CLI）→ **回落** CLI 分支，而不是直接失败：默认入口在「只有 CLI」的机器上也必须可用
      if (app) {
        if (!this.deps.activateApp) return { ok: false, reason: '未注入 activateApp（main 进程需装配 `open -a`）' }
        if (!this.deps.clipboardWrite) return { ok: false, reason: '剪贴板不可用，无法把文案交给桌面版' }
        try {
          await this.deps.activateApp(app)
        } catch (e) {
          return { ok: false, reason: `打开 ${this.identity.displayName} 桌面版失败：${(e as Error).message}` }
        }
        this.deps.clipboardWrite(ctx.promptText)
        return {
          ok: true,
          notice: `已打开 ${this.identity.displayName} 桌面版并把文案复制到剪贴板：点「新建会话」后按 ⌘V 粘贴（不会自动发送；发送后用「倒入历史会话」绑定）`,
        }
      }
      desktopFallbackNotice = `未检测到 ${this.identity.displayName} 桌面版，已改用终端`
    }
    if (!this.identity.exeName) return { ok: false, reason: `${this.identity.displayName} 是桌面应用，无法打开终端新建页` }
    const detected = await this.detect()
    if (!detected.installed) return { ok: false, reason: detected.reason ?? `${this.identity.displayName} 未安装` }
    if (!isExistingDirectory(ctx.cwd)) {
      return { ok: false, reason: '项目路径不存在或不是目录' }
    }
    const exe = await this.resolveExe()
    if (!exe) {
      return {
        ok: false,
        reason: `${this.identity.displayName} 未找到 CLI 可执行文件；若要用桌面版，请在上面选「桌面版」`,
      }
    }
    const open = this.deps.openTerminal
    if (!open) return { ok: false, reason: '未注入终端拉起实现（main 进程装配 openTerminal）' }
    await open({ cwd: ctx.cwd, executable: exe, args: [] })
    // 剪贴板不可用时不宣称「已复制」：只打开终端，并如实说明需要手动输入
    const clipboardOk = Boolean(this.deps.clipboardWrite)
    if (this.deps.clipboardWrite) this.deps.clipboardWrite(ctx.promptText)
    const notice = clipboardOk
      ? `已打开 ${this.identity.displayName}；文案已复制 —— 在终端里 ⌘V 再回车发送，发送后用「倒入历史会话」绑定`
      : `已打开 ${this.identity.displayName}；剪贴板不可用，请手动输入文案（发送后用「倒入历史会话」绑定）`
    return {
      ok: true,
      notice: desktopFallbackNotice ? `${desktopFallbackNotice}；${notice}` : notice,
    }
  }

  async launch(_ctx: LaunchContext): Promise<LaunchResult> {
    throw new Error(
      `${this.identity.displayName} 不能从 Tick 新建会话；请先在应用里开始，再用「倒入历史会话」绑定。`,
    )
  }

  /** OpenCode：`opencode --session <id>`；ZCode 没有 resume 通道（capabilities 已为 false） */
  async resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult> {
    if (!this.capabilities.resumeSession || !this.identity.resumeArgs) {
      throw new Error(`${this.identity.displayName} 不支持从 Tick 回到会话（只能看/记）`)
    }
    // 桌面版：没有按会话定位的通道 → 激活 App，并如实说明要自己在列表里点那条会话。
    if (ctx.client === 'desktop' && this.identity.desktopBundleId) {
      const app = await this.desktopApp()
      if (!app) throw new Error(`没找到 ${this.identity.displayName} 桌面版（${this.identity.desktopBundleName ?? 'App'}）`)
      if (!this.deps.activateApp) throw new Error('未注入 activateApp（main 进程需装配 `open -a`）')
      const identity = this.identityNow()
      const opened = await openStore(identity, this.log)
      let row: OpenCodeSessionRow | undefined
      try {
        row = opened ? readSessionRow(opened.db, identity, sessionId, this.log, { withUsage: false }) : undefined
      } finally {
        opened?.cleanup()
      }
      if (!row) throw new Error(`${this.identity.displayName} 会话不存在：${sessionId}`)
      // 归档会话在 CLI 分支会拒；桌面分支（只能开 App）同样不能假装打开
      if (row.archived) throw new Error('这条会话已归档，无法从 Tick 打开；请先在应用里取消归档')
      await this.deps.activateApp(app)
      return {
        toolId: this.id,
        sessionId: newCliSessionId(sessionId),
        cwd: row.cwd && existsSync(row.cwd) ? row.cwd : ctx.cwd,
        delivered: 'none',
        verified: true,
        notice: `已打开 ${this.identity.displayName} 桌面版；它没有「按会话定位」的入口，请在会话列表里选择「${row.title ?? sessionId}」`,
      }
    }
    const exe = await this.resolveExe()
    if (!exe) {
      throw new Error(
        `${this.identity.displayName} 未找到 CLI 可执行文件；桌面版只能打开应用（选「桌面版」入口），CLI 才能真正定位到这条会话`,
      )
    }
    const identity = this.identityNow()
    const opened = await openStore(identity, this.log)
    let row: OpenCodeSessionRow | undefined
    try {
      row = opened ? readSessionRow(opened.db, identity, sessionId, this.log, { withUsage: false }) : undefined
    } finally {
      opened?.cleanup()
    }
    if (!row) throw new Error(`${this.identity.displayName} 会话不存在：${sessionId}`)
    if (row.archived) throw new Error('这条会话已归档，无法从 Tick 打开；请先在应用里取消归档')
    const open = this.deps.openTerminal
    if (!open) throw new Error('未注入终端拉起实现（main 进程装配 openTerminal）')
    const cwd =
      row.cwd && isExistingDirectory(row.cwd)
        ? row.cwd
        : ctx.cwd && isExistingDirectory(ctx.cwd)
          ? ctx.cwd
          : homedir()
    await open({ cwd, executable: exe, args: this.identity.resumeArgs(sessionId) })
    return {
      toolId: this.id,
      sessionId: newCliSessionId(sessionId),
      cwd,
      delivered: 'none',
      verified: true,
    }
  }
}
