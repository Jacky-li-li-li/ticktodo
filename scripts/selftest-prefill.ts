/**
 * 预填/多工具关键边界断言（无测试框架；由 scripts/selftest-prefill.mjs 打包执行）。
 * 覆盖：pi 只按 installed 判断（无版本门控）、GUI 环境下的可执行文件定位、
 *       prefill ack/超时/超限降级、扩展 ack、启动清理、terminal env 转义、
 *       TodoStore 按 (toolId, sessionId) 精确绑定、LaunchService 的 installed/降级/resume fail-closed。
 * 第二轮修复回归：子代理用量/cost 口径、detect 门控、withName 快路径、注入过滤（AGENTS.md）、
 *                    notice 透传、导出 files、缓存/扫描上限、各工具 NaN 时间与归档 resumable。
 * 不依赖本机安装 pi/WorkBuddy，也不碰真实数据。
 */
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PiAdapter,
  commonBinDirs,
  findCliExecutable,
  isExecutableFile,
} from '../packages/ai/pi/src/index.ts'
import { ClaudeAdapter, readSessionMeta } from '../packages/ai/claude/src/index.ts'
import { canonicalPath, isExistingDirectory, isInjectedUserText, realUserText, toSessionTitle } from '../packages/ai/core/src/index.ts'
import { QoderAdapter, QODER_CN_DISTRO, QODER_DISTRO, resolveQoderSessionRoots } from '../packages/ai/qoder/src/index.ts'
import { CodexAdapter, collectRollouts } from '../packages/ai/codex/src/index.ts'
import { ClineAdapter } from '../packages/ai/cline/src/index.ts'
import { GrokAdapter } from '../packages/ai/grok/src/index.ts'
import { OmpAdapter } from '../packages/ai/omp/src/index.ts'
import { KimiAdapter } from '../packages/ai/kimi/src/index.ts'
import { OpenCodeAdapter } from '../packages/ai/opencode/src/index.ts'
import { ZCodeAdapter } from '../packages/ai/zcode/src/index.ts'
import {
  collectDshSessions,
  DshAdapter,
  readFrameLines,
  readHeader,
  readPlainLines,
  splitFrames,
} from '../packages/ai/dsh/src/index.ts'
import { buildNewSessionUrl, desktopLooksSignedIn } from '../packages/ai/claude-desktop/src/index.ts'
import { desktopBundledExe } from '../packages/ai/opencode/src/index.ts'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { ClaudeDesktopAdapter, DESKTOP_URL_MAX } from '../packages/ai/claude-desktop/src/index.ts'
import { createClaudeDesktopLocator, createClaudeLocator } from '../packages/session-locators/src/index.ts'
import { ExportService } from '../apps/desktop/src/main/services/export.ts'
import { detectWithTimeout } from '../apps/desktop/src/main/services/detect.ts'
import { collectKimiSessions } from '../packages/ai/kimi/src/index.ts'
import tickExtension from '../packages/tick-extension/src/index.ts'
import { cleanupLaunchCache, renderTerminalScript } from '../apps/desktop/src/main/services/terminal-launch.ts'
import { TodoStore } from '../apps/desktop/src/main/store.ts'
import { LaunchService } from '../apps/desktop/src/main/services/launch.ts'
import { SettingsStore } from '../apps/desktop/src/main/services/settings-store.ts'
import { DEFAULT_SETTINGS, newCliSessionId } from '../packages/shared/src/index.ts'

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
const dir = mkdtempSync(path.join(os.tmpdir(), 'tick-selftest-case-'))
/** Qoder 用例的终端捕获（跨 check 共享） */
let capturedQoder: { cwd: string; args: string[] } | undefined
const sid = '11111111-2222-4333-8444-555555555555'

// ---- pi 就绪判定：只认可执行文件，不探测版本 ----
await check('pi installed without version gating', async () => {
  const fake = path.join(dir, 'old-pi.sh')
  writeFileSync(fake, '#!/bin/sh\necho "1.2.0"\n', { mode: 0o700 })
  const d = await new PiAdapter({ resolveExe: async () => fake, sessionRoots: () => [] }).detect()
  assert.equal(d.installed, true)
  // 版本字段与 usable 已移除：旧版本不再被提前拦掉
  assert.equal('usable' in d, false)
  assert.equal('version' in d, false)
})

// ---- GUI（Finder / launchd）环境下的 pi 定位 ----
// 这些断言就是 2026-10-19「装了 pi 但检测不到」的回归防线：
// 打包 app 只继承最小 PATH，靠静态前缀 / 登录 shell PATH 兜底，不能再依赖 `pi --version`。

const probeHome = path.join(dir, 'probe-home')
const probeInPrefix = path.join(probeHome, '.local', 'bin', 'pi')
const minimalPath = '/usr/bin:/bin:/usr/sbin:/sbin' // launchd 给 GUI 的默认 PATH

await check('probe: 常见安装前缀覆盖 npm 全局 / ~/.local/bin / Homebrew', () => {
  const dirs = commonBinDirs('/Users/someone')
  for (const expected of [
    '/Users/someone/.npm-global/bin',
    '/Users/someone/.local/bin',
    '/Users/someone/Library/pnpm',
    '/Users/someone/.bun/bin',
    '/Users/someone/.volta/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    assert.ok(dirs.includes(expected), `缺少候选目录 ${expected}`)
  }
})

await check('probe: 最小 PATH 下仍能按常见前缀找到 pi', async () => {
  const exe = await findCliExecutable('pi', {
    env: { PATH: minimalPath },
    home: probeHome,
    isExecutable: (f) => f === probeInPrefix,
    loginShellPath: async () => null,
  })
  assert.equal(exe, probeInPrefix)
})

await check('probe: 前缀都没有时退回登录 shell 的 PATH（nvm / 自定义 prefix）', async () => {
  const shellBin = path.join(dir, 'shell-bin')
  const shellPi = path.join(shellBin, 'pi')
  const exe = await findCliExecutable('pi', {
    env: { PATH: minimalPath },
    home: probeHome,
    isExecutable: (f) => f === shellPi,
    loginShellPath: async () => `${shellBin}:/usr/bin:/bin`,
  })
  assert.equal(exe, shellPi)
})

await check('probe: TICK_PI_PATH 覆盖优先', async () => {
  const custom = path.join(dir, 'custom-pi')
  const exe = await findCliExecutable('pi', {
    env: { PATH: minimalPath, TICK_PI_PATH: custom },
    home: probeHome,
    isExecutable: (f) => f === custom || f === probeInPrefix,
    loginShellPath: async () => null,
  })
  assert.equal(exe, custom)
})

await check('probe: 找不到时返回 null，不把不存在的路径当已安装', async () => {
  const exe = await findCliExecutable('pi', {
    env: { PATH: minimalPath },
    home: path.join(dir, 'empty-home'),
    isExecutable: () => false,
    loginShellPath: async () => null,
  })
  assert.equal(exe, null)
})

await check('probe: 只认可执行普通文件（0644 / 目录 / 断链都不算）', () => {
  const plain = path.join(dir, 'pi-plain')
  writeFileSync(plain, 'not a program\n')
  chmodSync(plain, 0o644)
  assert.equal(isExecutableFile(plain), false)
  const runnable = path.join(dir, 'pi-runnable')
  writeFileSync(runnable, '#!/bin/sh\n')
  chmodSync(runnable, 0o755)
  assert.equal(isExecutableFile(runnable), true)
  assert.equal(isExecutableFile(dir), false)
  assert.equal(isExecutableFile(path.join(dir, 'pi-missing')), false)
})

// ---- prefill ack / 超时 / 超限 ----
// ---- detect：TICK_<TOOL>_PATH 指向可执行文件时 detect=true（GUI 最小 PATH 纪律的回归） ----
// 为什么放这么靠前：probe-exe 有 TTL 缓存，必须在该工具第一次真实 detect 之前跑
await check('detect: TICK_CODEX_PATH 指向可执行文件时 detect=true（不依赖本机安装）', async () => {
  const fake = path.join(dir, 'fake-codex-bin')
  writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const prev = process.env.TICK_CODEX_PATH
  process.env.TICK_CODEX_PATH = fake
  try {
    // 不注入 resolveExe：走真实 probe-exe 链路（与打包后 GUI 最小 PATH 的场景一致）
    assert.equal((await new CodexAdapter().detect()).installed, true)
  } finally {
    if (prev === undefined) delete process.env.TICK_CODEX_PATH
    else process.env.TICK_CODEX_PATH = prev
  }
})

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

// ---- Claude Code CLI adapter（不依赖本机安装；夹具会话写入临时 CLAUDE_CONFIG_DIR） ----
// 覆盖：无首行 header 的 cwd 解析、entrypoint 过滤（与 Desktop 共用 jsonl 不重复列）、
// 合成消息过滤、--prefill/--argv/--clipboard 的 argv、resume 用绝对路径、verify 绕缓存。
const claudeHome = path.join(dir, 'claude-home')
const claudeRoot = path.join(claudeHome, '.claude', 'projects', '-tmp-proj')
mkdirSync(claudeRoot, { recursive: true })
// 夹具 cwd 必须真实存在：resume 只在会话 cwd 存在时采用它（否则退回调用方 cwd，是刻意的降级）
const claudeCwd = path.join(dir, 'claude-proj')
mkdirSync(claudeCwd, { recursive: true })
const claudeSid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const desktopSid = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const claudeEnv = { ...process.env, HOME: claudeHome, CLAUDE_CONFIG_DIR: path.join(claudeHome, '.claude') }
delete claudeEnv.TICK_CLAUDE_PATH
function writeClaudeSession(file: string, sessionId: string, opts: { entrypoint?: string; cwd?: string } = {}) {
  const lines = [
    // 首行故意不是 header：实测第一行可能是 queue-operation / mode / custom-title
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'custom-title', customTitle: 'fixture title', sessionId },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-stdout>noise</local-command-stdout>' }, sessionId, cwd: opts.cwd ?? claudeCwd, timestamp: '2026-10-19T00:00:00.000Z', ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}) },
    { type: 'user', message: { role: 'user', content: 'real first ask' }, sessionId, cwd: opts.cwd ?? claudeCwd, timestamp: '2026-10-19T00:00:01.000Z', ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}) },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }, sessionId },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }, sessionId },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] }, sessionId },
    { type: 'user', message: { role: 'user', content: 'real last ask' }, sessionId, cwd: opts.cwd ?? claudeCwd, timestamp: '2026-10-19T00:00:09.000Z', ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}) },
  ]
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}
writeClaudeSession(path.join(claudeRoot, `${claudeSid}.jsonl`), claudeSid, { entrypoint: 'cli' })
writeClaudeSession(path.join(claudeRoot, `${desktopSid}.jsonl`), desktopSid, { entrypoint: 'claude-desktop' })
// 0 字节僵尸：不算产生
writeFileSync(path.join(claudeRoot, 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'), '')

await check('claude: detect 只认可执行文件（不跑 --version）', async () => {
  const exe = path.join(dir, 'fake-claude')
  writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const adapter = new ClaudeAdapter({ resolveExe: async () => exe, sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }] })
  assert.deepEqual(await adapter.detect(), { installed: true })
  const missing = new ClaudeAdapter({ resolveExe: async () => null })
  assert.equal((await missing.detect()).installed, false)
})

await check('claude: 列表跳过 0 字节与 Desktop 会话，cwd/标题/首末消息正确', async () => {
  const adapter = new ClaudeAdapter({ resolveExe: async () => '/fake/claude', sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }] })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, JSON.stringify(list.map((s) => s.sessionId)))
  assert.equal(list[0]?.sessionId, claudeSid)
  assert.equal(list[0]?.cwd, claudeCwd)
  assert.equal(list[0]?.name, 'fixture title')
  assert.equal(list[0]?.firstMessage, 'real first ask')
  const info = await adapter.describeSession(claudeSid)
  assert.equal(info?.lastMessage, 'real last ask') // 合成/tool_result 都被过滤
  assert.equal(info?.exists, true)
  assert.equal(info?.resumable, true)
  // withName=false 只回 cwd，不带标题
  const bare = await adapter.describeSession(claudeSid, { withName: false })
  assert.equal(bare?.name, undefined)
  assert.equal(bare?.cwd, claudeCwd)
})

await check('claude: 用量按 message.id 去重（重复行不重复计）', async () => {
  const adapter = new ClaudeAdapter({ resolveExe: async () => '/fake/claude', sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }] })
  const usage = await adapter.computeUsage(claudeSid)
  assert.equal(usage?.tokens.input, 10)
  assert.equal(usage?.tokens.output, 5)
  assert.equal(usage?.tokens.cacheRead, 2)
  assert.equal(usage?.tokens.cacheWrite, 1)
  assert.equal(usage?.costReported, false) // 无 cost-state 快照 → 只能当下限
})

await check('claude: launch 的 argv（prefill 原生 --prefill= / argv 用 -- 分隔 / clipboard 不进 argv）', async () => {
  const specs: { args: string[]; env?: Record<string, string> }[] = []
  const clips: string[] = []
  const adapter = new ClaudeAdapter({
    resolveExe: async () => '/fake/claude',
    sessionRoots: () => [],
    openTerminal: (spec) => { specs.push(spec) },
    clipboardWrite: (t) => clips.push(t),
  })
  const base = { cwd: dir, sessionId: newCliSessionId(sid) }
  const pre = await adapter.launch({ ...base, promptText: 'do it', deliver: 'prefill' })
  assert.equal(pre.delivered, 'prefill')
  assert.equal(pre.verified, false) // 预填下会话文件要等用户回车
  assert.deepEqual(specs.at(-1)?.args, ['--session-id', sid, '--prefill=do it'])

  const arg = await adapter.launch({ ...base, promptText: '-dash', deliver: 'argv' })
  assert.equal(arg.delivered, 'argv')
  assert.deepEqual(specs.at(-1)?.args, ['--session-id', sid, '--', '-dash'])

  const clip = await adapter.launch({ ...base, promptText: 'p', name: 'my todo', deliver: 'clipboard' })
  assert.equal(clip.delivered, 'clipboard')
  assert.deepEqual(specs.at(-1)?.args, ['--session-id', sid, '--name', 'my todo'])
  assert.deepEqual(clips, ['p'])

  await assert.rejects(() => adapter.launch({ ...base, promptText: '   ', deliver: 'prefill' }))
  await assert.rejects(() => adapter.launch({ ...base, cwd: path.join(dir, 'nope'), promptText: 'x', deliver: 'prefill' }))
})

await check('claude: verify 绕缓存直读，0 字节/不存在都算未产生', async () => {
  const adapter = new ClaudeAdapter({ resolveExe: async () => '/fake/claude', sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }] })
  assert.equal(await adapter.verify(claudeSid, { retries: 0 }), true)
  assert.equal(await adapter.verify('cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee', { retries: 0 }), false)
  assert.equal(await adapter.verify('99999999-2222-4333-8444-555555555555', { retries: 0 }), false)
})

await check('claude: resume 用会话文件绝对路径 + 会话自己的 cwd', async () => {
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new ClaudeAdapter({
    resolveExe: async () => '/fake/claude',
    sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }],
    openTerminal: (spec) => { captured = { cwd: spec.cwd, args: spec.args } },
  })
  const out = await adapter.resume(newCliSessionId(claudeSid), { promptText: '', cwd: dir, sessionId: newCliSessionId(claudeSid), deliver: 'none' })
  assert.equal(out.verified, true)
  assert.deepEqual(captured?.args, ['--resume', path.join(claudeRoot, `${claudeSid}.jsonl`)])
  assert.equal(captured?.cwd, claudeCwd)
  await assert.rejects(() => adapter.resume(newCliSessionId('99999999-2222-4333-8444-555555555555'), { promptText: '', cwd: dir, sessionId: newCliSessionId('99999999-2222-4333-8444-555555555555'), deliver: 'none' }))
})

// ---- Claude Desktop adapter（桌面工具：prefill + 深链接 resume，launch 必须抛错） ----
await check('claude-desktop: 未安装时静默禁用，launch 直接抛错', async () => {
  const adapter = new ClaudeDesktopAdapter({ appDirs: [path.join(dir, 'no-apps')], home: claudeHome })
  assert.equal((await adapter.detect()).installed, false)
  assert.deepEqual(await adapter.listSessionInfos(), [])
  assert.deepEqual(await adapter.discoverProjects(), [])
  await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
})

await check('claude-desktop: 只列 Desktop 会话（与 CLI 同一份 jsonl 不重复）', async () => {
  const appDir = path.join(dir, 'fake-apps')
  const bundle = path.join(appDir, 'Claude.app', 'Contents')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>',
  )
  // 登录态：Desktop userData 里有 local-agent-mode-sessions 目录
  mkdirSync(path.join(claudeHome, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'), { recursive: true })
  const urls: string[] = []
  const adapter = new ClaudeDesktopAdapter({
    appDirs: [appDir],
    home: claudeHome,
    sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }],
    openUrl: (url) => { urls.push(url) },
  })
  assert.equal((await adapter.detect()).installed, true)
  const list = await adapter.listSessionInfos()
  assert.deepEqual(list.map((s) => s.sessionId), [desktopSid])
  assert.equal(list[0]?.toolId, 'claude-desktop')

  // resume：深链接 + 三道前置校验
  const out = await adapter.resume(newCliSessionId(desktopSid), { promptText: '', cwd: dir, sessionId: newCliSessionId(desktopSid), deliver: 'none' })
  assert.equal(out.verified, true)
  assert.equal(urls.at(-1), `claude://resume?session=${desktopSid}`)
  // CLI 会话不能从 Desktop 打开（不在 Desktop 列表里，但按 id 直查能找到 → 仍允许，这是有意的：
  // Desktop 的 claude://resume 本来就能导入任意 CLI 会话）
  await assert.rejects(() => adapter.resume(newCliSessionId('99999999-2222-4333-8444-555555555555'), { promptText: '', cwd: dir, sessionId: newCliSessionId('99999999-2222-4333-8444-555555555555'), deliver: 'none' }))

  // prefill：不发送、不绑定，只开新建页
  const pre = await adapter.openNewSessionPage({ promptText: 'hello', cwd: dir })
  assert.equal(pre.ok, true)
  assert.equal(pre.truncated, false)
  assert.ok(urls.at(-1)?.startsWith('claude://code/new?'))
  assert.ok(urls.at(-1)?.includes('folder='))
  assert.ok(urls.at(-1)?.includes('q=hello'))
  assert.equal((await adapter.openNewSessionPage({ promptText: '', cwd: dir })).ok, false)
  assert.equal((await adapter.openNewSessionPage({ promptText: 'x', cwd: 'relative/path' })).ok, false)
})

