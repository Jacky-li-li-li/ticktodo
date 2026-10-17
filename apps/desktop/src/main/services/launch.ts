/**
 * LaunchService — 「继续」按钮背后的那一步：决定在哪个目录起 pi，然后绑定回 todo。
 *
 * PRD F4 的硬规则都在这里：
 *  1. **项目选填，但 cwd 不可空**：绑定 session 的 cwd → Todo.lastLaunch → home（D18，不猜“最近使用”）
 *  2. **可以免选，不可以隐式**：`resolveCwd()` 必须同时给出项目名，主按钮要显示它
 *  3. **投递默认剪贴板**（可审阅）；argv 立即发送是设置项，不是默认
 *
 * 拉起语义（M1/M2 修复）：
 *  - adapter 在**终端**里打开 pi（不是 headless spawn），会话文件要等用户在 pi 里发送第一条消息才出现；
 *    所以绑定先写 `pending`，再由 `reconcilePending()` 后台对账转 `verified`。
 *  - 记忆/绑定的目录若已失效（stale），退回主目录并在 `degraded` 里给出原因（验收 4.2）。
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type {
  AppSettings,
  LaunchOutcome,
  LaunchRequest,
  ResumeRequest,
  SessionBinding,
} from '@tick/shared'
import { newCliSessionId, type Todo } from '@tick/shared'
import { canonicalPath } from '@tick/ai-core'
import type { PiAdapter } from '@tick/ai-pi'
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
  /** 失效目录的重新定位映射（F3：只映射，不动 pi 的会话文件） */
  resolveAlias?: (projectPath: string) => string | undefined
}

export class LaunchService {
  constructor(
    private adapter: PiAdapter,
    private store: TodoStore,
    private opts: LaunchServiceOptions,
  ) {}

  private todoOf(id: string): Todo {
    const todo = this.store.list().find((t) => t.id === id)
    if (!todo) throw new Error(`todo 不存在: ${id}`)
    return todo
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

      // ① 已绑定 session 的 cwd（adapter 是权威源）
      if (todo.primarySessionId) {
        try {
          const info = await this.adapter.describeSession(todo.primarySessionId, { withName: false })
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
    const resolved = await this.resolveCwd(req.todoId, req.projectPath)
    const sessionId = newCliSessionId(randomUUID())
    const promptText = (req.promptText ?? todo.title).trim()

    let result
    try {
      result = await this.adapter.launch({
        promptText,
        cwd: resolved.projectPath,
        sessionId,
        name: todo.title.slice(0, 80),
        deliver: req.deliver,
      })
    } catch (err) {
      return {
        ok: false,
        projectPath: resolved.projectPath,
        delivered: req.deliver,
        reason: (err as Error).message,
      }
    }

    // 终端已打开 = 成功；session 文件晚一点出现（剪贴板模式下要等用户发送）→ pending 绑定
    const state: SessionBinding['state'] = result.verified ? 'verified' : 'pending'
    const info = result.verified
      ? await this.adapter.describeSession(result.sessionId, { withName: false }).catch(() => undefined)
      : undefined
    this.store.update(todo.id, {
      addBinding: {
        toolId: 'pi',
        sessionId: result.sessionId,
        boundAt: new Date().toISOString(),
        state,
        filePath: info?.filePath,
      },
      primarySessionId: result.sessionId,
      lastLaunch: {
        toolId: 'pi',
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
    }
  }

  async resume(req: ResumeRequest): Promise<LaunchOutcome> {
    const todo = req.todoId ? this.todoOf(req.todoId) : undefined
    // 业务规则 4：一个 session 最多绑一个 todo；已归属别的 todo 时不要偷偷重复绑定
    if (todo) {
      const owner = this.store.findTodoBySession(req.sessionId)
      if (owner && owner.id !== todo.id) {
        return {
          ok: false,
          sessionId: req.sessionId,
          delivered: 'none',
          reason: `这条会话已绑定到「${owner.title}」`,
        }
      }
    }
    const info = await this.adapter.describeSession(req.sessionId, { withName: false }).catch(() => undefined)

    // pending 会话：用户还没在 pi 里发送过第一条消息 → 没有 session 文件。
    // 重新打开终端（同一 session id），不要新建另一个绑定。
    if (!info) {
      if (!todo) {
        return {
          ok: false,
          sessionId: req.sessionId,
          delivered: 'none',
          reason: '会话文件还不存在（可能还没在 pi 中发送第一条消息）',
        }
      }
      const resolved = await this.resolveCwd(todo.id, req.projectPath)
      try {
        await this.adapter.launch({
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
          toolId: 'pi',
          sessionId: req.sessionId,
          boundAt: new Date().toISOString(),
          state: 'pending',
        },
        primarySessionId: req.sessionId,
        lastLaunch: { toolId: 'pi', projectPath: resolved.projectPath, launchedAt: new Date().toISOString() },
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
      const result = await this.adapter.resume(req.sessionId, {
        promptText: '',
        cwd,
        sessionId: req.sessionId,
        deliver: 'none',
      })
      if (todo) {
        this.store.update(todo.id, {
          addBinding: {
            toolId: 'pi',
            sessionId: req.sessionId,
            boundAt: new Date().toISOString(),
            state: 'verified',
            filePath: info.filePath,
          },
          primarySessionId: req.sessionId,
          lastLaunch: { toolId: 'pi', projectPath: cwd, launchedAt: new Date().toISOString() },
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
   * pending 绑定对账：终端里的 pi 产生会话文件后，把绑定从 pending 改成 verified。
   * 返回本次改动的条数（0 = 没有 pending 或都还没产生）。
   */
  async reconcilePending(): Promise<number> {
    let changed = 0
    for (const todo of this.store.list()) {
      for (const binding of todo.bindings) {
        if (binding.state !== 'pending') continue
        let verified = false
        try {
          verified = await this.adapter.verify(binding.sessionId, { retries: 0, intervalMs: 0 })
        } catch {
          verified = false
        }
        if (!verified) continue
        const info = await this.adapter
          .describeSession(binding.sessionId, { withName: false })
          .catch(() => undefined)
        if (this.store.markBinding(binding.sessionId, 'verified', info?.filePath)) changed++
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
