/**
 * SessionService — Tick 侧的会话视图（S5 反向建索引 / 多会话绑定 UI）。
 *
 * 分工（TECH-ARCH §6）：
 *  - 会话元数据的权威源是 adapter（listSessionInfos / describeSession）；
 *  - Tick 只持有绑定关系（Todo.bindings），这里把两者拼成 UI 需要的视图，不落镜像。
 *
 * 多工具（M5）：每行会话自带 toolId，读会话必须按 **binding 里的 toolId** 路由到 adapter，
 * 不用 sessionId 全局反查再猜工具——不同工具的 id 命名空间互不相干（合同 §1）。
 *
 * 时间线（P0-1..P0-5）：`forTodo()` 在每条绑定上多拼一个 `digest`（最后一条真实 user 消息 +
 * 会话内事件时间 + 归一状态）。digest 是**派生数据**：adapter 的 `SessionInfo` 是证据，
 * 这里只缓存「证据 + 文件指纹」到 `cache/session-digests.json`，状态每次按当前时间重算
 * （缓存里不能存 active/idle 的判定结果，否则十分钟后还是「进行中」）。
 */

import fs from 'node:fs'
import type {
  CliSessionId,
  SessionBinding,
  SessionDigest,
  SessionView,
  Todo,
  TodoRecentSession,
  TodoSessionView,
} from '@tick/shared'
import { newCliSessionId } from '@tick/shared'
import type { AiToolAdapter, SessionDigestSource, SessionInfo, SessionSummary } from '@tick/ai-core'
import { buildSessionDigest, canonicalPath } from '@tick/ai-core'
import type { TodoStore } from '../store'
import { atomicWriteJson, readJson } from './storage'

const CACHE_MS = 5_000

/** digest 派生缓存上限：只服务最近打开过的 todo，不无限长 */
const DIGEST_CACHE_MAX = 500
/** 缓存落盘去抖：forTodo 每 15s 刷一次，没必要每次写盘 */
const DIGEST_FLUSH_MS = 1_200

export interface ClaimResult {
  ok: boolean
  todo?: Todo
  reason?: string
}

export interface SessionServiceOptions {
  /** 派生缓存文件（`cache/session-digests.json`）；缺省 = 只内存缓存 */
  digestCacheFile?: string
  /** 时钟注入（状态单测/夹具用） */
  now?: () => number
}

interface DigestFingerprint {
  mtimeMs: number
  size: number
  /** 也纳入指纹：桌面工具的 DB 状态可能变而 jsonl 未追加 */
  lastUsedAt?: number
}

interface DigestCacheEntry {
  fingerprint: DigestFingerprint
  source: SessionDigestSource
}

interface DigestCacheFile {
  version: 1
  entries: Record<string, DigestCacheEntry>
}

export class SessionService {
  private cache?: { at: number; items: SessionSummary[] }
  private adapters: AiToolAdapter[]
  private digestCache = new Map<string, DigestCacheEntry>()
  private digestCacheLoaded = false
  private digestWriteTimer?: ReturnType<typeof setTimeout>
  private readonly digestCacheFile?: string
  private readonly clock: () => number

  constructor(
    adapters: AiToolAdapter[],
    private store: TodoStore,
    opts: SessionServiceOptions = {},
  ) {
    this.adapters = adapters
    this.digestCacheFile = opts.digestCacheFile
    this.clock = opts.now ?? Date.now
  }

