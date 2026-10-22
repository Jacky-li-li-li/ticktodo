/**
 * 应用内更新的纯逻辑 / 编排 selftest（无测试框架；由 scripts/selftest-update.mjs 打包执行）。
 *
 * 覆盖：
 *  1. update-state 全链路与阶段守卫（含迟到/非法事件、percent 钳制与去重、ready→handoff 失败、install-failed 保留 ready）；
 *  2. 错误分类与文案白名单（原始 message / URL / 绝对路径绝不进入状态）；
 *  3. SettingsStore 对旧 settings.json 的兼容（autoUpdateCheck 默认开）；
 *  4. UpdateService 编排（fake UpdaterLike + 注入 probe/hasUpdateConfig/prepareQuit/now）：
 *     检查/下载/交接失败、check 与下载停滞超时、自动检查的启动延迟与 stop 清理。
 *
 * 不依赖 Electron、electron-updater、codesign 或任何真实 feed；不碰真实数据。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UpdateState } from '../packages/shared/src/index.ts'
import { DEFAULT_SETTINGS } from '../packages/shared/src/index.ts'
import { SettingsStore } from '../apps/desktop/src/main/services/settings-store.ts'
import {
  INITIAL_UPDATE_STATE,
  INSTALL_FAILED_MESSAGE,
  classifyUpdateError,
  isRetryable,
  reduceUpdateState,
  unsupportedMessage,
  updateErrorMessage,
} from '../apps/desktop/src/main/services/update-state.ts'
import { UpdateService } from '../apps/desktop/src/main/services/update.ts'
import type { UpdaterLike, UpdateServiceDeps } from '../apps/desktop/src/main/services/update.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'tick-selftest-update-'))
let passed = 0
let failed = 0

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log('PASS', name)
    })
    .catch((e) => {
      failed++
      console.error('FAIL', name, e)
      process.exitCode = 1
    })
}

const NOW = '2026-10-22T00:00:00.000Z'
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 从 idle 推进到 downloading；percent > 0 时补一次进度事件 */
function downloadingState(percent = 0, version = '0.2.2'): UpdateState {
  let s = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'check-started', trigger: 'manual' }, NOW)
  s = reduceUpdateState(s, { type: 'check-available', version }, NOW)
  s = reduceUpdateState(s, { type: 'download-started', version }, NOW)
  if (percent > 0) s = reduceUpdateState(s, { type: 'download-progress', percent }, NOW)
  return s
}

function readyState(): UpdateState {
  let s = downloadingState(80)
  s = reduceUpdateState(s, { type: 'download-done', version: '0.2.2' }, NOW)
  return s
}

// ---------------- 1. reducer 全链路与守卫 ----------------

await check('selectors: 初始态只有 phase/currentVersion', () => {
  assert.deepEqual(INITIAL_UPDATE_STATE('0.2.1'), { phase: 'idle', currentVersion: '0.2.1' })
})

await check('reducer: idle→checking→available→downloading→ready', () => {
  let s: UpdateState = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'check-started', trigger: 'auto' }, NOW)
  assert.equal(s.phase, 'checking')
  assert.equal(s.phase === 'checking' ? s.trigger : '', 'auto')

  s = reduceUpdateState(s, { type: 'check-available', version: '0.2.2' }, NOW)
  assert.equal(s.phase, 'available')
  assert.equal(s.phase === 'available' ? s.checkedAt : '', NOW)

  s = reduceUpdateState(s, { type: 'download-started', version: '0.2.2' }, NOW)
  assert.equal(s.phase, 'downloading')
  assert.equal(s.phase === 'downloading' ? s.percent : -1, 0)

  s = reduceUpdateState(s, { type: 'download-done', version: '0.2.2' }, NOW)
  assert.equal(s.phase, 'ready')
  assert.equal(s.phase === 'ready' ? s.version : '', '0.2.2')
  assert.equal(s.phase === 'ready' ? s.checkedAt : '', NOW)
})

await check('reducer: checking→up-to-date，checkedAt 用注入时间', () => {
  let s = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'check-started', trigger: 'manual' }, NOW)
  s = reduceUpdateState(s, { type: 'check-none' }, NOW)
  assert.deepEqual(s, { phase: 'up-to-date', currentVersion: '0.2.1', checkedAt: NOW })
})

