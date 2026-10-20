/**
 * paths — Kimi Code 的会话定位与 wire.jsonl 解析（只读）。
 *
 * 格式事实（magpie `internal/sessions/kimi.go`、`transcript_kimi.go`、`calls_kimi.go`
 * + 本机实测 2026-10-20，7 个会话）：
 *
 *   `<root>/sessions/<workdir slug>/session_<uuid>/state.json`
 *   `<root>/sessions/<workdir slug>/session_<uuid>/agents/main/wire.jsonl`      ← 主对话
 *   `<root>/sessions/<workdir slug>/session_<uuid>/agents/agent-N/wire.jsonl`   ← 子代理（归本会话）
 *   `<root>/session_index.jsonl`  `{sessionId, sessionDir, workDir}`            ← **cwd 的唯一来源**
 *
 * 注意：
 *  - **`state.json` 里没有 cwd**（实测只有 title/custom/isCustomTitle/lastPrompt/agents/时间），
 *    cwd 必须取 `session_index.jsonl` 的 `workDir`（或退回 wire 的 `config.update.cwd`）。
 *  - 会话 id = 目录名 `session_<uuid>`（也是 `kimi --session <id>` 的参数）。
 *  - 子代理的 `agents[<id>].type === 'sub'`，其 wire 里的用量**归主会话**（magpie 同口径）。
 *  - `state.json` 的 `createdAt/updatedAt` 是 ISO；wire 的 `time` / `metadata.created_at` 是 **ms**。
 *  - 用户文本以 `turn.prompt` 为准（`origin.kind !== 'user'` 的是技能激活/系统触发，不算）；
 *    `turn.steer` 是回合中途进来的话（background_task 之类不算）。`context.append_message`
 *    带 `time` 的与 prompt/loop 事件重复，**跳过**；不带 `time` 的是 Python kimi-cli 导入的历史，才用。
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

/** Kimi Code 的 home：`KIMI_CODE_HOME` > `~/.kimi-code`（magpie `KimiCodeDir` 同口径） */
export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.KIMI_CODE_HOME?.trim()
  return override ? path.resolve(override) : path.join(home, '.kimi-code')
}

/** `session_index.jsonl`：sessionId → workDir（cwd 的唯一可靠来源） */
export function readKimiIndex(kimiHome = resolveKimiHome()): Map<string, string> {
  const out = new Map<string, string>()
  const file = path.join(kimiHome, 'session_index.jsonl')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      const r = parsed as Record<string, unknown>
      if (typeof r.sessionId === 'string' && typeof r.workDir === 'string' && r.workDir) {
        out.set(r.sessionId, r.workDir)
      }
    } catch {
      /* 坏行忽略 */
    }
  }
  return out
}

export interface KimiSessionDir {
  /** 目录名 = 会话 id（`session_<uuid>`），也是 `kimi --session` 的参数 */
  id: string
  dir: string
  statePath?: string
  /** 主对话（`agents/main/wire.jsonl`） */
  mainWirePath?: string
  /** 子代理的 wire（用量与工具调用归主会话） */
  subWirePaths: string[]
  mtimeMs: number
}

/**
 * 扫 `<root>/sessions/<slug>/session_*`；只读，不 mkdir。
 *
 * 达到 maxSessions 时**先按 mtime 排序取最近 top-N**再截断（旧实现按 readdir 顺序截断，
 * 超过上限会丢更新的会话），截断时经 `log` 记一次（不含 id/正文）。
 */