await check('claude-desktop: 超长文案按码点截断并如实返回 truncated', async () => {
  const urls: string[] = []
  const adapter = new ClaudeDesktopAdapter({
    appDirs: [path.join(dir, 'fake-apps')],
    home: claudeHome,
    sessionRoots: () => [],
    openUrl: (url) => { urls.push(url) },
  })
  const out = await adapter.openNewSessionPage({ promptText: '😀'.repeat(20000), cwd: dir })
  assert.equal(out.ok, true)
  assert.equal(out.truncated, true)
  assert.ok((urls.at(-1)?.length ?? 0) <= DESKTOP_URL_MAX)
  assert.ok(!(urls.at(-1) ?? '').includes('%EF%BF%BD')) // 不能劈开 emoji
})

// ---- Claude CLI：magpie 口径的三条修正（修订版、合成消息、标题/提示过滤） ----
await check('claude: 用量取「同 id 最后修订」、忽略 <synthetic>；summary 兼底标题', async () => {
  const root = path.join(dir, 'claude-rev-projects', 'p')
  mkdirSync(root, { recursive: true })
  const sid2 = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  writeFileSync(
    path.join(root, `${sid2}.jsonl`),
    [
      { type: 'summary', summary: '压缩出来的摘要', sessionId: sid2 },
      { type: 'mode', mode: 'normal', sessionId: sid2 },
      { type: 'user', message: { role: 'user', content: '真问题' }, sessionId: sid2, cwd: dir },
      // 同一条消息的两次修订：后一条才是最终用量
      { type: 'assistant', message: { id: 'rev', role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 1 } }, sessionId: sid2 },
      { type: 'assistant', message: { id: 'rev', role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 30, output_tokens: 2 } }, sessionId: sid2 },
      // 合成消息：带 usage 但不能计
      { type: 'assistant', message: { id: 'syn', role: 'assistant', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } }, sessionId: sid2 },
      // 合成行（注入上下文/中断标记）不算 user 文本
      { type: 'user', message: { role: 'user', content: '[Request interrupted by user]' }, sessionId: sid2 },
      { type: 'user', message: { role: 'user', content: 'Caveat: The messages below were generated' }, sessionId: sid2 },
      { type: 'user', message: { role: 'user', content: '<ide_opened_file>noise</ide_opened_file>' }, sessionId: sid2 },
      { type: 'user', message: { role: 'user', content: '真的最后一句' }, sessionId: sid2, cwd: dir },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  const adapter = new ClaudeAdapter({
    resolveExe: async () => '/fake/claude',
    sessionRoots: () => [{ dir: path.join(dir, 'claude-rev-projects'), source: 'default' }],
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list[0]?.name, '压缩出来的摘要') // ai-title 缺失 → summary 兼底
  const info = await adapter.describeSession(newCliSessionId(sid2))
  assert.equal(info?.lastMessage, '真的最后一句')
  const usage = await adapter.computeUsage(newCliSessionId(sid2))
  assert.equal(usage?.tokens.input, 30) // 修订版覆盖前一条，而不是 10+30
  assert.equal(usage?.tokens.output, 2)
  assert.equal(usage?.byModel.length, 1) // <synthetic> 不进桶
})

// ---- Qoder：与 Claude Code 同格式，只换身份/数据根/resume argv ----
await check('qoder: 两个发行版各自的数据根 + 各自的 toolId（不复用同一实例）', () => {
  const cfg = path.join(dir, 'qoder-cfg')
  const cfgCn = path.join(dir, 'qoder-cn-cfg')
  mkdirSync(path.join(cfg, 'projects'), { recursive: true })
  mkdirSync(path.join(cfgCn, 'projects'), { recursive: true })
  const env = { QODER_CONFIG_DIR: cfg, QODERCN_CONFIG_DIR: cfgCn }
  assert.equal(resolveQoderSessionRoots(QODER_DISTRO, env, '/h')[0]?.dir, path.join(cfg, 'projects'))
  assert.equal(resolveQoderSessionRoots(QODER_CN_DISTRO, env, '/h')[0]?.dir, path.join(cfgCn, 'projects'))
  // 目录不存在时返回空（只读：不 mkdir）
  assert.equal(resolveQoderSessionRoots(QODER_DISTRO, {}, '/h').length, 0)
  const a = new QoderAdapter(QODER_DISTRO)
  const b = new QoderAdapter(QODER_CN_DISTRO)
  assert.equal(a.id, 'qoder')
  assert.equal(b.id, 'qoder-cn')
  assert.notEqual(a.id, b.id)
})

await check('qoder: 会话列表/详情/用量复用 Claude 内核，resume 用 --resume <id>', async () => {
  const root = path.join(dir, 'qoder-home', 'projects', '-Users-x-qoder')
  mkdirSync(root, { recursive: true })
  const sid3 = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
  writeFileSync(
    path.join(root, `${sid3}.jsonl`),
    [
      { type: 'mode', mode: 'normal', sessionId: sid3 },
      { type: 'ai-title', aiTitle: 'Qoder 会话', sessionId: sid3 },
      { type: 'user', message: { role: 'user', content: '在 Qoder 里问的' }, sessionId: sid3, cwd: dir },
      // Qoder 只在一条回复的最后一块写 usage（前一块没有 usage 字段）
      { type: 'assistant', message: { id: 'q1', role: 'assistant', model: 'claude-sonnet-5', content: [] }, sessionId: sid3 },
      { type: 'assistant', message: { id: 'q1', role: 'assistant', model: 'claude-sonnet-5', usage: { input_tokens: 11, output_tokens: 4 } }, sessionId: sid3 },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  const adapter = new QoderAdapter(QODER_DISTRO, {
    sessionRoots: () => [{ dir: path.join(dir, 'qoder-home', 'projects'), source: 'default' }],
    resolveExe: async () => '/fake/qodercli',
    openTerminal: (spec) => { capturedQoder = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.toolId, 'qoder')
  assert.equal(list[0]?.name, 'Qoder 会话')
  const info = await adapter.describeSession(newCliSessionId(sid3))
  assert.equal(info?.lastMessage, '在 Qoder 里问的')
  assert.equal(info?.toolId, 'qoder')
  const usage = await adapter.computeUsage(newCliSessionId(sid3))
  assert.equal(usage?.tokens.input, 11) // 没有 usage 的块不会把非零用量抹成 0
  assert.equal(usage?.tokens.output, 4)

  // 回到会话：argv 是 --resume <id>（不是 transcript 路径），cwd 取会话自己的
  const out = await adapter.resume(newCliSessionId(sid3), {
    promptText: '',
    cwd: '/tmp',
    sessionId: newCliSessionId(sid3),
    deliver: 'none',
  })
  assert.equal(out.verified, true)
  assert.deepEqual(capturedQoder?.args, ['--resume', sid3])
  assert.equal(capturedQoder?.cwd, dir)

  // 没有预生成 id 的能力 → launch 必须直接拒绝（不假装能新建）
  await assert.rejects(() =>
    adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'argv' }),
  )
})

// ---- Claude Desktop：Desktop 自己的会话（local_<id> + 每会话 .claude home） ----
// 布局来源：app.asar 的 iFt()/Gti() + magpie 的 calls.go/desktop_titles.go（两处独立一致）。
await check('claude-desktop: local_ 会话（每会话 .claude home）可列/可描述/可回到会话', async () => {
  const dataDir = path.join(claudeHome, 'Library', 'Application Support', 'Claude')
  const localId = 'local_abc'
  const cliId = 'ffffffff-2222-4333-8444-555555555555'
  const home = path.join(dataDir, 'claude-code-sessions', 'acct', 'org', localId)
  const projectDir = path.join(home, '.claude', 'projects', '-Users-x-proj')
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path.join(projectDir, `${cliId}.jsonl`), [
    { type: 'mode', mode: 'normal', sessionId: cliId },
    { type: 'user', message: { role: 'user', content: '在 Desktop 里问的' }, sessionId: cliId, cwd: dir },
    { type: 'assistant', message: { id: 'd1', role: 'assistant', model: 'claude-opus-5', usage: { input_tokens: 7, output_tokens: 3 } }, sessionId: cliId },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  mkdirSync(path.join(dataDir, 'claude-code-sessions', 'acct', 'org'), { recursive: true })
  writeFileSync(
    path.join(dataDir, 'claude-code-sessions', 'acct', 'org', `${localId}.json`),
    JSON.stringify({ sessionId: localId, cliSessionId: cliId, title: 'Desktop 里的会话名', isArchived: false, createdAt: Date.now() - 60_000, lastActivityAt: Date.now() }),
  )
  // 归档会话：深链接打不开 → resumable=false，resume 必须直接拒
  const archivedId = 'local_archived'
  const archivedHome = path.join(dataDir, 'claude-code-sessions', 'acct', 'org', archivedId)
  const archivedProject = path.join(archivedHome, '.claude', 'projects', '-Users-x-proj')
  mkdirSync(archivedProject, { recursive: true })
  writeFileSync(path.join(archivedProject, 'aaaaaaaa-1111-4222-8333-444444444444.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' }, sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: dir }) + '\n')
  writeFileSync(
    path.join(dataDir, 'claude-code-sessions', 'acct', 'org', `${archivedId}.json`),
    JSON.stringify({ sessionId: archivedId, title: '归档的', isArchived: true }),
  )

  const urls: string[] = []
  const adapter = new ClaudeDesktopAdapter({
    appDirs: [path.join(dir, 'fake-apps')],
    home: claudeHome,
    sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }],
    openUrl: (url) => { urls.push(url) },
  })
  const list = await adapter.listSessionInfos()
  const local = list.find((s) => s.sessionId === localId)
  assert.ok(local, JSON.stringify(list.map((s) => s.sessionId)))
  assert.equal(local?.toolId, 'claude-desktop')
  assert.equal(local?.name, 'Desktop 里的会话名') // 记录里的标题优先
  assert.equal(local?.resumable, true)
  assert.ok(local?.filePath.includes(`${localId}/.claude/projects/`))
  const archived = list.find((s) => s.sessionId === archivedId)
  assert.equal(archived?.resumable, false)

  // resume：local_ → code/continue；uuid → resume
  await adapter.resume(newCliSessionId(localId), { promptText: '', cwd: dir, sessionId: newCliSessionId(localId), deliver: 'none' })
  assert.equal(urls.at(-1), `claude://code/continue?session=${localId}`)
  await adapter.resume(newCliSessionId(cliId), { promptText: '', cwd: dir, sessionId: newCliSessionId(cliId), deliver: 'none' })
  assert.equal(urls.at(-1), `claude://resume?session=${cliId}`)
  await assert.rejects(() =>
    adapter.resume(newCliSessionId(archivedId), { promptText: '', cwd: dir, sessionId: newCliSessionId(archivedId), deliver: 'none' }),
  )

  // 详情与用量走同一份正文
  const info = await adapter.describeSession(newCliSessionId(localId))
  assert.equal(info?.cwd, dir)
  assert.equal(info?.toolId, 'claude-desktop')
  const usage = await adapter.computeUsage(newCliSessionId(localId))
  assert.equal(usage?.tokens.input, 7)
  assert.equal(usage?.messageCount, 1) // 按 assistant message.id 去重（夹具里只有一条 assistant 消息 d1）

  // 项目发现同时吃「记录里的 cwd」与全局 store（路径统一 canonicalPath：/var → /private/var）
  const projects = await adapter.discoverProjects()
  assert.ok(projects.some((p) => p.path === canonicalPath(dir)), JSON.stringify(projects))
})

// ---- Codex：一个 thread 多 rollout 文件、input 扣 cache、注入消息过滤 ----
await check('codex: 同 thread 的多个 rollout 归并成一条会话，用量按「末次 total − 基线」相加', async () => {
  const codexHome = path.join(dir, 'codex-home')
  const dayDir = path.join(codexHome, 'sessions', '2026', '10', '20')
  mkdirSync(dayDir, { recursive: true })
  const thread = '019d3945-186c-74f3-94d2-6e79b2166942'
  const writeRollout = (file: string, lines: unknown[], mtime: number) => {
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const t = new Date(mtime)
    utimesSync(file, t, t)
  }
  // 第一个文件：从 0 开始累计
  writeRollout(
    path.join(dayDir, `rollout-2026-10-20T10-00-00-${thread}.jsonl`),
    [
      { timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { session_id: thread, id: thread, cwd: dir, originator: 'codex_cli_rs' } },
      { timestamp: '2026-10-20T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }] } },
      { timestamp: '2026-10-20T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真问题一' }] } },
      { timestamp: '2026-10-20T10:00:03.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex', cwd: dir } },
      { timestamp: '2026-10-20T10:00:04.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 50 } } } },
      { timestamp: '2026-10-20T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 3000, cached_input_tokens: 1200, cache_write_input_tokens: 100, output_tokens: 150 }, last_token_usage: { input_tokens: 2000, cached_input_tokens: 800, cache_write_input_tokens: 100, output_tokens: 100 } } } },
    ],
    Date.now() - 60_000,
  )
  // 第二个文件（同 thread 续写）：计数器从 0 重新开始 → 相加
  writeRollout(
    path.join(dayDir, `rollout-2026-10-20T11-00-00-${thread}_1.jsonl`),
    [
      { timestamp: '2026-10-20T11:00:00.000Z', type: 'session_meta', payload: { session_id: thread, id: thread, cwd: dir } },
      { timestamp: '2026-10-20T11:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真问题二' }] } },
      { timestamp: '2026-10-20T11:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20 }, last_token_usage: { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20 } } } },
    ],
    Date.now() - 30_000,
  )
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new CodexAdapter({
    codexHome,
    resolveExe: async () => '/fake/codex',
    openTerminal: (spec) => { captured = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '同 thread 的两个 rollout 必须归并成一条会话')
  assert.equal(list[0]?.sessionId, thread)
  assert.equal(list[0]?.files?.length, 2)
  assert.equal(list[0]?.firstMessage, '真问题一') // <environment_context> 被过滤
  assert.equal(list[0]?.cwd, dir)
  const info = await adapter.describeSession(newCliSessionId(thread))
  assert.equal(info?.lastMessage, '真问题二')
  const usage = await adapter.computeUsage(newCliSessionId(thread))
  // 文件1：input=(3000-1200-100)=1700, output=150, cacheRead=1200, cacheWrite=100
  // 文件2：input=500, output=20
  assert.equal(usage?.tokens.input, 1700 + 500)
  assert.equal(usage?.tokens.output, 150 + 20)
  assert.equal(usage?.tokens.cacheRead, 1200)
  // resume：codex resume <id>，cwd 取会话自己的
  await adapter.resume(newCliSessionId(thread), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId(thread), deliver: 'none' })
  assert.deepEqual(captured?.args, ['resume', thread])
  assert.equal(captured?.cwd, dir)
  // 没有预生成 id → launch 必须拒绝
  await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
})

// ---- Cline：manifest + 整份重写的 messages.json、<user_input> 剥离、AI SDK 口径 ----
await check('cline: manifest/messages 解析、<user_input> 剥离、input 扣 cache、resume --id', async () => {
  const sdir = path.join(dir, 'cline-sessions')
  const id = '5d21f-1774698689455-pqkr95n3'
  const sdir2 = path.join(sdir, id)
  mkdirSync(sdir2, { recursive: true })
  writeFileSync(
    path.join(sdir2, `${id}.json`),
    JSON.stringify({
      session_id: id,
      cwd: dir,
      started_at: '2026-10-20T09:00:00.000Z',
      ended_at: '2026-10-20T09:10:00.000Z',
      status: 'completed',
      model: 'MiniMax-M2.7',
      provider: 'minimax',
      metadata: { title: 'Cline 的标题' },
      prompt: 'manifest 里的首条',
    }),
  )
  writeFileSync(
    path.join(sdir2, `${id}.messages.json`),
    JSON.stringify({
      messages: [
        { role: 'user', content: '<user_input mode="act">用户真的问的</user_input>', ts: 1 },
        { role: 'assistant', content: '答', modelInfo: { id: 'MiniMax-M2.7' }, metrics: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 100 } },
        { role: 'user', content: '<system-reminder>注入</system-reminder>', ts: 2 },
        { role: 'user', content: '<user_input mode="act">最后一句</user_input>', ts: 3 },
      ],
      updated_at: '2026-10-20T09:10:00.000Z',
    }),
  )
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new ClineAdapter({
    sessionDir: sdir,
    resolveExe: async () => '/fake/cline',
    openTerminal: (spec) => { captured = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.name, 'Cline 的标题')
  assert.equal(list[0]?.cwd, dir)
  const info = await adapter.describeSession(newCliSessionId(id))
  assert.equal(info?.firstMessage, 'manifest 里的首条')
  assert.equal(info?.lastMessage, '最后一句') // <system-reminder> 不算用户消息
  const usage = await adapter.computeUsage(newCliSessionId(id))
  assert.equal(usage?.tokens.input, 500) // 1000 - 400 - 100
  assert.equal(usage?.tokens.output, 50)
  assert.equal(usage?.tokens.cacheRead, 400)
  await adapter.resume(newCliSessionId(id), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId(id), deliver: 'none' })
  assert.deepEqual(captured?.args, ['--id', id])
  await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
})

