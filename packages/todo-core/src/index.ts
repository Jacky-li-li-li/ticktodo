/**
 * @tick/todo-core — `todos.json` 的**唯一写实现**。
 *
 * 为什么要有这个包：这份数据会被 Main（TodoStore）、pi extension、面板 Chat 扩展、
 * MCP server 同时写。历史上 Main 与 extension 各写一份锁实现、锁名漂移，
 * 并发 240 次写丢 117 条。现在所有写方都 import 这里，锁名/原子写/幂等/损坏备份只有一份。
 *
 * 关键契约（与 `CLAUDE.md` 不变量 1 一致，改这里等于改所有写方）：
 *   - 锁文件 = `<todos.json>.lock`，不许改名；
 *   - 锁内容 = `<pid>:<uuid>` token，释放只删自己持有的锁；
 *   - mtime > 5s 视为陈旧锁强夺；
 *   - 写 = 同目录 tmp + fsync + rename，权限 0600；
 *   - 解析失败先备份 `<file>.corrupt-<ts>`；默认继续用空表（兼容既有行为），
 *     `onCorrupt:'throw'` 时抛 `TodoDataError('TICK_E_DATA_CORRUPT')` —— MCP 写路径必须用它，
 *     否则 agent 重试会把用户数据用空表覆盖。
 *
 * 不依赖 Electron / pi：MCP server、pi extension（esbuild bundle）、Electron main 都能用。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionBinding, Todo, TodoPatch, TodoStatus } from '@tick/shared'
import { newCliSessionId, parseTodosFile } from '@tick/shared'

// ---------- 类型 ----------

export interface TodosFile {
  version: 1
  todos: Todo[]
}

export type CorruptPolicy = 'empty' | 'throw'

export interface TodoStoreOptions {
  /** `todos.json` 的绝对路径 */
  file: string
  /** 时钟注入（测试用）；缺省 `new Date().toISOString()` */
  now?: () => string
  /** 解析失败时：`empty`（既有行为）或 `throw`（MCP 写路径必须 throw） */
  onCorrupt?: CorruptPolicy
  /** 拿锁超时（默认 5000ms，与陈旧锁阈值一致） */
  lockTimeoutMs?: number
}

export type TodoErrorCode = 'TICK_E_DATA_CORRUPT' | 'TICK_E_LOCK_TIMEOUT' | 'TICK_E_INVALID_INPUT'

export class TodoDataError extends Error {
  constructor(
    readonly code: TodoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TodoDataError'
  }
}

/** 兼容旧调用：标题为空等业务校验错误 */
export class TodoInputError extends Error {
  readonly code: TodoErrorCode = 'TICK_E_INVALID_INPUT'
  constructor(message: string) {
    super(message)
    this.name = 'TodoInputError'
  }
}

export interface CreateTodoInput {
  title: string
  body?: string
  /** 绑定的会话 id（有则建 verified 绑定；一个 session 最多绑一条 todo） */
  sessionId?: string
  /** 会话所属工具；缺省 `pi`（兼容旧 extension） */
  toolId?: string
  /** 当前工作目录（MCP 来源只写进 mcpOrigin，不落 Todo 字段） */
  cwd?: string
  /** 来源；缺省 `pi`（兼容旧 extension） */
  source?: Todo['source']
  /** 幂等键 */
  requestId?: string
  /** 来源记录（MCP 定位失败时） */
  mcpOrigin?: Todo['mcpOrigin']
  /**
   * 标题窗口去重（毫秒）。只在 MCP 写路径使用：同 toolId + 规范化 title 在窗口内已存在
   * → 返回既有 todo，避免模型重试/复述造成垃圾。缺省 0 = 关闭。
   */
  dedupeByTitleWithinMs?: number
}

export interface CreateTodoResult {
  todo: Todo
  created: boolean
  dedupedBy?: 'request_id' | 'session' | 'title'
}

// ---------- 路径 ----------

