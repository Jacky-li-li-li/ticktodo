/**
 * @tick/ai-codex — Codex（CLI / Codex Desktop）会话适配器（toolId = `codex`）。
 *
 * 分层（对齐 `docs/agent-session-storage-map.md`）：
 *   paths.ts   ：rollout 定位（`rollout-<ts>-<threadId>[_seg].jsonl[.zst]`）、按 thread 归并、流式 meta、用量口径
 *   adapter.ts ：detect / list / describe / usage / resume（`codex resume <id>`）
 *
 * 只读纪律：只读 `~/.codex`（或 `CODEX_HOME`）的 `sessions/**` 与 `archived_sessions/**`；
 * 不读 `auth.json` / `config.toml` 等配置与凭据，不写 Codex 任何文件。
 *
 * 与其它工具的关键差异（合同层面的处理）：
 *  - **一会话多文件**：`SessionSummary.files` 给全部 rollout，`filePath` 指向最新那个；
 *  - **没有预生成 id**：`newSessionMode='prefill'` + `prefillDelivery='terminal-copy'`
 *    （打开终端里的 Codex + 文案进剪贴板，不自动发送），`launch()` 直接抛错，只能倒入历史会话。
 */

export * from './paths'
export * from './adapter'
