/**
 * TodoList — 首页线索列表（§4.2，重构后不再内联展开）。
 *
 * 行交互见 TodoRow：点标题 / 行 / 右侧箭头进详情，勾选圆归档。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { TodoRow } from './TodoRow'

export function TodoList({
  todos,
  onArchive,
  onEnter,
}: {
  todos: Todo[]
  onArchive: (todo: Todo) => void
  onEnter: (todo: Todo) => void
}): React.JSX.Element {
  return (
    <>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} onArchive={onArchive} onEnter={onEnter} />
      ))}
    </>
  )
}
