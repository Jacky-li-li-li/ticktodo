/**
 * PinIcon — 顶栏置顶开关图标（推钉），14×14。
 */

import React from 'react'

export function PinIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M5.1 1.9h3.8l-.42 2.1 1.5 1.5-.3 1.05H4.32l-.3-1.05 1.5-1.5L5.1 1.9Z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M7 6.55V12.2" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    </svg>
  )
}
