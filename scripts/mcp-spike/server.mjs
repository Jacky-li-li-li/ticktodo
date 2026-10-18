#!/usr/bin/env node
/**
 * tick-spike MCP stdio server — 零依赖技术验证。
 *
 * 目的：验证「把 Tick 的 todos.json 领域写盘协议暴露成一个 MCP server」是否可行，
 * 以及真实客户端（pi / Claude Code）在 stdio 传输上到底能告诉 server 什么
 * （clientInfo、capabilities、能否拿到会话 id）。
 *
 * 传输：newline-delimited JSON-RPC 2.0（MCP stdio 的规定，每行一条消息，消息内不得含换行）。
 * ⚠️ stdout 只允许 JSON-RPC。所有日志走 TICK_MCP_LOG 或 stderr。
 *
 * 写盘协议逐字复用 packages/tick-extension/src/todos-file.ts 的语义（这是本 spike 的核心断言）：
 *   - 锁文件 = `<todos.json>.lock`（不能改名，Main 侧 services/storage.ts 用同一个名字）
 *   - O_EXCL 创建锁文件，内容 = `<pid>:<uuid>` token；释放只删自己 token 的锁
 *   - 锁 mtime 超过 5s 视为陈旧锁强夺
 *   - tmp + fsync + rename 原子写；损坏先备份 `<file>.corrupt-<ts>`
 *   - requestId / 同 sessionId 幂等（命中不写文件，避免触发 Main 的 fs.watch）
 *
 * 不 import 仓库内任何模块：pi 用 jiti 在无 node_modules 的目录里执行扩展，
 * 这个 server 未来也可能被同样的方式拉起，所以保持零依赖单文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------- 协议常量 ----------
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_VERSION = '2025-11-25'
const SERVER_INFO = { name: 'tick-spike', version: '0.0.1' }
const INSTRUCTIONS =
  '把 AI 会话里产生的线索写进 Tick 的 todos.json；stdin 关闭即退出，stdout 只有 JSON-RPC。'

const LOCK_TIMEOUT_MS = 5000

// ---------- 日志（绝不写 stdout） ----------
const LOG_FILE = process.env.TICK_MCP_LOG?.trim() || ''
let logFileReady = false

function writeLog(line) {
  const text = `[tick-spike ${new Date().toISOString()} pid=${process.pid}] ${line}\n`
  if (LOG_FILE) {
    try {
      if (!logFileReady) {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 })
        logFileReady = true
      }
      fs.appendFileSync(LOG_FILE, text)
      return
    } catch (err) {
      process.stderr.write(`[tick-spike] 日志文件不可写（${LOG_FILE}）：${String(err)}\n`)
    }
  }
  try {
    process.stderr.write(text)
  } catch {
    /* stderr 也坏了就彻底静默：绝不能把日志写进 stdout */
  }
}

function log(...parts) {
  writeLog(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))
}

// ---------- 配置 ----------
function resolveTickHome() {
  return process.env.TICK_HOME?.trim() || path.join(os.homedir(), '.ticktodo')
}

function todosFilePath(home = resolveTickHome()) {
  return path.join(home, 'data', 'todos.json')
}

const READONLY = process.env.TICK_MCP_READONLY === '1'
const HOME = resolveTickHome()
const TODOS_FILE = todosFilePath(HOME)

// ---------- todos.json 领域协议（逐字复用 todos-file.ts 的语义） ----------

function backupCorrupt(file) {
  try {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, backup)
    try {
      fs.chmodSync(backup, 0o600)
    } catch {
      /* 忽略 */
    }
    return backup
  } catch {
    return undefined
  }
}

/**
 * 解析失败时先备份再返回空表；只读路径（list_todos）不备份，避免读产生副作用。
 * 返回的 todos 保持文件中顺序（协议不排序，排序是 UI 的事）。
 */
function readFileStrict(file, backupOnCorrupt = false) {
  if (!fs.existsSync(file)) return { version: 1, todos: [] }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.todos)) {
      if (backupOnCorrupt) log(`todos.json 结构非法，已备份：${backupCorrupt(file) ?? file}`)
      return { version: 1, todos: [] }
    }
    return { version: 1, todos: parsed.todos }
  } catch (err) {
    if (backupOnCorrupt) log(`todos.json 解析失败，已备份：${backupCorrupt(file) ?? '失败'}`, String(err))
    return { version: 1, todos: [] }
  }
}

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* 忽略 */
  }
}

function acquireLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const start = Date.now()
  for (;;) {
    const token = `${process.pid}:${randomUUID()}`
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 })
      return token
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      try {
        const st = fs.statSync(lockPath)
        if (Date.now() - st.mtimeMs > timeoutMs) {
          fs.rmSync(lockPath, { force: true })
          continue
        }
      } catch {
        continue
      }
      // 5s 都抢不到就抛错，绝不能"无锁继续写"（那正是丢写的来源）
      if (Date.now() - start > timeoutMs) throw new Error(`todos.json 被锁定超过 ${timeoutMs}ms`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
}

function releaseLock(lockPath, token) {
  try {
    if (fs.readFileSync(lockPath, 'utf8') !== token) return
    fs.rmSync(lockPath, { force: true })
  } catch {
    /* 忽略 */
  }
}

function withLockedFile(file, fn) {
  // 首次运行时 data/ 还不存在：ENOENT 不是"抢不到锁"
  const ensureDir = file
  fs.mkdirSync(path.dirname(ensureDir), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.lock`
  const token = acquireLock(lockPath)
  try {
    const data = readFileStrict(file, true)
    const { result, dirty } = fn(data)
    if (dirty) writeFileAtomic(file, data)
    return result
  } finally {
    releaseLock(lockPath, token)
  }
}

// ---------- 会话身份 ----------
// MCP stdio 传输本身没有"会话 id"字段；server 能拿到的稳定身份只有两样：
//   1) 启动时注入的环境变量（TICK_AGENT_SESSION / TICK_AGENT_TOOL）
//   2) initialize 的 clientInfo.name（客户端类型，不是会话实例）
// 这是本 spike 要证明/证伪的关键点，见 README「设计约束」。
let clientInfo = { name: 'unknown' }
let clientCapabilities = {}
let negotiatedVersion = FALLBACK_VERSION
let initialized = false
let sawInitializedNotification = false

function resolveToolId(input) {
  const fromInput = typeof input === 'string' ? input.trim() : ''
  if (fromInput) return fromInput
  const fromEnv = process.env.TICK_AGENT_TOOL?.trim()
  if (fromEnv) return fromEnv
  if (clientInfo?.name) return clientInfo.name
  return 'mcp'
}

function resolveSessionId(input) {
  if (typeof input === 'string' && input.trim()) return input.trim()
  const fromEnv = process.env.TICK_AGENT_SESSION?.trim()
  if (fromEnv) return fromEnv
  return undefined
}

// ---------- 工具实现 ----------
function okResult(structuredContent, text) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: false,
  }
}

function errResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function parseArgs(args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments 必须是对象')
  return args
}

function toolCreateTodo(rawArgs) {
  if (READONLY) return errResult('TICK_MCP_READONLY=1：create_todo 已禁用（只读实例不写 todos.json）')
  const args = parseArgs(rawArgs)
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) return errResult('标题为空不可保存：请传非空 title')

  const body = typeof args.body === 'string' ? args.body.trim() || undefined : undefined
  const sessionId = resolveSessionId(args.session_id)
  const toolId = resolveToolId(args.tool_id)
  const cwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
  const requestId = typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : undefined

  if (cwd) log(`create_todo cwd=${cwd}（Todo 类型没有 cwd 字段，仅记日志，不落盘）`)

  const outcome = withLockedFile(TODOS_FILE, (data) => {
    const now = new Date().toISOString()

    // 幂等 1：requestId 命中 → 直接返回既有条目（不写文件）
    if (requestId) {
      const byRequest = data.todos.find((t) => t.requestId === requestId)
      if (byRequest) {
        const bound = sessionId ? byRequest.bindings.some((b) => b.sessionId === sessionId) : false
        return { result: { todo: byRequest, created: false, bound, reason: 'requestId' }, dirty: false }
      }
    }

    // 幂等 2：同 session 已绑过 todo → 返回既有那条，不新建（一个会话最多一条线索）
    if (sessionId) {
      const bySession = data.todos.find((t) => (t.bindings ?? []).some((b) => b.sessionId === sessionId))
      if (bySession) {
        return { result: { todo: bySession, created: false, bound: true, reason: 'sessionId' }, dirty: false }
      }
    }

    const todo = {
      id: randomUUID(),
      title,
      body,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      bindings: sessionId
        ? [{ toolId, sessionId, boundAt: now, state: 'verified' }]
        : [],
      primarySessionId: sessionId,
      // source 的联合类型只有 panel|pi：MCP 来源目前无法与 pi 区分（见 README 差距）
      source: 'pi',
      requestId,
    }
    data.todos.push(todo)
    return { result: { todo, created: true, bound: Boolean(sessionId), reason: 'created' }, dirty: true }
  })

  const { todo, created, bound, reason } = outcome
  const suffix = sessionId
    ? `，会话 ${sessionId.slice(0, 8)}（toolId=${toolId}）`
    : '，未绑定会话'
  const text = created
    ? `已创建线索「${todo.title}」（${todo.id}）${suffix}`
    : `已存在线索「${todo.title}」（${todo.id}），未重复创建（幂等键命中：${reason}）${suffix}`

  log(`create_todo created=${created} id=${todo.id} reason=${reason} bound=${bound} toolId=${toolId} session=${sessionId ?? '-'}`)
  return okResult(
    { todoId: todo.id, title: todo.title, created, bound },
    text,
  )
}

function toolListTodos(rawArgs) {
  const args = parseArgs(rawArgs)
  const status = args.status ?? 'open'
  if (!['open', 'done', 'all'].includes(status)) {
    return errResult(`status 只能是 open|done|all，收到 ${JSON.stringify(status)}`)
  }
  let limit = 50
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1) {
      return errResult('limit 必须是 >=1 的数字')
    }
    limit = Math.min(Math.floor(args.limit), 500)
  }

  const all = readFileStrict(TODOS_FILE).todos
  const filtered = status === 'all' ? all : all.filter((t) => t.status === status)
  const todos = filtered.slice(0, limit).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    primarySessionId: t.primarySessionId,
    bindings: (t.bindings ?? []).map((b) => ({ toolId: b.toolId, sessionId: b.sessionId, state: b.state })),
  }))

  const lines = [`共 ${todos.length} 条（status=${status}，limit=${limit}，总表 ${all.length} 条）`]
  for (const t of todos) {
    const bind = t.primarySessionId ? ` · 会话 ${t.primarySessionId.slice(0, 8)}` : ''
    lines.push(`- [${t.status}] ${t.title}（${t.id.slice(0, 8)}）${bind}`)
  }
  log(`list_todos status=${status} limit=${limit} count=${todos.length} total=${all.length}`)
  return okResult({ count: todos.length, todos }, lines.join('\n'))
}

function toolLinkSession(rawArgs) {
  if (READONLY) return errResult('TICK_MCP_READONLY=1：link_session 已禁用（只读实例不写 todos.json）')
  const args = parseArgs(rawArgs)
  const todoId = typeof args.todo_id === 'string' ? args.todo_id.trim() : ''
  if (!todoId) return errResult('todo_id 必填')
  const sessionId = resolveSessionId(args.session_id)
  if (!sessionId) return errResult('session_id 必填（或启动 server 时设置 TICK_AGENT_SESSION）')
  const toolId = resolveToolId(args.tool_id)

  const outcome = withLockedFile(TODOS_FILE, (data) => {
    const todo = data.todos.find((t) => t.id === todoId)
    if (!todo) return { result: { error: `todo 不存在：${todoId}` }, dirty: false }

    // 一个 session 最多绑一条 todo（业务规则 4）→ 明确告诉模型它已经绑到哪条
    const owner = data.todos.find(
      (t) => t.id !== todoId && (t.bindings ?? []).some((b) => b.sessionId === sessionId),
    )
    if (owner) {
      return {
        result: { error: `会话 ${sessionId.slice(0, 8)} 已绑定到「${owner.title}」，一个会话只能绑一条线索` },
        dirty: false,
      }
    }

    const existing = (todo.bindings ?? []).find((b) => b.sessionId === sessionId)
    if (existing) {
      // 幂等：已绑同一条 → 不改写文件
      return { result: { ok: true, todo, binding: existing, changed: false }, dirty: false }
    }

    const now = new Date().toISOString()
    const binding = { toolId, sessionId, boundAt: now, state: 'verified' }
    todo.bindings = [...(todo.bindings ?? []), binding]
    if (!todo.primarySessionId) todo.primarySessionId = sessionId
    todo.updatedAt = now
    return { result: { ok: true, todo, binding, changed: true }, dirty: true }
  })

  if (outcome.error) {
    log(`link_session 失败 todo=${todoId} session=${sessionId}：${outcome.error}`)
    return errResult(outcome.error)
  }
  const { todo, binding, changed } = outcome
  log(`link_session ok todo=${todo.id} session=${sessionId} toolId=${toolId} changed=${changed}`)
  return okResult(
    {
      ok: true,
      todoId: todo.id,
      bound: { toolId: binding.toolId, sessionId: binding.sessionId, boundAt: binding.boundAt, state: binding.state },
    },
    changed
      ? `已把会话 ${sessionId.slice(0, 8)} 绑定到「${todo.title}」（toolId=${toolId}）`
      : `会话 ${sessionId.slice(0, 8)} 本就绑定在「${todo.title}」上，未做改动`,
  )
}

// ---------- 工具清单（JSON Schema + annotations） ----------
const TOOLS = [
  {
    name: 'create_todo',
    title: '创建线索',
    description:
      '在 Tick 的 todos.json 里创建一条 todo；给了 session_id 就同时写入会话绑定。' +
      '幂等：同 request_id 或同 session_id 重复调用返回既有条目且不写文件。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '线索标题（必填，空串会被拒绝）' },
        body: { type: 'string', description: '补充说明（可选）' },
        session_id: { type: 'string', description: '当前 AI 会话 id；缺省时回落到环境变量 TICK_AGENT_SESSION' },
        tool_id: { type: 'string', description: '会话所属工具 id（pi / claude-code / ...）；缺省回落 TICK_AGENT_TOOL / clientInfo.name' },
        cwd: { type: 'string', description: '当前工作目录（仅用于诊断日志；Todo 类型暂无 cwd 字段）' },
        request_id: { type: 'string', description: '幂等键（建议用 conversationId:callId）' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: {
      title: '创建线索',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'list_todos',
    title: '列出线索',
    description: '只读列出 todos.json 中的线索；默认只看 open，limit 默认 50、上限 500。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done', 'all'], description: '默认 open' },
        limit: { type: 'number', minimum: 1, maximum: 500, description: '默认 50' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: '列出线索',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'link_session',
    title: '绑定会话',
    description: '把已有 todo 绑定到一个 AI 会话；同会话已绑别的 todo 时报错并指出归属。',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: '目标 todo id（必填）' },
        session_id: { type: 'string', description: '会话 id（必填；可缺省回落 TICK_AGENT_SESSION）' },
        tool_id: { type: 'string', description: '会话所属工具 id' },
        cwd: { type: 'string', description: '当前工作目录（仅诊断）' },
      },
      required: ['todo_id', 'session_id'],
      additionalProperties: false,
    },
    annotations: {
      title: '绑定会话',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
]

const TOOL_IMPLS = {
  create_todo: toolCreateTodo,
  list_todos: toolListTodos,
  link_session: toolLinkSession,
}

// ---------- JSON-RPC 传输 ----------
function send(message) {
  // 单次 write + 单行：stdout 上不允许出现任何非 JSON-RPC 字节
  process.stdout.write(JSON.stringify(message) + '\n')
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: '2.0', id: id ?? null, error })
}

function captureInitialize(params) {
  const file = process.env.TICK_MCP_CAPTURE?.trim()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const record = {
      capturedAt: new Date().toISOString(),
      serverPid: process.pid,
      argv: process.argv,
      env: {
        TICK_HOME: HOME,
        TICK_AGENT_TOOL: process.env.TICK_AGENT_TOOL ?? null,
        TICK_AGENT_SESSION: process.env.TICK_AGENT_SESSION ?? null,
        TICK_MCP_READONLY: process.env.TICK_MCP_READONLY ?? null,
      },
      params,
      negotiatedProtocolVersion: negotiatedVersion,
    }
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    log(`initialize params 已 capture 到 ${file}`)
  } catch (err) {
    log(`capture 失败（${file}）：${String(err)}`)
  }
}

function negotiateVersion(requested) {
  if (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)) return requested
  return FALLBACK_VERSION
}

function handleInitialize(id, params) {
  const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
  negotiatedVersion = negotiateVersion(requested)
  clientInfo =
    params && params.clientInfo && typeof params.clientInfo === 'object'
      ? { ...params.clientInfo }
      : { name: 'unknown' }
  clientCapabilities =
    params && params.capabilities && typeof params.capabilities === 'object' ? { ...params.capabilities } : {}
  initialized = true

  log(
    `initialize requested=${requested ?? '-'} negotiated=${negotiatedVersion} ` +
      `clientInfo=${JSON.stringify(clientInfo)} capabilities=${JSON.stringify(clientCapabilities)}`,
  )
  captureInitialize(params)

  sendResult(id, {
    protocolVersion: negotiatedVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  })
}

function handleToolsCall(id, params) {
  const name = params && typeof params.name === 'string' ? params.name : ''
  const impl = TOOL_IMPLS[name]
  if (!impl) {
    // 未知工具 = 工具调用级错误（isError），不是 JSON-RPC 方法不存在
    const text = `未知工具：${JSON.stringify(name)}；可用工具：${TOOLS.map((t) => t.name).join(', ')}`
    log(`tools/call 未知工具 ${JSON.stringify(name)}`)
    sendResult(id, errResult(text))
    return
  }
  try {
    sendResult(id, impl(params?.arguments ?? {}))
  } catch (err) {
    // 单个工具内部异常也要变成 isError，而不是让连接崩掉
    log(`tools/call ${name} 异常：${err?.stack ?? String(err)}`)
    sendResult(id, errResult(`${name} 执行失败：${err?.message ?? String(err)}`))
  }
}

function handleRequest(message) {
  const { id, method, params } = message
  const isNotification = id === undefined

  if (method === 'initialize') {
    handleInitialize(id, params)
    return
  }

  // initialize 之前只允许 initialize；其它请求按 MCP 惯例回 -32002（但不能崩）
  if (!initialized) {
    if (isNotification) {
      log(`initialize 之前收到通知 ${JSON.stringify(method)}，忽略`)
      return
    }
    sendError(id, -32002, 'Server not initialized：请先发送 initialize')
    return
  }

  switch (method) {
    case 'notifications/initialized':
      sawInitializedNotification = true
      log('收到 notifications/initialized')
      return // 通知没有 id，不回包
    case 'ping':
      sendResult(id, {})
      return
    case 'tools/list':
      log(`tools/list → ${TOOLS.length} 个工具`)
      sendResult(id, { tools: TOOLS })
      return
    case 'tools/call':
      handleToolsCall(id, params)
      return
    default:
      if (isNotification) {
        log(`未处理的通知 ${JSON.stringify(method)}`)
        return
      }
      sendError(id, -32601, `Method not found: ${method}`)
  }
}

function handleLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch (err) {
    log(`JSON 解析失败：${String(err)}`)
    sendError(null, -32700, 'Parse error：本 server 只接受换行分隔的 JSON-RPC，不支持批量/多行')
    return
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    sendError(message && typeof message === 'object' ? message.id : null, -32600, 'Invalid Request')
    return
  }
  try {
    handleRequest(message)
  } catch (err) {
    log(`处理 ${String(message.method)} 崩溃：${err?.stack ?? String(err)}`)
    if (message.id !== undefined) sendError(message.id, -32603, `Internal error: ${err?.message ?? String(err)}`)
  }
}

// ---------- stdin 循环 ----------
let buffer = ''
let shuttingDown = false

function shutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log(`退出：${reason}`)
  // stdout 是 pipe 时 write 是异步的：先结束再退出，避免截断最后一条应答
  try {
    process.stdout.end(() => process.exit(0))
  } catch {
    process.exit(0)
  }
  // 兜底：极少数情况下 end 的回调不触发
  setTimeout(() => process.exit(0), 250).unref()
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    handleLine(line)
  }
})
process.stdin.on('end', () => {
  if (buffer.trim()) handleLine(buffer)
  buffer = ''
  shutdown('stdin 关闭')
})
process.stdin.on('close', () => shutdown('stdin close'))
process.stdin.on('error', (err) => {
  log(`stdin 错误：${String(err)}`)
  shutdown('stdin error')
})

process.on('uncaughtException', (err) => {
  log(`uncaughtException：${err?.stack ?? String(err)}`)
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log(`unhandledRejection：${String(err)}`)
  process.exit(1)
})

log(
  `启动：home=${HOME} file=${TODOS_FILE} readonly=${READONLY} ` +
    `log=${LOG_FILE || 'stderr'} capture=${process.env.TICK_MCP_CAPTURE || '-'} ` +
    `tool=${process.env.TICK_AGENT_TOOL || '-'} session=${process.env.TICK_AGENT_SESSION || '-'}`,
)