// ---- Grok：目录型会话、generated_title、秒级时间戳、子代理过滤 ----
await check('grok: summary + updates 解析、子代理不进列表、turn_completed 用量', async () => {
  const grokHome = path.join(dir, 'grok-home')
  const cwdDir = path.join(grokHome, 'sessions', '%2FUsers%2Fx%2Fproj')
  const mk = (id: string, summary: Record<string, unknown>, updates?: string[], mtime = Date.now()) => {
    const d = path.join(cwdDir, id)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'summary.json'), JSON.stringify(summary))
    if (updates) writeFileSync(path.join(d, 'updates.jsonl'), updates.join('\n') + '\n')
    const t = new Date(mtime)
    for (const f of ['summary.json', 'updates.jsonl']) {
      try { utimesSync(path.join(d, f), t, t) } catch { /* 可能没有 updates */ }
    }
  }
  mk(
    '01a04e68-0662-7513-9512-055ae4478466',
    { info: { id: '01a04e68-0662-7513-9512-055ae4478466', cwd: dir }, generated_title: 'Grok 的标题', created_at: '2026-10-20T08:00:00.000Z', current_model_id: 'grok-4.5' },
    [
      JSON.stringify({ type: 'user', timestamp: 1770000000, message: { role: 'user', content: '问一句' } }),
      JSON.stringify({ type: 'turn_completed', timestamp: 1770000010, usage: { modelUsage: { 'grok-4.5': { inputTokens: 1000, cachedReadTokens: 300, cacheWriteTokens: 0, outputTokens: 40 } } } }),
      JSON.stringify({ type: 'user', timestamp: 1770000020, message: { role: 'user', content: '再问一句' } }),
    ],
    Date.now() - 10_000,
  )
  mk(
    '01a04e68-9999-0000-0000-000000000000',
    { info: { id: '01a04e68-9999-0000-0000-000000000000', cwd: dir }, session_kind: 'subagent', parent_session_id: '01a04e68-0662-7513-9512-055ae4478466' },
    undefined,
    Date.now() - 20_000,
  )
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new GrokAdapter({
    grokHome,
    resolveExe: async () => '/fake/grok',
    openTerminal: (spec) => { captured = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '子代理会话不能进列表')
  assert.equal(list[0]?.name, 'Grok 的标题')
  assert.equal(list[0]?.cwd, dir)
  const info = await adapter.describeSession(newCliSessionId('01a04e68-0662-7513-9512-055ae4478466'))
  assert.equal(info?.firstMessage, '问一句')
  assert.equal(info?.lastMessage, '再问一句')
  const usage = await adapter.computeUsage(newCliSessionId('01a04e68-0662-7513-9512-055ae4478466'))
  assert.equal(usage?.tokens.input, 700) // 1000 - 300
  assert.equal(usage?.tokens.output, 40)
  await adapter.resume(newCliSessionId('01a04e68-0662-7513-9512-055ae4478466'), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId('01a04e68-0662-7513-9512-055ae4478466'), deliver: 'none' })
  assert.deepEqual(captured?.args, ['--resume', '01a04e68-0662-7513-9512-055ae4478466'])
})

// ---- omp：首行是 title（不是 header）、title_change 改名、pi 形状的 usage ----
await check('omp: 首行 title 行不影响 header 解析；当前标题取 title 记录（title_change 只是审计历史）', async () => {
  const agentDir = path.join(dir, 'omp-agent')
  const sdir = path.join(agentDir, 'sessions', '-Desktop-pi')
  mkdirSync(sdir, { recursive: true })
  const ompId = '019f3133-222d-7000-a63e-e1ac243ff575'
  writeFileSync(
    path.join(sdir, `2026-07-05T07-34-22-509Z_${ompId}.jsonl`),
    [
      // 物理 title 记录 = 当前标题；title_change 是 append-only 审计（可能更旧）
      { type: 'title', v: 1, title: '当前标题', source: 'user', pad: '   ' },
      { type: 'session', version: 3, id: ompId, timestamp: '2026-07-05T07:34:22.509Z', cwd: dir },
      { type: 'title_change', id: 'x', title: '早期标题', source: 'auto' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'omp 里的问题' }] } },
      { type: 'message', message: { role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: '答' }], usage: { input: 139, output: 449, cacheRead: 87680, cacheWrite: 0, totalTokens: 88268, cost: { total: 0.0007 } } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new OmpAdapter({
    agentDir,
    resolveExe: async () => '/fake/omp',
    openTerminal: (spec) => { captured = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.sessionId, ompId)
  assert.equal(list[0]?.name, '当前标题') // 以物理 title 记录为准，不被旧 title_change 覆盖
  assert.equal(list[0]?.cwd, dir)
  const info = await adapter.describeSession(newCliSessionId(ompId))
  assert.equal(info?.firstMessage, 'omp 里的问题')
  const usage = await adapter.computeUsage(newCliSessionId(ompId))
  assert.equal(usage?.tokens.cacheRead, 87680)
  await adapter.resume(newCliSessionId(ompId), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId(ompId), deliver: 'none' })
  assert.deepEqual(captured?.args, ['--resume', ompId])

  // 旧格式没有 title 记录 → 退回最后一个 title_change
  const legacyId = '019f3133-3333-7000-a63e-e1ac243ff575'
  writeFileSync(
    path.join(sdir, `2026-07-05T07-35-22-509Z_${legacyId}.jsonl`),
    [
      { type: 'session', version: 3, id: legacyId, timestamp: '2026-07-05T07:35:22.509Z', cwd: dir },
      { type: 'title_change', id: 'y', title: '兜底标题', source: 'auto' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  const legacy = (await adapter.listSessionInfos()).find((x) => x.sessionId === legacyId)
  assert.equal(legacy?.name, '兜底标题')

  // 新文件常见形态：title 记录为空（还没自动起名）→ 有 title_change 就用它
  const emptyId = '019f3133-5555-7000-a63e-e1ac243ff575'
  writeFileSync(
    path.join(sdir, `2026-07-05T07-36-22-509Z_${emptyId}.jsonl`),
    [
      { type: 'title', v: 1, title: '', pad: '   ' },
      { type: 'session', version: 3, id: emptyId, timestamp: '2026-07-05T07:36:22.509Z', cwd: dir },
      { type: 'title_change', id: 'z', title: '后起标题', source: 'auto' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  const empty = (await adapter.listSessionInfos()).find((x) => x.sessionId === emptyId)
  assert.equal(empty?.name, '后起标题')
})

await check('omp: cwd=~ 时加 --allow-home（否则 omp 会把会话落到 /tmp 项目）', async () => {
  const agentDir = path.join(dir, 'omp-home-agent')
  const home = path.join(dir, 'omp-fake-home')
  mkdirSync(path.join(home, 'proj'), { recursive: true })
  const sdir = path.join(agentDir, 'sessions', '-Users-fake')
  mkdirSync(sdir, { recursive: true })
  const homeSid = '019f3133-4444-7000-a63e-e1ac243ff575'
  writeFileSync(
    path.join(sdir, `2026-07-05T07-40-00-000Z_${homeSid}.jsonl`),
    [
      { type: 'title', v: 1, title: '', pad: '   ' },
      { type: 'session', version: 3, id: homeSid, timestamp: '2026-07-05T07:40:00.000Z', cwd: home },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )
  const opened: Array<{ cwd: string; args: string[] }> = []
  const adapter = new OmpAdapter({
    agentDir,
    home,
    resolveExe: async () => '/fake/omp',
    openTerminal: (spec) => { opened.push({ cwd: spec.cwd, args: spec.args }) },
    clipboardWrite: () => undefined,
  })

  // 新建：home → --allow-home；子目录 → 不加
  await adapter.openNewSessionPage({ promptText: 'x', cwd: home })
  await adapter.openNewSessionPage({ promptText: 'x', cwd: path.join(home, 'proj') })
  assert.deepEqual(opened[0]?.args, ['--allow-home'])
  assert.deepEqual(opened[1]?.args, [])

  // 回到会话：会话 cwd 就是 home → 同样要 --allow-home（否则 resume 又会切到 /tmp）
  await adapter.resume(newCliSessionId(homeSid), { promptText: '', cwd: home, sessionId: newCliSessionId(homeSid), deliver: 'none' })
  assert.deepEqual(opened[2]?.args, ['--resume', homeSid, '--allow-home'])
})

// ---- Kimi：cwd 只在 session_index.jsonl、子代理 wire 归主会话、usage.record 去重 ----
await check('kimi: state/index/wire 三处拼装（cwd 来自 index）、子代理用量归主、fork 记录去重', async () => {
  const kimiHome = path.join(dir, 'kimi-home')
  const sid5 = 'session_11111111-2222-4333-8444-555555555555'
  const sdir = path.join(kimiHome, 'sessions', 'wd_proj_abc', sid5)
  mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true })
  mkdirSync(path.join(sdir, 'agents', 'agent-0'), { recursive: true })
  writeFileSync(
    path.join(sdir, 'state.json'),
    JSON.stringify({
      title: 'Kimi 自己的标题',
      isCustomTitle: false,
      lastPrompt: '最后一句',
      createdAt: '2026-10-20T01:00:00.000Z',
      updatedAt: '2026-10-20T02:00:00.000Z',
      agents: { main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main' } },
    }),
  )
  // cwd 不在 state.json：只能从 index 拿
  writeFileSync(
    path.join(kimiHome, 'session_index.jsonl'),
    JSON.stringify({ sessionId: sid5, sessionDir: sdir, workDir: dir }) + '\n',
  )
  const wire = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  writeFileSync(
    path.join(sdir, 'agents', 'main', 'wire.jsonl'),
    wire([
      { type: 'metadata', protocol_version: '1.4', created_at: 1781614831507 },
      { type: 'config.update', cwd: dir, modelAlias: 'kimi-code/kimi-for-coding' },
      { type: 'turn.prompt', time: 1781614832000, origin: { kind: 'user' }, input: [{ type: 'text', text: '第一问' }] },
      { type: 'turn.prompt', time: 1781614833000, origin: { kind: 'skill' }, input: [{ type: 'text', text: '技能激活，不算用户' }] },
      { type: 'turn.steer', time: 1781614834000, origin: { kind: 'background_task' }, input: [{ type: 'text', text: '后台通知' }] },
      { type: 'usage.record', time: 1781614832500, model: 'kimi-code/kimi-for-coding', usageScope: 'turn', usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 } },
      // fork 会把同一批记录原样复制 → 同一 (agent,time,model,usage) 只计一次
      { type: 'usage.record', time: 1781614832500, model: 'kimi-code/kimi-for-coding', usageScope: 'turn', usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 } },
      { type: 'turn.prompt', time: 1781614835000, origin: { kind: 'user' }, input: [{ type: 'text', text: '第二问' }] },
    ]),
  )
  // 子代理的用量也归主会话
  writeFileSync(
    path.join(sdir, 'agents', 'agent-0', 'wire.jsonl'),
    wire([
      { type: 'usage.record', time: 1781614832600, model: 'kimi-code/kimi-for-coding', usageScope: 'turn', usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 2 } },
    ]),
  )
  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new KimiAdapter({
    kimiHome,
    resolveExe: async () => '/fake/kimi',
    openTerminal: (spec) => { captured = spec },
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.sessionId, sid5)
  assert.equal(list[0]?.cwd, dir) // 来自 index，而不是 state.json（后者没有 cwd）
  assert.equal(list[0]?.name, 'Kimi 自己的标题')
  const info = await adapter.describeSession(newCliSessionId(sid5))
  assert.equal(info?.firstMessage, '第一问') // skill / background_task 不算
  assert.equal(info?.lastMessage, '第二问')
  const usage = await adapter.computeUsage(newCliSessionId(sid5))
  assert.equal(usage?.tokens.input, 110) // 100 + 10（重复记录被去重）
  assert.equal(usage?.tokens.output, 25)
  assert.equal(usage?.tokens.cacheRead, 40)
  assert.equal(usage?.tokens.cacheWrite, 2)
  await adapter.resume(newCliSessionId(sid5), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId(sid5), deliver: 'none' })
  assert.deepEqual(captured?.args, ['--session', sid5])
  assert.equal(captured?.cwd, dir)
  await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
})

// ---- OpenCode / ZCode：SQLite（session/message/part），用量来源不同 ----
await check('opencode: SQLite 会话列表/正文/用量（session 行自带），子代理不列，resume --session', async () => {
  const dbPath = path.join(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'ses_main', null, dir, 'OpenCode 会话', 1000, 2000, null, '{"id":"deepseek-v4","providerID":"opencode"}', 0.5,
    500, 40, 10, 200, 5,
  )
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'ses_sub', 'ses_main', dir, '子代理', 1000, 2000, null, null, 0, 99, 99, 0, 0, 0,
  )
  const insertMsg = db.prepare('insert into message (id, session_id, time_created, data) values (?,?,?,?)')
  const insertPart = db.prepare('insert into part (id, message_id, time_created, data) values (?,?,?,?)')
  insertMsg.run('m1', 'ses_main', 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }))
  insertPart.run('p1', 'm1', 1000, JSON.stringify({ type: 'text', text: '用户在 OpenCode 里的第一问' }))
  insertMsg.run('m2', 'ses_main', 2000, JSON.stringify({ role: 'assistant', tokens: {} }))
  insertPart.run('p2', 'm2', 2000, JSON.stringify({ type: 'text', text: '助手答复（不计入用户消息）' }))
  insertMsg.run('m3', 'ses_main', 3000, JSON.stringify({ role: 'user', time: { created: 3000 } }))
  insertPart.run('p3', 'm3', 3000, JSON.stringify({ type: 'text', text: '最后一问' }))
  db.close()

  let captured: { cwd: string; args: string[] } | undefined
  const adapter = new OpenCodeAdapter(
    {
      toolId: 'opencode',
      displayName: 'OpenCode',
      dbPath,
      usageSource: 'session-row',
      exeName: 'opencode',
      resumeArgs: (id) => ['--session', id],
    },
    { resolveExe: async () => '/fake/opencode', openTerminal: (spec) => { captured = spec } },
  )
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '子代理会话（parent_id 非空）不能进列表')
  assert.equal(list[0]?.sessionId, 'ses_main')
  assert.equal(list[0]?.cwd, dir)
  assert.equal(list[0]?.name, 'OpenCode 会话')
  assert.equal(list[0]?.filePath, dbPath) // 正文在数据库里
  const info = await adapter.describeSession(newCliSessionId('ses_main'))
  assert.equal(info?.firstMessage, '用户在 OpenCode 里的第一问')
  assert.equal(info?.lastMessage, '最后一问')
  const usage = await adapter.computeUsage(newCliSessionId('ses_main'))
  // 父 500/50 + 子代理 99/99（子代理用量不在父会话行里，必须自己加回来）
  assert.equal(usage?.tokens.input, 599)
  assert.equal(usage?.tokens.output, 149)
  assert.equal(usage?.tokens.cacheRead, 200)
  assert.equal(usage?.cost.total, 0.5)
  // 子代理有 token 但没上报成本（cost=0）→ 合并后的钱只能当下限（UI 打「≥」），不能标成可信
  assert.equal(usage?.costReported, false)
  await adapter.resume(newCliSessionId('ses_main'), { promptText: '', cwd: '/tmp', sessionId: newCliSessionId('ses_main'), deliver: 'none' })
  assert.deepEqual(captured?.args, ['--session', 'ses_main'])
  await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
})

await check('zcode: 同一套表结构但用量取 model_usage、没有 resume 通道', async () => {
  const dbPath = path.join(dir, 'zcode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
    create table model_usage (id text primary key, session_id text, model_id text, input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer, cache_creation_input_tokens integer);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('ses_z', null, dir, 'ZCode 会话', 1000, 2000, null)
  db.prepare('insert into message values (?,?,?,?)').run('m1', 'ses_z', 1000, JSON.stringify({ role: 'user' }))
  db.prepare('insert into part values (?,?,?,?)').run('p1', 'm1', 1000, JSON.stringify({ type: 'text', text: 'ZCode 里问的' }))
  // 两次模型调用（含一次重试）→ 都要计入
  db.prepare('insert into model_usage values (?,?,?,?,?,?,?,?)').run('u1', 'ses_z', 'zcode-pro', 1000, 100, 20, 300, 5)
  db.prepare('insert into model_usage values (?,?,?,?,?,?,?,?)').run('u2', 'ses_z', 'zcode-pro', 500, 50, 10, 100, 0)
  db.close()

  const adapter = new ZCodeAdapter({ dbPath })
  assert.equal(adapter.capabilities.resumeSession, false)
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1)
  assert.equal(list[0]?.toolId, 'zcode')
  const usage = await adapter.computeUsage(newCliSessionId('ses_z'))
  assert.equal(usage?.tokens.input, 1500)
  assert.equal(usage?.tokens.output, 180) // (100+20) + (50+10)
  assert.equal(usage?.tokens.cacheRead, 400)
  assert.equal(usage?.tokens.cacheWrite, 5)
  assert.equal(usage?.byModel[0]?.model, 'zcode-pro')
  await assert.rejects(() =>
    adapter.resume(newCliSessionId('ses_z'), { promptText: '', cwd: dir, sessionId: newCliSessionId('ses_z'), deliver: 'none' }),
  )
})

// ---- dsh：多帧 zstd（每帧独立）、header 只在首帧、投影缓存出标题/用量、子代理归父 ----
await check('dsh: 多帧 zstd 切帧正确（10MB/23k 帧那种文件的缩小版）', () => {
  // 3 个独立帧 + 一个 skippable 帧：必须逐帧解出全部内容
  const f1 = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'))
  const f2 = zstdCompressSync(Buffer.from('{"type":"user/message"}\n'))
  const f3 = zstdCompressSync(Buffer.from('{"type":"session/title"}\n'))
  const skip = Buffer.alloc(8 + 4)
  skip.writeUInt32LE(0x184d2a50, 0)
  skip.writeUInt32LE(4, 4)
  const buf = Buffer.concat([f1, f2, skip, f3])
  const { frames, truncated } = splitFrames(buf)
  assert.equal(frames.length, 4)
  assert.equal(truncated, false)
  assert.equal(frames.filter((f) => f.skippable).length, 1)
  const file = path.join(dir, 'dsh-frames.jsonl.zstd')
  writeFileSync(file, buf)
  const lines: string[] = []
  readFrameLines(file, { onLine: (l) => { lines.push(l) } })
  assert.deepEqual(lines, ['{"type":"session","id":"s1"}', '{"type":"user/message"}', '{"type":"session/title"}'])
})

