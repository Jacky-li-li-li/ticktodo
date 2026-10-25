/**
 * @tick/todo-core 行为测试：锁协议、外部数据校验、业务规则与 tmp 清理。
 * 断言公开接口可观察的行为（node --test，直接跑 TS 源码）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TodoDataError, TodoStoreCore, cleanStaleTmp } from '../src/index.ts'

function tmpFile(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  return path.join(dir, 'todos.json')
}

const binding = (sessionId: string, toolId = 'pi', state: 'pending' | 'verified' = 'verified') => ({
  toolId,
  sessionId,
  boundAt: new Date().toISOString(),
  state,
})

test('锁：崩溃残留（PID 已死）立即可抢，不用等 5s', () => {
  const file = tmpFile('tick-lock-stale')
  const lock = `${file}.lock`
  // pid 4 亿+ 在 macOS/Linux 上不可能存活
  fs.writeFileSync(lock, '4000000000:deadbeef', 'utf8')
  const store = new TodoStoreCore({ file, lockTimeoutMs: 1000 })
  const start = Date.now()
  store.create({ title: '残留锁后第一条' })
  assert.ok(Date.now() - start < 2000, `应在 PID 存活判定后立刻拿锁（耗时 ${Date.now() - start}ms）`)
})

test('锁：活锁绝不强夺，超时按 TICK_E_LOCK_TIMEOUT 报错', () => {
  const file = tmpFile('tick-lock-live')
  fs.writeFileSync(`${file}.lock`, `${process.pid}:alive-token`, 'utf8')
  const store = new TodoStoreCore({ file, lockTimeoutMs: 300 })
  assert.throws(
    () => store.create({ title: 'x' }),
    (e: unknown) => e instanceof TodoDataError && e.code === 'TICK_E_LOCK_TIMEOUT',
  )
  fs.rmSync(`${file}.lock`, { force: true })
})

test('业务规则 4（锁内）：同 session 不能绑到第二条 todo', () => {
  const file = tmpFile('tick-rule4')
  const store = new TodoStoreCore({ file })
  const a = store.create({ title: 'A' }).todo
  const b = store.create({ title: 'B' }).todo
  store.update(a.id, { addBinding: binding('s1') })

  assert.throws(() => store.update(b.id, { addBinding: binding('s1') }), /已绑定到「A」/)
  const direct = store.addBinding(b.id, binding('s1'))
  assert.equal(direct.ok, false)
  assert.equal(direct.conflictTodo?.id, a.id, 'addBinding 返回冲突方而不是覆盖')
})

test('update: body 空串清空、标题空拒绝、坏 binding 由 IPC 白名单挡（store 只管合法输入）', () => {
  const store = new TodoStoreCore({ file: tmpFile('tick-update') })
  const todo = store.create({ title: '修 Bug', body: '先复现' }).todo
  store.update(todo.id, { body: '' })
  assert.equal(store.list()[0]?.body, undefined, 'body 清空要真的清掉')
  assert.throws(() => store.update(todo.id, { title: '   ' }), /标题为空/)
})

test('外部数据：坏条目丢弃、好条目保留；结构坏/version 不支持走 corrupt 备份', () => {
  const file = tmpFile('tick-parse')
  const store = new TodoStoreCore({ file })
  const good = store.create({ title: '好的那条' }).todo

  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, todos: [null, { id: 1 }, { ...good, status: 'weird' }, good] }),
  )
  const list = store.list()
  assert.equal(list.length, 1, '核心字段坏的条目丢弃，标题保住')
  assert.equal(list[0]?.title, '好的那条')

  fs.writeFileSync(file, JSON.stringify({ version: 2, todos: [] }))
  assert.deepEqual(new TodoStoreCore({ file }).list(), [], '未来版本不硬读（默认 empty 策略）')
  assert.ok(
    fs.readdirSync(path.dirname(file)).some((n) => n.includes('.corrupt-')),
    '原件必须有备份可人工恢复',
  )
})

test('corrupt:throw 策略（MCP 写路径）：解析失败抛 TICK_E_DATA_CORRUPT，不用空表覆盖', () => {
  const file = tmpFile('tick-corrupt-throw')
  fs.writeFileSync(file, '{ not json')
  const store = new TodoStoreCore({ file, onCorrupt: 'throw' })
  assert.throws(
    () => store.list(),
    (e: unknown) => e instanceof TodoDataError && e.code === 'TICK_E_DATA_CORRUPT',
  )
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', '原件未被覆盖')
})

test('requestId 幂等：命中返回既有 todo 且不重写文件', () => {
  const file = tmpFile('tick-idem')
  const store = new TodoStoreCore({ file })
  const first = store.create({ title: '第一次', requestId: 'conv:call1' })
  assert.equal(first.created, true)
  const before = fs.readFileSync(file, 'utf8')
  const again = store.create({ title: '第二次', requestId: 'conv:call1' })
  assert.equal(again.created, false)
  assert.equal(again.todo.id, first.todo.id)
  assert.equal(fs.readFileSync(file, 'utf8'), before, '命中幂等键不写文件（不触发 watcher）')
})

test('markBinding / removeBinding primary 退位', () => {
  const store = new TodoStoreCore({ file: tmpFile('tick-mark') })
  const todo = store.create({ title: 'A' }).todo
  store.update(todo.id, { addBinding: binding('s1') })
  store.update(todo.id, { addBinding: binding('s2') })
  store.update(todo.id, { primarySessionId: 's1' })

  assert.equal(store.markBinding('s1', 'verified'), false, '无变化 = false')
  store.update(todo.id, { addBinding: { ...binding('s1'), state: 'pending' } })
  assert.equal(store.markBinding('s1', 'verified', '/f.jsonl', 'pi'), true)
  assert.equal(store.removeBinding(todo.id, 's1', 'pi'), true)
  assert.equal(store.list()[0]?.primarySessionId, 's2', 'primary 删掉后退到剩余第一条')
})

test('cleanStaleTmp: 只清超龄 .tmp，corrupt 备份与正式文件不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-tmpclean-'))
  const oldTmp = path.join(dir, 'todos.json.1.2.tmp')
  const freshTmp = path.join(dir, 'todos.json.3.4.tmp')
  const keep = path.join(dir, 'todos.json.corrupt-2026')
  for (const f of [oldTmp, freshTmp, keep]) fs.writeFileSync(f, 'x')
  const past = new Date(Date.now() - 2 * 3600_000)
  fs.utimesSync(oldTmp, past, past)
  assert.equal(cleanStaleTmp(dir, 3600_000), 1)
  assert.equal(fs.existsSync(oldTmp), false)
  assert.equal(fs.existsSync(freshTmp), true)
  assert.equal(fs.existsSync(keep), true)
})
