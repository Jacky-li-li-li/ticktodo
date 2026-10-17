/**
 * ArchiveList — 归档页（PRD F2：完成只改状态；恢复 = 改回 open，绑定不清空）。
 * 与首页同构：展开态在点击的那一行原地替换成线索卡片。
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
  activeId,
  renderDetail,
}: {
  todos: Todo[]
  onRestore: (todo: Todo) => void
  onOpen: (todo: Todo) => void
  /** 当前展开的线索 id：命中时该行原地替换成卡片 */
  activeId?: string | null
  renderDetail?: (todo: Todo) => React.ReactNode
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
      {todos.map((todo) => {
        if (activeId === todo.id && renderDetail) {
          return <React.Fragment key={todo.id}>{renderDetail(todo)}</React.Fragment>
        }
        return (
          <div
            className="thread-row done"
            key={todo.id}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(todo)
            }}
          >
            <span className="check" aria-hidden>
              <Check />
            </span>
            <button
              className="title title-button"
              onClick={(e) => {
                e.stopPropagation()
                onOpen(todo)
              }}
            >
              {todo.title}
            </button>
            <span className="time">{relTime(todo.updatedAt, new Date())}</span>
            {/* §4.2 归档页悬停：「恢复」胶囊（次按钮，撤销是唯一动作） */}
            <button
              className="action secondary"
              onClick={(e) => {
                e.stopPropagation()
                onRestore(todo)
              }}
            >
              恢复
            </button>
          </div>
        )
      })}
    </>
  )
}