await check('reducer: checking→error(offline)，retryable=true', () => {
  let s = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'check-started', trigger: 'manual' }, NOW)
  s = reduceUpdateState(s, { type: 'check-failed', code: 'offline' }, NOW)
  assert.equal(s.phase, 'error')
  assert.equal(s.phase === 'error' ? s.scope : '', 'check')
  assert.equal(s.phase === 'error' ? s.code : '', 'offline')
  assert.equal(s.phase === 'error' ? s.retryable : false, true)
  assert.equal(s.phase === 'error' ? s.checkedAt : '', NOW)
  assert.equal(s.phase === 'error' ? s.message : '', updateErrorMessage('offline'))
})

await check('reducer: downloading→error(http,404)，保留 version 与 httpStatus', () => {
  let s = downloadingState(40)
  s = reduceUpdateState(s, { type: 'download-failed', code: 'http', httpStatus: 404 }, NOW)
  assert.equal(s.phase, 'error')
  assert.equal(s.phase === 'error' ? s.scope : '', 'download')
  assert.equal(s.phase === 'error' ? s.version : '', '0.2.2')
  assert.equal(s.phase === 'error' ? s.httpStatus : 0, 404)
  assert.ok(s.phase === 'error' && s.message.includes('HTTP 404'))
  assert.equal(s.phase === 'error' ? s.retryable : false, true)
})

await check('reducer: 下载错误→download-started 可原地重试', () => {
  let s = downloadingState(10)
  s = reduceUpdateState(s, { type: 'download-failed', code: 'timeout' }, NOW)
  assert.equal(s.phase, 'error')
  s = reduceUpdateState(s, { type: 'download-started', version: '0.2.2' }, NOW)
  assert.equal(s.phase, 'downloading')
  assert.equal(s.phase === 'downloading' ? s.version : '', '0.2.2')
})

await check('reducer: ready + handoff-failed → error(scope=download, code=handoff, 保留 version)', () => {
  const ready = readyState()
  const s = reduceUpdateState(ready, { type: 'handoff-failed' }, NOW)
  assert.equal(s.phase, 'error')
  assert.equal(s.phase === 'error' ? s.scope : '', 'download')
  assert.equal(s.phase === 'error' ? s.code : '', 'handoff')
  assert.equal(s.phase === 'error' ? s.version : '', '0.2.2')
  assert.equal(s.phase === 'error' ? s.retryable : false, true)
  assert.equal(s.phase === 'error' ? s.checkedAt : '', NOW)
  assert.equal(s.phase === 'error' ? s.message : '', updateErrorMessage('handoff'))
  assert.ok((s.phase === 'error' ? s.message.length : 0) > 0)
  // handoff 可重试，但恢复通道是「重试下载」；isRetryable 与状态里的 retryable 保持同口径
  assert.equal(isRetryable('handoff'), true)
})

await check('reducer: 非 ready 阶段的 handoff-failed 返回原对象（双报只收口一次）', () => {
  const idle = INITIAL_UPDATE_STATE('0.2.1')
  assert.equal(reduceUpdateState(idle, { type: 'handoff-failed' }, NOW), idle)

  const checking = reduceUpdateState(idle, { type: 'check-started', trigger: 'manual' }, NOW)
  assert.equal(reduceUpdateState(checking, { type: 'handoff-failed' }, NOW), checking)

  const available = reduceUpdateState(checking, { type: 'check-available', version: '0.2.2' }, NOW)
  assert.equal(reduceUpdateState(available, { type: 'handoff-failed' }, NOW), available)

  const downloading = downloadingState(50)
  assert.equal(reduceUpdateState(downloading, { type: 'handoff-failed' }, NOW), downloading)

  // 第一次收口后再来一次同事件：error 不是 handoff 的起点，必须保持同一个 error 对象
  const errored = reduceUpdateState(readyState(), { type: 'handoff-failed' }, NOW)
  assert.equal(reduceUpdateState(errored, { type: 'handoff-failed' }, NOW), errored)

  const upToDate = reduceUpdateState(
    reduceUpdateState(INITIAL_UPDATE_STATE('0.2.1'), { type: 'check-started', trigger: 'auto' }, NOW),
    { type: 'check-none' },
    NOW,
  )
  assert.equal(reduceUpdateState(upToDate, { type: 'handoff-failed' }, NOW), upToDate)
})

