/**
 * SessionPicker — S5 反向建索引（PRD §3 S5 / M3）。
 *
 * 数据源：各工具会话列表里**没有被任何 todo 绑定**的那些（adapter.listSessionInfos）。
 * 交互：按项目分组 → 选中可「建线索并绑定」或「直接打开」；不批量自动生成。
 * 多工具后每行必须标出会话属于哪个工具（图标 + 展示名），否则分不清来源。
 */

import React, { useEffect, useMemo, useState } from 'react'
import type { SessionView, Todo } from '@tick/shared'
import { toolDisplayName } from '@tick/shared'
import { relTime } from '../list/relTime'
import { ToolIcon } from '../icons/ToolIcon'

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
        ? await window.tick.sessions.bind(todo.id, s.sessionId, s.toolId)
        : await window.tick.sessions.claim(s.sessionId, s.toolId)
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
    // 工具侧声明 resumable=false（如 WorkBuddy 的 playground 会话）时不要发起 resume：
    // 只会在错误的上下文里开会话，给一句中性说明即可。
    if (s.resumable === false) {
      onToast(`${toolDisplayName(s.toolId)} 的这个会话暂不支持从 Tick 定位（保守限制）`)
      return
    }
    setBusyId(s.sessionId)
    try {
      const out = await window.tick.launch.resume({
        sessionId: s.sessionId,
        toolId: s.toolId,
        projectPath: s.cwd,
      })
      // notice 是「实际发生了什么」的唯一来源（桌面入口只能激活 App、无法定位会话时必须如实说明），
      // 不能再用一句「已打开这个会话」盖过去 —— 那正是「假装定位成功」。
      onToast(
        out.ok
          ? (out.notice ?? `已在 ${toolDisplayName(s.toolId)} 里打开这个会话`)
          : (out.reason ?? '打开失败'),
      )
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
              <div className="session-group-head" title={cwd || '未知项目'}>
                {cwd ? cwd.replace(/^\/Users\/[^/]+/, '~') : '(未知项目)'}
              </div>
              {list.map((s) => (
                <div className="session-item" key={s.sessionId}>
                  <div className="session-main">
                    <div className="session-name" title={titleOf(s)}>
                      {titleOf(s)}
                    </div>
                    <div className="session-meta">
                      <span className="session-tool">
                        <ToolIcon toolId={s.toolId} size={12} />
                        <span className="session-tool-name">{toolDisplayName(s.toolId)}</span>
                      </span>
                      <span className="session-meta-rest">
                        {s.lastUsedAt ? relTime(new Date(s.lastUsedAt).toISOString()) : ''}
                        {s.boundTodoTitle ? ` · 已绑定 ${s.boundTodoTitle}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="session-actions">
                    <button
                      className="mini"
                      disabled={busyId !== null}
                      aria-disabled={s.resumable === false}
                      onClick={() => void handleResume(s)}
                      title={
                        s.resumable === false
                          ? `${toolDisplayName(s.toolId)} 的这个会话暂不支持从 Tick 定位（保守限制）`
                          : `不改任何绑定，直接在 ${toolDisplayName(s.toolId)} 里打开这个会话`
                      }
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
