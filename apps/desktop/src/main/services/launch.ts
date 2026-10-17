/**
 * LaunchService — 「继续」按钮背后的那一步：决定在哪个目录起 pi，然后绑定回 todo。
 *
 * PRD F4 的三条硬规则都在这里：
 *  1. **项目选填，但 cwd 不可空**：绑定 session 的 cwd → Todo.lastLaunch → home（D18，不猜“最近使用”）
 *  2. **可以免选，不可以隐式**：`resolveCwd()` 必须同时给出项目名，主按钮要显示它
 *  3. **投递默认剪贴板**（可审阅）；argv 立即发送是设置项，不是默认
 *
 * 绑定只在 verify 通过后写（防 0 字节僵尸会话留下假绑定）。
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { LaunchOutcome, LaunchRequest, ResumeRequest } from '@tick/shared'
import { newCliSessionId, type Todo } from '@tick/shared'
import type { LaunchResult } from '@tick/ai-core'
import type { PiAdapter } from '@tick/ai-pi'
import type { TodoStore } from '../store'

export interface ResolvedCwd {
  projectPath: string
  /** 主按钮上必须显示的那个名字 */
  projectName: string
  /** 来源：让 UI 能解释“为什么是这个项目” */
  source: 'bound-session' | 'last-launch' | 'home'
}

export class LaunchService {
  constructor(
    private adapter: PiAdapter,
    private store: TodoStore,
  ) {}

  private todoOf(id: string): Todo {
    const todo = this.store.list().find((t) => t.id === id)
    if (!todo) throw new Error(`todo 不存在: ${id}`)
    return todo
  }

  /**
   * cwd 三级推导（D18）。注意：这里**不问**“最近使用”，那是设置里的可选项，不是默认。
   */
  async resolveCwd(todoId?: string, explicit?: string): Promise<ResolvedCwd> {
    if (explicit) {
      return { projectPath: explicit, projectName: projectName(explicit), source: 'last-launch' }
    }
    if (todoId) {
      const todo = this.todoOf(todoId)
      if (todo.primarySessionId) {
        try {
          const info = await this.adapter.describeSession(todo.primarySessionId)
          if (info?.cwd) {
            return { projectPath: info.cwd, projectName: projectName(info.cwd), source: 'bound-session' }
          }
        } catch {
          /* 会话文件可能已被删：继续往下降级 */
        }
      }
      if (todo.lastLaunch?.projectPath) {
        return {
          projectPath: todo.lastLaunch.projectPath,
          projectName: projectName(todo.lastLaunch.projectPath),
          source: 'last-launch',
        }
      }
    }
    const home = os.homedir()
    return { projectPath: home, projectName: projectName(home), source: 'home' }
  }

  async launch(req: LaunchRequest): Promise<LaunchOutcome> {
    const todo = this.todoOf(req.todoId)
    const resolved = await this.resolveCwd(req.todoId, req.projectPath)
    const sessionId = newCliSessionId(randomUUID())
    const promptText = (req.promptText ?? todo.title).trim()

    let result: LaunchResult
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

    if (req.deliver === 'clipboard' && promptText) {
      // 剪贴板由 adapter 的 clipboardWrite 依赖注入写（main 装配时给的 Electron clipboard）
    }

    // 只有真的产生了 session 才绑定：0 字节僵尸不该进 bindings
    if (!result.verified) {
      return {
        ok: false,
        sessionId: result.sessionId,
        projectPath: resolved.projectPath,
        delivered: result.delivered,
        reason: 'pi 已启动，但这次没有产生会话内容（未绑定）',
      }
    }

    this.store.update(todo.id, {
      addBinding: { toolId: 'pi', sessionId: result.sessionId, boundAt: new Date().toISOString() },
      primarySessionId: result.sessionId,
      lastLaunch: { toolId: 'pi', projectPath: resolved.projectPath },
    })

    return {
      ok: true,
      sessionId: result.sessionId,
      projectPath: resolved.projectPath,
      delivered: result.delivered,
    }
  }

  async resume(req: ResumeRequest): Promise<LaunchOutcome> {
    const cwd = req.projectPath
      ? req.projectPath
      : (await this.adapter.describeSession(req.sessionId).catch(() => undefined))?.cwd ??
        (req.todoId ? (await this.resolveCwd(req.todoId)).projectPath : os.homedir())

    try {
      const result = await this.adapter.resume(req.sessionId, {
        promptText: '',
        cwd,
        sessionId: req.sessionId,
        deliver: 'none',
      })
      if (req.todoId) {
        this.store.update(req.todoId, {
          addBinding: { toolId: 'pi', sessionId: req.sessionId, boundAt: new Date().toISOString() },
          primarySessionId: req.sessionId,
          lastLaunch: { toolId: 'pi', projectPath: cwd },
        })
      }
      return { ok: true, sessionId: result.sessionId, projectPath: cwd, delivered: 'none' }
    } catch (err) {
      return { ok: false, sessionId: req.sessionId, projectPath: cwd, delivered: 'none', reason: (err as Error).message }
    }
  }
}

/**
 * 项目名 = basename；**绝不允许只显示它**（同名目录由 UI 再补父目录片段）。
 * home 是兜底而不是项目：显示成 ~，免得主按钮写成「在 jacky 中打开 pi」。
 */
function projectName(p: string): string {
  if (p === os.homedir()) return '~'
  const base = path.basename(p)
  return base || p
}
