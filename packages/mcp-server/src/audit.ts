/**
 * 审计日志：`cache/mcp-audit.log`（0600，append，超过 1 MB 轮转为 `.1`）。
 *
 * 字段固定为 `at,pid,toolId,tool,todoId?,sessionId?,code,ms`。
 * **不含 title/body/路径**：这条纪律与 probe 扫描的隐私边界一致（spec §1.8 / §4.6）。
 * 审计写失败不影响工具结果 —— 它是可观测性，不是业务前置条件。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ScanEvent } from '@tick/probe-scan'
import { logError } from './logger'

const MAX_BYTES = 1024 * 1024

export interface AuditEntry {
  /** 归一化后的客户端 toolId */
  toolId: string
  tool: 'create_todo' | 'list_todos' | 'link_session' | 'scan'
  todoId?: string
  sessionId?: string
  /** 业务错误码；成功为 `OK` */
  code: string
  ms: number
}

export function auditLogPath(home: string): string {
  return path.join(home, 'cache', 'mcp-audit.log')
}

function rotateIfNeeded(file: string, incomingBytes: number): void {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return // 还不存在：append 会创建
  }
  if (size === 0 || size + incomingBytes <= MAX_BYTES) return
  const rotated = `${file}.1`
  try {
    fs.rmSync(rotated, { force: true })
    fs.renameSync(file, rotated)
    try {
      fs.chmodSync(rotated, 0o600)
    } catch {
      /* 忽略 */
    }
  } catch {
    // 轮转失败也不能让日志无限长：退化为截断（cache 层可再生）
    try {
      fs.truncateSync(file, 0)
    } catch {
      /* 忽略 */
    }
  }
}

/** 扫描命中/冲突/过期/坏 probe 的审计（spec §4.1 / §4.2；不含路径与正文） */
export function auditScan(home: string, event: ScanEvent): void {
  const code =
    event.type === 'hit'
      ? 'BOUND'
      : event.type === 'conflict'
        ? 'SESSION_TAKEN'
        : event.type === 'expired'
          ? 'EXPIRED'
          : 'PROBE_CORRUPT'
  audit(home, {
    toolId: 'toolId' in event ? event.toolId : 'mcp',
    tool: 'scan',
    ...('todoId' in event ? { todoId: event.todoId } : {}),
    ...('sessionId' in event ? { sessionId: event.sessionId } : {}),
    code,
    ms: 0,
  })
}

export function audit(home: string, entry: AuditEntry): void {
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    toolId: entry.toolId,
    tool: entry.tool,
    ...(entry.todoId ? { todoId: entry.todoId } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    code: entry.code,
    ms: entry.ms,
  }
  const line = `${JSON.stringify(record)}\n`
  const file = auditLogPath(home)

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    rotateIfNeeded(file, Buffer.byteLength(line))
    const fd = fs.openSync(file, 'a', 0o600)
    try {
      fs.writeFileSync(fd, line)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      /* 已存在但不是 0600 时尽力修正；失败不影响审计内容 */
    }
  } catch (error) {
    logError('审计日志写入失败', error)
  }
}
