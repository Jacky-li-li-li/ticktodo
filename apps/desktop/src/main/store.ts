/**
 * TodoStore — 本地 Todo CRUD（M0）。
 *
 * PRD §6 业务规则落点：
 *  1. 标题为空不可保存；
 *  2. 完成只改状态（open/done），绑定不清空；删除 todo 默认解绑（M0 无绑定入口，结构先留）；
 *  3. todos.json = 原子写 + 文件锁（与 M2 的 CLI extension 共写同一份）；
 *  4. 数据格式带 version，缺失目录启动按需创建。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import { atomicWriteJson, FileLock } from './services/storage'

interface TodosFile {
  version: 1
  todos: Todo[]
}

export class TodoStore {
  private lock: FileLock

  constructor(private file: string) {
    this.lock = new FileLock(file)
  }

  /**
   * 读 todos.json。解析失败 = 数据层坏了（PRD 把 data/ 定为「致命」层）：
   * 先把原文件备份成 `<file>.corrupt-<ts>` 再返回空表，避免下一次写入把用户数据静默覆盖掉。
   */
  private load(): TodosFile {
    if (!fs.existsSync(this.file)) return { version: 1, todos: [] }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as TodosFile
      if (!parsed || !Array.isArray(parsed.todos)) {
        this.backupCorrupt()
        return { version: 1, todos: [] }
      }
      return { version: 1, todos: parsed.todos }
    } catch (err) {
      this.backupCorrupt(err)
      return { version: 1, todos: [] }
    }
  }

  private backupCorrupt(err?: unknown): void {
    const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.copyFileSync(this.file, backup)
      fs.chmodSync(backup, 0o600)
      console.error(`[tick] todos.json 损坏，已备份到 ${backup}`, err ?? '')
    } catch (e) {
      console.error('[tick] todos.json 损坏且备份失败', err ?? '', e)
    }
  }

  private save(data: TodosFile): void {
    atomicWriteJson(this.file, data)
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lock.acquire()) {
      throw new Error(`todos.json 文件锁获取失败（${this.file}）`)
    }
    try {
      return fn()
    } finally {
      this.lock.release()
    }
  }

  list(): Todo[] {
    // 列表态：M0 默认按 updatedAt 降序；页面排序规则由 UI 决定
    return this.load().todos
  }

  create(input: TodoCreateInput): Todo {
    const title = input.title.trim()
    if (!title) throw new Error('标题为空不可保存')

    // TS Omit —— bindings 结构留位，M2/M3 的 create_todo 与多会话绑定在这上生长
    const todo: Todo = {
      id: randomUUID(),
      title,
      body: input.body?.trim() || undefined,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bindings: [],
    }
    return this.withLock(() => {
      const data = this.load()
      data.todos.push(todo)
      this.save(data)
      return todo
    })
  }

  update(id: string, patch: TodoPatch): Todo {
    return this.withLock(() => {
      const data = this.load()
      const found = data.todos.find((t) => t.id === id)
      if (!found) throw new Error(`todo 不存在: ${id}`)

      if (patch.title !== undefined) {
        const title = patch.title.trim()
        if (!title) throw new Error('标题为空不可保存')
        found.title = title
      }
      if (patch.body !== undefined) found.body = patch.body.trim() || undefined
      if (patch.status !== undefined) found.status = patch.status
      if (patch.lastLaunch !== undefined) found.lastLaunch = patch.lastLaunch
      if (patch.primarySessionId !== undefined) found.primarySessionId = patch.primarySessionId
      if (patch.addBinding) {
        // 业务规则 4：一个 session 最多绑一个 todo（M0 只成长结构，去重校验靠 M3 的绑定 UI）
        const b = patch.addBinding
        const existing = found.bindings.find((x) => x.sessionId === b.sessionId && x.toolId === b.toolId)
        if (existing) {
          // pending → verified 对账 / S5 绑定会重复走 patch；已有绑定只更新状态与 filePath 提示
          if (b.state) existing.state = b.state
          if (b.filePath) existing.filePath = b.filePath
        } else {
          found.bindings.push(b)
        }
        if (!found.primarySessionId) found.primarySessionId = b.sessionId
      }
      found.updatedAt = new Date().toISOString()
      this.save(data)
      return found
    })
  }

  /**
   * pending 绑定对账：把某 session 的绑定状态改成 verified（不改 updatedAt——这不是用户编辑）。
   * 返回 true = 真的有状态变化（调用方可据此触发 UI 刷新/日志）。
   */
  markBinding(
    sessionId: string,
    state: NonNullable<TodoPatch['addBinding']>['state'],
    filePath?: string,
  ): boolean {
    return this.withLock(() => {
      const data = this.load()
      let changed = false
      for (const todo of data.todos) {
        for (const binding of todo.bindings) {
          if (binding.sessionId !== sessionId) continue
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
      if (changed) this.save(data)
      return changed
    })
  }

  /** 一个 session 最多绑一个 todo（业务规则 4）→ 反查归属 */
  findTodoBySession(sessionId: string): Todo | undefined {
    return this.load().todos.find((t) => t.bindings.some((b) => b.sessionId === sessionId))
  }

  /** 解绑一个 session；若它正好是 primary，退到剩余的第一条（业务规则 5：删除/解绑不动会话文件） */
  removeBinding(todoId: string, sessionId: string): boolean {
    return this.withLock(() => {
      const data = this.load()
      const todo = data.todos.find((t) => t.id === todoId)
      if (!todo) return false
      const before = todo.bindings.length
      todo.bindings = todo.bindings.filter((b) => b.sessionId !== sessionId)
      if (todo.bindings.length === before) return false
      if (todo.primarySessionId === sessionId) {
        todo.primarySessionId = todo.bindings[0]?.sessionId
      }
      todo.updatedAt = new Date().toISOString()
      this.save(data)
      return true
    })
  }

  remove(id: string): void {
    this.withLock(() => {
      const data = this.load()
      // 业务规则 5：删除 todo 默认解绑（bindings 随 todo 一起消失；session 文件不动）
      data.todos = data.todos.filter((t) => t.id !== id)
      this.save(data)
    })
  }

  /**
   * 启动时：file 不存在就创建空文件，避免首次读错误。
   * 必须带锁且锁内二次检查：首次运行时 extension 可能正好在建第一条 todo，
   * 无锁的「exists → save 空表」会把那条覆盖掉。
   */
  ensureFile(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    try {
      this.withLock(() => {
        if (!fs.existsSync(this.file)) this.save({ version: 1, todos: [] })
      })
    } catch {
      /* 锁被短暂占用：下次读写会走正常锁路径 */
    }
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* 忽略 */
    }
  }
}
