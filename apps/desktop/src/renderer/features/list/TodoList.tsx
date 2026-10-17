/**
 * TodoList / ThreadRow — 线索列表与线索行（§4.2）。
 * 状态映射：open → 静止行（右：时间）/ hover（右：继续胶囊）；done 不在本列表（归档页 M1）。
 * 无会话时不显示时间（不编造，§4.2）——M0 无绑定，时间取 updatedAt。
 */

import React from 'react'
import type { Todo } from '@tick/shared'
import { relTime } from './relTime'

const Check = (): React.JSX.Element => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 4.8L3.6 7L7.5 2.2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function TodoList({
  todos,
  onArchive,
}: {
  todos: Todo[]
  onArchive: (todo: Todo) => void
}): React.JSX.Element {
  return (
    <>
      {todos.map((todo) => (
        <div className="thread-row" key={todo.id}>
          <button
            className="check"
            onClick={() => onArchive(todo)}
            aria-label={`归档「${todo.title}」`}
          >
            <Check />
          </button>
          <span className="title">{todo.title}</span>
          <span className="time">{relTime(todo.updatedAt, new Date())}</span>
          {/* M0：继续动作占位（M1 接 AiPicker/launch） */}
          <button className="action">继续</button>
        </div>
      ))}
    </>
  )
}
