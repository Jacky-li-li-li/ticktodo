/**
 * EnterIcon — 线索行右侧「进入详情」图标（重构后替代「继续」胶囊）。
 */

import React from 'react'

export function EnterIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M3 7h7.4M7.4 4.2 10.2 7l-2.8 2.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
