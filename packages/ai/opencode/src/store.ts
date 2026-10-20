/**
 * store — OpenCode 系数据库（OpenCode / ZCode）的只读查询。
 *
 * 格式事实（magpie `opencode.go` / `calls_opencode.go` / `zcode.go` + 本机实测 2026-10-20）：
 *
 *   OpenCode：`~/.local/share/opencode/opencode.db`（`XDG_DATA_HOME` 可覆盖；`OPENCODE_DB` 可指定文件名）
 *   ZCode   ：`~/.zcode/cli/db/db.sqlite`
 *
 *   - `session`：`id` / `parent_id` / `directory`（cwd）/ `title` / `time_created` / `time_updated`
 *     / `time_archived`。**OpenCode 的 session 行还自带** `tokens_input|output|reasoning|cache_read|cache_write`
 *     与 `cost`（实测 == 该会话所有 assistant message 的 token 之和），所以列会话不需要碰 message 表。
 *     **ZCode 的 session 行没有这些列** → 用量取它的 `model_usage` 表（`input_tokens` / `output_tokens` /
 *     `reasoning_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`）。
 *   - `message`：`id` / `session_id` / `time_created` / `data`（JSON 文档：`role` / `tokens` / `modelID` …）
 *   - `part`：`id` / `message_id` / `data`（JSON：`type:"text"` 的 `text` 就是正文）
 *
 * 口径（与 magpie 一致）：`input` **不含** cache；`output` **不含** reasoning。
 * Tick 的 `TokenUsage` 没有 reasoning 字段，这里把 reasoning 并入 `output`（与 pi/Claude 的
 * 「output 含 thinking」一致），并在代码里写明。
 *
 * 子代理会话（`parent_id` 非空）不单独列：**父会话行不含子代理的 token/cost**（实测父行 cost
 * 恰等于父会话自己的 message 之和），所以两者都由本文件加回父会话。`readSessionRow` 仍能按 id
 * 精确查到子代理会话（单行查询，不再靠全表过滤）。
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  loadSqlite,
  openReadOnlySqlite,
  tableColumns,
  type OpenCodeLog,
} from './sqlite'

export interface OpenCodeIdentity {
  /** `opencode` | `zcode` */
  toolId: string
  /** 展示名（日志文案） */
  displayName: string
  /** 数据库绝对路径（调用方经 `dbPathNow()` 取得当前值，支持运行中重新解析） */
  dbPath: string
  /** 用量来源：session 行自带 / 独立 model_usage 表 */
  usageSource: 'session-row' | 'model-usage'
  /** 有 resume 命令时给可执行名；ZCode 是桌面应用 → undefined */
  exeName?: string
  resumeArgs?: (sessionId: string) => string[]
  /**
   * 桌面 App 的 bundle id（OpenCode：`ai.opencode.desktop`；ZCode：`dev.zcode.app`）。
   *  - OpenCode：桌面版与 CLI 共用同一份 DB，**不拆适配器**；桌面版只用于「装没装」判断与桌面入口；
   *  - ZCode：没有 CLI，**只有这个 bundle 能证明已安装**（数据目录存在不算，rules §4）。
   */
  desktopBundleId?: string
  /** 桌面 App 的 .app 名（`OpenCode.app` / `ZCode.app`） */
  desktopBundleName?: string
}

export interface OpenCodeSessionRow {
  id: string
  cwd?: string
  title?: string
  parentId?: string
  archived: boolean
  createdAt?: number
  updatedAt?: number
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  modelId?: string
  providerId?: string
  /** 本会话（session 行）自己的成本，**不含子代理** */
  cost?: number
  /** 子代理会话的成本之和（父行不含它，与 token 同理必须加回；无子代理时为 undefined） */
  childCost?: number
  /**
   * true = 有「token>0 但 cost 未上报（0）」的会话行（本会话或子代理）→ 合并后的 cost 只能当下限，
   * UI 要打「≥」。OpenCode 只在免费/网关模型上报 0，0 与「未上报」不可区分，保守降级。
   */
  costUnreported?: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** `model` 列是 JSON（`{"id":"…","providerID":"…"}`），也可能是裸字符串 */
function parseModel(value: unknown): { modelId?: string; providerId?: string } {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) {
        return { modelId: str(parsed.id) ?? str(parsed.modelID), providerId: str(parsed.providerID) }
      }
    } catch {
      return { modelId: value || undefined }
    }
    return { modelId: value || undefined }
  }
  if (isRecord(value)) return { modelId: str(value.id), providerId: str(value.providerID) }
  return {}
}

