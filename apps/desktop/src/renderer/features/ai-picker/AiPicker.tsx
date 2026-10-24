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
  /** 非空 = 记忆/指定的目录已失效，已退回主目录（main 侧 resolveCwd 产出） */
  degraded?: string
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const cwdLabel = (p: string): string =>
    home && p === home.projectPath ? '~' : p.replace(/^\/Users\/[^/]+/, '~')

  // 主目录是 os.homedir()：resolveCwd() 不带 todoId 恒返回 home（与 ChatPanel 同口径）。
  // 此前误把「已推导项目」写进 home，导致列表首项「主目录 ~」实际指向项目目录、真 home 被过滤掉。
  useEffect(() => {
    let alive = true
    void window.tick.launch
      .resolveCwd()
      .then((r) => {
        if (alive) setHome({ projectPath: r.projectPath, projectName: r.projectName, source: r.source })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // 项目三级推导（launch:resolve-cwd）：绑定会话 cwd → lastLaunch → home
  useEffect(() => {
    let alive = true
    void window.tick.launch
      .resolveCwd(todo.id)
      .then((r) => {
        if (!alive) return
        setResolved({
          projectPath: r.projectPath,
          projectName: r.projectName,
          source: r.source,
          degraded: r.degraded,
        })
        setMustAsk(Boolean(r.mustAsk))
      })
      .catch(() => {
        /* IPC 失败：resolved 保持 null，项目行显示 … */
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
      onResult('打开失败：Tick 与主进程的通信出了问题，可重试一次')
      setBusy(false)
    }
  }

  const installedTools = (tools ?? []).filter((t) => t.installed)
  const boundCount = todo.bindings.length

  /** 推导来源的一句解释（source 语义与文案此前错位：home 恰恰是三级全落空的兜底） */
  const derivationNote = (r: Resolved): string | undefined => {
    switch (r.source) {
      case 'bound-session':
        return '推导自绑定会话的项目；打开后可在 pi 里切换目录'
      case 'last-launch':
        return '推导自上次项目；打开后可在 pi 里切换目录'
      case 'recent':
        return '推导自最近使用的项目；打开后可在 pi 里切换目录'
      case 'home':
        return '没有更具体的项目，默认在主目录打开'
      default:
        return undefined
    }
  }

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
          <span className="ns-label">
            用哪个工具{tools ? ` · 检测到 ${installedTools.length} 个` : ''}
          </span>
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
                {tools === null
                  ? '正在检测本机工具…'
                  : tools.length === 0
                    ? '工具检测失败，可点「重新检测」再试'
                    : `已扫描本机：${tools.map((t) => t.toolId).join(' · ')} —— 均未检测到会话目录`}
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
                    .catch(() => {
                      onResult('工具检测失败')
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
          {/* degraded 必须提示（验收 4.2）：目录失效被静默退回 home，用户要知道这件事 */}
          {resolved?.degraded && <div className="ns-note warn">原目录已不存在，已退回主目录</div>}
          {resolved && !resolved.degraded && !mustAsk && derivationNote(resolved) && (
            <div className="ns-note">{derivationNote(resolved)}</div>
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
          {boundCount > 0
            ? `这条线索已有 ${boundCount} 个会话；这次会再开一个`
            : settings.deliver === 'argv'
              ? '文案会直接发给 AI —— 不自动发送只适用于剪贴板'
              : '文案先进剪贴板，你确认后再发 —— 不自动发送'}
        </div>
      </div>
    </div>
  )
}
