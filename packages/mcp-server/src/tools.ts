/**
 * v1 三个工具：`create_todo` / `list_todos` / `link_session`。
 *
 * 合同来源：`docs/mcp-tools-spec.md` §3（description 与 schema 逐字对齐）。
 * 写路径全部走 `@tick/todo-core`（唯一锁实现）；绑定回扫走 `@tick/probe-scan`；
 * 这里只负责：参数语义校验、幂等判定顺序、handle/probe 生命周期、结果信封与审计。
 *
 * Tier 0（本进程直写 + 自回扫）：v1 不实现 main 的 bridge，写工具如实返回
 * `degraded:true, degradedReason:"bridge_unavailable"`，但数据与绑定不降级。
 */

import path from 'node:path'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import type { Todo } from '@tick/shared'
import { newCliSessionId } from '@tick/shared'
import { TodoDataError, normalizeTitle } from '@tick/todo-core'
import {
  listProbes,
  newHandle,
  scheduleScans,
  scanProbes,
  writeProbe,
  type ProbeRecord,
} from '@tick/probe-scan'
import { normalizeClientToolId } from '@tick/session-locators'
import type { McpRuntime } from './config'
import { audit, auditScan } from './audit'
import { clampText, failure, success } from './errors'
import { logError } from './logger'
import { readLimiter, writeLimiter } from './limits'

// ---------- 文案（spec §3 原文，勿改写） ----------

const CREATE_DESCRIPTION =
  '在 Tick（用户的本地 todo 工作台）里新建一条线索。当用户说「记一下 / 加个 todo / 别忘了」，或你识别出需要后续跟进的事时使用。一次只建一条；标题要具体、动词开头。调用结果里会带一个 Tick 绑定句柄，请原样保留在对话里——Tick 靠它把这条线索关联到当前会话。'

const LIST_DESCRIPTION =
  '列出 Tick 里的线索（默认只返回未完成，不含正文）。当用户问「我还欠什么 / 这个项目还有哪些事 / 有哪些线索」时使用。结果按最近更新时间倒序；需要正文时用 get_todo（P1）。'

const LINK_DESCRIPTION =
  '把当前对话关联到 Tick 里已有的某条线索。当用户说「把这件事记到那条线索 / 关联一下」时使用。不需要传 session_id——Tick 会用结果里的绑定句柄自动识别当前会话；如果你确定知道会话 id，可以显式传。'

// ---------- 注解 ----------

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

// ---------- schema（字段名/描述/约束与 spec §3 一致） ----------

const sessionIdSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)

const toolIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)

const requestIdSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)

const createInputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('一句话线索标题（必填）。具体、动词开头，例如「补 PR #42 的 e2e」。'),
  body: z.string().max(4096).optional().describe('补充说明 / 下一步（选填）。不要放凭据或大段代码。'),
  session_id: sessionIdSchema
    .optional()
    .describe('当前客户端会话 id。仅当你确定知道时传；不知道就省略，Tick 会用句柄回扫自动识别。'),
  tool_id: toolIdSchema
    .optional()
    .describe('会话所属工具：pi / workbuddy / workbuddy-ai。缺省从 MCP clientInfo 推断。'),
  cwd: z
    .string()
    .max(1024)
    .optional()
    .describe('当前工作目录（绝对路径，选填）。仅用于来源展示与会话定位提示。'),
  request_id: requestIdSchema
    .optional()
    .describe('幂等键。同一次工具调用重试时保持不变；同一个 request_id 只会建一条线索。'),
  bind: z
    .boolean()
    .default(true)
    .describe('是否尝试把当前会话绑到这条线索。默认 true；false 时只建线索。'),
}).strict()

const listInputSchema = z.object({
  status: z.enum(['open', 'done', 'all']).default('open').describe('默认 open（只看未完成）。'),
  limit: z.number().int().min(1).max(100).default(20).describe('最多返回多少条（默认 20）。'),
  query: z
    .string()
    .max(100)
    .optional()
    .describe('可选：按标题子串过滤（忽略大小写，不做模糊/分词）。'),
  origin: z
    .enum(['any', 'local', 'mcp'])
    .default('any')
    .describe('来源过滤：local=用户手建/面板建，mcp=外部 agent 建。'),
}).strict()

