/**
 * App — 面板首页。
 *
 * 视图：线索（默认）/ 对话（M2 面板 Chat）/ 归档（M3）。
 * 交互（UI-SPEC §6）：
 *  - 点捕获行 → 输入态（回车收下 / Esc 取消）
 *  - 点勾选 → 立即归档（无确认框）→ 顶部 toast 3s「已归档「X」· 撤销」
 *  - 悬停线索行 → 右端时间换「继续」→ 打开 AiPicker（项目 / 投递 / 接着做）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo } from '@tick/shared'
import { CaptureLine } from '../features/editor/capture-line/CaptureLine'
import { TodoList } from '../features/list/TodoList'
import { Toast } from '../features/list/Toast'
import { ChatPanel } from '../features/panel-chat/ChatPanel'
import { AiPicker } from '../features/ai-picker/AiPicker'
import { useTodos } from './useTodos'
import { useProjects } from './useProjects'

type View = 'threads' | 'chat'

export default function App(): React.JSX.Element {
  const { todos, create, setStatus } = useTodos()
  const projects = useProjects()
  const open = todos.filter((t) => t.status === 'open')

  const [view, setView] = useState<View>('threads')
  const [toast, setToast] = useState<{ text: string; onUndo?: () => void } | null>(null)
  const [picker, setPicker] = useState<Todo | null>(null)
  const toastTimer = useRef<number>()

  const showToast = useCallback((text: string, onUndo?: () => void) => {
    setToast({ text, onUndo })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const archive = useCallback(
    (todo: Todo) => {
      setStatus(todo.id, 'done')
      showToast(`已归档「${todo.title}」`, () => {
        setStatus(todo.id, 'open')
        setToast(null)
      })
    },
    [setStatus, showToast],
  )

  // picker 里的 todo 可能被归档/删除：跟着列表走，找不到就关掉
  const activePicker = picker ? (open.find((t) => t.id === picker.id) ?? null) : null

  return (
    <div className="panel">
      {view === 'chat' ? (
        <ChatPanel onBack={() => setView('threads')} />
      ) : (
        <div className="panel-inner">
          <div className="topbar">
            <span className="topbar-title">线索</span>
            <div className="topbar-right">
              <button className="topbar-menu" title="对话（面板 Chat）" onClick={() => setView('chat')}>
                ⌘对话
              </button>
              <button className="topbar-menu" title="菜单（归档 / 设置）" aria-label="菜单">
                ⋯
              </button>
            </div>
          </div>

          <CaptureLine onSubmit={(title) => void create(title)} />

          <div className="content">
            {todos.length === 0 ? (
              <div className="empty">
                <div className="empty-title">想到什么就丢进来</div>
                <div className="empty-hint">一行字就够 —— 线索是索引，AI 会话是你随时可以接着做的地方</div>
              </div>
            ) : (
              <TodoList todos={open} onArchive={archive} onContinue={(t) => setPicker(t)} />
            )}
          </div>

          {activePicker && (
            <AiPicker
              todo={activePicker}
              projects={projects}
              onClose={() => setPicker(null)}
              onResult={(text) => showToast(text)}
            />
          )}

          {toast && <Toast text={toast.text} onUndo={toast.onUndo} />}
        </div>
      )}
    </div>
  )
}