export function collectKimiSessions(
  kimiHome = resolveKimiHome(),
  maxSessions = 2000,
  log?: (key: string, message: string) => void,
): KimiSessionDir[] {
  const root = path.join(kimiHome, 'sessions')
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return []
  }
  const out: KimiSessionDir[] = []
  for (const slug of slugs) {
    const slugDir = path.join(root, slug)
    let ids: string[]
    try {
      if (!statSync(slugDir).isDirectory()) continue
      ids = readdirSync(slugDir)
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.startsWith('session_')) continue
      const dir = path.join(slugDir, id)
      let isDir = false
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      const statePath = path.join(dir, 'state.json')
      const agentsDir = path.join(dir, 'agents')
      const mainWirePath = path.join(agentsDir, 'main', 'wire.jsonl')
      const subWirePaths: string[] = []
      let mtimeMs = 0
      try {
        mtimeMs = Math.max(mtimeMs, statSync(dir).mtimeMs)
      } catch {
        /* 忽略 */
      }
      let agentDirs: string[] = []
      try {
        agentDirs = readdirSync(agentsDir)
      } catch {
        /* 会话可能刚创建 */
      }
      for (const agent of agentDirs) {
        if (agent === 'main') continue
        const wire = path.join(agentsDir, agent, 'wire.jsonl')
        if (existsSync(wire)) subWirePaths.push(wire)
      }
      const hasMain = existsSync(mainWirePath)
      // 主 wire 都没有、state.json 也没有 → 不是可用会话
      if (!hasMain && !existsSync(statePath)) continue
      for (const p of [statePath, ...(hasMain ? [mainWirePath] : [])]) {
        try {
          mtimeMs = Math.max(mtimeMs, statSync(p).mtimeMs)
        } catch {
          /* 忽略 */
        }
      }
      out.push({
        id,
        dir,
        ...(existsSync(statePath) ? { statePath } : {}),
        ...(hasMain ? { mainWirePath } : {}),
        subWirePaths,
        mtimeMs,
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (out.length > maxSessions) {
    log?.('limit', `kimi 会话数超过上限 ${maxSessions}，只取最近 ${maxSessions} 个（按 mtime）`)
    return out.slice(0, maxSessions)
  }
  return out
}

export interface KimiState {
  title?: string
  /** true = 用户自己改的名（`custom.title` 或 `isCustomTitle`） */
  customTitle?: string
  lastPrompt?: string
  createdAt?: string
  updatedAt?: string
  /** 主代理 id（实测恒为 "main"；缺失时按 main 处理） */
  mainAgentId?: string
}

export function readKimiState(session: KimiSessionDir): KimiState {
  if (!session.statePath) return {}
  try {
    const raw: unknown = JSON.parse(readFileSync(session.statePath, 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const r = raw as Record<string, unknown>
    const custom = r.custom && typeof r.custom === 'object' ? (r.custom as Record<string, unknown>) : undefined
    const agents = r.agents && typeof r.agents === 'object' ? (r.agents as Record<string, unknown>) : undefined
    let mainAgentId: string | undefined
    if (agents) {
      for (const [id, value] of Object.entries(agents)) {
        if (value && typeof value === 'object' && (value as Record<string, unknown>).type === 'main') {
          mainAgentId = id
          break
        }
      }
    }
    return {
      title: typeof r.title === 'string' && r.title ? r.title : undefined,
      customTitle:
        r.isCustomTitle === true && custom && typeof custom.title === 'string' && custom.title
          ? custom.title
          : undefined,
      lastPrompt: typeof r.lastPrompt === 'string' && r.lastPrompt ? r.lastPrompt : undefined,
      createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
      updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
      mainAgentId,
    }
  } catch {
    return {}
  }
}

/** wire.jsonl 的解析结果（只保留必要文本与用量） */
export interface KimiWire {
  cwd?: string
  /** `metadata.created_at`（ms） */
  createdAt?: number
  model?: string
  firstUserText?: string
  lastUserText?: string
  firstUserAt?: number
  /** 末条用户文本的时间（ms）：合并主/子 wire 时必须按它取最新，不能按数组顺序覆盖 */
  lastUserAt?: number
  lastEventAt?: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** 见过的 usage 指纹（fork 会把父会话的记录原样复制过来，靠它去重） */
  usageKeys: Set<string>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function textOfBlocks(blocks: unknown): string | undefined {
  if (typeof blocks === 'string') return blocks.trim() || undefined
  if (!Array.isArray(blocks)) return undefined
  const text = blocks
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
    .trim()
  return text || undefined
}

export interface ReadKimiWireOptions {
  /** 只读前 N 字节（列表拿首条用户消息用；wire 单文件可达 10MB，整份读没意义） */
  maxBytes?: number
  /** 读到首条合格用户文本就停（列表/首条标题场景） */
  stopAfterFirstUser?: boolean
}

/**
 * 读一条 wire.jsonl。
 * @param agent 用来区分「主代理」与子代理（用量去重键里带 agent，避免 fork 复制导致重复计）
 */
export async function readKimiWire(
  file: string,
  agent: string,
  opts: ReadKimiWireOptions = {},
): Promise<KimiWire> {
  const out: KimiWire = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageKeys: new Set<string>(),
  }
  // 前缀读：`end` 是闭区间；末尾被切半的行 JSON.parse 失败会被跳过，不影响前面的内容
  const stream = createReadStream(file, {
    encoding: 'utf8',
    ...(opts.maxBytes !== undefined ? { start: 0, end: Math.max(0, opts.maxBytes - 1) } : {}),
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line) continue
      if (
        !line.includes('"turn.prompt"') &&
        !line.includes('"turn.steer"') &&
        !line.includes('"usage.record"') &&
        !line.includes('"config.update"') &&
        !line.includes('"context.append_message"') &&
        !line.includes('"metadata"')
      ) {
        continue
      }
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!isRecord(event)) continue
      const type = typeof event.type === 'string' ? event.type : ''
      const at = typeof event.time === 'number' && event.time > 0 ? event.time : undefined
      if (at !== undefined) out.lastEventAt = at

      if (type === 'metadata') {
        const created = num(event.created_at)
        if (created > 0) out.createdAt = created
        continue
      }
      if (type === 'config.update') {
        if (!out.cwd && typeof event.cwd === 'string' && event.cwd) out.cwd = event.cwd
        if (typeof event.modelAlias === 'string' && event.modelAlias) out.model = event.modelAlias
        continue
      }
      if (type === 'usage.record') {
        const usage = isRecord(event.usage) ? event.usage : undefined
        if (!usage) continue
        const input = num(usage.inputOther)
        const output = num(usage.output)
        const cacheRead = num(usage.inputCacheRead)
        const cacheWrite = num(usage.inputCacheCreation)
        const model = typeof event.model === 'string' ? event.model : ''
        // fork / 续写会把同一批记录原样复制：按 (agent,time,model,usage) 去重（magpie kimiCallKey 同口径）
        const key = `${agent}|${at ?? 0}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}`
        if (out.usageKeys.has(key)) continue
        out.usageKeys.add(key)
        out.tokens.input += input
        out.tokens.output += output
        out.tokens.cacheRead += cacheRead
        out.tokens.cacheWrite += cacheWrite
        if (!out.model && model) out.model = model
        continue
      }
      if (type === 'turn.prompt' || type === 'turn.steer') {
        // origin.kind !== 'user' 是技能激活 / background_task 通知，不是用户说的话
        const origin = isRecord(event.origin) ? event.origin : undefined
        const kind = origin && typeof origin.kind === 'string' ? origin.kind : undefined
        if (kind !== undefined && kind !== 'user') continue
        if (kind === undefined && type === 'turn.steer') continue // 没有 origin 的 steer 不猜
        const text = textOfBlocks(event.input)
        if (!text) continue
        if (out.firstUserText === undefined) {
          out.firstUserText = text
          out.firstUserAt = at
          // 列表只需要首条用户消息：提前结束，别把 10MB wire 全读完
          if (opts.stopAfterFirstUser) {
            stream.destroy()
            break
          }
        }
        out.lastUserText = text
        out.lastUserAt = at
        continue
      }
      if (type === 'context.append_message') {
        // 带 time 的与 prompt/loop 事件重复（Kimi Code 自己写的）；不带 time 的是导入的旧历史
        if (typeof event.time === 'number') continue
        const message = isRecord(event.message) ? event.message : undefined
        if (!message || message.role !== 'user') continue
        const text = textOfBlocks(message.content)
        if (!text) continue
        if (out.firstUserText === undefined) {
          out.firstUserText = text
          if (opts.stopAfterFirstUser) {
            stream.destroy()
            break
          }
        }
        out.lastUserText = text
      }
    }
  } finally {
    stream.destroy()
  }
  return out
}

/**
 * 标题压行规则统一用 core 版（滤 `#` /```` ``` ````/`<…>` 开头行）。
 * 旧本地实现多筛了 ``` 但少筛 `<`，三份拷贝规则正在漂移。
 */
export { toSessionTitle } from '@tick/ai-core'
