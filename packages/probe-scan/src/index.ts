/**
 * @tick/probe-scan — 句柄回扫（handle echo）。
 *
 * 流程：MCP 工具写一条 probe（cache/mcp-pending/<handle>.json）→ 客户端把工具结果写进
 * 自己的会话记录 → 本模块在认证工具的会话文件里做**字节级** handle 匹配 → 命中后
 * 从文件反解 sessionId → 写 verified 绑定 → 删除 probe。
 *
 * 纯 Node、无 Electron；MCP server 与 Tick main 共用。只做字面量匹配：不解析 JSON、
 * 不缓存正文、不进日志。误绑概率由 128-bit 随机 handle 保证。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { newCliSessionId } from '@tick/shared'
import { TodoStoreCore, resolveTickHome, type TodoStoreCore as Store } from '@tick/todo-core'
import { allLocators, locatorForTool, type SessionLocator } from '@tick/session-locators'

// ---------- handle ----------

/** Crockford base32（去掉 i/l/o/u 的 32 字符集） */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const HANDLE_RE = /^tk_[0-9a-hjkmnp-tv-z]{26}$/

/** 128 bit 随机 → 26 个 base32 字符（130 bit，末位补零） */
export function newHandle(): string {
  const bytes = randomBytes(16)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return `tk_${out.slice(0, 26)}`
}

// ---------- probe ----------

export type ProbePurpose = 'create' | 'link'

export interface ProbeRecord {
  version: 1
  handle: string
  purpose: ProbePurpose
  todoId: string
  /** 来源客户端标识（展示/回退扫描用；真正绑定用命中的 locator.toolId） */
  toolId: string
  clientInfo?: string
  cwd?: string
  at: number
  expiresAt: number
  pid: number
  requestId?: string
}

export interface ProbeDeps {
  home?: string
}

export function probeDir(home = resolveTickHome()): string {
  return path.join(home, 'cache', 'mcp-pending')
}

function probePath(handle: string, home = resolveTickHome()): string {
  if (!HANDLE_RE.test(handle)) throw new Error(`非法 handle: ${handle}`)
  return path.join(probeDir(home), `${handle}.json`)
}

export function writeProbe(probe: ProbeRecord, home = resolveTickHome()): void {
  const dir = probeDir(home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = probePath(probe.handle, home)
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(probe, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function deleteProbe(handle: string, home = resolveTickHome()): void {
  try {
    fs.rmSync(probePath(handle, home), { force: true })
  } catch {
    /* 已被别的进程删掉 / handle 非法：忽略 */
  }
}

export function listProbes(home = resolveTickHome()): ProbeRecord[] {
  const dir = probeDir(home)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: ProbeRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProbeRecord>
      if (
        raw.version === 1 &&
        typeof raw.handle === 'string' &&
        HANDLE_RE.test(raw.handle) &&
        typeof raw.todoId === 'string' &&
        (raw.purpose === 'create' || raw.purpose === 'link') &&
        typeof raw.at === 'number' &&
        typeof raw.expiresAt === 'number'
      ) {
        out.push(raw as ProbeRecord)
      } else {
        fs.rmSync(file, { force: true }) // 损坏的 probe 是可再生的 cache
      }
    } catch {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  return out
}

// ---------- 扫描 ----------

export interface ScanOptions {
  home?: string
  /** 注入 store（测试/单写者场景）；缺省按 TICK_HOME 打开 */
  store?: Store
  locators?: SessionLocator[]
  now?: number
  /** 单轮预算（毫秒），超了留到下一轮 */
  budgetMs?: number
  /** 单轮最多检查的文件数 */
  maxFiles?: number
  /** 单文件大小上限（字节） */
  maxFileBytes?: number
  /** 时间窗：probe.at 之前多少毫秒的文件也算（默认 10s） */
  beforeMs?: number
}

export interface ScanHit {
  handle: string
  todoId: string
  toolId: string
  sessionId: string
  filePath: string
}

export interface ScanResult {
  scanned: number
  hits: ScanHit[]
  /** 命中会话但已绑到别的 todo */
  conflicts: { handle: string; todoId: string; toolId: string; sessionId: string; conflictTodoId: string }[]
  expired: number
}

const DEFAULT_BUDGET_MS = 100
const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
const DEFAULT_BEFORE_MS = 10_000

/** 同步读文件并在其中查找 handle（分块 + 重叠，避免整文件进内存） */
function fileContains(file: string, needle: Buffer, maxBytes: number): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return false
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0 || size > maxBytes) return false
    const chunk = 1024 * 1024
    const overlap = needle.length - 1
    const buf = Buffer.alloc(Math.min(chunk + overlap, size + overlap))
    let pos = 0
    let carry = 0
    while (pos < size) {
      // 关键：readSync 的 length 不能超过缓冲区剩余空间（小文件时尤其明显）
      const want = Math.min(chunk, buf.length - carry, size - pos)
      if (want <= 0) break
      const n = fs.readSync(fd, buf, carry, want, pos)
      if (n <= 0) break
      const end = carry + n
      if (buf.subarray(0, end).indexOf(needle) !== -1) return true
      // 保留最后 overlap 字节到下一块开头
      if (overlap > 0 && end > overlap) {
        buf.copy(buf, 0, end - overlap, end)
        carry = overlap
      } else {
        carry = end
      }
      pos += n
    }
    return false
  } catch {
    return false
  } finally {
    fs.closeSync(fd)
  }
}

