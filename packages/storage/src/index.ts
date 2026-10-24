/**
 * @tick/storage — Main 进程与 pi extension 共用的存储原语。
 *
 * 为什么存在：todos.json 会被两个运行时（Electron Main / pi CLI extension）并发读写，
 * 锁名、锁协议、TICK_HOME 解析、原子写语义必须只有一份实现。此前两边各手抄一份，
 * 已经漂移出真实 bug（TICK_HOME trim 不一致 → 各写各的根；锁等待策略不同）。
 * 任何「两边约定一致」的规则都编码在这里，不靠注释互相应许。
 *
 * 运行环境：纯 Node API（Electron main 与 pi extension 进程都可用），无任何外部依赖。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------- 数据根 ----------

/**
 * 数据根目录。TICK_HOME 两侧（Main / extension）都从这里解析，trim 语义一致。
 * 曾经开过 Main 不 trim、extension trim 的漂移：带空格的 TICK_HOME 会让两个运行时
 * 写进不同根、各锁各的（与历史上锁名不一致丢写同构）。
 */
export function resolveTickHome(): string {
  return process.env.TICK_HOME?.trim() || path.join(os.homedir(), '.ticktodo')
}

export function todosFilePath(home = resolveTickHome()): string {
  return path.join(home, 'data', 'todos.json')
}

// ---------- 原子写 ----------

/**
 * 原子写：tmp（同目录，带 pid+时间戳防碰撞）+ fsync + rename + 目录 fsync。
 * 目录 fsync 保证 rename 本身落盘（Linux 需要；macOS/Windows 上失败则忽略）。
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    const dirFd = fs.openSync(dir, 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    /* 平台不支持目录 fd：rename 已原子，只是掉电窗口无保证 */
  }
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* 忽略 */
  }
}

/** 原子写 JSON（统一带结尾换行，便于人工 diff/append 场景） */
export function atomicWriteJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * 清理崩溃残留的 `.tmp` 文件（写入进程被 kill 后 rename 没跑完留下的）。
 * 只删 tmp 后缀且超龄的；corrupt-<ts> 备份与正式文件不动。
 */
export function cleanStaleTmp(dir: string, maxAgeMs = 60 * 60 * 1000): number {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const file = path.join(dir, name)
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.rmSync(file, { force: true })
        removed++
      }
    } catch {
      /* 忽略 */
    }
  }
  return removed
}

// ---------- 跨进程文件锁 ----------

export function lockPathFor(file: string): string {
  return `${file}.lock`
}

/** 锁内容 = `<pid>:<uuid>`；release 只删自己持有的锁，避免被强夺后误删下一个持有者的锁 */
type LockToken = `${number}:${string}`

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但属于其他用户；ESRCH = 不存在
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 陈旧判定（按证据收敛，不按等待时间猜）：
 *  - token 里的 PID 已死 → 陈旧（崩溃残留，立即可抢，不用等 5s）；
 *  - token 不可解析（旧格式/外部文件）→ 退回文件年龄 > STALE_LOCK_MS（跨机器同步场景 PID 无意义）；
 *  - PID 还活着 → 不陈旧。绝不抢活锁：抢活锁 = 两个进程同时读改写（丢写重现）。
 */
function lockIsStale(lockPath: string): boolean {
  let token: string
  try {
    token = fs.readFileSync(lockPath, 'utf8').trim()
  } catch {
    return true // 锁刚被释放/消失 → 回到重试，不算陈旧
  }
  const pid = Number.parseInt(token.split(':')[0] ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS
    } catch {
      return true
    }
  }
  return !pidAlive(pid)
}

const STALE_LOCK_MS = 5_000
const WAIT_SLICE_MS = 25

export class FileLock {
  private file: string
  private token: LockToken | undefined

  constructor(file: string) {
    this.file = file
  }

  /**
   * 拿锁。budgetMs 内拿不到（持有者还活着）返回 false，由调用方决定报错措辞。
   * 等待用 Atomics.wait（Electron main 与 extension 都是 Node 进程，可用；比 busy-spin 省电）。
   */
  acquire(budgetMs = 10_000): boolean {
    const lock = lockPathFor(this.file)
    const deadline = Date.now() + budgetMs
    for (;;) {
      const token: LockToken = `${process.pid}:${randomUUID()}`
      try {
        fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 })
        this.token = token
        return true
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException
        if (err.code !== 'EEXIST') throw err
        if (lockIsStale(lock)) {
          try {
            fs.rmSync(lock, { force: true })
          } catch {
            /* 另一个等待者先删了 → 下一轮直接竞争 */
          }
          continue
        }
        if (Date.now() >= deadline) return false
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_SLICE_MS)
      }
    }
  }

  release(): void {
    if (!this.token) return
    const lock = lockPathFor(this.file)
    try {
      if (fs.readFileSync(lock, 'utf8') !== this.token) return
      fs.rmSync(lock, { force: true })
    } catch {
      /* 忽略 */
    } finally {
      this.token = undefined
    }
  }
}

// ---------- jsonc（pi 的 settings.json 允许注释/尾逗号） ----------

/**
 * 剥注释与尾逗号后 JSON.parse。注释剥离按字符状态机处理字符串与转义；
 * 尾逗号只在字符串外剥（`,}` / `,]` 出现在字符串内容里时不能改写）。
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inStr = false
  let esc = false
  const nextMeaningful = (from: number): string | undefined => {
    let i = from
    for (;;) {
      const c = text[i]
      if (c === undefined) return undefined
      if (/\s/.test(c)) {
        i++
        continue
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
        continue
      }
      return c
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    if (c === ',') {
      const n = nextMeaningful(i + 1)
      if (n === '}' || n === ']') continue // 尾逗号：跳过
    }
    out += c
  }
  try {
    return JSON.parse(out)
  } catch {
    return undefined
  }
}
