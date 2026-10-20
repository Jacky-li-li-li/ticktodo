/**
 * paths — Codex 的 rollout 文件定位与逐行读取（只读；不缓存正文）。
 *
 * 格式事实（magpie `internal/sessions/codex.go` + 本机实测 151 个 rollout / 147 个 thread，2026-10-20）：
 *
 *   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DDTHH-mm-ss>-<threadId>[_<segment>].jsonl[.zst]`
 *   `~/.codex/archived_sessions/rollout-…jsonl`
 *
 *   - **threadId 在文件名里**，所以列会话不需要读文件；`_<segment>` 后缀表示同一个 thread
 *     恢复后又写了一个文件（一个会话 = 多个文件）。
 *   - 首行 `{"type":"session_meta","payload":{session_id|id, cwd, originator, cli_version, source, model_provider, timestamp}}`
 *     —— 只读首行就能拿到 cwd / 会话起点（`withName:false`、resume、discoverProjects 都用这条快路径）。
 *   - 每轮 `{"type":"turn_context","payload":{model, cwd, …}}`
 *   - 用量 `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{…},"last_token_usage":{…}}}}`
 *     —— `total_token_usage` 是**累计值**，`input_tokens` **已包含** `cached_input_tokens`
 *     （`cache_write_input_tokens` 亦然），所以计入 Tick 的 `input` 前必须扣掉这两项。
 *   - 用户消息 `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":…}]}}`；
 *     助手消息同结构但 `role:"assistant"` / `output_text`。
 *     首条 user 常是 `<environment_context>` 之类的注入上下文，必须过滤。
 *   - `.zst` 是 Codex 归档时压的整文件 zstd（Node ≥22.15 自带 `zlib.zstdDecompressSync`）。
 */

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { zstdDecompressSync } from 'node:zlib'
import { isRecord, num, realUserText, toSessionTitle } from '@tick/ai-core'

export { toSessionTitle }

/** Codex 的 home：`CODEX_HOME` > `~/.codex`（magpie `appdir.CodexHome` 同口径） */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.CODEX_HOME?.trim()
  return override ? path.resolve(override) : path.join(home, '.codex')
}

/**
 * rollout 文件名：`rollout-2026-03-29T19-05-22-019d3945-…-6e79b2166942[_seg].jsonl[.zst]`。
 * Captures: 1 = threadId，2 = 可选 segment。
 */
const ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9A-Za-z-]+?)(?:_[0-9A-Za-z-]+)?\.jsonl(?:\.zst)?$/

export interface RolloutFile {
  filePath: string
  /** 文件名里的 thread id（= 会话 id） */
  threadId: string
  compressed: boolean
  size: number
  mtimeMs: number
  /** true = `archived_sessions/` 里的（用户已在 Codex 里归档） */
  archived: boolean
}

/** 递归收集 rollout 文件（两层固定目录：sessions/ 按年月日分目录，archived_sessions/ 平铺） */
export function collectRollouts(
  codexHome = resolveCodexHome(),
  opts: { maxFiles?: number } = {},
): RolloutFile[] {
  const maxFiles = opts.maxFiles ?? 5000
  const out: RolloutFile[] = []
  const push = (filePath: string, archived: boolean): void => {
    const hit = ROLLOUT_RE.exec(path.basename(filePath))
    if (!hit) return
    let st
    try {
      st = statSync(filePath)
    } catch {
      return
    }
    if (!st.isFile() || st.size === 0) return
    out.push({
      filePath,
      threadId: hit[1] as string,
      compressed: filePath.endsWith('.zst'),
      size: st.size,
      mtimeMs: st.mtimeMs,
      archived,
    })
  }

  const walk = (dir: string, depth: number, archived: boolean): void => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = path.join(dir, name)
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        // sessions/<YYYY>/<MM>/<DD>/，最多再往里 3 层；archived_sessions 平铺
        if (depth < 3) walk(p, depth + 1, archived)
        continue
      }
      push(p, archived)
    }
  }
  walk(path.join(codexHome, 'sessions'), 0, false)
  walk(path.join(codexHome, 'archived_sessions'), 0, true)

  // readdirSync 的顺序不保证：**先收全再按 mtime 取最近的 N 个**。
  // 旧实现按目录顺序一旦达到上限就 return，超上限时被丢的是任意文件（可能丢同一 thread 的最新
  // rollout，导致 filePath 指向旧文件、files 不全），且没有任何日志。
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (out.length > maxFiles) {
    // 只报数量（不含路径/正文），让「列表少了会话」这件事至少可解释；进程级只报一次，避免每 5s 刷屏
    if (!truncationWarned) {
      truncationWarned = true
      console.warn(`[codex] rollout 文件 ${out.length} 个，超过上限 ${maxFiles}；按 mtime 保留最近 ${maxFiles} 个`)
    }
    return out.slice(0, maxFiles)
  }
  return out
}

