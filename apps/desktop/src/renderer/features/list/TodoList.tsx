/**
 * TodoList — 首页线索列表（§4.2，重构后不再内联展开）。
 *
 * 行交互见 TodoRow：点行进详情 / 双击标题改标题 / 勾选归档 / 右侧箭头进入。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { TodoRow } from './TodoRow'

export function TodoList({
  todos,
  onArchive,
  onEnter,
  onRename,
}: {
  todos: Todo[]
  onArchive: (todo: Todo) => void
  onEnter: (todo: Todo) => void
  onRename: (todo: Todo, title: string) => void
}): React.JSX.Element {
  return (
    <>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} onArchive={onArchive} onEnter={onEnter} onRename={onRename} />
      ))}
    </>
  )
}
