/**
 * CaptureLine — 捕获行（§4.1，母版结构；M0 首页/展开态都在顶栏正下方）。
 * 交互（§4.1）：点击 → 展开为输入态（C2）；回车收下；Esc 取消。
 * 规范（§7）：占位文案「想到什么，先丢下」——陈述式，不催。
 */

import React, { useEffect, useRef, useState } from 'react'

export function CaptureLine({
  onSubmit,
  focusSignal = 0,
}: {
  onSubmit: (title: string) => void
  /** 全局快捷键「新建线索」时递增，用于把焦点放进输入态 */
  focusSignal?: number
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (capturing) inputRef.current?.focus()
  }, [capturing])

  useEffect(() => {
    if (!focusSignal) return
    setCapturing(true)
    // 等输入框挂载后再聚焦
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [focusSignal])

  const commit = () => {
    const title = draft.trim()
    if (title) {
      onSubmit(title)
      setDraft('')
    }
    setCapturing(false)
  }

  return (
    <div
      className="capture-line"
      onClick={() => !capturing && setCapturing(true)}
      role="button"
      aria-label="新建线索"
    >
      <span className="plus">＋</span>
      {capturing ? (
        <input
          ref={inputRef}
          className="capture-line-input"
          placeholder="想到什么，先丢下"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法选词时按回车不应提交（与 ChatPanel 保持一致）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit()
            if (e.key === 'Escape') {
              setDraft('')
              setCapturing(false)
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span>想到什么，先丢下</span>
      )}
    </div>
  )
}
