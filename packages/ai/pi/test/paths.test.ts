/** parseJsonc 行为测试：注释/尾逗号容错，字符串内容不被改写 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseJsonc } from '../src/paths.ts'

test('parseJsonc: 注释与尾逗号', () => {
  assert.deepEqual(parseJsonc('{ "a": 1, /* c */ "b": 2 }'), { a: 1, b: 2 })
  assert.deepEqual(parseJsonc('{ "a": [1, 2,], }'), { a: [1, 2] })
  assert.deepEqual(parseJsonc('// lead\n{ "a": 1 } // tail'), { a: 1 })
  // 注释夹在尾逗号与括号之间也要能剥
  assert.deepEqual(parseJsonc('{ "a": 1, /* x */ }'), { a: 1 })
})

test('parseJsonc: 字符串内容不被改写（尾逗号正则会误伤的场景）', () => {
  assert.deepEqual(parseJsonc('{ "s": "x,}y", "u": "http://e.com" }'), { s: 'x,}y', u: 'http://e.com' })
  assert.equal(parseJsonc('{ broken'), undefined)
})