/** 截断告警只打一次（threads() 每 5s 会重扫，重复告警等于噪音） */
let truncationWarned = false

/** 一个 thread 的会话（可能多个 rollout 文件，按时间升序） */
export interface CodexThread {
  threadId: string
  files: RolloutFile[]
  /** 最新文件（`filePath` 指向它，用于导出/定位） */
  latest: RolloutFile
  /** true = 用户已在 Codex 里归档（最新那个文件在 archived_sessions/）→ 不宜从 Tick 回到会话 */
  archived: boolean
}

/** 按 thread id 归并（同一 thread 恢复后写到新 rollout 文件 = 一个会话） */
export function groupThreads(rollouts: RolloutFile[]): CodexThread[] {
  const byId = new Map<string, RolloutFile[]>()
  for (const file of rollouts) {
    const list = byId.get(file.threadId)
    if (list) list.push(file)
    else byId.set(file.threadId, [file])
  }
  const out: CodexThread[] = []
  for (const [threadId, files] of byId) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath))
    const latest = files[files.length - 1]
    if (latest) out.push({ threadId, files, latest, archived: latest.archived })
  }
  out.sort((a, b) => b.latest.mtimeMs - a.latest.mtimeMs)
  return out
}

/** 会话元数据（流式扫描产出；不含正文） */
export interface CodexMeta {
  sessionId?: string
  cwd?: string
  /** `model_provider`（openai / oss / 自定义网关…）：用量按它标 provider，不能一律当 openai */
  modelProvider?: string
  /** 最近一轮的模型（`turn_context.payload.model`） */
  model?: string
  /** 首条 / 最后一条**真实** user 文本（`<environment_context>` / AGENTS.md 注入已过滤） */
  firstUserText?: string
  lastUserText?: string
  firstUserAt?: number
  lastEventAt?: number
  /** 累计 token（已把 cache 从 input 里扣掉，见 usage.ts） */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** `token_count` 里的一个 usage 对象 → 已扣除 cache 的四项 */
export function tokensOf(raw: Record<string, unknown>): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
} {
  const cacheRead = num(raw.cached_input_tokens)
  const cacheWrite = num(raw.cache_write_input_tokens)
  // Codex 的 input_tokens 是「整个 prompt」，cache 读/写都在里面 → 扣掉，避免重复计
  const input = Math.max(0, num(raw.input_tokens) - cacheRead - cacheWrite)
  return { input, output: num(raw.output_tokens), cacheRead, cacheWrite }
}

/**
 * 一条 user 文本是否是「用户真的说的」（是则返回正文）。
 *
 * Codex 会把自己的环境说明当 `role=user` 写进 rollout，且**不止 `<…>` 一种形态**：
 * 还有 `# AGENTS.md instructions for <cwd>\n\n<INSTRUCTIONS>…`（本机 151 个 rollout 里 60 个）。
 * 判据收拢到 core 的 `realUserText`（与 claude/pi 的注入过滤同一份，避免再漂移）。
 */
export function userTextOf(payload: Record<string, unknown>): string | undefined {
  if (payload.role !== 'user') return undefined
  const content = payload.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => b.type === 'input_text' || b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
  return realUserText(text)
}

