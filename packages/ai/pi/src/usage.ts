/**
 * usage — 单会话用量（F6-b / M3，默认关）。
 *
 * 口径严格照 `scripts/session-usage.mjs`（已对 103 个本机会话自洽校验通过）：
 *   - 五个来源：assistant 消息 / toolResult 消息 / type:"usage" / compaction / branch_summary
 *   - reasoning 已含在 output、cacheWrite1h 是 cacheWrite 子集 → 不重复加
 *   - fork 会话前 N 条是继承段（含 usage）→ 求和时跳过（不是去重，是记账口径）
 *   - 有 token 却 cost=0 的 provider → costReported=false，UI 只能当下限
 *
 * 约束（TECH-ARCH §6.3）：只取 usage / provider / model / role / toolName / timestamp，
 * content 一律丢弃；不常驻扫描，只在用户打开详情且开关打开时算。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { CostUsage, SessionUsage, TokenUsage } from '@tick/ai-core'

interface MutableUsage extends TokenUsage {
  cost: CostUsage
  cacheWrite1h?: number
  reasoning?: number
}

interface BucketState {
  models: Record<string, MutableUsage>
  tools: Record<string, MutableUsage>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const emptyUsage = (): MutableUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
})

const emptyState = (): BucketState => ({ models: {}, tools: {} })

function addUsage(total: MutableUsage, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return
  const u = usage as Record<string, unknown>
  total.input += num(u.input)
  total.output += num(u.output)
  total.cacheRead += num(u.cacheRead)
  total.cacheWrite += num(u.cacheWrite)
  total.totalTokens += num(u.totalTokens)
  if (u.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + num(u.cacheWrite1h)
  if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + num(u.reasoning)
  const cost = (u.cost ?? {}) as Record<string, unknown>
  total.cost.input += num(cost.input)
  total.cost.output += num(cost.output)
  total.cost.cacheRead += num(cost.cacheRead)
  total.cost.cacheWrite += num(cost.cacheWrite)
  total.cost.total += num(cost.total)
}

function bucket(state: BucketState, name: keyof BucketState, key: string, usage: unknown): void {
  const totals = state[name]
  if (!Object.prototype.hasOwnProperty.call(totals, key)) {
    Object.defineProperty(totals, key, { value: emptyUsage(), enumerable: true, writable: true })
  }
  addUsage(totals[key] as MutableUsage, usage)
}

function countNonHeaderEntries(file: string): number {
  let n = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const o = JSON.parse(line) as { type?: string }
      if (o.type !== 'session') n++
    } catch {
      /* 坏行忽略 */
    }
  }
  return n
}

/**
 * 算一个会话文件的用量。
 * @param inheritedEntries fork 继承段条数（调用方用源文件条目数 - 1 得到）
 */
export function computeUsageFromFile(file: string, inheritedEntries = 0): SessionUsage | undefined {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return undefined
  }
  if (stat.size === 0) return undefined
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  const state = emptyState()
  let entries = 0
  let skipped = 0
  let messageCount = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = o.type
    if (type !== 'session') entries++
    if (inheritedEntries > 0 && type !== 'session' && entries <= inheritedEntries) {
      skipped++
      continue
    }

    switch (type) {
      case 'message': {
        const m = (o.message ?? {}) as Record<string, unknown>
        if (!m.usage || typeof m.usage !== 'object') break
        if (m.role === 'assistant') {
          bucket(state, 'models', `${String(m.provider ?? '?')}/${String(m.model ?? '?')}`, m.usage)
          messageCount++
        } else if (m.role === 'toolResult') {
          bucket(state, 'tools', String(m.toolName ?? '?'), m.usage)
        }
        break
      }
      case 'usage':
        if (o.usage) {
          bucket(state, 'models', `${String(o.provider ?? '?')}/${String(o.model ?? '?')}`, o.usage)
        }
        break
      case 'compaction':
        if (o.usage) bucket(state, 'models', 'compaction/summary', o.usage)
        break
      case 'branch_summary':
        if (o.usage) bucket(state, 'models', 'compaction/branch-summary', o.usage)
        break
      default:
        break
    }
  }

  const total = emptyUsage()
  const byModel: SessionUsage['byModel'] = []
  for (const [key, usage] of Object.entries(state.models)) {
    addUsage(total, usage)
    const [provider, ...rest] = key.split('/')
    byModel.push({
      provider: provider ?? '?',
      model: rest.join('/') || '?',
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
      },
      cost: usage.cost,
    })
  }
  for (const usage of Object.values(state.tools)) addUsage(total, usage)

  const costReported = byModel.every((m) => !(m.tokens.totalTokens > 0 && m.cost.total === 0))

  return {
    tokens: {
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      totalTokens: total.totalTokens,
    },
    cost: total.cost,
    byModel,
    messageCount,
    computedAt: Date.now(),
    costReported,
  }
}

/** 从文件 header 的 parentSession 推算继承段条数（源文件不在本机 → 0）。
 *  口径 = 源文件**非 header 条目数**（与 scripts/session-usage.mjs 的「行数 - 1」在完好文件上等价，
 *  但对坏行更稳：坏行既不算继承条目，也不算本文件的条目） */
export function inheritedEntriesOf(parentSessionPath: string | undefined): number {
  if (!parentSessionPath || !existsSync(parentSessionPath)) return 0
  try {
    return Math.max(0, countNonHeaderEntries(parentSessionPath))
  } catch {
    return 0
  }
}
