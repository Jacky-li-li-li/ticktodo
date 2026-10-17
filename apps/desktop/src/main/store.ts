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
import { atomicWriteJson, FileLock, readJson } from './services/storage'

interface TodosFile {
  version: 1
  todos: Todo[]
}

export class TodoStore {
  private lock: FileLock

  constructor(private file: string) {
    this.lock = new FileLock(file)
  }

  private load(): TodosFile {
    const parsed = readJson<TodosFile>(this.file)
    if (!parsed || !Array.isArray(parsed.todos)) {
      return { version: 1, todos: [] }
    }
    return { version: 1, todos: parsed.todos }
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
        if (!found.bindings.some((x) => x.sessionId === b.sessionId && x.toolId === b.toolId)) {
          found.bindings.push(b)
        }
        if (!found.primarySessionId) found.primarySessionId = b.sessionId
      }
      found.updatedAt = new Date().toISOString()
      this.save(data)
      return found
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

  /** 启动时：file 不存在就创建空文件，避免首次读错误（M0 简化：启动即建） */
  ensureFile(): void {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
      this.save({ version: 1, todos: [] })
    }
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* 忽略 */
    }
  }
}
