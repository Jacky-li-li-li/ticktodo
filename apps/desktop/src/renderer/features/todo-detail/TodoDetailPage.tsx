/**
 * TodoDetailPage — 一条线索的全量信息页（重构：首页不再内联展开，点行进这里）。
 *
 * 信息分层（自上而下）：
 *  1) 顶栏标题（双击只编辑标题；Enter/失焦保存、Esc 放弃）
 *  2) 补充上下文 body（双击进入编辑；失焦/Enter 保存、Shift+Enter 换行、Esc 放弃）
 *  3) 元信息：状态灯 / 来源 / 创建更新与最近拉起（悬停标题查看）
 *  4) 主操作：会话标题行右侧图标（新建会话 / 倒入历史会话）
 *  5) 会话列表：按项目（cwd）分组，组头显示项目名与路径；每条会话第一行 = 第一条 user 消息
 *     （与最后一条不同时再显示「上次」）、工具图标、时间与状态；
 *     右侧 1/8 为滑块（单击接着做 / 按住左拖到底解绑），设置开启时显示单会话用量
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Todo, TodoPatch, TodoSessionView } from '@tick/shared'
import type { SessionUsage } from '@tick/ai-core'
import { relTime } from '../list/relTime'
import { ToolIcon } from '../icons/ToolIcon'
import { PlusIcon } from '../icons/PlusIcon'
import { ImportIcon } from '../icons/ImportIcon'
import { TrashIcon } from '../icons/TrashIcon'

const cwdLabel = (p?: string): string => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '')

interface SessionProjectGroup {
  cwd: string
  name: string
  sessions: TodoSessionView[]
  latest: number
}

/** 会话按项目（cwd）分组：组间按最近使用倒序，组内同样倒序 */
function groupSessionsByProject(sessions: TodoSessionView[]): SessionProjectGroup[] {
  const map = new Map<string, TodoSessionView[]>()
  for (const s of sessions) {
    const key = s.cwd || '(未知项目)'
    const list = map.get(key)
    if (list) list.push(s)
    else map.set(key, [s])
  }
  return [...map.entries()]
    .map(([cwd, list]) => ({
      cwd,
      name: cwd.split('/').filter(Boolean).pop() ?? cwd,
      sessions: [...list].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
      latest: Math.max(...list.map((s) => s.lastUsedAt ?? 0)),
    }))
    .sort((a, b) => b.latest - a.latest)
}

/** 悬停标题时展示的绝对时间：今年省略年份，跨年带年 */
const absTime = (iso?: string): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  const date = d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年 ${md}`
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${date} ${hm}`
}