/** 必需列：session 缺任何一个都视为 schema 不识别（整体降级为空） */
const REQUIRED_SESSION_COLUMNS = ['id', 'directory', 'title', 'time_created', 'time_updated'] as const
/**
 * message/part 只服务「首/末条用户消息」与 ZCode 的用量兜底，**不**影响会话列表。
 * 缺列时只关掉正文能力（`bodyReadable=false`），不再把整个 store 降级为空 ——
 * 否则上游改 schema 会让用户以为「OpenCode 里一条会话都没有」。
 * `time_created` 是排序必需列（读窗口与 message 用量兜底都要它），缺了同样只关正文。
 */
const REQUIRED_MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'data'] as const
const REQUIRED_PART_COLUMNS = ['message_id', 'time_created', 'data'] as const

interface OpenedStore {
  db: DatabaseSync
  /** false = message/part schema 不识别 → `readUserTexts` 与 message 用量兜底不可用，列表/用量照常 */
  bodyReadable: boolean
  cleanup(): void
}

function hasColumns(db: DatabaseSync, table: string, required: readonly string[]): boolean {
  const cols = tableColumns(db, table)
  return required.every((col) => cols.has(col))
}

export async function openStore(
  identity: OpenCodeIdentity,
  log: OpenCodeLog,
): Promise<OpenedStore | undefined> {
  const sqlite = await loadSqlite(log)
  if (!sqlite) return undefined
  try {
    const { existsSync } = await import('node:fs')
    if (!existsSync(identity.dbPath)) return undefined
  } catch {
    return undefined
  }
  const opened = await openReadOnlySqlite(sqlite, identity.dbPath, log, identity.toolId)
  if (!opened) return undefined

  const sessionCols = tableColumns(opened.db, 'session')
  for (const col of REQUIRED_SESSION_COLUMNS) {
    if (!sessionCols.has(col)) {
      log('schema', `${identity.displayName} 的 session 表缺少列 ${col}，整体降级为空`)
      opened.cleanup()
      return undefined
    }
  }
  // message/part 缺列只降级正文能力（列表与用量仍可用）：日志与行为必须一致
  const bodyReadable =
    hasColumns(opened.db, 'message', REQUIRED_MESSAGE_COLUMNS) &&
    hasColumns(opened.db, 'part', REQUIRED_PART_COLUMNS)
  if (!bodyReadable) {
    log('schema', `${identity.displayName} 的 message/part 表缺列，首/末条用户消息降级为空（会话列表与用量不受影响）`)
  }
  if (identity.usageSource === 'model-usage' && tableColumns(opened.db, 'model_usage').size === 0) {
    log('schema', `${identity.displayName} 缺少 model_usage 表，用量降级为空`)
  }
  return { db: opened.db, bodyReadable, cleanup: opened.cleanup }
}

/** 精确查询单条会话时给的条件（取「这一条 + 它的子代理行」，单条详情/用量不再全表扫） */
interface SessionRowFilter {
  id: string
  /** false = 不要 tokens/cost（describe/resume 只看标题/时间/归档位，ZCode 不必为它扫 message 兜底） */
  withUsage?: boolean
}

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number }

function addTotals(a: Totals, b: Totals): void {
  a.input += b.input
  a.output += b.output
  a.cacheRead += b.cacheRead
  a.cacheWrite += b.cacheWrite
}

