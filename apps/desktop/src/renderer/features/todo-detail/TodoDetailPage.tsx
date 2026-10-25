/**
 * TodoDetailPage — 一条线索的全量信息页（重构：首页不再内联展开，点行进这里）。
 *
 * 信息分层（自上而下）：
 *  1) 顶栏标题（双击只编辑标题；Enter/失焦保存、Esc 放弃）
 *  2) 补充上下文 body（双击进入编辑；失焦/Enter 保存、Shift+Enter 换行、Esc 放弃）
 *  3) 元信息：状态灯 / 来源 / 创建更新与最近拉起（悬停标题查看）
 *  4) 主操作：会话标题行右侧图标（新建会话 / 倒入历史会话）
 *  5) 进展时间线：按会话内最后事件时间跨工具混排（`missing` 置底、`primary` 只加徽标），
 *     每项 = 工具图标 + 状态点/状态文案 + 消息时间 + 项目名 + 最后一条 user 消息原文
 *     （默认两行、>90 字可点开全文、>4000 字截断标「消息已截断」；没有原文时回退标题并标注）；
 *     右侧 1/8 为滑块（单击接着做 / 按住左拖到底解绑），设置开启时显示单会话用量
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionState, Todo, TodoPatch, TodoSessionView } from '@tick/shared'
import type { SessionUsage } from '@tick/ai-core'
import { toolDisplayName } from '@tick/shared'
import { ToolIcon } from '../icons/ToolIcon'
import { PlusIcon } from '../icons/PlusIcon'
import { ImportIcon } from '../icons/ImportIcon'
import { TrashIcon } from '../icons/TrashIcon'

const cwdLabel = (p?: string): string => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '')

/** 时间线条目上显示的消息时间：今天只给 HH:mm，今年给 M月D日，跨年带年份 */
function messageTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) return hm
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 时间线状态文案（P0-3；不用「失败」这类压力词） */
function stateText(state: SessionState): string {
  switch (state) {
    case 'active':
      return '进行中'
    case 'done':
      return '已结束'
    case 'missing':
      return '不在本机'
    default:
      return '已停下'
  }
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

  /**
   * adapter 明确声明 resumable=false（如 WorkBuddy 的 playground 会话）时不要试：
   * 试了只会在别的上下文里开出错误会话，保守置灰并说明原因；missing 语义保持不变。
   */
  const notResumableHint = (session: TodoSessionView): void => {
    onToast(`${toolDisplayName(session.toolId)} 的这个会话暂不支持从 Tick 定位（保守限制）`)
  }

  const resumeSession = async (session: TodoSessionView): Promise<void> => {
    if (session.missing) return
    if (session.resumable === false) {
      notResumableHint(session)
      return
    }
    const out = await window.tick.launch.resume({
      todoId: todo.id,
      sessionId: session.sessionId,
      toolId: session.toolId,
      projectPath: session.cwd,
    })
    onToast(
      out.ok
        ? // notice 优先：桌面入口只能激活 App、无法定位会话，必须原样告诉用户去列表里选
          (out.notice ?? `已在 ${toolDisplayName(session.toolId)} 里打开这个会话`)
        : (out.reason ?? '打开失败'),
    )
  }

  const unbind = async (session: TodoSessionView): Promise<void> => {
    const ok = await window.tick.sessions.unbind(todo.id, session.sessionId, session.toolId)
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
    // body 传空串 = 清空正文（main 侧 trim 后归一成 undefined）；传 undefined 则根本不更新该字段
    const ok = await onSave({ body: next })
    if (!ok) {
      setBody(todo.body ?? '')
      onToast('描述没保存成功')
    }
  }

  const done = todo.status === 'done'
  const toolCount = new Set(sessions.map((s) => s.toolId)).size

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

        {/* 进展（P0-2）：最后一条 user 消息 + 状态，按会话内最后事件时间倒序、跨工具混排 */}
        <section className="detail-section">
          <div className="detail-section-head">
            <span className="detail-section-title">
              进展<span className="detail-count">{sessions.length}</span>
              {toolCount > 1 && <span className="detail-tools-count">{toolCount} 个工具</span>}
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
            <div className="detail-timeline">
              {sessions.map((s) => (
                <SessionCard
                  key={s.sessionId}
                  session={s}
                  usage={usages[s.sessionId]}
                  usageEnabled={usageEnabled}
                  onResume={(session) => void resumeSession(session)}
                  onBlockedResume={notResumableHint}
                  onUnbindRequest={setPendingUnbind}
                />
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
 * 会话文件不在本机（missing）或工具侧声明 resumable=false 时禁止「接着做」，
 * 但仍可拖拽解绑；两种原因的说明走 title / aria / toast。
 */
function SessionCard({
  session: s,
  usage,
  usageEnabled,
  onResume,
  onBlockedResume,
  onUnbindRequest,
}: {
  session: TodoSessionView
  usage?: SessionUsage
  usageEnabled: boolean
  onResume: (session: TodoSessionView) => void
  /** resumable=false 仍允许拖拽解绑，但点击「接着做」要说明为什么不行 */
  onBlockedResume: (session: TodoSessionView) => void
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
  const [expanded, setExpanded] = useState(false)

  // P0-1/P0-3：最后一条真实 user 消息原文 + 消息时间 + 归一状态；
  // 旧 adapter 还没给 digest 时回退到 lastMessage（并如实标「标题回退」）。
  const digest = s.digest
  const state = digest?.state ?? (s.missing ? 'missing' : 'idle')
  const message = (digest?.lastUserMessage ?? s.lastMessage ?? s.firstMessage ?? s.name ?? '未命名会话').trim()
  const messageAt = digest?.lastUserMessageAt
  const timeText = messageTime(messageAt ?? digest?.lastActiveAt ?? s.lastUsedAt)
  const projectName = s.cwd ? (s.cwd.split('/').filter(Boolean).pop() ?? '') : ''
  const canExpand = message.length > 90
  const toolName = toolDisplayName(s.toolId)
  /**
   * 两种原因禁止「接着做」：missing（会话文件不在本机，既有语义）与
   * resumable === false（工具侧保守声明不支持从 Tick 定位）。同时成立时以禁用为准，
   * 但拖到左端解绑仍然可用。
   */
  const canResume = !s.missing && s.resumable !== false
  const blockedReason =
    s.resumable === false
      ? `${toolName} 的这个会话暂不支持从 Tick 定位（保守限制）`
      : s.missing
        ? '会话文件已不在本机'
        : ''

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
    // 只允许向左拖：初始位置不能向右滑
    const next = Math.max(start.maxLeft, Math.min(0, rawX))
    setDx(next)
    // 与终点虚线框（同尺寸）重叠到基本贴合时才 armed
    setArmed(next <= start.maxLeft + 6)
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
    if (!canResume) {
      // 不试 resume；resumable=false 给一句中性说明，missing 保持原来的静默（title 已说明）
      if (s.resumable === false) onBlockedResume(s)
      return
    }
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
        <div className="detail-session-tool" data-tool={toolName} aria-label={toolName}>
          <ToolIcon toolId={s.toolId} size={16} />
        </div>
        <div className="detail-session-main">
          {/* 第一行：状态 + 消息时间 + 项目（P0-2） */}
          <div className="detail-session-meta">
            <span className={`detail-state-dot is-${state}`} aria-hidden="true" />
            <span className="detail-session-state">{stateText(state)}</span>
            {timeText && (
              <span className="detail-session-time" title={messageAt ? '这条消息的时间' : '最后活动时间'}>
                {timeText}
              </span>
            )}
            {projectName && (
              <span className="detail-session-project" title={cwdLabel(s.cwd)}>
                {projectName}
              </span>
            )}
            {s.primary && <span className="detail-session-primary">默认</span>}
          </div>

          {/* 第二块：最后一条真实 user 消息原文（P0-1；长文折叠，点开看全文） */}
          <button
            type="button"
            className={`detail-session-msg ${expanded ? 'is-expanded' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              if (canExpand) setExpanded((v) => !v)
            }}
            title={canExpand ? (expanded ? '收起' : '展开全文') : message}
          >
            {message}
            {digest?.approximate && <span className="detail-session-approx">（标题回退）</span>}
          </button>

          {(s.state === 'pending' ||
            s.missing ||
            s.resumable === false ||
            digest?.lastUserMessageTruncated ||
            (usageEnabled && usage)) && (
            <div className="detail-session-top">
              {s.state === 'pending' && <span className="session-tag">待发送</span>}
              {s.missing && <span className="session-tag">已不在本机</span>}
              {s.resumable === false && <span className="session-tag">不可从 Tick 定位</span>}
              {digest?.lastUserMessageTruncated && <span className="session-tag">消息已截断</span>}
              {usageEnabled && usage && <span className="session-usage">{usageText(usage)}</span>}
            </div>
          )}
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
        } ${canResume ? '' : 'is-disabled'}`}
        style={dragging ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClick={onClick}
        aria-label={
          canResume
            ? `接着做（${toolName}）；按住向左拖到底可解绑「${message}」`
            : `${blockedReason}；按住向左拖到底可解绑「${message}」`
        }
        title={
          canResume
            ? '点击接着做 · 按住向左拖到底解绑'
            : `${blockedReason}；拖到左端解绑`
        }
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
