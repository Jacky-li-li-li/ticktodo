#!/usr/bin/env node
/**
 * Tick MCP server 回归脚本（P0，零产品依赖）。
 *
 * 故意不 import 仓库里的任何包：只通过 stdio 说 MCP，再直接读 `todos.json` 断言落盘结果。
 * 这样它测的是「客户端看到的行为」，而不是实现细节。
 *
 * 覆盖：tools/list 与 annotations、create 幂等（request_id / session）、Tick 未运行时的
 * 句柄回扫（pi 假会话 + WorkBuddy 国内版/国际版假根）、list 不含正文、link 成功/占用、
 * 只读、扫描关闭、错误码。所有 TICK_HOME / HOME / 客户端配置根都在 mkdtemp 里，结束清理。
 *
 * 用法：
 *   node scripts/mcp-check.mjs
 *   MCP_CHECK_VERBOSE=1 node scripts/mcp-check.mjs   # 同时打印 server stderr
 *
 * 退出码：0 = 全 PASS；1 = 有失败（或构建失败）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { McpClient, StdioTransport } from '@earendil-works/pi-mcp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_DIR = path.join(ROOT, 'packages', 'mcp-server')
const SERVER_ENTRY = path.join(PKG_DIR, 'dist', 'tick-mcp.mjs')
const HANDLE_RE = /^tk_[0-9a-hjkmnp-tv-z]{26}$/
const VERBOSE = process.env.MCP_CHECK_VERBOSE === '1'

let passed = 0
let failed = 0
const clients = []

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function checkEqual(label, actual, expected) {
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  )
}

function ensureBuild() {
  if (fs.existsSync(SERVER_ENTRY)) return
  console.log('[mcp-check] dist/tick-mcp.mjs 不存在，先构建…')
  let result = spawnSync('pnpm', ['--filter', '@tick/mcp-server', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0 || !fs.existsSync(SERVER_ENTRY)) {
    result = spawnSync(process.execPath, ['build.mjs'], { cwd: PKG_DIR, stdio: 'inherit' })
  }
  if (result.status !== 0 || !fs.existsSync(SERVER_ENTRY)) {
    console.error('[mcp-check] 构建失败：packages/mcp-server/dist/tick-mcp.mjs 不存在')
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    process.exit(1)
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function readTodos(home) {
  return readJson(path.join(home, 'data', 'todos.json'))?.todos ?? []
}

function findTodo(home, id) {
  return readTodos(home).find((todo) => todo.id === id)
}

function probeCount(home) {
  try {
    return fs.readdirSync(path.join(home, 'cache', 'mcp-pending')).filter((n) => n.endsWith('.json'))
      .length
  } catch {
    return 0
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs = 6_000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = fn()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

/** 每个场景一个隔离根：HOME / TICK_HOME / PI_CODING_AGENT_DIR 都不落真实用户目录 */
function makeContext(name, extraEnv = {}) {
  const base = path.join(TMP_ROOT, name)
  const home = path.join(base, 'home')
  const agentDir = path.join(base, 'pi-agent')
  fs.mkdirSync(path.join(agentDir, 'sessions', '--tmp--'), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  return {
    base,
    home,
    agentDir,
    env: {
      HOME: base,
      TICK_HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...extraEnv,
    },
  }
}

async function startClient(context, clientName = 'pi', clientVersion = '1.3.0') {
  const stderr = []
  const transport = new StdioTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: context.env,
    inheritEnv: false,
    stderr: 'pipe',
    onStderr: (chunk) => {
      stderr.push(chunk)
      if (VERBOSE) process.stderr.write(`[server] ${chunk}`)
    },
  })
  const client = new McpClient({ name: clientName, version: clientVersion })
  await client.connect(transport)
  clients.push(client)
  return { client, transport, stderr }
}

function sc(result) {
  return result?.structuredContent ?? {}
}

function errorCode(result) {
  return sc(result).error?.code
}

function textOf(result) {
  const block = Array.isArray(result?.content) ? result.content[0] : undefined
  return block?.type === 'text' ? block.text : ''
}

