/**
 * @tick/ai-claude — Claude Code CLI 适配器（toolId = `claude`）。
 *
 * 分层：
 *   paths.ts   ：配置根 / 会话文件定位 / 流式元数据（无首行 header，cwd 来自首个带 cwd 的记录）
 *   usage.ts   ：按 message.id 去重的用量 + `cost-state` 快照成本
 *   adapter.ts ：detect / discover / list / describe / verify / launch / resume
 *
 * 桌面形态的 Claude Desktop（Code tab）是**另一个独立工具**，见 `@tick/ai-claude-desktop`：
 * 两个 toolId、两份缓存、各自的身份与深链接，不通过切换根目录复用。
 *
 * 只读纪律：只读 `~/.claude/projects` 下的 `<uuid>.jsonl`（或 `CLAUDE_CONFIG_DIR` 指向的根），
 * 不读 `.credentials.json` / `~/.claude.json` / `settings.json`，不写 Claude 任何文件。
 */

export * from './paths'
export * from './usage'
export * from './adapter'
