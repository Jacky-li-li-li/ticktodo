/**
 * AiPicker — 新建会话（整页，§6.4 / §4.6）。
 *
 * 页面结构（固定顺序）：
 *   ← 新建会话
 *   线索名
 *   发送给 AI 的内容（可直接改）
 *   用哪个工具（本机检测到 N 个）· 胶囊由用户自己选
 *   项目 · <已推导>  改
 *   [复制文案并打开 pi]  ← 底部主按钮，Spacer 压到底
 *   文案先进剪贴板，你确认后再发 —— 不自动发送
 *
 * 口径：文案可编辑；工具不猜（每次由用户选）；投递方式跟随设置（默认剪贴板）；
 * 检测不到工具时只在页内出现中性提示卡（§4.6），不阻止记线索。
 */

import React, { useEffect, useRef, useState } from 'react'
import type { Todo } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'
import type { AppSettings } from '@tick/shared'

interface Resolved {
  projectPath: string
  projectName: string
  source: string
}

interface ToolStatus {
  toolId: string
  name: string
  installed: boolean
  version?: string
  reason?: string
}

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
  const [prompt, setPrompt] = useState(todo.body?.trim() || todo.title)
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [mustAsk, setMustAsk] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const [home, setHome] = useState<Resolved | null>(null)
  const [recent, setRecent] = useState<ProjectEntry[]>([])
  const [otherProjects, setOtherProjects] = useState<ProjectEntry[]>([])
  const [stale, setStale] = useState<ProjectEntry[]>([])
  const [showOther, setShowOther] = useState(false)
  const [showStale, setShowStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [tools, setTools] = useState<ToolStatus[] | null>(null)
  const [tool, setTool] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [bound, setBound] = useState(todo.bindings.length)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const cwdLabel = (p: string): string =>
    home && p === home.projectPath ? '~' : p.replace(/^\/Users\/[^/]+/, '~')

  // 项目三级推导（launch:resolve-cwd）：绑定会话 cwd → lastLaunch → home
  useEffect(() => {
    let alive = true
    void window.tick.launch.resolveCwd(todo.id).then((r) => {
      if (!alive) return
      const resolved = { projectPath: r.projectPath, projectName: r.projectName, source: r.source }
      setResolved(resolved)
      setHome({ projectPath: r.projectPath, projectName: '~', source: 'home' })
      setMustAsk(Boolean(r.mustAsk))
    })
    return () => {
      alive = false
    }
  }, [todo.id])

  // 工具检测（§4.6：只在需要它的动作上暴露；失败不阻塞记线索）
  useEffect(() => {
    let alive = true
    void window.tick.tools
      .status()
      .then((list) => {
        if (!alive) return
        setTools(list)
        const installed = list.filter((t) => t.installed)
        setTool((prev) => prev ?? installed[0]?.toolId ?? null)
      })
      .catch(() => {
        if (alive) setTools([])
      })
    return () => {
      alive = false
    }
  }, [])

  // 聚焦提示正文（整页打开即可输入）
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // 项目列表分组：主目录固定首项；低频 Downloads/tmp 折叠进「其他」（PRD 验收 12）
  useEffect(() => {
    const exists = projects.filter((p) => p.exists && p.path !== home?.projectPath)
    const other: ProjectEntry[] = []
    const recentList: ProjectEntry[] = []
    for (const p of exists) {
      const low = /^\/(Users\/[^/]+\/Downloads|tmp|private\/tmp|var\/folders)(\/|$)/.test(p.path)
      if (low && p.sessionCount <= 1) other.push(p)
      else recentList.push(p)
    }
    setRecent(recentList)
    setOtherProjects(other)
    setStale(projects.filter((p) => !p.exists))
  }, [projects, home?.projectPath])

  const run = async (): Promise<void> => {
    if (busy || !tool) return
    const deliver = settings.deliver
    setBusy(true)
    try {
      const outcome = await window.tick.launch.launch({
        todoId: todo.id,
        projectPath: resolved?.projectPath,
        deliver,
        promptText: prompt.trim() || todo.title,
      })
      if (outcome.ok) {
        if (outcome.pending) setBound((n) => n + 1)
        onResult(
          outcome.pending
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
        setBusy(false)
      }
    } catch {
      setBusy(false)
    }
  }

  const installedTools = (tools ?? []).filter((t) => t.installed)

  return (
    <div className="panel-inner">
      {/* §4.4 页面级顶栏：← + 标题 13 SemiBold 白 90%，不放 ⋯ */}
      <div className="topbar">
        <button className="topbar-back" onClick={onClose} aria-label="返回线索">
          ‹
        </button>
        <span className="topbar-title page">新建会话</span>
      </div>

      <div className="content new-session" onClick={() => setShowProjects(false)}>
        <div className="ns-field">
          <span className="ns-label">线索名</span>
          <span className="ns-todo-title">{todo.title}</span>
        </div>

        <div className="ns-field">
          <span className="ns-label">发送给 AI 的内容（可直接改）</span>
          <textarea
            ref={textareaRef}
            className="ns-prompt"
            value={prompt}
            placeholder={todo.title}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="ns-field">
          <span className="ns-label">用哪个工具</span>
          {installedTools.length > 0 ? (
            <div className="ns-tools">
              {installedTools.map((t) => (
                <button
                  key={t.toolId}
                  className={`pill secondary ${tool === t.toolId ? 'on' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setTool(t.toolId)
                  }}
                >
                  {t.toolId}
                  {t.version ? ` ${t.version}` : ''}
                </button>
              ))}
            </div>
          ) : (
            <div className="tool-card" onClick={(e) => e.stopPropagation()}>
              <div className="tool-card-title">没有可用的 agent 工具</div>
              <div className="tool-card-hint">Tick 只做索引、不内置模型…记线索不受影响</div>
              <div className="tool-card-scan">
                当前只接入了 pi；本机未检测到可用工具
              </div>
              <button
                className="tool-card-retry"
                disabled={rechecking}
                onClick={() => {
                  setRechecking(true)
                  void window.tick.tools
                    .status()
                    .then((list) => {
                      setTools(list)
                      setTool((prev) => prev ?? list.filter((t) => t.installed)[0]?.toolId ?? null)
                    })
                    .finally(() => setRechecking(false))
                }}
              >
                {rechecking ? '检测中…' : '重新检测'}
              </button>
            </div>
          )}
        </div>

        <div className="ns-field" onClick={(e) => e.stopPropagation()}>
          <span className="ns-label">项目</span>
          <button className="ns-project" onClick={() => setShowProjects((v) => !v)}>
            <span className="ns-project-name">
              {resolved ? (resolved.projectPath === home?.projectPath ? '主目录 ~' : resolved.projectName) : '…'}
              {resolved ? '（已推导）' : ''}
            </span>
            <span className="ns-project-path">{resolved ? cwdLabel(resolved.projectPath) : ''}</span>
            <span className="chevron">改</span>
          </button>
          {resolved?.source === 'home' && !mustAsk && (
            <div className="ns-note">推导自上次项目；打开后可在 pi 里切换目录</div>
          )}
          {mustAsk && resolved?.source === 'home' && (
            <div className="ns-note warn">设置里选了「每次必问」：先选一个项目再打开</div>
          )}

          {showProjects && (
            <div className="project-list ns-project-list">
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
                  <span className="path">{cwdLabel(p.path)}</span>
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
                    <span className="path">{cwdLabel(p.path)}</span>
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
                    <span className="path">{cwdLabel(p.path)} · 重新定位…</span>
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
        </div>
      </div>

      {/* 底部主按钮：Spacer 压到底（§6.4）；文案带工具与投递语境 */}
      <div className="ns-footer">
        <button
          className="pill primary ns-go"
          disabled={busy || !tool || (mustAsk && resolved?.source === 'home')}
          title={mustAsk && resolved?.source === 'home' ? '先选一个项目' : ''}
          onClick={() => void run()}
        >
          {busy
            ? '打开中…'
            : settings.deliver === 'argv'
              ? `直接发送并打开 ${tool ?? 'pi'}`
              : `复制文案并打开 ${tool ?? 'pi'}`}
        </button>
        <div className="ns-note center">
          {bound > 0
            ? `这条线索已有 ${bound} 个会话；这次会再开一个`
            : settings.deliver === 'argv'
              ? '文案会直接发给 AI —— 不自动发送只适用于剪贴板'
              : '文案先进剪贴板，你确认后再发 —— 不自动发送'}
        </div>
      </div>
    </div>
  )
}
