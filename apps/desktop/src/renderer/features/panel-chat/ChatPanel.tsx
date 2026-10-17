/**
 * ChatPanel — 面板对话页（PRD F5）。
 *
 * 布局沿用 UI-SPEC 的骨架：顶栏（返回 + 标题 + 当前模型）· 工作目录行 · 消息流 · 输入行。
 * 口径：
 *  - 面板对话**不显示用量**（D15）；模型名只作为“走哪条凭据”的说明
 *  - 面板 cwd 默认 home，可切换（F5）；切换只改 agent cwd，不新建会话
 */

import React, { useEffect, useRef, useState } from 'react'
import type { ProjectEntry } from '@tick/ai-core'
import { useChat } from './useChat'

export function ChatPanel({
  onBack,
  projects,
  onToast,
  onOpenSettings,
}: {
  onBack: () => void
  projects: ProjectEntry[]
  onToast: (text: string) => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { chat, send, abort, reset, setCwd } = useChat()
  const [draft, setDraft] = useState('')
  const [home, setHome] = useState<string>('')
  const [showProjects, setShowProjects] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.tick.launch.resolveCwd().then((r) => {
      if (alive) setHome(r.projectPath)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chat.messages, chat.status])

  const submit = (): void => {
    if (chat.status === 'unavailable' || chat.status === 'busy') return
    const text = draft
    setDraft('')
    void send(text)
  }

  const cwdLabel = (p: string): string => (home && p === home ? '~' : p.replace(/^\/Users\/[^/]+/, '~'))

  const pick = async (path: string): Promise<void> => {
    setShowProjects(false)
    try {
      await setCwd(path)
      onToast('面板对话的目录已切换')
    } catch (e) {
      onToast(`切换目录失败：${(e as Error).message}`)
    }
  }

  return (
    <div className="panel-inner">
      <div className="topbar">
        <button className="topbar-back" onClick={onBack} aria-label="返回线索">
          ‹
        </button>
        <span className="topbar-title">对话</span>
        <span className="chat-model" title={chat.model ?? ''}>
          {chat.status === 'busy'
            ? '正在回复…'
            : chat.source === 'custom'
              ? (chat.model ?? '').split('/').slice(1).join('/')
              : (chat.model ?? '')}
        </span>
        <button className="topbar-menu" title="新会话（清空当前上下文）" onClick={() => void reset()}>
          ↺
        </button>
      </div>

      <button className="chat-project" onClick={() => setShowProjects((v) => !v)}>
        <span className="label">目录</span>
        <span className="value" title={chat.cwd ?? ''}>
          {chat.cwd ? cwdLabel(chat.cwd) : '…'}
        </span>
        <span className="chevron">›</span>
      </button>
      {showProjects && (
        <div className="project-list chat-project-list">
          {home && (
            <button className={`project-item ${chat.cwd === home ? 'current' : ''}`} onClick={() => void pick(home)}>
              <span className="name">主目录 ~</span>
              <span className="path">~</span>
            </button>
          )}
          {projects
            .filter((p) => p.exists && p.path !== home)
            .slice(0, 12)
            .map((p) => (
              <button
                key={p.path}
                className={`project-item ${chat.cwd === p.path ? 'current' : ''}`}
                onClick={() => void pick(p.path)}
              >
                <span className="name">{p.path.split('/').filter(Boolean).pop()}</span>
                <span className="path">{cwdLabel(p.path)}</span>
              </button>
            ))}
        </div>
      )}

      <div className="content chat-stream" ref={scrollRef}>
        {chat.status === 'unavailable' ? (
          <div className="empty">
            <div className="empty-title">面板对话还不可用</div>
            <div className="empty-hint">{chat.reason ?? '未检测到可用的模型凭据'}</div>
            <div className="empty-hint">
              两个出口：在终端运行 pi 完成登录（默认复用），或在设置里自配 OpenAI 兼容 provider（不依赖 pi）
            </div>
            <button className="pill primary" onClick={onOpenSettings}>
              去设置
            </button>
            <div className="empty-hint">记线索、项目索引、导出不受影响</div>
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="empty">
            <div className="empty-title">直接说你想做什么</div>
            <div className="empty-hint">这里建的线索会进同一个列表；干活的长会话仍然交给 pi</div>
          </div>
        ) : (
          chat.messages.map((m) => (
            <div className={`chat-msg ${m.role}`} key={m.id}>
              <div className="chat-bubble">{m.text}</div>
            </div>
          ))
        )}
      </div>

      <div className={`capture-line chat-input ${chat.status === 'unavailable' ? 'disabled' : ''}`}>
        <span className="plus">›</span>
        <input
          className="capture-line-input"
          value={draft}
          placeholder={chat.status === 'unavailable' ? '未就绪' : '说点什么，回车发送'}
          disabled={chat.status === 'unavailable'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {chat.status === 'busy' ? (
          <button className="chat-send" onClick={() => void abort()}>
            停止
          </button>
        ) : (
          <button className="chat-send" onClick={submit} disabled={chat.status === 'unavailable' || !draft.trim()}>
            发送
          </button>
        )}
      </div>
      {/* PRD F6-b / D15：面板对话不参与用量统计，给一句静态说明避免误解 */}
      <div className="chat-usage-note">此处对话不计入用量统计</div>
    </div>
  )
}