await check('dsh: header 取自首帧、列表不解压正文、子代理用量加回父会话、没有 resume', async () => {
  const dshHome = path.join(dir, 'dsh-home')
  const mkSession = (opts: {
    dirName: string
    id: string
    cwd: string
    createdAt: number
    depth?: number
    parent?: string
    title?: string
    lastPromptAt?: number
    totals?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
    events?: unknown[]
    subagentMark?: boolean
  }) => {
    const project = `--${opts.cwd.replace(/\//g, '-')}--`
    const sdir = path.join(dshHome, 'sessions', project, opts.dirName)
    mkdirSync(sdir, { recursive: true })
    const header = {
      type: 'session',
      version: 0,
      id: opts.id,
      createdAt: opts.createdAt,
      cwd: opts.cwd,
      delegationDepth: opts.depth ?? 0,
      ...(opts.parent ? { parentSession: opts.parent, origin: 'subagent' } : {}),
    }
    // 多个帧：header 单独一帧（模拟真实写入），其余事件再一帧
    const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'))]
    if (opts.events?.length) {
      frames.push(zstdCompressSync(Buffer.from(opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n')))
    }
    writeFileSync(path.join(sdir, 'session.jsonl.zstd'), Buffer.concat(frames))
    // 投影缓存
    const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
    mkdirSync(cacheDir, { recursive: true })
    const rows: Record<string, unknown> = {
      sessionListMetadata: { seq: 1, ver: 1, val: { blank: false, lastPromptAt: opts.lastPromptAt ?? opts.createdAt } },
    }
    if (opts.title) rows.title = { seq: 2, ver: 1, val: opts.title }
    if (opts.totals) rows.tokenUsage = { seq: 3, ver: 1, val: { totals: opts.totals } }
    if (opts.subagentMark) rows.subagent = { seq: 4, ver: 1, val: { identity: { mode: 'continuable', label: 'x' } } }
    writeFileSync(
      path.join(cacheDir, `${opts.dirName}.json`),
      JSON.stringify({ version: 1, record: { identity: { createdAt: opts.createdAt, cwd: opts.cwd }, rows } }),
    )
  }

  mkSession({
    dirName: 'session-parent',
    id: 'session-parent',
    cwd: dir,
    createdAt: 1_700_000_000_000,
    title: 'dsh 的标题',
    lastPromptAt: 1_700_000_100_000,
    totals: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 50 },
    events: [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: '<system-reminder>注入的</system-reminder>' }], source: { kind: 'user' } } },
      { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'plugin 注入' }], source: { kind: 'plugin' } } },
      { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: '最后一问' }], source: { kind: 'user' } } },
    ],
  })
  // 子代理：delegationDepth=1 + parentSession；用量要加回父会话，且自己不列
  mkSession({
    dirName: 'session-child',
    id: 'session-child',
    cwd: dir,
    createdAt: 1_700_000_050_000,
    depth: 1,
    parent: 'session-parent',
    totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 0 },
    subagentMark: true,
  })

  const adapter = new DshAdapter({ dshHome, appDirs: [path.join(dir, 'fake-apps-dsh')] })
  assert.equal((await adapter.detect()).installed, false) // 没装 app → 静默禁用

  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '子代理会话不能进列表')
  assert.equal(list[0]?.sessionId, 'session-parent')
  assert.equal(list[0]?.name, 'dsh 的标题')
  assert.equal(list[0]?.cwd, dir)
  assert.equal(list[0]?.lastUsedAt, 1_700_000_100_000)
  // 列表只读开头若干帧（不解整份正文）：首条用户消息能拿到，注入消息不会冒充
  assert.equal(list[0]?.firstMessage, '第一问')

  // describe 才解压：注入消息（system-reminder / plugin）都不算用户输入
  const info = await adapter.describeSession(newCliSessionId('session-parent'))
  assert.equal(info?.firstMessage, '第一问')
  assert.equal(info?.lastMessage, '最后一问')
  assert.equal(info?.resumable, false)

  // 用量 = 父 + 子（父 6250 tokens：1000+200+5000+50；子 35：10+5+20+0）
  const usage = await adapter.computeUsage(newCliSessionId('session-parent'))
  assert.equal(usage?.tokens.input, 1010)
  assert.equal(usage?.tokens.output, 205)
  assert.equal(usage?.tokens.cacheRead, 5020)
  assert.equal(usage?.tokens.cacheWrite, 50)

  await assert.rejects(() => adapter.resume(newCliSessionId('session-parent'), { promptText: '', cwd: dir, sessionId: newCliSessionId('session-parent'), deliver: 'none' }))
  assert.equal(adapter.capabilities.resumeSession, false)
})

// ---- dsh 补齐：未压缩会话、多世代取最新、列表里的首条消息与模型 ----
await check('dsh: 未压缩 session.jsonl、.vN 世代取最新、列表带首条消息、usage 带模型', async () => {
  const dshHome = path.join(dir, 'dsh-home2')
  const project = path.join(dshHome, 'sessions', '--tmp-x--')
  const plainDir = path.join(project, 'plain-session')
  const genDir = path.join(project, 'gen-session')
  mkdirSync(plainDir, { recursive: true })
  mkdirSync(genDir, { recursive: true })
  const cacheDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })

  const header = (id: string) =>
    JSON.stringify({ type: 'session', version: 0, id, createdAt: 1_700_000_000_000, cwd: dir, delegationDepth: 0 })
  const userMsg = (text: string) =>
    JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
  const assistant = (model: string, provider: string) =>
    JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: { message: { role: 'assistant', content: [], source: { kind: 'model', model, provider } }, usage: { inputTokens: 10, outputTokens: 2 } },
    })

  // ① 未压缩：header / 首条用户消息 / 模型都在明文 jsonl 里
  writeFileSync(path.join(plainDir, 'session.jsonl'), [header('plain-1'), userMsg('未压缩会话的第一问'), assistant('deepseek-chat', 'deepseek')].join('\n') + '\n')
  writeFileSync(path.join(cacheDir, 'plain-session.json'), JSON.stringify({ version: 1, record: { identity: { createdAt: 1, cwd: dir }, rows: { title: { val: '明文标题' } } } }))

  // ② 多世代：老世代是明文、新世代是压缩且 v2 → 必须读 v2 的 header
  writeFileSync(path.join(genDir, 'session.jsonl'), header('old-gen') + '\n')
  writeFileSync(
    path.join(genDir, 'session.v2.jsonl.zstd'),
    Buffer.concat([
      zstdCompressSync(Buffer.from(header('new-gen') + '\n')),
      zstdCompressSync(Buffer.from([userMsg('新世代的第一问'), assistant('deepseek-reasoner', 'deepseek')].join('\n') + '\n')),
    ]),
  )

  const adapter = new DshAdapter({ dshHome, appDirs: [path.join(dir, 'fake-apps-dsh2')] })
  const list = await adapter.listSessionInfos()
  const plain = list.find((s) => s.sessionId === 'plain-1')
  assert.ok(plain, JSON.stringify(list.map((s) => s.sessionId)))
  assert.equal(plain?.name, '明文标题')
  assert.equal(plain?.firstMessage, '未压缩会话的第一问')
  const gen = list.find((s) => s.sessionId === 'new-gen')
  assert.ok(gen, '必须取最新世代 session.v2 的 header，而不是老的 session.jsonl')
  assert.equal(gen?.firstMessage, '新世代的第一问')
  assert.equal(list.some((s) => s.sessionId === 'old-gen'), false)

  const usage = await adapter.computeUsage(newCliSessionId('new-gen'))
  assert.equal(usage?.byModel[0]?.model, 'deepseek-reasoner')
  assert.equal(usage?.byModel[0]?.provider, 'deepseek')
  // 没有投影缓存 → 用量退回正文口径（10 input / 2 output）
  assert.equal(usage?.tokens.input, 10)
  assert.equal(usage?.tokens.output, 2)
})

// ---- 交叉评审发现的回归（omp 幽灵会话 / opencode·zcode 注入与子代理用量 / kimi 时间 / CD 登录） ----
await check('omp: 会话目录里的子代理 transcript 不能当会话列出来', async () => {
  const agentDir = path.join(dir, 'omp-agent2')
  const cwdDir = path.join(agentDir, 'sessions', '-Users-x-proj')
  const realId = '019f3133-222d-7000-a63e-e1ac243ff575'
  const sessionDir = path.join(cwdDir, `2026-07-05T07-34-22-509Z_${realId}`)
  mkdirSync(sessionDir, { recursive: true })
  const header = { type: 'session', version: 3, id: realId, timestamp: '2026-07-05T07:34:22.509Z', cwd: dir }
  writeFileSync(path.join(cwdDir, `2026-07-05T07-34-22-509Z_${realId}.jsonl`), [
    { type: 'title', title: '真实会话' },
    header,
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '真问题' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  // 子代理 transcript：没有 `<ts>_<uuid>` 前缀，不能算会话（本机实测 109 个这种文件被误列）
  writeFileSync(path.join(sessionDir, 'ExploreUsageCode.jsonl'), JSON.stringify({ type: 'title', title: '子代理' }) + '\n')
  const adapter = new OmpAdapter({ agentDir, resolveExe: async () => '/fake/omp' })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, JSON.stringify(list.map((s) => s.sessionId)))
  assert.equal(list[0]?.sessionId, realId)
})

await check('opencode: 注入的 user text 被过滤 + 子代理用量加回父会话', async () => {
  const dbPath = path.join(dir, 'oc-inject.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('root', null, dir, '根会话', 1, 9, null, null, 0, 100, 10, 0, 0, 0)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('child', 'root', dir, '子会话', 1, 9, null, null, 0, 50, 5, 0, 0, 0)
  const msg = db.prepare('insert into message values (?,?,?,?)')
  const part = db.prepare('insert into part values (?,?,?,?)')
  msg.run('m1', 'root', 1, JSON.stringify({ role: 'user' }))
  part.run('p1', 'm1', 1, JSON.stringify({ type: 'text', text: '<system-reminder>注入的规则</system-reminder>' }))
  msg.run('m2', 'root', 2, JSON.stringify({ role: 'user' }))
  part.run('p2', 'm2', 2, JSON.stringify({ type: 'text', text: '真正的问题' }))
  msg.run('m3', 'root', 3, JSON.stringify({ role: 'assistant' }))
  msg.run('m4', 'root', 4, JSON.stringify({ role: 'user' }))
  part.run('p4', 'm4', 4, JSON.stringify({ type: 'text', text: '最后一问' }))
  db.close()
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (id) => ['--session', id] },
    { resolveExe: async () => '/fake/opencode' },
  )
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '子代理会话不列')
  const info = await adapter.describeSession(newCliSessionId('root'))
  assert.equal(info?.firstMessage, '真正的问题', '首条必须是清洗后的用户文本，不是 system-reminder')
  assert.equal(info?.lastMessage, '最后一问')
  const usage = await adapter.computeUsage(newCliSessionId('root'))
  assert.equal(usage?.tokens.input, 150, '父 100 + 子 50')
  assert.equal(usage?.tokens.output, 15)
})

