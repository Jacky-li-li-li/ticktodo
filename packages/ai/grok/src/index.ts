/**
 * @tick/ai-grok — Grok Build 会话适配器（toolId = `grok`）。
 *
 * 分层：paths 与解析都在 adapter.ts（一个目录一个会话：`summary.json` + `updates.jsonl`）。
 * 只读：只读 `~/.grok/sessions/**`（可用 `GROK_HOME` 覆盖），不读配置/凭据。
 * 本机真实样本只有空会话（`num_messages=0` 且无 `updates.jsonl`）——这类不算会话、不贡献项目；
 * 消息与用量的口径来自 magpie，代码按「读不到就降级」。
 * 新建：`newSessionMode='prefill'` + `prefillDelivery='terminal-copy'`（打开终端 + 文案进剪贴板）。
 */

export * from './adapter'
