/**
 * todos-file — 直接读写 `~/.ticktodo/data/todos.json` 的最小实现。
 *
 * 为什么不去 import apps/desktop 的 TodoStore：
 *  这份代码会被打进 pi extension，运行在 **pi 自己的进程里**（CLI 或面板宿主），
 *  不能依赖 Electron / app 目录。领域规则只有一份（本文件），两边各包一层薄适配：
 *    - pi CLI   → src/index.ts   （ExtensionAPI.registerTool）
 *    - 面板 Chat → src/durable.ts（pi-durable defineTool）
 *
 * 与 Main 侧的契约（TECH-ARCH §7）：同一份 todos.json、原子写、文件锁。
 * 锁 / 原子写 / TICK_HOME 解析 / Todo 模型 / 解析校验都在共享包
 * （@tick/storage、@tick/shared）——两边手抄合同的时代已经证明会漂移出丢写 bug。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionBinding, Todo } from '@tick/shared'
import { newCliSessionId, parseTodosFile } from '@tick/shared'
import { FileLock, resolveTickHome, todosFilePath, writeFileAtomic } from '@tick/storage'

export interface CreateTodoInput {
  title: string
  body?: string
  /** 当前 pi 会话 id（有则绑定；一个 session 最多绑一个 todo） */
  sessionId?: string
  source?: 'panel' | 'pi'
  requestId?: string
}

export function backupCorrupt(file: string): string | undefined {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backup)
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      /* 忽略 */
    }
    return backup
  } catch {
    return undefined
  }
}

/**
 * 读 todos.json。解析失败时先备份成 `<file>.corrupt-<ts>` 再返回空表——
 * 数据层是「致命」层，不能静默把用户数据覆盖掉（至少留一份可人工恢复的原件）。
 * 只读路径（listTodos）不触发备份，避免读操作产生副作用。
 */
function readFile(file: string, backupOnCorrupt = false): { version: 1; todos: Todo[] } {
  if (!fs.existsSync(file)) return { version: 1, todos: [] }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (backupOnCorrupt) {
      const backup = backupCorrupt(file)
      console.error(`[tick] todos.json 解析失败（已备份到 ${backup ?? '失败'}）：`, err)
    }
    return { version: 1, todos: [] }
  }
  const parsed = parseTodosFile(raw)
  if (!parsed) {
    if (backupOnCorrupt) console.error(`[tick] todos.json 结构非法：${backupCorrupt(file) ?? file}`)
    return { version: 1, todos: [] }
  }
  return parsed
}

/** 锁内读改写；`dirty=false` 时不写文件（命中幂等键时避免无谓写 + 触发 watcher） */
function withLockedFile<T>(
  file: string,
  fn: (data: { version: 1; todos: Todo[] }) => { result: T; dirty: boolean },
): T {
  // 锁文件要和 data 目录同生：首次运行时目录还不存在（ENOENT 不是"抢不到锁"）
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = new FileLock(file)
  if (!lock.acquire()) throw new Error(`todos.json 被其他进程持有超过预算（${file}）`)
  try {
    const data = readFile(file, true)
    const { result, dirty } = fn(data)
    if (dirty) writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
    return result
  } finally {
    lock.release()
  }
}

/**
 * 建一条线索。
 * 幂等：requestId 命中或同一 session 已绑过 todo → 直接返回既有那条（不重复建）。
 */
export function createTodo(
  input: CreateTodoInput,
  home = resolveTickHome(),
): { todo: Todo; created: boolean } {
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('标题为空不可保存')

  const file = todosFilePath(home)
  return withLockedFile<{ todo: Todo; created: boolean }>(file, (data) => {
    const now = new Date().toISOString()

    const existing = data.todos.find(
      (t) =>
        (input.requestId && t.requestId === input.requestId) ||
        (input.sessionId && t.bindings.some((b) => b.sessionId === input.sessionId)),
    )
    // 命中幂等键 / 同会话：直接返回既有那条，且不写文件（避免无谓 write 触发 Main 的 fs.watch）
    if (existing) return { result: { todo: existing, created: false }, dirty: false }

    const binding: SessionBinding | undefined = input.sessionId
      ? {
          toolId: 'pi',
          sessionId: newCliSessionId(input.sessionId),
          boundAt: now,
          state: 'verified',
        }
      : undefined
    const todo: Todo = {
      id: randomUUID(),
      title,
      body: (input.body ?? '').trim() || undefined,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      bindings: binding ? [binding] : [],
      primarySessionId: binding?.sessionId,
      source: input.source ?? 'pi',
      requestId: input.requestId,
    }
    data.todos.push(todo)
    return { result: { todo, created: true }, dirty: true }
  })
}

export function listTodos(
  options: { status?: 'open' | 'done' | 'all'; limit?: number } = {},
  home = resolveTickHome(),
): Todo[] {
  const status = options.status ?? 'open'
  const all = readFile(todosFilePath(home)).todos
  const filtered = status === 'all' ? all : all.filter((t) => t.status === status)
  return filtered.slice(0, options.limit ?? 50)
}

/** 形状校验：给 extension 的返回文案用，避免把内部字段全吐给模型 */
export function describeTodo(t: Todo): string {
  const bind = t.primarySessionId ? ` · 会话 ${t.primarySessionId.slice(0, 8)}` : ''
  return `${t.status === 'done' ? '[已完成] ' : ''}${t.title}${bind}`
}
