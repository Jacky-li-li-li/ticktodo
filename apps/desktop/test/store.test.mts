/**
 * TodoStore 行为测试：业务规则 1/3/4/5 与损坏恢复，全部走公开接口（create/update/list/...）。
 * 用 .mts 后缀：apps/desktop 不是 ESM 包，显式按模块跑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TodoStore } from '../src/main/store.ts'

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-store-'))
  return path.join(dir, 'todos.json')
}

const binding = (sessionId: string, state: 'pending' | 'verified' = 'verified') => ({
  toolId: 'pi',
  sessionId,
  boundAt: new Date().toISOString(),
  state,
})

test('create/update/list：标题必填、body 空串可清空', () => {
  const store = new TodoStore(tmpFile())
  const todo = store.create({ title: ' 修Bug ' })
  assert.equal(todo.title, '修Bug')
  assert.equal(store.list().length, 1)

  assert.throws(() => store.create({ title: '   ' }), /标题为空/)
  assert.throws(() => store.update(todo.id, { title: '' }), /标题为空/)

  store.update(todo.id, { body: '先复现' })
  assert.equal(store.list()[0]?.body, '先复现')
  store.update(todo.id, { body: '' })
  assert.equal(store.list()[0]?.body, undefined, 'body 清空要真的清掉')
})

test('业务规则 4：同一 session 不能绑到第二个 todo（锁内强制）', () => {
  const store = new TodoStore(tmpFile())
  const a = store.create({ title: 'A' })
  const b = store.create({ title: 'B' })
  store.update(a.id, { addBinding: binding('s1') })

  assert.throws(() => store.update(b.id, { addBinding: binding('s1') }), /已绑定到「A」/)
  // 重复 add 到同一条 todo：只更新状态，不产生第二条绑定
  store.update(a.id, { addBinding: binding('s1', 'pending') })
  store.update(a.id, { addBinding: binding('s1', 'verified') })
  const found = store.list().find((t) => t.id === a.id)
  assert.equal(found?.bindings.length, 1)
  assert.equal(found?.bindings[0]?.state, 'verified')
})

test('markBinding / findTodoBySession / removeBinding（primary 退位）', () => {
  const store = new TodoStore(tmpFile())
  const a = store.create({ title: 'A' })
  store.update(a.id, { addBinding: binding('s1') })
  store.update(a.id, { addBinding: binding('s2') })

  assert.equal(store.findTodoBySession('s2')?.id, a.id)
  assert.equal(store.findTodoBySession('missing'), undefined)

  assert.equal(store.markBinding('s1', 'verified'), false, '无变化 = false')
  store.update(a.id, { addBinding: { ...binding('s1'), state: 'pending' } })
  assert.equal(store.markBinding('s1', 'verified', '/f.jsonl'), true)
  assert.equal(store.list()[0]?.bindings.find((b) => b.sessionId === 's1')?.filePath, '/f.jsonl')

  store.update(a.id, { primarySessionId: 's1' })
  assert.equal(store.removeBinding(a.id, 's1'), true)
  assert.equal(store.list()[0]?.primarySessionId, 's2', 'primary 删掉后退到剩余第一条')
  assert.equal(store.removeBinding(a.id, 's1'), false, '重复解绑 no-op')
})

test('删除 todo：绑定随之消失（业务规则 5，session 文件不归我们管）', () => {
  const store = new TodoStore(tmpFile())
  const a = store.create({ title: 'A' })
  store.update(a.id, { addBinding: binding('s1') })
  store.remove(a.id)
  assert.equal(store.list().length, 0)
})

test('损坏恢复：解析失败先备份再空表；version 不支持同样处理', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{ not json')
  const store = new TodoStore(file)
  assert.deepEqual(store.list(), [])
  const backup1 = fs.readdirSync(path.dirname(file)).find((n) => n.includes('.corrupt-'))
  assert.ok(backup1, '原件必须有备份可人工恢复')
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backup1 as string), 'utf8'), '{ not json')

  fs.writeFileSync(file, JSON.stringify({ version: 9, todos: [] }))
  const store2 = new TodoStore(file)
  assert.deepEqual(store2.list(), [])
  assert.ok(
    fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-')).length >= 2,
    '第二次损坏也留备份',
  )
})

test('垃圾条目被丢弃但不整体报废：好条目在下次保存后仍在', () => {
  const file = tmpFile()
  const store1 = new TodoStore(file)
  store1.create({ title: '好的那条' })
  const good = store1.list()[0]
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      todos: [{ id: 'x', title: 5, status: 'open', createdAt: '', updatedAt: '', bindings: [] }, good],
    }),
  )
  const store2 = new TodoStore(file)
  const list = store2.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.title, '好的那条')
  // 保存后垃圾不再回流到文件
  store2.create({ title: '新线索' })
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { todos: { title: unknown }[] }
  assert.equal(raw.todos.some((t) => typeof t.title !== 'string'), false)
})
