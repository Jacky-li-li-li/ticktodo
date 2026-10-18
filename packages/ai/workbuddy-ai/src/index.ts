/**
 * @tick/ai-workbuddy-ai — 国际版 WorkBuddy AI 适配器（toolId = `workbuddy-ai`）。
 *
 * 存储读取内核（sqlite / jsonl / detect 逻辑）复用 `@tick/ai-workbuddy`；
 * 本包只声明自己的身份（App bundle / 数据根 / scheme / 已验证版本 / playground 策略），
 * 因此与国内版是两个独立适配器、两个 toolId、两份缓存（rules §1）。
 */

export { WorkbuddyAiAdapter, WORKBUDDY_AI_IDENTITY } from './adapter'

// 同名的 deps 类型（intl 与国内版注入面完全一致，直接复用，避免两套漂移）
export type { WorkbuddyAdapterDeps as WorkbuddyAiAdapterDeps } from '@tick/ai-workbuddy'
export type {
  WorkbuddyDetectResult,
  WorkbuddyIdentity,
  WorkbuddyLog,
  WorkbuddySessionRow,
  WorkbuddyTranscriptMeta,
} from '@tick/ai-workbuddy'

// 纯函数出口：测试与 main 侧装配需要，不依赖具体发行版
export {
  clipText,
  collapseText,
  encodeCwd,
  extractUserText,
  readMetaCwd,
  readTranscriptMeta,
  resolveTranscript,
  resolveRootDir,
} from '@tick/ai-workbuddy'
