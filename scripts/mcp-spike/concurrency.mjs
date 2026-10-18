#!/usr/bin/env node
/**
 * concurrency.mjs — 两个并发写断言。
 *
 * (a) 6 个 server.mjs 子进程并发各写 20 条 → todos.json 恰好 120 条、无损坏、锁文件最终不存在。
 * (b) 跨运行时：用 esbuild 把 Main 侧真实的 TodoStore（apps/desktop/src/main/store.ts）打成
 *     独立 ESM，让 TodoStore.create() 与 3 个 server 进程同时各写 20 条。
 *     两边用的是同一份「<todos.json>.lock + O_EXCL + tmp/fsync/rename」协议——
 *     只要锁文件名或语义不一致，就必然丢写，总数会小于期望值。
 *
 * 运行：node scripts/mcp-spike/concurrency.mjs
 * 退出码：全部 PASS → 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SERVER = path.join(HERE, 'server.mjs')
const NODE = process.execPath
const RUN_ROOT = process.env.TICK_SPIKE_TMP || path.join('/tmp', 'tick-spike')
const STORE_BUNDLE = path.join(RUN_ROOT, 'store.mjs')

const PER_WRITER = 20

// ---------- 断言框架 ----------
const results = []
let failed = 0

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true })
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
  const home = path.join(RUN_ROOT, `conc-${tag}-${process.pid}`)
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(home, { recursive: true })
  return home
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// ---------- 极简 MCP stdio 客户端（裸 JSON-RPC，避免依赖顺序干扰并发） ----------
class MiniClient {
  constructor({ home, tag }) {
    this.home = home
    this.tag = tag
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.stdoutLines = []
    this.stderrText = ''
    this.exited = false
  }

  async start() {
    this.proc = spawn(NODE, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        TICK_HOME: this.home,
        TICK_MCP_LOG: path.join(this.home, `server-${this.tag}.log`),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exitPromise = new Promise((resolve) => this.proc.on('exit', (code) => resolve(code)))
    this.exitPromise.then(() => {
      this.exited = true
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (!line.trim()) continue
        this.stdoutLines.push(line)
        const msg = JSON.parse(line) // stdout 必须是纯 JSON-RPC，解析失败就让测试炸
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          clearTimeout(timer)
          if (msg.error) reject(new Error(`${this.tag} 请求失败：${JSON.stringify(msg.error)}`))
          else resolve(msg.result)
        }
      }
    })
    this.proc.stderr.on('data', (chunk) => (this.stderrText += chunk))
    await new Promise((resolve, reject) => {
      this.proc.once('spawn', resolve)
      this.proc.once('error', reject)
    })
    const init = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: `spike-concurrency-${this.tag}`, version: '0.0.0' },
    })
    if (init.serverInfo?.name !== 'tick-spike') throw new Error(`${this.tag} initialize 失败`)
    this.notify('notifications/initialized')
    return this
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.tag} ${method} 超时（id=${id}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** 一次性把 n 个 create_todo 写进 stdin，返回全部应答 */
  createMany(prefix, n) {
    const calls = []
    for (let i = 0; i < n; i++) {
      calls.push(
        this.request('tools/call', {
          name: 'create_todo',
          arguments: { title: `${prefix}-${this.tag}-${i}` },
        }),
      )
    }
    return Promise.all(calls)
  }

  async close() {
    this.proc.stdin.end()
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 10000))
    const code = await Promise.race([this.exitPromise, timeout])
    if (code === 'timeout' && this.proc.exitCode === null) this.proc.kill('SIGKILL')
    return code
  }

  kill() {
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL')
  }
}

