/**
 * storage — 数据根 ~/.ticktodo（TICK_HOME 可覆盖）的层级初始化与安全写。
 *
 * 分层语义（PRD §7 / TECH-ARCH §9）：
 *   data/     ✅ 可同步 · 关键（几十 KB，丢了致命）——永不自动删
 *   sessions/ ⚠️ 不建议同步 · 含对话正文（MB 级，丢了可承受）
 *   cache/    ❌ 无需同步 · 可再生（删了自动重建）
 *   exports/  F8 手动导出产物
 *
 * 凭据纪律：整个数据根不含任何 Key——Key 只进系统钥匙串（safeStorage）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface TickDirs {
  root: string
  data: string
  sessions: string
  panelChat: string
  cache: string
  exports: string
}

export function resolveDirs(): TickDirs {
  const root = process.env.TICK_HOME || path.join(os.homedir(), '.ticktodo')
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

// ---------- 原子写 + 文件锁 ----------
// todos.json 会被 CLI（extension，M2）与面板并发写（PRD F5）。
// 锁 = 同目录 O_EXCL 独占文件；陈旧锁（>5s）视为持有者已死，强夺。
//
// ⚠️ 锁文件名必须与 packages/tick-extension/src/todos-file.ts 完全一致（`<file>.lock`）：
// 两个运行时各写各的锁 = 没有互斥，会静默丢写（实测 240 次写丢 117 条）。
// 锁内容 = `<pid>:<uuid>` token，release 只删自己持有的锁，避免被强夺后误删别人的锁。

export function lockPathFor(file: string): string {
  return `${file}.lock`
}

export class FileLock {
  private file: string
  private token = ''

  constructor(file: string) {
    this.file = file
  }

  acquire(): boolean {
    const lock = lockPathFor(this.file)
    for (let attempt = 0; attempt < 40; attempt++) {
      const token = `${process.pid}:${randomUUID()}`
      try {
        fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 })
        this.token = token
        return true
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'EEXIST') throw err
        try {
          // 陈旧锁检测：>5s 强夺
          const age = Date.now() - fs.statSync(lock).mtimeMs
          if (age > 5_000) {
            fs.rmSync(lock, { force: true })
            continue
          }
        } catch {
          continue
        }
        spin(10 + attempt * 2)
      }
    }
    return false
  }

  release(): void {
    const lock = lockPathFor(this.file)
    try {
      // 只删自己持有的锁：被 >5s 强夺后不能再误删下一个持有者的锁
      if (fs.readFileSync(lock, 'utf8') !== this.token) return
      fs.rmSync(lock, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

function spin(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 短 busy-wait：避免 setTimer 把下一次写让给其它进程的交错窗口 */
  }
}

/** 原子写 JSON： tmp 同目录 + fsync + rename（同 FS rename 原子） */
export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  const data = JSON.stringify(value, null, 2)
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}
