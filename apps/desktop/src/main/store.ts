/**
 * TodoStore — Electron main 的 Todo 门面。
 *
 * 领域实现全部在 `@tick/todo-core`（todos.json 的唯一写实现）：
 *   - 锁 / 原子写 / 损坏备份 / requestId 幂等 / addBinding 冲突判定只有一份；
 *   - 这里只保留类形态，供 main 的 IPC 与 services 注入（不改调用方签名）。
 *
 * 不要在本文件里重新实现读写逻辑；否则又会回到「两份锁实现漂移」的老问题。
 */

import type { SessionBinding, Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import { openTodoStore, type TodoStoreCore } from '@tick/todo-core'

export class TodoStore {
  private core: TodoStoreCore

  constructor(file: string) {
    this.core = openTodoStore({ file })
  }

  list(): Todo[] {
    return this.core.list()
  }

  create(input: TodoCreateInput): Todo {
    return this.core.create({ title: input.title, body: input.body }).todo
  }

  update(id: string, patch: TodoPatch): Todo {
    return this.core.update(id, patch)
  }

  /** pending → verified 对账（不改 updatedAt） */
  markBinding(
    sessionId: string,
    state: SessionBinding['state'],
    filePath?: string,
    toolId?: string,
  ): boolean {
    return this.core.markBinding(sessionId, state, filePath, toolId)
  }

  /** 一个 session 最多绑一个 todo（业务规则 4）→ 反查归属 */
  findTodoBySession(sessionId: string, toolId?: string): Todo | undefined {
    return this.core.findTodoBySession(sessionId, toolId)
  }

  /** 解绑一个 session；若它是 primary，退到剩余第一条 */
  removeBinding(todoId: string, sessionId: string, toolId?: string): boolean {
    return this.core.removeBinding(todoId, sessionId, toolId)
  }

  remove(id: string): void {
    this.core.remove(id)
  }

  /** 启动时确保文件存在（锁内二次检查，避免覆盖 extension 的首条 todo） */
  ensureFile(): void {
    this.core.ensureFile()
  }
}