await check('zcode: 没有 model_usage 的会话回退 message.tokens；子代理用量也加回父', async () => {
  const dbPath = path.join(dir, 'zc-fallback.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
    create table model_usage (id text primary key, session_id text, model_id text, input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer, cache_creation_input_tokens integer);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('zroot', null, dir, 'ZCode 根', 1, 9, null)
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('zchild', 'zroot', dir, 'ZCode 子', 1, 9, null)
  db.prepare('insert into message values (?,?,?,?)').run('zm1', 'zroot', 1, JSON.stringify({ role: 'assistant', tokens: { input: 1000, output: 100, reasoning: 20, cache: { read: 300, write: 0 } } }))
  db.prepare('insert into message values (?,?,?,?)').run('zm2', 'zroot', 2, JSON.stringify({ role: 'user' }))
  db.prepare('insert into part values (?,?,?,?)').run('zp2', 'zm2', 2, JSON.stringify({ type: 'text', text: 'ZCode 的问题' }))
  // 子代理：有 model_usage（父没有）
  db.prepare('insert into model_usage values (?,?,?,?,?,?,?,?)').run('u1', 'zchild', 'zcode-pro', 50, 5, 0, 10, 0)
  db.close()
  const adapter = new ZCodeAdapter({ dbPath })
  const usage = await adapter.computeUsage(newCliSessionId('zroot'))
  assert.equal(usage?.tokens.input, 1050, 'message 兜底 1000 + 子代理 50')
  assert.equal(usage?.tokens.output, 125, '(100+20) + 子代理 5')
  assert.equal(usage?.tokens.cacheRead, 310)
  const info = await adapter.describeSession(newCliSessionId('zroot'))
  assert.equal(info?.lastMessage, 'ZCode 的问题')
})

await check('kimi: lastUsedAt 取 state.updatedAt 与 wire 最后事件的最大值', async () => {
  const kimiHome = path.join(dir, 'kimi-home2')
  const sid7 = 'session_22222222-3333-4444-8555-666666666666'
  const sdir = path.join(kimiHome, 'sessions', 'wd_x', sid7)
  mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true })
  writeFileSync(path.join(sdir, 'state.json'), JSON.stringify({ title: 't', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:10:00.000Z' }))
  writeFileSync(path.join(sdir, 'agents', 'main', 'wire.jsonl'), [
    { type: 'metadata', created_at: 1 },
    // 比 state.updatedAt（2026-10-01T00:10Z）更晚，才能验证「取最大值」
    { type: 'turn.prompt', time: 1791000000000, origin: { kind: 'user' }, input: [{ type: 'text', text: 'hi' }] },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  // 文件 mtime 是 lastUsedAt 的合法下界：设旧一点，才能断言「取到 wire 事件时间」
  const old = new Date('2026-09-01T00:00:00.000Z')
  utimesSync(path.join(sdir, 'agents', 'main', 'wire.jsonl'), old, old)
  utimesSync(sdir, old, old)
  utimesSync(path.join(sdir, 'state.json'), old, old)
  const adapter = new KimiAdapter({ kimiHome, resolveExe: async () => '/fake/kimi' })
  const list = await adapter.listSessionInfos()
  assert.equal(list[0]?.lastUsedAt, 1791000000000, '应取 wire 的最后事件时间（比 state.updatedAt 新）')
})

await check('claude-desktop: 只装了 Claude-3p（第三方网关模式）也算登录过', () => {
  const home2 = path.join(dir, 'cd3p-home')
  mkdirSync(path.join(home2, 'Library', 'Application Support', 'Claude-3p', 'claude-code-sessions', 'a', 'o'), { recursive: true })
  assert.equal(desktopLooksSignedIn(home2), true)
  assert.equal(desktopLooksSignedIn(path.join(dir, 'cd-empty-home')), false)
})

await check('qoder: 错误文案用本工具身份，不是「Claude Code」', async () => {
  const adapter = new QoderAdapter(QODER_DISTRO, {
    resolveExe: async () => '/fake/qodercli',
    sessionRoots: () => [],
  })
  await assert.rejects(
    () => adapter.resume(newCliSessionId(sid), { promptText: '', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }),
    (e: Error) => e.message.includes('qoder') && !e.message.includes('Claude Code'),
  )
})

// ---- CLI 的 prefill 形态：打开终端 + 文案进剪贴板（不预生成 id、不绑定、不自动发送） ----
await check('CLI prefill：codex/cline/grok/omp/kimi/opencode 都只打开工具并把文案放进剪贴板', async () => {
  const { CodexAdapter: Cx } = await import('../packages/ai/codex/src/index.ts')
  const { ClineAdapter: Cl } = await import('../packages/ai/cline/src/index.ts')
  const { GrokAdapter: Gk } = await import('../packages/ai/grok/src/index.ts')
  const { OmpAdapter: Op } = await import('../packages/ai/omp/src/index.ts')
  const { KimiAdapter: Km } = await import('../packages/ai/kimi/src/index.ts')
  const { OpenCodeAdapter: Oc } = await import('../packages/ai/opencode/src/index.ts')

  const cases = [
    { name: 'codex', make: (deps: never) => new Cx(deps) },
    { name: 'cline', make: (deps: never) => new Cl(deps) },
    { name: 'grok', make: (deps: never) => new Gk(deps) },
    { name: 'omp', make: (deps: never) => new Op(deps) },
    { name: 'kimi', make: (deps: never) => new Km(deps) },
  ] as const

  for (const { name, make } of cases) {
    let spec: { cwd: string; executable: string; args: string[] } | undefined
    const clips: string[] = []
    const adapter = make({
      resolveExe: async () => `/fake/${name}`,
      openTerminal: (s) => {
        spec = s as never
      },
      clipboardWrite: (t: string) => clips.push(t),
    } as never)
    assert.equal(adapter.capabilities.newSessionMode, 'prefill', `${name} 应为 prefill`)
    assert.equal(adapter.capabilities.prefillDelivery, 'terminal-copy', `${name} 应为 terminal-copy`)
    const out = await adapter.openNewSessionPage({ promptText: `${name} 的文案`, cwd: dir })
    assert.equal(out.ok, true, `${name} 应成功`)
    assert.ok(spec, `${name} 必须打开终端`)
    assert.deepEqual(spec?.args, [], `${name} 不能带启动参数（那会立刻发送）`)
    assert.equal(spec?.cwd, dir)
    assert.deepEqual(clips, [`${name} 的文案`], `${name} 文案应进剪贴板`)
    assert.ok(out.notice?.includes('⌘V'), `${name} 的 notice 必须说明要手动粘贴`)
    // 不预生成 id、不绑定：launch 仍然不能用作「新建并绑定」
    await assert.rejects(() => adapter.launch({ promptText: 'x', cwd: dir, sessionId: newCliSessionId(sid), deliver: 'none' }))
  }

  // qoder / qoder-cn：共享 Claude 内核，但新建页走 terminal-copy
  {
    const { QoderAdapter: Qd, QODER_DISTRO: Distro } = await import('../packages/ai/qoder/src/index.ts')
    let spec: { executable: string; args: string[] } | undefined
    const clips: string[] = []
    const q = new Qd(Distro, {
      resolveExe: async () => '/fake/qodercli',
      openTerminal: (sp) => { spec = sp as never },
      clipboardWrite: (t) => clips.push(t),
      sessionRoots: () => [],
    })
    assert.equal(q.capabilities.newSessionMode, 'prefill')
    assert.equal(q.capabilities.prefillDelivery, 'terminal-copy')
    const out = await q.openNewSessionPage({ promptText: 'qoder 文案', cwd: dir })
    // 旧断言 `out.ok === false ? out.reason : true` 恒真（qoder 曾直接 findCliExecutable 绕过注入）；
    // 现在 qoder 复用注入的 resolveExe → 可以真断言 terminal-copy 三件事
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(spec?.executable, '/fake/qodercli', 'openNewSessionPage 必须复用注入的 resolveExe')
    assert.deepEqual(spec?.args, [], '不能带启动参数（会立刻发送）')
    assert.deepEqual(clips, ['qoder 文案'])
    assert.ok(out.notice?.includes('⌘V'), out.notice)
  }

  // opencode 也一样（它的 adapter 需要 identity）
  let ocSpec: { args: string[] } | undefined
  const ocClips: string[] = []
  const oc = new Oc(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath: path.join(dir, 'oc-none.db'), usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    { resolveExe: async () => '/fake/opencode', openTerminal: (s) => { ocSpec = s as never }, clipboardWrite: (t) => ocClips.push(t) },
  )
  assert.equal(oc.capabilities.newSessionMode, 'prefill')
  const ocOut = await oc.openNewSessionPage({ promptText: 'OC 文案', cwd: dir })
  assert.equal(ocOut.ok, true)
  assert.deepEqual(ocSpec?.args, [])
  assert.deepEqual(ocClips, ['OC 文案'])

  // 共享实现（core TerminalCopyDeps）的两个共有缺陷：
  // ① cwd 是「同名文件」不是目录 → 必须失败（旧实现只判 existsSync 会放过）
  {
    const notDir = path.join(dir, 'cli-prefill-file')
    writeFileSync(notDir, 'x')
    const cx = new Cx({ resolveExe: async () => '/fake/codex', openTerminal: () => undefined } as never)
    const out = await cx.openNewSessionPage({ promptText: 'x', cwd: notDir })
    assert.equal(out.ok, false)
    assert.equal(out.reason, '项目路径不存在或不是目录')
  }
  // ② 剪贴板抛错 / 没注入 → 终端照开，但 notice 不能宣称「已复制」
  {
    let spec: { executable: string } | undefined
    const cx = new Cx({
      resolveExe: async () => '/fake/codex',
      openTerminal: (s: { executable: string }) => { spec = s },
      clipboardWrite: () => { throw new Error('clipboard 不可用') },
    } as never)
    const out = await cx.openNewSessionPage({ promptText: 'x', cwd: dir })
    assert.equal(out.ok, true)
    assert.ok(spec, '终端仍应打开')
    assert.ok(!out.notice?.includes('已复制'), `notice 不能宣称已复制：${out.notice}`)
    const noClip = await new Cx({ resolveExe: async () => '/fake/codex', openTerminal: () => undefined } as never)
      .openNewSessionPage({ promptText: 'x', cwd: dir })
    assert.ok(!noClip.notice?.includes('已复制'), '未注入 clipboardWrite 时同样不能宣称已复制')
  }
})

// ---- OpenCode Desktop：共用同一份 DB，且自带 CLI 在 ~/.opencode/bin（不拆适配器） ----
await check('opencode: 桌面端自带的 CLI（~/.opencode/bin/<exe>）在 PATH 无命中时被回落到', async () => {
  const home = path.join(dir, 'oc-desktop-home')
  const binDir = path.join(home, '.opencode', 'bin')
  mkdirSync(binDir, { recursive: true })
  const bin = path.join(binDir, 'opencode')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  // 1) 路径规则 + 可执行判定（复用 probe-exe 的口径：0644 不算）
  assert.equal(desktopBundledExe(home, 'opencode'), bin)
  assert.equal(isExecutableFile(bin), true)
  writeFileSync(path.join(binDir, 'opencode-plain'), 'x', { mode: 0o644 })
  assert.equal(isExecutableFile(path.join(binDir, 'opencode-plain')), false)

  // 2) 适配器：注入「PATH/常见前缀/登录 shell 都找不到」→ 回落到 ~/.opencode/bin
  let spec: { executable?: string; args?: string[] } | undefined
  const identity = {
    toolId: 'opencode',
    displayName: 'OpenCode',
    dbPath: path.join(dir, 'oc-desktop.db'),
    usageSource: 'session-row' as const,
    exeName: 'opencode',
    resumeArgs: (i: string) => ['--session', i],
  }
  const adapter = new OpenCodeAdapter(identity, {
    home,
    findExe: async () => null,
    openTerminal: (sp) => { spec = sp as never },
    clipboardWrite: () => undefined,
  })
  assert.equal((await adapter.detect()).installed, true, '找到桌面端自带 CLI 即算已安装')
  const out = await adapter.openNewSessionPage({ promptText: 'x', cwd: dir })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(spec?.executable, bin)
  assert.deepEqual(spec?.args, [])

  // 3) 两个位置都没有 → 如实报未安装（不拿数据目录冒充安装）
  const missing = new OpenCodeAdapter({ ...identity, dbPath: path.join(dir, 'oc-none.db') }, {
    home: path.join(dir, 'oc-empty-home'),
    findExe: async () => null,
  })
  assert.equal((await missing.detect()).installed, false)
})

// ---- OpenCode：只有桌面版时也算已安装（同一份 DB），但没有 CLI 就不能按会话打开 ----
await check('opencode: 只有桌面 App（ai.opencode.desktop）时 detect=true，resume/prefill 给可读原因', async () => {
  const home = path.join(dir, 'oc-desktop-only-home')
  mkdirSync(home, { recursive: true })
  const appDir = path.join(dir, 'oc-fake-apps')
  const bundle = path.join(appDir, 'OpenCode.app', 'Contents')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.opencode.desktop</string></dict></plist>',
  )
  const identity = {
    toolId: 'opencode',
    displayName: 'OpenCode',
    dbPath: path.join(dir, 'oc-desktop-only.db'),
    usageSource: 'session-row' as const,
    exeName: 'opencode',
    resumeArgs: (i: string) => ['--session', i],
    desktopBundleId: 'ai.opencode.desktop',
    desktopBundleName: 'OpenCode.app',
  }
  const adapter = new OpenCodeAdapter(identity, {
    home,
    appDirs: [appDir],
    findExe: async () => null,
    clipboardWrite: () => undefined,
  })
  assert.equal((await adapter.detect()).installed, true, '有桌面 App 就算已安装（数据可读）')
  // 没有 CLI 时走 CLI 分支 → 给出可读原因（并提示可改用「桌面版」入口）
  const out = await adapter.openNewSessionPage({ promptText: 'x', cwd: dir })
  assert.equal(out.ok, false)
  assert.ok(out.reason?.includes('请在上面选「桌面版」'), out.reason)
  await assert.rejects(
    () => adapter.resume(newCliSessionId('ses_x') as never, {
      promptText: '', cwd: dir, sessionId: newCliSessionId('ses_x'), deliver: 'none', client: 'cli',
    }),
    (e: Error) => e.message.includes('桌面版只能打开应用'),
  )

  // 既没有 CLI 也没有桌面 App → 如实未安装
  const none = new OpenCodeAdapter({ ...identity, desktopBundleId: undefined, desktopBundleName: undefined }, {
    home,
    appDirs: [path.join(dir, 'no-apps')],
    findExe: async () => null,
  })
  assert.equal((await none.detect()).installed, false)
})

// ---- OpenCode 多客户端：桌面版只「激活 App + 剪贴板」，CLI 才精确定位 ----
await check('opencode: clients=desktop/cli；桌面版激活 App + 复制文案，resume 只开 App（如实说明）', async () => {
  const home = path.join(dir, 'oc-clients-home')
  mkdirSync(home, { recursive: true })
  const appDir = path.join(dir, 'oc-clients-apps')
  const bundle = path.join(appDir, 'OpenCode.app', 'Contents')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.opencode.desktop</string></dict></plist>',
  )
  // 一条真实形状的会话行，供 resume 读标题
  const dbPath = path.join(dir, 'oc-clients.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'ses_desktop', null, dir, '桌面里的会话', 1000, 2000, null, null, 0, 1, 1, 0, 0, 0,
  )
  db.close()

  const activations: string[] = []
  const clips: string[] = []
  let terminal: { executable?: string; args?: string[] } | undefined
  const adapter = new OpenCodeAdapter(
    {
      toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row',
      exeName: 'opencode', resumeArgs: (id) => ['--session', id],
      desktopBundleId: 'ai.opencode.desktop', desktopBundleName: 'OpenCode.app',
    },
    {
      home, appDirs: [appDir],
      resolveExe: async () => '/fake/opencode',
      openTerminal: (spec) => { terminal = spec as never },
      activateApp: (app) => { activations.push(app) },
      clipboardWrite: (t) => { clips.push(t) },
    },
  )
  assert.deepEqual(adapter.capabilities.clients, ['desktop', 'cli'])

  // 桌面版新建：激活 App + 文案进剪贴板（不发深链接、不假装预填）
  const ok = await adapter.openNewSessionPage({ promptText: '你好 world', cwd: dir, client: 'desktop' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(activations.length, 1)
  assert.ok(activations[0]?.endsWith('/OpenCode.app'), activations[0])
  assert.deepEqual(clips, ['你好 world'])
  assert.ok(ok.notice?.includes('⌘V'), ok.notice)

  // 项目路径不存在 → 不开 App
  const bad = await adapter.openNewSessionPage({ promptText: 'x', cwd: path.join(dir, 'nope'), client: 'desktop' })
  assert.equal(bad.ok, false)
  assert.equal(activations.length, 1)

  // resume 桌面版：打开 App，说明不能定位，并带上会话标题
  const resumed = await adapter.resume(newCliSessionId('ses_desktop') as never, {
    promptText: '', cwd: dir, sessionId: newCliSessionId('ses_desktop'), deliver: 'none', client: 'desktop',
  })
  assert.equal(activations.length, 2)
  assert.equal(resumed.delivered, 'none')
  assert.ok(resumed.notice?.includes('桌面里的会话'), resumed.notice)

  // resume CLI：仍然精确 --session（不被桌面分支影响）
  await adapter.resume(newCliSessionId('ses_desktop') as never, {
    promptText: '', cwd: dir, sessionId: newCliSessionId('ses_desktop'), deliver: 'none', client: 'cli',
  })
  assert.deepEqual(terminal?.args, ['--session', 'ses_desktop'])
})

// ---- LaunchService：settings.toolClients 透传给 adapter（新建默认 desktop / 回到会话默认 cli） ----
await check('LaunchService: 多客户端偏好从 settings 透传，且按操作给不同缺省', async () => {
  const store = new TodoStore(path.join(dir, 'clients-todos.json'))
  store.ensureFile()
  const todo = store.create({ title: '多客户端' })
  const seen: Array<string | undefined> = []
  const adapter = {
    id: 'opencode',
    capabilities: {
      needsCwd: true, resumeSession: true, deliverPrompt: [], setSessionName: false,
      discoverProjects: false, describeSessions: false, usage: false,
      newSessionMode: 'prefill' as const, prefillDelivery: 'terminal-copy' as const,
      clients: ['desktop', 'cli'] as const,
    },
    detect: async () => ({ installed: true }),
    openNewSessionPage: async (ctx: { client?: string }) => {
      seen.push(ctx.client)
      return { ok: true as const, notice: 'opened' }
    },
    resume: async (_id: string, ctx: { client?: string }) => {
      seen.push(ctx.client)
      return { toolId: 'opencode', sessionId: _id, cwd: dir, delivered: 'none' as const, verified: true }
    },
    listSessionInfos: async () => [],
    // 有会话信息才会走到 adapter.resume（否则会被当成 pending 会话 fail-closed）
    describeSession: async (id: string) => ({ sessionId: id, cwd: dir } as never),
  }
  const mk = (toolClients?: Record<string, 'desktop' | 'cli'>) =>
    new LaunchService([adapter as never], store, {
      settings: () => ({ ...DEFAULT_SETTINGS, ...(toolClients ? { toolClients } : {}) }),
    })

  // 没有偏好：新建默认 desktop，回到会话默认 cli（能精确定位）
  await mk().prefillNewSession({ todoId: todo.id, toolId: 'opencode', projectPath: dir })
  await mk().resume({ sessionId: sid, toolId: 'opencode', projectPath: dir })
  assert.deepEqual(seen, ['desktop', 'cli'])

  // 设置里的偏好对两者都生效
  seen.length = 0
  await mk({ opencode: 'cli' }).prefillNewSession({ todoId: todo.id, toolId: 'opencode', projectPath: dir })
  await mk({ opencode: 'cli' }).resume({ sessionId: sid, toolId: 'opencode', projectPath: dir })
  assert.deepEqual(seen, ['cli', 'cli'])

  // 显式请求优先于设置
  seen.length = 0
  await mk({ opencode: 'cli' }).prefillNewSession({ todoId: todo.id, toolId: 'opencode', projectPath: dir, client: 'desktop' })
  assert.deepEqual(seen, ['desktop'])

  // 失败文案：terminal-copy 的 CLI 没有 GUI「新建页」，必须是「打开 X 失败」
  const throwAdapter = { ...adapter, openNewSessionPage: async () => { throw new Error('boom') } }
  const failedOut = await new LaunchService([throwAdapter as never], store, { settings: () => DEFAULT_SETTINGS })
    .prefillNewSession({ todoId: todo.id, toolId: 'opencode', projectPath: dir })
  assert.equal(failedOut.ok, false)
  assert.ok(
    failedOut.reason?.startsWith('打开 OpenCode 失败：boom'),
    `terminal-copy 的失败文案不该出现「新建页」：${failedOut.reason}`,
  )

  // 非 launch 工具误走 launch：兜底文案要同时覆盖「打开新建页 / 打开并复制文案」两形态
  const wrong = await new LaunchService([adapter as never], store, { settings: () => DEFAULT_SETTINGS })
    .launch({ todoId: todo.id, toolId: 'opencode', deliver: 'prefill' })
  assert.equal(wrong.ok, false)
  assert.ok(wrong.reason?.includes('打开并复制文案'), `实际：${wrong.reason}`)
})

// ---- settings：多客户端偏好 ----
await check('settings: toolClients 只收 desktop/cli，整表替换并落盘；非法值丢弃', () => {
  const file = path.join(dir, 'settings-clients.json')
  const store = new SettingsStore(file)
  const saved = store.update({ toolClients: { opencode: 'cli', junk: 'x' as never } })
  assert.equal(saved.toolClients?.opencode, 'cli')
  assert.equal(saved.toolClients?.junk, undefined)
  assert.equal(new SettingsStore(file).get().toolClients?.opencode, 'cli', '必须落盘')
  // 整表替换：清空后文件里也不残留
  assert.equal(store.update({ toolClients: {} }).toolClients, undefined)
  assert.equal(new SettingsStore(file).get().toolClients, undefined)
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
await check('LaunchService blocks uninstalled tool and keeps notice', async () => {
  const store = new TodoStore(path.join(dir, 'launch-todos.json'))
  store.ensureFile()
  const todo = store.create({ title: 't' })
  const caps = { needsCwd: true, resumeSession: true, deliverPrompt: ['prefill', 'argv', 'clipboard'], setSessionName: true, discoverProjects: false, describeSessions: false, usage: false, newSessionMode: 'launch' as const }
  let launched = false
  const missingAdapter = {
    id: 'pi', capabilities: caps,
    detect: async () => ({ installed: false, reason: 'not installed' }),
    launch: async () => { launched = true; throw new Error('must not') },
    resume: async () => { throw new Error('no') },
  }
  const svc = new LaunchService([missingAdapter as never], store, { settings: () => DEFAULT_SETTINGS })
  const r = await svc.launch({ todoId: todo.id, deliver: 'prefill' })
  assert.equal(r.ok, false)
  assert.ok(r.reason?.includes('not installed'))
  assert.equal(launched, false)

  const goodAdapter = {
    id: 'pi', capabilities: caps,
    detect: async () => ({ installed: true }),
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


// ============================================================
// 第二轮修复回归 —— claude / claude-desktop / session-locators
// ============================================================

// ---- [P1-2] 记录有 cliSessionId 但 home 全 miss：不得拿 mtime 最新正文顶替 ----
await check('claude-desktop: 记录有 cliSessionId 但 home 全 miss → 不拿 home 最新正文顶替', async () => {
  const home = path.join(dir, 'cd-p1-home')
  const appDir2 = path.join(dir, 'cd-p1-apps')
  mkdirSync(path.join(appDir2, 'Claude.app', 'Contents'), { recursive: true })
  writeFileSync(
    path.join(appDir2, 'Claude.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>',
  )
  const recordsDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org')
  mkdirSync(recordsDir, { recursive: true })
  const localA = 'local_aaaaaaaa-1111-4111-8111-111111111111'
  const localB = 'local_bbbbbbbb-2222-4222-8222-222222222222'
  const cliA = 'aaaaaaaa-1111-4111-8111-111111111111'
  const cliB = 'bbbbbbbb-2222-4222-8222-222222222222' // home 里唯一的正文，但属于 B 会话
  const cliC = 'cccccccc-3333-4333-8333-333333333333'

  // 记录 A：明确记着 cliA，但 home 里只有 cliB 的正文（A 的正文被 Desktop 清理了）
  const homeA = path.join(recordsDir, localA, '.claude', 'projects', '-tmp-proj')
  mkdirSync(homeA, { recursive: true })
  writeClaudeSession(path.join(homeA, `${cliB}.jsonl`), cliB, { entrypoint: 'claude-desktop' })
  writeFileSync(
    path.join(recordsDir, `${localA}.json`),
    JSON.stringify({ sessionId: localA, cliSessionId: cliA, cwd: claudeCwd }),
  )

  // 记录 B：完全没记 CLI id（Desktop 原生会话）→ 仍允许 home 里 latest 兜底
  const homeB = path.join(recordsDir, localB, '.claude', 'projects', '-tmp-proj')
  mkdirSync(homeB, { recursive: true })
  writeClaudeSession(path.join(homeB, `${cliC}.jsonl`), cliC, { entrypoint: 'claude-desktop' })
  writeFileSync(path.join(recordsDir, `${localB}.json`), JSON.stringify({ sessionId: localB, cwd: claudeCwd }))

  const adapter = new ClaudeDesktopAdapter({
    appDirs: [appDir2],
    home,
    sessionRoots: () => [{ dir: path.join(dir, 'cd-p1-empty-projects'), source: 'default' }],
    openUrl: () => undefined,
  })
  const list = await adapter.listSessionInfos()
  // 只有 B 出现；A 不得挂着 cliB 的正文被列出来
  assert.deepEqual(list.map((s) => s.sessionId), [localB])
  assert.equal(list[0]?.firstMessage, 'real first ask')
  assert.equal(await adapter.describeSession(newCliSessionId(localA)), undefined)
  assert.equal(await adapter.computeUsage(newCliSessionId(localA)), undefined)
  assert.ok((await adapter.describeSession(newCliSessionId(localB)))?.firstMessage)
})

// ---- [P2] claude：>8MB 会话补读尾部（晚到的 /rename 标题与最后一条 user） ----
await check('claude: >8MB 会话补读尾部（晚到的 title 与最后一条 user）', async () => {
  const projects = path.join(dir, 'claude-big-projects')
  const proj = path.join(projects, 'p')
  mkdirSync(proj, { recursive: true })
  const sidBig = '99999999-1111-4222-8333-444444444444'
  const file = path.join(proj, `${sidBig}.jsonl`)
  writeFileSync(
    file,
    [
      { type: 'ai-title', aiTitle: 'auto title', sessionId: sidBig },
      { type: 'user', message: { role: 'user', content: 'first question' }, sessionId: sidBig, cwd: claudeCwd, timestamp: '2026-10-20T00:00:00.000Z' },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )
  const filler = JSON.stringify({ type: 'api-request-blob', data: 'x'.repeat(4096) }) + '\n'
  for (let i = 0; i < 8; i++) appendFileSync(file, filler.repeat(256)) // 头部 > 8MB
  appendFileSync(
    file,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'LAST QUESTION AFTER 8MB' }, sessionId: sidBig, cwd: claudeCwd, timestamp: '2026-10-20T09:00:00.000Z' }) + '\n',
  )
  appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'renamed late', sessionId: sidBig }) + '\n')

  const adapter = new ClaudeAdapter({
    resolveExe: async () => '/fake/claude',
    sessionRoots: () => [{ dir: projects, source: 'default' }],
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list[0]?.name, 'renamed late') // 尾部的 rename 必须赢过头部的 ai-title
  assert.equal(list[0]?.firstMessage, 'first question') // 首条仍来自头部
  const info = await adapter.describeSession(sidBig)
  assert.equal(info?.lastMessage, 'LAST QUESTION AFTER 8MB') // 时间线「上次停在哪」

  // withName:false 必须扫到 cwd 即停：不补尾读
  const bare = await adapter.describeSession(sidBig, { withName: false })
  assert.equal(bare?.cwd, claudeCwd)
  assert.equal(bare?.lastMessage, undefined)
  const light = await readSessionMeta(file, { stopAfterCwd: true })
  assert.equal(light.cwd, claudeCwd)
  assert.notEqual(light.lastUserText, 'LAST QUESTION AFTER 8MB')
})

// ---- [P2] claude：detect 门控 + 缺 cwd 不再虚假归属到 ~ ----
await check('claude: 未安装时 list/discover/describe/usage 静默禁用（detect 门控）', async () => {
  const adapter = new ClaudeAdapter({
    resolveExe: async () => null,
    sessionRoots: () => [{ dir: path.join(claudeHome, '.claude', 'projects'), source: 'default' }],
  })
  assert.equal((await adapter.detect()).installed, false)
  assert.deepEqual(await adapter.listSessionInfos(), [])
  assert.deepEqual(await adapter.listSessions(), [])
  assert.deepEqual(await adapter.discoverProjects(), [])
  assert.equal(await adapter.describeSession(claudeSid), undefined)
  assert.equal(await adapter.computeUsage(claudeSid), undefined)
})

await check('claude: 记录里没有 cwd 时 cwd 给空串（不虚假归属到 ~）', async () => {
  const projects = path.join(dir, 'claude-nocwd-projects')
  const proj = path.join(projects, 'p')
  mkdirSync(proj, { recursive: true })
  const sidNoCwd = '12121212-1111-4222-8333-444444444444'
  writeFileSync(
    path.join(proj, `${sidNoCwd}.jsonl`),
    [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: sidNoCwd })].join('\n') + '\n',
  )
  const adapter = new ClaudeAdapter({
    resolveExe: async () => '/fake/claude',
    sessionRoots: () => [{ dir: projects, source: 'default' }],
  })
  const list = await adapter.listSessionInfos()
  assert.equal(list[0]?.cwd, '')
  assert.deepEqual(await adapter.discoverProjects(), []) // 缺 cwd 不贡献项目证据
})

// ---- [P2] claude-desktop：discoverProjects 按正文去重 + canonicalPath ----
await check('claude-desktop: discoverProjects 按正文去重（同一 cwd 不重复计数）', async () => {
  const home = path.join(dir, 'cd-dedupe-home')
  const appDir3 = path.join(dir, 'cd-dedupe-apps')
  mkdirSync(path.join(appDir3, 'Claude.app', 'Contents'), { recursive: true })
  writeFileSync(
    path.join(appDir3, 'Claude.app', 'Contents', 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string></dict></plist>',
  )
  const recordsDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org')
  mkdirSync(recordsDir, { recursive: true })
  const localD = 'local_dddddddd-1111-4111-8111-111111111111'
  const cliAdopted = 'dddddddd-1111-4111-8111-111111111111'
  const cliPlain = 'eeeeeeee-2222-4222-8222-222222222222'
  const projects = path.join(dir, 'cd-dedupe-projects')
  const proj = path.join(projects, 'p')
  mkdirSync(proj, { recursive: true })
  // 全局 store：被 adopt 的正文（entrypoint=claude-desktop）+ 一条纯 CLI 会话（不该被 desktop 计）
  writeClaudeSession(path.join(proj, `${cliAdopted}.jsonl`), cliAdopted, { entrypoint: 'claude-desktop' })
  writeClaudeSession(path.join(proj, `${cliPlain}.jsonl`), cliPlain, { entrypoint: 'cli' })
  // 记录 cliSessionId 指向同一条正文、home 无正文 → 旧实现会「记录 1 + reader 1 = 2」
  writeFileSync(
    path.join(recordsDir, `${localD}.json`),
    JSON.stringify({ sessionId: localD, cliSessionId: cliAdopted, cwd: claudeCwd, lastActivityAt: Date.now() }),
  )
  const adapter = new ClaudeDesktopAdapter({
    appDirs: [appDir3],
    home,
    sessionRoots: () => [{ dir: projects, source: 'default' }],
    openUrl: () => undefined,
  })
  const out = await adapter.discoverProjects()
  const entry = out.find((p) => p.path === canonicalPath(claudeCwd))
  assert.equal(entry?.sessionCount, 1, JSON.stringify(out))
  // 与列表口径一致
  assert.equal(entry?.sessionCount, (await adapter.listSessionInfos()).length)
})

// ---- [P3] buildNewSessionUrl：folder 本身超长时如实失败 ----
await check('claude-desktop: cwd 超长导致 URL 无法压到安全长度时返回 overLimit', () => {
  const out = buildNewSessionUrl('hi', `/tmp/${'x'.repeat(20000)}`)
  assert.equal(out.overLimit, true)
  assert.ok(out.url.length > DESKTOP_URL_MAX)
  const normal = buildNewSessionUrl('hi', claudeCwd)
  assert.equal(normal.overLimit, undefined)
  assert.equal(normal.truncated, false)
})

// ---- [P2/P3] MCP locator：全局 store 里的 Desktop 正文选 local_ id、resumeSpec 给绝对路径 ----
await check('session-locators: Desktop 正文在全局 store 时选 local_ id；claude resumeSpec 给绝对路径', async () => {
  const home = path.join(dir, 'locator-home')
  const recordsDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org')
  mkdirSync(recordsDir, { recursive: true })
  const localE = 'local_eeeeeeee-1111-4111-8111-111111111111'
  const cliDesktop = 'ffffffff-1111-4111-8111-111111111111'
  const globalProjects = path.join(dir, 'locator-global-projects')
  const globalProj = path.join(globalProjects, 'p')
  mkdirSync(globalProj, { recursive: true })
  const desktopFile = path.join(globalProj, `${cliDesktop}.jsonl`)
  writeClaudeSession(desktopFile, cliDesktop, { entrypoint: 'claude-desktop-3p' })
  // 记录 home 里没有正文，只有 cliSessionId（本机实测形态：正文落在全局 store）
  writeFileSync(
    path.join(recordsDir, `${localE}.json`),
    JSON.stringify({ sessionId: localE, cliSessionId: cliDesktop, cwd: claudeCwd }),
  )
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'locator-claude-config') }
  const desktopLocator = createClaudeDesktopLocator({ home, env })
  const located = await desktopLocator.readSession(desktopFile)
  assert.equal(located?.sessionId, localE) // 与 adapter 列表口径一致（不再是 CLI uuid）
  const claudeLocator = createClaudeLocator({ home, env })
  assert.equal(await claudeLocator.readSession(desktopFile), undefined) // entrypoint 互斥

  // claude resumeSpec：绝对路径（不再给裸 id）；roots 不含该会话时返回 undefined
  const cliConfig = path.join(dir, 'locator-claude-config-2')
  const cliProj = path.join(cliConfig, 'projects', 'p')
  mkdirSync(cliProj, { recursive: true })
  const sidLoc = 'abababab-1111-4111-8111-111111111111'
  const cliFile = path.join(cliProj, `${sidLoc}.jsonl`)
  writeClaudeSession(cliFile, sidLoc, { entrypoint: 'cli' })
  const cliLocator2 = createClaudeLocator({ home, env: { ...process.env, CLAUDE_CONFIG_DIR: cliConfig } })
  const spec = cliLocator2.resumeSpec?.(sidLoc, claudeCwd)
  assert.equal(spec?.kind, 'terminal')
  assert.equal((spec as { target?: string }).target, cliFile)
  assert.deepEqual((spec as { args?: string[] }).args, ['--resume', cliFile])
  // 找不到正文时不编路径（裸 id 不再冒充可执行）
  assert.equal(cliLocator2.resumeSpec?.('cdcdcdcd-1111-4111-8111-111111111111', claudeCwd), undefined)
})


// ============================================================
// 第二轮修复回归 —— codex / cline / grok / core 纯函数
// ============================================================

// ---- [P1-1] codex：AGENTS.md 注入被过滤 + model_provider 进 usage + withName:false 快路径 + 归档 ----
await check('codex: AGENTS.md 注入被过滤、标题不再是 <INSTRUCTIONS>；model_provider 进 usage', async () => {
  const codexHome = path.join(dir, 'codex-agnets-home')
  const dayDir = path.join(codexHome, 'sessions', '2026', '10', '20')
  mkdirSync(dayDir, { recursive: true })
  const thread = '019d3945-7a00-0000-0000-6e79b2166942'
  const lines = [
    {
      timestamp: '2026-10-20T10:00:00.000Z',
      type: 'session_meta',
      payload: { session_id: thread, id: thread, cwd: dir, model_provider: 'oss' },
    },
    {
      timestamp: '2026-10-20T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${dir}\n\n<INSTRUCTIONS>\n# AGENTS.md\n\n注入正文` }],
      },
    },
    {
      timestamp: '2026-10-20T10:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实提问一' }] },
    },
    {
      timestamp: '2026-10-20T10:00:03.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实提问二' }] },
    },
    {
      timestamp: '2026-10-20T10:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 },
        },
      },
    },
  ]
  writeFileSync(
    path.join(dayDir, `rollout-2026-10-20T10-00-00-${thread}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  )

  // 归档会话：resumable 必须如实 false
  const archivedDir = path.join(codexHome, 'archived_sessions')
  mkdirSync(archivedDir, { recursive: true })
  const archivedId = '019d3945-7b00-0000-0000-000000000002'
  writeFileSync(
    path.join(archivedDir, `rollout-2026-10-19T10-00-00-${archivedId}.jsonl`),
    [
      { timestamp: '2026-10-19T10:00:00.000Z', type: 'session_meta', payload: { session_id: archivedId, cwd: dir } },
      {
        timestamp: '2026-10-19T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '归档会话的问题' }] },
      },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  )

  const adapter = new CodexAdapter({ codexHome, resolveExe: async () => '/fake/codex' })
  const list = await adapter.listSessionInfos()
  const mine = list.find((s) => s.sessionId === thread)
  assert.equal(mine?.firstMessage, '真实提问一') // 注入被过滤（SessionSummary 只有 firstMessage）
  assert.equal(mine?.resumable, true)
  const archived = list.find((s) => s.sessionId === archivedId)
  assert.equal(archived?.resumable, false, '归档会话不能当成可回到会话')

  const info = await adapter.describeSession(newCliSessionId(thread))
  assert.equal(info?.firstMessage, '真实提问一')
  assert.equal(info?.lastMessage, '真实提问二')

  // withName:false 只读 session_meta：给 cwd/时间，但不返回 name/first/lastMessage
  const fast = await adapter.describeSession(newCliSessionId(archivedId), { withName: false })
  assert.equal(fast?.cwd, dir)
  assert.equal(fast?.firstMessage, undefined)
  assert.equal(fast?.lastMessage, undefined)
  assert.equal(fast?.createdAt, '2026-10-19T10:00:00.000Z') // 来自 session_meta.timestamp（不是文件 mtime）
  assert.equal(fast?.resumable, false)

  const usage = await adapter.computeUsage(newCliSessionId(thread))
  assert.equal(usage?.tokens.input, 600) // 1000 - 400
  assert.equal(usage?.byModel[0]?.provider, 'oss', 'provider 必须来自 session_meta.model_provider')
})

// ---- [P2] codex：collectRollouts 按 mtime 取最近 N（不是 readdir 顺序） ----
await check('codex: collectRollouts 超上限时按 mtime 保留最近的文件', () => {
  const home = path.join(dir, 'codex-truncate-home')
  const dayDir = path.join(home, 'sessions', '2026', '10', '20')
  mkdirSync(dayDir, { recursive: true })
  const mk = (name: string, ageMs: number): void => {
    const file = path.join(dayDir, `rollout-2026-10-20T10-00-00-${name}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { session_id: name, cwd: dir } }) + '\n')
    const t = new Date(Date.now() - ageMs)
    utimesSync(file, t, t)
  }
  mk('019d3945-aaaa-0000-0000-00000000000a', 60_000)
  mk('019d3945-bbbb-0000-0000-00000000000b', 10_000) // 最新
  mk('019d3945-cccc-0000-0000-00000000000c', 120_000)
  const kept = collectRollouts(home, { maxFiles: 2 })
  assert.equal(kept.length, 2)
  assert.equal(kept[0]?.threadId, '019d3945-bbbb-0000-0000-00000000000b', '必须先按 mtime 排序再截断')
})

