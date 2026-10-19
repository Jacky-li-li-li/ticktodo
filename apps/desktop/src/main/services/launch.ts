/**
 * LaunchService — 「继续」按钮背后的那一步：决定用哪个工具、在哪个目录起会话，然后绑定回 todo。
 *
 * PRD F4 的硬规则都在这里：
 *  1. **项目选填，但 cwd 不可空**：绑定 session 的 cwd → Todo.lastLaunch → home（D18，不猜“最近使用”）
 *  2. **可以免选，不可以隐式**：`resolveCwd()` 必须同时给出项目名，主按钮要显示它
 *  3. **投递默认预填**（可审阅，用户回车才发）；argv 立即发送是设置项，不是默认
 *
 * 拉起语义（M1/M2 修复）：
 *  - CLI adapter 在**终端**里打开工具（不是 headless spawn），会话文件要等用户在工具里发送第一条消息才出现；
 *    所以绑定先写 `pending`，再由 `reconcilePending()` 后台对账转 `verified`。
 *  - 记忆/绑定的目录若已失效（stale），退回主目录并在 `degraded` 里给出原因（验收 4.2）。
 *
 * 多工具（M5）：所有路由都以 `toolId` 为键（`LaunchRequest.toolId` → `Todo.bindings[].toolId` →
 * 默认可拉起 adapter），绑定/lastLaunch 里写的一律是 `adapter.id`。新建会话由 `newSessionMode`
 * 决定：`launch` 才走预生成 id + 绑定；`prefill` 只打开 GUI 新建页（`openNewSessionPage`），
 * 没有 pending 重新拉起分支——info 不存在就是失败，不许拿 pi 的兜底顶替。
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type {
  AppSettings,
  LaunchOutcome,
  LaunchRequest,
  PrefillNewSessionOutcome,
  PrefillNewSessionRequest,
  ResumeRequest,
  SessionBinding,
} from '@tick/shared'
import { newCliSessionId, toolDisplayName, type CliSessionId, type Todo } from '@tick/shared'
import { canonicalPath, type AiToolAdapter, type SessionInfo } from '@tick/ai-core'
import type { TodoStore } from '../store'

export type CwdSource = 'bound-session' | 'last-launch' | 'home' | 'explicit' | 'recent'
export type CwdDegraded = 'bound-session-missing' | 'last-launch-missing' | 'explicit-missing'

export interface ResolvedCwd {
  projectPath: string
  /** 主按钮上必须显示的那个名字 */
  projectName: string
  /** 来源：让 UI 能解释“为什么是这个项目” */
  source: CwdSource
  /** 非空 = 记忆/指定的目录已失效，已退回 home；UI 必须提示 */
  degraded?: CwdDegraded
  /** true = 设置里选了「每次必问」：UI 必须先让用户选一个项目才能拉起 */
  mustAsk?: boolean
}

export interface LaunchServiceOptions {
  settings: () => AppSettings
  /** 默认项目 = recent 时的候选（ProjectIndex 最近使用且非 stale 的项，不含 home） */
  recentProject?: () => string | undefined
  /** 失效目录的重新定位映射（F3：只映射，不动工具自己的会话文件） */
  resolveAlias?: (projectPath: string) => string | undefined
}

/** 桌面工具不能走 launch（预生成 id + 绑定）时的统一提示；UI 只按 newSessionMode 过滤，这里是最后一道兜底 */
const DESKTOP_TOOL_REASON =
  '该工具是桌面应用，不能从 Tick 直接新建并绑定；请用「打开新建页」或先在应用里开始会话，再用「倒入历史会话」绑定'

export class LaunchService {
  private adapters: AiToolAdapter[]

  constructor(
    adapters: AiToolAdapter[],
    private store: TodoStore,
    private opts: LaunchServiceOptions,
  ) {
    this.adapters = adapters
  }

  private todoOf(id: string): Todo {
    const todo = this.store.list().find((t) => t.id === id)
    if (!todo) throw new Error(`todo 不存在: ${id}`)
    return todo
  }

  private adapterById(id: string | undefined): AiToolAdapter | undefined {
    return id ? this.adapters.find((a) => a.id === id) : undefined
  }

