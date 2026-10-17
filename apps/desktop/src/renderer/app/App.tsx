/**
 * App — 面板首页。
 *
 * 视图：线索（默认）/ 归档 / 对话（面板 Chat）。
 * 交互（UI-SPEC §6 + PRD F1/F2）：
 *  - 点捕获行 → 输入态（回车收下 / Esc 取消）；⌘⇧N 全局快捷键直接聚焦
 *  - 点勾选 → 立即归档（无确认框）→ toast 3s「已归档「X」· 撤销」
 *  - 点标题 → 展开/编辑（标题/正文/状态/删除）
 *  - 悬停线索行 → 右端时间换「继续」→ 打开 AiPicker（项目 / 投递 / 接着做）
 *  - ⋯ 菜单：归档页 / 设置（后续接入 S5、导出）
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo } from '@tick/shared'
import { CaptureLine } from '../features/editor/capture-line/CaptureLine'
import { TodoList } from '../features/list/TodoList'
import { ArchiveList } from '../features/list/ArchiveList'
import { Toast } from '../features/list/Toast'
import { ChatPanel } from '../features/panel-chat/ChatPanel'
import { AiPicker } from '../features/ai-picker/AiPicker'
import { TodoDetail } from '../features/todo-detail/TodoDetail'
import { SettingsSheet } from '../features/settings/SettingsSheet'
import { SessionPicker } from '../features/sessions/SessionPicker'
import { useTodos } from './useTodos'
import { useProjects } from './useProjects'
import { useSettings } from './useSettings'

type View = 'threads' | 'archive' | 'chat'

export default function App(): React.JSX.Element {
  const { todos, create, patch, setStatus, remove, refresh: refreshTodos } = useTodos()
  const { projects, refresh: refreshProjects } = useProjects()
  const { settings, update: updateSettings } = useSettings()
  const open = todos.filter((t) => t.status === 'open')
  const done = todos.filter((t) => t.status === 'done')

  const [view, setView] = useState<View>('threads')
  const [toast, setToast] = useState<{ text: string; onUndo?: () => void } | null>(null)
  const [picker, setPicker] = useState<Todo | null>(null)
  const [detail, setDetail] = useState<Todo | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionPicker, setSessionPicker] = useState<{ todo: Todo | null } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [focusSignal, setFocusSignal] = useState(0)
  const toastTimer = useRef<number>()

  const showToast = useCallback((text: string, onUndo?: () => void) => {
    setToast({ text, onUndo })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3000)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  // 全局快捷键「新建线索」：main → renderer（无论在哪个视图/浮层，都回到线索页并聚焦捕获行）
  useEffect(
    () =>
      window.tick.window.onNewTodo(() => {
        setView('threads')
        setDetail(null)
        setSettingsOpen(false)
        setSessionPicker(null)
        setMenuOpen(false)
        setFocusSignal((n) => n + 1)
      }),
    [],
  )

  const archive = useCallback(
    (todo: Todo) => {
      void setStatus(todo.id, 'done')
      showToast(`已归档「${todo.title}」`, () => {
        void setStatus(todo.id, 'open')
        setToast(null)
      })
    },
    [setStatus, showToast],
  )

  const restore = useCallback(
    (todo: Todo) => {
      void setStatus(todo.id, 'open')
      showToast(`已恢复「${todo.title}」`)
    },
    [setStatus, showToast],
  )

  // sheet 里的 todo 可能被归档/删除：跟着列表走，找不到就关掉
  const activePicker = picker ? (open.find((t) => t.id === picker.id) ?? null) : null
  const activeDetail = detail ? (todos.find((t) => t.id === detail.id) ?? null) : null
  const visibleOpen = expanded ? open : open.slice(0, 5)

  return (
    <div className="panel">
      {activePicker ? (
        /* §6.4 新建会话：整页，非弹层 */
        <AiPicker
          todo={activePicker}
          projects={projects}
          settings={settings}
          refreshProjects={refreshProjects}
          onClose={() => setPicker(null)}
          onResult={(text) => showToast(text)}
        />
      ) : view === 'chat' ? (
        <ChatPanel
          onBack={() => setView('threads')}
          projects={projects}
          onToast={showToast}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      ) : (
        <div className="panel-inner">
          <div className="topbar">
            {view === 'archive' ? (
              <button className="topbar-back" onClick={() => setView('threads')} aria-label="返回线索">
                ‹
              </button>
            ) : null}
            <span className="topbar-title">{view === 'archive' ? '归档' : '线索'}</span>
            <div className="topbar-right">
              {view === 'threads' && (
                <button className="topbar-menu" title="对话（面板 Chat）" onClick={() => setView('chat')}>
                  ⌘对话
                </button>
              )}
              <button
                className="topbar-menu"
                title="菜单（归档 / 设置）"
                aria-label="菜单"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </button>
            </div>
          </div>

          {menuOpen && (
            <div className="menu-pop" onMouseLeave={() => setMenuOpen(false)}>
              <button
                className="menu-item"
                onClick={() => {
                  setView('archive')
                  setMenuOpen(false)
                }}
              >
                归档
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setSessionPicker({ todo: null })
                  setMenuOpen(false)
                }}
              >
                认领历史会话
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  void window.tick.export
                    .run({ scope: 'open' })
                    .then((r) => showToast(`已导出未完成 ${r.todoCount} 条到 exports/`))
                    .catch((e) => showToast(`导出失败：${(e as Error).message}`))
                }}
              >
                导出未完成…
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  void window.tick.export
                    .run({ scope: 'all' })
                    .then((r) => showToast(`已导出全部 ${r.todoCount} 条到 exports/`))
                    .catch((e) => showToast(`导出失败：${(e as Error).message}`))
                }}
              >
                导出全部…
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setSettingsOpen(true)
                  setMenuOpen(false)
                }}
              >
                设置
              </button>
            </div>
          )}

          {view === 'threads' && (
            <CaptureLine
              focusSignal={focusSignal}
              onSubmit={(title) => {
                void create(title).then((todo) => {
                  // 标题为空是静默拒绝（业务规则 1）；其它失败（锁占用/写盘错误）必须让用户知道
                  if (!todo && title.trim()) showToast('没保存成功：todos.json 可能被占用')
                })
              }}
            />
          )}

          <div className="content" onClick={() => setDetail(null)}>
            {/* §5 展开态：线索卡片 + 次要线索（点卡片外空白折叠，§6.1） */}
            {activeDetail && (
              <TodoDetail
                todo={activeDetail}
                onClose={() => setDetail(null)}
                onSave={async (p) => {
                  const updated = await patch(activeDetail.id, p)
                  return Boolean(updated)
                }}
                onSetStatus={(status) => {
                  void setStatus(activeDetail.id, status)
                  setDetail(null)
                  // §4.3：归档 toast 必须带撤销（列表勾选与卡片勾选同口径）
                  if (status === 'done') {
                    showToast(`已归档「${activeDetail.title}」`, () => {
                      void setStatus(activeDetail.id, 'open')
                      setToast(null)
                    })
                  } else {
                    showToast('已恢复')
                  }
                }}
                onDelete={() => {
                  void remove(activeDetail.id).then((ok) => {
                    showToast(ok ? '已删除（会话文件未动）' : '删除失败')
                  })
                }}
                onContinue={() => {
                  setDetail(null)
                  setPicker(activeDetail)
                }}
                onClaimSessions={() => {
                  setDetail(null)
                  setSessionPicker({ todo: activeDetail })
                }}
                onSessionsChanged={() => void refreshTodos()}
                onToast={showToast}
                usageEnabled={settings.usageEnabled}
              />
            )}
            {view === 'archive' ? (
              <ArchiveList todos={done} onRestore={restore} onOpen={(t) => setDetail(t)} />
            ) : open.length === 0 && done.length === 0 ? (
              <div className="empty">
                <div className="empty-title">想到什么就丢进来</div>
                <div className="empty-hint">一行字就够 —— 线索是索引，AI 会话是你随时可以接着做的地方</div>
                <button className="empty-action" onClick={() => setSessionPicker({ todo: null })}>
                  从历史会话认领一条 →
                </button>
              </div>
            ) : open.length === 0 ? (
              <div className="empty">
                <div className="empty-title">都做完了</div>
                <div className="empty-hint">归档里还留着它们，随时可以恢复</div>
                <button className="empty-action" onClick={() => setView('archive')}>
                  去归档里看看 →
                </button>
              </div>
            ) : (
              <>
                <TodoList
                  todos={visibleOpen}
                  onArchive={archive}
                  onContinue={(t) => setPicker(t)}
                  onOpen={(t) => setDetail(t)}
                />
                {open.length > 5 && (
                  <button
                    className="list-more"
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpanded((v) => !v)
                    }}
                  >
                    {expanded ? '收起' : `展开全部（${open.length}）`}
                  </button>
                )}
              </>
            )}
          </div>

          {sessionPicker && (
            <SessionPicker
              todo={sessionPicker.todo ?? undefined}
              onClose={() => setSessionPicker(null)}
              onChanged={() => void refreshTodos()}
              onToast={showToast}
            />
          )}

          {settingsOpen && (
            <SettingsSheet
              settings={settings}
              onChange={(p) => void updateSettings(p)}
              onClose={() => setSettingsOpen(false)}
              onToast={showToast}
            />
          )}
        </div>
      )}

      {/* toast 在所有页面（线索/新建会话/面板对话）都可浮于捕获行上方 */}
      {toast && <Toast text={toast.text} onUndo={toast.onUndo} />}
    </div>
  )
}
