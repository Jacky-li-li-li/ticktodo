/**
 * ArchiveList — 归档页（PRD F2：完成只改状态；恢复 = 改回 open，绑定不清空）。
 * 与首页同构：点行进详情，悬停「恢复」。改名入口在详情页标题。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { TodoRow } from './TodoRow'

export function ArchiveList({
  todos,
  onRestore,
  onEnter,
}: {
  todos: Todo[]
  onRestore: (todo: Todo) => void
  onEnter: (todo: Todo) => void
}): React.JSX.Element {
  if (todos.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">还没有归档</div>
        <div className="empty-hint">完成的线索会安静地留在这里，随时可以恢复</div>
      </div>
    )
  }
  return (
    <>
      {todos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} done onRestore={onRestore} onEnter={onEnter} />
      ))}
    </>
  )
}