await check('reducer: install-failed 保留 ready 且 installError 有值', () => {
  const ready = readyState()
  const failedInstall = reduceUpdateState(ready, { type: 'install-failed' }, NOW)
  assert.equal(failedInstall.phase, 'ready')
  assert.equal(
    failedInstall.phase === 'ready' ? failedInstall.installError : undefined,
    INSTALL_FAILED_MESSAGE,
  )
  assert.equal(failedInstall.phase === 'ready' ? failedInstall.version : '', '0.2.2')
  // 重试前清掉旧错误；清完仍是 ready
  const retry = reduceUpdateState(failedInstall, { type: 'install-started' }, NOW)
  assert.equal(retry.phase, 'ready')
  assert.equal(retry.phase === 'ready' ? retry.installError : 'x', undefined)
})

await check('reducer: 迟到/非法事件返回原对象', () => {
  const ready = readyState()
  assert.equal(reduceUpdateState(ready, { type: 'check-started', trigger: 'auto' }, NOW), ready)
  assert.equal(reduceUpdateState(ready, { type: 'check-available', version: '9.9.9' }, NOW), ready)
  assert.equal(reduceUpdateState(ready, { type: 'download-progress', percent: 100 }, NOW), ready)
  assert.equal(reduceUpdateState(ready, { type: 'download-done', version: '9.9.9' }, NOW), ready)
  assert.equal(reduceUpdateState(ready, { type: 'install-failed' }, NOW).phase, 'ready')

  const available = reduceUpdateState(
    reduceUpdateState(INITIAL_UPDATE_STATE('0.2.1'), { type: 'check-started', trigger: 'manual' }, NOW),
    { type: 'check-available', version: '0.2.2' },
    NOW,
  )
  assert.equal(reduceUpdateState(available, { type: 'check-started', trigger: 'manual' }, NOW), available)
  assert.equal(reduceUpdateState(available, { type: 'download-progress', percent: 10 }, NOW), available)

  const downloading = downloadingState(50)
  assert.equal(reduceUpdateState(downloading, { type: 'check-available', version: '9.9.9' }, NOW), downloading)
  assert.equal(reduceUpdateState(downloading, { type: 'download-started', version: '9.9.9' }, NOW), downloading)

  const upToDate = reduceUpdateState(
    reduceUpdateState(INITIAL_UPDATE_STATE('0.2.1'), { type: 'check-started', trigger: 'auto' }, NOW),
    { type: 'check-none' },
    NOW,
  )
  assert.equal(reduceUpdateState(upToDate, { type: 'check-available', version: '9.9.9' }, NOW), upToDate)
})

await check('reducer: percent 钳到 0..100、取整、整数不变返回原对象', () => {
  const s = downloadingState(50)
  assert.equal(reduceUpdateState(s, { type: 'download-progress', percent: 50.4 }, NOW), s)
  const zero = reduceUpdateState(s, { type: 'download-progress', percent: -5 }, NOW)
  assert.equal(zero.phase === 'downloading' ? zero.percent : -1, 0)
  const hundred = reduceUpdateState(s, { type: 'download-progress', percent: 150 }, NOW)
  assert.equal(hundred.phase === 'downloading' ? hundred.percent : -1, 100)
  const nan = reduceUpdateState(hundred, { type: 'download-progress', percent: Number.NaN }, NOW)
  assert.equal(nan.phase === 'downloading' ? nan.percent : -1, 0)
  const bps = reduceUpdateState(s, { type: 'download-progress', percent: 51, bytesPerSecond: 1234.6 }, NOW)
  assert.equal(bps.phase === 'downloading' ? bps.bytesPerSecond : 0, 1235)
})