function readAudit(home) {
  try {
    return fs
      .readFileSync(path.join(home, 'cache', 'mcp-audit.log'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/** SDK 在 legacy 连接上把 schema 校验失败表达成 isError 工具结果（不进 handler） */
function schemaRejected(result) {
  return result?.isError === true && textOf(result).startsWith('Input validation error')
}

/** 假的 pi 会话：首行必须是合法 session header，正文里带 handle（回扫只做字面量匹配） */
function writePiSession(agentDir, sessionId, handle) {
  const dir = path.join(agentDir, 'sessions', '--tmp--')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}_${sessionId}.jsonl`)
  const header = {
    type: 'session',
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: '/tmp',
  }
  const message = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: `Tick 绑定句柄：${handle}` }],
  }
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`)
  return file
}

/** 假的 WorkBuddy 会话：文件名即 sessionId，不需要合法 header */
function writeWorkbuddySession(root, sessionId, handle) {
  const dir = path.join(root, 'projects', 'tmp-tick-wb')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'message', content: [{ type: 'text', text: `Tick 绑定句柄：${handle}` }] })}\n`,
  )
  return file
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-mcp-check-'))

async function main() {
  ensureBuild()
  console.log(`[mcp-check] server = ${SERVER_ENTRY}`)
  console.log(`[mcp-check] tmp    = ${TMP_ROOT}`)

  // ============================================================
  // A. 主场景：工具面、create 幂等、pi 回扫、list、link、错误码
  // ============================================================
  const mainCtx = makeContext('main')
  const { client } = await startClient(mainCtx)

  check('initialize: serverInfo.name === tick', client.serverInfo?.name === 'tick', JSON.stringify(client.serverInfo))
  check(
    'initialize: version 为 0.1.0+mcp.<n>',
    /^0\.1\.0\+mcp\.\d+$/.test(client.serverInfo?.version ?? ''),
    client.serverInfo?.version,
  )
  check(
    'initialize: instructions 含句柄保留要求',
    typeof client.instructions === 'string' && client.instructions.includes('Tick 绑定句柄'),
  )

  const tools = await client.listTools()
  checkEqual(
    'tools/list: 固定 3 个工具且顺序稳定',
    tools.map((tool) => tool.name),
    ['create_todo', 'list_todos', 'link_session'],
  )

  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const createTool = byName.get('create_todo')
  const listTool = byName.get('list_todos')
  const linkTool = byName.get('link_session')

  check(
    'tools/list: create_todo annotations',
    createTool?.annotations?.readOnlyHint === false &&
      createTool?.annotations?.destructiveHint === false &&
      createTool?.annotations?.idempotentHint === true &&
      createTool?.annotations?.openWorldHint === false,
    JSON.stringify(createTool?.annotations),
  )
  check(
    'tools/list: list_todos annotations 只读',
    listTool?.annotations?.readOnlyHint === true &&
      listTool?.annotations?.destructiveHint === false &&
      listTool?.annotations?.idempotentHint === true,
    JSON.stringify(listTool?.annotations),
  )
  check(
    'tools/list: link_session annotations',
    linkTool?.annotations?.readOnlyHint === false && linkTool?.annotations?.idempotentHint === true,
    JSON.stringify(linkTool?.annotations),
  )
  check(
    'tools/list: create_todo schema（title 必填、additionalProperties=false、bind 默认 true）',
    createTool?.inputSchema?.required?.includes('title') === true &&
      createTool?.inputSchema?.additionalProperties === false &&
      createTool?.inputSchema?.properties?.bind?.default === true,
    JSON.stringify(createTool?.inputSchema),
  )
  check(
    'tools/list: list_todos schema（limit 1..100）',
    listTool?.inputSchema?.properties?.limit?.minimum === 1 &&
      listTool?.inputSchema?.properties?.limit?.maximum === 100 &&
      listTool?.inputSchema?.properties?.limit?.default === 20,
    JSON.stringify(listTool?.inputSchema?.properties?.limit),
  )
  check(
    'tools/list: link_session schema（todo_id 必填）',
    linkTool?.inputSchema?.required?.includes('todo_id') === true,
    JSON.stringify(linkTool?.inputSchema),
  )
  check(
    'tools/list: description 与 spec 关键文案一致',
    createTool?.description?.includes('一次只建一条') === true &&
      listTool?.description?.includes('不含正文') === true &&
      linkTool?.description?.includes('不需要传 session_id') === true,
  )

  // ---- create_todo：正常路径 ----
  const title = '补 PR #42 的 e2e'
  const created = await client.callTool('create_todo', {
    title: `  ${title}  `,
    body: '只记标题也可以，这条带 body',
    cwd: '/tmp',
    request_id: 'req-check-1',
  })
  const createdSc = sc(created)
  check('create_todo: ok/created', createdSc.ok === true && createdSc.created === true, JSON.stringify(createdSc))
  check('create_todo: title 去首尾空白', createdSc.title === title, createdSc.title)
  check('create_todo: handle 格式 tk_+26', HANDLE_RE.test(createdSc.handle ?? ''), createdSc.handle)
  check('create_todo: binding.state=pending', createdSc.binding?.state === 'pending', JSON.stringify(createdSc.binding))
  check('create_todo: 文本以句柄开头（便于客户端保留）', textOf(created).startsWith(`Tick 绑定句柄：${createdSc.handle}`), textOf(created))
  const createdId = createdSc.todoId
  const handle = createdSc.handle
  check('create_todo: 写入 todos.json（source=mcp / toolId=pi）', (() => {
    const todos = readTodos(mainCtx.home)
    const todo = todos.find((item) => item.id === createdId)
    return todos.length === 1 && todo?.source === 'mcp' && todo?.mcpOrigin?.toolId === 'pi' && todo?.body?.includes('body')
  })())
  check('create_todo: 写入 1 个 probe', probeCount(mainCtx.home) === 1, String(probeCount(mainCtx.home)))

  // ---- 审计：字段固定、无 title/body/路径 ----
  const auditFile = path.join(mainCtx.home, 'cache', 'mcp-audit.log')
  const auditLines = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean)
    : []
  const auditRecords = auditLines.map((line) => JSON.parse(line))
  const auditKeys = new Set(auditRecords.flatMap((record) => Object.keys(record)))
  check('audit: cache/mcp-audit.log 存在且有 create 记录', auditRecords.some((r) => r.tool === 'create_todo' && r.code === 'OK'))
  check(
    'audit: 字段只有 at/pid/toolId/tool/todoId/sessionId/code/ms',
    [...auditKeys].every((key) => ['at', 'pid', 'toolId', 'tool', 'todoId', 'sessionId', 'code', 'ms'].includes(key)),
    [...auditKeys].join(','),
  )
  check(
    'audit: 不含 title/body/cwd/文件路径',
    auditLines.every((line) => !line.includes(title) && !line.includes('只记标题也可以') && !line.includes('/tmp')),
  )
  check('audit: 文件权限 0600', (fs.statSync(auditFile).mode & 0o777) === 0o600, (fs.statSync(auditFile).mode & 0o777).toString(8))

  // ---- 幂等：同 request_id ----
  const retried = await client.callTool('create_todo', { title, request_id: 'req-check-1' })
  const retriedSc = sc(retried)
  check(
    'create_todo 幂等: request_id 命中，不新建',
    retriedSc.ok === true &&
      retriedSc.created === false &&
      retriedSc.dedupedBy === 'request_id' &&
      retriedSc.todoId === createdId,
    JSON.stringify(retriedSc),
  )
  check('create_todo 幂等: 复用同一 handle', retriedSc.handle === handle, `${retriedSc.handle} != ${handle}`)
  check('create_todo 幂等: todo 数仍为 1、probe 仍为 1', readTodos(mainCtx.home).length === 1 && probeCount(mainCtx.home) === 1)

  // ---- 显式 session_id：直接 verified ----
  const explicitSession = 'sess-explicit-0001'
  const explicit = await client.callTool('create_todo', {
    title: '显式会话绑定',
    session_id: explicitSession,
    tool_id: 'pi',
  })
  const explicitSc = sc(explicit)
  const explicitId = explicitSc.todoId
  check(
    'create_todo 显式 session: 直接 verified',
    explicitSc.ok === true &&
      explicitSc.created === true &&
      explicitSc.binding?.state === 'verified' &&
      explicitSc.binding?.sessionId === explicitSession &&
      explicitSc.binding?.toolId === 'pi',
    JSON.stringify(explicitSc.binding),
  )
  check('create_todo 显式 session: 不写 probe', probeCount(mainCtx.home) === 1, String(probeCount(mainCtx.home)))

  const explicitAgain = await client.callTool('create_todo', {
    title: '另一个标题也不该新建',
    session_id: explicitSession,
    tool_id: 'pi',
  })
  const explicitAgainSc = sc(explicitAgain)
  check(
    'create_todo 幂等: 同 session 命中，返回既有 todo',
    explicitAgainSc.created === false &&
      explicitAgainSc.dedupedBy === 'session' &&
      explicitAgainSc.todoId === explicitId &&
      readTodos(mainCtx.home).length === 2,
    JSON.stringify(explicitAgainSc),
  )

  // ---- Tick 未运行：句柄回扫 ----
  const piSessionId = '11111111-2222-4333-8444-555555555555'
  // 同 cwd 的诱饵会话：也带一个合法 handle，但和本 probe 的 handle 不同 → 不能绑错
  writePiSession(mainCtx.agentDir, '99999999-0000-4000-8000-000000000000', `tk_${'0'.repeat(26)}`)
  writePiSession(mainCtx.agentDir, piSessionId, handle)
  const scanned = await waitFor(() => {
    const todo = findTodo(mainCtx.home, createdId)
    const binding = todo?.bindings?.find((item) => item.toolId === 'pi')
    return binding?.state === 'verified' ? binding : undefined
  })
  check(
    'pi 回扫: 会话文件命中 handle → binding.state=verified',
    scanned?.state === 'verified',
    JSON.stringify(findTodo(mainCtx.home, createdId)?.bindings),
  )
  check('pi 回扫: sessionId 来自 header.id', scanned?.sessionId === piSessionId, scanned?.sessionId)
  check('pi 回扫: toolId=pi、filePath 指向命中的会话文件', scanned?.toolId === 'pi' && scanned?.filePath?.endsWith(`${piSessionId}.jsonl`), JSON.stringify(scanned))
  check('pi 回扫: 命中后删除 probe', probeCount(mainCtx.home) === 0, String(probeCount(mainCtx.home)))
  check(
    'pi 回扫: 同 cwd 诱饵会话不会被误绑',
    findTodo(mainCtx.home, createdId)?.bindings?.length === 1 &&
      findTodo(mainCtx.home, createdId)?.bindings?.[0]?.sessionId === piSessionId,
    JSON.stringify(findTodo(mainCtx.home, createdId)?.bindings),
  )
  const scanAudit = await waitFor(
    () => readAudit(mainCtx.home).find((entry) => entry.tool === 'scan' && entry.code === 'BOUND' && entry.todoId === createdId),
    2_000,
  )
  check(
    'scan 审计: 命中写 tool=scan/code=BOUND，且不含路径',
    scanAudit?.toolId === 'pi' && !JSON.stringify(scanAudit).includes('/'),
    JSON.stringify(scanAudit),
  )

  // ---- list_todos：无 body、排序、过滤 ----
  const listed = await client.callTool('list_todos', {})
  const listedSc = sc(listed)
  check('list_todos: ok/count=2', listedSc.ok === true && listedSc.count === 2, JSON.stringify(listedSc))
  check(
    'list_todos: 每条都没有 body 字段',
    Array.isArray(listedSc.todos) && listedSc.todos.every((todo) => !Object.prototype.hasOwnProperty.call(todo, 'body')),
  )
  check(
    'list_todos: 回扫后的 todo bindingState=verified',
    listedSc.todos?.find((todo) => todo.todoId === createdId)?.bindingState === 'verified',
    JSON.stringify(listedSc.todos),
  )
  check('list_todos: 文本最多 20 条摘要且带 checkbox', textOf(listed).includes('1. [ ]'), textOf(listed))

  const filtered = await client.callTool('list_todos', { query: '显式会话' })
  check(
    'list_todos: query 子串过滤（忽略大小写式匹配）',
    sc(filtered).count === 1 && sc(filtered).todos?.[0]?.todoId === explicitId,
    JSON.stringify(sc(filtered)),
  )
  const onlyMcp = await client.callTool('list_todos', { origin: 'mcp' })
  check('list_todos: origin=mcp 命中 2 条', sc(onlyMcp).count === 2, JSON.stringify(sc(onlyMcp)))
  const onlyLocal = await client.callTool('list_todos', { origin: 'local' })
  check('list_todos: origin=local 为 0 条', sc(onlyLocal).count === 0, JSON.stringify(sc(onlyLocal)))

  const auditCountBefore = readAudit(mainCtx.home).length
  const limitRejected = await client.callTool('list_todos', { limit: 0 })
  check(
    'list_todos: limit 越界在 handler 之前被 SDK 拒绝',
    schemaRejected(limitRejected) && sc(limitRejected).error === undefined,
    JSON.stringify(limitRejected),
  )
  const extraRejected = await client.callTool('list_todos', { unexpected: true })
  check(
    'list_todos: additionalProperties=false 在 handler 之前被 SDK 拒绝',
    schemaRejected(extraRejected),
    JSON.stringify(extraRejected),
  )
  check('list_todos: schema 拒绝不进 handler（审计记录不增加）', readAudit(mainCtx.home).length === auditCountBefore)

  // ---- resources（可选，但已实现就一起回归） ----
  try {
    const resourceList = await client.listResources()
    check(
      'resources/list: tick://todos 存在',
      resourceList.some((resource) => resource.uri === 'tick://todos'),
      JSON.stringify(resourceList.map((resource) => resource.uri)),
    )
    const read = await client.readResource('tick://todos')
    const resourceText = read.contents?.[0]?.text ?? ''
    check('resources/read: tick://todos 返回 JSON 且无 body', resourceText.includes('"todos"') && !resourceText.includes('"body"'))
    const templates = await client.listResourceTemplates()
    check(
      'resources/templates/list: tick://todos/{todoId}',
      templates.some((template) => template.uriTemplate === 'tick://todos/{todoId}'),
      JSON.stringify(templates.map((template) => template.uriTemplate)),
    )
    const detail = await client.readResource(`tick://todos/${createdId}`)
    check(
      'resources/read: 单条含 body 与 sessions',
      (detail.contents?.[0]?.text ?? '').includes('"body"') &&
        (detail.contents?.[0]?.text ?? '').includes('"sessions"'),
    )
    let missingResource
    try {
      await client.readResource('tick://todos/00000000-0000-4000-8000-000000000000')
    } catch (error) {
      missingResource = error
    }
    // SDK 2.3.1 按 2026-07-28 MUST 把 -32002 映射成 -32602（只接收 -32002）；见报告
    check(
      'resources/read: 不存在 → 协议错误（SDK 映射为 -32602）',
      missingResource?.code === -32602 && String(missingResource?.message ?? '').includes('TICK_E_TODO_NOT_FOUND'),
      JSON.stringify(missingResource?.message),
    )
  } catch (error) {
    check('resources: 注册与读取可用', false, error instanceof Error ? error.message : String(error))
  }

  await client.close()

  // ============================================================
  // B. link_session：显式成功 / 幂等 / SESSION_TAKEN
  //    独立进程：写工具突发配额是 5/10s，和主场景分开才好逐条断言
  // ============================================================
  const linkCtx = makeContext('link')
  const { client: linkClient } = await startClient(linkCtx)

  const linkTarget = await linkClient.callTool('create_todo', { title: '链接目标', bind: false })
  const linkTargetId = sc(linkTarget).todoId
  check(
    'create_todo bind=false: 不写 handle/probe，binding=unbound',
    sc(linkTarget).handle === undefined &&
      sc(linkTarget).binding?.state === 'unbound' &&
      sc(linkTarget).binding?.reason === 'bind_false' &&
      probeCount(linkCtx.home) === 0,
    JSON.stringify(sc(linkTarget)),
  )
  const bindFalseCtx = makeContext('bind-false-explicit')
  const { client: bindFalseClient } = await startClient(bindFalseCtx)
  const bindFalseExplicit = sc(
    await bindFalseClient.callTool('create_todo', {
      title: 'bind=false 时忽略 session_id',
      session_id: 'sess-should-be-ignored',
      bind: false,
    }),
  )
  check(
    'create_todo bind=false: 即使给了 session_id 也不绑定',
    bindFalseExplicit.binding?.state === 'unbound' &&
      findTodo(bindFalseCtx.home, bindFalseExplicit.todoId)?.bindings?.length === 0,
    JSON.stringify(bindFalseExplicit),
  )
  await bindFalseClient.close()

  const linked = await linkClient.callTool('link_session', {
    todo_id: linkTargetId,
    session_id: 'sess-link-0001',
    tool_id: 'pi',
  })
  const linkedSc = sc(linked)
  check(
    'link_session 显式 session: verified',
    linkedSc.ok === true && linkedSc.binding?.state === 'verified' && linkedSc.binding?.sessionId === 'sess-link-0001',
    JSON.stringify(linkedSc),
  )
  check('link_session: 文本为「已关联」', textOf(linked).includes('已关联'), textOf(linked))
  check(
    'link_session: 落盘 binding state=verified/origin=mcp',
    findTodo(linkCtx.home, linkTargetId)?.bindings?.some(
      (binding) => binding.sessionId === 'sess-link-0001' && binding.state === 'verified' && binding.origin === 'mcp',
    ) === true,
  )

  const linkedAgain = await linkClient.callTool('link_session', {
    todo_id: linkTargetId,
    session_id: 'sess-link-0001',
    tool_id: 'pi',
  })
  check(
    'link_session 幂等: 同 todo 同 session 成功且不重复写',
    sc(linkedAgain).ok === true && sc(linkedAgain).binding?.state === 'verified',
    JSON.stringify(sc(linkedAgain)),
  )

  const otherTarget = await linkClient.callTool('create_todo', { title: '另一条链接目标', bind: false })
  const otherTargetId = sc(otherTarget).todoId
  const taken = await linkClient.callTool('link_session', {
    todo_id: otherTargetId,
    session_id: 'sess-link-0001',
    tool_id: 'pi',
  })
  check(
    'link_session: 会话已绑别的 todo → TICK_E_SESSION_TAKEN',
    taken.isError === true && errorCode(taken) === 'TICK_E_SESSION_TAKEN',
    JSON.stringify(sc(taken)),
  )
  check(
    'link_session: 冲突结果带 otherTodo 信息（文本里）',
    textOf(taken).includes('链接目标') && textOf(taken).includes(linkTargetId),
    textOf(taken),
  )
  check(
    'link_session: SESSION_TAKEN 不覆盖原绑定',
    findTodo(linkCtx.home, linkTargetId)?.bindings?.some((binding) => binding.sessionId === 'sess-link-0001') === true &&
      findTodo(linkCtx.home, otherTargetId)?.bindings?.length === 0,
  )
  await linkClient.close()

  // ============================================================
  // C. link_session 待回扫 + 输入错误码
  // ============================================================
  const pendingCtx = makeContext('link-pending')
  const { client: pendingClient } = await startClient(pendingCtx)

  const pendingTarget = await pendingClient.callTool('create_todo', { title: '待回扫链接目标', bind: false })
  const pendingTargetId = sc(pendingTarget).todoId
  const pending = await pendingClient.callTool('link_session', { todo_id: pendingTargetId })
  const pendingSc = sc(pending)
  check(
    'link_session 无 session: 返回 pending + handle',
    pendingSc.ok === true && pendingSc.binding?.state === 'pending' && HANDLE_RE.test(pendingSc.handle ?? ''),
    JSON.stringify(pendingSc),
  )
  check(
    'link_session 无 session: 文本含「正在把当前对话关联到」',
    textOf(pending).includes('正在把当前对话关联到'),
    textOf(pending),
  )
  check('link_session 无 session: 写入 probe（purpose=link）', (() => {
    const probe = readJson(
      path.join(pendingCtx.home, 'cache', 'mcp-pending', `${pendingSc.handle}.json`),
    )
    return probe?.purpose === 'link' && probe?.todoId === pendingTargetId
  })())

  const missingTodo = await pendingClient.callTool('link_session', {
    todo_id: '00000000-0000-4000-8000-000000000000',
    session_id: 'sess-missing-0001',
    tool_id: 'pi',
  })
  check(
    'link_session: todo 不存在 → TICK_E_TODO_NOT_FOUND',
    missingTodo.isError === true && errorCode(missingTodo) === 'TICK_E_TODO_NOT_FOUND',
    JSON.stringify(sc(missingTodo)),
  )
  check('错误文本以 [CODE] 开头', textOf(missingTodo).startsWith('[TICK_E_TODO_NOT_FOUND]'), textOf(missingTodo))

  const blankTitle = await pendingClient.callTool('create_todo', { title: '   ' })
  check(
    'create_todo: 全空白标题 → TICK_E_TITLE_EMPTY',
    blankTitle.isError === true && errorCode(blankTitle) === 'TICK_E_TITLE_EMPTY',
    JSON.stringify(sc(blankTitle)),
  )

  const emptyTitle = await pendingClient.callTool('create_todo', { title: '' })
  check(
    'create_todo: 空字符串在 schema 层被拒（不进 handler）',
    schemaRejected(emptyTitle),
    JSON.stringify(emptyTitle),
  )
  await pendingClient.close()

  // ============================================================
  // D. 限流：写突发 5/10s，第 6 次被拒且不落盘
  // ============================================================
  const rlCtx = makeContext('rate-limit')
  const { client: rlClient } = await startClient(rlCtx)
  const burst = []
  for (let index = 0; index < 5; index += 1) {
    burst.push(
      await rlClient.callTool('create_todo', { title: `限流样本 ${index}`, request_id: `rate-${index}` }),
    )
  }
  check('限流: 突发 5 次写允许', burst.every((result) => sc(result).ok === true), JSON.stringify(burst.map((r) => errorCode(r))))
  const sixth = await rlClient.callTool('create_todo', { title: '限流第 6 次' })
  check(
    '限流: 第 6 次 → TICK_E_RATE_LIMITED + retryAfterSeconds',
    sixth.isError === true &&
      errorCode(sixth) === 'TICK_E_RATE_LIMITED' &&
      Number.isInteger(sc(sixth).error?.retryAfterSeconds) &&
      sc(sixth).error.retryAfterSeconds >= 1 &&
      sc(sixth).error.retryable === true,
    JSON.stringify(sc(sixth)),
  )
  check('限流: 被拒的调用不落盘（仍 5 条）', readTodos(rlCtx.home).length === 5, String(readTodos(rlCtx.home).length))
  const readUnderLimit = await rlClient.callTool('list_todos', {})
  check(
    '限流: 读工具使用独立配额（写被限时仍可读）',
    sc(readUnderLimit).ok === true && sc(readUnderLimit).count === 5,
    JSON.stringify(sc(readUnderLimit)),
  )
  await rlClient.close()

  // ============================================================
  // E. 只读模式
  // ============================================================
  const roCtx = makeContext('readonly', { TICK_MCP_READONLY: '1' })
  const { client: roClient } = await startClient(roCtx)
  const roList = await roClient.callTool('list_todos', {})
  check('只读: list_todos 仍可读（空表）', sc(roList).ok === true && sc(roList).count === 0, JSON.stringify(sc(roList)))
  const roCreate = await roClient.callTool('create_todo', { title: '只读模式不该建单' })
  check(
    '只读: create_todo → TICK_E_READONLY',
    roCreate.isError === true && errorCode(roCreate) === 'TICK_E_READONLY',
    JSON.stringify(sc(roCreate)),
  )
  const roLink = await roClient.callTool('link_session', { todo_id: '00000000-0000-4000-8000-000000000000' })
  check(
    '只读: link_session → TICK_E_READONLY（在 todo 校验之前拒绝）',
    roLink.isError === true && errorCode(roLink) === 'TICK_E_READONLY',
    JSON.stringify(sc(roLink)),
  )
  check(
    '只读: 不写 todos.json / 不写 probe',
    !fs.existsSync(path.join(roCtx.home, 'data', 'todos.json')) &&
      !fs.existsSync(path.join(roCtx.home, 'cache', 'mcp-pending')),
  )
  check('只读: 拒绝也进审计（code=TICK_E_READONLY）', (() => {
    try {
      const lines = fs.readFileSync(path.join(roCtx.home, 'cache', 'mcp-audit.log'), 'utf8').trim().split('\n')
      return lines.some((line) => JSON.parse(line).code === 'TICK_E_READONLY')
    } catch {
      return false
    }
  })())
  await roClient.close()

  // ============================================================
  // C. 扫描关闭：建单成功但 unbound；无 session 的 link 报 SCAN_DISABLED
  // ============================================================
  const sdCtx = makeContext('scan-off', { TICK_MCP_SCAN: '0' })
  const { client: sdClient } = await startClient(sdCtx)
  const sdCreate = await sdClient.callTool('create_todo', { title: '扫描关闭时建的单' })
  check(
    'scan=0: create 成功但 binding=unbound/scan_disabled，无 handle',
    sc(sdCreate).ok === true &&
      sc(sdCreate).created === true &&
      sc(sdCreate).binding?.state === 'unbound' &&
      sc(sdCreate).binding?.reason === 'scan_disabled' &&
      sc(sdCreate).handle === undefined,
    JSON.stringify(sc(sdCreate)),
  )
  check('scan=0: 不写 probe', probeCount(sdCtx.home) === 0, String(probeCount(sdCtx.home)))
  const sdTargetId = sc(sdCreate).todoId
  const sdLink = await sdClient.callTool('link_session', { todo_id: sdTargetId })
  check(
    'scan=0: link_session 无 session_id → TICK_E_SCAN_DISABLED',
    sdLink.isError === true && errorCode(sdLink) === 'TICK_E_SCAN_DISABLED',
    JSON.stringify(sc(sdLink)),
  )
  const sdExplicit = await sdClient.callTool('link_session', {
    todo_id: sdTargetId,
    session_id: 'sess-scan-off-0001',
    tool_id: 'pi',
  })
  check(
    'scan=0: 显式 session_id 仍可绑定（不依赖扫描）',
    sc(sdExplicit).ok === true && sc(sdExplicit).binding?.state === 'verified',
    JSON.stringify(sc(sdExplicit)),
  )
  await sdClient.close()

  // ============================================================
  // D. WorkBuddy 国内版：WORKBUDDY_CONFIG_DIR 假根
  // ============================================================
  const wbRoot = path.join(TMP_ROOT, 'workbuddy-cn-data')
  const wbCtx = makeContext('workbuddy-cn', { WORKBUDDY_CONFIG_DIR: wbRoot })
  const { client: wbClient } = await startClient(wbCtx)
  const wbCreate = await wbClient.callTool('create_todo', {
    title: 'WorkBuddy 国内版绑定',
    tool_id: 'workbuddy',
  })
  const wbSc = sc(wbCreate)
  check(
    'workbuddy: create 返回 pending + handle',
    wbSc.ok === true && wbSc.binding?.state === 'pending' && HANDLE_RE.test(wbSc.handle ?? ''),
    JSON.stringify(wbSc),
  )
  const wbSessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  writeWorkbuddySession(wbRoot, wbSessionId, wbSc.handle)
  const wbBinding = await waitFor(() => {
    const binding = findTodo(wbCtx.home, wbSc.todoId)?.bindings?.[0]
    return binding?.state === 'verified' ? binding : undefined
  })
  check(
    'workbuddy: 假 projects/<enc>/<uuid>.jsonl 回扫 → verified',
    wbBinding?.state === 'verified',
    JSON.stringify(findTodo(wbCtx.home, wbSc.todoId)?.bindings),
  )
  check(
    'workbuddy: 绑定到 toolId=workbuddy，sessionId=文件名',
    wbBinding?.toolId === 'workbuddy' && wbBinding?.sessionId === wbSessionId,
    JSON.stringify(wbBinding),
  )
  check(
    'workbuddy: mcpOrigin.toolId 保留调用方声明',
    findTodo(wbCtx.home, wbSc.todoId)?.mcpOrigin?.toolId === 'workbuddy',
  )
  await wbClient.close()

  // ============================================================
  // E. WorkBuddy AI 国际版：默认根在临时 HOME 下（不吃 WORKBUDDY_CONFIG_DIR）
  // ============================================================
  const wbAiCtx = makeContext('workbuddy-ai')
  const wbAiRoot = path.join(wbAiCtx.base, '.workbuddy-ai')
  const { client: wbAiClient } = await startClient(wbAiCtx)
  const wbAiCreate = await wbAiClient.callTool('create_todo', {
    title: 'WorkBuddy AI 绑定',
    tool_id: 'workbuddy-ai',
  })
  const wbAiSc = sc(wbAiCreate)
  const wbAiSessionId = 'ffffffff-1111-4222-8333-444444444444'
  writeWorkbuddySession(wbAiRoot, wbAiSessionId, wbAiSc.handle)
  const wbAiBinding = await waitFor(() => {
    const binding = findTodo(wbAiCtx.home, wbAiSc.todoId)?.bindings?.[0]
    return binding?.state === 'verified' ? binding : undefined
  })
  check(
    'workbuddy-ai: 默认根 ~/.workbuddy-ai 回扫 → verified',
    wbAiBinding?.state === 'verified' && wbAiBinding?.toolId === 'workbuddy-ai' && wbAiBinding?.sessionId === wbAiSessionId,
    JSON.stringify(wbAiBinding),
  )
  await wbAiClient.close()

  // ============================================================
  // F. data/settings.json 的开关（不设环境变量）
  // ============================================================
  const settingsRoCtx = makeContext('settings-readonly')
  fs.mkdirSync(path.join(settingsRoCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(settingsRoCtx.home, 'data', 'settings.json'),
    JSON.stringify({ mcpReadOnly: true }),
  )
  const { client: settingsRoClient } = await startClient(settingsRoCtx)
  const settingsRo = await settingsRoClient.callTool('create_todo', { title: 'settings 只读' })
  check(
    'settings.json: mcpReadOnly=true → TICK_E_READONLY',
    settingsRo.isError === true && errorCode(settingsRo) === 'TICK_E_READONLY',
    JSON.stringify(sc(settingsRo)),
  )
  await settingsRoClient.close()

  const settingsRoOffCtx = makeContext('settings-readonly-env-off', { TICK_MCP_READONLY: '0' })
  fs.mkdirSync(path.join(settingsRoOffCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(settingsRoOffCtx.home, 'data', 'settings.json'),
    JSON.stringify({ mcpReadOnly: true }),
  )
  const { client: settingsRoOffClient } = await startClient(settingsRoOffCtx)
  const settingsRoOff = await settingsRoOffClient.callTool('create_todo', { title: '环境变量覆盖 settings' })
  check(
    'settings.json: TICK_MCP_READONLY=0 覆盖 mcpReadOnly=true',
    sc(settingsRoOff).ok === true && sc(settingsRoOff).created === true,
    JSON.stringify(sc(settingsRoOff)),
  )
  await settingsRoOffClient.close()

  const settingsScanCtx = makeContext('settings-scan-off')
  fs.mkdirSync(path.join(settingsScanCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(settingsScanCtx.home, 'data', 'settings.json'),
    JSON.stringify({ mcpScan: false }),
  )
  const { client: settingsScanClient } = await startClient(settingsScanCtx)
  const settingsScanCreate = await settingsScanClient.callTool('create_todo', { title: 'settings 关扫描' })
  check(
    'settings.json: mcpScan=false → unbound/scan_disabled 且无 probe',
    sc(settingsScanCreate).binding?.state === 'unbound' &&
      sc(settingsScanCreate).binding?.reason === 'scan_disabled' &&
      sc(settingsScanCreate).handle === undefined &&
      probeCount(settingsScanCtx.home) === 0,
    JSON.stringify(sc(settingsScanCreate)),
  )
  const settingsScanLink = await settingsScanClient.callTool('link_session', {
    todo_id: sc(settingsScanCreate).todoId,
  })
  check(
    'settings.json: mcpScan=false → link 无 session 时报 TICK_E_SCAN_DISABLED',
    settingsScanLink.isError === true && errorCode(settingsScanLink) === 'TICK_E_SCAN_DISABLED',
    JSON.stringify(sc(settingsScanLink)),
  )
  await settingsScanClient.close()

  const settingsScanOnCtx = makeContext('settings-scan-env-on', { TICK_MCP_SCAN: '1' })
  fs.mkdirSync(path.join(settingsScanOnCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(settingsScanOnCtx.home, 'data', 'settings.json'),
    JSON.stringify({ mcpScan: false }),
  )
  const { client: settingsScanOnClient } = await startClient(settingsScanOnCtx)
  const settingsScanOn = await settingsScanOnClient.callTool('create_todo', { title: '环境变量开扫描' })
  check(
    'settings.json: TICK_MCP_SCAN=1 覆盖 mcpScan=false',
    sc(settingsScanOn).ok === true &&
      sc(settingsScanOn).binding?.state === 'pending' &&
      HANDLE_RE.test(sc(settingsScanOn).handle ?? '') &&
      probeCount(settingsScanOnCtx.home) === 1,
    JSON.stringify(sc(settingsScanOn)),
  )
  await settingsScanOnClient.close()

  // SettingsStore 真实写盘形状：{version:1, settings:{...}}（不是顶层）
  const nestedRoCtx = makeContext('settings-nested-readonly')
  fs.mkdirSync(path.join(nestedRoCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(nestedRoCtx.home, 'data', 'settings.json'),
    JSON.stringify({ version: 1, settings: { mcpReadOnly: true } }),
  )
  const { client: nestedRoClient } = await startClient(nestedRoCtx)
  const nestedRoCreate = await nestedRoClient.callTool('create_todo', { title: '嵌套只读' })
  check(
    'settings.json: {version,settings:{mcpReadOnly:true}} → TICK_E_READONLY',
    errorCode(nestedRoCreate) === 'TICK_E_READONLY',
    JSON.stringify(sc(nestedRoCreate)),
  )
  await nestedRoClient.close()

  const nestedScanCtx = makeContext('settings-nested-scan-off')
  fs.mkdirSync(path.join(nestedScanCtx.home, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(nestedScanCtx.home, 'data', 'settings.json'),
    JSON.stringify({ version: 1, settings: { mcpScan: false } }),
  )
  const { client: nestedScanClient } = await startClient(nestedScanCtx)
  const nestedScan = await nestedScanClient.callTool('create_todo', { title: '嵌套关扫描' })
  check(
    'settings.json: {version,settings:{mcpScan:false}} → unbound/scan_disabled',
    sc(nestedScan).ok === true &&
      sc(nestedScan).binding?.state === 'unbound' &&
      sc(nestedScan).binding?.reason === 'scan_disabled' &&
      probeCount(nestedScanCtx.home) === 0,
    JSON.stringify(sc(nestedScan)),
  )
  await nestedScanClient.close()

  // ============================================================
  // G. stdin EOF：关机前做一次最终回扫（不靠 3s/10s/30s 定时器）
  // ============================================================
  const eofCtx = makeContext('eof-scan')
  const { client: eofClient } = await startClient(eofCtx)
  const eofCreate = await eofClient.callTool('create_todo', { title: 'EOF 最终回扫' })
  const eofSc = sc(eofCreate)
  const eofSessionId = '99999999-8888-4777-8666-555555555555'
  writePiSession(eofCtx.agentDir, eofSessionId, eofSc.handle)
  const closeStartedAt = Date.now()
  // 立刻关 stdin：3s 定时器还没到，只有结束前最终回扫能把它绑上
  await eofClient.close()
  const closeElapsed = Date.now() - closeStartedAt
  const eofBinding = await waitFor(() => {
    const binding = findTodo(eofCtx.home, eofSc.todoId)?.bindings?.[0]
    return binding?.state === 'verified' ? binding : undefined
  }, 3_000)
  check(
    'stdin EOF: 最终回扫在退出前完成绑定',
    eofBinding?.state === 'verified' && eofBinding?.sessionId === eofSessionId,
    JSON.stringify(findTodo(eofCtx.home, eofSc.todoId)?.bindings),
  )
  check('stdin EOF: 命中后 probe 被删除', probeCount(eofCtx.home) === 0, String(probeCount(eofCtx.home)))
  check('stdin EOF: 进程及时退出（<2.5s）', closeElapsed < 2_500, `${closeElapsed}ms`)

  // ============================================================
  // I. 启动回扫 / 过期 probe / 损坏数据 fail-closed
  // ============================================================
  const startupCtx = makeContext('startup-scan')
  const { client: startupFirst } = await startClient(startupCtx)
  const startupCreated = sc(await startupFirst.callTool('create_todo', { title: '启动回扫' }))
  check(
    '启动回扫: 第一次 create 留下 pending probe',
    HANDLE_RE.test(startupCreated.handle ?? '') && probeCount(startupCtx.home) === 1,
    JSON.stringify(startupCreated),
  )
  // 先关掉旧进程（EOF 时还没有会话文件，probe 不会被删），再写会话文件，最后启动新进程
  await startupFirst.close()
  check('启动回扫: 旧进程退出后 probe 仍在', probeCount(startupCtx.home) === 1, String(probeCount(startupCtx.home)))
  const startupSessionId = 'abcabcab-1111-4222-8333-444444444444'
  writePiSession(startupCtx.agentDir, startupSessionId, startupCreated.handle)
  const { client: startupSecond } = await startClient(startupCtx)
  const startupBound = await waitFor(() => {
    const binding = findTodo(startupCtx.home, startupCreated.todoId)?.bindings?.[0]
    return binding?.state === 'verified' ? binding : undefined
  }, 3_000)
  check(
    '启动回扫: 新进程启动后处理上次留下的 probe',
    startupBound?.sessionId === startupSessionId,
    JSON.stringify(findTodo(startupCtx.home, startupCreated.todoId)?.bindings),
  )
  await startupSecond.close()

  const expiredCtx = makeContext('expired-probe')
  const expiredDir = path.join(expiredCtx.home, 'cache', 'mcp-pending')
  fs.mkdirSync(expiredDir, { recursive: true })
  const expiredHandle = `tk_${'0'.repeat(26)}`
  fs.writeFileSync(
    path.join(expiredDir, `${expiredHandle}.json`),
    JSON.stringify({
      version: 1,
      handle: expiredHandle,
      purpose: 'create',
      todoId: '00000000-0000-4000-8000-000000000000',
      toolId: 'pi',
      at: new Date(Date.now() - 25 * 3600_000).toISOString(),
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      pid: 1,
    }),
  )
  const { client: expiredClient } = await startClient(expiredCtx)
  const expiredRemoved = await waitFor(() => probeCount(expiredCtx.home) === 0, 3_000)
  check('过期 probe: 启动回扫删除（不留下垃圾）', expiredRemoved === true, String(probeCount(expiredCtx.home)))
  await expiredClient.close()

  const corruptCtx = makeContext('corrupt')
  const corruptFile = path.join(corruptCtx.home, 'data', 'todos.json')
  fs.mkdirSync(path.dirname(corruptFile), { recursive: true })
  fs.writeFileSync(corruptFile, '{ this is not valid json')
  const { client: corruptClient } = await startClient(corruptCtx)
  const corruptCreate = await corruptClient.callTool('create_todo', { title: '损坏时不能写' })
  check(
    '数据损坏: create_todo fail-closed（TICK_E_DATA_CORRUPT）',
    errorCode(corruptCreate) === 'TICK_E_DATA_CORRUPT',
    JSON.stringify(sc(corruptCreate)),
  )
  const corruptList = await corruptClient.callTool('list_todos', {})
  check('数据损坏: list_todos 报错且不覆盖', errorCode(corruptList) === 'TICK_E_DATA_CORRUPT', JSON.stringify(sc(corruptList)))
  const corruptLink = await corruptClient.callTool('link_session', { todo_id: 'nope', session_id: 'x' })
  check('数据损坏: link_session fail-closed', errorCode(corruptLink) === 'TICK_E_DATA_CORRUPT', JSON.stringify(sc(corruptLink)))
  check('数据损坏: 原文件逐字节未变', fs.readFileSync(corruptFile, 'utf8') === '{ this is not valid json')
  check(
    '数据损坏: 已生成 .corrupt-* 备份',
    fs.readdirSync(path.dirname(corruptFile)).some((name) => name.includes('.corrupt-')),
    fs.readdirSync(path.dirname(corruptFile)).join(','),
  )
  check('数据损坏: 不写 probe', probeCount(corruptCtx.home) === 0, String(probeCount(corruptCtx.home)))
  await corruptClient.close()

  // 标题窗口去重 + pending 投影（不需要 request_id/session_id）
  const dedupeCtx = makeContext('title-dedupe')
  const { client: dedupeClient } = await startClient(dedupeCtx)
  const firstTitle = sc(await dedupeClient.callTool('create_todo', { title: 'Repeat   Title', tool_id: 'pi' }))
  const secondTitle = sc(await dedupeClient.callTool('create_todo', { title: 'repeat title', tool_id: 'pi' }))
  check(
    '标题去重: 同 toolId + 规范化标题 10 分钟内只建一条',
    firstTitle.created === true &&
      secondTitle.created === false &&
      secondTitle.dedupedBy === 'title' &&
      secondTitle.todoId === firstTitle.todoId &&
      readTodos(dedupeCtx.home).length === 1,
    JSON.stringify({ firstTitle, secondTitle }),
  )
  const pendingList = sc(await dedupeClient.callTool('list_todos', {}))
  check(
    'list_todos: probe 未回扫时 bindingState=pending',
    pendingList.todos?.find((todo) => todo.todoId === firstTitle.todoId)?.bindingState === 'pending',
    JSON.stringify(pendingList.todos),
  )
  await dedupeClient.close()

  // ============================================================
  // H. modern 2026-07-28：stateless + 每请求 _meta 信封（SDK 双代）
  // request_id 的作用域是 (toolId, request_id)：跨工具同 key 不能互相命中
  const crossCtx = makeContext('request-scope')
  const { client: crossPi } = await startClient(crossCtx, 'pi')
  const crossPiSc = sc(await crossPi.callTool('create_todo', { title: 'pi 的同 key', request_id: 'same-key', tool_id: 'pi' }))
  const { client: crossWb } = await startClient(crossCtx, 'workbuddy', '5.8.3')
  const crossWbSc = sc(await crossWb.callTool('create_todo', { title: 'workbuddy 的同 key', request_id: 'same-key', tool_id: 'workbuddy' }))
  check(
    '幂等作用域: 同 request_id 换 toolId 会新建（不是全局 key）',
    crossPiSc.created === true &&
      crossWbSc.created === true &&
      crossPiSc.todoId !== crossWbSc.todoId &&
      readTodos(crossCtx.home).length === 2,
    JSON.stringify({ pi: crossPiSc, wb: crossWbSc }),
  )
  await crossPi.close()
  await crossWb.close()

  // ============================================================
  // H. modern 2026-07-28：stateless + 每请求 _meta 信封（SDK 双代）
  // ============================================================
  const modernCtx = makeContext('modern')
  const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'pi', version: '1.3.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
  const modernReq = (id, method, params = {}) => ({
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: ENVELOPE },
  })
  const modern = spawnSync(process.execPath, [SERVER_ENTRY], {
    env: modernCtx.env,
    encoding: 'utf8',
    timeout: 15_000,
    input:
      [
        modernReq(1, 'server/discover'),
        modernReq(2, 'tools/list'),
        modernReq(3, 'tools/call', {
          name: 'create_todo',
          arguments: { title: 'modern 2026 绑定' },
        }),
        modernReq(4, 'tools/call', {
          name: 'create_todo',
          arguments: { title: '' },
        }),
        modernReq(5, 'resources/read', { uri: 'tick://todos/nope' }),
      ]
        .map((message) => JSON.stringify(message))
        .join('\n') + '\n',
  })
  const modernMessages = String(modern.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
  const modernBy = new Map(modernMessages.filter(Boolean).map((message) => [message.id, message]))
  check(
    'modern: server/discover 宣告 2026-07-28',
    modernBy.get(1)?.result?.supportedVersions?.includes('2026-07-28') === true &&
      modernBy.get(1)?.result?.resultType === 'complete',
    JSON.stringify(modernBy.get(1)?.result),
  )
  check(
    'modern: tools/list 带 ttlMs=60000/cacheScope=private',
    modernBy.get(2)?.result?.ttlMs === 60_000 &&
      modernBy.get(2)?.result?.cacheScope === 'private' &&
      modernBy.get(2)?.result?.tools?.length === 3,
    JSON.stringify(modernBy.get(2)?.result && { ttlMs: modernBy.get(2).result.ttlMs, cacheScope: modernBy.get(2).result.cacheScope }),
  )
  const modernCreate = modernBy.get(3)?.result
  const modernSc = sc(modernCreate)
  check(
    'modern: create_todo 用 _meta clientInfo 推断 toolId=pi',
    modernSc.ok === true &&
      modernSc.binding?.state === 'pending' &&
      HANDLE_RE.test(modernSc.handle ?? '') &&
      findTodo(modernCtx.home, modernSc.todoId)?.mcpOrigin?.toolId === 'pi',
    JSON.stringify(modernSc),
  )
  const modernProbeFile = (() => {
    try {
      const dir = path.join(modernCtx.home, 'cache', 'mcp-pending')
      const name = fs.readdirSync(dir).find((entry) => entry.endsWith('.json'))
      return name ? path.join(dir, name) : undefined
    } catch {
      return undefined
    }
  })()
  const modernProbe = modernProbeFile ? readJson(modernProbeFile) : undefined
  check(
    'modern: probe 为 spec 格式（clientInfo 对象 + ISO 时间）',
    modernProbe?.clientInfo?.name === 'pi' &&
      Number.isFinite(Date.parse(modernProbe?.at)) &&
      Number.isFinite(Date.parse(modernProbe?.expiresAt)),
    JSON.stringify(modernProbe && { clientInfo: modernProbe.clientInfo, at: modernProbe.at, expiresAt: modernProbe.expiresAt }),
  )
  check(
    'modern: schema 校验失败 → isError（SDK 2.3.1 as-built，不是 -32602）',
    modernBy.get(4)?.result?.isError === true &&
      textOf(modernBy.get(4)?.result).startsWith('Input validation error'),
    JSON.stringify(modernBy.get(4)?.result),
  )
  check(
    'modern: resources/read 不存在 → -32602（SDK 映射）',
    modernBy.get(5)?.error?.code === -32602,
    JSON.stringify(modernBy.get(5)?.error),
  )
}

try {
  await main()
} catch (error) {
  failed += 1
  console.error('FAIL  未捕获异常 —', error)
} finally {
  for (const client of clients) {
    try {
      await client.close()
    } catch {
      /* 已关闭 */
    }
  }
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch (error) {
    console.error('[mcp-check] 清理临时目录失败：', error)
  }
  console.log(`\n[mcp-check] ${passed} PASS, ${failed} FAIL`)
  process.exitCode = failed === 0 ? 0 : 1
}
