/**
 * sqlite — 只读读取 `<root>/workbuddy.db` 的 sessions 表。
 *
 * 硬纪律（PRD §9.1 / §9B.1、rules §4）：
 *  1. **只读**：绝不写工具目录。首选 `new DatabaseSync(db, { readOnly: true })` 直接读 live 库
 *     （实测 5.8.3/5.8.4 可读，且不改变 db/-wal/-shm 的 mtime）；
 *  2. live 只读打开失败（WAL 下缺 -shm、目录无写权限等）→ 把 db + -wal + -shm 复制到
 *     `mkdtemp` 临时目录，以**普通方式**打开副本（副本会回放 -wal），finally 关闭并删目录；
 *  3. **禁用 `?immutable=1`**：它会忽略 -wal（实测读到 0 行，PRD §9B.1 陷阱）；
 *  4. SQL 注意 NULL 三值逻辑：非删除值实测有 NULL / -1 / 0，用 `COALESCE(deleted_at, -1) <= 0`；
 *     `transport` 缺省视为 local；`is_background_automation` 用 `COALESCE(..., 0) != 1`；
 *  5. schema 不识别 / 读取异常 → 返回空数组 + 日志记录一次原因，绝不抛给 UI。
 *
 * 表结构无官方承诺（5.8.x 只有本机逆向 + 小样本），所以列名先经 `PRAGMA table_info(sessions)`
 * 探测：必需列缺失即视为 schema 不识别，整体降级为空而不是读出半套错误数据。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { dbFilePath } from './paths'
import type { WorkbuddyLog, WorkbuddySessionRow } from './types'

type SqliteModule = typeof import('node:sqlite')

/** 缺失即无法安全读取会话列表的列（实测 5.8.3 / 5.8.4 均存在） */
const REQUIRED_COLUMNS = [
  'id',
  'cwd',
  'status',
  'created_at',
  'updated_at',
  'deleted_at',
  'transport',
] as const

/**
 * node:sqlite 在 Node 22/24 仍是 experimental；动态 import + 缓存，
 * 运行态（更老的 Electron/Node）不支持时降级为空，而不是让 main 启动即崩。
 */
let sqliteModulePromise: Promise<SqliteModule | undefined> | undefined

async function loadSqlite(log: WorkbuddyLog): Promise<SqliteModule | undefined> {
  sqliteModulePromise ??= import('node:sqlite')
    .then((mod) => mod)
    .catch(() => undefined)
  const mod = await sqliteModulePromise
  if (!mod) log('sqlite-module', 'node:sqlite 不可用，WorkBuddy 会话数据降级为空')
  return mod
}

interface SessionsSchema {
  columns: Set<string>
  has(column: string): boolean
}

interface OpenedDatabase {
  db: DatabaseSync
  /** 关闭连接；复制副本场景还要删掉临时目录 */
  cleanup(): void
}

export interface ReadSessionsOptions {
  log: WorkbuddyLog
  /** 只查单条 id（resume / describeSession）；缺省 = 全部有效会话 */
  id?: string
}

/**
 * 读取有效会话行（已过滤软删除 / 云端 / 后台自动化，按最近活跃降序）。
 * DB 不存在、schema 不识别、任何读取异常 → `[]`（不抛）。
 */
export async function readSessionRows(
  rootDir: string,
  options: ReadSessionsOptions,
): Promise<WorkbuddySessionRow[]> {
  const file = dbFilePath(rootDir)
  if (!fs.existsSync(file)) return [] // 还没装/还没产生会话：不是错误，不记日志

  const sqlite = await loadSqlite(options.log)
  if (!sqlite) return []

  const opened = await openReadOnly(sqlite, file, options.log)
  if (!opened) return []

  try {
    const probe = probeSessionsSchema(opened.db)
    if ('reason' in probe) {
      options.log('schema', probe.reason)
      return []
    }
    const byId = options.id !== undefined
    const statement = opened.db.prepare(buildSessionQuery(probe.schema, byId))
    const raw = (byId ? statement.all(options.id as string) : statement.all()) as Record<
      string,
      unknown
    >[]
    const rows: WorkbuddySessionRow[] = []
    for (const item of raw) {
      const row = toSessionRow(item)
      if (row) rows.push(row)
    }
    return rows
  } catch (e) {
    options.log('read', `读取 workbuddy.db 失败：${errorText(e)}`)
    return []
  } finally {
    opened.cleanup()
  }
}

// ---------- 打开（含 WAL 复制兜底） ----------

async function openReadOnly(
  sqlite: SqliteModule,
  file: string,
  log: WorkbuddyLog,
): Promise<OpenedDatabase | undefined> {
  let liveError: string
  try {
    const db = new sqlite.DatabaseSync(file, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    })
    // WAL 库在「缺 -shm / 目录不可写」时可能构造成功、**首次访问才报 unable to open database file**，
    // 所以这里必须立刻试读一次；不可用就关掉走复制兜底，而不是把坏连接交给上层。
    if (isUsable(db)) return { db, cleanup: () => closeQuietly(db) }
    closeQuietly(db)
    liveError = '只读连接建立后不可读（WAL 需要 -shm 写权限或 -shm 缺失）'
  } catch (e) {
    liveError = errorText(e)
  }
  return copyAndOpen(sqlite, file, liveError, log)
}

