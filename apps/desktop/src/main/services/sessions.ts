/**
 * SessionService — Tick 侧的会话视图（S5 反向建索引 / 多会话绑定 UI）。
 *
 * 分工（TECH-ARCH §6）：
 *  - 会话元数据的权威源是 adapter（listSessionInfos / describeSession）；
 *  - Tick 只持有绑定关系（Todo.bindings），这里把两者拼成 UI 需要的视图，不落镜像。
 */

import type { CliSessionId, SessionView, Todo, TodoSessionView } from '@tick/shared'
import { newCliSessionId } from '@tick/shared'
import type { SessionSummary } from '@tick/ai-core'
import { canonicalPath, gitRootOf } from '@tick/ai-core'
import type { PiAdapter } from '@tick/ai-pi'
import type { TodoStore } from '../store'

const CACHE_MS = 5_000

export interface ClaimResult {
  ok: boolean
  todo?: Todo
  reason?: string
}

export class SessionService {
  private cache?: { at: number; items: SessionSummary[] }

  constructor(
    private adapter: PiAdapter,
    private store: TodoStore,
  ) {}

  /** 会话列表（5s 进程内缓存：S5 反复打开不重复扫 49MB） */
  private async summaries(force = false): Promise<SessionSummary[]> {
    const now = Date.now()
    if (!force && this.cache && now - this.cache.at < CACHE_MS) return this.cache.items
    const items = this.adapter.listSessionInfos
      ? await this.adapter.listSessionInfos()
      : await this.fallbackSummaries()
    this.cache = { at: now, items }
    return items
  }

  /** 兼容只实现了 listSessions 的 adapter（第二工具接入时） */
  private async fallbackSummaries(): Promise<SessionSummary[]> {
    if (!this.adapter.listSessions) return []
    const refs = await this.adapter.listSessions()
    const out: SessionSummary[] = []
    for (const ref of refs) {
      const info = await this.adapter.describeSession?.(ref.sessionId)
      if (!info) continue
      out.push({
        toolId: info.toolId,
        sessionId: info.sessionId,
        cwd: info.cwd,
        name: info.name,
        firstMessage: info.firstMessage,
        createdAt: info.createdAt,
        lastUsedAt: info.lastUsedAt,
        filePath: info.filePath ?? '',
        exists: info.exists,
        parentSessionPath: info.parentSessionPath,
      })
    }
    return out
  }

  async invalidate(): Promise<void> {
    this.cache = undefined
  }

  /** 全部会话（S5 用 unboundOnly；默认项目预筛用 projectPath） */
  async list(opts: { unboundOnly?: boolean; projectPath?: string } = {}): Promise<SessionView[]> {
    const summaries = await this.summaries()
    const todos = this.store.list()
    const bound = new Map<string, Todo>()
    for (const todo of todos) {
      for (const b of todo.bindings) bound.set(b.sessionId, todo)
    }
    const wantProject = opts.projectPath ? canonicalPath(opts.projectPath) : undefined
    // 项目过滤与项目索引同口径：cwd 是仓库子目录（monorepo）的会话要上卷到 git 根再比
    const gitRoots = new Map<string, string | undefined>()
    const matchesProject = (cwd: string): boolean => {
      const canonical = canonicalPath(cwd)
      if (canonical === wantProject) return true
      if (!gitRoots.has(canonical)) gitRoots.set(canonical, gitRootOf(canonical) ?? undefined)
      return gitRoots.get(canonical) === wantProject
    }
    const views: SessionView[] = []
    for (const s of summaries) {
      if (wantProject && !matchesProject(s.cwd)) continue
      const owner = bound.get(s.sessionId)
      if (opts.unboundOnly && owner) continue
      views.push({
        toolId: s.toolId,
        sessionId: s.sessionId,
        cwd: s.cwd,
        name: s.name,
        firstMessage: s.firstMessage,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        filePath: s.filePath,
        exists: s.exists,
        boundTodoId: owner?.id,
        boundTodoTitle: owner?.title,
      })
    }
    return views
  }

