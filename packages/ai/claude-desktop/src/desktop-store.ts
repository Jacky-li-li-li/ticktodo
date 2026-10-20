/**
 * desktop-store — Claude Desktop 自己的会话存储（Code tab 与 Cowork）。
 *
 * 与 CLI 的关系（关键事实，两条独立证据互相印证）：
 *   1. **CLI 会话被 Desktop 原地 adopt**，正文仍在 `~/.claude/projects/<proj>/<uuid>.jsonl`
 *      （官方文档「Desktop continues the same session rather than a copy」+ `app.asar` 的
 *      `adoptCliSession` / `resolveProjectDirForSession`）。
 *   2. **Desktop 自己的会话有独立 home**：每个会话一个目录，里面是**完整的 `.claude` 布局**
 *      `<userData>/<kind>/<accountId>/<orgId>/local_<id>/.claude/projects/<proj>/<uuid>.jsonl`，
 *      会话记录是同级的 `local_<id>.json`。证据：`app.asar` 1.46388.4 的
 *      `iFt()`（session home = `<base>/<sessionId>`）与 `Gti()`（Code tab 同时看
 *      `<sessionHome>/.claude/projects` 与全局 `~/.claude/projects`），以及第三方实现
 *      magpie（`internal/sessions/calls.go` 的 `callDesktopDirs()` 与 `ccFiles("claude-desktop", home)`）。
 *
 * kind 目录：
 *   - `claude-code-sessions`     → Code tab（asar `Pti={cowork:lE, code:eV}`，`eV` 即此）
 *   - `local-agent-mode-sessions` → Cowork（同一套存储形状）
 * 这里两个都扫：对 Tick 而言它们都是「Claude Desktop 里的会话」，展示名不区分。
 *
 * 只读边界：只读 `local_*.json` 记录里的
 *   `sessionId / cliSessionId / unarchivedCliSessionId / preClearCliSessionId /
 *    priorCliSessionIds / title / isArchived / cwd / createdAt / lastActivityAt`，
 * 以及 per-session home 里的 `.claude/projects/**​/<uuid>.jsonl`。
 * **不读** IndexedDB / Local Storage / cookies / config.json / OAuth 缓存。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Desktop 的 userData 根（`~/Library/Application Support/Claude`；`Claude-3p` 是第三方网关模式） */
export function desktopDataDirs(home = homedir()): string[] {
  const base = path.join(home, 'Library', 'Application Support')
  return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')]
}

/** 会话种类目录（Code tab / Cowork），两个都扫 */
export const DESKTOP_KINDS = ['claude-code-sessions', 'local-agent-mode-sessions'] as const

/** `local_<id>`：Desktop 自己的会话 id（asar 的 `J9t=/^local_[A-Za-z0-9-]{1,64}$/`） */
export const LOCAL_SESSION_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/

export function isLocalSessionId(id: string): boolean {
  return LOCAL_SESSION_ID_RE.test(id)
}

/** 一条 Desktop 会话记录（`local_<id>.json` 的只读投影） */
export interface DesktopSessionRecord {
  /** `local_<id>`（文件名或记录里的 sessionId；缺失则无法用 `code/continue` 打开） */
  localId: string
  /** Desktop 当前使用的 CLI 会话 id（**可能缺失**：没有任何 CLI 会话时） */
  cliSessionId?: string
  /** 归档/清空前的历史 id（同一会话的旧正文，仍可用 `--resume` 接上） */
  priorCliSessionIds: string[]
  title?: string
  /** true = 归档：asar 的 `$9t()` 只找非归档会话 → 不能用 `code/continue` 打开 */
  archived: boolean
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  /** 该会话的独立 home（`…/local_<id>`），内部含 `.claude/projects` */
  homeDir: string
  /** 记录文件本身（导出/定位用） */
  recordPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRecordFile(file: string): Record<string, unknown> | undefined {
  try {
    if (statSync(file).size > 8 * 1024 * 1024) return undefined // 防御：记录文件不该这么大
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return ms
  }
  return undefined
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item))
}

/**
 * 把一个 `local_<id>.json` 投影成 `DesktopSessionRecord`。
 * 记录里没有 `cliSessionId` 时也算有效（Desktop 原生会话可能只跑过 Desktop 的引擎）。
 */
export function toSessionRecord(
  recordPath: string,
  homeDir: string,
  raw: Record<string, unknown>,
): DesktopSessionRecord | undefined {
  const fromFile = path.basename(recordPath, '.json')
  const localId = stringOf(raw.sessionId) ?? (isLocalSessionId(fromFile) ? fromFile : undefined)
  if (!localId || !isLocalSessionId(localId)) return undefined
  const cliSessionId = stringOf(raw.cliSessionId) ?? stringOf(raw.unarchivedCliSessionId)
  const prior = [
    ...stringArrayOf(raw.priorCliSessionIds),
    ...(stringOf(raw.preClearCliSessionId) ? [stringOf(raw.preClearCliSessionId) as string] : []),
  ]
  return {
    localId,
    ...(cliSessionId ? { cliSessionId } : {}),
    priorCliSessionIds: [...new Set(prior)].filter((id) => id !== cliSessionId),
    ...(stringOf(raw.title) ? { title: stringOf(raw.title) as string } : {}),
    archived: raw.isArchived === true,
    ...(stringOf(raw.cwd) ? { cwd: stringOf(raw.cwd) as string } : {}),
    ...(numberOf(raw.createdAt) ? { createdAt: numberOf(raw.createdAt) } : {}),
    ...(numberOf(raw.lastActivityAt) ? { lastActivityAt: numberOf(raw.lastActivityAt) } : {}),
    homeDir,
    recordPath,
  }
}

