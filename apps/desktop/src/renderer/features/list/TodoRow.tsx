/**
 * TodoRow — 首页 / 归档页共用的线索行（重构：首页不再内联展开）。
 *
 * 交互：
 *  - 点标题 / 行内空白 / 右侧「进入」图标 → 打开详情页（改名入口在详情页标题上）
 *  - 勾选圆 → 归档；归档页右侧「恢复」→ 恢复
 *  - 列表行不提供改名：单击即进入，避免最大的点击区（标题）成为无响应死区
 *  - P0-6：标题下一行 = 最近一条会话的最后一条 user 消息（单行截断，悬停看全文）
 */

import React from 'react'
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
}: {
  todo: Todo
  done?: boolean
  /** 时间线 P0-6：最近一条绑定会话的最后一句（没有就不占位） */
  recentSession?: TodoRecentSession
  onArchive?: (todo: Todo) => void
  onRestore?: (todo: Todo) => void
  onEnter: (todo: Todo) => void
}): React.JSX.Element {
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
    <div className={`thread-row ${done ? 'done' : ''}`} onClick={() => onEnter(todo)}>
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
        {/* 点击自然冒泡到行 → 进详情；不 stopPropagation，避免标题成为无响应死区 */}
        <button className="title title-button">{todo.title}</button>

        {/* P0-6：标题下一行 = 最近一条会话的最后一句（单行截断，悬停看全文） */}
        {lastText && (
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
          onEnter(todo)
        }}
        aria-label={`进入「${todo.title}」`}
        title="进入线索详情"
      >
        <EnterIcon />
      </button>
    </div>
  )
}
