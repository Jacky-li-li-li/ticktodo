/**
 * TodoDetail — 线索展开/编辑（PRD F2：标题必填、正文选填、完成只改状态、删除默认解绑）。
 *
 * 会话列表（1:N 绑定、切换默认、接着做）在 Phase B 接到这里；本组件先落编辑与状态。
 */

import React, { useEffect, useState } from 'react'
import type { Todo, TodoPatch, TodoSessionView } from '@tick/shared'
import type { SessionUsage } from '@tick/ai-core'
import { relTime } from '../list/relTime'

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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<TodoSessionView[]>([])
  const [usages, setUsages] = useState<Record<string, SessionUsage | undefined>>({})

  const loadSessions = (): void => {
    void window.tick.sessions
      .forTodo(todo.id)
      .then(setSessions)
      .catch(() => setSessions([]))
  }

  useEffect(() => {
    loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo.id, todo.primarySessionId, todo.bindings.length])

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
    const ok = await onSave({ title: title.trim(), body: body.trim() || undefined })
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">{todo.status === 'done' ? '已完成线索' : '编辑线索'}</span>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="sheet-section-title">标题（必填）</div>
        <input
          className="sheet-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
          }}
          autoFocus
        />

        <div className="sheet-section-title">内容（选填）</div>
        <textarea
          className="sheet-textarea"
          value={body}
          placeholder="下一步 / 上下文 / 链接…"
          onChange={(e) => setBody(e.target.value)}
        />

        <div className="sheet-section-title">会话（{todo.bindings.length}）</div>
        <div className="todo-sessions">
          {sessions.length === 0 && <div className="session-empty">还没有会话；新建一个，或认领历史会话</div>}
          {sessions.map((s) => (
            <div className={`todo-session ${s.missing ? 'missing' : ''}`} key={s.sessionId}>
              <div className="session-main">
                <div className="session-name">
                  {s.primary ? <span className="primary-dot" title="默认 resume 的会话" /> : null}
                  {(s.name ?? s.firstMessage ?? `会话 ${s.sessionId.slice(0, 8)}`).trim()}
                  {s.state === 'pending' ? <span className="session-tag">待发送</span> : null}
                  {s.missing ? <span className="session-tag">已不在本机</span> : null}
                </div>
                <div className="session-meta">
                  {s.cwd ? s.cwd.replace(/^\/Users\/[^/]+/, '~') : ''}
                  {s.lastUsedAt ? ` · ${relTime(new Date(s.lastUsedAt).toISOString())}` : ''}
                </div>
                {usageEnabled && usages[s.sessionId] ? (
                  <div className="session-usage" title={usageTitle(usages[s.sessionId] as SessionUsage)}>
                    {usageText(usages[s.sessionId] as SessionUsage)}
                  </div>
                ) : null}
              </div>
              <div className="session-actions">
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
            </div>
          ))}
        </div>
        <div className="sheet-actions">
          <button className="secondary" onClick={onContinue}>
            ＋ 新建会话
          </button>
          <button className="secondary" onClick={onClaimSessions}>
            认领历史会话
          </button>
        </div>

        <div className="sheet-meta">
          绑定 {todo.bindings.length} 个会话
          {todo.lastLaunch?.projectPath ? ` · 上次项目 ${todo.lastLaunch.projectPath.replace(/^\/Users\/[^/]+/, '~')}` : ''}
        </div>

        <div className="sheet-actions">
          <button className="secondary" onClick={() => void save()} disabled={!title.trim() || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className="secondary" onClick={() => onSetStatus(todo.status === 'done' ? 'open' : 'done')}>
            {todo.status === 'done' ? '恢复' : '归档'}
          </button>
          <button
            className="secondary"
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
            className={`secondary danger ${confirmDelete ? 'confirm' : ''}`}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              onDelete()
              onClose()
            }}
            title="删除只解绑，不动 pi 的会话文件"
          >
            {confirmDelete ? '确认删除？' : '删除'}
          </button>
        </div>
      </div>
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function usageText(u: SessionUsage): string {
  const money = `${u.costReported ? '' : '≥ '}$${u.cost.total.toFixed(4)}`
  return `${fmtTokens(u.tokens.totalTokens)} tokens · ${money}${u.costReported ? '' : '（provider 未上报）'}`
}

function usageTitle(u: SessionUsage): string {
  const { input, output, cacheRead, cacheWrite, totalTokens } = u.tokens
  return [
    `input ${input}`,
    `output ${output}`,
    `cacheRead ${cacheRead}（${((cacheRead / Math.max(totalTokens, 1)) * 100).toFixed(0)}%）`,
    `cacheWrite ${cacheWrite}`,
    `按模型：${u.byModel.map((m) => `${m.provider}/${m.model} ${m.tokens.totalTokens}`).join(' · ')}`,
  ].join('\n')
}