function combineTotals(a: Totals | undefined, b: Totals | undefined): Totals | undefined {
  if (!a) return b ? { ...b } : undefined
  if (!b) return a
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

/**
 * 列会话（不含子代理会话）。`usageSource='model-usage'` 时一次分组查询补齐用量。
 * 传 `filter` 时只查「这一条 + 它的子代理行」（`where id=? or parent_id=?`），
 * 供 describe/resume/computeUsage 单条使用 —— 否则每次详情都要全表扫 + 逐行 JSON.parse。
 */
export function listSessionRows(
  db: DatabaseSync,
  identity: OpenCodeIdentity,
  log: OpenCodeLog,
  filter?: SessionRowFilter,
): OpenCodeSessionRow[] {
  const cols = tableColumns(db, 'session')
  const usageCols = ['tokens_input', 'tokens_output', 'tokens_cache_read', 'tokens_cache_write'].every((c) =>
    cols.has(c),
  )
  const select = [
    'id',
    'directory',
    'title',
    'time_created',
    'time_updated',
    cols.has('parent_id') ? 'parent_id' : 'null as parent_id',
    cols.has('time_archived') ? 'time_archived' : 'null as time_archived',
    cols.has('model') ? 'model' : 'null as model',
    cols.has('cost') ? 'cost' : '0 as cost',
    usageCols ? 'tokens_input' : '0 as tokens_input',
    usageCols ? 'tokens_output' : '0 as tokens_output',
    usageCols ? 'tokens_cache_read' : '0 as tokens_cache_read',
    usageCols ? 'tokens_cache_write' : '0 as tokens_cache_write',
    // reasoning 并入 output（Tick 的 TokenUsage 没有 reasoning 字段），保持「output 含 thinking」口径
    usageCols && cols.has('tokens_reasoning') ? 'tokens_reasoning' : '0 as tokens_reasoning',
  ].join(', ')
  const where = filter ? ' where (id = ? or parent_id = ?)' : ''
  const params = filter ? [filter.id, filter.id] : []

  let raw: Record<string, unknown>[]
  try {
    raw = db.prepare(`select ${select} from session${where}`).all(...params) as Record<string, unknown>[]
  } catch (e) {
    log('query', `${identity.displayName} 会话查询失败：${(e as Error).message}`)
    return []
  }
  const ids = raw.map((row) => str(row.id)).filter((id): id is string => Boolean(id))
  // describe/resume 不需要用量：跳过用量查询（ZCode 的 message 兜底是全表扫，没必要为标题付这份钱）
  const withUsage = filter?.withUsage !== false

  const usageBySession =
    withUsage && identity.usageSource === 'model-usage'
      ? readModelUsage(db, identity, log, filter ? ids : undefined)
      : new Map()
  // ZCode 有 6/18 个根会话完全没有 model_usage 行（但 message 里带 tokens）→ 回退到 message 汇总。
  // 只查缺 model_usage 的会话（大库上逐行 JSON.parse 是纯浪费），单条查询时再按 id 收敛。
  const fallbackUsage =
    withUsage &&
    identity.usageSource === 'model-usage' &&
    hasColumns(db, 'message', ['session_id', 'time_created', 'data'])
      ? readMessageUsage(db, log, filter ? ids : undefined)
      : new Map()

  /** 一条会话（含子代理）的用量：session 行自带 → model_usage → message 兜底 */
  const usageOfRow = (row: Record<string, unknown>): Totals | undefined => {
    const id = str(row.id)
    if (!id) return undefined
    if (
      usageCols &&
      (num(row.tokens_input) || num(row.tokens_output) || num(row.tokens_cache_read) || num(row.tokens_reasoning))
    ) {
      return {
        input: num(row.tokens_input),
        output: num(row.tokens_output) + num(row.tokens_reasoning),
        cacheRead: num(row.tokens_cache_read),
        cacheWrite: num(row.tokens_cache_write),
      }
    }
    return usageBySession.get(id) ?? fallbackUsage.get(id)
  }

  // 子代理的 token 与 cost 都**不**在父会话行里（实测父行 cost 恰等于父会话自己的 message 之和），
  // 必须像 token 一样自己加回父会话，否则同一张卡片两个口径（token 已含子代理、钱没含）。
  // 同时记录「有 token 但 cost=0」的子会话：合并成本时这部分钱是未知的，只能当下限（costReported=false）。
  const childUsage = new Map<string, { totals: Totals; cost: number; unreported: boolean }>()
  const hasTokens = (usage: Totals): boolean =>
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0
  for (const row of withUsage ? raw : []) {
    const parentId = str(row.parent_id)
    if (!parentId) continue
    const usage = usageOfRow(row)
    const cost = num(row.cost)
    if (!usage && cost === 0) continue
    const acc = childUsage.get(parentId) ?? {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      unreported: false,
    }
    if (usage) {
      addTotals(acc.totals, usage)
      if (hasTokens(usage) && cost <= 0) acc.unreported = true
    }
    acc.cost += cost
    childUsage.set(parentId, acc)
  }

  const out: OpenCodeSessionRow[] = []
  for (const row of raw) {
    const id = str(row.id)
    if (!id) continue
    const parentId = str(row.parent_id)
    // 子代理会话不单独列（用量已计入父会话）；按 id 精确查它时例外
    if (parentId && filter?.id !== id) continue
    // ZCode 的 session 行没有 model 列 → 用 model_usage 里最大的 model_id 兜底
    const base = usageOfRow(row)
    const child = childUsage.get(id)
    // 父会话的可见用量 = 自己 + 子代理（与 dsh 的口径一致）
    const usage = combineTotals(base, child?.totals)
    const model = parseModel(row.model)
    if (!model.modelId) {
      const usageModel = usageBySession.get(id)?.model
      if (usageModel) model.modelId = usageModel
    }
    const childCost = child?.cost ?? 0
    // 本行自己的 token>0/cost=0、或任一子代理如此 → 合并成本不可信（下限）
    const costUnreported = Boolean((base && hasTokens(base) && num(row.cost) <= 0) || child?.unreported)
    out.push({
      id,
      cwd: str(row.directory),
      title: str(row.title),
      parentId,
      archived: row.time_archived !== null && row.time_archived !== undefined,
      createdAt: num(row.time_created) || undefined,
      updatedAt: num(row.time_updated) || undefined,
      ...(usage ? { tokens: usage } : {}),
      ...(model.modelId ? { modelId: model.modelId } : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      cost: num(row.cost),
      ...(childCost > 0 ? { childCost } : {}),
      ...(costUnreported ? { costUnreported: true } : {}),
    })
  }
  // 单条查询按 id 取；列表按最近活动排序
  if (!filter) out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return out
}

/**
 * 从 `message` 的 JSON 汇总用量（只在没有 `model_usage` 行时兜底）。
 * 口径与 `model_usage` 一致：input 不含 cache、output 含 reasoning。
 *
 * 性能：ZCode 本机 40MB 库 / 2147 条 message，全表扫 + 逐行 `JSON.parse` 实测 114ms/次，
 * 而真正缺 `model_usage` 的会话只是少数 → 过滤下推到 SQL（只扫这些会话），单条查询再按 id 收敛。
 * `onlySessionIds` 为空数组时直接返回空 Map（避免生成 `in ()` 非法 SQL）。
 */
function readMessageUsage(
  db: DatabaseSync,
  log: OpenCodeLog,
  onlySessionIds?: string[],
): Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> {
  const out = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>()
  if (onlySessionIds && onlySessionIds.length === 0) return out
  const where: string[] = []
  const params: string[] = []
  if (onlySessionIds) {
    where.push(`session_id in (${onlySessionIds.map(() => '?').join(',')})`)
    params.push(...onlySessionIds)
  }
  // 只查缺 model_usage 的会话。子查询里排除 NULL：`not in (含 NULL)` 会让结果恒为空。
  if (tableColumns(db, 'model_usage').size > 0) {
    where.push('session_id not in (select session_id from model_usage where session_id is not null)')
  }
  const whereSql = where.length > 0 ? ` where ${where.join(' and ')}` : ''
  try {
    const rows = db
      .prepare(`select session_id, data from message${whereSql} order by time_created asc`)
      .all(...params) as Record<string, unknown>[]
    for (const row of rows) {
      const sessionId = str(row.session_id)
      if (!sessionId) continue
      let message: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(String(row.data))
        if (!isRecord(parsed)) continue
        message = parsed
      } catch {
        continue
      }
      const tokens = isRecord(message.tokens) ? message.tokens : undefined
      if (!tokens) continue
      const cache = isRecord(tokens.cache) ? tokens.cache : undefined
      const acc = out.get(sessionId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      acc.input += num(tokens.input)
      acc.output += num(tokens.output) + num(tokens.reasoning)
      acc.cacheRead += cache ? num(cache.read) : 0
      acc.cacheWrite += cache ? num(cache.write) : 0
      out.set(sessionId, acc)
    }
  } catch (e) {
    log('query', `message 用量兜底失败：${(e as Error).message}`)
  }
  return out
}

/** ZCode 的用量：按 session 汇总 model_usage（每次模型调用一行，含重试） */
function readModelUsage(
  db: DatabaseSync,
  identity: OpenCodeIdentity,
  log: OpenCodeLog,
  onlySessionIds?: string[],
): Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string }> {
  const out = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string }
  >()
  if (onlySessionIds && onlySessionIds.length === 0) return out
  const cols = tableColumns(db, 'model_usage')
  if (cols.size === 0) return out
  const outputExpr = cols.has('reasoning_tokens')
    ? 'sum(coalesce(output_tokens,0) + coalesce(reasoning_tokens,0))'
    : 'sum(coalesce(output_tokens,0))'
  // 单条查询时只汇总这一条（含子代理）的用量，别为一条会话 group by 整张表
  const where = onlySessionIds ? ` where session_id in (${onlySessionIds.map(() => '?').join(',')})` : ''
  try {
    const rows = db
      .prepare(
        `select session_id,
                sum(coalesce(input_tokens,0)) as input,
                ${outputExpr} as output,
                sum(coalesce(cache_read_input_tokens,0)) as cache_read,
                sum(coalesce(cache_creation_input_tokens,0)) as cache_write,
                max(model_id) as model
         from model_usage${where} group by session_id`,
      )
      .all(...(onlySessionIds ?? [])) as Record<string, unknown>[]
    for (const row of rows) {
      const id = str(row.session_id)
      if (!id) continue
      out.set(id, {
        input: num(row.input),
        output: num(row.output),
        cacheRead: num(row.cache_read),
        cacheWrite: num(row.cache_write),
        ...(str(row.model) ? { model: str(row.model) as string } : {}),
      })
    }
  } catch (e) {
    log('query', `${identity.displayName} 用量查询失败：${(e as Error).message}`)
  }
  return out
}