const linkInputSchema = z.object({
  todo_id: z.string().describe('目标线索 id（必填）。先用 list_todos 找到。'),
  session_id: sessionIdSchema.optional().describe('可选：已知的会话 id。'),
  tool_id: toolIdSchema.optional().describe('可选：会话所属工具。'),
  cwd: z.string().max(1024).optional().describe('可选：当前工作目录。'),
  request_id: requestIdSchema.optional().describe('幂等键。'),
}).strict()

const HANDLE_PATTERN = /^tk_[0-9a-hjkmnp-tv-z]{26}$/

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().optional(),
  next: z.string().optional(),
})

const bindingSchema = z.object({
  state: z.enum(['verified', 'pending', 'unbound']),
  toolId: z.string().optional(),
  sessionId: z.string().optional(),
  filePath: z.string().optional(),
  reason: z.string().optional(),
})

const createOutputSchema = z.object({
  ok: z.boolean(),
  todoId: z.string().optional(),
  title: z.string().optional(),
  status: z.enum(['open', 'done']).optional(),
  created: z.boolean().optional(),
  dedupedBy: z.enum(['request_id', 'session', 'title']).optional(),
  handle: z.string().regex(HANDLE_PATTERN).optional(),
  binding: bindingSchema.optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
  error: errorSchema.optional(),
}).strict()

const listTodoSchema = z.object({
  todoId: z.string(),
  title: z.string(),
  status: z.enum(['open', 'done']),
  createdAt: z.string().meta({ format: 'date-time' }),
  updatedAt: z.string().meta({ format: 'date-time' }),
  origin: z.enum(['local', 'mcp']),
  toolId: z.string().optional(),
  sessionCount: z.number().int(),
  bindingState: z.enum(['verified', 'pending', 'none']),
  primarySessionId: z.string().optional(),
})

const listOutputSchema = z.object({
  ok: z.boolean(),
  count: z.number().int().optional(),
  todos: z.array(listTodoSchema).optional(),
  truncated: z.boolean().optional(),
  error: errorSchema.optional(),
}).strict()

const linkOutputSchema = z.object({
  ok: z.boolean(),
  todoId: z.string().optional(),
  title: z.string().optional(),
  handle: z.string().regex(HANDLE_PATTERN).optional(),
  binding: bindingSchema.optional(),
  degraded: z.boolean().optional(),
  degradedReason: z.string().optional(),
  error: errorSchema.optional(),
}).strict()

// ---------- 内部类型与工具函数 ----------

export interface ServerState {
  /** 上次安排 3s/10s/30s 扫描批次的时间；长驻进程需要按批次续排，不能只排一次 */
  lastScanScheduledAt: number
  /** 本进程是否写过 probe：没有就不用做 EOF 最终回扫 */
  probesWritten: number
}

interface BindingView {
  state: 'verified' | 'pending' | 'unbound'
  toolId?: string
  sessionId?: string
  filePath?: string
  reason?: string
}

type ToolName = 'create_todo' | 'list_todos' | 'link_session'

/** 标题窗口去重：10 分钟（spec §1.6 第 3 条） */
const TITLE_DEDUPE_WINDOW_MS = 10 * 60 * 1000
const PROBE_TTL_MS = 24 * 60 * 60 * 1000

function normalizeToolId(raw: string): string {
  if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw)) return raw
  return normalizeClientToolId({ name: raw })
}

/** 现代协议信封里的保留键（与 @modelcontextprotocol/core 一致） */
const ENVELOPE_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'

/**
 * 工具 handler 的 ctx 只用到 mcpReq.envelope。
 * v2 SDK 在 stdio 的 modern 路径不会 seed `getClientVersion()`（那是 HTTP 入口做的），
 * 所以现代请求必须从每个请求的 `_meta` 信封里读 clientInfo，否则 tool_id 永远退化成 "mcp"。
 */
interface ToolContext {
  mcpReq?: { envelope?: Record<string, unknown> }
}

function envelopeClientInfo(ctx: ToolContext | undefined): { name: string; version?: string } | undefined {
  const raw = ctx?.mcpReq?.envelope?.[ENVELOPE_CLIENT_INFO]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as { name?: unknown; version?: unknown }
  if (typeof record.name !== 'string' || !record.name) return undefined
  return {
    name: record.name,
    ...(typeof record.version === 'string' && record.version ? { version: record.version } : {}),
  }
}