/**
 * 只读每个 rollout 的 `session_meta`（正常就是首行；最多看前 8 行，兼容个别前置记录）。
 *
 * 为什么需要：`describeSession({withName:false})` / `resume` / `discoverProjects` 只要 cwd 与
 * 会话起点，旧实现走 `readRolloutMeta` 会把整份正文（本机最大单文件 10MB）逐行 JSON.parse，
 * 随会话体积线性退化。规则 §2 也明确要求 `withName:false` 时不得扫全文。
 */
export interface RolloutHeader {
  sessionId?: string
  cwd?: string
  /** `session_meta` 自己的 timestamp（毫秒）——会话真正的起点（文件 mtime 只是最后一次写） */
  createdAt?: number
  /** `model_provider`（openai / oss / 自定义网关…），用量按它标 provider */
  modelProvider?: string
}

const HEADER_SCAN_LINES = 8

export async function readRolloutHeader(file: RolloutFile): Promise<RolloutHeader> {
  const header: RolloutHeader = {}
  let seen = 0
  await forEachRolloutLine(file, (line) => {
    if (!line) return false
    seen += 1
    if (line.includes('"session_meta"')) {
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        event = undefined
      }
      if (isRecord(event) && event.type === 'session_meta' && isRecord(event.payload)) {
        const payload = event.payload
        const id = typeof payload.session_id === 'string' ? payload.session_id : payload.id
        if (typeof id === 'string' && id) header.sessionId = id
        if (typeof payload.cwd === 'string' && payload.cwd) header.cwd = payload.cwd
        if (typeof payload.model_provider === 'string' && payload.model_provider) {
          header.modelProvider = payload.model_provider
        }
        const at = typeof payload.timestamp === 'string' ? Date.parse(payload.timestamp) : undefined
        if (at === undefined || Number.isNaN(at)) {
          // 个别版本把 timestamp 放在外层事件上
          const outer = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : undefined
          if (outer !== undefined && !Number.isNaN(outer)) header.createdAt = outer
        } else {
          header.createdAt = at
        }
        return true // 拿到 session_meta 就停：不读正文
      }
    }
    return seen >= HEADER_SCAN_LINES
  })
  return header
}

/**
 * 逐行读 rollout（`.zst` 先整份解压再按行切；普通文件真流式）。
 * `onLine` 返回 true = 提前停（readRolloutHeader 找到 session_meta 就停）。
 */
async function forEachRolloutLine(
  file: RolloutFile,
  onLine: (line: string) => boolean | void,
): Promise<void> {
  if (file.compressed) {
    // 归档压缩文件：整份解压后按行解析。**这是未验证分支**（本机 0 个 .zst 样本），
    // 所以上限按「单个会话正文」的量级取 32MB：超过就放弃解析（只留 id/文件名，列表仍可用），
    // 避免菜单栏常驻进程被一次解压打爆内存（旧上限 512MB 无法解释）。
    const MAX_ZST_BYTES = 32 * 1024 * 1024
    if (file.size > MAX_ZST_BYTES) return
    let text: string
    try {
      text = zstdDecompressSync(await readFileBytes(file.filePath), { maxOutputLength: MAX_ZST_BYTES }).toString('utf8')
    } catch {
      return
    }
    for (const line of text.split('\n')) {
      if (onLine(line) === true) return
    }
    return
  }
  const stream = createReadStream(file.filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (onLine(line) === true) break
    }
  } finally {
    stream.destroy()
  }
}

/**
 * 读一个 rollout 文件：session_meta / turn_context / token_count / 用户文本。
 *
 * 用量口径（as-built，见 usage.ts 的注释）：
 *  单文件用量 = 最后一次 `total_token_usage` − 基线，
 *  基线 = 第一次 `total_token_usage` − 第一次 `last_token_usage`
 *   （这样「计数器按 thread 累计」与「每个文件从 0 重新累计」两种情况都对）。
 */