await check('reducer: unsupported 不被 check/download/install 改写，也不覆盖 downloading/ready', () => {
  let s = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'unsupported', reason: 'unsigned' }, NOW)
  assert.equal(s.phase, 'unsupported')
  assert.equal(reduceUpdateState(s, { type: 'check-started', trigger: 'manual' }, NOW), s)
  assert.equal(reduceUpdateState(s, { type: 'download-started', version: '0.2.2' }, NOW), s)
  assert.equal(reduceUpdateState(s, { type: 'install-failed' }, NOW), s)

  const downloading = downloadingState(30)
  assert.equal(reduceUpdateState(downloading, { type: 'unsupported', reason: 'dev' }, NOW), downloading)
  const ready = readyState()
  assert.equal(reduceUpdateState(ready, { type: 'unsupported', reason: 'no-feed' }, NOW), ready)
})

// ---------------- 2. 错误分类与文案白名单 ----------------

await check('classify: 网络 / HTTP / feed / signature / timeout / unknown', () => {
  const cases: Array<[unknown, string, number?]> = [
    [new Error('getaddrinfo ENOTFOUND api.github.com'), 'offline'],
    [new Error('connect ECONNREFUSED 127.0.0.1:443'), 'offline'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'offline'],
    [new Error('net::ERR_NETWORK_CHANGED'), 'offline'],
    [Object.assign(new Error('boom'), { statusCode: 404 }), 'http', 404],
    [Object.assign(new Error('boom'), { statusCode: 503 }), 'http', 503],
    [new Error('Cannot find latest-mac.yml in the app-update.yml directory'), 'feed'],
    [new Error('sha512 checksum mismatch'), 'signature'],
    [new Error('code signature invalid'), 'signature'],
    [Object.assign(new Error('slow'), { name: 'UpdateTimeoutError' }), 'timeout'],
    [new Error('something unexpected'), 'unknown'],
  ]
  for (const [err, code, httpStatus] of cases) {
    const got = classifyUpdateError(err)
    assert.equal(got.code, code, `期望 ${code}，实际 ${got.code}`)
    if (httpStatus !== undefined) assert.equal(got.httpStatus, httpStatus)
  }
})

await check('文案：只来自白名单，不含原始 message / URL / 绝对路径 / file://', () => {
  const dirty = new Error(
    'GET https://evil.example/secret?token=1 failed; file:///Users/jacky/Library/Application Support/Tick/x',
  )
  const codes = ['offline', 'http', 'feed', 'signature', 'timeout', 'install', 'handoff', 'unknown'] as const
  for (const code of codes) {
    const text = updateErrorMessage(code)
    assert.ok(text.length > 0)
    for (const fragment of ['evil.example', '/Users/', 'file://', 'token=1', 'GET https']) {
      assert.equal(text.includes(fragment), false, `${code} 文案泄露了 ${fragment}`)
    }
  }
  const classified = classifyUpdateError(dirty)
  let s = INITIAL_UPDATE_STATE('0.2.1')
  s = reduceUpdateState(s, { type: 'check-started', trigger: 'manual' }, NOW)
  s = reduceUpdateState(s, { type: 'check-failed', ...classified }, NOW)
  assert.equal(s.phase, 'error')
  const message = s.phase === 'error' ? s.message : ''
  assert.equal(message, updateErrorMessage(classified.code))
  for (const fragment of ['evil.example', '/Users/', 'file://', 'token=1']) {
    assert.equal(message.includes(fragment), false)
  }
})

await check('unsupported 五个 reason 的文案固定；dev/unsigned 不出现「错误」', () => {
  const reasons = ['dev', 'unsigned', 'no-feed', 'translocated', 'probe-failed'] as const
  for (const reason of reasons) {
    const s = reduceUpdateState(INITIAL_UPDATE_STATE('0.2.1'), { type: 'unsupported', reason }, NOW)
    assert.equal(s.phase, 'unsupported')
    assert.equal(s.phase === 'unsupported' ? s.message : '', unsupportedMessage(reason))
    assert.ok((s.phase === 'unsupported' ? s.message.length : 0) > 0)
  }
  assert.equal(unsupportedMessage('dev').includes('错误'), false)
  assert.equal(unsupportedMessage('unsigned').includes('错误'), false)
})

