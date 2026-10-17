/**
 * ArchiveList — 归档页（PRD F2：完成只改状态；恢复 = 改回 open，绑定不清空）。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { relTime } from './relTime'

export function ArchiveList({
  todos,
  onRestore,
  onOpen,
}: {
  todos: Todo[]
  onRestore: (todo: Todo) => void
  onOpen: (todo: Todo) => void
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
        <div className="thread-row done" key={todo.id}>
          <span className="check done" aria-hidden>
            ✓
          </span>
          <button className="title title-button" onClick={() => onOpen(todo)}>
            {todo.title}
          </button>
          <span className="time">{relTime(todo.updatedAt, new Date())}</span>
          <button className="action" onClick={() => onRestore(todo)}>
            恢复
          </button>
        </div>
      ))}
    </>
  )
}
