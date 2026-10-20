/**
 * @tick/ai-cline — Cline CLI（Cline 3 / Cline SDK）会话适配器（toolId = `cline`）。
 *
 * 分层：
 *   paths.ts   ：sessions 目录解析、`<id>/<id>.json` manifest 与 `<id>.messages.json` 定位
 *   adapter.ts ：detect / list / describe / usage（AI SDK 口径）/ resume（`cline --id <id>`）
 *
 * 只读：只读 `~/.cline/data/sessions/**`（可用 `CLINE_SESSION_DATA_DIR` / `CLINE_DATA_DIR` /
 * `CLINE_DIR` 覆盖），不读 `~/.cline` 下的 kanban / 配置 / 凭据，不写任何文件。
 */

export * from './paths'
export * from './adapter'
