/**
 * AiPicker — 新建会话（整页，§6.4 / §4.6）。
 *
 * 页面结构（固定顺序）：
 *   ← 新建会话
 *   线索名
 *   发送给 AI 的内容（可直接改）
 *   项目 · <已推导>  改（先选项目：项目决定 cwd，工具只决定用哪个 AI）
 *   用哪个工具 · 单选列表（后续接更多工具时纵向扩展）
 *   [预填文案并打开 <工具>] / [直接发送并打开 <工具>]  ← 底部主按钮
 *   文案先预填到工具输入框，你确认后再发 —— 不自动发送
 *
 * 口径：文案可编辑；工具不猜（每次由用户选）；投递方式默认跟随设置，但底部提供
 * 「直接发送」勾选（仅作用于这一次拉起：勾选=argv 直接发送，不勾=预填输入框待确认）；
 * 列表包含两类可操作工具（统一由 newSessionMode 表达）：
 *  - `launch`（pi / Claude Code）：Tick 预生成 id → 终端新建 → 绑定；
 *  - `prefill`：只打开「新建入口」并放入文案，不自动发送、不绑定。它有两种投递形态：
 *      · `deeplink`（WorkBuddy 系 / Claude Desktop）：GUI 新建页 + 深链接预填；
 *      · `terminal-copy`（Codex / Cline / Grok / omp / Kimi / OpenCode）：CLI 没有草稿 API，
 *        只能打开终端里的工具 + 文案进剪贴板，由用户 ⌘V + 回车确认。
 * 两类都没有（`none`）时只在页内出现中性提示卡（§4.6），不阻止记线索。
 */

import React, { useEffect, useRef, useState } from 'react'
import type { AppSettings, Todo, ToolClientId, ToolStatus } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'
import { toolDisplayName } from '@tick/shared'
import { ToolIcon } from '../icons/ToolIcon'

interface Resolved {
  projectPath: string
  projectName: string
  source: string
  /** 非空 = 记忆/指定的目录已失效，已退回主目录（main 侧 resolveCwd 产出，UI 必须提示） */
  degraded?: string
}

/**
 * 本页可选的工具（统一由 newSessionMode 表达，不再用两个布尔组合）：
 *  - `launch`：写文案 → 在终端里新建会话（Tick 预生成 id 并绑定）；
 *  - `prefill`：打开它的 GUI 新建页并预填，不自动发送/不绑定；
 *  - `none`：工具已安装，但**不支持从 Tick 新建会话**（只能先在工具里开始，再「倒入历史会话」绑定）。
 * 文案上用「仅倒入」，不要写「不可用」——那会被读成「这个工具坏了/没接上」，而它其实能列会话、能回到会话。
 * 只按 installed 判断（2026-10-19 起不再做版本校验）。
 */
const isSelectable = (t: ToolStatus): boolean =>
  t.installed && (t.newSessionMode === 'launch' || t.newSessionMode === 'prefill')
/** 只能「打开新建入口 + 放入文案」的工具（桌面深链接 / CLI 终端 + 剪贴板） */
const isPrefillOnly = (t: ToolStatus): boolean => t.newSessionMode === 'prefill'
/** CLI 形态的 prefill：打开终端里的工具、文案进剪贴板（CLI 没有草稿 API） */
const isTerminalCopy = (t: ToolStatus): boolean =>
  t.newSessionMode === 'prefill' && t.prefillDelivery === 'terminal-copy'
/**
 * 标签文案：区分「GUI 新建页」与「打开并复制」。
 * OpenCode 两个入口都是「打开 + 文案进剪贴板」（它的深链接在 1.19.3 不生效），所以统一标「打开并复制」。
 */