// ---------------- 3. SettingsStore 兼容 ----------------

await check('settings: 旧文件默认 autoUpdateCheck=true，改 false 后重载仍是 false', () => {
  assert.equal(DEFAULT_SETTINGS.autoUpdateCheck, true)
  const file = path.join(dir, 'settings.json')
  // 旧版本 Tick 写出来的文件：只有 deliver，没有 autoUpdateCheck
  writeFileSync(file, JSON.stringify({ version: 1, settings: { deliver: 'argv' } }))
  const oldStore = new SettingsStore(file)
  assert.equal(oldStore.get().autoUpdateCheck, true)
  assert.equal(oldStore.get().deliver, 'argv')

  const next = oldStore.update({ autoUpdateCheck: false })
  assert.equal(next.autoUpdateCheck, false)
  const reloaded = new SettingsStore(file)
  assert.equal(reloaded.get().autoUpdateCheck, false)
})

// ---------------- 4. UpdateService 编排（fake UpdaterLike） ----------------

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = false
  allowPrerelease = true
  allowDowngrade = true
  logger = {
    info: (_message: unknown): void => {},
    warn: (_message: unknown): void => {},
    error: (_message: unknown): void => {},
    debug: (_message: unknown): void => {},
  }
  onCount = 0
  checkCount = 0
  downloadCount = 0
  quitCount = 0
  checkImpl: () => Promise<unknown> = async () => undefined
  downloadImpl: () => Promise<unknown> = async () => undefined
  quitImpl: () => void = () => {}
  private listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): unknown {
    this.onCount++
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  checkForUpdates(): Promise<unknown> {
    this.checkCount++
    return this.checkImpl()
  }

  downloadUpdate(): Promise<unknown> {
    this.downloadCount++
    return this.downloadImpl()
  }

  quitAndInstall(): void {
    this.quitCount++
    this.quitImpl()
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }
}

interface Harness {
  service: UpdateService
  fake: FakeUpdater
  states: UpdateState[]
  prepareCalls: number
  cancelCalls: number
}

function makeHarness(overrides: Partial<UpdateServiceDeps> = {}): Harness {
  const fake = new FakeUpdater()
  const states: UpdateState[] = []
  const counters = { prepare: 0, cancel: 0 }
  const deps: UpdateServiceDeps = {
    currentVersion: '0.2.1',
    isPackaged: true,
    execPath: '/Applications/Tick.app/Contents/MacOS/Tick',
    updater: fake,
    probeSignature: async () => 'signed',
    hasUpdateConfig: () => true,
    autoCheckEnabled: () => true,
    onState: (state) => states.push(state),
    prepareQuit: async () => {
      counters.prepare++
      return () => {
        counters.cancel++
      }
    },
    now: () => NOW,
    log: () => {},
    installStartTimeoutMs: 20,
    ...overrides,
  }
  const service = new UpdateService(deps)
  return {
    service,
    fake,
    states,
    get prepareCalls() {
      return counters.prepare
    },
    get cancelCalls() {
      return counters.cancel
    },
  }
}

await check('service: dev 不碰 updater，ready/check 都是 unsupported/dev', async () => {
  const h = makeHarness({ isPackaged: false })
  const state = await h.service.ready()
  assert.equal(state.phase, 'unsupported')
  assert.equal(state.phase === 'unsupported' ? state.reason : '', 'dev')
  const checked = await h.service.check('manual')
  assert.equal(checked.phase, 'unsupported')
  assert.equal(h.fake.onCount, 0)
  assert.equal(h.fake.checkCount, 0)
  assert.equal(h.fake.downloadCount, 0)
})

