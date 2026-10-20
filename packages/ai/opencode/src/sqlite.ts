/**
 * sqlite — 只读打开 OpenCode 系工具的数据库（OpenCode / ZCode 共用）。
 *
 * 纪律与 `@tick/ai-workbuddy` 的 sqlite.ts 完全一致（那边是参考实现）：
 *  1. 首选 `new DatabaseSync(file, { readOnly: true })`，**打开后立刻试读一次**
 *     —— WAL 库在缺 `-shm` / 目录不可写时构造成功、首次访问才报错；
 *  2. 试读失败才把 `db` + `-wal` + `-shm` 复制到 `mkdtemp`，用普通方式打开副本（会回放 -wal），
 *     用完关闭并删目录；
 *  3. **禁用 `immutable=1`**（会忽略 -wal，实测读到 0 行）；
 *  4. 任何失败都降级为空（返回 undefined + 一次日志），绝不向 UI 抛。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

type SqliteModule = typeof import('node:sqlite')

let sqliteModulePromise: Promise<SqliteModule | undefined> | undefined

/** node:sqlite 在 Node 22/24 仍是 experimental：动态 import + 缓存，不支持时降级 */
export async function loadSqlite(log: OpenCodeLog): Promise<SqliteModule | undefined> {
  sqliteModulePromise ??= import('node:sqlite')
    .then((mod) => mod)
    .catch(() => undefined)
  const mod = await sqliteModulePromise
  if (!mod) log('sqlite-module', 'node:sqlite 不可用，数据库会话降级为空')
  return mod
}

export type OpenCodeLog = (key: string, message: string) => void

export interface OpenedDatabase {
  db: DatabaseSync
  /** 关闭连接；复制副本场景还要删掉临时目录 */
  cleanup(): void
}

export async function openReadOnlySqlite(
  sqlite: SqliteModule,
  file: string,
  log: OpenCodeLog,
  tag: string,
): Promise<OpenedDatabase | undefined> {
  let liveError: string
  try {
    const db = new sqlite.DatabaseSync(file, {
      readOnly: true,
      enableForeignKeyConstraints: false,
    })
    if (isUsable(db)) return { db, cleanup: () => closeQuietly(db) }
    closeQuietly(db)
    liveError = '只读连接建立后不可读（WAL 需要 -shm 写权限或 -shm 缺失）'
  } catch (e) {
    liveError = errorText(e)
  }

  let tmpDir: string | undefined
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tick-${tag}-`))
    const copy = path.join(tmpDir, 'copy.db')
    fs.copyFileSync(file, copy)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${file}${suffix}`
      if (fs.existsSync(source)) fs.copyFileSync(source, `${copy}${suffix}`)
    }
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
    log('open', `${tag} 数据库只读打开与复制读取均失败：${errorText(e)}（只读原因：${liveError}）`)
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

/** 连接是否真的可读：WAL 库的构造是惰性的，必须真读一次 */
function isUsable(db: DatabaseSync): boolean {
  try {
    db.prepare('select 1 as ok').get()
    return true
  } catch {
    return false
  }
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 表是否存在 + 该表的列（用于 schema 探测；缺列即视为不识别） */
export function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`pragma table_info(${table})`).all() as { name?: unknown }[]
    return new Set(rows.map((r) => (typeof r.name === 'string' ? r.name : '')).filter(Boolean))
  } catch {
    return new Set()
  }
}