  /** 会话列表（5s 进程内缓存：S5 反复打开不重复扫 49MB） */
  private async summaries(force = false): Promise<SessionSummary[]> {
    const now = this.clock()
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

  /** 某条 todo 下的会话（绑定详情 + 时间线摘要）；会话被删也能返回 missing 占位 */
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
        digest: await this.digestOf(binding, hit),
        boundAt: binding.boundAt,
        state: binding.state,
        primary: todo.primarySessionId === binding.sessionId,
        missing,
        boundTodoId: todo.id,
        boundTodoTitle: todo.title,
      })
    }
    // P0-2：按会话内最后事件时间倒序（跨工具混排）；primary 只加徽标，不改排序。
    // missing 排最后——它已经不能「接着做」，不该占据时间线顶部。
    out.sort((a, b) => {
      if (a.missing !== b.missing) return a.missing ? 1 : -1
      const at = a.digest?.lastActiveAt ?? a.lastUsedAt ?? 0
      const bt = b.digest?.lastActiveAt ?? b.lastUsedAt ?? 0
      return bt - at
    })
    return out
  }

  /**
   * 首页线索行（P0-6）：每个 todo 取一条「最近会话」的最后一条 user 消息。
   *
   * 这里刻意只取 primary（缺省退到最后一条绑定），不扫全部 sessions 列表：
   * 首页每次渲染都调，不能为了一行小字把 15 个工具的会话库全扫一遍。
   */
  async recentForTodos(todoIds: string[]): Promise<TodoRecentSession[]> {
    const todos = new Map(this.store.list().map((t) => [t.id, t]))
    const out: TodoRecentSession[] = []
    for (const todoId of [...new Set(todoIds)].slice(0, 50)) {
      const todo = todos.get(todoId)
      if (!todo || todo.bindings.length === 0) continue
      const binding =
        todo.bindings.find((b) => b.sessionId === todo.primarySessionId) ??
        todo.bindings[todo.bindings.length - 1]
      if (!binding) continue
      const hit = await this.describeBinding(binding)
      const digest = await this.digestOf(binding, hit)
      // 没有消息、也不在进行中 → 这行没有可说的，宁可不占位
      if (!digest.lastUserMessage && digest.state !== 'active') continue
      out.push({
        todoId,
        toolId: digest.toolId,
        sessionId: digest.sessionId,
        state: digest.state,
        lastUserMessage: digest.lastUserMessage,
        lastUserMessageAt: digest.lastUserMessageAt,
        lastActiveAt: digest.lastActiveAt,
        approximate: digest.approximate,
        lastUserMessageTruncated: digest.lastUserMessageTruncated,
      })
    }
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

  // ---------- 时间线摘要 + 派生缓存 ----------

  private async digestOf(
    binding: SessionBinding,
    hit: { adapter: AiToolAdapter; info?: SessionInfo } | undefined,
  ): Promise<SessionDigest> {
    const info = hit?.info
    const toolId = info?.toolId ?? hit?.adapter.id ?? binding.toolId
    if (!info) {
      // 会话文件/记录不在了：仍然是时间线条目，只是 state=missing、没有消息
      return buildSessionDigest(
        { toolId, sessionId: binding.sessionId, exists: false },
        this.clock(),
      )
    }

    this.loadDigestCache()
    const key = `${info.toolId}\u0000${info.sessionId}`
    const fingerprint = this.fingerprintOf(info)
    if (fingerprint) {
      const cached = this.digestCache.get(key)
      if (cached && sameFingerprint(cached.fingerprint, fingerprint)) {
        return buildSessionDigest(cached.source, this.clock())
      }
    }

    const source = sourceOf(info)
    if (fingerprint) {
      this.pruneDigestCache(key)
      this.digestCache.set(key, { fingerprint, source })
      this.scheduleDigestPersist()
    }
    return buildSessionDigest(source, this.clock())
  }

  /** 文件指纹：用于判断「证据是否需要重读」；拿不到 stat 就不缓存（每次现算，绝不误用旧证据） */
  private fingerprintOf(info: SessionInfo): DigestFingerprint | undefined {
    if (!info.filePath) return undefined
    try {
      const st = fs.statSync(info.filePath)
      return { mtimeMs: st.mtimeMs, size: st.size, lastUsedAt: info.lastUsedAt }
    } catch {
      return undefined
    }
  }

  private loadDigestCache(): void {
    if (this.digestCacheLoaded) return
    this.digestCacheLoaded = true
    const file = this.digestCacheFile
    if (!file) return
    const raw = readJson<DigestCacheFile>(file)
    if (!raw || raw.version !== 1 || typeof raw.entries !== 'object' || raw.entries === null) return
    for (const [key, entry] of Object.entries(raw.entries)) {
      if (!isCacheEntry(entry)) continue
      this.digestCache.set(key, entry)
    }
  }

  private pruneDigestCache(incomingKey: string): void {
    if (this.digestCache.size < DIGEST_CACHE_MAX || this.digestCache.has(incomingKey)) return
    // Map 保持插入顺序：删最旧的一批，给新条目腾位置
    for (const key of [...this.digestCache.keys()].slice(0, 100)) this.digestCache.delete(key)
  }

  private scheduleDigestPersist(): void {
    if (!this.digestCacheFile || this.digestWriteTimer) return
    this.digestWriteTimer = setTimeout(() => {
      this.digestWriteTimer = undefined
      try {
        const entries: Record<string, DigestCacheEntry> = {}
        for (const [key, entry] of this.digestCache) entries[key] = entry
        atomicWriteJson(this.digestCacheFile as string, { version: 1, entries })
      } catch (e) {
        // 派生缓存写失败不影响功能：下次还会重建
        console.warn('[tick] session-digests 缓存写入失败:', (e as Error).message)
      }
    }, DIGEST_FLUSH_MS)
    this.digestWriteTimer.unref?.()
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

/** adapter 证据 → 时间线源；没有原文时用旧 `lastMessage` 兜底并标 approximate */
function sourceOf(info: SessionInfo): SessionDigestSource {
  const approximate = info.lastUserMessage === undefined && info.lastMessage !== undefined
  return {
    toolId: info.toolId,
    sessionId: info.sessionId,
    exists: info.exists,
    lastUserMessage: info.lastUserMessage ?? info.lastMessage,
    // 压缩标题回退没有可靠消息时间：宁可留空，也不要把文件 mtime 冒充消息时间
    lastUserMessageAt: info.lastUserMessage === undefined ? undefined : info.lastUserMessageAt,
    lastEventAt: info.lastEventAt ?? info.lastUsedAt,
    endedCleanly: info.endedCleanly,
    running: info.running,
    approximate,
  }
}

function sameFingerprint(a: DigestFingerprint, b: DigestFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.lastUsedAt === b.lastUsedAt
}

function isCacheEntry(value: unknown): value is DigestCacheEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as { fingerprint?: unknown; source?: unknown }
  const fp = entry.fingerprint as Partial<DigestFingerprint> | undefined
  const src = entry.source as Partial<SessionDigestSource> | undefined
  return (
    typeof fp === 'object' &&
    fp !== null &&
    typeof fp.mtimeMs === 'number' &&
    typeof fp.size === 'number' &&
    typeof src === 'object' &&
    src !== null &&
    typeof src.toolId === 'string' &&
    typeof src.sessionId === 'string' &&
    typeof src.exists === 'boolean'
  )
}
