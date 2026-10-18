/**
 * ImportIcon — 「倒入历史会话」图标按钮用：向下箭头落进托盘。
 */

import React from 'react'

export function ImportIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2.9 9.2v1.6c0 .7.6 1.3 1.3 1.3h5.6c.7 0 1.3-.6 1.3-1.3V9.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M7 2.6v5.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M4.9 5.9 7 8l2.1-2.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
