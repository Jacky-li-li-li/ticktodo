/**
 * @tick/ai-zcode — ZCode 适配器（toolId = `zcode`，桌面应用，只读不可跳）。
 *
 * 复用 `@tick/ai-opencode` 的数据库读取内核，只声明自己的身份（库路径、用量表、无 resume）。
 */

export * from './adapter'
