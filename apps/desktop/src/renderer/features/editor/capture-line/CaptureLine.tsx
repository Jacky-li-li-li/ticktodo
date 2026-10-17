/**
 * CaptureLine — 捕获行（§4.1，母版结构；M0 首页/展开态都在顶栏正下方）。
 * 交互（§4.1）：点击 → 展开为输入态（C2）；回车收下；Esc 取消。
 * 规范（§7）：占位文案「想到什么，先丢下」——陈述式，不催。
 */

import React, { useEffect, useRef, useState } from 'react'

export function CaptureLine({ onSubmit }: { onSubmit: (title: string) => void }): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (capturing) inputRef.current?.focus()
  }, [capturing])

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
            if (e.key === 'Enter') commit()
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
