/**
 * 日志：stdout 是 JSON-RPC 的专用通道，任何一行杂物都会让客户端解析失败。
 *
 * 所以这里只往 stderr 或 `TICK_MCP_LOG` 指向的文件写；两者都不可用时彻底静默。
 * 日志里不放标题/正文/会话路径（与审计同一纪律）。
 */

import fs from 'node:fs'
import path from 'node:path'

const LOG_FILE = (process.env.TICK_MCP_LOG ?? '').trim()

let logDirReady = false

function line(level: string, message: string): string {
  return `[tick-mcp ${new Date().toISOString()} pid=${process.pid} ${level}] ${message}\n`
}

function write(level: string, message: string): void {
  const text = line(level, message)
  if (LOG_FILE) {
    try {
      if (!logDirReady) {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 })
        logDirReady = true
      }
      fs.appendFileSync(LOG_FILE, text, { mode: 0o600 })
      return
    } catch {
      // 落到 stderr；绝不落到 stdout
    }
  }
  try {
    process.stderr.write(text)
  } catch {
    // stderr 也坏了就静默：宁可丢日志，也不能污染协议流
  }
}

export function logInfo(message: string): void {
  write('info', message)
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? '' : String(error)
  write('error', detail ? `${message} — ${detail}` : message)
}