  /**
   * 默认可拉起工具：pi 优先（历史行为/旧数据的默认工具），否则任一声明 newSessionMode='launch' 的工具。
   */
  private defaultLaunchAdapter(): AiToolAdapter | undefined {
    const pi = this.adapterById('pi')
    if (pi?.capabilities.newSessionMode === 'launch') return pi
    return this.adapters.find((a) => a.capabilities.newSessionMode === 'launch')
  }

  /**
   * 读某个 todo 里某条会话的权威元数据。
   * 先按 `binding.toolId` 精确路由；只有「按 id 找不到 adapter」（工具下线/旧数据缺字段）时才逐个探测。
   * 不做全局 sessionId → 工具的假设：不同工具的 id 空间互不相干。
   */
  private async describeByBinding(
    todo: Todo | undefined,
    sessionId: CliSessionId,
  ): Promise<{ adapter: AiToolAdapter; info?: SessionInfo } | undefined> {
    const binding = todo?.bindings.find((b) => b.sessionId === sessionId)
    const direct = this.adapterById(binding?.toolId)
    if (direct) {
      const info = await direct
        .describeSession?.(sessionId, { withName: false })
        .catch(() => undefined)
      return { adapter: direct, info }
    }
    for (const adapter of this.adapters) {
      if (!adapter.describeSession) continue
      const info = await adapter
        .describeSession(sessionId, { withName: false })
        .catch(() => undefined)
      if (info) return { adapter, info }
    }
    return undefined
  }

  /**
   * cwd 三级推导（D18）+ stale 降级（验收 4.2）。
   * 注意：这里**不问**“最近使用”，那是设置里的可选项，不是默认。
   */
  async resolveCwd(todoId?: string, explicit?: string): Promise<ResolvedCwd> {
    if (explicit && explicit.trim()) {
      const p = explicit.trim()
      if (existsSync(p)) return resolveExisting(p, 'explicit')
      return homeResolved('explicit-missing')
    }

    if (todoId) {
      const todo = this.todoOf(todoId)
      const setting = this.opts.settings().defaultProject

      // 「每次必问」：跳过 ①/②/③，强制走选择器（PRD F4-b）
      if (setting === 'ask') return { ...homeResolved(), mustAsk: true }

      let degraded: CwdDegraded | undefined

      // ① 已绑定 session 的 cwd（会话所属工具的 adapter 是权威源）
      if (todo.primarySessionId) {
        try {
          const hit = await this.describeByBinding(todo, todo.primarySessionId)
          const info = hit?.info
          if (info?.cwd) {
            if (existsSync(info.cwd)) return resolveExisting(info.cwd, 'bound-session')
            const alias = this.opts.resolveAlias?.(info.cwd)
            if (alias && existsSync(alias)) return resolveExisting(alias, 'bound-session')
            degraded = 'bound-session-missing'
          } else {
            degraded = 'bound-session-missing'
          }
        } catch {
          degraded = 'bound-session-missing'
        }
      }

      // ② 上次用户显式选过的工具 + 目录
      if (todo.lastLaunch?.projectPath) {
        if (existsSync(todo.lastLaunch.projectPath)) return resolveExisting(todo.lastLaunch.projectPath, 'last-launch')
        const alias = this.opts.resolveAlias?.(todo.lastLaunch.projectPath)
        if (alias && existsSync(alias)) return resolveExisting(alias, 'last-launch')
        degraded = degraded ?? 'last-launch-missing'
      }

      // ③ 兜底：设置「最近使用」或 home（D18 默认 home，不猜）
      if (setting === 'recent') {
        const recent = this.opts.recentProject?.()
        if (recent && existsSync(recent)) return resolveExisting(recent, 'recent')
      }
      return homeResolved(degraded)
    }

    return homeResolved()
  }