// ---- [P1-5] cline：列表流式只取首条合格 user；manifest 缺失与 NaN 时间降级 ----
await check('cline: manifest 缺失仍收会话、时间不产生 NaN、列表只取首条合格 user', async () => {
  const sdir = path.join(dir, 'cline-degrade-sessions')
  // 会话 A：没有 manifest（写盘竞态/被清）→ 会话仍要出现，cwd 退回 homedir
  const a = 'no-manifest'
  mkdirSync(path.join(sdir, a), { recursive: true })
  writeFileSync(
    path.join(sdir, a, `${a}.messages.json`),
    JSON.stringify({ messages: [{ role: 'user', content: '<user_input>只有一条</user_input>' }] }),
  )
  // 会话 B：manifest 的 ended_at 是坏值 → lastUsedAt 退回文件 mtime（不能是 NaN）
  const b = 'bad-time'
  mkdirSync(path.join(sdir, b), { recursive: true })
  writeFileSync(
    path.join(sdir, b, `${b}.json`),
    JSON.stringify({ cwd: dir, started_at: 'not-a-date', ended_at: 'not-a-date' }),
  )
  writeFileSync(
    path.join(sdir, b, `${b}.messages.json`),
    JSON.stringify({
      messages: [
        { role: 'user', content: '<system-reminder>注入</system-reminder>' },
        { role: 'user', content: '<user_input mode="act">真的问题</user_input>' },
        { role: 'assistant', content: '答', modelInfo: { id: 'm' }, metrics: { inputTokens: 10, outputTokens: 2 } },
      ],
    }),
  )
  const adapter = new ClineAdapter({ sessionDir: sdir, resolveExe: async () => '/fake/cline' })
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 2, 'manifest 缺失不能把会话丢掉')
  assert.equal(list.find((s) => s.sessionId === a)?.firstMessage, '只有一条')
  assert.equal(list.find((s) => s.sessionId === a)?.cwd, os.homedir())
  assert.equal(list.find((s) => s.sessionId === b)?.firstMessage, '真的问题') // 注入被跳过
  assert.ok(Number.isFinite(list.find((s) => s.sessionId === b)?.lastUsedAt), 'NaN 时间必须兜底')
  const usage = await adapter.computeUsage(newCliSessionId(b))
  assert.equal(usage?.tokens.input, 10)
  assert.equal(usage?.messageCount, 3)
})

// ---- [P2] grok：空会话（num_messages=0 且无 updates）不算会话/项目；根路径不贡献项目 ----
await check('grok: 空会话与根路径不进列表/项目，空会话如实 resumable=false', async () => {
  const grokHome = path.join(dir, 'grok-empty-home')
  const cwdDir = path.join(grokHome, 'sessions', '%2F')
  const emptyId = '01a04e68-0000-0000-0000-0000000000ee'
  const d = path.join(cwdDir, emptyId)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    path.join(d, 'summary.json'),
    JSON.stringify({ info: { id: emptyId, cwd: '/' }, session_summary: '', num_messages: 0, created_at: '2026-08-29T16:43:55Z' }),
  )

  const adapter = new GrokAdapter({
    grokHome,
    resolveExe: async () => '/fake/grok',
    openTerminal: () => undefined,
  })
  assert.equal((await adapter.listSessionInfos()).length, 0, '空会话不能进历史会话列表')
  assert.equal((await adapter.discoverProjects()).length, 0, '根路径不能贡献项目，空会话也不能')
  assert.equal((await adapter.listSessions()).length, 0)
  // 即使被直接问到（例如旧绑定），也要如实说不可回
  const info = await adapter.describeSession(newCliSessionId(emptyId), { withName: false })
  assert.equal(info?.resumable, false)
})

// ---- core：跨 adapter 共享的纯函数（toSessionTitle / 注入过滤 / cwd 校验） ----
await check('core: toSessionTitle 滤 # / ``` / <；注入过滤覆盖 AGENTS.md；isExistingDirectory 真判目录', () => {
  const injected = '# AGENTS.md instructions for /tmp/x\n\n<INSTRUCTIONS>\n# AGENTS.md\n\n正文'
  assert.equal(toSessionTitle(injected), '正文')
  assert.equal(toSessionTitle('# 标题\n```json\n{}\n真问题'), '{}')
  assert.equal(toSessionTitle('<environment_context>x</environment_context>\n真问题'), '真问题')
  assert.equal(isInjectedUserText('# AGENTS.md instructions for /a\n\n<INSTRUCTIONS>…'), true)
  assert.equal(isInjectedUserText('[Request interrupted by user]'), true)
  assert.equal(isInjectedUserText('Caveat: The messages below were generated'), true)
  assert.equal(isInjectedUserText('真问题'), false)
  assert.equal(realUserText('  真问题  '), '真问题')
  assert.equal(realUserText('<system>noise</system>'), undefined)

  const d = path.join(dir, 'core-dir')
  mkdirSync(d, { recursive: true })
  const f = path.join(dir, 'core-file')
  writeFileSync(f, 'x')
  assert.equal(isExistingDirectory(d), true)
  assert.equal(isExistingDirectory(f), false)
  assert.equal(isExistingDirectory('relative/path'), false)
})


