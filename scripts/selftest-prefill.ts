/**
 * 预填/多工具关键边界断言（无测试框架；由 scripts/selftest-prefill.mjs 打包执行）。
 * 覆盖：pi 版本门槛、prefill ack/超时/超限降级、扩展 ack、启动清理、terminal env 转义、
 *       TodoStore 按 (toolId, sessionId) 精确绑定、LaunchService 的 usable/降级/resume fail-closed。
 * 不依赖本机安装 pi/WorkBuddy，也不碰真实数据。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PiAdapter } from '../packages/ai/pi/src/index.ts'
import tickExtension from '../packages/tick-extension/src/index.ts'
import { cleanupLaunchCache, renderTerminalScript } from '../apps/desktop/src/main/services/terminal-launch.ts'
import { TodoStore } from '../apps/desktop/src/main/store.ts'
import { LaunchService } from '../apps/desktop/src/main/services/launch.ts'
import { DEFAULT_SETTINGS, newCliSessionId } from '../packages/shared/src/index.ts'

let passed = 0
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log('PASS', name)
    })
    .catch((e) => {
      console.error('FAIL', name, e)
      process.exitCode = 1
    })
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'tick-selftest-case-'))
const sid = '11111111-2222-4333-8444-555555555555'

// ---- pi 版本门槛 ----
await check('old pi is installed but unusable', async () => {
  const fake = path.join(dir, 'old-pi.sh')
  writeFileSync(fake, '#!/bin/sh\necho "1.2.0"\n', { mode: 0o700 })
  const d = await new PiAdapter({ resolveExe: async () => fake, sessionRoots: () => [] }).detect()
  assert.equal(d.installed, true)
  assert.equal(d.usable, false)
})

// ---- prefill ack / 超时 / 超限 ----
await check('prefill ack ok', async () => {
  const clips: string[] = []
  const pi = new PiAdapter({
    resolveExe: async () => '/bin/echo',
    sessionRoots: () => [],
    prefillDir: dir,
    clipboardWrite: (t) => clips.push(t),
    prefillAckTimeoutMs: 500,
    openTerminal: (spec) => {
      writeFileSync(spec.env!.TICK_LAUNCH_ACK!, JSON.stringify({ ok: true }), { mode: 0o600 })
      rmSync(spec.env!.TICK_LAUNCH_FILE!, { force: true })
    },
  })
  const r = await pi.launch({ promptText: 'hello', cwd: dir, sessionId: sid, deliver: 'prefill' })
  assert.equal(r.delivered, 'prefill')
  assert.equal(r.notice, undefined)
  assert.equal(clips.length, 0)
})

await check('prefill ack timeout falls back to clipboard + notice', async () => {
  const clips: string[] = []
  const pi = new PiAdapter({
    resolveExe: async () => '/bin/echo',
    sessionRoots: () => [],
    prefillDir: dir,
    clipboardWrite: (t) => clips.push(t),
    prefillAckTimeoutMs: 100,
    openTerminal: () => {},
  })
  const r = await pi.launch({
    promptText: 'fallback',
    cwd: dir,
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    deliver: 'prefill',
  })
  assert.equal(r.delivered, 'clipboard')
  assert.ok(r.notice)
  assert.deepEqual(clips, ['fallback'])
  assert.equal(existsSync(path.join(dir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.prefill.json')), false)
})

await check('oversize prefill falls back to clipboard without prefill env', async () => {
  const clips: string[] = []
  let spec: { env?: Record<string, string> } | undefined
  const pi = new PiAdapter({
    resolveExe: async () => '/bin/echo',
    sessionRoots: () => [],
    prefillDir: dir,
    clipboardWrite: (t) => clips.push(t),
    prefillAckTimeoutMs: 100,
    openTerminal: (s) => { spec = s },
  })
  const big = 'x'.repeat(200_001)
  const r = await pi.launch({ promptText: big, cwd: dir, sessionId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', deliver: 'prefill' })
  assert.equal(r.delivered, 'clipboard')
  assert.ok(r.notice)
  assert.equal(spec?.env, undefined)
  assert.deepEqual(clips, [big])
})

// ---- tick-extension ack ----
const handlers = new Map<string, Function>()
tickExtension({ on: (ev: string, h: Function) => handlers.set(ev, h), registerTool: () => {} } as never)
function runExtension(control: string, ack: string, sessionId = sid): { text: string; ack?: { ok: boolean; reason?: string } } {
  process.env.TICK_LAUNCH_FILE = control
  process.env.TICK_LAUNCH_ACK = ack
  let text = ''
  handlers.get('session_start')!({ type: 'session_start' }, {
    ui: { setEditorText: (t: string) => { text = t } },
    sessionManager: { getSessionId: () => sessionId },
  })
  return { text, ack: existsSync(ack) ? JSON.parse(readFileSync(ack, 'utf8')) : undefined }
}
await check('extension writes ok ack and deletes control file', () => {
  const c = path.join(dir, 'ext-ok.prefill.json')
  const a = `${c}.ack`
  writeFileSync(c, JSON.stringify({ version: 1, mode: 'prefill', sessionId: sid, promptText: 'x' }), { mode: 0o600 })
  const out = runExtension(c, a)
  assert.equal(out.text, 'x')
  assert.equal(out.ack?.ok, true)
  assert.equal(existsSync(c), false)
})
await check('extension rejects session mismatch', () => {
  const c = path.join(dir, 'ext-mismatch.prefill.json')
  const a = `${c}.ack`
  writeFileSync(c, JSON.stringify({ version: 1, mode: 'prefill', sessionId: 'other', promptText: 'x' }), { mode: 0o600 })
  const out = runExtension(c, a)
  assert.equal(out.text, '')
  assert.equal(out.ack?.reason, 'session-mismatch')
})

// ---- cache cleanup ----
await check('cleanup removes stale prefill/command, keeps new command', () => {
  const cache = path.join(dir, 'cache')
  mkdirSync(cache)
  for (const n of ['old.command', 'old.prefill.json', 'old.prefill.json.ack', 'new.command']) {
    writeFileSync(path.join(cache, n), 'x')
  }
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
  for (const n of ['old.command', 'old.prefill.json', 'old.prefill.json.ack']) {
    utimesSync(path.join(cache, n), old, old)
  }
  cleanupLaunchCache(cache)
  assert.equal(existsSync(path.join(cache, 'old.command')), false)
  assert.equal(existsSync(path.join(cache, 'old.prefill.json')), false)
  assert.equal(existsSync(path.join(cache, 'old.prefill.json.ack')), false)
  assert.equal(existsSync(path.join(cache, 'new.command')), true)
})

// ---- terminal env ----
await check('terminal script exports env with POSIX quoting; rejects bad key', () => {
  const script = renderTerminalScript({ cwd: dir, executable: '/bin/echo', args: ['x'], env: { TICK_LAUNCH_FILE: `${dir}/a b'c.json` } })
  assert.ok(script.includes(`export TICK_LAUNCH_FILE='${dir}/a b'\\''c.json'`))
  assert.throws(() => renderTerminalScript({ cwd: dir, executable: 'x', args: [], env: { 'BAD KEY': 'x' } }))
})

// ---- TodoStore tool-aware binding ----
await check('binding lookup/removal is tool-aware', () => {
  const store = new TodoStore(path.join(dir, 'todos.json'))
  store.ensureFile()
  const a = store.create({ title: 'a' })
  const b = store.create({ title: 'b' })
  const x = 'same-id'
  store.update(a.id, { addBinding: { toolId: 'pi', sessionId: x as never, boundAt: 'now', state: 'verified' } })
  store.update(b.id, { addBinding: { toolId: 'workbuddy', sessionId: x as never, boundAt: 'now', state: 'pending' } })
  assert.equal(store.findTodoBySession(x, 'pi')?.id, a.id)
  assert.equal(store.findTodoBySession(x, 'workbuddy')?.id, b.id)
  assert.equal(store.removeBinding(a.id, x, 'pi'), true)
  assert.equal(store.findTodoBySession(x, 'workbuddy')?.id, b.id)
})

// ---- LaunchService gates ----
await check('LaunchService blocks usable=false and keeps notice', async () => {
  const store = new TodoStore(path.join(dir, 'launch-todos.json'))
  store.ensureFile()
  const todo = store.create({ title: 't' })
  const caps = { needsCwd: true, resumeSession: true, deliverPrompt: ['prefill', 'argv', 'clipboard'], setSessionName: true, discoverProjects: false, describeSessions: false, usage: false, newSessionMode: 'launch' as const }
  let launched = false
  const oldAdapter = {
    id: 'pi', capabilities: caps,
    detect: async () => ({ installed: true, usable: false, reason: 'too old' }),
    launch: async () => { launched = true; throw new Error('must not') },
    resume: async () => { throw new Error('no') },
  }
  const svc = new LaunchService([oldAdapter as never], store, { settings: () => DEFAULT_SETTINGS })
  const r = await svc.launch({ todoId: todo.id, deliver: 'prefill' })
  assert.equal(r.ok, false)
  assert.ok(r.reason?.includes('too old'))
  assert.equal(launched, false)

  const goodAdapter = {
    id: 'pi', capabilities: caps,
    detect: async () => ({ installed: true, usable: true }),
    launch: async () => ({ toolId: 'pi', sessionId: newCliSessionId(sid), cwd: dir, delivered: 'clipboard' as const, verified: false, notice: 'fallback' }),
    resume: async () => { throw new Error('no') },
  }
  const svc2 = new LaunchService([goodAdapter as never], store, { settings: () => DEFAULT_SETTINGS })
  const r2 = await svc2.launch({ todoId: todo.id, deliver: 'prefill' })
  assert.equal(r2.ok, true)
  assert.equal(r2.notice, 'fallback')
  const r3 = await svc2.resume({ sessionId: '99999999-2222-4333-8444-555555555555' })
  assert.equal(r3.ok, false)
  assert.ok(r3.reason?.includes('无法确定'))
})

rmSync(dir, { recursive: true, force: true })
console.log(`\nRESULT passed=${passed}${process.exitCode ? ' failed=1' : ' failed=0'}`)