  async launch(req: LaunchRequest): Promise<LaunchOutcome> {
    const todo = this.todoOf(req.todoId)
    const adapter = req.toolId ? this.adapterById(req.toolId) : this.defaultLaunchAdapter()
    if (!adapter) {
      return {
        ok: false,
        delivered: req.deliver,
        reason: req.toolId ? `未注册的工具：${req.toolId}` : '没有可新建会话的工具',
      }
    }
    // 只有 launch 模式能「预生成 id + 写绑定」；prefill 模式走 openNewSessionPage，不能混用
    if (adapter.capabilities.newSessionMode !== 'launch') {
      return { ok: false, delivered: req.deliver, reason: DESKTOP_TOOL_REASON }
    }
    // 未安装时不要假装成功（Q14 双出口空态）；detect 自身异常也要兜成原因。
    // 不再判断版本（2026-10-19 移除）：装了就让调用发生，版本差异由真实失败如实暴露。
    const detected = await adapter
      .detect()
      .catch((e): { installed: boolean; reason: string } => ({
        installed: false,
        reason: (e as Error).message,
      }))
    if (!detected.installed) {
      return {
        ok: false,
        delivered: req.deliver,
        reason: detected.reason ?? `${toolDisplayName(adapter.id)} 当前不可用`,
      }
    }

    const resolved = await this.resolveCwd(req.todoId, req.projectPath)
    const sessionId = newCliSessionId(randomUUID())
    const promptText = (req.promptText ?? todo.title).trim()
    // 只向「更不自动」方向降级：prefill → clipboard；argv 不可用必须明确失败，
    // 否则 UI 写着「不自动发送」却可能真的发出去（或反过来）。
    const supported = adapter.capabilities.deliverPrompt
    let deliver = req.deliver
    if (!supported.includes(deliver)) {
      if (deliver === 'argv') {
        return {
          ok: false,
          delivered: 'argv',
          reason: `${toolDisplayName(adapter.id)} 不支持直接发送，请取消勾选后重试`,
        }
      }
      if (deliver === 'prefill' && supported.includes('clipboard')) {
        deliver = 'clipboard' // 只向「不自动发送」方向降级
      } else if (deliver === 'clipboard' && supported.includes('prefill')) {
        deliver = 'prefill'
      } else {
        return {
          ok: false,
          delivered: req.deliver,
          reason: `${toolDisplayName(adapter.id)} 不支持该投递方式`,
        }
      }
    }

    let result
    try {
      result = await adapter.launch({
        promptText,
        cwd: resolved.projectPath,
        sessionId,
        name: todo.title.slice(0, 80),
        deliver,
      })
    } catch (err) {
      return {
        ok: false,
        projectPath: resolved.projectPath,
        delivered: deliver,
        reason: (err as Error).message,
      }
    }

    // 终端已打开 = 成功；预填/剪贴板下会话文件要等用户发送才出现 → pending 绑定
    const state: SessionBinding['state'] = result.verified ? 'verified' : 'pending'
    const info = result.verified
      ? await adapter
          .describeSession?.(result.sessionId, { withName: false })
          .catch(() => undefined)
      : undefined
    this.store.update(todo.id, {
      addBinding: {
        // 绑定属于「实际拉起它的工具」，不写死任何工具 id
        toolId: adapter.id,
        sessionId: result.sessionId,
        boundAt: new Date().toISOString(),
        state,
        filePath: info?.filePath,
      },
      primarySessionId: result.sessionId,
      lastLaunch: {
        toolId: adapter.id,
        projectPath: resolved.projectPath,
        launchedAt: new Date().toISOString(),
      },
    })

    return {
      ok: true,
      sessionId: result.sessionId,
      projectPath: resolved.projectPath,
      delivered: result.delivered,
      pending: !result.verified,
      ...(result.notice ? { notice: result.notice } : {}),
    }
  }