function clientInfo(server: McpServer, ctx?: ToolContext): { name: string; version?: string } {
  // 1) modern：每请求 _meta 信封（最权威，且不依赖 initialize）
  const fromEnvelope = envelopeClientInfo(ctx)
  if (fromEnvelope) return fromEnvelope
  // 2) legacy：initialize 的 clientInfo
  const info = server.server.getClientVersion()
  if (info?.name) return { name: info.name, ...(info.version ? { version: info.version } : {}) }
  // 3) 两者都没有：不猜
  return { name: 'mcp' }
}

function resolveToolId(server: McpServer, explicit?: string, ctx?: ToolContext): string {
  if (explicit) return normalizeToolId(explicit)
  const fromEnv = (process.env.TICK_AGENT_TOOL ?? '').trim()
  if (fromEnv) return normalizeToolId(fromEnv)
  return normalizeClientToolId(clientInfo(server, ctx))
}

function clientInfoLabel(server: McpServer, ctx?: ToolContext): string | undefined {
  const info = clientInfo(server, ctx)
  if (!info.name) return undefined
  return info.version ? `${info.name} ${info.version}` : info.name
}

/** probe 的 clientInfo 是对象（spec §4.1）；没有真实客户端身份时省略，不写 "mcp" */
function probeClientInfo(
  server: McpServer,
  ctx?: ToolContext,
): { name: string; version?: string } | undefined {
  const info = clientInfo(server, ctx)
  if (info.name === 'mcp' && !info.version) return undefined
  return info
}

/** sessionId 是不透明字符串，但要能安全写进 JSON / 文件名比较：不许路径分隔符与 NUL */
function isSafeSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[/\\\u0000]/.test(value)
}

function bindingOf(todo: Todo, preferredSessionId?: string, preferredToolId?: string): BindingView {
  const byPreference = (state: 'verified' | 'pending'): BindingView | undefined => {
    const match = todo.bindings.find(
      (b) =>
        (b.state ?? 'verified') === state &&
        (!preferredSessionId || b.sessionId === preferredSessionId) &&
        (!preferredToolId || b.toolId === preferredToolId),
    )
    if (!match) return undefined
    return {
      state,
      toolId: match.toolId,
      sessionId: match.sessionId,
      ...(match.filePath ? { filePath: match.filePath } : {}),
    }
  }
  // 旧数据没有 state，按 verified 处理（与 CLAUDE.md 不变量一致）
  return byPreference('verified') ?? byPreference('pending') ?? { state: 'unbound' }
}

/** 幂等命中时复用同一 todo 的未过期 probe，避免每次重试都换 handle */
function findReusableProbe(home: string, todoId: string): ProbeRecord | undefined {
  const now = Date.now()
  return listProbes(home)
    .filter((p) => p.todoId === todoId && Date.parse(p.expiresAt) > now)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
}

function writeProbeSafely(home: string, probe: ProbeRecord): boolean {
  try {
    writeProbe(probe, home)
    return true
  } catch (error) {
    // probe 写不进去只是「这次自动绑定失效」，todo 已经落盘；不能把成功改写成失败
    logError('probe 写入失败（绑定降级为 unbound）', error)
    return false
  }
}

function ensureScans(state: ServerState, runtime: McpRuntime): void {
  state.probesWritten += 1
  const now = Date.now()
  // 一个批次覆盖 30s；30s 内的新 probe 会被该批次的 10s/30s 扫描顺带覆盖。
  // 长驻进程（客户端一直开着）必须续排，否则第一批定时器跑完后新 probe 再没人扫。
  if (state.lastScanScheduledAt !== 0 && now - state.lastScanScheduledAt < 30_000) return
  state.lastScanScheduledAt = now
  // 定时器 unref：绝不为等 30s 的扫描把进程挂住（spec §4.5）
  scheduleScans(
    () =>
      scanProbes({
        home: runtime.home,
        store: runtime.store,
        onEvent: (event) => auditScan(runtime.home, event),
      }),
    [3_000, 10_000, 30_000],
  )
}

