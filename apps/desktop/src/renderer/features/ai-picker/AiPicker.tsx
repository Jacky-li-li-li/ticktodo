/**
 * AiPicker — 「继续」之后的那个决定（PRD F4 / UI-SPEC 动作三态）。
 *
 * 三态（按绑定数）：
 *   0  → 主按钮「在 <项目> 中打开 pi」（新建会话）
 *   1  → 主按钮「接着做」（resume primary）+ 次「新建会话」
 *   N  → 同上 + 「查看列表」（M3 的会话浮层；这里先显示数量并接到 primary）
 *
 * 两条不可退让的规则：
 *  - 主按钮**永远显示项目名**（可以免选，不可以隐式）
 *  - 投递默认剪贴板（可审阅）；直接发送要用户显式切
 */

import React, { useEffect, useMemo, useState } from 'react'
import type { LaunchDeliver, Todo } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'
import type { ResolvedCwdView } from '../../../preload/index'

export function AiPicker({
  todo,
  projects,
  onClose,
  onResult,
}: {
  todo: Todo
  projects: ProjectEntry[]
  onClose: () => void
  onResult: (text: string) => void
}): React.JSX.Element {
  const [resolved, setResolved] = useState<ResolvedCwdView | null>(null)
  const [deliver, setDeliver] = useState<LaunchDeliver>('clipboard')
  const [busy, setBusy] = useState(false)
  const [showProjects, setShowProjects] = useState(false)

  useEffect(() => {
    let alive = true
    void window.tick.launch.resolveCwd(todo.id).then((r) => {
      if (alive) setResolved(r)
    })
    return () => {
      alive = false
    }
  }, [todo.id])

  const bound = todo.bindings.length
  const recent = useMemo(() => projects.filter((p) => p.exists).slice(0, 8), [projects])

  const run = async (kind: 'resume' | 'launch'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const outcome =
        kind === 'resume' && todo.primarySessionId
          ? await window.tick.launch.resume({
              todoId: todo.id,
              sessionId: todo.primarySessionId,
              projectPath: resolved?.projectPath,
            })
          : await window.tick.launch.launch({
              todoId: todo.id,
              projectPath: resolved?.projectPath,
              deliver,
            })
      if (outcome.ok) {
        onResult(
          kind === 'resume'
            ? '已切回那个会话'
            : outcome.delivered === 'clipboard'
              ? '文案已复制 —— 到 pi 里 ⌘V'
              : '已发出去，pi 正在处理',
        )
        onClose()
      } else {
        onResult(outcome.reason ?? '没能打开 pi')
        onClose()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">{todo.title}</span>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {/* 项目行：名字必须在主按钮上，这里显示完整路径避免同名目录误选 */}
        <button className="sheet-row project" onClick={() => setShowProjects((v) => !v)}>
          <span className="label">项目</span>
          <span className="value">{resolved?.projectName ?? '…'}</span>
          <span className="path">{resolved?.projectPath ?? ''}</span>
          <span className="chevron">›</span>
        </button>

        {showProjects && (
          <div className="project-list">
            {recent.length === 0 && <div className="project-empty">还没有扫到项目</div>}
            {recent.map((p) => (
              <button
                key={p.path}
                className={`project-item ${p.path === resolved?.projectPath ? 'current' : ''}`}
                onClick={() => {
                  setResolved({ projectPath: p.path, projectName: p.path.split('/').filter(Boolean).pop() ?? p.path, source: 'last-launch' })
                  setShowProjects(false)
                }}
              >
                <span className="name">{p.path.split('/').filter(Boolean).pop()}</span>
                <span className="path">{p.path.replace(/^\/Users\/[^/]+/, '~')}</span>
              </button>
            ))}
          </div>
        )}

        {/* 投递方式：默认剪贴板（可审阅），不默认“自动发送” */}
        <div className="sheet-row deliver">
          <span className="label">投递</span>
          <div className="segmented">
            <button
              className={deliver === 'clipboard' ? 'on' : ''}
              onClick={() => setDeliver('clipboard')}
              title="把文案放进剪贴板，由你决定什么时候粘"
            >
              复制文案
            </button>
            <button
              className={deliver === 'argv' ? 'on' : ''}
              onClick={() => setDeliver('argv')}
              title="作为启动参数直接发给 pi"
            >
              直接发送
            </button>
          </div>
        </div>

        <div className="sheet-actions">
          {bound > 0 && (
            <button className="primary" onClick={() => void run('resume')} disabled={busy}>
              接着做
              {bound > 1 && <span className="badge">{bound}</span>}
            </button>
          )}
          <button
            className={bound > 0 ? 'secondary' : 'primary'}
            onClick={() => void run('launch')}
            disabled={busy}
          >
            在 {resolved?.projectName ?? '…'} 中打开 pi
          </button>
        </div>
      </div>
    </div>
  )
}
