/**
 * paths — DeepSeek Harness（dsh）的会话定位、header 与官方投影缓存（只读）。
 *
 * 格式事实（magpie `internal/sessions/dsh.go` + 本机实测 2026-10-20，80 个会话）：
 *
 *   `$DSH_HOME/sessions/<project>/<session id>/session[.v<N>].jsonl[.zstd]`
 *   `$DSH_HOME/storages/session_projcache/sessions/<目录名>.json`   ← dsh 自己的投影缓存
 *
 *  - 会话目录名**不等于** header 的 id：本机两种都有（`session-<uuid>` 与 `<uuid>`），
 *    所以 id 一律取 header 的 `id`，目录名只用来找文件和缓存。
 *  - 会话文件可能有多个世代（`session.v3.jsonl` 与 `session.jsonl`），**取最新世代**；
 *    同世代取 mtime 更新的那个。压缩文件是**多帧 zstd**（见 zstd-frames.ts）。
 *  - header = 首行：`{type:"session", version, id, createdAt(ms), cwd, delegationDepth,
 *    parentSession?, origin:"subagent"?}`。
 *  - 子代理：`delegationDepth > 0` + `parentSession`（本机 16/40 个）。
 *  - **投影缓存**（`<dir>.json`，`record.rows.<key>.val`）里有：
 *      `title`（字符串）、`sessionListMetadata`（`{blank, lastPromptAt}`）、
 *      `tokenUsage.totals`（`{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`）、
 *      `subagent`（顶层是 `{}`、子代理是 `{identity:{mode,label}}`，**不含父 id**）、`sessionStats`。
 *    有了它，列会话**不需要**解压 26MB 正文（实测 0.49s/个）。
 *
 * ⚠️ 只读边界：不读 `$DSH_HOME/.credentials.yaml`、`.env`、`llm-deepseek/`、`profiles/`。
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { readFirstFrameText } from './zstd-frames'

/** dsh 的数据根：`DSH_HOME` > `~/.dsh`（magpie `DshDir` 同口径） */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.DSH_HOME?.trim()
  return override ? path.resolve(override) : path.join(home, '.dsh')
}

/** `session.jsonl` / `session.v3.jsonl` / `session.v3.jsonl.zstd` */
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/

export interface DshHeader {
  id: string
  cwd?: string
  createdAt?: number
  delegationDepth?: number
  parentSession?: string
  origin?: string
  version?: number
}

