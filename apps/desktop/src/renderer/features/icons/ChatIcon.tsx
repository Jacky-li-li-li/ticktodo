/**
 * ChatIcon — 面板对话入口图标（14×14，线性会话气泡 + 三个点）。
 * 只用于顶栏图标位，不承担品牌 T 标记的职责。
 */

import React from 'react'

export function ChatIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M12.25 6.35c0 2.5-2.35 4.53-5.25 4.53-.53 0-1.04-.07-1.52-.19L2.9 12.05l.76-2.03A4.3 4.3 0 0 1 1.75 6.35C1.75 3.85 4.1 1.82 7 1.82s5.25 2.03 5.25 4.53Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="4.75" cy="6.35" r="0.62" fill="currentColor" />
      <circle cx="7" cy="6.35" r="0.62" fill="currentColor" />
      <circle cx="9.25" cy="6.35" r="0.62" fill="currentColor" />
    </svg>
  )
}
