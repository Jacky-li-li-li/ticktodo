/**
 * useChat — 面板对话的 renderer 侧状态。
 *
 * main 的 ChatAgentHost 是唯一执行者；这里只订阅 ChatIpc.updated（durable 的 view 节流推）。
 * 就绪度是数据的一部分：status='unavailable' 时输入框禁用并显示一行原因（不做安装引导）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ChatState } from '@tick/shared'
import type { TickApi } from '../../../preload/index'

declare global {
  interface Window {
    tick: TickApi
  }
}

const EMPTY: ChatState = { status: 'unavailable', messages: [], reason: '正在探测模型…' }

export function useChat(): {
  chat: ChatState
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  reset: () => Promise<void>
} {
  const [chat, setChat] = useState<ChatState>(EMPTY)

  useEffect(() => {
    let alive = true
    void window.tick.chat.state().then((s) => {
      if (alive) setChat(s)
    })
    const off = window.tick.chat.onUpdate((s) => {
      if (alive) setChat(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const send = useCallback(async (text: string) => {
    const content = text.trim()
    if (!content) return
    // 乐观上屏：durable 的 user entry 会很快覆盖成真实 id
    setChat((prev) => ({
      ...prev,
      status: 'busy',
      messages: [...prev.messages, { id: `local-${Date.now()}`, role: 'user', text: content }],
    }))
    try {
      await window.tick.chat.send(content)
    } catch (e) {
      setChat((prev) => ({
        ...prev,
        status: 'idle',
        messages: [
          ...prev.messages,
          { id: `err-${Date.now()}`, role: 'assistant', text: `发送失败：${(e as Error).message}` },
        ],
      }))
    }
  }, [])

  const abort = useCallback(async () => {
    await window.tick.chat.abort()
  }, [])

  const reset = useCallback(async () => {
    await window.tick.chat.reset()
  }, [])

  return { chat, send, abort, reset }
}
