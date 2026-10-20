/**
 * @tick/ai-omp — omp（oh-my-pi，pi 的 fork）会话适配器（toolId = `omp`）。
 *
 * 与 pi 的关系：目录/文件命名、消息形状、usage 形状都相同；差异是「首行是定宽 title 行」、
 * 「标题来自 `title_change`」，所以只重写「定位 + 表头/标题」，其余复用 `@tick/ai-pi`。
 * 只读：只碰 `~/.omp/agent/sessions/**`，不读 `agent.db` 与配置。
 */

export * from './adapter'
