/**
 * SessionService — Tick 侧的会话视图（S5 反向建索引 / 多会话绑定 UI）。
 *
 * 分工（TECH-ARCH §6）：
 *  - 会话元数据的权威源是 adapter（listSessionInfos / describeSession）；
 *  - Tick 只持有绑定关系（Todo.bindings），这里把两者拼成 UI 需要的视图，不落镜像。
 *
 * 多工具（M5）：每行会话自带 toolId，读会话必须按 **binding 里的 toolId** 路由到 adapter，
 * 不用 sessionId 全局反查再猜工具——不同工具的 id 命名空间互不相干（合同 §1）。
 */

import type { CliSessionId, SessionBinding, SessionView, Todo, TodoSessionView } from '@tick/shared'
import { newCliSessionId } from '@tick/shared'
import type { AiToolAdapter, SessionInfo, SessionSummary } from '@tick/ai-core'
import { canonicalPath } from '@tick/ai-core'
import type { TodoStore } from '../store'

const CACHE_MS = 5_000

export interface ClaimResult {
  ok: boolean
  todo?: Todo
  reason?: string
}

export class SessionService {
  private cache?: { at: number; items: SessionSummary[] }
  private adapters: AiToolAdapter[]

  constructor(adapters: AiToolAdapter[], private store: TodoStore) {
    this.adapters = adapters
  }

  /** 会话列表（5s 进程内缓存：S5 反复打开不重复扫 49MB） */
  private async summaries(force = false): Promise<SessionSummary[]> {
    const now = Date.now()
    if (!force && this.cache && now - this.cache.at < CACHE_MS) return this.cache.items
    const items: SessionSummary[] = []
    for (const adapter of this.adapters) {
      // 单个工具读失败只丢它自己：另一个工具的会话不能因此整列变空（规则 §7 失败降级）
      try {
        if (adapter.listSessionInfos) items.push(...(await adapter.listSessionInfos()))
        else if (adapter.listSessions) items.push(...(await this.fallbackSummaries(adapter)))
      } catch (e) {
        console.warn(`[tick] ${adapter.id} 会话列表读取失败:`, (e as Error).message)
      }
    }
    items.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    this.cache = { at: now, items }
    return items
  }