  /** 某条 todo 下的会话（绑定详情）；会话被删也能返回 missing 占位 */
  async forTodo(todoId: string): Promise<TodoSessionView[]> {
    const todo = this.store.list().find((t) => t.id === todoId)
    if (!todo) return []
    const out: TodoSessionView[] = []
    for (const binding of todo.bindings) {
      const info = await this.adapter.describeSession(binding.sessionId).catch(() => undefined)
      const missing = !info
      out.push({
        toolId: binding.toolId,
        sessionId: binding.sessionId,
        cwd: info?.cwd ?? '',
        name: info?.name,
        firstMessage: info?.firstMessage,
        lastMessage: info?.lastMessage,
        createdAt: info?.createdAt ?? binding.boundAt,
        lastUsedAt: info?.lastUsedAt,
        filePath: info?.filePath ?? binding.filePath ?? '',
        exists: Boolean(info),
        boundAt: binding.boundAt,
        state: binding.state,
        primary: todo.primarySessionId === binding.sessionId,
        missing,
        boundTodoId: todo.id,
        boundTodoTitle: todo.title,
      })
    }
    // primary 在前，其余按最后使用时间倒序
    out.sort((a, b) => Number(b.primary) - Number(a.primary) || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    return out
  }

  /** S5：用一条历史会话建 todo 并绑定（不批量自动生成） */
  async claim(sessionId: CliSessionId): Promise<ClaimResult> {
    const summaries = await this.summaries()
    const s = summaries.find((x) => x.sessionId === sessionId)
    if (!s) return { ok: false, reason: '会话已不在本机' }

    const owner = this.store.findTodoBySession(sessionId)
    if (owner) {
      return { ok: false, todo: owner, reason: `这条会话已绑定到「${owner.title}」` }
    }

    const title = (s.name ?? s.firstMessage ?? `会话 ${sessionId.slice(0, 8)}`).trim()
    const todo = this.store.create({ title })
    const now = new Date().toISOString()
    try {
      this.store.update(todo.id, {
        addBinding: {
          toolId: s.toolId,
          sessionId,
          boundAt: now,
          state: 'verified',
          filePath: s.filePath,
        },
        primarySessionId: sessionId,
        lastLaunch: { toolId: s.toolId, projectPath: s.cwd, launchedAt: now },
      })
    } catch (err) {
      // create 与 update 是两次加锁：中间被并发抢先绑定时，store 会拒绝（规则 4）而不是产生双绑定
      return { ok: false, reason: (err as Error).message }
    }
    this.cache = undefined
    return { ok: true, todo: this.store.list().find((t) => t.id === todo.id) }
  }

  /** 把历史会话绑到已有 todo（多会话绑定 UI / S5 从 todo 进入） */
  async bind(todoId: string, sessionId: CliSessionId): Promise<ClaimResult> {
    const todo = this.store.list().find((t) => t.id === todoId)
    if (!todo) return { ok: false, reason: 'todo 不存在' }
    const owner = this.store.findTodoBySession(sessionId)
    if (owner && owner.id !== todoId) {
      return { ok: false, todo: owner, reason: `这条会话已绑定到「${owner.title}」` }
    }
    const summaries = await this.summaries()
    const s = summaries.find((x) => x.sessionId === sessionId)
    if (!s) return { ok: false, reason: '会话已不在本机' }

    const now = new Date().toISOString()
    try {
      this.store.update(todoId, {
        addBinding: {
          toolId: s.toolId,
          sessionId,
          boundAt: now,
          state: 'verified',
          filePath: s.filePath,
        },
        primarySessionId: sessionId,
        lastLaunch: { toolId: s.toolId, projectPath: s.cwd, launchedAt: now },
      })
    } catch (err) {
      // store 在锁内查重（规则 4）：并发 bind 的后到者在这里被拒，而不是双写
      return { ok: false, reason: (err as Error).message }
    }
    this.cache = undefined
    return { ok: true, todo: this.store.list().find((t) => t.id === todoId) }
  }

  /** 切换默认 resume 的会话（不改其他绑定） */
  setPrimary(todoId: string, sessionId: CliSessionId): Todo | undefined {
    const todo = this.store.list().find((t) => t.id === todoId)
    if (!todo || !todo.bindings.some((b) => b.sessionId === sessionId)) return undefined
    return this.store.update(todoId, { primarySessionId: sessionId })
  }

  /** 解绑（不动会话文件；若删的是 primary，自动退到剩余第一条） */
  unbind(todoId: string, sessionId: CliSessionId): boolean {
    this.cache = undefined
    return this.store.removeBinding(todoId, sessionId)
  }

  sessionIdOf(raw: string): CliSessionId {
    return newCliSessionId(raw)
  }
}