/**
 * 扫 Desktop 的全部会话 store。
 *
 * 布局：`<dataDir>/<kind>/<accountId>/<orgId>/local_<id>.json`
 * （记录直接放在 account/org 目录下；`<accountId>` 是 UUID，也见过 `org` 层缺失的历史目录）。
 * 逐层 readdir，任何一层读不到就跳过——不抛、不猜。
 *
 * `maxRecords` 在**解析阶段**生效（不是读完再 slice）：异常目录/大量残留记录时不要让
 * 首帧把所有 JSON 都读一遍。正常量级远小于上限（本机 3 条），截断只作为兜底；
 * readdir 顺序不保证按时间，所以它不是「保留最近 N 条」，只防异常目录。
 */
export function collectDesktopSessions(
  home = homedir(),
  maxRecords = Number.POSITIVE_INFINITY,
): DesktopSessionRecord[] {
  const out: DesktopSessionRecord[] = []
  const seen = new Set<string>()
  outer: for (const dataDir of desktopDataDirs(home)) {
    for (const kind of DESKTOP_KINDS) {
      const kindDir = path.join(dataDir, kind)
      for (const account of safeReaddir(kindDir)) {
        const accountDir = path.join(kindDir, account)
        if (!isDir(accountDir)) continue
        // 记录可能直接在 account 下，也可能在 account/<org> 下（实测两种日志都出现过）
        for (const entry of safeReaddir(accountDir)) {
          const entryPath = path.join(accountDir, entry)
          if (entry.endsWith('.json') && entry.startsWith('local_') && !isDir(entryPath)) {
            const raw = readRecordFile(entryPath)
            const record = raw ? toSessionRecord(entryPath, path.join(accountDir, entry.replace(/\.json$/, '')), raw) : undefined
            addRecord(out, seen, record)
            if (out.length >= maxRecords) break outer
            continue
          }
          if (!isDir(entryPath)) continue
          for (const file of safeReaddir(entryPath)) {
            if (!file.endsWith('.json') || !file.startsWith('local_')) continue
            const filePath = path.join(entryPath, file)
            if (isDir(filePath)) continue
            const raw = readRecordFile(filePath)
            const record = raw
              ? toSessionRecord(filePath, path.join(entryPath, file.replace(/\.json$/, '')), raw)
              : undefined
            addRecord(out, seen, record)
            if (out.length >= maxRecords) break outer
          }
        }
      }
    }
  }
  out.sort((a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0))
  return out
}

function addRecord(
  out: DesktopSessionRecord[],
  seen: Set<string>,
  record: DesktopSessionRecord | undefined,
): void {
  if (!record || seen.has(record.recordPath)) return
  seen.add(record.recordPath)
  out.push(record)
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 主会话 jsonl 命名（与 CLI 一致：`<uuid>.jsonl`；subagents/ 在子目录里，不收） */
const TRANSCRIPT_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

/**
 * 在会话自己的 home 里找正文：`<home>/.claude/projects/<proj>/<uuid>.jsonl`。
 *
 * 优先 `cliSessionId`（Desktop 当前在用的那条）；没有再退到历史 id；
 * **只有记录完全没记任何 CLI id 时**才取 home 里最新的一条主会话（Desktop 原生会话可能
 * 只跑过 Desktop 引擎、没记 cliSessionId）。
 *
 * 为什么 record 记着 id 却一条都没命中时不能退回「最新一条」：home 里保留下来的正文
 * 可能是另一条会话（Desktop 30 天清理、`/clear`、adopt 后 home 残留都会造成），拿它顶替
 * 会把 B 会话的 firstMessage/lastMessage/用量挂到 A 记录上（审查 P1）。这种时候必须返回
 * undefined，让调用方（`resolveRecord`）改用「按 id 查全局 store」这条有身份依据的路径。
 */
export function findTranscriptInHome(
  homeDir: string,
  record: Pick<DesktopSessionRecord, 'cliSessionId' | 'priorCliSessionIds'>,
): { filePath: string; sessionId: string } | undefined {
  const projects = path.join(homeDir, '.claude', 'projects')
  const projectsInHome = safeReaddir(projects)
  if (projectsInHome.length === 0) return undefined

  const wanted = [record.cliSessionId, ...record.priorCliSessionIds].filter(
    (id): id is string => typeof id === 'string' && Boolean(id),
  )
  const all: { filePath: string; sessionId: string; mtimeMs: number }[] = []
  for (const project of projectsInHome) {
    const projectDir = path.join(projects, project)
    if (!isDir(projectDir)) continue
    for (const name of safeReaddir(projectDir)) {
      const hit = TRANSCRIPT_RE.exec(name)
      if (!hit) continue
      const filePath = path.join(projectDir, name)
      try {
        const st = statSync(filePath)
        if (!st.isFile() || st.size === 0) continue // 0 字节 = 还没产生
        all.push({ filePath, sessionId: hit[1] as string, mtimeMs: st.mtimeMs })
      } catch {
        continue
      }
    }
  }
  if (all.length === 0) return undefined
  for (const id of wanted) {
    const hit = all.find((item) => item.sessionId.toLowerCase() === id.toLowerCase())
    if (hit) return { filePath: hit.filePath, sessionId: hit.sessionId }
  }
  // 记录里有 CLI id 但 home 里一条都没命中：正文不在这里（可能在全局 store，或已被清理）。
  // 不许拿 home 里 mtime 最新的正文顶替——那是另一条会话（见函数头注释）。
  if (wanted.length > 0) return undefined
  // 只有「记录完全没记 CLI id」的 Desktop 原生会话才允许 latest 兜底
  all.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = all[0]
  return latest ? { filePath: latest.filePath, sessionId: latest.sessionId } : undefined
}