function readTodos(home) {
  const file = path.join(home, 'data', 'todos.json')
  assert(fs.existsSync(file), `todos.json 不存在：${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function inspectHome(home) {
  const dataDir = path.join(home, 'data')
  const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []
  return {
    lock: fs.existsSync(path.join(dataDir, 'todos.json.lock')),
    tmp: files.filter((f) => f.endsWith('.tmp')),
    corrupt: files.filter((f) => f.includes('.corrupt-')),
    files,
  }
}

function assertShape(todos, label) {
  const ids = new Set()
  for (const t of todos) {
    for (const key of ['id', 'title', 'status', 'createdAt', 'updatedAt']) {
      assert(t[key] !== undefined, `${label} 条目缺字段 ${key}：${JSON.stringify(t).slice(0, 120)}`)
    }
    assertEqual(t.status, 'open', `${label} status`)
    assert(Array.isArray(t.bindings), `${label} bindings 非数组`)
    assert(!ids.has(t.id), `${label} id 重复：${t.id}`)
    ids.add(t.id)
  }
  return ids
}

function titlesByPrefix(todos) {
  const map = new Map()
  for (const t of todos) {
    const prefix = String(t.title).split('-').slice(0, 2).join('-') // 例：a-12345 / store-p0
    map.set(prefix, (map.get(prefix) ?? 0) + 1)
  }
  return map
}

// ---------- (a) 6 进程 × 20 ----------
console.log(`tick-spike concurrency check  root=${ROOT}`)
console.log(`run dir=${RUN_ROOT}\n`)

const homeA = freshHome('a')
const WRITERS_A = 6

await check(`(a) 6 个 server 进程并发各写 ${PER_WRITER} 条 → ${WRITERS_A * PER_WRITER} 条且无丢写`, async () => {
  const clients = []
  try {
    for (let i = 0; i < WRITERS_A; i++) clients.push(await new MiniClient({ home: homeA, tag: `p${i}` }).start())

    // 真正并发：所有进程的 20 个请求一次性灌进各自 stdin
    const all = await Promise.all(clients.map((c) => c.createMany('a', PER_WRITER)))
    const flat = all.flat()
    assertEqual(flat.length, WRITERS_A * PER_WRITER, '应答数')
    const created = flat.filter((r) => r.structuredContent?.created === true).length
    assertEqual(created, WRITERS_A * PER_WRITER, 'created=true 应答数')

    for (const c of clients) {
      const code = await c.close()
      assertEqual(code, 0, `${c.tag} 退出码`)
    }

    const file = readTodos(homeA)
    assertEqual(file.version, 1, 'todos.json version')
    assertEqual(file.todos.length, WRITERS_A * PER_WRITER, 'todos 条数')
    const ids = assertShape(file.todos, '(a)')
    assertEqual(ids.size, WRITERS_A * PER_WRITER, '唯一 id 数')

    const byPrefix = titlesByPrefix(file.todos)
    for (const c of clients) {
      assertEqual(byPrefix.get(`a-${c.tag}`), PER_WRITER, `${c.tag} 写入条数`)
    }

    const hygiene = inspectHome(homeA)
    assertEqual(hygiene.lock, false, '锁文件最终应不存在')
    assertEqual(hygiene.tmp.length, 0, `残留 tmp 文件：${hygiene.tmp.join(',')}`)
    assertEqual(hygiene.corrupt.length, 0, `出现损坏备份：${hygiene.corrupt.join(',')}`)

    return `${file.todos.length} todos · ${WRITERS_A} writers × ${PER_WRITER} · lock=absent`
  } finally {
    for (const c of clients) c.kill()
  }
})

// ---------- (b) 跨运行时：真实 TodoStore vs 3 个 server ----------
const homeB = freshHome('b')
const SERVER_WRITERS_B = 3
let degradedReason = null
let makeStore = null

await check('(b) esbuild 打包 Main 侧 TodoStore（apps/desktop/src/main/store.ts）', async () => {
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild')
  fs.mkdirSync(RUN_ROOT, { recursive: true })
  try {
    assert(fs.existsSync(esbuild), `找不到 esbuild：${esbuild}`)
    execFileSync(
      esbuild,
      [
        'apps/desktop/src/main/store.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${STORE_BUNDLE}`,
      ],
      { cwd: ROOT, stdio: 'pipe', timeout: 60000 },
    )
    assert(fs.existsSync(STORE_BUNDLE), '打包产物不存在')
    const mod = await import(`${pathToFileURL(STORE_BUNDLE).href}?t=${Date.now()}`)
    assertEqual(typeof mod.TodoStore, 'function', '导出的 TodoStore')

    makeStore = (home) => {
      const store = new mod.TodoStore(path.join(home, 'data', 'todos.json'))
      store.ensureFile()
      return {
        list: () => store.list(),
        create: (title) => store.create({ title }),
        kind: 'real-TodoStore',
      }
    }
    const size = fs.statSync(STORE_BUNDLE).size
    return `${STORE_BUNDLE} (${size}B, export=[${Object.keys(mod).join(',')}])`
  } catch (err) {
    // 任务书允许的降级路径：esbuild/workspace 解析失败时用"复制同款协议的第二实现"
    degradedReason = err?.message ?? String(err)
    console.log(`      ! esbuild 降级：${degradedReason}`)
    makeStore = makeFallbackStore
    return `DEGRADED：${degradedReason}`
  }
})