/** 投影缓存里 Tick 需要的部分 */
export interface DshCache {
  title?: string
  cwd?: string
  createdAt?: number
  lastPromptAt?: number
  blank?: boolean
  /** 是否是子代理会话（缓存只给 mode/label，父 id 仍要读 header） */
  subagent?: boolean
  totals?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface DshSession {
  /** header 的会话 id（写入 binding 的唯一值） */
  id: string
  /** 会话目录（含世代文件与 lock） */
  dir: string
  /** 选中的最新世代文件（可能 .zstd） */
  filePath: string
  compressed: boolean
  header: DshHeader
  cache?: DshCache
  mtimeMs: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * 取第一行**非空**文本（没有换行就是整段）。
 * 旧实现 `indexOf('\n') || text.length` 的怪癖：首字符是换行时会把整段当第一行去 JSON.parse；
 * 这里显式 indexOf 并跳过开头的空行（写入中的首帧可能以换行开头）。
 */
function firstLine(text: string): string {
  let rest = text
  for (;;) {
    const index = rest.indexOf('\n')
    const line = index === -1 ? rest : rest.slice(0, index)
    if (line.trim()) return line
    if (index === -1) return ''
    rest = rest.slice(index + 1)
  }
}

/** 读首帧的第一行并解析成 header；失败返回 undefined（不猜） */
export function readHeader(filePath: string, compressed: boolean): DshHeader | undefined {
  if (!compressed) {
    // 未压缩：只读前 64KB 取第一行（未压缩会话可能很大，不能整份读）
    let head: string
    try {
      const fd = openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        const n = readSync(fd, buf, 0, buf.length, 0)
        head = buf.subarray(0, n).toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return undefined
    }
    try {
      const line = firstLine(head)
      return toHeader(JSON.parse(line || head))
    } catch {
      return undefined
    }
  }
  const text = readFirstFrameText(filePath)
  if (!text) return undefined
  try {
    return toHeader(JSON.parse(firstLine(text)))
  } catch {
    return undefined
  }
}

function toHeader(parsed: unknown): DshHeader | undefined {
  if (!isRecord(parsed) || parsed.type !== 'session') return undefined
  const id = str(parsed.id)
  if (!id) return undefined
  return {
    id,
    cwd: str(parsed.cwd),
    createdAt: num(parsed.createdAt),
    delegationDepth: typeof parsed.delegationDepth === 'number' ? parsed.delegationDepth : undefined,
    parentSession: str(parsed.parentSession),
    origin: str(parsed.origin),
    version: typeof parsed.version === 'number' ? parsed.version : undefined,
  }
}

/** `storages/session_projcache/sessions/<dir>.json` → DshCache（读不到就 undefined） */
export function readCache(
  dshHome: string,
  dirName: string,
  log?: (key: string, message: string) => void,
): DshCache | undefined {
  const file = path.join(dshHome, 'storages', 'session_projcache', 'sessions', `${dirName}.json`)
  let raw: unknown
  try {
    // 缓存文件缺失是正常的（新会话/关掉投影）；只有「文件在但读/解析失败」才值得记日志
    if (!existsSync(file)) return undefined
    if (statSync(file).size > 32 * 1024 * 1024) {
      log?.('cache', 'dsh 投影缓存文件超过 32MB，已忽略（不该发生）')
      return undefined
    }
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    log?.('cache', 'dsh 投影缓存读取/解析失败，该会话退回正文口径')
    return undefined
  }
  if (!isRecord(raw) || !isRecord(raw.record)) return undefined
  const record = raw.record
  const identity = isRecord(record.identity) ? record.identity : undefined
  const rows = isRecord(record.rows) ? record.rows : undefined
  const rowVal = (key: string): unknown => {
    if (!rows) return undefined
    const row = rows[key]
    return isRecord(row) ? row.val : undefined
  }
  const title = rowVal('title')
  const listMeta = rowVal('sessionListMetadata')
  const tokenUsage = rowVal('tokenUsage')
  const subagent = rowVal('subagent')
  const cache: DshCache = {
    title: typeof title === 'string' && title ? title : undefined,
    cwd: identity ? str(identity.cwd) : undefined,
    createdAt: identity ? num(identity.createdAt) : undefined,
    lastPromptAt: isRecord(listMeta) ? num(listMeta.lastPromptAt) : undefined,
    blank: isRecord(listMeta) ? listMeta.blank === true : undefined,
    // 实测：顶层会话这里是 `{}`，子代理是 `{identity:{mode,label}}` —— 不是「有没有这一行」
    subagent: isRecord(subagent) && isRecord(subagent.identity),
  }
  if (isRecord(tokenUsage) && isRecord(tokenUsage.totals)) {
    const t = tokenUsage.totals
    const totals = {
      input: num(t.uncachedInputTokens) ?? 0,
      output: num(t.outputTokens) ?? 0,
      cacheRead: num(t.cacheReadTokens) ?? 0,
      cacheWrite: num(t.cacheWriteTokens) ?? 0,
    }
    if (totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0) cache.totals = totals
  }
  return cache
}

/**
 * `sessions` 目录的轻量「版本戳」（缓存失效用）：根目录 mtime + 各项目目录 mtime/条目数。
 * 为什么不能只看根 mtime：新增会话发生在**项目目录**里，根目录 mtime 不变。
 * 局限：会话文件内容变化不改目录 mtime → 调用方还要加短 TTL 兜底（见 DshAdapter）。
 */
export function dshSessionsStamp(dshHome = resolveDshHome()): string {
  const root = path.join(dshHome, 'sessions')
  const parts: string[] = []
  try {
    parts.push(String(statSync(root).mtimeMs))
    for (const project of readdirSync(root)) {
      const projectDir = path.join(root, project)
      try {
        const st = statSync(projectDir)
        if (!st.isDirectory()) continue
        parts.push(`${project}:${st.mtimeMs}:${readdirSync(projectDir).length}`)
      } catch {
        /* 并发删除：忽略该目录 */
      }
    }
  } catch {
    return ''
  }
  return parts.join('|')
}

/**
 * 扫 `sessions/<project>/<dir>/`：
 *  - 每个目录选**最新世代**的会话文件（`.v<N>` 最大；同世代 mtime 更新者）；
 *  - **先收集轻量元数据、按 mtime 排序取 top-N，再读 header**：达到 maxSessions 时按
 *    readdir 顺序截断会漏掉更新的会话（旧实现的问题），而且多读的 header 也没人用；
 *  - 读首帧 header；header 读不出来（写入中/老格式）→ 跳过该目录，不猜 id。
 */
export function collectDshSessions(
  dshHome = resolveDshHome(),
  maxSessions = 5000,
  log?: (key: string, message: string) => void,
): DshSession[] {
  const root = path.join(dshHome, 'sessions')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return []
  }
  interface Candidate {
    dir: string
    dirName: string
    filePath: string
    compressed: boolean
    mtimeMs: number
  }
  const candidates: Candidate[] = []
  for (const project of projects) {
    const projectDir = path.join(root, project)
    let dirs: string[]
    try {
      if (!statSync(projectDir).isDirectory()) continue
      dirs = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const dirName of dirs) {
      const dir = path.join(projectDir, dirName)
      let names: string[]
      try {
        if (!statSync(dir).isDirectory()) continue
        names = readdirSync(dir)
      } catch {
        continue
      }
      let chosen: { filePath: string; compressed: boolean; gen: number; mtimeMs: number } | undefined
      for (const name of names) {
        const hit = SESSION_FILE_RE.exec(name)
        if (!hit) continue
        const filePath = path.join(dir, name)
        let st
        try {
          st = statSync(filePath)
        } catch {
          continue
        }
        if (!st.isFile() || st.size === 0) continue // 0 字节 = 还没产生
        const gen = hit[1] ? Number(hit[1]) : 0
        const cand = { filePath, compressed: Boolean(hit[2]), gen, mtimeMs: st.mtimeMs }
        // 世代更大优先；同世代 mtime 更新优先
        if (!chosen || cand.gen > chosen.gen || (cand.gen === chosen.gen && cand.mtimeMs > chosen.mtimeMs)) {
          chosen = cand
        }
      }
      if (!chosen) continue
      candidates.push({ dir, dirName, ...chosen })
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length > maxSessions) {
    log?.('limit', `dsh 会话数超过上限 ${maxSessions}，只取最近 ${maxSessions} 个（按文件 mtime）`)
  }
  const out: DshSession[] = []
  let skippedHeaders = 0
  for (const cand of candidates.slice(0, maxSessions)) {
    const header = readHeader(cand.filePath, cand.compressed)
    if (!header) {
      // 逐条记日志会刷屏；这里只计数，循环结束后记一次（不含会话 id/路径）
      skippedHeaders += 1
      continue
    }
    const cache = readCache(dshHome, cand.dirName, log)
    out.push({
      id: header.id,
      dir: cand.dir,
      filePath: cand.filePath,
      compressed: cand.compressed,
      header,
      ...(cache ? { cache } : {}),
      mtimeMs: cand.mtimeMs,
    })
  }
  if (skippedHeaders > 0) {
    log?.(
      'header',
      `dsh 有 ${skippedHeaders} 个会话首帧读不出来（写入中 / 超过 8MB 首帧上限 / 格式不认识），已跳过`,
    )
  }
  return out
}

/**
 * 读 `Info.plist` 的 `CFBundleIdentifier`（XML 走正则；**二进制 plist** 走系统 `plutil -convert json`）。
 *
 * 为什么需要 plutil 兜底：Xcode 打包默认可能是二进制 plist，只解析 XML 会让「装了的 App」被
 * 静默判成未安装（整个适配器在 UI 里消失）。实现与 `@tick/ai-opencode/src/paths.ts` 的
 * `bundleIdOf` 一致；两个包没有互相依赖，后续可抽到共享只读 helper（本轮先各留一份并注明）。
 */
export async function bundleIdOf(appBundle: string): Promise<string | undefined> {
  const plist = path.join(appBundle, 'Contents', 'Info.plist')
  let buf: Buffer
  try {
    buf = readFileSync(plist)
  } catch {
    return undefined
  }
  if (buf.subarray(0, 6).toString('latin1') !== 'bplist') {
    const hit = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(buf.toString('utf8'))
    return hit?.[1]?.trim() || undefined
  }
  const { execFile } = await import('node:child_process')
  return new Promise<string | undefined>((resolve) => {
    execFile(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', plist],
      { timeout: 1500, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) return resolve(undefined)
        try {
          const parsed: unknown = JSON.parse(stdout)
          const value =
            parsed && typeof parsed === 'object'
              ? (parsed as Record<string, unknown>).CFBundleIdentifier
              : undefined
          resolve(typeof value === 'string' ? value : undefined)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}

/**
 * 标题压行规则统一用 core 版（滤 `#` /```` ``` ````/`<…>` 开头行）。
 * 旧本地实现只滤 `#`，会让 `<system-reminder>` 之类的行当标题；dsh 的正文里这类注入不少。
 */
export { toSessionTitle } from '@tick/ai-core'

export function exists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}
