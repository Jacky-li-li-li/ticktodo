/**
 * usage — Claude Code 单会话用量（F6-b，默认关，只在用户打开详情且设置开启时算）。
 *
 * 口径（2026-10-19 本机实测 2.1.302，44a09b90 会话 4.4MB / 285 条 assistant）：
 *
 *  1. **同一条 assistant 消息会写多行**（`apiBlockIndex` 分块 + 续写），285 行只有 109 个
 *     不同的 `message.id`；逐行相加会把 token 放大 ~2.6 倍。所以按 `message.id` 去重。
 *     **后出现的版本是修订版**：Claude Code 在消息继续生成时会重写这一行的 usage，
 *     所以「同一 id 取最后一条」而不是第一条（本机 4.4MB 样本里 285 行的 usage 完全一致，
 *     看不出差别；但流式续写的消息会变——口径与 magpie 的 `claudeContribution.accept()`
 *     一致：同一 id 以最新 revision 为准）。
 *  2. `message.model === "<synthetic>"` 的行是 Claude Code 自己合成的（无模型调用），
 *     即使带 usage 也不能计入。
 *  2. 字段映射（Anthropic 原始 usage）：
 *       input_tokens              → input
 *       output_tokens             → output
 *       cache_read_input_tokens   → cacheRead
 *       cache_creation_input_tokens → cacheWrite
 *     `output_tokens_details.thinking_tokens` 已含在 output 里，不重复加。
 *  3. **成本以 `cost-state` 快照为准**：Claude Code 每轮结束写一行累计快照
 *     （`totalCostUSD` + 每模型 `modelUsage`），取最后一条。快照缺失时成本报 0 并
 *     `costReported=false`（UI 只能显示「未上报」，不许把 0 当成真的免费）。
 *     快照里 `hasUnknownModelCost=true` 说明至少一个模型价格未知 → 同样置 false。
 *  4. fork / 续写：Claude Code 的 fork 是**新文件**（`--fork-session`），不会把父会话正文
 *     复制进新文件，所以这里不需要 pi 那样的「继承段跳过」；但同一 sessionId 可能有
 *     `.orphaned-*` 旧稿（不在主文件里），不参与统计。
 *
 * 读取纪律：只取 usage / model / type / timestamp，content 一律丢弃；结果按
 * (mtime, size) 缓存在 adapter 里，文件不变不重算。
 */

import { createReadStream, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { CostUsage, SessionUsage, TokenUsage } from '@tick/ai-core'

interface MutableModel {
  provider: string
  model: string
  tokens: TokenUsage
  cost: CostUsage
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const emptyTokens = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
})

const emptyCost = (): CostUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

/** Claude Code 自己合成的消息（无真实模型调用），带 usage 也不能计入 */
const SYNTHETIC_MODEL = '<synthetic>'

/** 把一个模型的用量加进桶里（桶键用模型名，不带 provider 前缀） */
function addToBucket(byModel: Map<string, MutableModel>, model: string, tokens: TokenUsage): void {
  // 桶键用**模型名**：`cost-state` 快照的键形如 `deepseek/deepseek-flash[1m]`，
  // 而逐行记录的 `message.model` 只有 `deepseek-flash`；带前缀作键会让同一个模型被算两次。
  let bucket = byModel.get(model)
  if (!bucket) {
    bucket = { provider: 'anthropic', model, tokens: emptyTokens(), cost: emptyCost() }
    byModel.set(model, bucket)
  }
  bucket.tokens.input += tokens.input
  bucket.tokens.output += tokens.output
  bucket.tokens.cacheRead += tokens.cacheRead
  bucket.tokens.cacheWrite += tokens.cacheWrite
  bucket.tokens.totalTokens += tokens.totalTokens
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 `provider/model` 形式的键里拆 provider（Claude Code 的 modelUsage 键形如 `deepseek/deepseek-flash[1m]`） */
function splitModelKey(key: string): { provider: string; model: string } {
  const slash = key.indexOf('/')
  if (slash <= 0) return { provider: 'anthropic', model: key }
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) }
}

/**
 * 扫一份会话文件算用量。
 * 返回值缺失（undefined）= 文件里没有任何 assistant 消息（空会话/只有命令输出）。
 */
