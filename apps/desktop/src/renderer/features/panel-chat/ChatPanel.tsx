/**
 * ChatPanel — 面板对话页（PRD F5）。
 *
 * 布局沿用 UI-SPEC 的骨架：顶栏（返回 + 标题 + 当前模型）· 消息流（唯一可滚）· 输入行（固定）。
 * 口径：
 *  - 面板对话**不显示用量**（D15）；模型名只作为“走哪条凭据”的说明
 *  - 未就绪（没有可用凭据）时只给一行原因，不做安装引导（2026-10-17 用户定的口径）
 */

import React, { useEffect, useRef, useState } from 'react'
import { useChat } from './useChat'

export function ChatPanel({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { chat, send, abort, reset } = useChat()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="panel-inner">
      <div className="topbar">
        <button className="topbar-back" onClick={onBack} aria-label="返回线索">
          ‹
        </button>
        <span className="topbar-title">对话</span>
        <span className="chat-model" title={chat.model ?? ''}>
          {chat.status === 'busy' ? '正在回复…' : (chat.model ?? '')}
        </span>
        <button className="topbar-menu" title="新会话（清空当前上下文）" onClick={() => void reset()}>
          ↺
        </button>
      </div>

      <div className="content chat-stream" ref={scrollRef}>
        {chat.status === 'unavailable' ? (
          <div className="empty">
            <div className="empty-title">面板对话还不可用</div>
            <div className="empty-hint">{chat.reason ?? '未检测到可用的模型凭据'}</div>
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
    </div>
  )
}
