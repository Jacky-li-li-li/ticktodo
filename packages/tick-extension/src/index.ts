/**
 * tick-extension — pi extension：defineTool(create_todo / list_todos)。
 * M2 实装（CLI 与面板共用同一实现）。
 *
 * 要点（PRD F5）：
 *  - 安装走 pi 自动发现目录 ~/.pi/agent/extensions/（默认启用，不必 -e）；
 *  - 直接读写 ~/.ticktodo/data/todos.json，与 Main 侧共享原子写 + 文件锁；
 *  - 写操作标为非 safe 重跑 + 幂等键（配合 pi-durable 的 requestId）。
 */

export {}
