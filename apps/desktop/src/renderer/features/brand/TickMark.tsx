/**
 * TickMark — 顶栏品牌位使用的小尺寸云豆 + 图钉标记（与 build/icon.svg 同源 IP）。
 *
 * 为什么不用 1024 图标直接缩到 16px：应用图标带 macOS 外边距 + 完整 squircle，
 * 16px 下云豆细节会糊掉；这里为 UI 单独做 16px 网格的紧凑版
 * （深色圆角底 + 白色云豆轮廓 + 双眼 + Accent 图钉）。
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
      {/* cloud body */}
      <path
        d="M3.2 9.2c0-1.5 1.1-2.5 2.4-2.5.3-1 1.2-1.7 2.4-1.7s2.1.7 2.4 1.7c1.3 0 2.4 1 2.4 2.5 0 1.4-1.2 2.4-2.8 2.4H6c-1.6 0-2.8-1-2.8-2.4z"
        fill="#F3F7FE"
      />
      <circle cx="6.3" cy="8.6" r="0.85" fill="#121A27" />
      <circle cx="9.7" cy="8.6" r="0.85" fill="#121A27" />
      <circle cx="6.55" cy="8.4" r="0.25" fill="#F3F7FE" />
      <circle cx="9.95" cy="8.4" r="0.25" fill="#F3F7FE" />
      {/* pin */}
      <circle cx="8" cy="3.6" r="0.7" fill="#0A84FF" />
      <rect x="7.75" y="4.2" width="0.5" height="0.85" fill="#0A84FF" />
    </svg>
  )
}