export async function computeUsageFromFile(file: string): Promise<SessionUsage | undefined> {
  let size: number
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  if (size === 0) return undefined

  /**
   * message.id → 该消息当前采用的 usage（同一 id 多行 = 同一条消息的多个 block / 修订）。
   * 用 Map 而不是 Set，是为了让后出现的修订能覆盖前一条（见文件头口径 1）。
   */
  const perMessage = new Map<string, { model: string; tokens: TokenUsage }>()
  /** 逐行口径的模型桶（没有 cost-state 快照时用它；有快照则以快照为准） */
  const byModel = new Map<string, MutableModel>()
  /**
   * 消息数口径 = **按 `message.id` 去重的 assistant 消息数**（计费用的消息）。
   * 旧实现把 user 记录也数进去（含 `/model` 等本地命令噪声、isMeta 注入、压缩摘要），
   * 真实 4.4MB 样本会偏大 2–3 倍；UI 侧还没有消费者，但现在口径自洽。
   */
  let messageCount = 0
  let assistantCount = 0

  /** 最后一条 cost-state 快照（累计值，直接覆盖而不是相加） */
  let costState:
    | { totalCostUSD: number; modelUsage: Record<string, Record<string, unknown>>; unknownCost: boolean }
    | undefined

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      // 快速跳过噪声行。role 判据要同时认紧凑与带空格两种写法：paths.ts 的元数据读取
      // 已经兼容两者，这里不能漂移（否则第三方包装写出的带空格 jsonl 会被整行跳过、
      // 用量静默算成 0）。
      if (
        !line.includes('"usage"') &&
        !line.includes('"cost-state"') &&
        !line.includes('"role":"assistant"') &&
        !line.includes('"role": "assistant"') &&
        !line.includes('"role":"user"') &&
        !line.includes('"role": "user"')
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

      if (event.type === 'cost-state') {
        const total = num(event.totalCostUSD)
        const modelUsage = isRecord(event.modelUsage) ? event.modelUsage : {}
        costState = {
          totalCostUSD: total,
          modelUsage: modelUsage as Record<string, Record<string, unknown>>,
          unknownCost: event.hasUnknownModelCost === true,
        }
        continue
      }

      const message = event.message
      if (!isRecord(message)) continue
      if (message.role !== 'assistant') continue

      const modelName = typeof message.model === 'string' && message.model ? message.model : 'unknown'
      // 合成消息：Claude Code 自己写的（无真实模型调用），带 usage 也不算
      if (modelName === SYNTHETIC_MODEL) continue
      assistantCount += 1

      const usage = isRecord(message.usage) ? message.usage : undefined
      if (!usage) continue
      const tokens: TokenUsage = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        totalTokens: 0,
      }
      tokens.totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite

      const id = typeof message.id === 'string' ? message.id : undefined
      if (id === undefined) {
        // 没有 id 的行（旧格式/异常行）无法去重，只能按出现次数直接累计
        messageCount += 1
        addToBucket(byModel, modelName, tokens)
        continue
      }
      // 同一 id 后出现的版本覆盖前一条（修订版），而不是累加。
      // 但如果这一行是「零用量」的尾块（Qoder 类工具只在某一行的 usage 里报数），
      // 不能把已经记下的非零用量抹成 0。
      const prev = perMessage.get(id)
      if (prev && tokens.totalTokens === 0 && prev.tokens.totalTokens > 0) continue
      perMessage.set(id, { model: modelName, tokens })
    }
  } finally {
    stream.destroy()
  }

  if (assistantCount === 0 && !costState) return undefined

  // 逐行口径：同一 message.id 只取最后一个版本
  messageCount += perMessage.size
  for (const { model, tokens } of perMessage.values()) addToBucket(byModel, model, tokens)

  /**
   * 两套口径二选一，**不混用**：
   *  - 有 `cost-state` 快照（绝大多数会话）：token 与成本都取快照——它是 Claude Code 自己的
   *    累计记账（含 compaction 前已丢弃的段，且键带 `[1m]` 之类的窗口后缀），比逐行重算更准；
   *  - 没有快照（会话刚开 / 被中断）：退回逐行按 message.id 去重的结果，成本报 0 且
   *    `costReported=false`（UI 只能显示「未上报」）。
   */
  const cost = emptyCost()
  let costReported = false
  let models: MutableModel[]
  if (costState) {
    cost.total = costState.totalCostUSD
    // 有未知价格模型 → 只能当下限；全部为 0 而确实有 token 也同理
    costReported = !costState.unknownCost && costState.totalCostUSD > 0
    models = []
    for (const [key, value] of Object.entries(costState.modelUsage)) {
      if (!isRecord(value)) continue
      const { provider, model } = splitModelKey(key)
      const tokens: TokenUsage = {
        input: num(value.inputTokens),
        output: num(value.outputTokens),
        cacheRead: num(value.cacheReadInputTokens),
        cacheWrite: num(value.cacheCreationInputTokens),
        totalTokens:
          num(value.inputTokens) +
          num(value.outputTokens) +
          num(value.cacheReadInputTokens) +
          num(value.cacheCreationInputTokens),
      }
      models.push({ provider, model, tokens, cost: { ...emptyCost(), total: num(value.costUSD) } })
    }
  } else {
    models = [...byModel.values()]
  }

  models.sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens)
  const totals = emptyTokens()
  for (const item of models) {
    totals.input += item.tokens.input
    totals.output += item.tokens.output
    totals.cacheRead += item.tokens.cacheRead
    totals.cacheWrite += item.tokens.cacheWrite
    totals.totalTokens += item.tokens.totalTokens
  }

  return {
    tokens: totals,
    cost,
    byModel: models.map((item) => ({
      provider: item.provider,
      model: item.model,
      tokens: item.tokens,
      cost: item.cost,
    })),
    messageCount,
    computedAt: Date.now(),
    costReported,
  }
}