  /**
   * 桌面工具：打开它的 GUI「新建会话/任务」页并预填文案 + 项目。
   *
   * 这不是 launch：不预生成 sessionId、不投递、不写 binding/lastLaunch，
   * 发送动作留给用户在工具里完成；之后仍走「倒入历史会话」建立绑定。
   * 项目推导复用 resolveCwd（绑定会话 cwd → lastLaunch → home），与「新建会话」同一口径。
   */
  async prefillNewSession(req: PrefillNewSessionRequest): Promise<PrefillNewSessionOutcome> {
    let todo: Todo
    try {
      todo = this.todoOf(req.todoId)
    } catch (e) {
      return { ok: false, reason: `线索不存在或已删除：${(e as Error).message}` }
    }
    const adapter = this.adapterById(req.toolId)
    if (!adapter) return { ok: false, reason: `未注册的工具：${req.toolId}` }
    if (adapter.capabilities.newSessionMode !== 'prefill' || !adapter.openNewSessionPage) {
      return {
        ok: false,
        reason: `${toolDisplayName(adapter.id)} 不支持打开新建会话页`,
      }
    }
    const detected = await adapter.detect().catch(() => undefined)
    if (detected && !detected.installed) {
      return { ok: false, reason: detected.reason ?? `${toolDisplayName(adapter.id)} 当前不可用` }
    }

    const resolved = await this.resolveCwd(req.todoId, req.projectPath)
    const promptText = (req.promptText ?? todo.title).trim() || todo.title
    try {
      const result = await adapter.openNewSessionPage({ promptText, cwd: resolved.projectPath })
      return { ...result, cwd: resolved.projectPath }
    } catch (e) {
      return {
        ok: false,
        reason: `打开 ${toolDisplayName(adapter.id)} 新建页失败：${(e as Error).message}`,
        cwd: resolved.projectPath,
      }
    }
  }

  async resume(req: ResumeRequest): Promise<LaunchOutcome> {
    const todo = req.todoId ? this.todoOf(req.todoId) : undefined
    // 业务规则 4：一个 session 最多绑一个 todo；已归属别的 todo 时不要偷偷重复绑定
    if (todo) {
      const owner = this.store.findTodoBySession(req.sessionId, req.toolId)
      if (owner && owner.id !== todo.id) {
        return {
          ok: false,
          sessionId: req.sessionId,
          delivered: 'none',
          reason: `这条会话已绑定到「${owner.title}」`,
        }
      }
    }

    // 路由顺序：显式 toolId → todo.bindings 里该 sessionId 的 toolId。
    // 无法确定所属工具时必须 fail-closed：不同工具的 id 空间互不相干，拿 pi 去打开
    // WorkBuddy 的会话会让 pi 在新 cwd 里静默新建一个同 id 会话（错误工具 + 错误绑定）。
    const bindingToolId = todo?.bindings.find(
      (b) => b.sessionId === req.sessionId && (!req.toolId || b.toolId === req.toolId),
    )?.toolId
    const adapter = req.toolId ? this.adapterById(req.toolId) : this.adapterById(bindingToolId)
    if (!adapter) {
      return {
        ok: false,
        sessionId: req.sessionId,
        delivered: 'none',
        reason: req.toolId
          ? `未注册的工具：${req.toolId}`
          : '无法确定这条会话属于哪个工具；请从对应工具的会话列表打开',
      }
    }
    if (!adapter.capabilities.resumeSession) {
      return {
        ok: false,
        sessionId: req.sessionId,
        delivered: 'none',
        reason: `${toolDisplayName(adapter.id)} 不支持从 Tick 回到会话`,
      }
    }

    const info = await adapter
      .describeSession?.(req.sessionId, { withName: false })
      .catch(() => undefined)

    // pending 会话：用户还没在工具里发送过第一条消息 → 没有 session 文件。
    // 只有 newSessionMode='launch' 的 CLI 工具才有这条通路：重新打开终端（同一 session id），不新建绑定。
    if (!info) {
      // 桌面工具没有「重新拉起同一 id」的通路：绝不能回落到 launch 重建绑定，直接给原因（失败降级）
      if (adapter.capabilities.newSessionMode !== 'launch') {
        const detected = await adapter.detect().catch(() => undefined)
        return {
          ok: false,
          sessionId: req.sessionId,
          delivered: 'none',
          reason:
            detected && !detected.installed
              ? (detected.reason ?? `${toolDisplayName(adapter.id)} 当前不可用`)
              : `在 ${toolDisplayName(adapter.id)} 里找不到这条会话（可能已删除，或应用还没写入本地记录）`,
        }
      }
      if (!todo) {
        return {
          ok: false,
          sessionId: req.sessionId,
          delivered: 'none',
          reason: `会话文件还不存在（可能还没在 ${toolDisplayName(adapter.id)} 中发送第一条消息）`,
        }
      }
      const resolved = await this.resolveCwd(todo.id, req.projectPath)
      try {
        await adapter.launch({
          promptText: '',
          cwd: resolved.projectPath,
          sessionId: req.sessionId,
          name: todo.title.slice(0, 80),
          deliver: 'none',
        })
      } catch (err) {
        return {
          ok: false,
          sessionId: req.sessionId,
          projectPath: resolved.projectPath,
          delivered: 'none',
          reason: (err as Error).message,
        }
      }
      this.store.update(todo.id, {
        addBinding: {
          toolId: adapter.id,
          sessionId: req.sessionId,
          boundAt: new Date().toISOString(),
          state: 'pending',
        },
        primarySessionId: req.sessionId,
        lastLaunch: { toolId: adapter.id, projectPath: resolved.projectPath, launchedAt: new Date().toISOString() },
      })
      return {
        ok: true,
        sessionId: req.sessionId,
        projectPath: resolved.projectPath,
        delivered: 'none',
        pending: true,
      }
    }

    // 会话文件已存在：cwd 以会话自身为准；目录失效时查重新定位映射，再退回 renderer 选择/home
    const alias = info.cwd ? this.opts.resolveAlias?.(info.cwd) : undefined
    const cwd =
      info.cwd && existsSync(info.cwd)
        ? canonicalPath(info.cwd)
        : alias && existsSync(alias)
          ? canonicalPath(alias)
          : req.projectPath && existsSync(req.projectPath)
            ? canonicalPath(req.projectPath)
            : os.homedir()

    try {
      const result = await adapter.resume(req.sessionId, {
        promptText: '',
        cwd,
        sessionId: req.sessionId,
        deliver: 'none',
      })
      if (todo) {
        this.store.update(todo.id, {
          addBinding: {
            toolId: adapter.id,
            sessionId: req.sessionId,
            boundAt: new Date().toISOString(),
            state: 'verified',
            filePath: info.filePath,
          },
          primarySessionId: req.sessionId,
          lastLaunch: { toolId: adapter.id, projectPath: cwd, launchedAt: new Date().toISOString() },
        })
      }
      return { ok: true, sessionId: result.sessionId, projectPath: cwd, delivered: 'none' }
    } catch (err) {
      return {
        ok: false,
        sessionId: req.sessionId,
        projectPath: cwd,
        delivered: 'none',
        reason: (err as Error).message,
      }
    }
  }

