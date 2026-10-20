/**
 * ToolIcon — 按 toolId 取对应 AI 工具的品牌图标。
 *
 * 两条路径，按「有没有官方矢量 mark」分流：
 *  1. **内联 SVG**（`ICONS`）：pi / WorkBuddy 两个发行版 / Claude 两个入口 —— 官方提供 SVG，
 *     直接内联（路径与配色未改，只做 viewBox 裁边与 id 前缀处理）。
 *  2. **位图**（`MARKS`）：Kimi / ZCode / DeepSeek Harness / Qoder / Cline / Grok / OpenCode / omp
 *     —— 官方只有 App 图标或位图 favicon，这里用**官方图标的 96px 版本**（Vite 资源导入，
 *     显示尺寸 14px，@3x 屏足够清晰）。来源逐条写在 `assets/README.md`，不自行重绘。
 *
 * 未登记的工具返回 null（只显示文字），不猜图标。
 * 目前 15 个适配器全部有图标；唯一没有**独立** mark 的是 `codex`——用 OpenAI 官方 blossom
 * 标识厂商（见上面的注释与 `assets/README.md`），不是自造的图形。
 *
 * 工具展示名不要在这里做（用 `@tick/shared` 的 `toolDisplayName()`），图标只负责图形。
 */

import React from 'react'
import { ClaudeIcon } from './ClaudeIcon'
import { PiIcon } from './PiIcon'
import { WorkbuddyIcon } from './WorkbuddyIcon'
import { WorkbuddyAiIcon } from './WorkbuddyAiIcon'
import clineMark from './assets/cline.png'
import codexMark from './assets/codex.png'
import dshMark from './assets/dsh.png'
import grokMark from './assets/grok.png'
import kimiMark from './assets/kimi.png'
import ompMark from './assets/omp.png'
import opencodeMark from './assets/opencode.png'
import qoderMark from './assets/qoder.png'
import zcodeMark from './assets/zcode.png'

const ICONS: Record<string, (props: { size?: number }) => React.JSX.Element> = {
  pi: PiIcon,
  workbuddy: WorkbuddyIcon,
  // 国际版与国内版官方 mark 相同；WorkbuddyAiIcon 用右下角地球徽标做 Tick 内区分
  'workbuddy-ai': WorkbuddyAiIcon,
  // Claude Code 与 Claude Desktop 共用官方星芒 mark（官方没有区分两个形态的图形），
  // 区分靠展示名：Claude Code / Claude Desktop
  claude: ClaudeIcon,
  'claude-desktop': ClaudeIcon,
}

/** 只有位图官方 mark 的工具（键 → Vite 资源 URL） */
const MARKS: Record<string, string> = {
  // Codex 没有公开的独立 mark（CLI 只发布终端截图，openai.com 资源 403）→ 用 OpenAI 官方
  // blossom（开发者文档的 favicon.svg，去蓝色底圆、按官方单色用法转黑）。这是「厂商 mark」，
  // 不是自造的 Codex 图形；细节见 assets/README.md。
  codex: codexMark,
  kimi: kimiMark,
  zcode: zcodeMark,
  dsh: dshMark,
  // 国内版（qoder-cn）与国际版共用同一个官方 mark（两个站点返回同一张图）
  qoder: qoderMark,
  'qoder-cn': qoderMark,
  cline: clineMark,
  grok: grokMark,
  opencode: opencodeMark,
  omp: ompMark,
}

export function ToolIcon({
  toolId,
  size = 14,
}: {
  toolId: string
  size?: number
}): React.JSX.Element | null {
  const Icon = ICONS[toolId]
  if (Icon) return <Icon size={size} />
  const mark = MARKS[toolId]
  if (mark) {
    return (
      <img
        className="tool-icon"
        width={size}
        height={size}
        src={mark}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    )
  }
  return null
}
