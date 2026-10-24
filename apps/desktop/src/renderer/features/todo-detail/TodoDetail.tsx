/**
 * TodoDetail — 展开态线索卡片（UI-SPEC §5/§6.2/§4.5）。
 *
 * 页面结构：捕获行 → 线索卡片 → 次要线索（列表仍在下方，点卡片外空白折叠）。
 * 卡片内容（§6.2）：标题 → 「上次停在哪」user 消息 → 动作（按会话数三态）→ 次要操作。
 * 「上次停在哪」= 主会话文件里**最后一条 user 消息**；main 侧按 (mtime,size) 缓存元数据，
 * 卡片打开期间在窗口重新聚焦/回前台时刷新，并每 15s 轮询一次（文件没变只 stat，不重扫正文）。
 * 会话浮层（§4.5）：「查看列表」按钮正下方右对齐；实心点=已落盘会话，空心点=待发送；
 * 每行两行文字（时间+状态 / 上次停在哪）；footer「＋ 新建会话 · 认领历史会话」。
 */

import React, { useCallback, useEffect, useState } from 'react'
import type { Todo, TodoPatch, TodoSessionView } from '@tick/shared'
import type { SessionUsage } from '@tick/ai-core'
import { relTime } from '../list/relTime'

const Check = (): React.JSX.Element => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
    <path d="M1.5 4.8L3.6 7L7.5 2.2" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function TodoDetail({
  todo,
  onClose,
  onSave,
  onSetStatus,
  onDelete,
  onContinue,
  onClaimSessions,
  onSessionsChanged,
  onToast,
  usageEnabled,
}: {
  todo: Todo
  onClose: () => void
  onSave: (patch: TodoPatch) => Promise<boolean>
  onSetStatus: (status: Todo['status']) => void
  onDelete: () => void
  onContinue: () => void
  onClaimSessions: () => void
  onSessionsChanged: () => void
  onToast: (text: string) => void
  usageEnabled: boolean
}): React.JSX.Element {
  const [title, setTitle] = useState(todo.title)
  const [body, setBody] = useState(todo.body ?? '')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<TodoSessionView[]>([])
  const [showSessions, setShowSessions] = useState(false)
  const [usages, setUsages] = useState<Record<string, SessionUsage | undefined>>({})

  const loadSessions = useCallback((): void => {
    void window.tick.sessions
      .forTodo(todo.id)
      .then(setSessions)
      .catch(() => setSessions([]))
  }, [todo.id])

  useEffect(() => {
    loadSessions()
  }, [loadSessions, todo.primarySessionId, todo.bindings.length])

  // 会话文件会在终端里持续写入：面板重新获得焦点 / 回到前台时刷新「上次停在哪」，
  // 卡片打开期间每 15s 再对一次（main 侧 meta 缓存让未变更文件只 stat 不重扫）。
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
  const projectName =
    primary?.cwd?.split('/').filter(Boolean).pop() ??
    todo.lastLaunch?.projectPath?.split('/').filter(Boolean).pop()

  const resumeSession = async (session: TodoSessionView): Promise<void> => {
    if (session.missing) return
    const out = await window.tick.launch.resume({
      todoId: todo.id,
      sessionId: session.sessionId,
      projectPath: session.cwd,
    })
    onToast(out.ok ? '已在终端里打开那个会话' : (out.reason ?? '打开失败'))
    if (out.ok) onClose()
  }

  const setPrimary = async (session: TodoSessionView): Promise<void> => {
    const updated = await window.tick.sessions.setPrimary(todo.id, session.sessionId)
    if (updated) {
      loadSessions()
      onSessionsChanged()
    }
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
    // body 传空串 = 清空正文（main 侧 trim 后归一成 undefined）；传 undefined 则根本不更新该字段
    const ok = await onSave({ title: title.trim(), body: body.trim() })
    setSaving(false)
    if (ok) {
      setEditing(false)
      onToast('已保存')
    } else {
      onToast('保存失败：todos.json 可能被占用')
    }
  }

  const stopped = primary ? (primary.lastMessage ?? primary.name ?? primary.firstMessage) : undefined

  return (
    <div className="thread-card" onClick={(e) => e.stopPropagation()}>
      {editing ? (
        <>
          <div className="card-edit-fields">
            <input
              className="sheet-input"
              value={title}
              placeholder="标题（必填）"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
              }}
              autoFocus
            />
            <textarea
              className="sheet-textarea"
              value={body}
              placeholder="下一步 / 上下文 / 链接…"
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="card-secondary">
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
      ) : (
        <>
          {/* 点击卡片头（标题/时间/空白）收起；勾选按钮单独 stopPropagation，仍然只做归档/恢复 */}
          <div className="card-head" onClick={onClose} title="点击收起">
            <button
              className="check"
              onClick={(e) => {
                e.stopPropagation()
                onSetStatus(todo.status === 'done' ? 'open' : 'done')
              }}
              aria-label={todo.status === 'done' ? `恢复「${todo.title}」` : `归档「${todo.title}」`}
            >
              {todo.status === 'done' && <Check />}
            </button>
            <span className={`card-title ${todo.status === 'done' ? 'done' : ''}`}>{todo.title}</span>
            <span className="card-time">{relTime(todo.updatedAt, new Date())}</span>
          </div>

          {stopped && (
            <div className="card-stopped">
              <span className="card-stopped-label">上次停在哪</span>
              <span className="card-stopped-text">「{stopped}」</span>
            </div>
          )}

          {/* §6.2 动作三态：0 会话=新建会话；1 会话=接着做+新建会话；N 会话=接着做+查看列表（角标） */}
          <div className="card-actions">
            {sessions.length === 0 ? (
              <button className="pill primary" onClick={onContinue}>
                新建会话
              </button>
            ) : (
              <>
                <button className="pill primary" onClick={() => void resumeSession(primary as TodoSessionView)}>
                  {sessions.length === 1 && projectName ? `在 ${projectName} 中打开 pi` : '接着做'}
                </button>
                <button className="pill secondary" onClick={onContinue}>
                  新建会话
                </button>
                {sessions.length > 1 && (
                  <button className="pill secondary" onClick={() => setShowSessions((v) => !v)}>
                    查看列表
                    <span className="badge">{sessions.length}</span>
                  </button>
                )}
              </>
            )}
          </div>

          {showSessions && sessions.length > 1 && (
            <div className="sessions-pop" onClick={(e) => e.stopPropagation()}>
              <div className="sessions-pop-label">这条线上的对话</div>
              {sessions.map((s) => (
                <div className="session-line" key={s.sessionId}>
                  {/* 实心点=已落盘会话；空心点=待发送（§4.5：空心点=分开存的面板会话，这里映射 pending） */}
                  <span className={`session-dot ${s.state === 'pending' ? 'hollow' : ''}`} />
                  <div className="session-line-main">
                    <div className="session-line-top">
                      <span className={s.primary ? 'current' : ''}>
                        {s.lastUsedAt ? relTime(new Date(s.lastUsedAt).toISOString()) : '—'}
                      </span>
                      {s.primary && <span className="session-tag">默认</span>}
                      {s.state === 'pending' && <span className="session-tag">待发送</span>}
                      {s.missing && <span className="session-tag">已不在本机</span>}
                      {usageEnabled && usages[s.sessionId] ? (
                        <span className="session-usage">{usageText(usages[s.sessionId] as SessionUsage)}</span>
                      ) : null}
                    </div>
                    <div className="session-line-stop">{s.lastMessage ?? s.name ?? s.firstMessage ?? '—'}</div>
                  </div>
                  <button className="mini primary" disabled={s.missing} onClick={() => void resumeSession(s)}>
                    接着做
                  </button>
                  {!s.primary && !s.missing && (
                    <button className="mini" onClick={() => void setPrimary(s)}>
                      设为默认
                    </button>
                  )}
                  <button className="mini" onClick={() => void unbind(s)}>
                    解绑
                  </button>
                </div>
              ))}
              <div className="sessions-pop-footer">
                <button className="link" onClick={onContinue}>
                  ＋ 新建会话
                </button>
                <span className="dot-sep">·</span>
                <button className="link" onClick={onClaimSessions}>
                  认领历史会话
                </button>
              </div>
            </div>
          )}

          <div className="card-secondary">
            <button className="mini" onClick={() => setEditing(true)}>
              编辑
            </button>
            <button
              className="mini"
              onClick={() => onSetStatus(todo.status === 'done' ? 'open' : 'done')}
            >
              {todo.status === 'done' ? '恢复' : '归档'}
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
              title="删除只解绑，不动 pi 的会话文件"
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                onDelete()
                onClose()
              }}
            >
              {confirmDelete ? '再点一次确认' : '删除'}
            </button>
          </div>

          {todo.body && <div className="card-body">{todo.body}</div>}
        </>
      )}
    </div>
  )
}

function usageText(usage: SessionUsage): string {
  const money = `${usage.costReported ? '' : '≥ '}$${usage.cost.total.toFixed(4)}`
  return `${usage.tokens.totalTokens.toLocaleString()} tokens · ${money}${usage.costReported ? '' : '（未上报）'}`
}