  /** 兼容只实现了 listSessions 的 adapter（新实现优先 listSessionInfos） */
  private async fallbackSummaries(adapter: AiToolAdapter): Promise<SessionSummary[]> {
    if (!adapter.listSessions) return []
    const refs = await adapter.listSessions()
    const out: SessionSummary[] = []
    for (const ref of refs) {
      const info = await adapter.describeSession?.(ref.sessionId)
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
    const views: SessionView[] = []
    for (const s of summaries) {
      if (wantProject && canonicalPath(s.cwd) !== wantProject) continue
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
        // 缺省 = 可回到；只有工具明确否定（如桌面端 playground 会话）才置灰
        resumable: s.resumable,
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
      const hit = await this.describeBinding(binding)
      const info = hit?.info
      const missing = !info
      out.push({
        // 工具侧现状优先（历史数据可能没有 toolId，或工具包被重命名）
        toolId: info?.toolId ?? hit?.adapter.id ?? binding.toolId,
        sessionId: binding.sessionId,
        cwd: info?.cwd ?? '',
        name: info?.name,
        firstMessage: info?.firstMessage,
        lastMessage: info?.lastMessage,
        createdAt: info?.createdAt ?? binding.boundAt,
        lastUsedAt: info?.lastUsedAt,
        filePath: info?.filePath ?? binding.filePath ?? '',
        exists: Boolean(info),
        // info 都读不到时没有「能不能回」的信息，交给 missing 表达（UI 已禁 resume）
        resumable: info ? info.resumable !== false : undefined,
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

  /**
   * 读一条绑定会话的权威元数据。
   * 先按 binding.toolId 精确路由；只有「按 id 找不到 adapter」（工具下线/旧数据缺字段）时
   * 才逐个探测——反过来先全局探测会把同 id 的会话认成别的工具。
   */
  private async describeBinding(
    binding: SessionBinding,
  ): Promise<{ adapter: AiToolAdapter; info?: SessionInfo } | undefined> {
    const direct = this.adapters.find((a) => a.id === binding.toolId)
    if (direct) {
      const info = await direct.describeSession?.(binding.sessionId).catch(() => undefined)
      return { adapter: direct, info }
    }
    for (const adapter of this.adapters) {
      const info = await adapter.describeSession?.(binding.sessionId).catch(() => undefined)
      if (info) return { adapter, info }
    }
    return undefined
  }

  /** S5：用一条历史会话建 todo 并绑定（不批量自动生成） */
  async claim(sessionId: CliSessionId, toolId?: string): Promise<ClaimResult> {
    const summary = await this.findSummary(sessionId, toolId)
    if (!summary) return { ok: false, reason: '会话已不在本机' }

    const owner = this.store.findTodoBySession(sessionId, summary.toolId)
    if (owner) {
      return { ok: false, todo: owner, reason: `这条会话已绑定到「${owner.title}」` }
    }

    const title = (summary.name ?? summary.firstMessage ?? `会话 ${sessionId.slice(0, 8)}`).trim()
    const todo = this.store.create({ title })
    const now = new Date().toISOString()
    try {
      this.store.update(todo.id, {
        addBinding: {
          toolId: summary.toolId,
          sessionId,
          boundAt: now,
          state: 'verified',
          filePath: summary.filePath,
        },
        primarySessionId: sessionId,
        lastLaunch: { toolId: summary.toolId, projectPath: summary.cwd, launchedAt: now },
      })
    } catch (err) {
      // create 与 update 两次加锁：中间被并发抢先绑定时，todo-core 会拒绝（规则 4）而不是产生双绑定
      return { ok: false, reason: (err as Error).message }
    }
    this.cache = undefined
    return { ok: true, todo: this.store.list().find((t) => t.id === todo.id) }
  }

  /** 把历史会话绑到已有 todo（多会话绑定 UI / S5 从 todo 进入） */
  async bind(todoId: string, sessionId: CliSessionId, toolId?: string): Promise<ClaimResult> {
    const todo = this.store.list().find((t) => t.id === todoId)
    if (!todo) return { ok: false, reason: 'todo 不存在' }
    const summary = await this.findSummary(sessionId, toolId)
    if (!summary) return { ok: false, reason: '会话已不在本机' }
    const owner = this.store.findTodoBySession(sessionId, summary.toolId)
    if (owner && owner.id !== todoId) {
      return { ok: false, todo: owner, reason: `这条会话已绑定到「${owner.title}」` }
    }
    const now = new Date().toISOString()
    try {
      this.store.update(todoId, {
        addBinding: {
          toolId: summary.toolId,
          sessionId,
          boundAt: now,
          state: 'verified',
          filePath: summary.filePath,
        },
        primarySessionId: sessionId,
        lastLaunch: { toolId: summary.toolId, projectPath: summary.cwd, launchedAt: now },
      })
    } catch (err) {
      // todo-core 在锁内查重（规则 4）：并发 bind 的后到者在这里被拒，而不是双写
      return { ok: false, reason: (err as Error).message }
    }
    this.cache = undefined
    return { ok: true, todo: this.store.list().find((t) => t.id === todoId) }
  }

  /** 解绑（不动会话文件；若删的是 primary，自动退到剩余第一条） */
  unbind(todoId: string, sessionId: CliSessionId, toolId?: string): boolean {
    this.cache = undefined
    return this.store.removeBinding(todoId, sessionId, toolId)
  }

  sessionIdOf(raw: string): CliSessionId {
    return newCliSessionId(raw)
  }

  /**
   * 会话列表的并集按 (toolId, sessionId) 才是唯一键；
   * toolId 缺省时优先按 id 匹配（旧调用/历史数据），显式传入时精确匹配该工具。
   */
  private async findSummary(sessionId: CliSessionId, toolId?: string): Promise<SessionSummary | undefined> {
    const summaries = await this.summaries()
    return summaries.find((x) => x.sessionId === sessionId && (!toolId || x.toolId === toolId))
  }
}
