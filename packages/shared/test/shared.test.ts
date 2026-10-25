/** parseTodosFile / sanitizeTodoPatch 的行为测试：外部数据在边界被收敛成合法领域类型 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTodosFile, sanitizeTodoPatch } from '../src/index.ts'

const validTodo = {
  id: 't1',
  title: '写周报',
  status: 'open',
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
  bindings: [{ toolId: 'pi', sessionId: 's1', boundAt: '2026-10-24T00:00:00Z', state: 'verified' }],
  primarySessionId: 's1',
}

test('parseTodosFile: 合法文件原样通过（含 mcpOrigin）', () => {
  const parsed = parseTodosFile({
    version: 1,
    todos: [{ ...validTodo, mcpOrigin: { toolId: 'claude', at: '2026-10-24T00:00:00Z', cwd: '/p' } }],
  })
  assert.ok(parsed)
  assert.equal(parsed.todos[0]?.mcpOrigin?.toolId, 'claude')
})

test('parseTodosFile: 结构坏 → undefined（调用方走 corrupt 备份）', () => {
  assert.equal(parseTodosFile(null), undefined)
  assert.equal(parseTodosFile('nope'), undefined)
  assert.equal(parseTodosFile({ version: 2, todos: [] }), undefined, '未来版本不硬读')
  assert.equal(parseTodosFile({ version: 1 }), undefined, '缺 todos 数组')
})

test('parseTodosFile: 坏条目丢弃；坏字段丢弃但 todo 保留', () => {
  const parsed = parseTodosFile({
    version: 1,
    todos: [
      null,
      { id: 123 },
      { ...validTodo, id: 't-bad-status', status: 'weird' },
      // 坏 binding 全丢、坏 mcpOrigin 全丢，但 todo 本身（标题）保留
      { ...validTodo, id: 't-bad-bindings', bindings: [{ toolId: 'pi', sessionId: 's1', boundAt: 'x', state: 'bogus' }, 7] },
      { ...validTodo, id: 't-bad-origin', mcpOrigin: { at: 'missing toolId' } },
      validTodo,
    ],
  })
  assert.ok(parsed)
  const ids = parsed.todos.map((t) => t.id).sort()
  assert.deepEqual(ids, ['t-bad-bindings', 't-bad-origin', 't1'], '只有核心字段坏的条目被丢弃')
  const badBindings = parsed.todos.find((t) => t.id === 't-bad-bindings')
  assert.equal(badBindings?.bindings.length, 0)
  const badOrigin = parsed.todos.find((t) => t.id === 't-bad-origin')
  assert.equal(badOrigin?.mcpOrigin, undefined)
})

test('sanitizeTodoPatch: 白名单归一化，未知字段不进 patch', () => {
  assert.deepEqual(sanitizeTodoPatch({ title: ' 新标题 ', unknown: 1 }), { title: ' 新标题 ' })
  assert.deepEqual(sanitizeTodoPatch({ body: '' }), { body: '' }, '空串 = 清空正文，必须保留')
  assert.equal(sanitizeTodoPatch({ status: 'weird' }), undefined)
  assert.equal(sanitizeTodoPatch({ title: 42 }), undefined)
  const patch = sanitizeTodoPatch({
    addBinding: { toolId: 'pi', sessionId: 's1', boundAt: 'x', state: 'pending', origin: 'mcp' },
    primarySessionId: 's1',
    lastLaunch: { toolId: 'pi', projectPath: '/p', launchedAt: 'x' },
  })
  assert.ok(patch?.addBinding && patch.primarySessionId && patch.lastLaunch)
  assert.equal(
    sanitizeTodoPatch({ addBinding: { toolId: 'pi', sessionId: 7, boundAt: 'x' } }),
    undefined,
    '坏 binding 不进 patch',
  )
  assert.equal(
    sanitizeTodoPatch({ addBinding: { toolId: 'pi', sessionId: 's1', boundAt: 'x', origin: 'other' } }),
    undefined,
    'origin 只允许 mcp',
  )
  assert.equal(sanitizeTodoPatch({}), undefined, '没有合法字段 = 没有更新')
})