export function TodoDetailPage({
  todo,
  onBack,
  onSave,
  onNewSession,
  onClaimSessions,
  onSessionsChanged,
  onToast,
  usageEnabled,
  children,
}: {
  todo: Todo
  onBack: () => void
  onSave: (patch: TodoPatch) => Promise<boolean>
  onNewSession: () => void
  onClaimSessions: () => void
  onSessionsChanged: () => void
  onToast: (text: string) => void
  usageEnabled: boolean
  /** 浮层（如倒入历史会话）挂在本页内，保证 sheet 的绝对定位仍相对面板 */
  children?: React.ReactNode
}): React.JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [body, setBody] = useState(todo.body ?? '')
  /** 标题与描述分开编辑：标题在顶栏，补充上下文在正文区，互不干扰 */
  const [editing, setEditing] = useState<'title' | 'body' | null>(null)
  const [hoverTimes, setHoverTimes] = useState(false)
  const skipSaveRef = useRef(false)
  const [sessions, setSessions] = useState<TodoSessionView[]>([])
  const [usages, setUsages] = useState<Record<string, SessionUsage | undefined>>({})
  const [pendingUnbind, setPendingUnbind] = useState<TodoSessionView | null>(null)

  useEffect(() => {
    if (editing === null) {
      setTitle(todo.title)
      setBody(todo.body ?? '')
    }
  }, [todo.title, todo.body, editing])

  const loadSessions = useCallback((): void => {
    void window.tick.sessions
      .forTodo(todo.id)
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [todo.id])

  useEffect(() => {
    loadSessions()
  }, [loadSessions, todo.primarySessionId, todo.bindings.length])

  // 会话文件在终端里持续写入：回到前台 / 窗口聚焦 / 每 15s 刷新一次
  useEffect(() => {
    const refresh = (): void => loadSessions()
    const onVisibility = (): void => {
      if (!document.hidden) loadSessions()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(() => {
      if (!document.hidden) loadSessions()
    }, 15_000)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [loadSessions])

  // 用量只在设置开启时按需算（F6-b：默认关；只算这条 todo 的会话）
  useEffect(() => {
    if (!usageEnabled) {
      setUsages({})
      return
    }
    let alive = true
    void Promise.all(
      sessions.map(async (s) => {
        const usage = await window.tick.usage.get(s.toolId, s.sessionId).catch(() => undefined)
        return [s.sessionId, usage] as const
      }),
    ).then((entries) => {
      if (alive) setUsages(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [usageEnabled, sessions])

  const resumeSession = async (session: TodoSessionView): Promise<void> => {
    if (session.missing) return
    const out = await window.tick.launch.resume({
      todoId: todo.id,
      sessionId: session.sessionId,
      projectPath: session.cwd,
    })
    onToast(out.ok ? '已在终端里打开那个会话' : (out.reason ?? '打开失败'))
  }

  const unbind = async (session: TodoSessionView): Promise<void> => {
    const ok = await window.tick.sessions.unbind(todo.id, session.sessionId)
    if (ok) {
      loadSessions()
      onSessionsChanged()
      onToast('已解绑（会话文件未动）')
    }
  }

  /** 标题编辑：Enter 或失焦保存；空标题/未改动不保存；Esc 放弃 */
  const commitTitle = async (): Promise<void> => {
    setEditing(null)
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      setTitle(todo.title)
      return
    }
    const next = title.trim()
    if (!next) {
      setTitle(todo.title)
      return
    }
    if (next === todo.title) return
    const ok = await onSave({ title: next })
    if (!ok) {
      setTitle(todo.title)
      onToast('标题没保存成功')
    }
  }

  /** 补充上下文：点击空白（失焦）或 Enter 保存，Shift+Enter 换行，Esc 放弃 */
  const commitBody = async (): Promise<void> => {
    setEditing(null)
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      setBody(todo.body ?? '')
      return
    }
    const next = body.trim()
    if (next === (todo.body ?? '').trim()) return
    const ok = await onSave({ body: next || undefined })
    if (!ok) {
      setBody(todo.body ?? '')
      onToast('描述没保存成功')
    }
  }

  const done = todo.status === 'done'
  const projectGroups = useMemo(() => groupSessionsByProject(sessions), [sessions])

  return (
    <div className="panel-inner detail-page">
      <div className="topbar detail-topbar">
        <button className="topbar-back" onClick={onBack} aria-label="返回线索">
          ‹
        </button>
        <div
          className="detail-topbar-main"
          onMouseEnter={() => setHoverTimes(true)}
          onMouseLeave={() => setHoverTimes(false)}
        >
          {/* 标题前不放入口勾选：进行中 = 绿色呼吸灯，已归档 = 静态灰点（归档/恢复在「其他」里） */}
          <span className={`detail-status ${done ? 'done' : ''}`} aria-hidden="true" />
          {editing === 'title' ? (
            <input
              className="sheet-input detail-title-input"
              value={title}
              placeholder="标题（必填）"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  e.currentTarget.blur()
                } else if (e.key === 'Escape') {
                  skipSaveRef.current = true
                  e.currentTarget.blur()
                }
              }}
              onBlur={() => void commitTitle()}
              autoFocus
            />
          ) : (
            <h1
              className={`detail-topbar-title ${done ? 'done' : ''}`}
              title="双击修改标题"
              onDoubleClick={() => setEditing('title')}
            >
              {todo.title}
            </h1>
          )}

          {/* 悬停标题 → 来源 / 创建 / 更新 / 最近拉起（绝对时间） */}
          {hoverTimes && editing === null && (
            <div className="detail-times" role="tooltip">
              {todo.source && (
                <div className="detail-times-row">
                  <span>来源</span>
                  <span>{todo.source === 'panel' ? '面板对话' : 'CLI'}</span>
                </div>
              )}
              <div className="detail-times-row">
                <span>创建</span>
                <span>{absTime(todo.createdAt)}</span>
              </div>
              <div className="detail-times-row">
                <span>更新</span>
                <span>{absTime(todo.updatedAt)}</span>
              </div>
              {todo.lastLaunch?.launchedAt && (
                <div className="detail-times-row">
                  <span>最近拉起</span>
                  <span>{absTime(todo.lastLaunch.launchedAt)}</span>
                </div>
              )}
            </div>
          )}
        </div>
        {done && <span className="detail-chip">已归档</span>}
      </div>

      <div className="content detail-content">
        {/* 补充上下文：独立编辑 —— 失焦或 Enter 保存，Shift+Enter 换行，Esc 放弃 */}
        {editing === 'body' ? (
          <textarea
            className="sheet-textarea detail-body-input"
            value={body}
            placeholder="补充上下文：下一步 / 上下文 / 链接…"
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => void commitBody()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                skipSaveRef.current = true
                e.currentTarget.blur()
              }
            }}
            autoFocus
          />
        ) : todo.body ? (
          <div
            className="detail-body"
            title="双击编辑补充上下文"
            onDoubleClick={() => setEditing('body')}
          >
            {todo.body}
          </div>
        ) : (
          <button className="detail-body-empty" onClick={() => setEditing('body')}>
            ＋ 添加补充上下文（下一步 / 上下文 / 链接）
          </button>
        )}

        {/* 会话 */}
        <section className="detail-section">
          <div className="detail-section-head">
            <span className="detail-section-title">
              会话<span className="detail-count">{sessions.length}</span>
            </span>
            <div className="detail-section-actions">
              <button
                className="detail-icon-btn"
                onClick={onNewSession}
                title="新建会话"
                aria-label="新建会话"
              >
                <PlusIcon />
              </button>
              <button
                className="detail-icon-btn"
                onClick={onClaimSessions}
                title="倒入历史会话"
                aria-label="倒入历史会话"
              >
                <ImportIcon />
              </button>
            </div>
          </div>

          {sessions.length === 0 ? (
            <div className="detail-empty">
              还没有绑定会话。点右上角 ＋ 新建，或倒入一条历史会话。
            </div>
          ) : (
            <div className="detail-session-groups">
              {projectGroups.map((group) => (
                <div className="detail-project-group" key={group.cwd}>
                  <div className="detail-project-head" title={group.cwd}>
                    <span className="detail-project-name">{group.name}</span>
                    <span className="detail-project-path">{cwdLabel(group.cwd)}</span>
                  </div>
                  <div className="detail-sessions">
                    {group.sessions.map((s) => (
                      <SessionCard
                        key={s.sessionId}
                        session={s}
                        usage={usages[s.sessionId]}
                        usageEnabled={usageEnabled}
                        onResume={(session) => void resumeSession(session)}
                        onUnbindRequest={setPendingUnbind}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* 解绑二次确认：滑块拖到左端松手后弹出 */}
      {pendingUnbind && (
        <div className="sheet-backdrop" onPointerDown={() => setPendingUnbind(null)}>
          <div
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="sheet-head">
              <span className="sheet-title">解绑这个会话？</span>
              <button
                className="sheet-close"
                onClick={() => setPendingUnbind(null)}
                aria-label="取消"
              >
                ✕
              </button>
            </div>
            <div className="sheet-note">
              只解除这条线索与该会话的绑定，不会删除 AI 工具里的会话文件。
            </div>
            <div className="sheet-actions">
              <button className="secondary" onClick={() => setPendingUnbind(null)}>
                取消
              </button>
              <button
                className="danger"
                onClick={() => {
                  const s = pendingUnbind
                  setPendingUnbind(null)
                  void unbind(s)
                }}
              >
                解绑
              </button>
            </div>
          </div>
        </div>
      )}

      {children}
    </div>
  )
}

function usageText(usage: SessionUsage): string {
  const money = `${usage.costReported ? '' : '≥ '}$${usage.cost.total.toFixed(4)}`
  return `${usage.tokens.totalTokens.toLocaleString()} tokens · ${money}${usage.costReported ? '' : '（未上报）'}`
}

/**
 * SessionCard — 会话卡片 + 右侧 1/8 宽方块滑块。
 *
 * 交互：单击方块 = 接着做（方块右滑回弹 + 卡片轻推）；按住方块向左拖到卡片最左侧 1/8
 * 区（拖动时显示终点与引导线），松手 → 二次确认弹窗 → 解绑。
 * 会话文件不在本机时禁止「接着做」，但仍可拖拽解绑。
 */
function SessionCard({
  session: s,
  usage,
  usageEnabled,
  onResume,
  onUnbindRequest,
}: {
  session: TodoSessionView
  usage?: SessionUsage
  usageEnabled: boolean
  onResume: (session: TodoSessionView) => void
  onUnbindRequest: (session: TodoSessionView) => void
}): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const blockRef = useRef<HTMLButtonElement>(null)
  const startRef = useRef<{ x: number; y: number; maxLeft: number } | null>(null)
  const lockedRef = useRef(false)
  const movedRef = useRef(false)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false)
  const [pulse, setPulse] = useState(false)

  const firstText = (s.firstMessage ?? s.name ?? '未命名会话').trim()
  const lastText = s.lastMessage?.trim()

  const reset = (): void => {
    startRef.current = null
    lockedRef.current = false
    setDx(0)
    setDragging(false)
    setArmed(false)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0) return
    const card = cardRef.current
    const block = blockRef.current
    if (!card || !block) return
    const rect = card.getBoundingClientRect()
    const blockRect = block.getBoundingClientRect()
    // 终点 = 卡片最左侧 1/8 区的中心（W/16）；方块静止时贴右，中心 = rect.right - blockWidth/2
    const startCenter = rect.right - blockRect.width / 2
    const targetCenter = rect.left + rect.width / 16
    startRef.current = { x: e.clientX, y: e.clientY, maxLeft: targetCenter - startCenter }
    setDx(0)
    lockedRef.current = false
    movedRef.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const start = startRef.current
    if (!start) return
    const rawX = e.clientX - start.x
    const rawY = e.clientY - start.y
    if (!lockedRef.current) {
      if (Math.abs(rawX) > 5 && Math.abs(rawX) > Math.abs(rawY)) {
        lockedRef.current = true
        setDragging(true)
      } else {
        return // 竖向意图：不接管
      }
    }
    const next = Math.max(start.maxLeft, Math.min(8, rawX))
    setDx(next)
    setArmed(next <= start.maxLeft + 10)
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    if (!startRef.current) return
    const wasLocked = lockedRef.current
    const wasArmed = armed
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    reset()
    if (!wasLocked) return
    // 拖拽结束后紧随的 click 要吞掉
    movedRef.current = true
    window.setTimeout(() => {
      movedRef.current = false
    }, 0)
    if (!cancelled && wasArmed) onUnbindRequest(s)
  }

  const onClick = (): void => {
    if (movedRef.current) {
      movedRef.current = false
      return
    }
    if (s.missing) return
    setPulse(true)
    window.setTimeout(() => setPulse(false), 240)
    onResume(s)
  }

  return (
    <div
      ref={cardRef}
      className={`detail-session ${dragging ? 'is-dragging' : ''} ${pulse ? 'is-resuming' : ''}`}
    >
      <div className="detail-session-body">
        <div className="detail-session-tool" data-tool={s.toolId} aria-label={s.toolId}>
          <ToolIcon toolId={s.toolId} size={16} />
        </div>
        <div className="detail-session-main">
          {/* 第一行 = 该会话的第一条 user 消息（会话是什么事） */}
          <div className="detail-session-title" title={firstText}>
            {firstText}
          </div>
          {lastText && lastText !== firstText && (
            <div className="detail-session-last" title={lastText}>
              <span className="detail-session-last-label">上次</span>
              {lastText}
            </div>
          )}
          <div className="detail-session-top">
            <span>
              {s.lastUsedAt ? relTime(new Date(s.lastUsedAt).toISOString(), new Date()) : '—'}
            </span>
            {s.state === 'pending' && <span className="session-tag">待发送</span>}
            {s.missing && <span className="session-tag">已不在本机</span>}
            {usageEnabled && usage && <span className="session-usage">{usageText(usage)}</span>}
          </div>
        </div>
      </div>

      {/* 拖动时：终点区（卡片最左 1/8）+ 引导线；方块滑到终点后覆盖它 */}
      {dragging && (
        <>
          <div className="detail-session-guide" aria-hidden="true" />
          <div className={`detail-session-target ${armed ? 'is-armed' : ''}`} aria-hidden="true">
            <TrashIcon size={14} />
            <span>解绑</span>
          </div>
        </>
      )}

      {/* 右侧 1/8：方块本身就是滑块（单击接着做 / 按住左拖解绑） */}
      <button
        ref={blockRef}
        type="button"
        className={`detail-session-block ${dragging ? 'is-dragging' : ''} ${
          armed ? 'is-armed' : ''
        } ${s.missing ? 'is-disabled' : ''}`}
        style={dragging ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClick={onClick}
        aria-label={`接着做；按住向左拖到底可解绑「${firstText}」`}
        title={s.missing ? '会话文件已不在本机；拖到左端解绑' : '点击接着做 · 按住向左拖到底解绑'}
      >
        {dragging ? (
          <>
            <TrashIcon size={14} />
            <span className="detail-session-block-label">{armed ? '松手' : '解绑'}</span>
          </>
        ) : (
          <span className="detail-session-grip" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