await check('service: 未打包 / 签名 / feed 的能力判定顺序', async () => {
  await (async () => {
    const h = makeHarness({ probeSignature: async () => 'unsigned' })
    const s = await h.service.ready()
    assert.equal(s.phase === 'unsupported' ? s.reason : '', 'unsigned')
  })()

  await (async () => {
    const h = makeHarness({ probeSignature: async () => 'probe-failed' })
    const s = await h.service.ready()
    assert.equal(s.phase === 'unsupported' ? s.reason : '', 'probe-failed')
  })()

  await (async () => {
    let probed = 0
    const h = makeHarness({
      execPath: '/private/var/folders/x/AppTranslocation/ABC/d/Tick.app/Contents/MacOS/Tick',
      probeSignature: async () => {
        probed++
        return 'signed'
      },
    })
    const s = await h.service.ready()
    assert.equal(s.phase === 'unsupported' ? s.reason : '', 'translocated')
    assert.equal(probed, 0, 'translocated 应排在签名探测之前')
  })()

  await (async () => {
    const h = makeHarness({ hasUpdateConfig: () => false })
    const s = await h.service.ready()
    assert.equal(s.phase === 'unsupported' ? s.reason : '', 'no-feed')
  })()

  await (async () => {
    const h = makeHarness()
    const s = await h.service.ready()
    assert.equal(s.phase, 'idle')
  })()
})

await check('service: 支持更新时配置一次，update-available→available', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  const state = await h.service.check('manual')
  assert.equal(state.phase, 'available')
  assert.equal(state.phase === 'available' ? state.version : '', '0.2.2')
  assert.equal(h.fake.checkCount, 1)
  assert.equal(h.fake.autoDownload, false)
  assert.equal(h.fake.autoInstallOnAppQuit, true)
  assert.equal(h.fake.allowPrerelease, false)
  assert.equal(h.fake.allowDowngrade, false)

  // 第二次检查会注册第二次配置？configured 只允许一次，onCount 不应增长
  const onCount = h.fake.onCount
  await h.service.check('manual')
  assert.equal(h.fake.onCount, onCount)
})

await check('service: 两次并发 check 只调一次 checkForUpdates', async () => {
  const h = makeHarness()
  const gate = deferred<unknown>()
  h.fake.checkImpl = () => gate.promise
  const p1 = h.service.check('manual')
  const p2 = h.service.check('manual')
  await tick()
  assert.equal(h.fake.checkCount, 1, '第二次 check 应被单飞挡住')
  h.fake.emit('update-available', { version: '0.2.2' })
  gate.resolve(null)
  const [s1, s2] = await Promise.all([p1, p2])
  // 第二次调用在 checking 阶段直接返回当前快照（不发起第二个请求），所以它可能是 checking
  assert.equal(s1.phase, 'available')
  assert.ok(s2.phase === 'checking' || s2.phase === 'available')
  assert.equal(h.fake.checkCount, 1)
})

await check('service: downloadUpdate→downloading（进度）→ready', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')

  const gate = deferred<unknown>()
  h.fake.downloadImpl = () => gate.promise
  const p = h.service.download()
  assert.equal(h.service.getState().phase, 'downloading')
  h.fake.emit('download-progress', { percent: 42.6, bytesPerSecond: 2048 })
  let mid = h.service.getState()
  assert.equal(mid.phase === 'downloading' ? mid.percent : -1, 43)
  assert.equal(mid.phase === 'downloading' ? mid.bytesPerSecond : 0, 2048)

  h.fake.emit('update-downloaded', { version: '0.2.2' })
  gate.resolve(null)
  const done = await p
  assert.equal(done.phase, 'ready')
  assert.equal(done.phase === 'ready' ? done.version : '', '0.2.2')
})

await check('service: error 事件 + promise reject 只收口一次 error', async () => {
  const h = makeHarness()
  const gate = deferred<unknown>()
  h.fake.checkImpl = () => gate.promise
  const p = h.service.check('manual')
  await tick()
  const orig = Object.assign(new Error('ENOTFOUND update.example'), {})
  h.fake.emit('error', orig)
  gate.reject(new Error('ENOTFOUND update.example'))
  const state = await p
  assert.equal(state.phase, 'error')
  assert.equal(state.phase === 'error' ? state.scope : '', 'check')
  assert.equal(state.phase === 'error' ? state.code : '', 'offline')
  const errorBroadcasts = h.states.filter((s) => s.phase === 'error')
  assert.equal(errorBroadcasts.length, 1, '一次失败只能广播一次 error')
})