// ============================================================
// 第二轮修复回归 —— app（LaunchService / export / detect 超时）
// ============================================================

// ---- [P1-4] LaunchService.resume 透传 adapter 的 notice（防「假装定位成功」） ----
await check('LaunchService: resume 透传 adapter notice（没有就不伪造）', async () => {
  const store = new TodoStore(path.join(dir, 'resume-notice-todos.json'))
  store.ensureFile()
  const todo = store.create({ title: '桌面入口' })
  const caps = {
    needsCwd: true, resumeSession: true, deliverPrompt: [], setSessionName: false,
    discoverProjects: false, describeSessions: false, usage: false, newSessionMode: 'prefill' as const,
  }
  const base = {
    id: 'opencode',
    capabilities: caps,
    detect: async () => ({ installed: true }),
    describeSession: async (id: string) => ({ sessionId: id, cwd: dir }),
  }
  const noticeText = '已打开 OpenCode 桌面版；它没有「按会话定位」的入口，请在会话列表里选择「某个标题」'
  const withNotice = {
    ...base,
    resume: async (id: string) => ({
      toolId: 'opencode', sessionId: newCliSessionId(id), cwd: dir,
      delivered: 'none' as const, verified: true, notice: noticeText,
    }),
  }
  const sessionId = newCliSessionId('aaaaaaaa-2222-4333-8444-555555555555')
  const out = await new LaunchService([withNotice as never], store, { settings: () => DEFAULT_SETTINGS })
    .resume({ todoId: todo.id, sessionId, toolId: 'opencode' })
  assert.equal(out.ok, true)
  assert.equal(out.notice, noticeText, 'adapter 的 notice 必须透传（否则 UI 会说假成功）')

  // 不带 notice 的 adapter：LaunchOutcome.notice 必须是 undefined（不能凭空补文案）
  const store2 = new TodoStore(path.join(dir, 'resume-notice-todos2.json'))
  store2.ensureFile()
  const todo2 = store2.create({ title: '普通 CLI' })
  const noNotice = {
    ...base,
    resume: async (id: string) => ({
      toolId: 'opencode', sessionId: newCliSessionId(id), cwd: dir, delivered: 'none' as const, verified: true,
    }),
  }
  const out2 = await new LaunchService([noNotice as never], store2, { settings: () => DEFAULT_SETTINGS })
    .resume({ todoId: todo2.id, sessionId, toolId: 'opencode' })
  assert.equal(out2.ok, true)
  assert.equal(out2.notice, undefined)
})

// ---- [P2-11] ExportService 把 SessionInfo.files 写进导出索引 ----
await check('export: 多文件会话导出 files；filePath 保持主文件', async () => {
  const store = new TodoStore(path.join(dir, 'export-multifile-todos.json'))
  store.ensureFile()
  const todo = store.create({ title: '多 rollout' })
  store.update(todo.id, {
    addBinding: {
      toolId: 'codex',
      sessionId: newCliSessionId(sid),
      boundAt: new Date().toISOString(),
      state: 'verified',
    },
  })
  const adapter = {
    id: 'codex',
    capabilities: {
      needsCwd: false, resumeSession: true, deliverPrompt: [], setSessionName: false,
      discoverProjects: false, describeSessions: true, usage: false, newSessionMode: 'prefill' as const,
    },
    describeSession: async (id: string) => ({
      sessionId: id,
      cwd: dir,
      filePath: '/tmp/rollout-b.jsonl', // 最新那个 = 主文件
      files: ['/tmp/rollout-a.jsonl', '/tmp/rollout-b.jsonl'],
      resumable: true,
      exists: true,
    }),
  }
  const svc = new ExportService([adapter as never], store, () => DEFAULT_SETTINGS, path.join(dir, 'exports'))
  const out = await svc.run({ scope: 'todo', todoId: todo.id })

  const json = JSON.parse(readFileSync(out.jsonPath, 'utf8')) as {
    todos: Array<{ sessions: Array<{ filePath: string; files?: string[] }> }>
  }
  const s = json.todos[0]!.sessions[0]!
  assert.equal(s.filePath, '/tmp/rollout-b.jsonl', 'filePath 仍是主文件')
  assert.deepEqual(s.files, ['/tmp/rollout-a.jsonl', '/tmp/rollout-b.jsonl'], '全部正文文件必须落进导出索引')

  const md = readFileSync(out.markdownPath, 'utf8')
  assert.ok(md.includes('共 2 个正文文件'), 'Markdown 要标出多文件会话（人看索引时不会漏）')
})

// ---- [P2-33] detectWithTimeout：慢/挂起的 detect 不能拖住首帧 ----
await check('detectWithTimeout: 超时/异常降级为未安装，快路径原样返回', async () => {
  // 永不返回的 detect：必须在超时附近返回，不能挂住。
  // 注意：detectWithTimeout 内部的超时 timer 是 `unref()` 的（不能拖住 Electron 退出），
  // 单测里必须自己挂一个 ref 的 timer 保住 event loop，否则进程会以「unsettled top-level await」退出。
  const keepAlive = setTimeout(() => undefined, 1_000)
  try {
    const hang = { detect: () => new Promise<never>(() => {}) }
    const t0 = Date.now()
    const slow = await detectWithTimeout(hang as never, 60)
    const elapsed = Date.now() - t0
    assert.equal(slow.installed, false)
    assert.ok(slow.reason?.includes('超时'), `应给「超时」原因，实际：${slow.reason}`)
    assert.ok(elapsed >= 50 && elapsed < 1000, `应在超时附近返回（实际 ${elapsed}ms）`)

    // 抛错的 detect：降级成未安装 + 可读原因（而不是把整块 status 打成 IPC 异常）
    const boom = { detect: async () => { throw new Error('boom') } }
    const failedDetect = await detectWithTimeout(boom as never, 60)
    assert.equal(failedDetect.installed, false)
    assert.ok(failedDetect.reason?.includes('boom'), `实际：${failedDetect.reason}`)

    // 正常路径：原样返回，不改变 installed 语义
    const ok = { detect: async () => ({ installed: true }) }
    assert.deepEqual(await detectWithTimeout(ok as never, 60), { installed: true })
  } finally {
    clearTimeout(keepAlive)
  }
})

// ============================================================
// 第二轮修复回归 —— 默认数据根 / detect 纯函数（docs-fixer 建议）
// ============================================================

await check('roots: 各家默认数据根认 env 覆盖、目录不存在时不 mkdir', async () => {
  const { resolveCodexHome } = await import('../packages/ai/codex/src/index.ts')
  const { resolveClineSessionDir } = await import('../packages/ai/cline/src/index.ts')
  const { resolveGrokHome } = await import('../packages/ai/grok/src/index.ts')
  const { resolveOmpAgentDir } = await import('../packages/ai/omp/src/index.ts')
  const { resolveKimiHome } = await import('../packages/ai/kimi/src/index.ts')
  const { resolveDshHome } = await import('../packages/ai/dsh/src/index.ts')
  const { resolveOpenCodeDbPath, resolveZCodeDbPath } = await import('../packages/ai/opencode/src/index.ts')
  const { resolveSessionRoots: claudeRoots } = await import('../packages/ai/claude/src/index.ts')

  const h = path.join(dir, 'roots-home')
  const storeDir = path.join(dir, 'roots-store')
  const none = {} as NodeJS.ProcessEnv
  // 默认根（固定到假的 home，不依赖本机）
  assert.equal(resolveCodexHome(none, h), path.join(h, '.codex'))
  assert.equal(resolveGrokHome(none, h), path.join(h, '.grok'))
  assert.equal(resolveKimiHome(none, h), path.join(h, '.kimi-code'))
  assert.equal(resolveDshHome(none, h), path.join(h, '.dsh'))
  assert.equal(resolveOmpAgentDir(none, h), path.join(h, '.omp', 'agent'))
  assert.equal(resolveClineSessionDir(none, h), path.join(h, '.cline', 'data', 'sessions'))
  assert.equal(resolveOpenCodeDbPath(none, h), path.join(h, '.local', 'share', 'opencode', 'opencode.db'))
  assert.equal(resolveZCodeDbPath(h), path.join(h, '.zcode', 'cli', 'db', 'db.sqlite'))
  // 只读：目录不存在时返回空且不 mkdir
  assert.deepEqual(claudeRoots(none, h), [])
  assert.equal(existsSync(path.join(h, '.claude')), false)
  // env 覆盖优先
  assert.equal(resolveCodexHome({ CODEX_HOME: path.join(storeDir, 'codex') }, h), path.join(storeDir, 'codex'))
  assert.equal(resolveGrokHome({ GROK_HOME: path.join(storeDir, 'grok') }, h), path.join(storeDir, 'grok'))
  assert.equal(resolveKimiHome({ KIMI_CODE_HOME: path.join(storeDir, 'kimi') }, h), path.join(storeDir, 'kimi'))
  assert.equal(resolveDshHome({ DSH_HOME: path.join(storeDir, 'dsh') }, h), path.join(storeDir, 'dsh'))
  assert.equal(resolveOmpAgentDir({ OMP_HOME: path.join(storeDir, 'omp') }, h), path.join(storeDir, 'omp', 'agent'))
  assert.equal(resolveClineSessionDir({ CLINE_SESSION_DATA_DIR: path.join(storeDir, 'cline') }, h), path.join(storeDir, 'cline'))
  assert.equal(resolveOpenCodeDbPath({ XDG_DATA_HOME: path.join(storeDir, 'xdg') }, h), path.join(storeDir, 'xdg', 'opencode', 'opencode.db'))
})


// ============================================================
// 第二轮修复回归 —— opencode / zcode / dsh / kimi（data-fixer）
// ============================================================

// ---- [P1-3] opencode：子代理 cost 并入父会话 ----
await check('opencode: 子代理 cost 并入父会话（父 0.5 + 子 0.25 = 0.75），costReported 口径一致', async () => {
  const dbPath = path.join(dir, 'oc-cost.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_p', null, dir, '父', 1, 9, null, null, 0.5, 100, 10, 0, 0, 0)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_c', 'ses_p', dir, '子', 1, 9, null, null, 0.25, 5, 1, 0, 0, 0)
  db.close()
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (id) => ['--session', id] },
    { resolveExe: async () => '/fake/opencode' },
  )
  const usage = await adapter.computeUsage(newCliSessionId('ses_p'))
  assert.equal(usage?.cost.total, 0.75, '父 0.5 + 子 0.25（旧实现只报 0.5）')
  assert.equal(usage?.costReported, true)
  assert.equal(usage?.tokens.input, 105, 'token 口径本来就含子代理，cost 现在与它一致')

  // 子代理有 token 但 cost=0（未上报）→ 合并成本只能当下限
  const mixDbPath = path.join(dir, 'oc-cost-mixed.db')
  const mix = new DatabaseSync(mixDbPath)
  mix.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  mix.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('mix_p', null, dir, '父', 1, 9, null, null, 0.5, 10, 10, 0, 0, 0)
  mix.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('mix_c', 'mix_p', dir, '子', 1, 9, null, null, 0, 100, 100, 0, 0, 0)
  mix.close()
  const mixAdapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath: mixDbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    {},
  )
  const mixed = await mixAdapter.computeUsage(newCliSessionId('mix_p'))
  assert.equal(mixed?.cost.total, 0.5)
  assert.equal(mixed?.costReported, false, '子代理 token>0/cost=0 → 合并成本不可信（下限）')

  // 全部 token=0、只有子代理 cost>0：不能因为「没 token」把成本丢掉
  const costOnlyDbPath = path.join(dir, 'oc-cost-only.db')
  const costOnly = new DatabaseSync(costOnlyDbPath)
  costOnly.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  costOnly.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('co_p', null, dir, '父', 1, 9, null, null, 0, 0, 0, 0, 0, 0)
  costOnly.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('co_c', 'co_p', dir, '子', 1, 9, null, null, 2.5, 0, 0, 0, 0, 0)
  costOnly.close()
  const costOnlyAdapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath: costOnlyDbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    {},
  )
  const costOnlyUsage = await costOnlyAdapter.computeUsage(newCliSessionId('co_p'))
  assert.ok(costOnlyUsage, 'token 全 0 但子代理有 cost 时不能返回 undefined（成本丢失）')
  assert.equal(costOnlyUsage?.cost.total, 2.5)
  assert.equal(costOnlyUsage?.costReported, true)
})

// ---- [P2] opencode：readUserTexts 不再升序截断（>20000 part 的超长会话 lastMessage 仍正确） ----
await check('opencode: 超长会话（>20000 part）的 lastMessage 取真正的最后一条用户消息', async () => {
  const dbPath = path.join(dir, 'oc-long.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_long', null, dir, '长会话', 1, 9, null, null, 0, 0, 0, 0, 0, 0)
  const insertMsg = db.prepare('insert into message values (?,?,?,?)')
  const insertPart = db.prepare('insert into part values (?,?,?,?)')
  db.exec('begin')
  insertMsg.run('m_first', 'ses_long', 1, JSON.stringify({ role: 'user' }))
  insertPart.run('p_first', 'm_first', 1, JSON.stringify({ type: 'text', text: '第一条' }))
  for (let i = 0; i < 20100; i++) {
    insertMsg.run(`m_a${i}`, 'ses_long', 2 + i, JSON.stringify({ role: 'assistant' }))
    insertPart.run(`p_a${i}`, `m_a${i}`, 2 + i, JSON.stringify({ type: 'text', text: 'x' }))
  }
  insertMsg.run('m_last', 'ses_long', 100000, JSON.stringify({ role: 'user' }))
  insertPart.run('p_last', 'm_last', 100000, JSON.stringify({ type: 'text', text: '真正的最后一问' }))
  db.exec('commit')
  db.close()
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    {},
  )
  const info = await adapter.describeSession(newCliSessionId('ses_long'))
  assert.equal(info?.firstMessage, '第一条')
  assert.equal(info?.lastMessage, '真正的最后一问')
})

// ---- [P2 REGRESSED] opencode：注入「按轮成段连续写入」时，20 条固定窗口会漏真实首/末条 ----
// 真实库 2/63 会话：一条前 20 条 user message 全是 <inbound-context>（first 变空），
// 一条最后 20 条全是注入（last 回落成第一条）。窗口必须向外分页扫描到命中或穷尽。
await check('opencode: 首/尾窗口遇到连续注入时向外分页扫描（不漏 first/last）', async () => {
  const windowDbPath = path.join(dir, 'oc-window.db')
  const db = new DatabaseSync(windowDbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  const insertSession = db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertMsg = db.prepare('insert into message values (?,?,?,?)')
  const insertPart = db.prepare('insert into part values (?,?,?,?)')
  const userMsg = (sessionId: string, index: number, time: number) => {
    const id = `${sessionId}-m${index}`
    insertMsg.run(id, sessionId, time, JSON.stringify({ role: 'user' }))
    return id
  }
  const injection = (sessionId: string, index: number, time: number) => {
    const id = userMsg(sessionId, index, time)
    insertPart.run(`${id}-p`, id, time, JSON.stringify({ type: 'text', text: `<inbound-context>自动注入 ${index}</inbound-context>` }))
  }
  const clean = (sessionId: string, index: number, time: number, text: string) => {
    const id = userMsg(sessionId, index, time)
    insertPart.run(`${id}-p`, id, time, JSON.stringify({ type: 'text', text }))
  }
  insertSession.run('ses_head', null, dir, '头部全注入', 1, 9, null, null, 0, 1, 1, 0, 0, 0)
  insertSession.run('ses_tail', null, dir, '尾部全注入', 1, 9, null, null, 0, 1, 1, 0, 0, 0)
  // 头部全注入：前 20 条 user message 全是注入，第 21 条才是真实提问（旧的固定窗口取不到）
  for (let i = 1; i <= 20; i++) injection('ses_head', i, i)
  clean('ses_head', 21, 21, '真实的首条提问')
  clean('ses_head', 22, 22, '另一条真实提问')
  // 尾部全注入：先两条真实提问，之后 20 条全是注入（旧的固定窗口把 last 回落成第一条）
  clean('ses_tail', 1, 1, '最早的真实提问')
  clean('ses_tail', 2, 2, '真实的末条提问')
  for (let i = 3; i <= 22; i++) injection('ses_tail', i, i)
  db.close()

  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath: windowDbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    {},
  )
  const head = await adapter.describeSession(newCliSessionId('ses_head'))
  assert.equal(head?.firstMessage, '真实的首条提问', '前 20 条全注入时必须继续向后翻页')
  assert.equal(head?.lastMessage, '另一条真实提问')
  const tail = await adapter.describeSession(newCliSessionId('ses_tail'))
  assert.equal(tail?.firstMessage, '最早的真实提问')
  assert.equal(tail?.lastMessage, '真实的末条提问', '后 20 条全注入时必须继续向前翻页，不能回落成第一条')
})

// ---- [P2] opencode：message 表缺列 → 列表/用量照常，仅正文降级（bodyReadable=false） ----
await check('opencode: message 表缺列时列表/用量照常，只把首/末条用户消息降级为空', async () => {
  const dbPath = path.join(dir, 'oc-noschema.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, data text);  -- 缺 time_created
    create table part (id text primary key, message_id text, data text);     -- 缺 time_created
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_x', null, dir, '标题在', 1, 9, null, null, 0, 10, 2, 0, 0, 0)
  db.close()
  const logs: string[] = []
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    { resolveExe: async () => '/fake/opencode', log: (k, m) => logs.push(`${k}:${m}`) },
  )
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 1, '旧实现会把整个 store 降级为空（列表 0 条）')
  assert.equal(list[0]?.name, '标题在')
  assert.equal((await adapter.computeUsage(newCliSessionId('ses_x')))?.tokens.input, 10, '用量仍可用')
  const info = await adapter.describeSession(newCliSessionId('ses_x'))
  assert.equal(info?.name, '标题在')
  assert.equal(info?.firstMessage, undefined, '正文能力关闭')
  assert.ok(logs.some((l) => l.includes('首/末条用户消息降级为空')), JSON.stringify(logs))
})