export async function readRolloutMeta(file: RolloutFile): Promise<CodexMeta> {
  const meta: CodexMeta = {}
  let firstTotal: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  let firstLast: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
  let lastTotal: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined

  const consume = (line: string): void => {
    if (!line) return
    // 只解析这几类；其余（function_call / reasoning / …）跳过。
    // 注意：旧实现还放行了「含 "timestamp" 的行」，而 codex 每条记录都带 timestamp
    // → 等于整份文件全部 JSON.parse（实测 78k 行 vs 需要的 19k 行），这个快路径本来是假的。
    // `"text"` 是必须的：user 消息的 content 块有 `input_text` 与 `text` 两种形态
    // （`[{type:'text',text:…}]`），只放行 `input_text` 会把这些真实提问整条跳过。
    if (
      !line.includes('"session_meta"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"token_count"') &&
      !line.includes('"input_text"') &&
      !line.includes('"text"')
    ) {
      return
    }
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(event)) return
    const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : undefined
    if (at !== undefined && !Number.isNaN(at)) meta.lastEventAt = at
    const payload = isRecord(event.payload) ? event.payload : undefined
    if (!payload) return

    if (event.type === 'session_meta') {
      const id = typeof payload.session_id === 'string' ? payload.session_id : payload.id
      if (meta.sessionId === undefined && typeof id === 'string' && id) meta.sessionId = id
      if (meta.cwd === undefined && typeof payload.cwd === 'string' && payload.cwd) meta.cwd = payload.cwd
      if (meta.modelProvider === undefined && typeof payload.model_provider === 'string' && payload.model_provider) {
        meta.modelProvider = payload.model_provider
      }
      return
    }
    if (event.type === 'turn_context') {
      if (typeof payload.model === 'string' && payload.model) meta.model = payload.model
      if (meta.cwd === undefined && typeof payload.cwd === 'string' && payload.cwd) meta.cwd = payload.cwd
      return
    }
    if (event.type === 'event_msg' && payload.type === 'token_count') {
      const info = isRecord(payload.info) ? payload.info : undefined
      if (!info) return
      const total = isRecord(info.total_token_usage) ? tokensOf(info.total_token_usage) : undefined
      const last = isRecord(info.last_token_usage) ? tokensOf(info.last_token_usage) : undefined
      if (total) {
        firstTotal ??= total
        if (last) firstLast ??= last
        lastTotal = total
      }
      return
    }
    if (event.type === 'response_item' && payload.type === 'message') {
      const text = userTextOf(payload)
      if (!text) return
      if (meta.firstUserText === undefined) {
        meta.firstUserText = text
        if (at !== undefined && !Number.isNaN(at)) meta.firstUserAt = at
      }
      meta.lastUserText = text
    }
  }

  await forEachRolloutLine(file, (line) => {
    consume(line)
    return false
  })
  // 只解析四类行后，最后一条被解析的记录可能不是文件最后一行；用文件 mtime 兜底
  // （列表排序只需要一个单调的「最近使用」时钟，不需要精确到事件）。
  meta.lastEventAt ??= file.mtimeMs

  if (lastTotal) {
    // 基线：第一次 total − 第一次 last（计数器按 thread 累计时，这个差就是「本次文件之前已用的量」）
    const baseline = {
      input: Math.max(0, (firstTotal?.input ?? 0) - (firstLast?.input ?? 0)),
      output: Math.max(0, (firstTotal?.output ?? 0) - (firstLast?.output ?? 0)),
      cacheRead: Math.max(0, (firstTotal?.cacheRead ?? 0) - (firstLast?.cacheRead ?? 0)),
      cacheWrite: Math.max(0, (firstTotal?.cacheWrite ?? 0) - (firstLast?.cacheWrite ?? 0)),
    }
    meta.usage = {
      input: Math.max(0, lastTotal.input - baseline.input),
      output: Math.max(0, lastTotal.output - baseline.output),
      cacheRead: Math.max(0, lastTotal.cacheRead - baseline.cacheRead),
      cacheWrite: Math.max(0, lastTotal.cacheWrite - baseline.cacheWrite),
    }
  }
  return meta
}

async function readFileBytes(file: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return readFile(file)
}
