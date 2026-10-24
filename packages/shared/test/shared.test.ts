/** parseTodosFile / sanitizeTodoPatch 的行为测试：外部数据在边界被收敛成合法领域类型 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTodosFile, sanitizeTodoPatch } from '../src/index.ts'

const validTodo = {
  id: 't1',
  title: '写周报',
  body: '周五前',
  status: 'open',
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
  bindings: [{ toolId: 'pi', sessionId: 's1', boundAt: '2026-10-24T00:00:00Z', state: 'verified' }],
  primarySessionId: 's1',
}

test('parseTodosFile: 合法文件原样通过', () => {
  const parsed = parseTodosFile({ version: 1, todos: [validTodo] })
  assert.ok(parsed)
  assert.equal(parsed.todos.length, 1)
  assert.equal(parsed.todos[0]?.title, '写周报')
  assert.equal(parsed.todos[0]?.bindings[0]?.sessionId, 's1')
})

test('parseTodosFile: 结构坏 → undefined（调用方走 corrupt 备份）', () => {
  assert.equal(parseTodosFile(null), undefined)
  assert.equal(parseTodosFile('nope'), undefined)
  assert.equal(parseTodosFile({ version: 2, todos: [] }), undefined, '未来版本不硬读')
  assert.equal(parseTodosFile({ version: 1 }), undefined, '缺 todos 数组')
})

test('parseTodosFile: 坏条目丢弃、好条目保留（标题是最值钱的数据）', () => {
  const parsed = parseTodosFile({
    version: 1,
    todos: [null, { id: 123 }, { ...validTodo, status: 'weird' }, validTodo],
  })
  assert.ok(parsed)
  assert.equal(parsed.todos.length, 1)
  assert.equal(parsed.todos[0]?.id, 't1')
})

test('parseTodosFile: 坏 binding 丢弃但 todo 保留；缺省字段补齐', () => {
  const parsed = parseTodosFile({
    version: 1,
    todos: [
      {
        ...validTodo,
        bindings: [{ toolId: 'pi', sessionId: 's1', boundAt: 'x', state: 'bogus' }, null],
      },
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed.todos[0]?.bindings.length, 0, 'state 非法 / null 的 binding 全丢')
  const minimal = parseTodosFile({
    version: 1,
    todos: [
      {
        id: 't2',
        title: 't',
        status: 'done',
        createdAt: 'x',
        updatedAt: 'y',
        bindings: [],
      },
    ],
  })
  assert.ok(minimal)
  assert.equal(minimal.todos[0]?.body, undefined)
})

test('sanitizeTodoPatch: 白名单归一化', () => {
  assert.deepEqual(sanitizeTodoPatch({ title: ' 新标题 ', unknown: 1 }), { title: ' 新标题 ' })
  assert.deepEqual(sanitizeTodoPatch({ body: '' }), { body: '' }, '空串 = 清空正文，必须保留')
  assert.deepEqual(sanitizeTodoPatch({ status: 'done' }), { status: 'done' })
  assert.equal(sanitizeTodoPatch({ status: 'weird' }), undefined, '未知 status 不落盘')
  assert.equal(sanitizeTodoPatch({ title: 42 }), undefined)
  const patch = sanitizeTodoPatch({
    addBinding: { toolId: 'pi', sessionId: 's1', boundAt: 'x', state: 'pending' },
    primarySessionId: 's1',
    lastLaunch: { toolId: 'pi', projectPath: '/p', launchedAt: 'x' },
  })
  assert.ok(patch?.addBinding && patch.primarySessionId && patch.lastLaunch)
  assert.equal(
    sanitizeTodoPatch({ addBinding: { toolId: 'pi', sessionId: 7, boundAt: 'x' } }),
    undefined,
    '坏 binding 不进 patch',
  )
  assert.equal(sanitizeTodoPatch({}), undefined, '没有合法字段 = 没有更新')
})