async function copyAndOpen(
  sqlite: SqliteModule,
  file: string,
  liveError: string,
  log: WorkbuddyLog,
): Promise<OpenedDatabase | undefined> {
  let tmpDir: string | undefined
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-wb-'))
    const copy = path.join(tmpDir, 'workbuddy.db')
    fs.copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${file}${suffix}`
      if (fs.existsSync(source)) fs.copyFileSync(source, `${copy}${suffix}`)
    }
    // 副本是我们自己的临时文件：普通方式打开（会回放 -wal），绝不用 immutable=1（会忽略 -wal）
    const db = new sqlite.DatabaseSync(copy)
    if (!isUsable(db)) {
      closeQuietly(db)
      throw new Error('复制出的副本仍不可读')
    }
    const dir = tmpDir
    return {
      db,
      cleanup: () => {
        closeQuietly(db)
        removeDir(dir)
      },
    }
  } catch (e) {
    if (tmpDir) removeDir(tmpDir)
    log('open', `workbuddy.db 只读打开与复制读取均失败：${errorText(e)}（只读原因：${liveError}）`)
    return undefined
  }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    /* 已关闭/打开失败：忽略 */
  }
}

/**
 * 连接是否真的可读：`new DatabaseSync()` 对 WAL 库是惰性打开，缺 -shm 时构造不报错、
 * 第一次真正访问才 `unable to open database file`。用它把这种情况逼出来走复制兜底。
 */
function isUsable(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return true
  } catch {
    return false
  }
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不影响读取结果 */
  }
}

// ---------- schema 探测 + SQL ----------

function probeSessionsSchema(db: DatabaseSync): { schema: SessionsSchema } | { reason: string } {
  let info: unknown
  try {
    info = db.prepare('PRAGMA table_info(sessions)').all()
  } catch (e) {
    return { reason: `sessions 表探测失败：${errorText(e)}` }
  }
  if (!Array.isArray(info) || info.length === 0) return { reason: 'workbuddy.db 中不存在 sessions 表' }

  const columns = new Set<string>()
  for (const item of info) {
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string' && name) columns.add(name)
  }
  const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column))
  if (missing.length > 0) {
    return { reason: `sessions 表缺少必需列：${missing.join(',')}（schema 未验证，降级为空）` }
  }
  return { schema: { columns, has: (column: string) => columns.has(column) } }
}

/**
 * 组装查询。可选列缺失时用常量兜底（`NULL AS x` / `0 AS x`），
 * 这样旧 schema 也能读出「核心字段齐全」的会话，而不是整表失败。
 */
function buildSessionQuery(schema: SessionsSchema, byId: boolean): string {
  const optional = (column: string, fallback: string): string =>
    schema.has(column) ? column : `${fallback} AS ${column}`

  const select = [
    'id',
    'cwd',
    'status',
    'created_at',
    'updated_at',
    'deleted_at',
    'transport',
    optional('title', 'NULL'),
    optional('custom_title', 'NULL'),
    optional('last_activity_at', 'NULL'),
    optional('is_playground', '0'),
    optional('is_background_automation', 'NULL'),
  ].join(', ')

  const where = ['COALESCE(deleted_at, -1) <= 0', "COALESCE(transport, 'local') = 'local'"]
  if (schema.has('is_background_automation')) where.push('COALESCE(is_background_automation, 0) != 1')
  if (byId) where.push('id = ?')

  const orderBy = schema.has('last_activity_at')
    ? 'COALESCE(last_activity_at, updated_at) DESC'
    : 'updated_at DESC'

  return `SELECT ${select} FROM sessions WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`
}

// ---------- 行归一 ----------

function toSessionRow(raw: Record<string, unknown>): WorkbuddySessionRow | undefined {
  const id = str(raw.id)
  if (!id) return undefined
  const createdAt = num(raw.created_at) ?? 0
  return {
    id,
    cwd: str(raw.cwd) ?? '',
    title: str(raw.title),
    customTitle: str(raw.custom_title),
    status: str(raw.status) ?? '',
    createdAt,
    updatedAt: num(raw.updated_at) ?? createdAt,
    lastActivityAt: positive(raw.last_activity_at),
    deletedAt: num(raw.deleted_at) ?? -1,
    transport: str(raw.transport) ?? 'local',
    isPlayground: num(raw.is_playground) === 1,
    isBackgroundAutomation: num(raw.is_background_automation) === 1,
  }
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 毫秒时间戳：0/NULL/负数都视为「没有」 */
function positive(value: unknown): number | undefined {
  const parsed = num(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