const prefillTag = (t: ToolStatus): string => (isTerminalCopy(t) ? '打开并复制' : '新建页')
/** 默认优先 pi（现有主路径），否则第一个可新建工具 */
const preferredTool = (list: ToolStatus[]): string | null =>
  (list.find((t) => t.toolId === 'pi') ?? list[0])?.toolId ?? null

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
  /**
   * 本次拉起的投递方式：默认跟随设置，但这是**每页一次的覆盖**，不回写设置。
   * 用户想「这次直接发」时不必再去设置页；取消勾选即回到预填输入框（可审阅）。
   */
  const [directSend, setDirectSend] = useState(settings.deliver === 'argv')
  /**
   * 多客户端工具（OpenCode：桌面版 / CLI）的选择，按 toolId 记。
   * 会话数据两边共用，差别只在「新建入口」与「怎么回到会话」：
   *  - 桌面版：新会话页 + 文案预填（不发送）；回到会话只能打开项目，需要自己点那一条；
   *  - CLI：终端 + 文案进剪贴板；回到会话能 `--session` 精确定位。
   * 选择写进 settings.toolClients，下次进来默认沿用。
   */
  const [clientChoice, setClientChoice] = useState<Record<string, ToolClientId>>({})
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * 列表严格等于「本机已安装的工具」：已安装但没有新建通路的（newSessionMode='none'）也保留，
   * 只是禁用并给原因，不能因为它不支持新建就把它从本机工具列表里删掉。
   * 展示顺序按「能新建的优先 → 展示名」，不跟 main 的注册顺序走（注册顺序是把适配器按接入批次排的，
   * 会让 Claude Desktop 掉到 WorkBuddy 后面、同厂商工具被拆散）。
   */
  const installedTools = (tools ?? [])
    .filter((t) => t.installed)
    .sort((a, b) => {
      const byAbility = Number(isSelectable(b)) - Number(isSelectable(a))
      if (byAbility !== 0) return byAbility
      return a.name.localeCompare(b.name, 'en')
    })
  /** 其中当前真的能执行「新建」的子集（默认选中/主按钮只从这里面挑） */
  const selectableTools = installedTools.filter(isSelectable)
  const selectedTool = selectableTools.find((t) => t.toolId === tool)
  /** 当前选中工具是 prefill 形态：只打开新建入口 + 放入文案，不自动发送/不绑定 */
  const prefillMode = selectedTool?.newSessionMode === 'prefill'
  /** 空态里说明「本机扫到了什么」：只数真正安装的，未安装的 adapter 不算 detected */
  const detectedNames = installedTools.map((t) => t.name)
  /** 禁用行的悬浮说明：把「为什么不能新建」和「那怎么用它」一次说清 */
  const importOnlyHint = (t: ToolStatus): string =>
    `只能倒入历史会话：先在 ${t.name} 里开始一条会话，再用「倒入历史会话」绑定；Tick 不会替你新建它`
  /** 当前选中工具的展示名：优先用 main 给的 status.name，其次走 shared 的兜底映射；没有则留空 */
  const toolName =
    selectedTool?.name ?? (tool ? toolDisplayName(tool) : '')

  /**
   * 某个工具当前用哪个客户端：本次点选 > settings > 缺省 desktop（新建场景，与 main 侧 clientFor 一致）。
   * 卡片右侧的切换按钮会即时改这里，选中桌面版时标签/按钮文案同步变。
   */
  const clientOf = (toolId: string, clients?: ToolClientId[]): ToolClientId | undefined => {
    if (!clients || clients.length < 2) return undefined
    const picked = clientChoice[toolId] ?? settings.toolClients?.[toolId]
    return picked && clients.includes(picked) ? picked : clients[0]
  }
  const chosenClient = selectedTool ? clientOf(selectedTool.toolId, selectedTool.clients) : undefined
  /** 文案里的入口名：CLI 直接用工具名；桌面版补「桌面版」。拼句子时按末字符决定要不要空格 */
  const clientLabel = (name: string): string =>
    chosenClient === 'desktop' ? `${name} 桌面版` : name
  const joiner = (label: string): string => (/[A-Za-z0-9]$/.test(label) ? ' ' : '')
  /** 当前入口的展示名（每次渲染只算一次；按钮与底部说明共用） */
  const entryName = clientLabel(toolName)
  /** 当前选中的 prefill 工具是不是「打开终端 + 复制文案」形态（避免在 JSX 里对 selectedTool 做非空断言） */
  const terminalCopy = Boolean(selectedTool && isTerminalCopy(selectedTool))

  /**
   * 切换「桌面版 / CLI」：先乐观更新，失败则回滚并提示。
   * 不能 fire-and-forget —— main 侧 resume 也读同一份 settings.toolClients，
   * UI 显示已切换但写盘失败会让「回到会话」走另一条入口。
   */
  const applyClient = async (toolId: string, id: ToolClientId): Promise<void> => {
    const prev = clientChoice[toolId]
    setClientChoice((p) => ({ ...p, [toolId]: id }))
    try {
      await window.tick.settings.update({
        toolClients: { ...(settings.toolClients ?? {}), [toolId]: id },
      })
    } catch {
      setClientChoice((p) => {
        const next = { ...p }
        if (prev) next[toolId] = prev
        else delete next[toolId]
        return next
      })
      onResult(`保存「${id === 'desktop' ? '桌面版' : 'CLI'}」偏好失败，请重试`)
    }
  }

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
        const selectable = list.filter(isSelectable)
        setTool((prev) =>
          selectable.some((t) => t.toolId === prev) ? prev : preferredTool(selectable),
        )
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

    // prefill 形态（GUI 深链接 / CLI 终端 + 剪贴板）：只把文案送到工具的新建入口，不写绑定
    if (prefillMode) {
      setBusy(true)
      try {
        const outcome = await window.tick.launch.openNewSessionPage({
          todoId: todo.id,
          toolId: tool,
          projectPath: resolved?.projectPath,
          promptText: prompt.trim() || todo.title,
          ...(chosenClient ? { client: chosenClient } : {}),
        })
        if (outcome.ok) {
          onResult(
            // adapters 的 notice 是「实际发生了什么」的唯一来源（CLI 会说明文案已进剪贴板），
            // 不能在这里再用一句笼统的「已打开新建页」盖过去。
            outcome.notice ??
              `已在 ${toolName} 中打开新建任务页${
                outcome.truncated ? '（文案过长，已截断预填）' : ''
              } —— 发送后可用「倒入历史会话」绑定`,
          )
          onClose()
        } else {
          onResult(outcome.reason ?? `没能打开 ${toolName} 新建页`)
          setBusy(false)
        }
      } catch {
        onResult(`打开 ${toolName} 新建页失败，请重试`)
        setBusy(false)
      }
      return
    }

    // 勾选优先于设置：这是「这次直接发」的显式意图；不勾则预填输入框（不进剪贴板）
    const deliver = directSend ? 'argv' : 'prefill'
    setBusy(true)
    try {
      const outcome = await window.tick.launch.launch({
        todoId: todo.id,
        toolId: tool,
        projectPath: resolved?.projectPath,
        deliver,
        promptText: prompt.trim() || todo.title,
      })
      if (outcome.ok) {
        if (outcome.pending) setBound((n) => n + 1)
        // notice = 非致命降级（如 prefill 回执超时后已改投剪贴板）；优先如实展示，不能藏
        const message =
          outcome.notice ??
          (outcome.pending
            ? outcome.delivered === 'prefill'
              ? `${toolName} 已在终端打开 —— 文案已预填，确认后回车发送，发送后自动绑定`
              : outcome.delivered === 'clipboard'
                ? `${toolName} 已在终端打开 —— 文案已复制，⌘V 发送后自动绑定`
                : `${toolName} 已在终端打开，正在发送…`
            : outcome.delivered === 'prefill'
              ? `文案已预填到 ${toolName} —— 确认后回车发送`
              : outcome.delivered === 'clipboard'
                ? `文案已复制 —— 到 ${toolName} 里 ⌘V`
                : `已发出去，${toolName} 正在处理`)
        onResult(message)
        onClose()
      } else {
        onResult(outcome.reason ?? `没能打开 ${toolName}`)
        setBusy(false)
      }
    } catch {
      onResult(`打开 ${toolName} 失败，请重试`)
      setBusy(false)
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
          {!resolved?.degraded && !mustAsk && resolved?.source === 'home' && (
            <div className="ns-note">
              没有更具体的项目，默认在主目录打开{toolName ? `；打开后可在 ${toolName} 里切换目录` : ''}
            </div>
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

        <div className="ns-field ns-field-tools">
          <span className="ns-label">用哪个工具</span>
          {tools === null ? (
            <div className="tool-card" onClick={(e) => e.stopPropagation()}>
              <div className="tool-card-title">正在检测本机工具…</div>
              <div className="tool-card-hint">检测完成后会列出本机已安装的工具。</div>
            </div>
          ) : installedTools.length > 0 ? (
            <>
              <div className="ns-tools" role="radiogroup" aria-label="用哪个工具">
                {installedTools.map((t) => {
                  const on = tool === t.toolId
                  const available = isSelectable(t)
                  const rowClient = clientOf(t.toolId, t.clients)
                  const multiClient = (t.clients?.length ?? 0) > 1
                  return (
                    // radio 与「桌面版 / CLI」切换器必须是**兄弟节点**：ARIA 规定 radio 的 descendants
                    // 是 presentational，把 button 嵌进 radio 里读屏不会报它。切换器用绝对定位放进
                    // 卡片内部右侧（.ns-tool.has-switch 让出 96px），卡片保持整行等宽。
                    <div key={t.toolId} className="ns-tool-row">
                      <div
                        role="radio"
                        aria-checked={on}
                        aria-disabled={!available}
                        tabIndex={available ? 0 : -1}
                        className={`ns-tool ${on ? 'on' : ''} ${available ? '' : 'unavailable'}${multiClient ? ' has-switch' : ''}`}
                        title={available ? undefined : importOnlyHint(t)}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (available) setTool(t.toolId)
                        }}
                        onKeyDown={(e) => {
                          if (!available) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setTool(t.toolId)
                          }
                        }}
                      >
                        <ToolIcon toolId={t.toolId} size={16} />
                        <span className="ns-tool-name">{t.name}</span>
                        {isPrefillOnly(t) && (
                          <span className="ns-tool-tag">{prefillTag(t)}</span>
                        )}
                        {!available && <span className="ns-tool-tag">仅倒入</span>}
                      </div>
                      {/* 同一份会话数据的两个入口：只改「新建/回到会话」走哪个客户端，不影响读取 */}
                      {multiClient && (
                        <span
                          className="ns-switch"
                          role="group"
                          aria-label={`${t.name} 打开方式`}
                          title={
                            rowClient === 'desktop'
                              ? '桌面版：打开 App 并把文案放进剪贴板（⌘V）；回到会话只打开 App，不能定位'
                              : 'CLI：打开终端 + 剪贴板；回到会话能精确定位'
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          {(t.clients ?? []).map((id) => (
                            <button
                              key={id}
                              type="button"
                              className={`ns-switch-btn ${rowClient === id ? 'on' : ''}`}
                              aria-pressed={rowClient === id}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!on) setTool(t.toolId)
                                void applyClient(t.toolId, id)
                              }}
                            >
                              {id === 'desktop' ? '桌面版' : 'CLI'}
                            </button>
                          ))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="tool-card" onClick={(e) => e.stopPropagation()}>
              <div className="tool-card-title">未检测到本机的 AI 工具</div>
              <div className="tool-card-hint">安装 pi 或对应桌面应用后，这里会自动出现；记线索不受影响。</div>
              <div className="tool-card-scan">未检测到已安装的 AI 工具</div>
              <button
                className="tool-card-retry"
                disabled={rechecking}
                onClick={() => {
                  setRechecking(true)
                  void window.tick.tools
                    .status()
                    .then((list) => {
                      setTools(list)
                      const selectable = list.filter(isSelectable)
                      setTool((prev) =>
                        selectable.some((t) => t.toolId === prev)
                          ? prev
                          : preferredTool(selectable),
                      )
                    })
                    .finally(() => setRechecking(false))
                }}
              >
                {rechecking ? '检测中…' : '重新检测'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 底部主按钮：Spacer 压到底（§6.4）；桌面工具没有「直接发送」勾选（只预填） */}
      <div className="ns-footer">
        <div className="ns-footer-row">
          <button
            className="pill primary ns-go"
            disabled={busy || !tool || (mustAsk && resolved?.source === 'home')}
            title={mustAsk && resolved?.source === 'home' ? '先选一个项目' : ''}
            onClick={() => void run()}
          >
            {busy
              ? '打开中…'
              : prefillMode
                ? terminalCopy
                  ? `打开 ${entryName}${joiner(entryName)}并复制文案`
                  : `在${toolName ? ` ${toolName}` : ''} 中打开新建页`
                : `${directSend ? '直接发送并打开' : '预填文案并打开'}${
                    toolName ? ` ${toolName}` : ''
                  }`}
          </button>
          {!prefillMode && (
            <label
              className="ns-direct"
              title="勾选后把文案作为启动消息直接发给工具（启动即发）；不勾则预填到工具输入框，确认后回车"
            >
              <input
                type="checkbox"
                checked={directSend}
                disabled={busy || !tool}
                onChange={(e) => setDirectSend(e.target.checked)}
              />
              <span>直接发送</span>
            </label>
          )}
        </div>
        <div className="ns-note center">
          {prefillMode
            ? terminalCopy
              // CLI / 桌面版都没有草稿 API：能做的只有「打开工具 + 复制文案」，不承诺已预填
              ? `打开 ${entryName}${joiner(entryName)}并把文案复制到剪贴板（⌘V 粘贴）；不会自动发送，发送后可用「倒入历史会话」绑定`
              : `只打开 ${toolName} 的新建任务页并预填文案/项目；发送后可用「倒入历史会话」绑定`
            : bound > 0
              ? `这条线索已有 ${bound} 个会话；这次会再开一个`
              : directSend
                ? '文案会直接发给 AI —— 勾选后不经过预填'
                : '文案会预填到工具输入框，你确认后回车发送 —— 不自动发送'}
        </div>
      </div>
    </div>
  )
}
