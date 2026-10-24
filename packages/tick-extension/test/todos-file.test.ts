/**
 * extension 侧领域逻辑（todos-file）行为测试：幂等键、同会话去重、损坏处理。
 * 通过 TICK_HOME 指向临时目录，不碰真实 ~/.ticktodo。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createTodo, listTodos, describeTodo } from '../src/todos-file.ts'
import { resolveTickHome, todosFilePath } from '@tick/storage'

function withTmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-ext-'))
  process.env.TICK_HOME = home
  return home
}

test('createTodo: 建单 + requestId 幂等（命中不重写文件）', () => {
  const home = withTmpHome()
  const first = createTodo({ title: ' 调研方案 ', source: 'panel', requestId: 'conv:call1' })
  assert.equal(first.created, true)
  assert.equal(first.todo.title, '调研方案')

  const file = todosFilePath()
  const before = fs.readFileSync(file, 'utf8')
  const again = createTodo({ title: '调研方案（改了名字也不该重复建）', source: 'panel', requestId: 'conv:call1' })
  assert.equal(again.created, false)
  assert.equal(again.todo.id, first.todo.id, '命中 requestId 返回既有那条')
  assert.equal(fs.readFileSync(file, 'utf8'), before, '命中幂等键不写文件（不触发 Main watch）')
  assert.equal(listTodos({ status: 'all' }).length, 1)
})

test('createTodo: 同一 session 只建一条；无 requestId 时靠 sessionId 去重', () => {
  withTmpHome()
  const a = createTodo({ title: '第一次', sessionId: 'sess-1', source: 'pi' })
  const b = createTodo({ title: '第二次', sessionId: 'sess-1', source: 'pi' })
  assert.equal(b.created, false)
  assert.equal(b.todo.id, a.todo.id)
  const list = listTodos({ status: 'open' })
  assert.equal(list.length, 1)
  assert.equal(list[0]?.primarySessionId, 'sess-1')
  assert.equal(describeTodo(list[0] as never).includes('sess-1'.slice(0, 8)), true)
})

test('createTodo: 空标题拒绝；文件损坏时备份后继续（写路径）', () => {
  const home = withTmpHome()
  assert.throws(() => createTodo({ title: '  ' }), /标题为空/)

  const file = todosFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'NOT JSON AT ALL')
  const todo = createTodo({ title: '损坏后新建' })
  assert.equal(todo.created, true)
  const backup = fs.readdirSync(path.dirname(file)).find((n) => n.includes('.corrupt-'))
  assert.ok(backup, '损坏原件必须留备份')
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backup as string), 'utf8'), 'NOT JSON AT ALL')
  assert.equal(path.dirname(file), path.join(resolveTickHome(), 'data'))
})

test('listTodos: 状态过滤 + TICK_HOME 覆盖生效', () => {
  const home = withTmpHome()
  createTodo({ title: '开着' })
  createTodo({ title: '完事' })
  const done = JSON.parse(fs.readFileSync(todosFilePath(), 'utf8')) as {
    todos: { id: string; title: string }[]
  }
  const doneId = done.todos.find((t) => t.title === '完事')?.id
  fs.writeFileSync(
    todosFilePath(),
    JSON.stringify({
      version: 1,
      todos: done.todos.map((t) => (t.id === doneId ? { ...t, status: 'done' } : t)),
    }),
  )
  assert.equal(listTodos({ status: 'open' }).map((t) => t.title).join(), '开着')
  assert.equal(listTodos({ status: 'done' }).length, 1)
  assert.equal(home.startsWith(os.tmpdir()), true)
})
