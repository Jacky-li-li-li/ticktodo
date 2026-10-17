/**
 * ArchiveList — 归档页（PRD F2：完成只改状态；恢复 = 改回 open，绑定不清空）。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { relTime } from './relTime'

const Check = (): React.JSX.Element => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 4.8L3.6 7L7.5 2.2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

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
        <div className="thread-row done" key={todo.id} onClick={(e) => e.stopPropagation()}>
          <span className="check" aria-hidden>
            <Check />
          </span>
          <button className="title title-button" onClick={() => onOpen(todo)}>
            {todo.title}
          </button>
          <span className="time">{relTime(todo.updatedAt, new Date())}</span>
          {/* §4.2 归档页悬停：「恢复」胶囊（次按钮，撤销是唯一动作） */}
          <button className="action secondary" onClick={() => onRestore(todo)}>
            恢复
          </button>
        </div>
      ))}
    </>
  )
}
