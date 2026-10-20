/**
 * @tick/ai-claude-desktop — Claude Desktop（Code tab + Cowork）适配器（toolId = `claude-desktop`）。
 *
 * 身份与 CLI 完全独立（App bundle / scheme / toolId / 缓存各自一份），但**读取内核复用**
 * `@tick/ai-claude`：两个入口共用同一套会话正文格式（`<uuid>.jsonl`，无首行 header）。
 *
 * 两套会话存储（见 `desktop-store.ts` 的注释与 docs/claude-code-adapter-notes.md §3）：
 *  1. Desktop 自己的会话：`<userData>/<kind>/<acct>/<org>/local_<id>/.claude/projects/…`（id = `local_<id>`）；
 *  2. 被 Desktop adopt 的 CLI 会话：仍在 `~/.claude/projects/…`（id = CLI 的 uuid）。
 *
 * 只读边界：只碰 `Claude.app/Contents/Info.plist`、`local_<id>.json` 记录里列出的字段、
 * 以及会话正文 jsonl；不读 Desktop 的 IndexedDB / Local Storage / cookies / config.json 内容 / OAuth 缓存。
 */

export * from './paths'
export * from './desktop-store'
export * from './adapter'