/** 降级实现：复制 todos-file.ts 的锁/原子写语义（只有协议，不是产品代码） */
function makeFallbackStore(home) {
  const file = path.join(home, 'data', 'todos.json')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lockPath = `${file}.lock`
  const token = `${process.pid}:fallback`
  const acquire = () => {
    for (let i = 0; i < 200; i++) {
      try {
        fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 })
        return
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 5000) {
            fs.rmSync(lockPath, { force: true })
            continue
          }
        } catch {}
        sleepSync(10)
      }
    }
    throw new Error('降级实现抢锁失败')
  }
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { version: 1, todos: [] }
    }
  }
  const write = (data) => {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  }
  return {
    kind: 'fallback-copy',
    create: (title) => {
      acquire()
      try {
        const data = read()
        const now = new Date().toISOString()
        const todo = {
          id: globalThis.crypto.randomUUID(),
          title,
          status: 'open',
          createdAt: now,
          updatedAt: now,
          bindings: [],
        }
        data.todos.push(todo)
        write(data)
        return todo
      } finally {
        try {
          if (fs.readFileSync(lockPath, 'utf8') === token) fs.rmSync(lockPath, { force: true })
        } catch {}
      }
    },
    list: () => read().todos,
  }
}

await check(
  `(b1) TodoStore + 3 个 server 同时各写 ${PER_WRITER} 条 → ${(SERVER_WRITERS_B + 1) * PER_WRITER} 条守恒（${degradedReason ? 'DEGRADED' : '真实 Main 代码'}）`,
  async () => {
    if (!makeStore) throw new Error('store 未就绪')
    const store = makeStore(homeB)
    const clients = []
    try {
      for (let i = 0; i < SERVER_WRITERS_B; i++) {
        clients.push(await new MiniClient({ home: homeB, tag: `s${i}` }).start())
      }

      // 先把 3×20 个请求灌进子进程 stdin，让它们真的开始在别的进程里跑
      const serverWrites = clients.map((c) => c.createMany('b', PER_WRITER))
      await new Promise((resolve) => setImmediate(resolve)) // 让 stdin 写入落到 pipe

      // 主线程同步写（TodoStore 是同步 API）：与子进程的写在时间上重叠
      let storeCreated = 0
      for (let i = 0; i < PER_WRITER; i++) {
        // FileLock 40 次尝试失败会抛错；并发下允许重试，但不能"跳过"
        let todo
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            todo = store.create(`store-b-${i}`)
            break
          } catch (err) {
            if (!/文件锁|lock/i.test(String(err?.message))) throw err
            sleepSync(5 + attempt * 2)
          }
        }
        assert(todo, `store 第 ${i} 条始终抢不到锁`)
        storeCreated++
      }

      const serverResults = (await Promise.all(serverWrites)).flat()
      assertEqual(serverResults.length, SERVER_WRITERS_B * PER_WRITER, 'server 应答数')
      assertEqual(
        serverResults.filter((r) => r.structuredContent?.created === true).length,
        SERVER_WRITERS_B * PER_WRITER,
        'server created=true 数',
      )
      for (const c of clients) assertEqual(await c.close(), 0, `${c.tag} 退出码`)

      const file = readTodos(homeB)
      assertEqual(file.todos.length, (SERVER_WRITERS_B + 1) * PER_WRITER, 'todos 条数')
      assertShape(file.todos, '(b1)')
      assertEqual(store.list().length, (SERVER_WRITERS_B + 1) * PER_WRITER, 'Main 侧 store.list() 条数')
      assertEqual(storeCreated, PER_WRITER, 'store 写入条数')
      assert(file.todos.some((t) => t.title === 'store-b-0'), '缺 store 写入的条目')
      assert(file.todos.some((t) => t.title.startsWith('b-s0-')), '缺 server s0 写入的条目')

      const hygiene = inspectHome(homeB)
      assertEqual(hygiene.lock, false, '锁文件最终应不存在')
      return `${file.todos.length} todos · 1 store + ${SERVER_WRITERS_B} servers（store.list 也读到 ${file.todos.length}）`
    } finally {
      for (const c of clients) c.kill()
    }
  },
)

