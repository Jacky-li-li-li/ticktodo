/**
 * App — 面板首页。
 *
 * 视图：线索（默认）/ 归档 / 对话（面板 Chat）/ 线索详情（整页）。
 * 交互（重构 2026-10-18）：
 *  - 点捕获行 → 输入态（回车收下 / Esc 取消）；⌘⇧N 全局快捷键直接聚焦
 *  - 点勾选 → 立即归档（无确认框）→ toast 3s「已归档「X」· 撤销」
 *  - 点行 / 右侧箭头图标 → 进入线索详情页（首页不再内联展开）
 *  - 双击标题 → 原地改标题（Enter/失焦保存，Esc 取消）
 *  - ⋯ 菜单：归档页 / 认领历史会话 / 导出 / 设置
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Todo } from '@tick/shared'
import { CaptureLine } from '../features/editor/capture-line/CaptureLine'
import { TodoList } from '../features/list/TodoList'
import { ArchiveList } from '../features/list/ArchiveList'
import { Toast } from '../features/list/Toast'
import { ChatPanel } from '../features/panel-chat/ChatPanel'
import { AiPicker } from '../features/ai-picker/AiPicker'
import { TodoDetailPage } from '../features/todo-detail/TodoDetailPage'
import { SettingsSheet } from '../features/settings/SettingsSheet'
import { SessionPicker } from '../features/sessions/SessionPicker'
import { useTodos } from './useTodos'
import { useProjects } from './useProjects'
import { useSettings } from './useSettings'
import { TickMark } from '../features/brand/TickMark'
import { ChatIcon } from '../features/icons/ChatIcon'
import { PinIcon } from '../features/icons/PinIcon'

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
  const [detailId, setDetailId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionPicker, setSessionPicker] = useState<{ todo: Todo | null } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pinned, setPinned] = useState(true)
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

  // 鼠标点击后不显示 focus ring（系统 accent 橙色框），键盘 Tab 仍保留可见焦点。
  useEffect(() => {
    const root = document.documentElement
    const markPointer = (): void => root.classList.add('using-pointer')
    const markKeyboard = (): void => root.classList.remove('using-pointer')
    document.addEventListener('pointerdown', markPointer, true)
    document.addEventListener('keydown', markKeyboard, true)
    return () => {
      document.removeEventListener('pointerdown', markPointer, true)
      document.removeEventListener('keydown', markKeyboard, true)
    }
  }, [])

  // 置顶开关：main 持久化在 cache/window-state.json；关闭后失焦自动隐藏
  useEffect(() => {
    let alive = true
    void window.tick.window
      .getPinned()
      .then((v) => {
        if (alive) setPinned(v)
      })
      .catch(() => {
        /* 读取失败保持默认置顶 */
      })
    return () => {
      alive = false
    }
  }, [])

  const togglePinned = useCallback(() => {
    const next = !pinned
    setPinned(next)
    void window.tick.window
      .setPinned(next)
      .then(setPinned)
      .catch(() => setPinned(!next))
  }, [pinned])

  // 全局快捷键「新建线索」：main → renderer（无论在哪个视图/浮层，都回到线索页并聚焦捕获行）
  useEffect(
    () =>
      window.tick.window.onNewTodo(() => {
        setView('threads')
        setDetailId(null)
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

  // sheet / 详情页里的 todo 可能被归档/删除：跟着列表走，找不到就关掉
  const activePicker = picker ? (open.find((t) => t.id === picker.id) ?? null) : null
  const activeDetail = detailId ? (todos.find((t) => t.id === detailId) ?? null) : null
  const baseOpen = expanded ? open : open.slice(0, 5)

  useEffect(() => {
    if (detailId && !todos.some((t) => t.id === detailId)) setDetailId(null)
  }, [todos, detailId])

  // 首页双击标题 → 原地改名（空标题/未变则静默忽略）
  const rename = useCallback(
    (todo: Todo, next: string) => {
      const title = next.trim()
      if (!title || title === todo.title) return
      void patch(todo.id, { title }).then((updated) => {
        showToast(updated ? '已改标题' : '改标题失败')
      })
    },
    [patch, showToast],
  )

  return (
    <div className="panel">
      {activePicker ? (
        /* §6.4 新建会话：整页，非弹层 */
        <AiPicker
          todo={activePicker}
          projects={projects}
          settings={settings}
          refreshProjects={refreshProjects}
          onClose={() => {
            setPicker(null)
            void refreshTodos()
          }}
          onResult={(text) => showToast(text)}
        />
      ) : activeDetail ? (
        <TodoDetailPage
          key={activeDetail.id}
          todo={activeDetail}
          onBack={() => setDetailId(null)}
          onSave={async (p) => Boolean(await patch(activeDetail.id, p))}
          onSetStatus={(status) => {
            if (status === 'done') archive(activeDetail)
            else restore(activeDetail)
          }}
          onDelete={() => {
            void remove(activeDetail.id).then((ok) => {
              setDetailId(null)
              showToast(ok ? '已删除（会话文件未动）' : '删除失败')
            })
          }}
          onNewSession={() => setPicker(activeDetail)}
          onClaimSessions={() => setSessionPicker({ todo: activeDetail })}
          onSessionsChanged={() => void refreshTodos()}
          onToast={showToast}
          usageEnabled={settings.usageEnabled}
        >
          {sessionPicker && (
            <SessionPicker
              todo={sessionPicker.todo ?? undefined}
              onClose={() => setSessionPicker(null)}
              onChanged={() => void refreshTodos()}
              onToast={showToast}
            />
          )}
        </TodoDetailPage>
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
            {view === 'archive' ? (
              <span className="topbar-title">归档</span>
            ) : (
              <span className="topbar-title topbar-brand">
                <TickMark size={16} />
                <span className="brand-name">Ticktodo</span>
              </span>
            )}
            <div className="topbar-right">
              <button
                className={`topbar-icon ${pinned ? 'is-on' : ''}`}
                title={pinned ? '已置顶：点击取消（取消后点击外部会自动收起）' : '置顶窗口'}
                aria-label={pinned ? '取消置顶' : '置顶窗口'}
                aria-pressed={pinned}
                onClick={togglePinned}
              >
                <PinIcon />
              </button>
              {view === 'threads' && (
                <button
                  className="topbar-icon"
                  title="对话（面板 Chat）"
                  aria-label="打开对话"
                  onClick={() => setView('chat')}
                >
                  <ChatIcon />
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

          <div className="content">
            {view === 'archive' ? (
              <ArchiveList
                todos={done}
                onRestore={restore}
                onEnter={(t) => setDetailId(t.id)}
                onRename={rename}
              />
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
                  todos={baseOpen}
                  onArchive={archive}
                  onEnter={(t) => setDetailId(t.id)}
                  onRename={rename}
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