/** `~/.ticktodo`（`TICK_HOME` 可覆盖）；与 apps/desktop 的 resolveDirs 同一口径 */
export function resolveTickHome(): string {
  return process.env.TICK_HOME?.trim() || path.join(os.homedir(), '.ticktodo')
}

export function todosFilePath(home = resolveTickHome()): string {
  return path.join(home, 'data', 'todos.json')
}

/**
 * 清理崩溃残留的写盘 `.tmp`（进程被 kill 后 rename 没跑完留下的）。
 * data/ 是「建议同步」层，垃圾不清会被一起同步走。只删超龄 tmp；corrupt 备份与正式文件不动。
 */
export function cleanStaleTmp(dir: string, maxAgeMs = 60 * 60 * 1000): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const file = path.join(dir, name)
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true })
        removed++
      }
    } catch {
      /* 忽略 */
    }
  }
  return removed
}

// ---------- 锁 / 原子写 ----------

const STALE_LOCK_MS = 5_000

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但属于其他用户；ESRCH = 不存在
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 陈旧判定（按证据收敛，不按等待时间猜）：
 *  - token 里的 PID 已死 → 陈旧（崩溃残留立即可抢，不用干等 5s）；
 *  - token 不可解析 → 退回文件年龄 > STALE_LOCK_MS（跨机器同步场景 PID 无意义）；
 *  - PID 还活着 → 不陈旧。绝不抢活锁：抢活锁 = 两个写方同时读改写（丢写重现）。
 */
function lockIsStale(lockPath: string): boolean {
  let token: string
  try {
    token = fs.readFileSync(lockPath, 'utf8').trim()
  } catch {
    return true // 锁刚被释放/消失 → 回到重试
  }
  const pid = Number.parseInt(token.split(':')[0] ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS
    } catch {
      return true
    }
  }
  return !pidAlive(pid)
}

function acquireLock(lockPath: string, timeoutMs: number): string {
  const start = Date.now()
  for (;;) {
    const token = `${process.pid}:${randomUUID()}`
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 })
      return token
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw e
    }
    if (lockIsStale(lockPath)) {
      fs.rmSync(lockPath, { force: true })
      continue
    }
    if (Date.now() - start > timeoutMs) {
      throw new TodoDataError('TICK_E_LOCK_TIMEOUT', `todos.json 被锁定超过 ${timeoutMs}ms`)
    }
    // extension 里没有 await 的余地（纯同步 API），用 Atomics.wait 让出一小段 CPU
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== token) return
    fs.rmSync(lockPath, { force: true })
  } catch {
    /* 锁已被强夺 / 文件不存在：忽略 */
  }
}

/** 同一进程内同一文件只备份一次：list 会被 UI 高频调用，重复 backup 会刷出一堆副本 */
const corruptBackupDone = new Set<string>()

function backupCorrupt(file: string): string | undefined {
  if (corruptBackupDone.has(file)) return undefined
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backup)
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      /* 忽略 */
    }
    corruptBackupDone.add(file)
    return backup
  } catch {
    return undefined
  }
}

/** 读并校验；解析失败按策略处理。只读路径（list）不备份，避免读产生副作用 */
function readTodosFile(file: string, policy: { backup: boolean; onCorrupt: CorruptPolicy }): TodosFile {
  if (!fs.existsSync(file)) return { version: 1, todos: [] }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    // version 不支持 / 缺 todos 数组 = 结构非法 → 走 corrupt 策略（备份原件，不能拿空表覆盖）
    const parsed = parseTodosFile(raw)
    if (!parsed) throw new Error('结构非法（version 不支持或缺少 todos 数组）')
    corruptBackupDone.delete(file)
    // 坏条目已被逐条丢弃（标题保住）；文件里的垃圾在下次 dirty 写时自然消失
    return parsed
  } catch (e) {
    const backup = policy.backup ? backupCorrupt(file) : undefined
    if (policy.onCorrupt === 'throw') {
      throw new TodoDataError(
        'TICK_E_DATA_CORRUPT',
        `todos.json 解析失败${backup ? `（已备份到 ${backup}）` : ''}`,
      )
    }
    if (backup) console.error(`[tick] todos.json 解析失败（已备份到 ${backup}）`, e)
    return { version: 1, todos: [] }
  }
}

