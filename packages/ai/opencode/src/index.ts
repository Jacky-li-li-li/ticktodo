/**
 * @tick/ai-opencode — OpenCode 系适配器（OpenCode / ZCode 共用，身份参数化）。
 *
 * 分层：
 *   paths.ts   ：数据库位置（OpenCode 的 XDG/`OPENCODE_DB`、ZCode 的 `~/.zcode/cli/db`）
 *   sqlite.ts  ：只读打开 + 试读 + WAL 复制兜底（与 `@tick/ai-workbuddy` 同纪律）
 *   store.ts   ：session/message/part 查询、用量口径（OpenCode 用 session 行，ZCode 用 model_usage）
 *   adapter.ts ：detect / list / describe / usage / resume（`opencode --session <id>`）
 *
 * 只读：只读数据库与 `-wal`/`-shm`（只读打开时 SQLite 可能维护读标记，不视为 Tick 写数据）。
 */

export * from './paths'
export * from './sqlite'
export * from './store'
export * from './adapter'
