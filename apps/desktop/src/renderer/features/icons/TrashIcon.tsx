/**
 * TrashIcon — 解绑（拖动终点 / 危险确认）用。
 */

import React from 'react'

export function TrashIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.8 3.8h8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M5.4 3.8V2.9c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M4 3.8l.5 6.7c0 .6.5 1.1 1.1 1.1h2.8c.6 0 1.1-.5 1.1-1.1L10 3.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.1 6.2v2.9M7.9 6.2v2.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
