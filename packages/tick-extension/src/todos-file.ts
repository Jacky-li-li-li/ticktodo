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
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface TodoBinding {
  toolId: string
  sessionId: string
  boundAt: string
}

export interface TodoRecord {
  id: string
  title: string
  body?: string
  status: 'open' | 'done'
  createdAt: string
  updatedAt: string
  bindings: TodoBinding[]
  primarySessionId?: string
  source?: 'panel' | 'pi'
  requestId?: string
}

interface TodosFile {
  version: 1
  todos: TodoRecord[]
}

export interface CreateTodoInput {
  title: string
  body?: string
  /** 当前 pi 会话 id（有则绑定；一个 session 最多绑一个 todo） */
  sessionId?: string
  /** 当前工作目录（仅记录在 body 里，不当作项目主键写入） */
  cwd?: string
  source?: 'panel' | 'pi'
  requestId?: string
}

export function resolveTickHome(): string {
  return process.env.TICK_HOME?.trim() || path.join(os.homedir(), '.ticktodo')
}

export function todosFilePath(home = resolveTickHome()): string {
  return path.join(home, 'data', 'todos.json')
}

function readFile(file: string): TodosFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TodosFile
    if (!parsed || !Array.isArray(parsed.todos)) return { version: 1, todos: [] }
    return { version: 1, todos: parsed.todos }
  } catch {
    return { version: 1, todos: [] }
  }
}

/** 原子写：tmp + fsync + rename（与 Main 侧 storage.ts 同款语义） */
function writeFileAtomic(file: string, data: TodosFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
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

/** O_EXCL 目录锁；5s 视为陈旧锁（进程崩了留下的） */
function acquireLock(lockPath: string, timeoutMs = 5000): number | undefined {
  const start = Date.now()
  for (;;) {
    try {
      return fs.openSync(lockPath, 'wx')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > timeoutMs) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      if (Date.now() - start > timeoutMs) throw new Error(`todos.json 被锁定超过 ${timeoutMs}ms`)
      // 同步等待一小段（extension 里不能 await 一个纯同步 API）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
}

function withLockedFile<T>(file: string, fn: (data: TodosFile) => T): T {
  // 锁文件要和 data 目录同生：首次运行时目录还不存在（ENOENT 不是"抢不到锁"）
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.lock`
  const fd = acquireLock(lockPath)
  if (fd === undefined) throw new Error(`todos.json 锁不可用（${lockPath}）`)
  try {
    const data = readFile(file)
    const result = fn(data)
    writeFileAtomic(file, data)
    return result
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* 忽略 */
    }
    fs.rmSync(lockPath, { force: true })
  }
}

/**
 * 建一条线索。
 * 幂等：requestId 命中或同一 session 已绑过 todo → 直接返回既有那条（不重复建）。
 */
export function createTodo(input: CreateTodoInput, home = resolveTickHome()): { todo: TodoRecord; created: boolean } {
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('标题为空不可保存')

  const file = todosFilePath(home)
  return withLockedFile(file, (data) => {
    const now = new Date().toISOString()

    const existing = data.todos.find(
      (t) =>
        (input.requestId && t.requestId === input.requestId) ||
        (input.sessionId && t.bindings.some((b) => b.sessionId === input.sessionId)),
    )
    if (existing) return { todo: existing, created: false }

    const todo: TodoRecord = {
      id: randomUUID(),
      title,
      body: (input.body ?? '').trim() || undefined,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      bindings: input.sessionId
        ? [{ toolId: 'pi', sessionId: input.sessionId, boundAt: now }]
        : [],
      primarySessionId: input.sessionId,
      source: input.source ?? 'pi',
      requestId: input.requestId,
    }
    data.todos.push(todo)
    return { todo, created: true }
  })
}

export function listTodos(
  options: { status?: 'open' | 'done' | 'all'; limit?: number } = {},
  home = resolveTickHome(),
): TodoRecord[] {
  const status = options.status ?? 'open'
  const all = readFile(todosFilePath(home)).todos
  const filtered = status === 'all' ? all : all.filter((t) => t.status === status)
  return filtered.slice(0, options.limit ?? 50)
}

/** 形状校验：给 extension 的返回文案用，避免把内部字段全吐给模型 */
export function describeTodo(t: TodoRecord): string {
  const bind = t.primarySessionId ? ` · 会话 ${t.primarySessionId.slice(0, 8)}` : ''
  return `${t.status === 'done' ? '[已完成] ' : ''}${t.title}${bind}`
}