/** 递归收集候选文件（跳过 symlink / 超大文件；按 mtime 窗口过滤） */
function collectFiles(
  root: string,
  window: { from: number; to: number },
  opts: { maxFiles: number; maxBytes: number; deadline: number },
): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    if (files.length >= opts.maxFiles || Date.now() > opts.deadline) return
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (files.length >= opts.maxFiles || Date.now() > opts.deadline) return
      if (name === 'node_modules' || name === '.git') continue
      const p = path.join(dir, name)
      let st: fs.Stats
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!st.isFile()) continue
      if (st.size === 0 || st.size > opts.maxBytes) continue
      if (st.mtimeMs < window.from || st.mtimeMs > window.to) continue
      files.push(p)
    }
  }
  walk(root)
  return files
}

/**
 * 扫一轮 probe：命中即写 verified 绑定并删 probe；过期 probe 删掉。
 * 返回结果用于审计/日志（不含标题/正文）。
 */
export async function scanProbes(options: ScanOptions = {}): Promise<ScanResult> {
  const home = options.home ?? resolveTickHome()
  // 回扫写绑定也必须 fail-closed：todos.json 损坏时绝不能读空表再写回（会覆盖用户数据）
  const store =
    options.store ?? new TodoStoreCore({ file: path.join(home, 'data', 'todos.json'), onCorrupt: 'throw' })
  const now = options.now ?? Date.now()
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const deadline = now + budgetMs
  const locators = options.locators ?? allLocators()
  const result: ScanResult = { scanned: 0, hits: [], conflicts: [], expired: 0 }

  for (const probe of listProbes(home)) {
    if (probe.expiresAt <= now) {
      deleteProbe(probe.handle, home)
      result.expired++
      continue
    }
    if (Date.now() > deadline) break

    // 已知 toolId 且装了 locator → 只扫它：避免为了找一条线索去翻别的工具的全部会话
    // （隐私边界）。只有 toolId 未知/无 locator 时才回退到全部认证 locator。
    const primary = locatorForTool(probe.toolId)
    const candidates = primary ? [primary] : locators
    const needle = Buffer.from(probe.handle, 'utf8')
    const from = probe.at - (options.beforeMs ?? DEFAULT_BEFORE_MS)
    const to = Math.min(now + 5_000, probe.expiresAt)
    let resolved = false

    for (const locator of candidates) {
      if (!locator || Date.now() > deadline) continue
      for (const root of locator.roots()) {
        if (Date.now() > deadline) break
        const files = collectFiles(root, { from, to }, {
          maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
          maxBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
          deadline,
        })
        for (const file of files) {
          result.scanned++
          if (!fileContains(file, needle, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)) continue
          const located = await locator.readSession(file)
          if (!located) continue // 命中但格式不认识：继续找，不猜

          let bound: ReturnType<Store['addBinding']>
          try {
            bound = store.addBinding(probe.todoId, {
              toolId: locator.toolId,
              sessionId: newCliSessionId(located.sessionId),
              boundAt: new Date(now).toISOString(),
              state: 'verified',
              filePath: located.filePath,
              origin: 'mcp',
            })
          } catch {
            // 数据损坏 / 锁超时：保留 probe，等下次（不能让扫描把坏数据覆盖成空表）
            continue
          }
          if (bound.ok) {
            result.hits.push({
              handle: probe.handle,
              todoId: probe.todoId,
              toolId: locator.toolId,
              sessionId: located.sessionId,
              filePath: located.filePath,
            })
          } else if (bound.conflictTodo) {
            result.conflicts.push({
              handle: probe.handle,
              todoId: probe.todoId,
              toolId: locator.toolId,
              sessionId: located.sessionId,
              conflictTodoId: bound.conflictTodo.id,
            })
          }
          deleteProbe(probe.handle, home)
          resolved = true
          break
        }
        if (resolved) break
      }
      if (resolved) break
    }
  }

  return result
}

/** 给调用方一个「延迟扫 + 结束前最终扫」的小工具；timer 不阻断进程退出 */
export function scheduleScans(
  run: () => Promise<unknown>,
  delaysMs: number[] = [3_000, 10_000, 30_000],
): NodeJS.Timeout[] {
  const timers = delaysMs.map((ms) =>
    setTimeout(() => {
      void run().catch(() => {
        /* 扫描失败不影响工具结果；审计由调用方处理 */
      })
    }, ms),
  )
  for (const t of timers) t.unref()
  return timers
}

/** 供测试：清空 probe 目录 */
export function clearProbes(home = resolveTickHome()): void {
  try {
    fs.rmSync(probeDir(home), { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
