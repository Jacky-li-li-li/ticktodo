/**
 * SessionPicker — S5 反向建索引（PRD §3 S5 / M3）。
 *
 * 数据源：pi 会话列表里**没有被任何 todo 绑定**的那些（adapter.listSessionInfos）。
 * 交互：按项目分组 → 选中可「建线索并绑定」或「直接打开」；不批量自动生成。
 */

import React, { useEffect, useMemo, useState } from 'react'
import type { SessionView, Todo } from '@tick/shared'
import { relTime } from '../list/relTime'

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

export function SessionPicker({
  todo,
  onClose,
  onChanged,
  onToast,
}: {
  /** 从某条线索展开时带入：选中会话 → 绑定到这条 todo；没有则新建 todo */
  todo?: Todo
  onClose: () => void
  onChanged: () => void
  onToast: (text: string) => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionView[] | null>(null)
  const [recentOnly, setRecentOnly] = useState(true)
  const [onlyProject, setOnlyProject] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const projectHint = todo?.lastLaunch?.projectPath

  useEffect(() => {
    let alive = true
    setSessions(null)
    void window.tick.sessions
      .list({
        unboundOnly: true,
        projectPath: onlyProject ? projectHint : undefined,
      })
      .then((list) => {
        if (alive) setSessions(list)
      })
      .catch((e) => {
        if (alive) setError((e as Error).message)
      })
    return () => {
      alive = false
    }
  }, [onlyProject, projectHint])

  const filtered = useMemo(() => {
    if (!sessions) return []
    if (!recentOnly) return sessions
    const cutoff = Date.now() - THIRTY_DAYS
    return sessions.filter((s) => (s.lastUsedAt ?? 0) >= cutoff)
  }, [sessions, recentOnly])

  /** 按项目（cwd）分组，组内按最近使用倒序 */
  const groups = useMemo(() => {
    const map = new Map<string, SessionView[]>()
    for (const s of filtered) {
      const list = map.get(s.cwd) ?? []
      list.push(s)
      map.set(s.cwd, list)
    }
    return [...map.entries()].sort(
      (a, b) => (b[1][0]?.lastUsedAt ?? 0) - (a[1][0]?.lastUsedAt ?? 0),
    )
  }, [filtered])

  const titleOf = (s: SessionView): string =>
    (s.name ?? s.firstMessage ?? `会话 ${s.sessionId.slice(0, 8)}`).trim()

  const handleClaim = async (s: SessionView): Promise<void> => {
    if (busyId) return
    setBusyId(s.sessionId)
    try {
      const result = todo
        ? await window.tick.sessions.bind(todo.id, s.sessionId)
        : await window.tick.sessions.claim(s.sessionId)
      if (result.ok) {
        onToast(todo ? `已绑定到「${todo.title}」` : `已建线索「${result.todo?.title ?? ''}」`)
        onChanged()
        onClose()
      } else {
        onToast(result.reason ?? '没绑上')
      }
    } catch (e) {
      onToast(`操作失败：${(e as Error).message}`)
    } finally {
      setBusyId(null)
    }
  }

  const handleResume = async (s: SessionView): Promise<void> => {
    if (busyId) return
    setBusyId(s.sessionId)
    try {
      const out = await window.tick.launch.resume({ sessionId: s.sessionId, projectPath: s.cwd })
      onToast(out.ok ? '已在终端里打开那个会话' : (out.reason ?? '打开失败'))
      if (out.ok) onClose()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet session-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">倒入历史会话</span>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="session-filters">
          <button className={`chip ${recentOnly ? 'on' : ''}`} onClick={() => setRecentOnly((v) => !v)}>
            {recentOnly ? '近 30 天' : '全部时间'}
          </button>
          {projectHint && (
            <button className={`chip ${onlyProject ? 'on' : ''}`} onClick={() => setOnlyProject((v) => !v)}>
              仅当前项目
            </button>
          )}
          <span className="session-count">
            {sessions === null ? '扫描中…' : `${filtered.length} 条未绑定`}
          </span>
        </div>

        {error && <div className="session-empty">扫描失败：{error}</div>}
        {sessions !== null && filtered.length === 0 && (
          <div className="session-empty">
            没有可倒入的会话{recentOnly ? '（试试「全部时间」）' : ''}
          </div>
        )}

        <div className="session-groups">
          {groups.map(([cwd, list]) => (
            <div className="session-group" key={cwd}>
              <div className="session-group-head" title={cwd}>
                {cwd.replace(/^\/Users\/[^/]+/, '~')}
              </div>
              {list.map((s) => (
                <div className="session-item" key={s.sessionId}>
                  <div className="session-main">
                    <div className="session-name" title={titleOf(s)}>
                      {titleOf(s)}
                    </div>
                    <div className="session-meta">
                      {s.lastUsedAt ? relTime(new Date(s.lastUsedAt).toISOString()) : ''}
                      {s.boundTodoTitle ? ` · 已绑定 ${s.boundTodoTitle}` : ''}
                    </div>
                  </div>
                  <div className="session-actions">
                    <button
                      className="mini"
                      disabled={busyId !== null}
                      onClick={() => void handleResume(s)}
                      title="不改任何绑定，直接在终端打开这个会话"
                    >
                      打开
                    </button>
                    <button
                      className="mini primary"
                      disabled={busyId !== null}
                      onClick={() => void handleClaim(s)}
                    >
                      {todo ? '绑定' : '建线索'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
