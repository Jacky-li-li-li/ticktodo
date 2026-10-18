#!/usr/bin/env node
/**
 * check-client.mjs — 用真实的 MCP 客户端库（@earendil-works/pi-mcp）验证 server.mjs。
 *
 * 为什么用库而不是裸 socket：要证明这不是"自说自话"——McpClient 会做协议校验
 * （initialize result 形状、tools/list 形状、CallToolResult 形状、协议版本白名单），
 * 任何一处不符合 MCP 规范这里都会直接抛错。
 *
 * 运行：node scripts/mcp-spike/check-client.mjs
 * 退出码：全部 PASS → 0；任一 FAIL → 1。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { McpClient, StdioTransport } from '@earendil-works/pi-mcp'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, 'server.mjs')
const ROOT = path.resolve(HERE, '..', '..')
const RUN_ROOT = path.join(process.env.TICK_SPIKE_TMP || '/tmp/tick-spike', `check-${process.pid}`)
const NODE = process.execPath

// ---------- 断言框架 ----------
const results = []
let failed = 0

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`)
  } catch (err) {
    failed++
    results.push({ name, ok: false, detail: err?.message ?? String(err) })
    console.log(`FAIL  ${name}  — ${err?.message ?? String(err)}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

function freshHome(tag) {
  const home = path.join(RUN_ROOT, tag)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  return home
}

function readTodos(home) {
  const file = path.join(home, 'data', 'todos.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function todosFile(home) {
  return path.join(home, 'data', 'todos.json')
}

// ---------- 真实客户端实例 ----------
async function openClient({ home, env = {}, capture, logFile, name = 'tick-spike-check', version = '0.0.1' }) {
  const client = new McpClient({
    name,
    version,
    capabilities: { roots: { listChanged: false } },
    roots: [{ uri: 'file://' + path.join(os.tmpdir(), 'tick-spike'), name: 'tick-spike' }],
    requestTimeoutMs: 15000,
  })
  const stderrChunks = []
  const transport = new StdioTransport({
    command: NODE,
    args: [SERVER],
    cwd: ROOT,
    env: {
      ...process.env,
      TICK_HOME: home,
      ...(capture ? { TICK_MCP_CAPTURE: capture } : {}),
      ...(logFile ? { TICK_MCP_LOG: logFile } : {}),
      ...env,
    },
    stderr: 'pipe',
    onStderr: (chunk) => stderrChunks.push(chunk),
  })
  await client.connect(transport)
  return {
    client,
    transport,
    stderr: () => stderrChunks.join(''),
    close: async () => {
      await client.close().catch(() => {})
    },
  }
}

// ---------- 裸 stdio 进程（验证传输卫生 / 协议边界） ----------
class RawServer {
  constructor({ home, env = {}, logFile }) {
    this.home = home
    this.env = { ...env }
    this.logFile = logFile
    this.stdout = ''
    this.stderrText = ''
    this.lines = []
    this.nextId = 1
    this.pending = new Map()
    this.proc = null
    this.exit = null
  }

  async start() {
    const env = { ...process.env, TICK_HOME: this.home, ...this.env }
    if (this.logFile) env.TICK_MCP_LOG = this.logFile
    else delete env.TICK_MCP_LOG
    this.proc = spawn(NODE, [SERVER], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.exit = new Promise((resolve) => this.proc.on('exit', (code, signal) => resolve({ code, signal })))
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      this.stdout += chunk
      let idx
      while ((idx = this.stdout.indexOf('\n')) !== -1) {
        const line = this.stdout.slice(0, idx)
        this.stdout = this.stdout.slice(idx + 1)
        if (line.trim() === '') continue
        this.lines.push(line)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue // 卫生断言会把它抓出来
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          resolve(msg)
        }
      }
    })
    this.proc.stderr.on('data', (chunk) => {
      this.stderrText += chunk
    })
    await new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve)
      this.proc.once('error', reject)
    })
    return this
  }

  send(message) {
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  notify(method, params) {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`raw 请求超时：${method} (id=${id})`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer)
          resolve(msg)
        },
      })
      this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    })
  }

  initialize(protocolVersion = '2025-11-25', name = 'tick-spike-raw') {
    return this.request('initialize', {
      protocolVersion,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name, version: '0.0.0' },
    })
  }

  async close() {
    this.proc.stdin.end()
    const timer = new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout', signal: null }), 5000))
    const result = await Promise.race([this.exit, timer])
    if (result.code === 'timeout' && this.proc.exitCode === null) this.proc.kill('SIGKILL')
    return result
  }
}

// ---------- 断言正文 ----------
console.log(`tick-spike MCP client check  root=${ROOT}`)
console.log(`server=${SERVER}`)
console.log(`run dir=${RUN_ROOT}\n`)

const home = freshHome('main')
const captureFile = path.join(RUN_ROOT, 'capture-main.json')
const logFile = path.join(RUN_ROOT, 'server.log')
const ctx = await openClient({ home, capture: captureFile, logFile })

let todoA
let todoB
let todoC

await check('initialize：serverInfo.name=tick-spike / version=0.0.1 / instructions 非空', () => {
  assertEqual(ctx.client.serverInfo?.name, 'tick-spike', 'serverInfo.name')
  assertEqual(ctx.client.serverInfo?.version, '0.0.1', 'serverInfo.version')
  assert(typeof ctx.client.instructions === 'string' && ctx.client.instructions.length > 0, 'instructions 为空')
  return `name=${ctx.client.serverInfo.name} version=${ctx.client.serverInfo.version}`
})

await check('协议版本协商：客户端请求 2025-11-25 → 原样回显', () => {
  assertEqual(ctx.client.protocolVersion, '2025-11-25', 'protocolVersion')
  return ctx.client.protocolVersion
})

await check('capabilities.tools.listChanged === false', () => {
  assertEqual(ctx.client.serverCapabilities?.tools?.listChanged, false, 'capabilities.tools.listChanged')
  return JSON.stringify(ctx.client.serverCapabilities)
})

await check('tools/list：3 个工具，名字/annotations/inputSchema 均符合预期', async () => {
  const tools = await ctx.client.listTools()
  assertEqual(tools.length, 3, '工具数量')
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  assertEqual(
    JSON.stringify(Object.keys(byName).sort()),
    JSON.stringify(['create_todo', 'link_session', 'list_todos']),
    '工具名集合',
  )
  const expected = {
    create_todo: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    list_todos: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    link_session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }
  for (const [name, annotations] of Object.entries(expected)) {
    const tool = byName[name]
    assert(tool, `缺少工具 ${name}`)
    assertEqual(tool.inputSchema?.type, 'object', `${name}.inputSchema.type`)
    for (const [key, value] of Object.entries(annotations)) {
      assertEqual(tool.annotations?.[key], value, `${name}.annotations.${key}`)
    }
  }
  assertEqual(JSON.stringify(byName.create_todo.inputSchema.required), JSON.stringify(['title']), 'create_todo.required')
  return '3 tools · annotations ok'
})

await check('create_todo：建成 1 条，todos.json 落盘，binding.toolId/sessionId 正确', async () => {
  const res = await ctx.client.callTool('create_todo', {
    title: 'spike-A：MCP 建的线索',
    body: '来自 check-client.mjs',
    session_id: 'sess-A',
    tool_id: 'pi',
    cwd: '/tmp/tick-spike/workspace',
    request_id: 'req-A',
  })
  assertEqual(res.isError, false, 'isError')
  assertEqual(res.structuredContent?.created, true, 'structuredContent.created')
  assertEqual(res.structuredContent?.bound, true, 'structuredContent.bound')
  assertEqual(res.structuredContent?.title, 'spike-A：MCP 建的线索', 'structuredContent.title')
  assert(/^[0-9a-f-]{36}$/.test(res.structuredContent?.todoId ?? ''), 'todoId 不是 UUID')

  const file = readTodos(home)
  assertEqual(file?.todos?.length, 1, 'todos.json 条数')
  const todo = file.todos[0]
  assertEqual(todo.id, res.structuredContent.todoId, 'todo.id 与 structuredContent.todoId')
  assertEqual(todo.status, 'open', 'todo.status')
  assertEqual(todo.bindings.length, 1, 'bindings 数量')
  assertEqual(todo.bindings[0].toolId, 'pi', 'binding.toolId')
  assertEqual(todo.bindings[0].sessionId, 'sess-A', 'binding.sessionId')
  assertEqual(todo.bindings[0].state, 'verified', 'binding.state')
  assertEqual(todo.primarySessionId, 'sess-A', 'primarySessionId')
  assertEqual(todo.requestId, 'req-A', 'requestId')
  todoA = todo
  return `id=${todo.id} bindings=${JSON.stringify(todo.bindings.map((b) => b.toolId + '/' + b.sessionId))}`
})

await check('幂等（session_id）：同会话再 create → created=false，总数仍为 1', async () => {
  const res = await ctx.client.callTool('create_todo', {
    title: 'spike-A 重复调用',
    session_id: 'sess-A',
    tool_id: 'pi',
  })
  assertEqual(res.isError, false, 'isError')
  assertEqual(res.structuredContent?.created, false, 'created')
  assertEqual(res.structuredContent?.todoId, todoA.id, '返回既有 todoId')
  assertEqual(readTodos(home).todos.length, 1, 'todos.json 条数')
  return `created=false todoId=${res.structuredContent.todoId}`
})

await check('幂等（request_id）：重复 request_id → created=false，总数不变', async () => {
  const first = await ctx.client.callTool('create_todo', {
    title: 'spike-reqid',
    request_id: 'req-1',
  })
  assertEqual(first.structuredContent?.created, true, '首次 created')
  assertEqual(readTodos(home).todos.length, 2, '首次后条数')
  const second = await ctx.client.callTool('create_todo', {
    title: 'spike-reqid 换标题但同幂等键',
    request_id: 'req-1',
  })
  assertEqual(second.structuredContent?.created, false, '重复 created')
  assertEqual(second.structuredContent?.todoId, first.structuredContent.todoId, '重复返回同一 todoId')
  assertEqual(readTodos(home).todos.length, 2, '重复后条数')
  return `requestId=req-1 todoId=${first.structuredContent.todoId}`
})

await check('list_todos：能读到上面两条（status=all）', async () => {
  const res = await ctx.client.callTool('list_todos', { status: 'all' })
  assertEqual(res.isError, false, 'isError')
  assertEqual(res.structuredContent?.count, 2, 'count')
  const titles = res.structuredContent.todos.map((t) => t.title)
  assert(titles.includes('spike-A：MCP 建的线索'), '缺少 spike-A')
  assert(titles.includes('spike-reqid'), '缺少 spike-reqid')
  assert(Array.isArray(res.content) && res.content[0]?.type === 'text' && res.content[0].text.length > 0, 'text 摘要为空')
  return `count=${res.structuredContent.count}`
})

await check('list_todos：status/limit 过滤生效（open + limit=1）', async () => {
  const res = await ctx.client.callTool('list_todos', { status: 'open', limit: 1 })
  assertEqual(res.isError, false, 'isError')
  assertEqual(res.structuredContent?.count, 1, 'count')
  assertEqual(res.structuredContent.todos.length, 1, 'todos.length')
  return `count=${res.structuredContent.count}`
})

await check('准备第二/第三条 todo（不绑定会话）', async () => {
  const b = await ctx.client.callTool('create_todo', { title: 'spike-B：待绑定' })
  const c = await ctx.client.callTool('create_todo', { title: 'spike-C：不该被绑' })
  assertEqual(b.structuredContent?.created, true, 'B created')
  assertEqual(c.structuredContent?.created, true, 'C created')
  todoB = readTodos(home).todos.find((t) => t.id === b.structuredContent.todoId)
  todoC = readTodos(home).todos.find((t) => t.id === c.structuredContent.todoId)
  assertEqual(readTodos(home).todos.length, 4, 'todos.json 条数')
  return `B=${todoB.id.slice(0, 8)} C=${todoC.id.slice(0, 8)}`
})

await check('link_session：把 sess-B 绑到第二条 todo 成功', async () => {
  const res = await ctx.client.callTool('link_session', {
    todo_id: todoB.id,
    session_id: 'sess-B',
    tool_id: 'claude-code',
    cwd: '/tmp/tick-spike/workspace',
  })
  assertEqual(res.isError, false, 'isError')
  assertEqual(res.structuredContent?.ok, true, 'ok')
  assertEqual(res.structuredContent?.todoId, todoB.id, 'todoId')
  assertEqual(res.structuredContent?.bound?.sessionId, 'sess-B', 'bound.sessionId')
  assertEqual(res.structuredContent?.bound?.toolId, 'claude-code', 'bound.toolId')

  const file = readTodos(home)
  const b = file.todos.find((t) => t.id === todoB.id)
  assertEqual(b.bindings.length, 1, 'B bindings')
  assertEqual(b.primarySessionId, 'sess-B', 'B primarySessionId')

  // 再调一次应幂等（不新增 binding）
  const again = await ctx.client.callTool('link_session', { todo_id: todoB.id, session_id: 'sess-B' })
  assertEqual(again.isError, false, '幂等调用 isError')
  const b2 = readTodos(home).todos.find((t) => t.id === todoB.id)
  assertEqual(b2.bindings.length, 1, '幂等后 B bindings')
  return `bound=${JSON.stringify(res.structuredContent.bound)}`
})

await check('link_session：同 session 绑第三条 → isError 且指出已绑定到「spike-B」', async () => {
  const res = await ctx.client.callTool('link_session', { todo_id: todoC.id, session_id: 'sess-B' })
  assertEqual(res.isError, true, 'isError')
  const text = res.content?.[0]?.text ?? ''
  assert(text.includes('已绑定到「spike-B：待绑定」'), `错误文案未指出归属：${text}`)
  todoC = readTodos(home).todos.find((t) => t.id === todoC.id)
  assertEqual(todoC.bindings.length, 0, 'C 不应被写入 binding')
  return text.slice(0, 80)
})

await check('TICK_MCP_READONLY=1：独立实例 create_todo 返回 isError，list 仍可读', async () => {
  const roHome = freshHome('readonly')
  const ro = await openClient({ home: roHome, env: { TICK_MCP_READONLY: '1' } })
  try {
    const write = await ro.client.callTool('create_todo', { title: 'readonly 不该落盘' })
    assertEqual(write.isError, true, 'create_todo isError')
    assert(String(write.content?.[0]?.text ?? '').includes('TICK_MCP_READONLY'), '错误文案应说明只读')
    assertEqual(readTodos(roHome), null, '只读实例不应创建 todos.json')

    const read = await ro.client.callTool('list_todos', { status: 'all' })
    assertEqual(read.isError, false, 'list_todos 应可用')
    assertEqual(read.structuredContent?.count, 0, '只读实例 count')

    const link = await ro.client.callTool('link_session', { todo_id: 'nope', session_id: 'x' })
    assertEqual(link.isError, true, 'link_session isError')
  } finally {
    await ro.close()
  }
  return 'create/link blocked · list ok'
})

await check('环境变量回落：TICK_AGENT_SESSION / TICK_AGENT_TOOL 在缺省参数时生效', async () => {
  const envHome = freshHome('env')
  const c = await openClient({ home: envHome, env: { TICK_AGENT_SESSION: 'sess-env', TICK_AGENT_TOOL: 'pi-env' } })
  try {
    const res = await c.client.callTool('create_todo', { title: 'env-session-todo' })
    assertEqual(res.isError, false, 'isError')
    assertEqual(res.structuredContent?.bound, true, 'bound（应回落到 env session）')
    const file = readTodos(envHome)
    assertEqual(file.todos.length, 1, 'todos 条数')
    assertEqual(file.todos[0].bindings[0].sessionId, 'sess-env', 'binding.sessionId')
    assertEqual(file.todos[0].bindings[0].toolId, 'pi-env', 'binding.toolId')
    assertEqual(file.todos[0].primarySessionId, 'sess-env', 'primarySessionId')
  } finally {
    await c.close()
  }
  return 'env session/tool 生效'
})

await check('capture：initialize params 落文件，clientInfo.name 已记录', () => {
  assert(fs.existsSync(captureFile), `capture 文件不存在：${captureFile}`)
  const captured = JSON.parse(fs.readFileSync(captureFile, 'utf8'))
  assertEqual(captured.params?.clientInfo?.name, 'tick-spike-check', 'clientInfo.name')
  assertEqual(captured.params?.protocolVersion, '2025-11-25', 'protocolVersion')
  assert(captured.params?.capabilities?.roots, 'capture 缺少 roots capability')
  return `clientInfo=${JSON.stringify(captured.params.clientInfo)}`
})

await check('日志路由：TICK_MCP_LOG 文件有日志，stderr 不含日志/JSON-RPC', () => {
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  assert(log.includes('initialize requested='), '日志文件缺少 initialize 记录')
  assert(log.includes('create_todo created='), '日志文件缺少 create_todo 记录')
  const stderr = ctx.stderr()
  assert(!stderr.includes('[tick-spike'), `TICK_MCP_LOG 已设置但 stderr 仍有日志：${stderr.slice(0, 200)}`)
  assert(!/"jsonrpc"\s*:/.test(stderr), 'stderr 出现 JSON-RPC 应答')
  return `log=${path.basename(logFile)} (${log.split('\n').length} lines) stderr=${stderr.length}B`
})

// ---------- 裸传输卫生 + 协议边界 ----------
const rawHome = freshHome('raw')

await check('stdout 卫生：每行都是合法 JSON-RPC，未知方法 -32601，未知工具 isError', async () => {
  const raw = await new RawServer({ home: rawHome }).start()
  try {
    const init = await raw.initialize('2025-11-25', 'tick-spike-raw-hygiene')
    assertEqual(init.result?.serverInfo?.name, 'tick-spike', 'raw initialize')
    raw.notify('notifications/initialized')

    const list = await raw.request('tools/list')
    assertEqual(list.result?.tools?.length, 3, 'raw tools/list')

    const created = await raw.request('tools/call', {
      name: 'create_todo',
      arguments: { title: 'hygiene-1', session_id: 'sess-raw' },
    })
    assertEqual(created.result?.isError, false, 'raw create isError')
    assertEqual(created.result?.structuredContent?.created, true, 'raw create created')

    const pong = await raw.request('ping')
    assertEqual(JSON.stringify(pong.result), '{}', 'ping result')

    const unknownMethod = await raw.request('resources/list')
    assertEqual(unknownMethod.error?.code, -32601, '未知方法错误码')

    const unknownTool = await raw.request('tools/call', { name: 'delete_everything', arguments: {} })
    assertEqual(unknownTool.result?.isError, true, '未知工具应返回 isError')

    const exit = await raw.close()
    assertEqual(exit.code, 0, 'stdin 关闭后退出码')

    // stdout 每一行都必须是 JSON-RPC 2.0；日志/调试输出混进来会在这里挂掉
    assert(raw.lines.length >= 6, `stdout 应答行数过少：${raw.lines.length}`)
    for (const [i, line] of raw.lines.entries()) {
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        throw new Error(`stdout 第 ${i + 1} 行不是 JSON：${line.slice(0, 120)}`)
      }
      assertEqual(msg.jsonrpc, '2.0', `stdout 第 ${i + 1} 行 jsonrpc`)
      assert('id' in msg, `stdout 第 ${i + 1} 行缺少 id`)
    }
    assert(!raw.lines.some((l) => l.includes('[tick-spike')), 'stdout 混入日志行')

    // 未设置 TICK_MCP_LOG 时日志走 stderr：应有日志，但绝不能有 JSON-RPC 应答
    assert(raw.stderrText.includes('[tick-spike'), 'stderr 缺少日志（缺省应写 stderr）')
    assert(!/"jsonrpc"\s*:/.test(raw.stderrText), 'stderr 出现 JSON-RPC 应答')
    assert(!/"result"\s*:/.test(raw.stderrText), 'stderr 出现 JSON-RPC result')
    return `${raw.lines.length} 行 JSON-RPC · exit=${exit.code} · stderr=${raw.stderrText.length}B（无 JSON-RPC）`
  } finally {
    if (raw.proc?.exitCode === null) raw.proc.kill('SIGKILL')
  }
})

await check('协议协商降级：请求 2099-12-31 → 回 2025-11-25；请求 2024-11-05 → 原样回显', async () => {
  const a = await new RawServer({ home: freshHome('neg-a'), logFile: path.join(RUN_ROOT, 'neg-a.log') }).start()
  try {
    const res = await a.initialize('2099-12-31')
    assertEqual(res.result?.protocolVersion, '2025-11-25', '未知版本应降级')
  } finally {
    await a.close()
  }
  const b = await new RawServer({ home: freshHome('neg-b'), logFile: path.join(RUN_ROOT, 'neg-b.log') }).start()
  try {
    const res = await b.initialize('2024-11-05')
    assertEqual(res.result?.protocolVersion, '2024-11-05', '支持的版本应回显')
  } finally {
    await b.close()
  }
  return '2099-12-31→2025-11-25 · 2024-11-05→2024-11-05'
})

await check('initialize 之前的请求返回 -32002 且不崩，之后仍可 initialize', async () => {
  const raw = await new RawServer({ home: freshHome('preinit') }).start()
  try {
    const early = await raw.request('tools/list')
    assertEqual(early.error?.code, -32002, '初始化前请求错误码')
    const init = await raw.initialize('2025-06-18')
    assertEqual(init.result?.serverInfo?.name, 'tick-spike', '初始化仍然成功')
    const list = await raw.request('tools/list')
    assertEqual(list.result?.tools?.length, 3, '初始化后 tools/list')
    const exit = await raw.close()
    assertEqual(exit.code, 0, '退出码')
    return 'early=-32002 · then initialize ok'
  } finally {
    if (raw.proc?.exitCode === null) raw.proc.kill('SIGKILL')
  }
})

await ctx.close()

// ---------- 汇总 ----------
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} PASS${failed ? ` · ${failed} FAIL` : ''}`)
if (failed) {
  console.log('\n失败明细：')
  for (const r of results.filter((x) => !x.ok)) console.log(`- ${r.name}: ${r.detail}`)
  process.exit(1)
}
console.log('全部通过。')
process.exit(0)