function atomicWrite(file: string, data: TodosFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* 忽略 */
  }
}

function withLockedFile<T>(
  file: string,
  timeoutMs: number,
  fn: (data: TodosFile) => { result: T; dirty: boolean },
  onCorrupt: CorruptPolicy,
): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.lock`
  const token = acquireLock(lockPath, timeoutMs)
  try {
    const data = readTodosFile(file, { backup: true, onCorrupt })
    const { result, dirty } = fn(data)
    if (dirty) atomicWrite(file, data)
    return result
  } finally {
    releaseLock(lockPath, token)
  }
}

// ---------- 纯函数 ----------

/** 规范化标题：NFKC + 去首尾 + 连续空白折叠（MCP 标题窗口去重要作用） */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

/** 去重用的 key：规范化 + 仅 ASCII 小写（中文不做 locale 折叠，避免误合并） */
function titleKey(title: string): string {
  return normalizeTitle(title).replace(/[A-Z]/g, (c) => c.toLowerCase())
}

/** 给 extension/模型看的一行摘要（不吐内部字段） */
export function describeTodo(t: Todo): string {
  const bind = t.primarySessionId ? ` · 会话 ${t.primarySessionId.slice(0, 8)}` : ''
  return `${t.status === 'done' ? '[已完成] ' : ''}${t.title}${bind}`
}

function applyBinding(todo: Todo, binding: SessionBinding): void {
  const existing = todo.bindings.find(
    (b) => b.sessionId === binding.sessionId && b.toolId === binding.toolId,
  )
  if (existing) {
    if (binding.state) existing.state = binding.state
    if (binding.filePath) existing.filePath = binding.filePath
    if (binding.origin) existing.origin = binding.origin
  } else {
    todo.bindings.push(binding)
  }
  if (!todo.primarySessionId) todo.primarySessionId = binding.sessionId
}

// ---------- Store ----------

export interface AddBindingResult {
  ok: boolean
  todo?: Todo
  /** 该会话已绑到另一条 todo（不覆盖，返回冲突方） */
  conflictTodo?: Todo
}

export class TodoStoreCore {
  private readonly file: string
  private readonly now: () => string
  private readonly onCorrupt: CorruptPolicy
  private readonly lockTimeoutMs: number

  constructor(opts: TodoStoreOptions) {
    this.file = opts.file
    this.now = opts.now ?? (() => new Date().toISOString())
    this.onCorrupt = opts.onCorrupt ?? 'empty'
    this.lockTimeoutMs = opts.lockTimeoutMs ?? STALE_LOCK_MS
  }

  list(): Todo[] {
    // 损坏先备份：这是 data/ 层的既有承诺（UI 读到坏数据也不能让原文件无痕消失）
    return readTodosFile(this.file, { backup: true, onCorrupt: this.onCorrupt }).todos
  }

  ensureFile(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    try {
      withLockedFile(
        this.file,
        this.lockTimeoutMs,
        (data) => {
          // 锁内二次检查：首次运行时 extension 可能正在建第一条 todo
          const exists = fs.existsSync(this.file)
          return { result: undefined, dirty: !exists && data.todos.length === 0 }
        },
        this.onCorrupt,
      )
    } catch {
      /* 锁被短暂占用：下次读写会走正常锁路径 */
    }
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* 忽略 */
    }
  }

  create(input: CreateTodoInput): CreateTodoResult {
    const title = normalizeTitle(input.title ?? '')
    if (!title) throw new TodoInputError('标题为空不可保存')

    return withLockedFile<CreateTodoResult>(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        const now = this.now()

        // 1) requestId 幂等
        if (input.requestId) {
          // spec §1.6：request_id 的作用域是 (toolId, request_id)，不同工具的相同 key 不互相命中
          const hit = data.todos.find(
            (t) =>
              t.requestId === input.requestId &&
              (!input.toolId ||
                (t.mcpOrigin?.toolId ??
                  (t.source === 'mcp' ? t.bindings[0]?.toolId : undefined)) === input.toolId),
          )
          if (hit) return { result: { todo: hit, created: false, dedupedBy: 'request_id' }, dirty: false }
        }
        // 2) 同会话已绑（一个 session 最多绑一条 todo）
        if (input.sessionId) {
          const hit = data.todos.find((t) =>
            t.bindings.some(
              (b) => b.sessionId === input.sessionId && (!input.toolId || b.toolId === input.toolId),
            ),
          )
          if (hit) return { result: { todo: hit, created: false, dedupedBy: 'session' }, dirty: false }
        }
        // 3) 标题窗口去重（仅 MCP 传入）
        if (input.dedupeByTitleWithinMs && input.dedupeByTitleWithinMs > 0) {
          const since = Date.parse(now) - input.dedupeByTitleWithinMs
          const key = titleKey(title)
          const hit = data.todos.find((t) => {
            if (t.source !== 'mcp') return false // 用户手写的同名线索不参与 agent 去重
            if (!t.createdAt) return false
            const at = Date.parse(t.createdAt)
            if (Number.isNaN(at) || at < since) return false
            if (input.toolId && t.mcpOrigin?.toolId !== input.toolId) return false
            return titleKey(t.title) === key
          })
          if (hit) return { result: { todo: hit, created: false, dedupedBy: 'title' }, dirty: false }
        }

        const binding: SessionBinding | undefined = input.sessionId
          ? {
              toolId: input.toolId ?? 'pi',
              sessionId: newCliSessionId(input.sessionId),
              boundAt: now,
              state: 'verified',
            }
          : undefined

        const todo: Todo = {
          id: randomUUID(),
          title,
          body: input.body?.trim() || undefined,
          status: 'open',
          createdAt: now,
          updatedAt: now,
          bindings: binding ? [binding] : [],
          primarySessionId: binding ? binding.sessionId : undefined,
          source: input.source,
          requestId: input.requestId,
          mcpOrigin: input.mcpOrigin,
        }
        data.todos.push(todo)
        return { result: { todo, created: true }, dirty: true }
      },
      this.onCorrupt,
    )
  }

  update(id: string, patch: TodoPatch): Todo {
    return withLockedFile(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        const found = data.todos.find((t) => t.id === id)
        if (!found) throw new TodoInputError(`todo 不存在: ${id}`)

        if (patch.title !== undefined) {
          const title = normalizeTitle(patch.title)
          if (!title) throw new TodoInputError('标题为空不可保存')
          found.title = title
        }
        if (patch.body !== undefined) found.body = patch.body.trim() || undefined
        if (patch.status !== undefined) found.status = patch.status
        if (patch.lastLaunch !== undefined) found.lastLaunch = patch.lastLaunch
        if (patch.primarySessionId !== undefined) found.primarySessionId = patch.primarySessionId
        if (patch.addBinding) {
          // 业务规则：一个 session 最多绑一个 todo（toolId 是命名空间的一部分）
          const owner = data.todos.find(
            (t) =>
              t.id !== found.id &&
              t.bindings.some(
                (b) =>
                  b.sessionId === patch.addBinding?.sessionId &&
                  b.toolId === patch.addBinding?.toolId,
              ),
          )
          if (owner) throw new TodoInputError(`会话已绑定到「${owner.title}」`)
          applyBinding(found, patch.addBinding)
        }
        found.updatedAt = this.now()
        return { result: found, dirty: true }
      },
      this.onCorrupt,
    )
  }

  /** 把一条 todo 绑到会话；已绑到别的 todo 时返回冲突（不覆盖） */
  addBinding(todoId: string, binding: SessionBinding): AddBindingResult {
    return withLockedFile<AddBindingResult>(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        const todo = data.todos.find((t) => t.id === todoId)
        if (!todo) return { result: { ok: false }, dirty: false }
        const conflict = data.todos.find(
          (t) =>
            t.id !== todoId &&
            t.bindings.some(
              (b) => b.sessionId === binding.sessionId && b.toolId === binding.toolId,
            ),
        )
        if (conflict) return { result: { ok: false, todo, conflictTodo: conflict }, dirty: false }
        applyBinding(todo, binding)
        todo.updatedAt = this.now()
        return { result: { ok: true, todo }, dirty: true }
      },
      this.onCorrupt,
    )
  }

  /**
   * pending → verified 对账；不改 updatedAt（这不是用户编辑）。
   * 返回 true = 真的有状态变化。
   */
  markBinding(sessionId: string, state: SessionBinding['state'], filePath?: string, toolId?: string): boolean {
    return withLockedFile(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        let changed = false
        for (const todo of data.todos) {
          for (const binding of todo.bindings) {
            if (binding.sessionId !== sessionId) continue
            if (toolId && binding.toolId !== toolId) continue
            if (binding.state !== state) {
              binding.state = state
              changed = true
            }
            if (filePath && binding.filePath !== filePath) {
              binding.filePath = filePath
              changed = true
            }
          }
        }
        return { result: changed, dirty: changed }
      },
      this.onCorrupt,
    )
  }

  /** 一个 session 最多绑一个 todo（业务规则）→ 反查归属 */
  findTodoBySession(sessionId: string, toolId?: string): Todo | undefined {
    return this.list().find((t) =>
      t.bindings.some((b) => b.sessionId === sessionId && (!toolId || b.toolId === toolId)),
    )
  }

  /** 解绑；若它正好是 primary，退到剩余第一条（删除/解绑不动会话文件） */
  removeBinding(todoId: string, sessionId: string, toolId?: string): boolean {
    return withLockedFile(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        const todo = data.todos.find((t) => t.id === todoId)
        if (!todo) return { result: false, dirty: false }
        const before = todo.bindings.length
        todo.bindings = todo.bindings.filter(
          (b) => !(b.sessionId === sessionId && (!toolId || b.toolId === toolId)),
        )
        if (todo.bindings.length === before) return { result: false, dirty: false }
        if (todo.primarySessionId === sessionId) {
          todo.primarySessionId = todo.bindings[0]?.sessionId
        }
        todo.updatedAt = this.now()
        return { result: true, dirty: true }
      },
      this.onCorrupt,
    )
  }

  remove(id: string): void {
    withLockedFile(
      this.file,
      this.lockTimeoutMs,
      (data) => {
        const before = data.todos.length
        data.todos = data.todos.filter((t) => t.id !== id)
        return { result: undefined, dirty: data.todos.length !== before }
      },
      this.onCorrupt,
    )
  }
}

// ---------- 便捷函数（pi extension 用；不需要 class） ----------

export function openTodoStore(opts: TodoStoreOptions): TodoStoreCore {
  return new TodoStoreCore(opts)
}

/** 建一条线索；`home` 覆盖时用于测试/隔离 */
export function createTodo(input: CreateTodoInput, home = resolveTickHome()): CreateTodoResult {
  return new TodoStoreCore({ file: todosFilePath(home) }).create(input)
}

export function listTodos(
  options: { status?: 'open' | 'done' | 'all'; limit?: number } = {},
  home = resolveTickHome(),
): Todo[] {
  const status = options.status ?? 'open'
  const all = new TodoStoreCore({ file: todosFilePath(home) }).list()
  const filtered = status === 'all' ? all : all.filter((t) => t.status === status)
  return filtered.slice(0, options.limit ?? 50)
}

export type { TodoPatch, TodoStatus }