/** 注入包装：`<system-reminder>` 整块剥离；剩下的如果仍只有标签，就不算用户说的话 */
const INJECTION_BLOCKS: RegExp[] = [
  /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<environment_context[^>]*>[\s\S]*?<\/environment_context>/gi,
  /<user_instructions[^>]*>[\s\S]*?<\/user_instructions>/gi,
  /<permissions instructions[^>]*>[\s\S]*?<\/permissions instructions>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
]

/** 一条 user 文本的清洗：剥离注入块；剥完为空、或以 `<` 开头（整条注入）就不算用户输入 */
export function cleanUserText(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  let text = raw
  for (const re of INJECTION_BLOCKS) text = text.replace(re, '')
  text = text.trim()
  if (!text) return undefined
  if (text.startsWith('<')) return undefined
  if (/^<[a-z_ -]+>[\s\S]*<\/[a-z_ -]+>$/i.test(text)) return undefined
  return text
}

/**
 * 一条会话的「首/末条用户文本」。
 *
 * 历史教训（两次踩坑，别再退回固定窗口）：
 *  1. 初版「升序 + limit 20000」：超长会话的 `lastMessage` 会静默变成中段某条，且一次读出全部 part；
 *  2. 第二轮「首/尾各 20 条窗口」：把首尾写死。注释里的概率论证（44% 注入 ⇒ 连续 20 条全注入概率 < 1e-7）
 *     把注入当成独立随机事件，但 OpenCode 里 agent/自动化会话的注入是**按轮成段连续写入**的 ——
 *     真实库 63 条根会话里 2 条中招：一条前 20 条 user message 全是 `<inbound-context>`（first 变空），
 *     一条最后 20 条全是注入（last 回落成第一条）。
 *
 * 现在：**按页向外滚动**，每页 20 条 user message（只取这些 message 的 text part），
 * 命中第一条清洗后的文本即停。页数上限 20（最多 400 条 message）——正常会话第一页就命中，
 * 注入成段的会话扫 2–3 页，同时避免「全是注入」的病态会话把整库扫穿（真实库最长会话 59 条 user 消息）。
 */
