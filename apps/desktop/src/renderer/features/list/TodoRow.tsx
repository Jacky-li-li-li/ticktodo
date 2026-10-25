/**
 * TodoRow — 首页 / 归档页共用的线索行（重构：首页不再内联展开）。
 *
 * 交互：
 *  - 点行内空白或右侧「进入」图标 → 打开详情页
 *  - 双击标题 → 原地改标题（Enter/失焦保存，Esc 取消；空标题不保存）
 *  - 勾选圆 → 归档；归档页右侧「恢复」→ 恢复
 *  - 「继续」胶囊已移除，改为右侧圆形箭头图标按钮
 */

import React, { useEffect, useRef, useState } from 'react'
import type { Todo, TodoRecentSession } from '@tick/shared'
import { toolDisplayName } from '@tick/shared'
import { relTime } from './relTime'
import { EnterIcon } from '../icons/EnterIcon'

const Check = (): React.JSX.Element => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 4.8L3.6 7L7.5 2.2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function TodoRow({
  todo,
  done = false,
  recentSession,
  onArchive,
  onRestore,
  onEnter,
  onRename,
}: {
  todo: Todo
  done?: boolean
  /** 时间线 P0-6：最近一条绑定会话的最后一句（没有就不占位） */
  recentSession?: TodoRecentSession
  onArchive?: (todo: Todo) => void
  onRestore?: (todo: Todo) => void
  onEnter: (todo: Todo) => void
  onRename: (todo: Todo, title: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(todo.title)
  const cancelRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 外部（其他窗口 / extension）改了标题时同步草稿
  useEffect(() => {
    if (!editing) setDraft(todo.title)
  }, [todo.title, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    if (cancelRef.current) {
      cancelRef.current = false
      setDraft(todo.title)
      return
    }
    const next = draft.trim()
    if (next && next !== todo.title) onRename(todo, next)
    else setDraft(todo.title)
  }

  const lastText = recentSession?.lastUserMessage?.trim()
  const toolName = recentSession ? toolDisplayName(recentSession.toolId) : ''
  const stateLabel =
    recentSession?.state === 'active'
      ? '进行中'
      : recentSession?.state === 'done'
        ? '已结束'
        : recentSession?.state === 'missing'
          ? '不在本机'
          : '已停下'

  return (
    <div
      className={`thread-row ${done ? 'done' : ''}`}
      onClick={() => {
        if (!editing) onEnter(todo)
      }}
    >
      {done ? (
        <span className="check" aria-hidden>
          <Check />
        </span>
      ) : (
        <button
          className="check"
          onClick={(e) => {
            e.stopPropagation()
            onArchive?.(todo)
          }}
          aria-label={`归档「${todo.title}」`}
        >
          <Check />
        </button>
      )}

      <div className="thread-main">
        {editing ? (
          <input
            ref={inputRef}
            className="title-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                cancelRef.current = true
                e.currentTarget.blur()
              }
            }}
            onBlur={commit}
            aria-label="修改标题"
          />
        ) : (
          <button
            className="title title-button"
            title="双击修改标题"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {todo.title}
          </button>
        )}

        {/* P0-6：标题下一行 = 最近一条会话的最后一句（单行截断，悬停看全文） */}
        {!editing && lastText && (
          <span
            className={`thread-last ${recentSession?.state === 'active' ? 'is-active' : ''}`}
            title={`${toolName} · ${stateLabel}：${lastText}`}
          >
            {lastText}
          </span>
        )}
      </div>

      <span className="time">{relTime(todo.updatedAt, new Date())}</span>

      {done && onRestore && (
        <button
          className="action secondary"
          onClick={(e) => {
            e.stopPropagation()
            onRestore(todo)
          }}
        >
          恢复
        </button>
      )}

      <button
        className="row-enter"
        onClick={(e) => {
          e.stopPropagation()
          if (!editing) onEnter(todo)
        }}
        aria-label={`进入「${todo.title}」`}
        title="进入线索详情"
      >
        <EnterIcon />
      </button>
    </div>
  )
}
