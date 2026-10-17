/**
 * useTodos — todos 数据hook（M0：load/create/update；refresh 留给多窗口与 extension 共写场景）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import type { TickApi } from '../../preload/index'

declare global {
  interface Window {
    tick: TickApi
  }
}

export function useTodos(): {
  todos: Todo[]
  refresh: () => Promise<void>
  create: (title: string, body?: string) => Promise<Todo | undefined>
  patch: (id: string, p: TodoPatch) => Promise<Todo | undefined>
  setStatus: (id: string, status: Todo['status']) => Promise<void>
} {
  const [todos, setTodos] = useState<Todo[]>([])

  const refresh = useCallback(async () => {
    setTodos(await window.tick.todos.list())
  }, [])

  useEffect(() => {
    void refresh()
    // pi extension 直接写 todos.json（命令行里 create_todo）→ main 的 fs.watch 推过来
    return window.tick.todos.onChange?.(() => void refresh())
  }, [refresh])

  const create = useCallback(
    async (title: string, body?: string) => {
      try {
        const todo = await window.tick.todos.create({ title, body })
        await refresh()
        return todo
      } catch {
        // 标题为空不可保存（业务规则 1）；捕获行静默拒绝即可
        return undefined
      }
    },
    [refresh],
  )

  const patch = useCallback(
    async (id: string, p: TodoPatch) => {
      try {
        const todo = await window.tick.todos.update(id, p)
        await refresh()
        return todo
      } catch {
        return undefined
      }
    },
    [refresh],
  )

  const setStatus = useCallback(
    async (id: string, status: Todo['status']) => {
      await patch(id, { status })
    },
    [patch],
  )

  return { todos, refresh, create, patch, setStatus }
}
