/**
 * ToolIcon — 按 toolId 取对应 AI 工具的品牌图标。
 *
 * 未登记的工具返回 null（只显示文字），不猜图标；
 * 后续新增适配器时在这里登记即可。工具展示名不要在这里做（用 @tick/shared 的
 * `toolDisplayName()`），图标只负责图形。
 */

import React from 'react'
import { PiIcon } from './PiIcon'
import { WorkbuddyIcon } from './WorkbuddyIcon'
import { WorkbuddyAiIcon } from './WorkbuddyAiIcon'

const ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  pi: PiIcon,
  workbuddy: WorkbuddyIcon,
  // 国际版与国内版官方 mark 相同；WorkbuddyAiIcon 用右下角地球徽标做 Tick 内区分
  'workbuddy-ai': WorkbuddyAiIcon,
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
