/**
 * App — 面板首页（M0：顶栏 + 捕获行 + 线索列表 + 空态 + 归档 toast）。
 * 严格按 UI-SPEC §5 页面结构与 §6.1/6.3 交互：
 *  - 点捕获行 → 捕获态（回车收下 / Esc 取消）
 *  - 点勾选 → 立即归档（无确认框）→ 顶部 toast 3s「已归档「X」· 撤销」
 *  - 列表只显示 open；done 在归档页（M1 接菜单）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo } from '@tick/shared'
import { CaptureLine } from '../features/editor/capture-line/CaptureLine'
import { TodoList } from '../features/list/TodoList'
import { Toast } from '../features/list/Toast'
import { useTodos } from './useTodos'

export default function App(): React.JSX.Element {
  const { todos, create, setStatus } = useTodos()
  const open = todos.filter((t) => t.status === 'open')

  const [toast, setToast] = useState<{ text: string; onUndo: () => void } | null>(null)
  const toastTimer = useRef<number>()

  const showToast = useCallback((text: string, onUndo: () => void) => {
    setToast({ text, onUndo })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  const archive = useCallback(
    (todo: Todo) => {
      setStatus(todo.id, 'done')
      showToast(
        `已归档「${todo.title}」`,
        // 撤销 = 复原为 open（材料层重新收下）
        () => {
          setStatus(todo.id, 'open')
          setToast(null)
        },
      )
    },
    [setStatus, showToast],
  )

  return (
    <div className="panel">
      <div className="panel-inner">
        <div className="topbar">
          <span className="topbar-title">线索</span>
          <button className="topbar-menu" title="菜单（归档 / 设置）" aria-label="菜单">
            ⋯
          </button>
        </div>

        <CaptureLine onSubmit={(title) => void create(title)} />

        <div className="content">
          {todos.length === 0 ? (
            <div className="empty">
              <div className="empty-title">想到什么就丢进来</div>
              <div className="empty-hint">一行字就够 —— 线索是索引，AI 会话是你随时可以接着做的地方</div>
            </div>
          ) : (
            <TodoList todos={open} onArchive={archive} />
          )}
        </div>

        {toast && <Toast text={toast.text} onUndo={toast.onUndo} />}
      </div>
    </div>
  )
}
