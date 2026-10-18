/**
 * @tick/ai-workbuddy — 国内版 WorkBuddy 适配器（toolId = `workbuddy`）。
 *
 * 分层：
 *   paths.ts       ：App bundle / 数据根 / cwd 编码 / jsonl 定位（只读边界的第一道）
 *   sqlite.ts      ：`workbuddy.db` 只读打开（WAL 复制兜底 + schema 探测 + 过滤）
 *   transcript.ts  ：jsonl 流式解析 + user 文本抽取（`<user_query>` / 系统包装剥离）
 *   base-adapter.ts：detect / list / discover / describe / resume / launch 的共用逻辑
 *   adapter.ts     ：国内版身份（WorkbuddyAdapter）
 *
 * 国际版 `@tick/ai-workbuddy-ai` 复用本包的读取内核与 `WorkbuddyIdentity` 类型，
 * 但身份（bundle / 根目录 / scheme / 已验证版本 / playground 策略）各自实现。
 *
 * 只读纪律（rules §4、PRD §9.7）：只读 `workbuddy.db`（+ -wal/-shm）与
 * `projects/<编码 cwd>/<id>.jsonl`；不读 keyblob / device-id / security/ / settings.json /
 * models.json 等敏感文件；不写工具任何文件；不联网。
 */

export * from './types'
export * from './paths'
export * from './sqlite'
export * from './transcript'
export * from './base-adapter'
export * from './adapter'