await check('service: 下载失败后 download() 可再次调用并成功', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')

  h.fake.downloadImpl = async () => {
    throw Object.assign(new Error('HTTP request failed'), { statusCode: 404 })
  }
  const failed = await h.service.download()
  assert.equal(failed.phase, 'error')
  assert.equal(failed.phase === 'error' ? failed.scope : '', 'download')
  assert.equal(failed.phase === 'error' ? failed.version : '', '0.2.2')
  assert.equal(failed.phase === 'error' ? failed.httpStatus : 0, 404)

  h.fake.downloadImpl = async () => {
    h.fake.emit('update-downloaded', { version: '0.2.2' })
  }
  const retried = await h.service.download()
  assert.equal(retried.phase, 'ready')
  assert.equal(h.fake.downloadCount, 2)
})

await check('service: 交接失败（error 事件 + promise reject 双报）只收口一次 handoff', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')

  const gate = deferred<unknown>()
  h.fake.downloadImpl = () => gate.promise
  const p = h.service.download()
  assert.equal(h.service.getState().phase, 'downloading')

  // MacUpdater 先 dispatch update-downloaded（此刻状态已 ready、downloading 已清），
  // 之后才把 zip 交给 Squirrel.Mac；Squirrel 失败时库发 error 且 downloadUpdate() reject。
  h.fake.emit('update-downloaded', { version: '0.2.2' })
  assert.equal(h.service.getState().phase, 'ready')

  const raw = new Error('Squirrel.Mac: code signature invalid on downloaded zip')
  h.fake.emit('error', raw)
  gate.reject(raw)

  const state = await p
  assert.equal(state.phase, 'error')
  assert.equal(state.phase === 'error' ? state.scope : '', 'download')
  assert.equal(state.phase === 'error' ? state.code : '', 'handoff')
  assert.equal(state.phase === 'error' ? state.version : '', '0.2.2')
  assert.equal(state.phase === 'error' ? state.message : '', updateErrorMessage('handoff'))
  const handoffBroadcasts = h.states.filter((s) => s.phase === 'error')
  assert.equal(handoffBroadcasts.length, 1, 'error 事件与 promise reject 只能广播一次 error')

  // 重试下载：已下载版本还在，fake 改成功后能重新回到 ready，不需要重新检查
  h.fake.downloadImpl = async () => {
    h.fake.emit('update-downloaded', { version: '0.2.2' })
  }
  const retried = await h.service.download()
  assert.equal(retried.phase, 'ready')
  assert.equal(retried.phase === 'ready' ? retried.version : '', '0.2.2')
  assert.equal(h.fake.downloadCount, 2)
})

await check('service: 只有 downloadUpdate() reject（error 事件缺失/迟到）也收口成 handoff', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')

  const gate = deferred<unknown>()
  h.fake.downloadImpl = () => gate.promise
  const p = h.service.download()
  h.fake.emit('update-downloaded', { version: '0.2.2' })
  gate.reject(new Error('handoff to Squirrel failed'))

  const state = await p
  assert.equal(state.phase, 'error')
  assert.equal(state.phase === 'error' ? state.code : '', 'handoff')
  assert.equal(state.phase === 'error' ? state.version : '', '0.2.2')

  // 迟到的 error 事件：状态已不是 ready，不许造第二个 error
  const before = h.states.length
  h.fake.emit('error', new Error('late error event'))
  assert.equal(h.states.length, before)
  assert.equal(h.states.filter((s) => s.phase === 'error').length, 1)
})