function finish(
  runtime: McpRuntime,
  tool: ToolName,
  toolId: string,
  startedAt: number,
  result: CallToolResult,
  ids: { todoId?: string; sessionId?: string } = {},
): CallToolResult {
  const structured = result.structuredContent as
    | { ok?: boolean; error?: { code?: string } }
    | undefined
  const code = structured?.ok === false ? (structured.error?.code ?? 'TICK_E_INTERNAL') : 'OK'
  audit(runtime.home, {
    toolId,
    tool,
    ...(ids.todoId ? { todoId: ids.todoId } : {}),
    ...(ids.sessionId ? { sessionId: ids.sessionId } : {}),
    code,
    ms: Date.now() - startedAt,
  })
  return result
}

function fromError(error: unknown): CallToolResult {
  if (error instanceof TodoDataError || (error as { code?: string })?.code) {
    const code = (error as { code?: string }).code
    if (code === 'TICK_E_DATA_CORRUPT') {
      return failure(
        'TICK_E_DATA_CORRUPT',
        'todos.json 解析失败',
        '让用户在 Tick 里修复或恢复备份（不要重建数据文件）',
        false,
      )
    }
    if (code === 'TICK_E_LOCK_TIMEOUT') {
      return failure('TICK_E_LOCK_TIMEOUT', 'todos.json 正在被其他进程写入', '稍后重试', true)
    }
    if (code === 'TICK_E_INVALID_INPUT') {
      return failure(
        'TICK_E_INVALID_INPUT',
        error instanceof Error ? error.message : '参数不合法',
        '修正参数后重试',
        false,
      )
    }
  }
  logError('工具执行失败', error)
  return failure('TICK_E_INTERNAL', '内部错误', '稍后重试；若持续失败请上报日志', false)
}

function projectTodo(todo: Todo, pendingTodoIds?: ReadonlySet<string>): z.infer<typeof listTodoSchema> {
  const states = todo.bindings.map((b) => b.state ?? 'verified')
  const bindingState = states.includes('verified')
    ? ('verified' as const)
    : states.includes('pending') || pendingTodoIds?.has(todo.id)
      ? ('pending' as const)
      : ('none' as const)
  const toolId = todo.mcpOrigin?.toolId ?? todo.bindings[0]?.toolId
  return {
    todoId: todo.id,
    title: todo.title,
    status: todo.status,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    origin: todo.source === 'mcp' ? 'mcp' : 'local',
    ...(toolId ? { toolId } : {}),
    sessionCount: todo.bindings.length,
    bindingState,
    ...(todo.primarySessionId ? { primarySessionId: todo.primarySessionId } : {}),
  }
}

function createText(
  created: boolean,
  dedupedBy: 'request_id' | 'session' | 'title' | undefined,
  title: string,
  handle: string | undefined,
  binding: BindingView,
): string {
  const head = handle ? `Tick 绑定句柄：${handle}\n` : ''
  const suffix = binding.state === 'unbound' ? '（未关联会话）' : ''
  if (created) return `${head}已在 Tick 建好线索：${title}${suffix}`
  if (dedupedBy === 'title') return `${head}已存在同名线索，未重复创建：${title}${suffix}`
  const why = dedupedBy === 'request_id' ? 'request_id 命中' : '会话命中'
  return `${head}已存在同样的线索（${why}），未重复创建：${title}${suffix}`
}

function rateLimited(retryAfterSeconds: number): CallToolResult {
  return failure(
    'TICK_E_RATE_LIMITED',
    '操作过于频繁',
    `等待 ${retryAfterSeconds} 秒后重试`,
    true,
    { retryAfterSeconds },
  )
}

// ---------- 注册 ----------

