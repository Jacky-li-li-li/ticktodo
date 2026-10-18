/**
 * PiIcon — pi（pi.dev）官方品牌标记，用在「用哪个工具」胶囊里。
 *
 * 取自官方 logo https://pi.dev/logo-auto.svg（原 viewBox 0 0 800 800，三色几何「π」）。
 * 官方 SVG 四周留白约占 40%，直接缩到 14px 时图形只剩 ~8px；这里把 viewBox 裁到
 * 色块边界 + 约 6% 呼吸位（135.29 135.29 529.43 529.43），路径本身未改、不改色。
 */

import React from 'react'

export function PiIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="135.29 135.29 529.43 529.43"
      aria-hidden="true"
      focusable="false"
      className="tool-icon"
    >
      <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
      <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
      <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  )
}