const USER_TEXT_PAGE = 20
const USER_TEXT_MAX_PAGES = 20

interface UserTextPage {
  /** message id，按查询方向排列（asc = 最早在前；desc = 最新在前） */
  order: string[]
  /** message id → 已清洗的 text part（按 part 时间升序） */
  textByMessage: Map<string, string[]>
}

function textOfPart(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.type !== 'text') return undefined
    return typeof parsed.text === 'string' ? parsed.text : undefined
  } catch {
    return undefined
  }
}

/** 取会话某一页 **user** message 的文本 part（`offset` 按消息条数分页） */
function readUserTextPage(
  db: DatabaseSync,
  sessionId: string,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): UserTextPage | undefined {
  let ids: string[]
  try {
    // json_valid 兜底坏行：json_extract 遇到非法 JSON 会整条查询报错，不能让一行坏数据毁掉整个会话。
    // rowid 作 time_created 的 tiebreak，保证分页边界稳定（同毫秒的消息不会跨页重复/漏掉）。
    const rows = db
      .prepare(
        `select m.id as id
           from message m
          where m.session_id = ?
            and json_valid(m.data)
            and json_extract(m.data, '$.role') = 'user'
          order by m.time_created ${direction}, m.rowid ${direction}
          limit ? offset ?`,
      )
      .all(sessionId, limit, offset) as Record<string, unknown>[]
    ids = rows.map((row) => str(row.id)).filter((id): id is string => Boolean(id))
  } catch {
    // schema 不识别 / SQLite 无 JSON1：降级为空（openStore 已记过 schema 日志）
    return undefined
  }
  const textByMessage = new Map<string, string[]>()
  if (ids.length === 0) return { order: [], textByMessage }
  try {
    const rows = db
      .prepare(
        `select p.message_id as message_id, p.data as data
           from part p
          where p.message_id in (${ids.map(() => '?').join(',')})
            and json_valid(p.data)
            and json_extract(p.data, '$.type') = 'text'
          order by p.time_created asc`,
      )
      .all(...ids) as Record<string, unknown>[]
    for (const row of rows) {
      const messageId = str(row.message_id)
      if (!messageId) continue
      // 实测 44% 的 user text part 是 `<system-reminder>` / `<inbound-context>` 之类的注入
      // （OpenCode 把它当 user 消息存）；剥完为空的直接丢弃，继续找下一条。
      const text = cleanUserText(textOfPart(row.data))
      if (!text) continue
      const list = textByMessage.get(messageId) ?? []
      list.push(text)
      textByMessage.set(messageId, list)
    }
  } catch {
    return undefined
  }
  return { order: ids, textByMessage }
}

