/**
 * @tick/ai-pi — PiAdapter（M1 实装）。
 *
 * pi 官方规范实证：docs/已对齐/RESEARCH-pi.md（pi 事实以此为准）。
 * - paths.ts     ：会话根解析（env / settings jsonc / 默认）+ 首行 header 读取 + 僵尸过滤
 * - probe-exe.ts ：GUI 环境下的可执行文件定位（常见前缀 / PATH / 登录 shell PATH 兜底）
 * - adapter.ts   ：detect / discoverProjects / listSessions / describeSession /
 *                  verify / launch / resume（argv 固定数组）
 */

export * from './paths'
export * from './probe-exe'
export * from './adapter'
export * from './usage'