await check('service: check 超时（checkTimeoutMs）→ error(scope=check, code=timeout)', async () => {
  const h = makeHarness({ checkTimeoutMs: 20 })
  // 永不 resolve、也不发事件：只能靠 check 自己的超时收口
  h.fake.checkImpl = () => new Promise<unknown>(() => {})
  // withTimeout 的 timer 是 unref 的（生产里不能拖住 Electron 退出）；测试进程没有别的句柄，
  // 需要一个 ref 的 timer 把事件循环撑到超时触发，否则 node 会以「unsettled top-level await」退出
  const keepAlive = setTimeout(() => {}, 200)
  try {
    const state = await h.service.check('manual')
    assert.equal(h.fake.checkCount, 1)
    assert.equal(state.phase, 'error')
    assert.equal(state.phase === 'error' ? state.scope : '', 'check')
    assert.equal(state.phase === 'error' ? state.code : '', 'timeout')
    assert.equal(state.phase === 'error' ? state.retryable : false, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

await check('service: 下载停滞（downloadStallMs）→ error(scope=download, code=timeout)', async () => {
  const h = makeHarness({ downloadStallMs: 20 })
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')

  // 永不 resolve、也不发进度：不能 await download()，否则测试会跟着挂住
  h.fake.downloadImpl = () => new Promise<unknown>(() => {})
  void h.service.download()
  assert.equal(h.service.getState().phase, 'downloading')
  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = h.service.getState()
  assert.equal(state.phase, 'error')
  assert.equal(state.phase === 'error' ? state.scope : '', 'download')
  assert.equal(state.phase === 'error' ? state.code : '', 'timeout')
  assert.equal(state.phase === 'error' ? state.retryable : false, true)
  assert.equal(state.phase === 'error' ? state.version : '', '0.2.2')
})

await check('service: autoCheckEnabled=false 时 start() 不排自动检查', async () => {
  const h = makeHarness({ autoCheckEnabled: () => false, startupDelayMs: 10 })
  h.fake.checkImpl = async () => {}
  h.service.start()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(h.fake.checkCount, 0)
  h.service.stop()
})

await check('service: startupDelayMs 内自动检查一次；stop() 清掉未触发的 timer', async () => {
  const on = makeHarness({ autoCheckEnabled: () => true, startupDelayMs: 10 })
  on.fake.checkImpl = async () => {}
  on.service.start()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(on.fake.checkCount, 1, 'startupDelayMs 后应恰好自动检查一次')
  on.service.stop()

  // stop 在 startup timer 触发之前调用：之后一次都不能再检查
  const off = makeHarness({ autoCheckEnabled: () => true, startupDelayMs: 60 })
  off.fake.checkImpl = async () => {}
  off.service.start()
  // 先让 start() 里 ready() 的微任务把 timer 排上，再 stop
  await new Promise((resolve) => setTimeout(resolve, 10))
  off.service.stop()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(off.fake.checkCount, 0)
})

await check('service: install 抛错时调用 cancel，状态仍是 ready + installError', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')
  h.fake.downloadImpl = async () => {
    h.fake.emit('update-downloaded', { version: '0.2.2' })
  }
  await h.service.download()
  assert.equal(h.service.getState().phase, 'ready')

  h.fake.quitImpl = () => {
    throw new Error('quitAndInstall failed')
  }
  await h.service.install()
  assert.equal(h.prepareCalls, 1)
  assert.equal(h.fake.quitCount, 1)
  assert.equal(h.cancelCalls, 1)
  const state = h.service.getState()
  assert.equal(state.phase, 'ready')
  assert.equal(state.phase === 'ready' ? state.installError : '', INSTALL_FAILED_MESSAGE)
})

await check('service: quitAndInstall 成功调用但进程没退，超时后 cancel 并允许重试', async () => {
  const h = makeHarness()
  h.fake.checkImpl = async () => {
    h.fake.emit('update-available', { version: '0.2.2' })
  }
  await h.service.check('manual')
  h.fake.downloadImpl = async () => {
    h.fake.emit('update-downloaded', { version: '0.2.2' })
  }
  await h.service.download()

  // 不抛错也不退出：模拟安装被系统静默忽略
  h.fake.quitImpl = () => {}
  await h.service.install()
  assert.equal(h.fake.quitCount, 1)
  assert.equal(h.cancelCalls, 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(h.cancelCalls, 1)
  const state = h.service.getState()
  assert.equal(state.phase, 'ready')
  assert.equal(state.phase === 'ready' ? state.installError : '', INSTALL_FAILED_MESSAGE)
  h.service.stop()
})

process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
rmSync(dir, { recursive: true, force: true })

console.log(`\nRESULT passed=${passed} failed=${failed}`)
if (failed > 0) process.exitCode = 1
