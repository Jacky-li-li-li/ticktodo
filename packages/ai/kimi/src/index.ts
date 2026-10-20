/**
 * @tick/ai-kimi — Kimi Code 适配器（toolId = `kimi`）。
 *
 * 分层：
 *   paths.ts   ：`KIMI_CODE_HOME` / `sessions/<slug>/session_*` 定位、`session_index.jsonl` 的 cwd、
 *                `state.json` 标题、`wire.jsonl` 的用户文本与用量（含 fork 去重）
 *   adapter.ts ：detect / list / describe / usage / resume（`kimi --session <id>`）
 *
 * 只读：只读 `~/.kimi-code`（可用 `KIMI_CODE_HOME` 覆盖）下的 sessions 与 index，
 * 不读 `oauth/`、`cache/`、`search-index/`，不写任何文件。
 *
 * 本机实测（7 个会话）：`state.json` **没有 cwd**，cwd 只能取 `session_index.jsonl` 的 `workDir`；
 * 会话 id 是目录名 `session_<uuid>`；子代理在 `agents/agent-N/`，用量归主会话。
 */

export * from './paths'
export * from './adapter'
