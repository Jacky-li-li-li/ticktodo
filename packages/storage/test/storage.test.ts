/**
 * @tick/storage 行为测试（node --test，直接跑 TS 源码）。
 * 断言的是用户可观察的行为：锁的互斥与陈旧判定、原子写产物、jsonc 解析结果。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  FileLock,
  atomicWriteJson,
  cleanStaleTmp,
  lockPathFor,
  parseJsonc,
  readJson,
  resolveTickHome,
  writeFileAtomic,
} from '../src/index.ts'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

test('FileLock: 互斥、释放后可重入', () => {
  const dir = tmpDir('tick-lock')
  const file = path.join(dir, 'todos.json')
  const a = new FileLock(file)
  const b = new FileLock(file)
  assert.equal(a.acquire(), true)
  // 持有者还活着（就是本进程）→ 短预算内拿不到，不抢活锁
  assert.equal(b.acquire(100), false)
  a.release()
  assert.equal(b.acquire(100), true)
  b.release()
})

test('FileLock: 崩溃残留（PID 已死）立即判定陈旧，不用等 5s', () => {
  const dir = tmpDir('tick-lock-stale')
  const file = path.join(dir, 'todos.json')
  const lock = lockPathFor(file)
  // pid 4 亿+ 在 macOS/Linux 上不可能存活
  fs.writeFileSync(lock, '4000000000:deadbeef', 'utf8')
  const a = new FileLock(file)
  assert.equal(a.acquire(1000), true)
  a.release()
})

test('FileLock: release 只删自己持有的锁', () => {
  const dir = tmpDir('tick-lock-foreign')
  const file = path.join(dir, 'todos.json')
  const lock = lockPathFor(file)
  const a = new FileLock(file)
  assert.equal(a.acquire(), true)
  // 模拟锁被别人强夺后写入了他人的 token
  fs.writeFileSync(lock, `${process.pid}:someone-else`, 'utf8')
  a.release()
  assert.equal(fs.existsSync(lock), true, '别人的锁不能被误删')
  fs.rmSync(lock, { force: true })
})

test('atomicWriteJson: 读回一致、无 tmp 残留、原子覆盖', () => {
  const dir = tmpDir('tick-write')
  const file = path.join(dir, 'data.json')
  atomicWriteJson(file, { version: 1, todos: [{ title: '你好 world', n: 1 }] })
  assert.deepEqual(readJson<{ version: number; todos: { title: string; n: number }[] }>(file), {
    version: 1,
    todos: [{ title: '你好 world', n: 1 }],
  })
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), '统一带结尾换行')
  atomicWriteJson(file, { version: 1, todos: [] })
  assert.deepEqual(readJson(file).todos, [])
  const residue = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  assert.deepEqual(residue, [], '成功写完不留 tmp')
})

test('parseJsonc: 注释/尾逗号/字符串内容边界', () => {
  assert.deepEqual(parseJsonc('{ "a": 1, /* c */ "b": 2 }'), { a: 1, b: 2 })
  assert.deepEqual(parseJsonc('{ "a": [1, 2,], }'), { a: [1, 2] })
  assert.deepEqual(parseJsonc('// lead\n{ "a": 1 } // tail'), { a: 1 })
  // 字符串里的 `,}` 与 // 不得被改写（此前尾逗号正则会误伤）
  assert.deepEqual(parseJsonc('{ "s": "x,}y", "u": "http://e.com" }'), { s: 'x,}y', u: 'http://e.com' })
  assert.equal(parseJsonc('{ broken'), undefined)
})

test('resolveTickHome: TICK_HOME trim 语义两侧一致', () => {
  const prev = process.env.TICK_HOME
  try {
    process.env.TICK_HOME = '  /tmp/tick-home  '
    assert.equal(resolveTickHome(), '/tmp/tick-home')
    delete process.env.TICK_HOME
    assert.equal(resolveTickHome(), path.join(os.homedir(), '.ticktodo'))
  } finally {
    if (prev === undefined) delete process.env.TICK_HOME
    else process.env.TICK_HOME = prev
  }
})

test('cleanStaleTmp: 只清超龄 .tmp', () => {
  const dir = tmpDir('tick-tmp-clean')
  const old = path.join(dir, 'todos.json.1.2.tmp')
  const fresh = path.join(dir, 'todos.json.3.4.tmp')
  const keep = path.join(dir, 'todos.json.corrupt-2026')
  for (const f of [old, fresh, keep]) fs.writeFileSync(f, 'x')
  // 把 old 回拨 2 小时
  const past = new Date(Date.now() - 2 * 3600_000)
  fs.utimesSync(old, past, past)
  assert.equal(cleanStaleTmp(dir, 3600_000), 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true)
  assert.equal(fs.existsSync(keep), true, 'corrupt 备份不是 tmp，不动')
})

test('writeFileAtomic: 数据是 Uint8Array 也能写（extension 打包产物场景）', () => {
  const dir = tmpDir('tick-bytes')
  const file = path.join(dir, 'bin.dat')
  writeFileAtomic(file, Buffer.from([1, 2, 3]))
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3])
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

// 环境自检：node 版本必须支持 strip/transform types（防止 CI 环境悄悄退化）
test('runner: node --experimental-strip-types 可用', () => {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', '-e', 'process.stdout.write("ok")'], {
    encoding: 'utf8',
  })
  assert.equal(out, 'ok')
})
