/**
 * session-ns — 会话命名空间（业务规则 3：面板.session id 与 CLI `pi --session` id 严格隔离）。
 */

/** CLI 会话 id（品牌类型定义在 @tick/shared，避免 UI 层反向依赖 ai 包） */
export type { CliSessionId } from '@tick/shared'

/** 面板 Chat 会话 key（pi-durable store 内的持久 UUIDv7） */
export type PanelSessionKey = `panel:${string}`

export function toPanelSessionKey(uuid: string): PanelSessionKey {
  return `panel:${uuid}`
}
