/**
 * @tick/ai-qoder — Qoder CLI（`qoder` 与国内版 `qoder-cn`）。
 *
 * Qoder 的会话格式与 Claude Code 逐字段相同，所以本包只做「身份 + 数据根 + resume argv」，
 * 解析、用量、列表全部复用 `@tick/ai-claude`（magpie 也是同一个读取器）。
 *
 * 两个发行版是**两个独立工具**：两个 toolId、两份缓存、各自的数据根环境变量；
 * 装哪个算哪个，互不影响（rules §1）。
 */

export * from './adapter'
