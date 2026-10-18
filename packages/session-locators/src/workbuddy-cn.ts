/** WorkBuddy 国内版 locator（toolId = workbuddy；吃 WORKBUDDY_CONFIG_DIR） */
import { WORKBUDDY_IDENTITY } from '@tick/ai-workbuddy'
import { createWorkbuddyLocator } from './workbuddy'
import type { SessionLocator } from './types'

export function createWorkbuddyCnLocator(deps: { rootDir?: string } = {}): SessionLocator {
  return createWorkbuddyLocator(WORKBUDDY_IDENTITY, deps)
}
