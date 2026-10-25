/**
 * TodoList — 首页线索列表（§4.2，重构后不再内联展开）。
 *
 * 行交互见 TodoRow：点行进详情 / 双击标题改标题 / 勾选归档 / 右侧箭头进入。
 * P0-6：每行第二小字 = 最近一条会话的最后一条 user 消息（由 App 批量取好传进来）。
 */

import React from 'react'
import type { Todo, TodoRecentSession } from '@tick/shared'
import { TodoRow } from './TodoRow'

export function TodoList({
  todos,
  recent,
  onArchive,
  onEnter,
  onRename,
}: {
  todos: Todo[]
  /** todoId → 最近会话摘要；缺省/没有会话时行内不显示第二行 */
  recent?: Record<string, TodoRecentSession>
  onArchive: (todo: Todo) => void
  onEnter: (todo: Todo) => void
  onRename: (todo: Todo, title: string) => void
}): React.JSX.Element {
  return (
    <>
      {todos.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          recentSession={recent?.[todo.id]}
          onArchive={onArchive}
          onEnter={onEnter}
          onRename={onRename}
        />
      ))}
    </>
  )
}
