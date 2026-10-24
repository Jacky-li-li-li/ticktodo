/**
 * paths — pi 会话目录解析与轻量读取（只碰首行 header / session_info，不缓存正文）。
 *
 * 官方事实（RESEARCH-pi §1 / §2.6 / §6.0）：
 *   路径 = `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，`/` `\` `:` → `-`
 *   首行 = {"type":"session","version":N,"id","timestamp","cwd"[,"parentSession"]}
 *   覆盖链：$PI_CODING_AGENT_SESSION_DIR > settings.json(sessionDir, jsonc) > 默认
 *   覆盖形态是「所有会话平铺一个目录」
 *   子代理会话在项目目录再往下 <depth≤3> 层（<session>/0-<name>.jsonl）
 *   顶层散落纯 UUID 0 字节僵尸（本机 31 个）→ size===0 一律视为未产生
 *
 * ⚠️ 绝不调用 pi 的 getDefaultSessionDir()——它会 mkdirSync，探测性路径会造垃圾目录。
 */

import { createReadStream, existsSync, openSync, statSync, closeSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { parseJsonc } from '@tick/storage'

export interface SessionRoot {
  dir: string
  source: 'env' | 'settings' | 'default'
  /** 覆盖来源（env / settings）时所有 .jsonl 平铺 */
  flat: boolean
}

export interface SessionHeader {
  id?: string
  timestamp?: string
  cwd?: string
  parentSession?: string
}

export { parseJsonc } from '@tick/storage'

/** 会话根目录解析（多来源可能同时存在，全收） */
export function resolveSessionRoots(homedirOverride?: string): SessionRoot[] {
  const home = homedirOverride ?? homedir()
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent')
  const envSession = process.env.PI_CODING_AGENT_SESSION_DIR

  let settingsSession: string | undefined
  const settingsPath = path.join(agentDir, 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed = parseJsonc(readFileSyncUtf8(settingsPath)) as { sessionDir?: string } | undefined
      settingsSession = typeof parsed?.sessionDir === 'string' ? parsed.sessionDir : undefined
    } catch {
      /* 解析失败当没配 */
    }
  }

  const roots: SessionRoot[] = []
  for (const [dir, source] of [
    [envSession, 'env'],
    [settingsSession, 'settings'],
    [path.join(agentDir, 'sessions'), 'default'],
  ] as const) {
    if (dir && existsSync(dir)) {
      roots.push({ dir: path.resolve(dir), source, flat: source !== 'default' })
    }
  }
  // 去重：env/settings 覆盖指向默认目录（或其祖先）时，同一文件会被两个 root 各收集一次，
  // 项目计数翻倍。被更深遍历的非平铺 root 覆盖的 root 丢弃。
  const deduped: SessionRoot[] = []
  for (const root of roots) {
    const covered = deduped.some(
      (kept) =>
        !kept.flat &&
        (root.dir === kept.dir || root.dir.startsWith(kept.dir + path.sep)),
    )
    if (!covered) deduped.push(root)
  }
  return deduped
}

function readFileSyncUtf8(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, 0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * 递归收集 .jsonl（含子代理目录；写入时 pi 保证 pending 消息不落盘，无半条风险）。
 * 异步版：reconcile 每 5s 走一次，同步 walk 会周期性阻塞 Electron main 的事件循环。
 */
export async function collectJsonlFiles(root: string, maxDepth = 3): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1)
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(p)
      }
    }
  }
  await walk(root, 0)
  return files
}

/**
 * 只读首行 header（buffer 65KB，header 行远小于此）。
 * 存在性/可读性交给调用方 stat；解析失败返回 undefined。
 */
export function readFirstLineHeader(file: string): SessionHeader | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(65_536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    const line = nl >= 0 ? text.slice(0, nl) : text
    if (!line.trim()) return undefined
    const parsed = JSON.parse(line) as Partial<SessionHeader> & { type?: string }
    if (parsed?.type !== 'session') return undefined // 首行无 header ≈ 坏文件（实测 0 个，仍容错）
    return parsed
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 按会话 id 找文件：verify/resume 用。
 * 命中 = 文件名以 `<timestamp>_<id>.jsonl` 结尾（或平铺形态 `<id>.jsonl`）。
 * 注意：调用方必须 stat size>0 才算真命——0 字节 = 僵尸（D16）。
 */
export async function findSessionFilesById(
  sessionId: string,
  roots: SessionRoot[],
  maxDepth = 3,
): Promise<string[]> {
  const hits: string[] = []
  for (const root of roots) {
    const files = await collectJsonlFiles(root.dir, Math.min(maxDepth, root.flat ? 1 : 3))
    for (const f of files) {
      const base = path.basename(f, '.jsonl')
      if (base === sessionId || base.endsWith(`_${sessionId}`)) hits.push(f)
    }
  }
  return hits
}

export interface SessionMeta {
  /** 最新的 session_info.name（--name 写入，可能被 /rename 改） */
  name?: string
  /** 首条 user 消息的纯文本（用于 name 缺失时的标题回退） */
  firstUserText?: string
  /** 最后一条 user 消息的纯文本（UI-SPEC §6.2 展开卡片「上次停在哪」） */
  lastUserText?: string
}

/**
 * 读会话元数据：最新 session_info.name + 首条 user 文本。
 * 口径（TECH-ARCH §6）：name 必须全量扫（pi 自己也如此），但**只取字段、不缓存正文**。
 * 行内先 includes 再 parse；内存只保留两行文本。
 */
export async function readSessionMeta(file: string): Promise<SessionMeta> {
  return new Promise<SessionMeta>((resolve, reject) => {
    const rs = createReadStream(file, { encoding: 'utf8' })
    const meta: SessionMeta = {}
    let pending = ''
    const consume = (line: string): void => {
      if (line.includes('"session_info"')) {
        try {
          const parsed = JSON.parse(line) as { type?: string; name?: string }
          if (parsed.type === 'session_info' && typeof parsed.name === 'string' && parsed.name) {
            meta.name = parsed.name
          }
        } catch {
          /* 坏行忽略 */
        }
      } else if (line.includes('"role":"user"')) {
        // 注意：不能把「还没找到首条」作为整个分支的条件，否则找到 first 后
        // 后续 user 消息不会再被扫描，lastUserText 会永远停在第一条。
        try {
          const parsed = JSON.parse(line) as {
            type?: string
            message?: { role?: string; content?: unknown }
          }
          if (parsed.type === 'message' && parsed.message?.role === 'user') {
            const text = messageText(parsed.message.content)
            if (text.trim()) {
              if (meta.firstUserText === undefined) meta.firstUserText = text
              meta.lastUserText = text
            }
          }
        } catch {
          /* 坏行忽略 */
        }
      }
    }
    rs.on('data', (chunk) => {
      pending += chunk
      let idx = pending.indexOf('\n')
      while (idx >= 0) {
        consume(pending.slice(0, idx))
        pending = pending.slice(idx + 1)
        idx = pending.indexOf('\n')
      }
    })
    rs.on('end', () => {
      // 写入中的会话可能最后一行还没换行，不能丢
      if (pending) consume(pending)
      resolve(meta)
    })
    rs.on('error', reject)
  })
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/** 把首条消息压成一行可用的标题：去 context 标签/AGENTS.md/图片块，截断 */
export function toSessionTitle(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('#') && !l.startsWith('<'))
  const first = lines[0]
  if (!first) return undefined
  return first.length > max ? `${first.slice(0, max)}…` : first
}