export function registerTools(server: McpServer, runtime: McpRuntime, state: ServerState): void {
  server.registerTool(
    'create_todo',
    {
      title: '创建 Tick 线索',
      description: CREATE_DESCRIPTION,
      inputSchema: createInputSchema,
      outputSchema: createOutputSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => {
      const startedAt = Date.now()
      const toolId = resolveToolId(server, args.tool_id, ctx)
      const ids: { todoId?: string; sessionId?: string } = {}
      try {
        const flags = runtime.flags()
        if (flags.readonly) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            failure('TICK_E_READONLY', 'Tick 处于只读模式', '去 Tick 设置里关闭只读', false),
            ids,
          )
        }
        const limited = writeLimiter.take()
        if (!limited.ok) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            rateLimited(limited.retryAfterSeconds),
            ids,
          )
        }

        // schema 之外的语义校验：空白标题、NFKC 后超长、非法 cwd / sessionId
        const title = normalizeTitle(args.title)
        if (!title) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            failure('TICK_E_TITLE_EMPTY', '标题不能为空', '给一个具体标题', false),
            ids,
          )
        }
        if (title.length > 200) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            failure('TICK_E_TITLE_TOO_LONG', '标题超过 200 字符', '缩短标题后重试', false),
            ids,
          )
        }
        if (args.body !== undefined && args.body.length > 4096) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            failure('TICK_E_BODY_TOO_LONG', '正文超过 4096 字符', '缩短正文或只记标题', false),
            ids,
          )
        }
        if (args.cwd !== undefined) {
          if (!path.isAbsolute(args.cwd) || args.cwd.length > 1024) {
            return finish(
              runtime,
              'create_todo',
              toolId,
              startedAt,
              failure(
                'TICK_E_INVALID_INPUT',
                'cwd 必须是绝对路径且不超过 1024 字符',
                '传绝对路径或省略 cwd',
                false,
              ),
              ids,
            )
          }
        }
        if (args.session_id !== undefined && !isSafeSessionId(args.session_id)) {
          return finish(
            runtime,
            'create_todo',
            toolId,
            startedAt,
            failure('TICK_E_INVALID_INPUT', 'session_id 不合法', '传工具侧的原始会话 id', false),
            ids,
          )
        }

        const explicitSessionId = args.session_id
        const shouldBind = args.bind !== false
        if (explicitSessionId && shouldBind) ids.sessionId = explicitSessionId
        const at = Date.now()
        const originAt = new Date(at).toISOString()
        const infoLabel = clientInfoLabel(server, ctx)

        // 幂等顺序由 todo-core 保证：request_id → 会话 → 标题窗口
        const result = runtime.store.create({
          title,
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(explicitSessionId && shouldBind ? { sessionId: explicitSessionId } : {}),
          toolId,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          source: 'mcp',
          ...(args.request_id ? { requestId: args.request_id } : {}),
          mcpOrigin: {
            toolId,
            ...(infoLabel ? { clientInfo: infoLabel } : {}),
            ...(args.cwd ? { cwd: args.cwd } : {}),
            at: originAt,
          },
          dedupeByTitleWithinMs: TITLE_DEDUPE_WINDOW_MS,
        })
        const todo = result.todo
        ids.todoId = todo.id

        let handle: string | undefined
        let binding: BindingView

        if (!shouldBind) {
          // bind=false 是硬要求：即使调用方给了 session_id 也只建线索
          binding = { state: 'unbound', reason: 'bind_false' }
        } else if (explicitSessionId) {
          // 显式 session 由 todo-core 在新建时写 verified；幂等命中（request_id/title）
          // 不许再写盘，所以这里只如实投影当前绑定，不把 unbound 粉饰成 verified。
          binding = bindingOf(todo, explicitSessionId, toolId)
        } else if (result.created) {
          if (!flags.scanEnabled) {
            binding = { state: 'unbound', reason: 'scan_disabled' }
          } else {
            handle = newHandle()
            const probeClient = probeClientInfo(server, ctx)
            const probe: ProbeRecord = {
              version: 1,
              handle,
              purpose: 'create',
              todoId: todo.id,
              toolId,
              ...(probeClient ? { clientInfo: probeClient } : {}),
              ...(args.cwd ? { cwd: args.cwd } : {}),
              at: new Date(at).toISOString(),
              expiresAt: new Date(at + PROBE_TTL_MS).toISOString(),
              pid: process.pid,
              ...(args.request_id ? { requestId: args.request_id } : {}),
            }
            if (writeProbeSafely(runtime.home, probe)) {
              ensureScans(state, runtime)
              binding = { state: 'pending' }
            } else {
              binding = { state: 'unbound', reason: 'probe_write_failed' }
            }
          }
        } else if (!flags.scanEnabled) {
          binding = { state: 'unbound', reason: 'scan_disabled' }
        } else {
          // 幂等命中：不新建 probe，只复用还在有效期内的同一个 handle
          const existing = findReusableProbe(runtime.home, todo.id)
          if (existing) {
            handle = existing.handle
            ensureScans(state, runtime)
            binding = { state: 'pending' }
          } else {
            binding = bindingOf(todo)
            if (binding.state === 'unbound') binding = { state: 'unbound', reason: 'probe_expired' }
          }
        }

        const structured: Record<string, unknown> = {
          todoId: todo.id,
          title: todo.title,
          status: todo.status,
          created: result.created,
          ...(result.dedupedBy ? { dedupedBy: result.dedupedBy } : {}),
          ...(handle ? { handle } : {}),
          binding,
          degraded: true,
          degradedReason: 'bridge_unavailable',
        }
        const text = clampText(createText(result.created, result.dedupedBy, todo.title, handle, binding))
        return finish(
          runtime,
          'create_todo',
          toolId,
          startedAt,
          success(text, structured),
          ids,
        )
      } catch (error) {
        return finish(runtime, 'create_todo', toolId, startedAt, fromError(error), ids)
      }
    },
  )

  server.registerTool(
    'list_todos',
    {
      title: '列出 Tick 线索',
      description: LIST_DESCRIPTION,
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      annotations: READ_ANNOTATIONS,
    },
    async (args, ctx) => {
      const startedAt = Date.now()
      const toolId = resolveToolId(server, undefined, ctx)
      try {
        const limited = readLimiter.take()
        if (!limited.ok) {
          return finish(runtime, 'list_todos', toolId, startedAt, rateLimited(limited.retryAfterSeconds))
        }

        const all = runtime.store.list()
        const status = args.status
        const query = (args.query ?? '').toLowerCase()
        const origin = args.origin

        const filtered = all.filter((todo) => {
          if (status !== 'all' && todo.status !== status) return false
          if (query && !todo.title.toLowerCase().includes(query)) return false
          const isMcp = todo.source === 'mcp'
          if (origin === 'local' && isMcp) return false
          if (origin === 'mcp' && !isMcp) return false
          return true
        })

        filtered.sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )

        const limit = args.limit
        const truncated = filtered.length > limit
        // 还在等回扫的线索没有 binding（pending 不落盘），但 UI 语义上应显示 pending
        const pending = new Set(
          listProbes(runtime.home)
            .filter((probe) => Date.parse(probe.expiresAt) > Date.now())
            .map((probe) => probe.todoId),
        )
        const page = filtered.slice(0, limit).map((todo) => projectTodo(todo, pending))

        const lines = page
          .slice(0, 20)
          .map((todo, index) => `${index + 1}. [${todo.status === 'done' ? 'x' : ' '}] ${todo.title}`)
        if (page.length > 20) lines.push(`…另有 ${filtered.length - 20} 条`)
        const text = lines.length > 0 ? lines.join('\n') : '（没有符合条件的线索）'

        return finish(
          runtime,
          'list_todos',
          toolId,
          startedAt,
          success(clampText(text), { count: page.length, todos: page, truncated }),
        )
      } catch (error) {
        return finish(runtime, 'list_todos', toolId, startedAt, fromError(error))
      }
    },
  )

  server.registerTool(
    'link_session',
    {
      title: '关联当前会话到 Tick 线索',
      description: LINK_DESCRIPTION,
      inputSchema: linkInputSchema,
      outputSchema: linkOutputSchema,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => {
      const startedAt = Date.now()
      const toolId = resolveToolId(server, args.tool_id, ctx)
      const ids: { todoId?: string; sessionId?: string } = {}
      try {
        const flags = runtime.flags()
        if (flags.readonly) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            failure('TICK_E_READONLY', 'Tick 处于只读模式', '去 Tick 设置里关闭只读', false),
            ids,
          )
        }
        const limited = writeLimiter.take()
        if (!limited.ok) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            rateLimited(limited.retryAfterSeconds),
            ids,
          )
        }

        if (args.cwd !== undefined && (!path.isAbsolute(args.cwd) || args.cwd.length > 1024)) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            failure('TICK_E_INVALID_INPUT', 'cwd 必须是绝对路径', '传绝对路径或省略 cwd', false),
            ids,
          )
        }
        if (args.session_id !== undefined && !isSafeSessionId(args.session_id)) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            failure('TICK_E_INVALID_INPUT', 'session_id 不合法', '传工具侧的原始会话 id', false),
            ids,
          )
        }

        ids.todoId = args.todo_id
        const todo = runtime.store.list().find((item) => item.id === args.todo_id)
        if (!todo) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            failure(
              'TICK_E_TODO_NOT_FOUND',
              `线索不存在：${args.todo_id}`,
              '调用 list_todos 确认 todoId',
              false,
            ),
            ids,
          )
        }

        const at = new Date().toISOString()

        if (args.session_id) {
          const sessionId = args.session_id
          ids.sessionId = sessionId
          const owner = runtime.store.findTodoBySession(sessionId, toolId)
          if (owner && owner.id !== todo.id) {
            return finish(
              runtime,
              'link_session',
              toolId,
              startedAt,
              failure(
                'TICK_E_SESSION_TAKEN',
                `该会话已绑定到「${owner.title}」(${owner.id})`,
                '让用户在 Tick 里先解绑，或改用其他线索',
                false,
              ),
              ids,
            )
          }

          // 已绑在同一条：幂等成功，不重复写
          if (owner && owner.id === todo.id) {
            const binding = bindingOf(owner, sessionId, toolId)
            if (binding.state === 'verified') {
              return finish(
                runtime,
                'link_session',
                toolId,
                startedAt,
                success(`已关联：这条对话 → 「${todo.title}」`, {
                  todoId: todo.id,
                  title: todo.title,
                  binding,
                  degraded: true,
                  degradedReason: 'bridge_unavailable',
                }),
                ids,
              )
            }
          }

          const bound = runtime.store.addBinding(todo.id, {
            toolId,
            sessionId: newCliSessionId(sessionId),
            boundAt: at,
            state: 'verified',
            origin: 'mcp',
          })
          if (!bound.ok) {
            if (bound.conflictTodo) {
              return finish(
                runtime,
                'link_session',
                toolId,
                startedAt,
                failure(
                  'TICK_E_SESSION_TAKEN',
                  `该会话已绑定到「${bound.conflictTodo.title}」(${bound.conflictTodo.id})`,
                  '让用户在 Tick 里先解绑，或改用其他线索',
                  false,
                ),
                ids,
              )
            }
            return finish(
              runtime,
              'link_session',
              toolId,
              startedAt,
              failure(
                'TICK_E_TODO_NOT_FOUND',
                `线索不存在：${args.todo_id}`,
                '调用 list_todos 确认 todoId',
                false,
              ),
              ids,
            )
          }

          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            success(`已关联：这条对话 → 「${todo.title}」`, {
              todoId: todo.id,
              title: todo.title,
              binding: { state: 'verified', toolId, sessionId },
              degraded: true,
              degradedReason: 'bridge_unavailable',
            }),
            ids,
          )
        }

        // 没有 session_id：写 probe（purpose=link），由回扫把当前会话绑上来
        if (!flags.scanEnabled) {
          return finish(
            runtime,
            'link_session',
            toolId,
            startedAt,
            failure(
              'TICK_E_SCAN_DISABLED',
              '扫描已关闭且没有显式 session_id',
              '打开 Tick 的扫描开关，或显式传 session_id',
              false,
            ),
            ids,
          )
        }

        let handle = findReusableProbe(runtime.home, todo.id)?.handle
        if (!handle) {
          handle = newHandle()
          const probeAt = Date.now()
          const probeClient = probeClientInfo(server, ctx)
          const probe: ProbeRecord = {
            version: 1,
            handle,
            purpose: 'link',
            todoId: todo.id,
            toolId,
            ...(probeClient ? { clientInfo: probeClient } : {}),
            ...(args.cwd ? { cwd: args.cwd } : {}),
            at: new Date(probeAt).toISOString(),
            expiresAt: new Date(probeAt + PROBE_TTL_MS).toISOString(),
            pid: process.pid,
            ...(args.request_id ? { requestId: args.request_id } : {}),
          }
          if (!writeProbeSafely(runtime.home, probe)) {
            return finish(
              runtime,
              'link_session',
              toolId,
              startedAt,
              failure('TICK_E_INTERNAL', '无法写入绑定句柄', '稍后重试；若持续失败请上报日志', false),
              ids,
            )
          }
        }
        ensureScans(state, runtime)

        return finish(
          runtime,
          'link_session',
          toolId,
          startedAt,
          success(`正在把当前对话关联到「${todo.title}」…（Tick 绑定句柄：${handle}）`, {
            todoId: todo.id,
            title: todo.title,
            handle,
            binding: { state: 'pending' },
            degraded: true,
            degradedReason: 'bridge_unavailable',
          }),
          ids,
        )
      } catch (error) {
        return finish(runtime, 'link_session', toolId, startedAt, fromError(error), ids)
      }
    },
  )
}
