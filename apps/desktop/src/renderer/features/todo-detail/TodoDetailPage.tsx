/**
 * TodoDetailPage — 一条线索的全量信息页（重构：首页不再内联展开，点行进这里）。
 *
 * 信息分层（自上而下）：
 *  1) 标题 / 状态 / 创建与更新时间（双击标题或「编辑」进入编辑态）
 *  2) 描述 body（可编辑）
 *  3) 元信息：状态、项目目录、创建/更新、最后拉起
 *  4) 主操作：接着做（主会话）/ 新建会话 / 认领历史会话
 *  5) 会话列表：每条会话的工具、时间、状态、最后一条 user 消息、cwd，
 *     以及「接着做 / 设为默认 / 解绑」；设置开启时显示单会话用量
 *  6) 其他：归档或恢复、编辑、导出（JSON+MD）、删除（二次确认，只解绑不动会话文件）
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { Todo, TodoPatch, TodoSessionView } from '@tick/shared'
import type { SessionUsage } from '@tick/ai-core'
import { relTime } from '../list/relTime'
import { ToolIcon } from '../icons/ToolIcon'

const cwdLabel = (p?: string): string => (p ? p.replace(/^\/Users\/[^/]+/, '~') : '')

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
  onSetStatus,
  onDelete,
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
  onSetStatus: (status: Todo['status']) => void
  onDelete: () => void
  onNewSession: () => void
  onClaimSessions: () => void
  onSessionsChanged: () => void
  onToast: (text: string) => void
  usageEnabled: boolean
  /** 浮层（如认领历史会话）挂在本页内，保证 sheet 的绝对定位仍相对面板 */
  children?: React.ReactNode
}): React.JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [body, setBody] = useState(todo.body ?? '')
  const [editing, setEditing] = useState(false)
  const [hoverTimes, setHoverTimes] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<TodoSessionView[]>([])
  const [usages, setUsages] = useState<Record<string, SessionUsage | undefined>>({})

  useEffect(() => {
    if (!editing) {
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

  const primary = sessions.find((s) => s.primary) ?? sessions[0]

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

  const save = async (): Promise<void> => {
    if (!title.trim() || saving) return
    setSaving(true)
    const ok = await onSave({ title: title.trim(), body: body.trim() || undefined })
    setSaving(false)
    if (ok) {
      setEditing(false)
      onToast('已保存')
    }
  }

  const done = todo.status === 'done'

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
          {editing ? (
            <input
              className="sheet-input detail-title-input"
              value={title}
              placeholder="标题（必填）"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
                if (e.key === 'Escape') setEditing(false)
              }}
              autoFocus
            />
          ) : (
            <h1
              className={`detail-topbar-title ${done ? 'done' : ''}`}
              title="双击修改标题与描述"
              onDoubleClick={() => setEditing(true)}
            >
              {todo.title}
            </h1>
          )}

          {/* 悬停标题 → 来源 / 创建 / 更新 / 最近拉起（绝对时间） */}
          {hoverTimes && !editing && (
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
        {editing ? (
          <>
            <textarea
              className="sheet-textarea detail-body-input"
              value={body}
              placeholder="下一步 / 上下文 / 链接…"
              onChange={(e) => setBody(e.target.value)}
            />
            <div className="detail-edit-actions">
              <button className="mini primary" onClick={() => void save()} disabled={!title.trim() || saving}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button
                className="mini"
                onClick={() => {
                  setTitle(todo.title)
                  setBody(todo.body ?? '')
                  setEditing(false)
                }}
              >
                取消
              </button>
            </div>
          </>
        ) : todo.body ? (
          <div className="detail-body" onDoubleClick={() => setEditing(true)}>
            {todo.body}
          </div>
        ) : (
          <button className="detail-body-empty" onClick={() => setEditing(true)}>
            ＋ 添加描述（下一步 / 上下文 / 链接）
          </button>
        )}

        {/* 主操作 */}
        <div className="detail-actions-primary">
          {primary && !primary.missing ? (
            <button className="pill primary" onClick={() => void resumeSession(primary)}>
              接着做
            </button>
          ) : (
            <button className="pill primary" onClick={onNewSession}>
              新建会话
            </button>
          )}
          {primary && !primary.missing && (
            <button className="pill secondary" onClick={onNewSession}>
              新建会话
            </button>
          )}
          <button className="pill secondary" onClick={onClaimSessions}>
            认领
          </button>
        </div>

        {/* 会话 */}
        <section className="detail-section">
          <div className="detail-section-head">
            <span className="detail-section-title">
              会话<span className="detail-count">{sessions.length}</span>
            </span>
          </div>

          {sessions.length === 0 ? (
            <div className="detail-empty">
              还没有绑定会话。点上面的「新建会话」，或从历史会话里认领一条。
            </div>
          ) : (
            <div className="detail-sessions">
              {sessions.map((s) => (
                <div className="detail-session" key={s.sessionId}>
                  <div className="detail-session-tool" title={s.toolId}>
                    <ToolIcon toolId={s.toolId} size={16} />
                  </div>
                  <div className="detail-session-main">
                    <div className="detail-session-top">
                      <span className="detail-session-toolname">{s.toolId}</span>
                      <span>{s.lastUsedAt ? relTime(new Date(s.lastUsedAt).toISOString(), new Date()) : '—'}</span>
                      {s.primary && <span className="session-tag">默认</span>}
                      {s.state === 'pending' && <span className="session-tag">待发送</span>}
                      {s.missing && <span className="session-tag">已不在本机</span>}
                      {usageEnabled && usages[s.sessionId] && (
                        <span className="session-usage">{usageText(usages[s.sessionId] as SessionUsage)}</span>
                      )}
                    </div>
                    <div className="detail-session-msg">{s.lastMessage ?? s.name ?? s.firstMessage ?? '—'}</div>
                    {/* 项目跟会话走：不同会话可能不在同一个项目里 */}
                    <div className="detail-session-project" title={s.filePath}>
                      <span className="detail-session-project-name">
                        项目 {s.cwd.split('/').filter(Boolean).pop() ?? s.cwd}
                      </span>
                      <span className="detail-session-project-path">{cwdLabel(s.cwd)}</span>
                    </div>
                  </div>
                  <div className="detail-session-actions">
                    <button className="mini primary" disabled={s.missing} onClick={() => void resumeSession(s)}>
                      接着做
                    </button>
                    <button className="mini" onClick={() => void unbind(s)}>
                      解绑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 其他操作 */}
        <section className="detail-section">
          <div className="detail-section-head">
            <span className="detail-section-title">其他</span>
          </div>
          <div className="detail-actions">
            <button className="mini" onClick={() => onSetStatus(done ? 'open' : 'done')}>
              {done ? '恢复' : '归档'}
            </button>
            <button className="mini" onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              className="mini"
              onClick={() => {
                void window.tick.export
                  .run({ scope: 'todo', todoId: todo.id })
                  .then((r) => onToast(`已导出到 exports/（${r.sessionCount} 个会话）`))
                  .catch((e) => onToast(`导出失败：${(e as Error).message}`))
              }}
            >
              导出
            </button>
            <button
              className={`mini danger ${confirmDelete ? 'confirm' : ''}`}
              title="删除只解绑，不动 AI 工具的会话文件"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                onDelete()
              }}
            >
              {confirmDelete ? '再点一次确认' : '删除'}
            </button>
          </div>
          <div className="detail-note">删除只解绑，不会动 pi / 其他工具里的会话文件。</div>
        </section>
      </div>
      {children}
    </div>
  )
}

function usageText(usage: SessionUsage): string {
  const money = `${usage.costReported ? '' : '≥ '}$${usage.cost.total.toFixed(4)}`
  return `${usage.tokens.totalTokens.toLocaleString()} tokens · ${money}${usage.costReported ? '' : '（未上报）'}`
}
