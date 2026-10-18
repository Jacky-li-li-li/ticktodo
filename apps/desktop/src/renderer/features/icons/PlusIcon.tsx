/**
 * PlusIcon — 新建会话图标按钮用。
 */

import React from 'react'

export function PlusIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">
      <path d="M7 3.4v7.2M3.4 7h7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
