/**
 * @tick/session-locators — 认证工具（pi / workbuddy / workbuddy-ai / claude / claude-desktop）
 * 的会话定位器。
 *
 * 只读、纯 Node、不 import Electron。MCP server（Tier 0 自回扫）与 Tick main
 * （Tier 1 补扫）共用同一组 locator，避免「app 开着能绑、关着绑不上」。
 *
 * 认证范围跟随项目现有 adapter（决策 7）：不认识的客户端没有 locator，
 * 它们的 todo 会停在 unbound（只记来源，不伪造 sessionId）。
 *
 * claude / claude-desktop 是同一引擎的两个入口：前者按 entrypoint 排除 Desktop 会话，
 * 后者只收 Desktop 会话；被 adopt 的 CLI 会话在 Desktop 侧按记录的 cliSessionId 认领成
 * `local_<id>`（与 adapter 列表口径一致）。
 */

import { piLocator } from './pi'
import { createClaudeDesktopLocator, createClaudeLocator } from './claude'
import { createWorkbuddyAiLocator } from './workbuddy-ai'
import { createWorkbuddyCnLocator } from './workbuddy-cn'
import type { ClientIdentity, SessionLocator } from './types'

export * from './types'
export { piLocator } from './pi'
export { createClaudeDesktopLocator, createClaudeLocator } from './claude'
export { createWorkbuddyLocator } from './workbuddy'
export { createWorkbuddyCnLocator } from './workbuddy-cn'
export { createWorkbuddyAiLocator } from './workbuddy-ai'

const wbCn = createWorkbuddyCnLocator()
const wbAi = createWorkbuddyAiLocator()
const claude = createClaudeLocator()
const claudeDesktop = createClaudeDesktopLocator()

/**
 * 全部认证 locator（顺序稳定：pi → claude → claude-desktop → WorkBuddy 两份）。
 *
 * claude 与 claude-desktop 共用同一份 `~/.claude/projects`：前者按 entrypoint 排除 Desktop 会话，
 * 后者只收 Desktop 会话，所以同一个会话只会被一个 locator 命中（不重复绑定）。
 */
export function allLocators(): SessionLocator[] {
  return [piLocator, claude, claudeDesktop, wbCn, wbAi]
}

export function locatorForTool(toolId: string): SessionLocator | undefined {
  return allLocators().find((l) => l.toolId === toolId)
}

/** 用 clientInfo 选 locator（只用于写 mcpOrigin.toolId；扫描会回退到全部认证 locator） */
export function matchLocator(client: ClientIdentity, env: NodeJS.ProcessEnv): SessionLocator | undefined {
  return allLocators().find((l) => l.matches(client, env))
}

/**
 * 把 clientInfo.name 归一成 toolId（小写、非字母数字转 `-`、截 32）。
 * 只用于展示/来源记录；真正的绑定 toolId 以命中的 locator 为准。
 */
export function normalizeClientToolId(client: ClientIdentity): string {
  const raw = (client.name ?? 'mcp').toLowerCase()
  const id = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return id || 'mcp'
}
