/**
 * TickMark — 顶栏品牌位使用的小尺寸 T 形线索标记（与 build/icon.svg 同源）。
 *
 * 为什么不用 1024 图标直接缩到 16px：应用图标带 macOS 外边距 + 完整 squircle，
 * 16px 下 T 只剩约 5px；这里为 UI 单独做 16px 网格的紧凑版（深色圆角底 + 白 T + Accent 节点）。
 */

import React from 'react'

export function TickMark({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="brand-mark"
    >
      <rect
        x="0.5"
        y="0.5"
        width="15"
        height="15"
        rx="4.2"
        fill="#121A27"
        stroke="rgba(255,255,255,0.14)"
        strokeWidth="0.6"
      />
      <path
        d="M3.1 5.05C4.9 5.45 11.1 5.45 12.85 5.05"
        stroke="#F3F7FE"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M8 5.25V12.6"
        stroke="#F3F7FE"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12.7" cy="5.05" r="1.1" fill="#0A84FF" />
      <circle cx="8" cy="12.65" r="0.58" stroke="#C9D8EC" strokeOpacity="0.55" strokeWidth="0.5" />
    </svg>
  )
}