  /**
   * pending 绑定对账：终端里的 CLI 产生会话文件后，把绑定从 pending 改成 verified。
   * 按 `binding.toolId` 路由；桌面工具没有 `verify`（本来也不会产生 pending 绑定）→ 跳过。
   * 返回本次改动的条数（0 = 没有 pending 或都还没产生）。
   */
  async reconcilePending(): Promise<number> {
    let changed = 0
    for (const todo of this.store.list()) {
      for (const binding of todo.bindings) {
        if (binding.state !== 'pending') continue
        const adapter = this.adapterById(binding.toolId)
        if (!adapter) continue
        const verify = adapter.verify?.bind(adapter)
        if (!verify) continue
        let verified = false
        try {
          verified = await verify(binding.sessionId, { retries: 0, intervalMs: 0 })
        } catch {
          verified = false
        }
        if (!verified) continue
        const info = await adapter
          .describeSession?.(binding.sessionId, { withName: false })
          .catch(() => undefined)
        if (this.store.markBinding(binding.sessionId, 'verified', info?.filePath, binding.toolId)) changed++
      }
    }
    return changed
  }
}

function resolveExisting(projectPath: string, source: CwdSource): ResolvedCwd {
  const canonical = canonicalPath(projectPath)
  return { projectPath: canonical, projectName: projectName(canonical), source }
}

function homeResolved(degraded?: CwdDegraded): ResolvedCwd {
  const home = canonicalPath(os.homedir())
  return { projectPath: home, projectName: '~', source: 'home', degraded }
}

/**
 * 项目名 = basename；**绝不允许只显示它**（同名目录由 UI 再补父目录片段）。
 * home 是兜底而不是项目：显示成 ~，免得主按钮写成「在 jacky 中打开 pi」。
 */
function projectName(p: string): string {
  if (p === os.homedir() || p === canonicalPath(os.homedir())) return '~'
  const base = path.basename(p)
  return base || p
}