await check('(b2) 再补 2 个 server 进程 × 20 → 总数对齐任务书的 120 条', async () => {
  if (!makeStore) throw new Error('store 未就绪')
  const store = makeStore(homeB)
  const clients = []
  try {
    for (let i = 0; i < 2; i++) clients.push(await new MiniClient({ home: homeB, tag: `x${i}` }).start())
    const writes = clients.map((c) => c.createMany('x', PER_WRITER))
    await new Promise((resolve) => setImmediate(resolve))
    const serverResults = (await Promise.all(writes)).flat()
    for (const c of clients) {
      assertEqual(await c.close(), 0, `${c.tag} 退出码`)
    }
    assertEqual(
      serverResults.filter((r) => r.structuredContent?.created === true).length,
      2 * PER_WRITER,
      '新增 created=true 数',
    )

    const file = readTodos(homeB)
    assertEqual(file.todos.length, 120, 'todos 条数（120）')
    assertShape(file.todos, '(b2)')
    assertEqual(store.list().length, 120, 'Main 侧 store.list() 条数')
    assertEqual(inspectHome(homeB).lock, false, '锁文件最终应不存在')
    assertEqual(inspectHome(homeB).corrupt.length, 0, '不应出现损坏备份')
    return `120 todos · 累计 1 store + 5 server 进程 · 无丢写`
  } finally {
    for (const c of clients) c.kill()
  }
})

await check('(b3) 跨运行时读：TodoStore 能读到 server 写的条目，字段完整', async () => {
  if (!makeStore) throw new Error('store 未就绪')
  const store = makeStore(homeB)
  const todos = store.list()
  assertEqual(todos.length, 120, 'store.list()')
  const fromServer = todos.find((t) => t.title === 'b-s0-0')
  assert(fromServer, '缺 server 写入的 b-s0-0')
  assertEqual(fromServer.status, 'open', 'status')
  assertEqual(fromServer.bindings.length, 0, 'bindings（未绑定会话时为空数组）')
  const fromStore = todos.find((t) => t.title === 'store-b-0')
  assert(fromStore, '缺 store 写入的 store-b-0')
  // 反向：server 的 list_todos 也应读到 TodoStore 写的条目
  const reader = await new MiniClient({ home: homeB, tag: 'reader' }).start()
  try {
    const res = await reader.request('tools/call', {
      name: 'list_todos',
      arguments: { status: 'all', limit: 500 },
    })
    assertEqual(res.structuredContent?.count, 120, 'server 侧 list_todos count')
    assert(
      res.structuredContent.todos.some((t) => t.title === 'store-b-0'),
      'server 侧读不到 TodoStore 写的条目',
    )
  } finally {
    await reader.close()
  }
  return '双向可见（Main→文件←server）'
})

// ---------- 汇总 ----------
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} PASS${failed ? ` · ${failed} FAIL` : ''}`)
if (degradedReason) console.log(`注意：(b) 走了降级实现（${degradedReason}）`)
if (failed) {
  console.log('\n失败明细：')
  for (const r of results.filter((x) => !x.ok)) console.log(`- ${r.name}: ${r.detail}`)
  process.exit(1)
}
console.log(`全部通过。保留产物：${STORE_BUNDLE}`)
process.exit(0)
