/** WorkBuddy AI 国际版 locator（独立 toolId；复用 WorkBuddy 读取内核，不共用国内版配置） */
import { WORKBUDDY_AI_IDENTITY } from '@tick/ai-workbuddy-ai'
import { createWorkbuddyLocator } from './workbuddy'
import type { SessionLocator } from './types'

/**
 * 国际版没有官方根目录环境变量。`TICK_WORKBUDDY_AI_ROOT` 是 Tick 自己的
 * **测试/隔离**钩子（不是产品配置语义，不参与版本判断）；未设置时用默认 `~/.workbuddy-ai`。
 */
export function createWorkbuddyAiLocator(deps: { rootDir?: string } = {}): SessionLocator {
  const rootDir = deps.rootDir ?? process.env.TICK_WORKBUDDY_AI_ROOT?.trim() ?? undefined
  return createWorkbuddyLocator(WORKBUDDY_AI_IDENTITY, rootDir ? { rootDir } : {})
}
