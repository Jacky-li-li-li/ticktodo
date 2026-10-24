/**
 * storage — 数据根 ~/.ticktodo 的层级初始化（分层语义见 PRD §7 / TECH-ARCH §9）。
 *
 * 锁、原子写、TICK_HOME 解析、jsonc 等跨运行时原语在 @tick/storage（Main 与
 * pi extension 共用一份实现，防漂移）；这里只管 Tick 自己的目录布局。
 *
 * 分层语义：
 *   data/     ✅ 可同步 · 关键（几十 KB，丢了致命）——永不自动删
 *   sessions/ ⚠️ 不建议同步 · 含对话正文（MB 级，丢了可承受）
 *   cache/    ❌ 无需同步 · 可再生（删了自动重建）
 *   exports/  F8 手动导出产物
 *
 * 凭据纪律：整个数据根不含任何 Key——Key 只进系统钥匙串（safeStorage）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveTickHome } from '@tick/storage'

export interface TickDirs {
  root: string
  data: string
  sessions: string
  panelChat: string
  cache: string
  exports: string
}

export function resolveDirs(): TickDirs {
  const root = resolveTickHome()
  return {
    root,
    data: path.join(root, 'data'),
    sessions: path.join(root, 'sessions'),
    panelChat: path.join(root, 'sessions', 'panel-chat'),
    cache: path.join(root, 'cache'),
    exports: path.join(root, 'exports'),
  }
}

const README = `# ~/.ticktodo 数据层说明

Tick = 「AI 会话的索引层」。本目录按性质分四层：

| 目录 | 丢了会怎样 | 同步 | 说明 |
|---|---|---|---|
| data/ | 致命（todo 全没） | ✅ 建议 | 关键数据：todos.json / settings.json；永不自动删 |
| sessions/ | 可承受（面板只是捕获入口） | ⚠️ 不建议 | 面板对话正文（MB 级）；建议提供「清除面板历史」 |
| cache/ | 无所谓（重扫即重建） | ❌ 不需要 | 项目缓存等可再生数据 |
| exports/ | — | — | F8 手动导出的产物 |

注意：
- 本目录不含任何 API Key；凭据只存在系统钥匙串。
- 若用网盘/dotfiles 同步，只同步 data/ 这一层即可。
`

const LAYERS = ['data', 'sessions', 'cache', 'exports'] as const

export function ensureDirs(dirs: TickDirs): void {
  fs.mkdirSync(dirs.root, { recursive: true, mode: 0o700 })
  for (const layer of LAYERS) {
    const dir = path.join(dirs.root, layer)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // 0700 目录；root 跑过会留下 root 属主 → 启动时修正（TECH-ARCH §10）
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      /* 权限修正失败不阻塞启动 */
    }
  }
  fs.mkdirSync(dirs.panelChat, { recursive: true, mode: 0o700 })
  // 内容变了就刷新（旧版本留下的 README 不会一直骗人）
  const readme = path.join(dirs.root, 'README.md')
  try {
    if (!fs.existsSync(readme) || fs.readFileSync(readme, 'utf8') !== README) {
      fs.writeFileSync(readme, README, { mode: 0o600 })
    }
  } catch {
    /* README 写失败不阻塞启动 */
  }
}
