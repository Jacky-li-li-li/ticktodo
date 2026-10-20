/**
 * @tick/ai-dsh — DeepSeek Harness 适配器（toolId = `dsh`）。
 *
 * 分层：
 *   zstd-frames.ts：dsh 的**多帧 zstd**（一个 10MB 文件 = 23,331 帧）切帧与逐帧解压
 *   paths.ts      ：`DSH_HOME/sessions/<project>/<dir>/session[.vN].jsonl[.zstd]`、首帧 header、
 *                   官方投影缓存（`storages/session_projcache/sessions/<dir>.json`）
 *   adapter.ts    ：detect（App bundle `com.deepseek.dsh`）/ list / describe / usage
 *
 * 关键取舍：
 *  - **列会话不解压正文**：标题/cwd/最近活动/累计用量都在投影缓存里（实测 80 个会话）；
 *  - 子代理（`delegationDepth > 0`）不单列，用量加回父会话；
 *  - **不能回到会话**：`dsh://` 只处理 `dsh://open`（聚焦窗口），没有按会话打开的协议
 *    → `resumeSession=false`，`resume()` 给可读原因。
 *
 * 只读：不读 `.credentials.yaml` / `.env` / `llm-deepseek/` / `profiles/`。
 */

export * from './zstd-frames'
export * from './paths'
export * from './adapter'