// ---- [P2/P3] opencode：归档 resumable=false；子代理会话可按 id 描述（单行查询） ----
await check('opencode: 归档会话 resumable=false；子代理会话可按 id 描述（单行查询）', async () => {
  const dbPath = path.join(dir, 'oc-arch.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
  `)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_root', null, dir, '根', 1, 9, null, null, 0, 1, 1, 0, 0, 0)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_child', 'ses_root', dir, '子代理', 1, 9, null, null, 0, 1, 1, 0, 0, 0)
  db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_arch', null, dir, '归档', 1, 9, 1234, null, 0, 1, 1, 0, 0, 0)
  db.close()
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    { resolveExe: async () => '/fake/opencode' },
  )
  const list = await adapter.listSessionInfos()
  assert.equal(list.length, 2, '子代理会话不单独列')
  assert.equal(list.find((s) => s.sessionId === 'ses_arch')?.resumable, false, '归档会话必须置灰')
  assert.equal(list.find((s) => s.sessionId === 'ses_root')?.resumable, true)
  const child = await adapter.describeSession(newCliSessionId('ses_child'))
  assert.ok(child, '子代理会话能按 id 查到（旧实现 list().find() → undefined）')
  assert.equal(child?.name, '子代理')
})

// ---- [P2] opencode：dbPath 支持 () => string（延迟解析；app-fixer 在 main 传 getter） ----
await check('opencode: dbPath 支持 getter（构造后再出现的库也能读到；换库即时生效）', async () => {
  const mkDb = (file: string, title: string) => {
    const db = new DatabaseSync(file)
    db.exec(`create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
      tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, time_created integer, data text);`)
    db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('ses_1', null, dir, title, 1, 9, null, null, 0, 1, 1, 0, 0, 0)
    db.close()
  }
  const dbA = path.join(dir, 'oc-lazy-a.db')
  const dbB = path.join(dir, 'oc-lazy-b.db')
  let current = dbA // 构造时还不存在
  const adapter = new OpenCodeAdapter(
    { toolId: 'opencode', displayName: 'OpenCode', dbPath: '/nonexistent.db', usageSource: 'session-row', exeName: 'opencode', resumeArgs: (i) => ['--session', i] },
    { resolveExe: async () => '/fake/opencode', dbPath: () => current },
  )
  assert.equal((await adapter.listSessionInfos()).length, 0)
  mkDb(dbA, '库A')
  assert.equal((await adapter.listSessionInfos())[0]?.name, '库A', 'getter 不能只在构造时求值')
  mkDb(dbB, '库B')
  current = dbB
  assert.equal((await adapter.listSessionInfos())[0]?.name, '库B')
})

// ---- [P2] opencode：选桌面版但只有 CLI → 回落终端 + notice ----
await check('opencode: 默认入口选桌面版但只有 CLI 时回落终端，并如实给 notice', async () => {
  const dbPath = path.join(dir, 'oc-fallback.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer, model text, cost real,
    tokens_input integer, tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);`)
  db.close()
  let spec: { cwd?: string; executable?: string; args?: string[] } | undefined
  const clips: string[] = []
  const adapter = new OpenCodeAdapter(
    {
      toolId: 'opencode', displayName: 'OpenCode', dbPath, usageSource: 'session-row',
      exeName: 'opencode', resumeArgs: (id) => ['--session', id],
      desktopBundleId: 'ai.opencode.desktop', desktopBundleName: 'OpenCode.app',
    },
    {
      resolveExe: async () => '/fake/opencode',
      appDirs: [path.join(dir, 'no-apps')],
      openTerminal: (s) => { spec = s as never },
      clipboardWrite: (t) => clips.push(t),
    },
  )
  const out = await adapter.openNewSessionPage({ promptText: '你好', cwd: dir, client: 'desktop' })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(out.notice?.includes('未检测到 OpenCode 桌面版，已改用终端'), out.notice)
  assert.deepEqual(spec?.args, [], 'terminal-copy：argv 不带 prompt')
  assert.deepEqual(clips, ['你好'])
})

// ---- [P2] zcode：detect 只看 App bundle（XML/二进制 plist），数据残留不算安装；列表置灰 ----
await check('zcode: detect 以 App bundle 为准（XML/二进制 plist），只有数据残留不算安装；列表置灰', async () => {
  const appDir = path.join(dir, 'zc-apps')
  const bundle = path.join(appDir, 'ZCode.app', 'Contents')
  mkdirSync(bundle, { recursive: true })
  const dbPath = path.join(dir, 'zc.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer, time_archived integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, time_created integer, data text);
    create table model_usage (id text primary key, session_id text, model_id text, input_tokens integer, output_tokens integer, reasoning_tokens integer, cache_read_input_tokens integer, cache_creation_input_tokens integer);`)
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('ses_z', null, dir, 'Z', 1, 9, null)
  db.close()
  // ① XML plist
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.zcode.app</string></dict></plist>',
  )
  const installed = new ZCodeAdapter({ dbPath, appDirs: [appDir] })
  assert.equal((await installed.detect()).installed, true)
  assert.equal((await installed.listSessionInfos())[0]?.resumable, false, 'ZCode 没有 resume 通道 → 列表直接置灰')
  // ② 只有数据、没有 App → 未安装，reason 区分「卸载残留」
  const dataOnly = new ZCodeAdapter({ dbPath, appDirs: [path.join(dir, 'no-zc-apps')], home: path.join(dir, 'no-home') })
  const detected = await dataOnly.detect()
  assert.equal(detected.installed, false, '数据目录存在不算已安装（rules §4）')
  assert.ok(detected.reason?.includes('应用可能已卸载'), detected.reason)
  // ③ 二进制 plist（Xcode 默认可能是 bplist）→ plutil 兜底必须认
  writeFileSync(
    path.join(bundle, 'Info.plist'),
    Buffer.from('YnBsaXN0MDDRAQJfEBJDRkJ1bmRsZUlkZW50aWZpZXJdZGV2Lnpjb2RlLmFwcAgLIAAAAAAAAAEBAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAu', 'base64'),
  )
  assert.equal((await installed.detect()).installed, true, '二进制 plist 不能判未安装')
})

// ---- [P2] dsh：readHeader 跳过首帧开头的空行 ----
await check('dsh: readHeader 跳过首帧开头的空行（旧实现会把整段当第一行 JSON.parse 失败）', () => {
  const home = path.join(dir, 'dsh-nl')
  const sdir = path.join(home, 'sessions', '--p--', 's-nl')
  mkdirSync(sdir, { recursive: true })
  const file = path.join(sdir, 'session.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from('\n' + JSON.stringify({ type: 'session', id: 's-nl', cwd: dir, createdAt: 5 }) + '\n')))
  assert.equal(readHeader(file, true)?.id, 's-nl')
})

// ---- [P2] dsh：readFirstFrameText 64KB 起步、首帧更大时按需加倍 ----
await check('dsh: readFirstFrameText 首帧 >64KB 时按需加倍（不再固定读 1MB）', () => {
  const home = path.join(dir, 'dsh-big')
  const sdir = path.join(home, 'sessions', '--p--', 's-big')
  mkdirSync(sdir, { recursive: true })
  const file = path.join(sdir, 'session.jsonl.zstd')
  const bigHeader = { type: 'session', id: 's-big', cwd: dir, createdAt: 5, padding: 'x'.repeat(100 * 1024) }
  writeFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify(bigHeader) + '\n')))
  assert.equal(readHeader(file, true)?.id, 's-big')
})

// ---- [P2] dsh：readPlainLines CJK 跨 256KB 块边界不出 U+FFFD ----
await check('dsh: 未压缩会话 CJK 跨 256KB 块边界不被解成 U+FFFD', () => {
  const file = path.join(dir, 'plain-cjk.jsonl')
  const prefix = '{"pad":"","text":"aaa'
  const boundary = 256 * 1024
  // 「中」的 3 字节正好跨 256KB 边界：首字节落在 boundary-1
  const padLen = boundary - 1 - Buffer.byteLength(prefix)
  const line = '{"pad":"' + 'a'.repeat(padLen) + '","text":"aaa中tail"}'
  writeFileSync(file, line + '\n')
  const got: string[] = []
  readPlainLines(file, { onLine: (l) => { got.push(l) } })
  assert.equal(got.length, 1)
  assert.ok(got[0]?.includes('aaa中tail'), JSON.stringify(got[0]?.slice(-20)))
  assert.equal(got[0]?.includes('\ufffd'), false)
})

// ---- [P2] dsh：会话收集按 mtime 取 top-N + 截断 log 一次 ----
await check('dsh: 会话数超上限时按 mtime 保留最近 N 个（不是 readdir 顺序）并记 log', () => {
  const home = path.join(dir, 'dsh-topn')
  const mk = (name: string, mtime: number) => {
    const sdir = path.join(home, 'sessions', '--p--', name)
    mkdirSync(sdir, { recursive: true })
    const file = path.join(sdir, 'session.jsonl.zstd')
    writeFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: name, cwd: dir, createdAt: mtime }) + '\n')))
    utimesSync(file, new Date(mtime), new Date(mtime))
    utimesSync(sdir, new Date(mtime), new Date(mtime))
  }
  mk('s-0', 1000)
  mk('s-1', 3000)
  mk('s-2', 2000)
  const logs: string[] = []
  const sessions = collectDshSessions(home, 2, (key) => logs.push(key))
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['s-1', 's-2'], '最新的两个')
  assert.ok(logs.includes('limit'), JSON.stringify(logs))
})

// ---- [P2/P3] dsh：usage 回退正文口径也计子代理；discoverProjects 用投影缓存 cwd ----
await check('dsh: usage 回退正文口径也计子代理；discoverProjects 用投影缓存 cwd', async () => {
  const home = path.join(dir, 'dsh-fallback')
  const mkSession = (dirName: string, header: Record<string, unknown>, events: unknown[]) => {
    const sdir = path.join(home, 'sessions', '--p--', dirName)
    mkdirSync(sdir, { recursive: true })
    writeFileSync(
      path.join(sdir, 'session.jsonl.zstd'),
      Buffer.concat([
        zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')),
        zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n')),
      ]),
    )
  }
  const usageEvent = (input: number, output: number) => ({
    type: 'assistant/message', seq: 1, time: 2,
    data: { message: { role: 'assistant', content: [], source: { kind: 'model', model: 'deepseek-chat', provider: 'deepseek' } }, usage: { inputTokens: input, outputTokens: output } },
  })
  mkSession('d-p', { type: 'session', id: 'd-p', cwd: dir, createdAt: 1, delegationDepth: 0 }, [
    { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '父问' }], source: { kind: 'user' } } },
    usageEvent(10, 2),
  ])
  mkSession('d-c', { type: 'session', id: 'd-c', cwd: dir, createdAt: 1, delegationDepth: 1, parentSession: 'd-p', origin: 'subagent' }, [usageEvent(5, 1)])
  const adapter = new DshAdapter({ dshHome: home, appDirs: [path.join(dir, 'no-apps')] })
  const usage = await adapter.computeUsage(newCliSessionId('d-p'))
  assert.equal(usage?.tokens.input, 15, '父 10 + 子 5（旧实现只算父 10）')
  assert.equal(usage?.tokens.output, 3)

  // 缓存 cwd 优先于 header cwd
  const home2 = path.join(dir, 'dsh-cwdcache')
  const cwdB = path.join(dir, 'cwd-b')
  mkdirSync(cwdB, { recursive: true })
  const sdir = path.join(home2, 'sessions', '--p--', 's-cwd')
  mkdirSync(sdir, { recursive: true })
  writeFileSync(path.join(sdir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 's-cwd', cwd: path.join(dir, 'cwd-a'), createdAt: 1 }) + '\n')))
  const cacheDir = path.join(home2, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(path.join(cacheDir, 's-cwd.json'), JSON.stringify({ version: 1, record: { identity: { createdAt: 1, cwd: cwdB }, rows: {} } }))
  const adapter2 = new DshAdapter({ dshHome: home2, appDirs: [path.join(dir, 'no-apps')] })
  const projects = await adapter2.discoverProjects()
  assert.equal(projects.length, 1)
  assert.ok(projects[0]?.path.endsWith('cwd-b'), JSON.stringify(projects))
})

// ---- [P2/P3] dsh：resume 直接抛错；列表 resumable=false；header 读失败日志只记一次 ----
await check('dsh: 列表 resumable=false；resume 直接抛错；header 读失败日志只记一次', async () => {
  const home = path.join(dir, 'dsh-resume')
  const sdir = path.join(home, 'sessions', '--p--', 's-r')
  mkdirSync(sdir, { recursive: true })
  writeFileSync(path.join(sdir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', id: 's-r', cwd: dir, createdAt: 1 }) + '\n')))
  const adapter = new DshAdapter({ dshHome: home, appDirs: [path.join(dir, 'no-apps')] })
  assert.equal((await adapter.listSessionInfos())[0]?.resumable, false)
  await assert.rejects(
    () => adapter.resume(newCliSessionId('s-r'), { promptText: '', cwd: dir, sessionId: newCliSessionId('s-r'), deliver: 'none' }),
    /没有按会话打开/,
  )

  const home2 = path.join(dir, 'dsh-log')
  const broken = path.join(home2, 'sessions', '--p--', 'broken')
  mkdirSync(broken, { recursive: true })
  writeFileSync(path.join(broken, 'session.jsonl.zstd'), Buffer.from('not-zstd'))
  const logs: string[] = []
  const adapter2 = new DshAdapter({ dshHome: home2, appDirs: [path.join(dir, 'no-apps')], log: (k) => logs.push(k) })
  await adapter2.listSessionInfos()
  await adapter2.listSessionInfos()
  assert.equal(logs.filter((k) => k === 'dsh.header').length, 1, JSON.stringify(logs))
})

// ---- [P2/P3] kimi：lastMessage 按 lastUserAt 取最新（子 wire 的用户文本不抢主对话末条） ----
await check('kimi: lastMessage 按时间取最新，子 wire 的 user 文本不覆盖主对话末条', async () => {
  const home = path.join(dir, 'kimi-last')
  const ksid = 'session_11111111-2222-3333-8444-555555555555'
  const sdir = path.join(home, 'sessions', 'wd_x', ksid)
  mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true })
  mkdirSync(path.join(sdir, 'agents', 'agent-1'), { recursive: true })
  writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: ksid, sessionDir: sdir, workDir: dir }) + '\n')
  writeFileSync(path.join(sdir, 'state.json'), JSON.stringify({ title: 't' }))
  const prompt = (time: number, text: string) => JSON.stringify({ type: 'turn.prompt', time, origin: { kind: 'user' }, input: [{ type: 'text', text }] })
  writeFileSync(path.join(sdir, 'agents', 'main', 'wire.jsonl'), [prompt(1000, '主问题'), prompt(3000, '主最后一问')].join('\n') + '\n')
  writeFileSync(path.join(sdir, 'agents', 'agent-1', 'wire.jsonl'), prompt(2000, '子代理问的') + '\n')
  const adapter = new KimiAdapter({ kimiHome: home, resolveExe: async () => '/fake/kimi' })
  const info = await adapter.describeSession(newCliSessionId(ksid))
  assert.equal(info?.firstMessage, '主问题')
  assert.equal(info?.lastMessage, '主最后一问', '旧实现按数组顺序被子 wire 覆盖')
})

// ---- [P3] kimi：Date.parse 失败不产生 NaN 的 lastUsedAt ----
await check('kimi: state 时间非法时 lastUsedAt 仍为有限数（不产生 NaN）', async () => {
  const home = path.join(dir, 'kimi-nan')
  const ksid = 'session_99999999-8888-7777-8666-555555555555'
  const sdir = path.join(home, 'sessions', 'wd_y', ksid)
  mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true })
  writeFileSync(path.join(sdir, 'state.json'), JSON.stringify({ title: 't', createdAt: 'not-a-date', updatedAt: 'not-a-date' }))
  writeFileSync(
    path.join(sdir, 'agents', 'main', 'wire.jsonl'),
    JSON.stringify({ type: 'turn.prompt', time: 5000, origin: { kind: 'user' }, input: [{ type: 'text', text: 'hi' }] }) + '\n',
  )
  const adapter = new KimiAdapter({ kimiHome: home, resolveExe: async () => '/fake/kimi' })
  const list = await adapter.listSessionInfos()
  assert.ok(Number.isFinite(list[0]?.lastUsedAt), JSON.stringify(list[0]))
  assert.ok((list[0]?.lastUsedAt ?? 0) >= 5000)
})

// ---- [P3] kimi：会话收集按 mtime 取 top-N + 截断 log ----
await check('kimi: 会话数超上限时按 mtime 保留最近 N 个并记 log', () => {
  const home = path.join(dir, 'kimi-topn')
  const mk = (i: number, mtime: number) => {
    const ksid = `session_0000000${i}-1111-2222-8333-44444444444${i}`
    const sdir = path.join(home, 'sessions', 'wd_z', ksid)
    mkdirSync(path.join(sdir, 'agents', 'main'), { recursive: true })
    writeFileSync(path.join(sdir, 'state.json'), JSON.stringify({ title: `t${i}` }))
    writeFileSync(path.join(sdir, 'agents', 'main', 'wire.jsonl'), '')
    for (const p of [path.join(sdir, 'state.json'), path.join(sdir, 'agents', 'main', 'wire.jsonl'), sdir]) {
      utimesSync(p, new Date(mtime), new Date(mtime))
    }
  }
  mk(0, 1000)
  mk(1, 3000)
  mk(2, 2000)
  const logs: string[] = []
  const sessions = collectKimiSessions(home, 2, (key) => logs.push(key))
  assert.equal(sessions.length, 2)
  assert.ok(logs.includes('limit'), JSON.stringify(logs))
  assert.equal(sessions[0]?.id.includes('00000001'), true, '最新的应是 mtime=3000 那条')
})

// 中途被信号杀掉（如 CI 超时）也不留临时目录：交给 exit 钩子兜底
process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
rmSync(dir, { recursive: true, force: true })
console.log(`\nRESULT passed=${passed} failed=${failed}`)
// 让 `node` 的退出码反映 FAIL（旧实现只靠 process.exitCode，RESULT 里恒写 failed=1）
if (failed > 0) process.exitCode = 1
