/**
 * transcript — WorkBuddy 会话消息流（`projects/<编码 cwd>/<id>.jsonl`）的流式解析。
 *
 * 格式事实（docs/workbuddy-adapter-notes.md §3 / §4 / §10.8 / §10.11）：
 *   - 一行一个事件；`type` ∈ session-meta / message / function_call / function_call_result /
 *     reasoning / file-history-snapshot / ai-title / custom-title …（未知 type 一律忽略）；
 *   - 消息：`type="message"`、`role` ∈ user/assistant、`content[]` = `{type:"input_text"|"text", text}`；
 *   - 真实用户请求：`providerData.startsNewUserRequest === true`；合成消息用
 *     `providerData.isMeta === true`（后台任务通知）与 `providerData.isCompacted === true`
 *     （上下文压缩摘要，可能自带 `<user_query>` 片段，必须按 isCompacted 过滤）；
 *   - 用户原文被包装在 `<system-reminder data-role="…">` 里，内层平铺多个标签，最后是
 *     `<user_query>用户原文</user_query>` → 抽取 `<user_query>` 之间的内容（非贪婪、DOTALL，
 *     标签**带属性**，不能用无属性字面量匹配）；没有该标签时剥离外层
 *     `<system-reminder[^>]*>…</system-reminder>` 再取剩余；
 *   - 时间戳单位是**毫秒**（实测 message.timestamp 为 number）。
 *
 * 读取纪律：只按行流式扫描、只保留首/末 user 文本与标题（不缓存正文）；
 * 容忍末行半行与坏行；`*.ndjson`、`<id>/subagents/**`、`file-rollback` 不是主消息流（调用方不传）。
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { WorkbuddyTranscriptMeta } from './types'

/** `<user_query …>` 抽取（标签可能带属性；内层文本可能跨行 → DOTALL + 非贪婪） */
const USER_QUERY_RE = /<user_query[^>]*>([\s\S]*?)<\/user_query>/i
/** 是否有 `<user_query>` 开标签（用于无 startsNewUserRequest 字段时的回退判定） */
const USER_QUERY_OPEN_RE = /<user_query[\s>]/i
/** 外层包装剥离（实测标签带 `data-role` 等属性，必须容忍属性） */
const SYSTEM_REMINDER_RE = /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi

/**
 * 流式读会话元数据：首条/最后一条 user 消息 + 标题兜底。
 * 只有 `type=message && role=user` 的行会走到文本抽取；其余行解析后立即丢弃。
 */
export async function readTranscriptMeta(file: string): Promise<WorkbuddyTranscriptMeta> {
  const meta: WorkbuddyTranscriptMeta = {}
  let aiTitle: string | undefined
  let customTitle: string | undefined

  /**
   * PRD §9.2 的「优先 `startsNewUserRequest`」必须真的分两级，而不是先到先得：
   * 同一份 jsonl 里可能既有强候选（真实请求）又有弱候选（字段缺失的旧消息/注入上下文）。
   * 只要有强候选，首/末都只从强候选里取；一个都没有才退回弱候选。
   */
  interface Candidate {
    text: string
    at?: number
  }
  let firstStrong: Candidate | undefined
  let lastStrong: Candidate | undefined
  let firstWeak: Candidate | undefined
  let lastWeak: Candidate | undefined

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // 快速跳过绝大多数无关行：只有这几类事件参与元数据
      if (
        !line.includes('"message"') &&
        !line.includes('"ai-title"') &&
        !line.includes('"custom-title"')
      ) {
        continue
      }
      const event = parseJsonLine(line)
      if (!event) continue
      const type = event.type
      if (type === 'message') {
        const at = eventTime(event)
        if (at !== undefined) meta.lastEventAt = at
        if (event.role === 'assistant') {
          meta.lastEventKind = 'assistant'
          if (typeof event.status === 'string') meta.lastAssistantStatus = event.status
          continue
        }
        const user = readUserMessageText(event)
        if (!user) continue
        meta.lastEventKind = 'user'
        const candidate: Candidate = { text: user.text, at }
        if (user.strong) {
          firstStrong ??= candidate
          lastStrong = candidate
        } else {
          firstWeak ??= candidate
          lastWeak = candidate
        }
        continue
      }
      if (type === 'custom-title') {
        customTitle = titleField(event) ?? customTitle
      } else if (type === 'ai-title') {
        aiTitle = titleField(event) ?? aiTitle
      }
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  const first = firstStrong ?? firstWeak
  const last = lastStrong ?? lastWeak
  if (first) {
    meta.firstUserText = first.text
    meta.firstUserAt = first.at
  }
  if (last) {
    meta.lastUserText = last.text
    meta.lastUserAt = last.at
  }

  const title = customTitle ?? aiTitle
  if (title) meta.title = title
  return meta
}

/**
 * 判断一行 message 是否是「真实用户请求」并抽出原文。
 * 过滤规则（PRD §9.2 / §9B.2，首条与最后一条共用同一套）：
 *   role=user 且非 isMeta 且非 isCompacted；
 *   `startsNewUserRequest===true` → 强候选；
 *   字段显式 false → 不是新的用户请求（续写/注入），直接排除；
 *   字段缺失（实测国内版 6/73 条 role=user 没有该字段）→ 只认带 `<user_query>` 的弱候选。
 */
function readUserMessageText(
  event: Record<string, unknown>,
): { text: string; strong: boolean } | undefined {
  if (event.role !== 'user') return undefined
  const provider = isRecord(event.providerData) ? event.providerData : undefined
  if (provider?.isMeta === true || provider?.isCompacted === true) return undefined

  const rawText = contentText(event.content)
  if (!rawText) return undefined

  const flag = provider?.startsNewUserRequest
  if (flag === false) return undefined

  const text = extractUserText(rawText)
  if (!text) return undefined
  if (flag === true) return { text, strong: true }
  // 字段缺失：只认带 <user_query> 的（同文件出现强候选时强候选优先，见 readTranscriptMeta）
  if (!USER_QUERY_OPEN_RE.test(rawText)) return undefined
  return { text, strong: false }
}

/** 抽取用户原文：优先 `<user_query>` 内文本；否则剥离 `<system-reminder>` 外层包装 */
export function extractUserText(raw: string): string | undefined {
  const match = USER_QUERY_RE.exec(raw)
  const body = match ? match[1] : raw.replace(SYSTEM_REMINDER_RE, '')
  return collapseText(body)
}

/** 空白折叠（多行/多空格压成一行；证据展示规则，不改写文字内容） */
export function collapseText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 0 ? collapsed : undefined
}

/** 截断（超长才截，末尾加省略号，避免把「截过」伪装成原文） */
export function clipText(text: string | undefined, max: number): string | undefined {
  if (!text || text.length === 0) return undefined
  if (max <= 0) return undefined
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** content[] 里 user 侧文本块拼接（实测 user 用 input_text；容错 text） */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'input_text' && block.type !== 'text') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 标题事件取值：实测 `aiTitle`；custom-title 可能是 `customTitle`/`title`，容错三者 */
function titleField(event: Record<string, unknown>): string | undefined {
  for (const key of ['customTitle', 'aiTitle', 'title'] as const) {
    const value = event[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 事件时间：message.timestamp 是毫秒数；其它形态（ISO 字符串）兜底解析，非法返回 undefined */
function eventTime(event: Record<string, unknown>): number | undefined {
  const raw = event.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined // 末行半行/坏行：忽略
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