interface UserTextScan {
  found?: string
  /** true = 查询本身失败（schema/JSON1），与「扫完没有合格文本」区分开 */
  error: boolean
}

/**
 * 从会话一端向外分页扫，返回第一条清洗后的用户文本。
 * `asc` = 从最早往后找首条；`desc` = 从最新往前找末条。
 */
function scanUserText(db: DatabaseSync, sessionId: string, direction: 'asc' | 'desc'): UserTextScan {
  for (let page = 0; page < USER_TEXT_MAX_PAGES; page++) {
    const window = readUserTextPage(db, sessionId, direction, USER_TEXT_PAGE, page * USER_TEXT_PAGE)
    if (!window) return { error: true }
    for (const messageId of window.order) {
      const texts = window.textByMessage.get(messageId)
      if (!texts) continue
      const joined = texts.join('\n').trim()
      if (joined) return { found: joined, error: false }
    }
    // 这一页没取满 → 已经到会话末尾
    if (window.order.length < USER_TEXT_PAGE) return { error: false }
  }
  // 达到页数上限仍没命中：按「无可展示的用户文本」处理（病态全注入会话，和全量扫的结论一致）
  return { error: false }
}

/** 该会话的首/末条**用户**文本（读 message + part；子代理消息不属于它，故不按 parent 汇总） */
export function readUserTexts(
  db: DatabaseSync,
  sessionId: string,
  log?: OpenCodeLog,
): { first?: string; last?: string } {
  const head = scanUserText(db, sessionId, 'asc')
  const tail = scanUserText(db, sessionId, 'desc')
  if (head.error || tail.error) {
    // rules §7/§8：读失败要可诊断，但日志不带宽窄不一的会话 id/正文
    log?.('query', 'OpenCode 有会话的首/末条用户消息读取失败（正文降级为空）')
  }
  const first = head.found
  // 正常情况 tail 一定能找到（它从另一端扫同一批 user message）；`?? first` 只是查询部分失败时的兜底
  const last = tail.found ?? first
  return { first, last }
}

/** 单条会话（详情/用量用）：`where id = ?` 单行查询 + 子代理聚合；子代理会话也能按 id 查到 */
export function readSessionRow(
  db: DatabaseSync,
  identity: OpenCodeIdentity,
  sessionId: string,
  log: OpenCodeLog,
  opts: { withUsage?: boolean } = {},
): OpenCodeSessionRow | undefined {
  return listSessionRows(db, identity, log, {
    id: sessionId,
    ...(opts.withUsage === false ? { withUsage: false } : {}),
  })[0]
}
