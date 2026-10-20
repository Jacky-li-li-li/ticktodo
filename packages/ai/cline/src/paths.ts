/**
 * paths — Cline CLI 的会话定位（只读）。
 *
 * 格式事实（magpie `internal/sessions/cline.go` + 本机实测 2026-10-20）：
 *   `<sessions>/<id>/<id>.json`            ← manifest：cwd / started_at / status / model / provider /
 *                                              metadata.title / prompt / messages_path
 *   `<sessions>/<id>/<id>.messages.json`   ← 对话：`{ messages: [{role, content, ts, modelInfo.id,
 *                                              metrics:{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}] }`
 *   `<sessions>/<id>/<id>.hooks.jsonl`     ← hooks 事件，**不是**对话
 *
 * 目录解析（magpie 同序）：`$CLINE_SESSION_DATA_DIR` > `$CLINE_DATA_DIR/sessions` >
 * `$CLINE_DIR/data/sessions` > `~/.cline/data/sessions`。
 *
 * 注意：`<id>.messages.json` 是**整份重写**的（不是追加流），所以缓存只能按 (mtime,size) 失效，
 * 不能像 jsonl 那样假设「只在尾部增长」。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function resolveClineSessionDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const direct = env.CLINE_SESSION_DATA_DIR?.trim()
  if (direct) return path.resolve(direct)
  const data = env.CLINE_DATA_DIR?.trim()
  if (data) return path.join(path.resolve(data), 'sessions')
  const dir = env.CLINE_DIR?.trim()
  if (dir) return path.join(path.resolve(dir), 'data', 'sessions')
  return path.join(home, '.cline', 'data', 'sessions')
}

export interface ClineSession {
  id: string
  manifestPath: string
  messagesPath: string
  mtimeMs: number
  size: number
}

/** 收集 `<sessions>/<id>/<id>.messages.json`（只认主会话；子代理是 `<agent>.messages.json`） */
export function collectClineSessions(sessionDir = resolveClineSessionDir()): ClineSession[] {
  let ids: string[]
  try {
    ids = readdirSync(sessionDir)
  } catch {
    return []
  }
  const out: ClineSession[] = []
  for (const id of ids) {
    const dir = path.join(sessionDir, id)
    const manifestPath = path.join(dir, `${id}.json`)
    const messagesPath = path.join(dir, `${id}.messages.json`)
    let messages
    try {
      messages = statSync(messagesPath)
    } catch {
      continue // 没有对话文件 = 不是会话（hooks.jsonl / 子代理）
    }
    if (!messages.isFile() || messages.size === 0) continue
    // manifest 可能是写盘竞态/被清：**不要因此把整条会话丢掉**，只是没有 cwd/title
    let manifest
    try {
      manifest = statSync(manifestPath)
    } catch {
      manifest = undefined
    }
    out.push({
      id,
      manifestPath,
      messagesPath,
      // 两份文件都要参与「变了没」的判断
      mtimeMs: Math.max(messages.mtimeMs, manifest?.mtimeMs ?? 0),
      size: messages.size + (manifest?.size ?? 0),
    })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

export interface ClineManifest {
  /** 工具自报的会话 id（当前无人消费；文件路径里已有 id，保留作校验/诊断） */
  sessionId?: string
  cwd?: string
  startedAt?: string
  endedAt?: string
  /** 会话状态 / 来源（预留：时间线 PRD 的 status 字段落地后消费，当前列表不展示） */
  status?: string
  model?: string
  provider?: string
  source?: string
  title?: string
  prompt?: string
}

export function readClineManifest(session: ClineSession): ClineManifest {
  try {
    const raw: unknown = JSON.parse(readFileSync(session.manifestPath, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const m = raw as Record<string, unknown>
    const metadata = m.metadata && typeof m.metadata === 'object' ? (m.metadata as Record<string, unknown>) : undefined
    return {
      sessionId: typeof m.session_id === 'string' ? m.session_id : session.id,
      cwd: typeof m.cwd === 'string' ? m.cwd : undefined,
      startedAt: typeof m.started_at === 'string' ? m.started_at : undefined,
      endedAt: typeof m.ended_at === 'string' ? m.ended_at : undefined,
      status: typeof m.status === 'string' ? m.status : undefined,
      model: typeof m.model === 'string' ? m.model : undefined,
      provider: typeof m.provider === 'string' ? m.provider : undefined,
      source: typeof m.source === 'string' ? m.source : undefined,
      // 空串按「没有」处理：Cline 会写 `prompt: ""`。若原样透传，调用方的 `prompt ?? fallback`
      // 会把空串当有效值 → 吞掉真正的首条 user 消息（还会白扫一遍正文）。
      title: metadata && typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : undefined,
      prompt: typeof m.prompt === 'string' && m.prompt.trim() ? m.prompt.trim() : undefined,
    }
  } catch {
    return {}
  }
}
