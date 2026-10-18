/**
 * ToolIcon — 按 toolId 取对应 AI 工具的品牌图标。
 *
 * 未登记的工具返回 null（只显示文字），不猜图标；
 * 后续新增适配器（如 WorkBuddy）时在这里登记即可。
 */

import React from 'react'
import { PiIcon } from './PiIcon'

const ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  pi: PiIcon,
}

export function ToolIcon({
  toolId,
  size = 14,
}: {
  toolId: string
  size?: number
}): React.JSX.Element | null {
  const Icon = ICONS[toolId]
  return Icon ? <Icon size={size} /> : null
}
