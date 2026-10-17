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
import type { AppSettings, LaunchDeliver, Todo } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'
import type { ResolvedCwdView } from '../../../preload/index'

export function AiPicker({
  todo,
  projects,
  settings,
  refreshProjects,
  onClose,
  onResult,
}: {
  todo: Todo
  projects: ProjectEntry[]
  settings: AppSettings
  refreshProjects: () => Promise<void>
  onClose: () => void
  onResult: (text: string) => void
}): React.JSX.Element {
  const [resolved, setResolved] = useState<ResolvedCwdView | null>(null)
  const [home, setHome] = useState<ResolvedCwdView | null>(null)
  const [deliver, setDeliver] = useState<LaunchDeliver>(settings.deliver)
  const [deliverTouched, setDeliverTouched] = useState(false)
  const [mustAsk, setMustAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showProjects, setShowProjects] = useState(false)

  // 设置里的默认投递方式（用户在本次选择里手动切过就以手动为准）
  useEffect(() => {
    if (!deliverTouched) setDeliver(settings.deliver)
  }, [settings.deliver, deliverTouched])

  useEffect(() => {
    let alive = true
    // 同时拿「这条 todo 的默认 cwd」和「主目录」：主目录是项目列表的固定首项（F4-a）
    void window.tick.launch.resolveCwd(todo.id).then((r) => {
      if (!alive) return
      setResolved(r)
      // 设置「每次必问」：直接展开选择器，未选项目前不允许拉起
      if (r.mustAsk) {
        setMustAsk(true)
        setShowProjects(true)
      }
    })
    void window.tick.launch.resolveCwd().then((r) => {
      if (alive) setHome(r)
    })
    return () => {
      alive = false
    }
  }, [todo.id])

  const bound = todo.bindings.length
  const [showOther, setShowOther] = useState(false)
  const [showStale, setShowStale] = useState(false)
  const candidates = useMemo(
    () => projects.filter((p) => p.exists && p.path !== home?.projectPath),
    [projects, home?.projectPath],
  )
  // Q13 / 验收 12：低频（≤1 条会话）且位于 Downloads/tmp 的临时目录默认折叠进「其他」
  const isTemp = (p: ProjectEntry): boolean =>
    p.sessionCount <= 1 && /(^|\/)(Downloads|tmp|Temp|private\/tmp)(\/|$)/.test(p.path)
  const recent = useMemo(() => candidates.filter((p) => !isTemp(p)).slice(0, 8), [candidates])
  const otherProjects = useMemo(() => candidates.filter(isTemp), [candidates])
  const stale = useMemo(() => projects.filter((p) => !p.exists).slice(0, 5), [projects])

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
            ? '已在终端里打开那个会话'
            : outcome.pending
              ? outcome.delivered === 'clipboard'
                ? 'pi 已在终端打开 —— 文案已复制，⌘V 发送后自动绑定'
                : 'pi 已在终端打开，正在发送…'
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
        {resolved?.degraded && (
          <div className="project-hint">
            {resolved.degraded === 'explicit-missing'
              ? '这个目录已不在，已回到主目录'
              : '上次记住的项目已不在，已回到主目录'}
          </div>
        )}

        {showProjects && (
          <div className="project-list">
            {home && (
              <button
                className={`project-item ${home.projectPath === resolved?.projectPath ? 'current' : ''}`}
                onClick={() => {
                  setResolved({ projectPath: home.projectPath, projectName: '~', source: 'explicit' })
                  setMustAsk(false)
                  setShowProjects(false)
                }}
              >
                <span className="name">主目录 ~</span>
                <span className="path">~</span>
              </button>
            )}
            {recent.length === 0 && !home && <div className="project-empty">还没有扫到项目</div>}
            {recent.map((p) => (
              <button
                key={p.path}
                className={`project-item ${p.path === resolved?.projectPath ? 'current' : ''}`}
                onClick={() => {
                  setResolved({
                    projectPath: p.path,
                    projectName: p.path.split('/').filter(Boolean).pop() ?? p.path,
                    source: 'explicit',
                  })
                  setMustAsk(false)
                  setShowProjects(false)
                }}
              >
                <span className="name">{p.path.split('/').filter(Boolean).pop()}</span>
                <span className="path">{p.path.replace(/^\/Users\/[^/]+/, '~')}</span>
              </button>
            ))}
            {otherProjects.length > 0 && (
              <button className="project-group-toggle" onClick={() => setShowOther((v) => !v)}>
                {showOther ? '收起其他' : `其他（${otherProjects.length}）`}
              </button>
            )}
            {showOther &&
              otherProjects.map((p) => (
                <button
                  key={p.path}
                  className={`project-item ${p.path === resolved?.projectPath ? 'current' : ''}`}
                  onClick={() => {
                    setResolved({
                      projectPath: p.path,
                      projectName: p.path.split('/').filter(Boolean).pop() ?? p.path,
                      source: 'explicit',
                    })
                    setMustAsk(false)
                    setShowProjects(false)
                  }}
                >
                  <span className="name">{p.path.split('/').filter(Boolean).pop()}</span>
                  <span className="path">{p.path.replace(/^\/Users\/[^/]+/, '~')}</span>
                </button>
              ))}
            {stale.length > 0 && (
              <button className="project-group-toggle" onClick={() => setShowStale((v) => !v)}>
                {showStale ? '收起已失效' : `已失效（${stale.length}）`}
              </button>
            )}
            {showStale &&
              stale.map((p) => (
                  <button
                    key={p.path}
                    className="project-item stale"
                    title="只做 old→new 映射，不移动 agent 自己的文件"
                    onClick={() => {
                      void window.tick.projects.relocate(p.path).then(async (r) => {
                        await refreshProjects()
                        if (r.relocated) {
                          setResolved({
                            projectPath: r.relocated,
                            projectName: r.relocated.split('/').filter(Boolean).pop() ?? r.relocated,
                            source: 'explicit',
                          })
                          setMustAsk(false)
                          setShowProjects(false)
                        }
                      })
                    }}
                  >
                    <span className="name">{p.path.split('/').filter(Boolean).pop()}</span>
                    <span className="path">{p.path.replace(/^\/Users\/[^/]+/, '~')} · 重新定位…</span>
                  </button>
                ))}
            <button
              className="project-add"
              disabled={adding}
              onClick={() => {
                setAdding(true)
                void window.tick.projects
                  .add()
                  .then(async (list) => {
                    await refreshProjects()
                    const added =
                      list.find((p) => !projects.some((old) => old.path === p.path)) ??
                      list[list.length - 1]
                    if (added) {
                      setResolved({
                        projectPath: added.path,
                        projectName: added.path.split('/').filter(Boolean).pop() ?? added.path,
                        source: 'explicit',
                      })
                      setMustAsk(false)
                    }
                    setShowProjects(false)
                  })
                  .finally(() => setAdding(false))
              }}
            >
              {adding ? '选择目录…' : '＋ 添加本地目录…'}
            </button>
          </div>
        )}

        {/* 投递方式：默认剪贴板（可审阅），不默认“自动发送” */}
        <div className="sheet-row deliver">
          <span className="label">投递</span>
          <div className="segmented">
            <button
              className={deliver === 'clipboard' ? 'on' : ''}
              onClick={() => {
                setDeliverTouched(true)
                setDeliver('clipboard')
              }}
              title="把文案放进剪贴板，由你决定什么时候粘"
            >
              复制文案
            </button>
            <button
              className={deliver === 'argv' ? 'on' : ''}
              onClick={() => {
                setDeliverTouched(true)
                setDeliver('argv')
              }}
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
            disabled={busy || (mustAsk && resolved?.source === 'home')}
            title={mustAsk && resolved?.source === 'home' ? '设置里选了「每次必问」：先选一个项目' : ''}
          >
            在 {resolved?.projectName ?? '…'} 中打开 pi
          </button>
        </div>
      </div>
    </div>
  )
}
