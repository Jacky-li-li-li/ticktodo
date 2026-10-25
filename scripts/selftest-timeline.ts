/**
 * 时间线（P0-1/P0-3/P0-5/P0-6）selftest（无测试框架；由 scripts/selftest-timeline.mjs 打包执行）。
 *
 * 覆盖：
 *  1. core 纯函数：状态归一（missing/active/done/idle）、截断与 approximate 标记；
 *  2. 三个适配器的证据解析：pi（message.timestamp + stopReason）、claude（ISO timestamp +
 *     assistant stop_reason）、workbuddy（message.timestamp + assistant status + <user_query>）；
 *  3. SessionService：forTodo 按会话内事件时间排序、missing 排最后、digest 派生缓存
 *     （文件指纹不变时复用证据、变了必须重读）、recentForTodos（P0-6）。
 *
 * 不启动 Electron、不读真实会话：全部用 mkdtemp 里的夹具文件。
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AiToolAdapter, SessionInfo } from '../packages/ai/core/src/index.ts'
import {
  SESSION_DIGEST_TEXT_MAX,
  buildSessionDigest,
  deriveSessionState,
} from '../packages/ai/core/src/index.ts'
import { readSessionMeta as readPiMeta } from '../packages/ai/pi/src/paths.ts'
import { readSessionMeta as readClaudeMeta } from '../packages/ai/claude/src/paths.ts'
import { readTranscriptMeta } from '../packages/ai/workbuddy/src/transcript.ts'
import { TodoStore } from '../apps/desktop/src/main/store.ts'
import { SessionService } from '../apps/desktop/src/main/services/sessions.ts'
import { newCliSessionId } from '../packages/shared/src/index.ts'

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

const NOW = Date.UTC(2026, 9, 25, 4, 0, 0)
const dir = mkdtempSync(path.join(os.tmpdir(), 'tick-selftest-timeline-'))

function jsonl(file: string, rows: unknown[]): string {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'))
  return file
}

async function main(): Promise<void> {
  // ---------- 1. 状态归一 ----------
  await check('state: 文件不在 = missing', () => {
    assert.equal(deriveSessionState({ exists: false }, NOW), 'missing')
  })
  await check('state: 工具自报进行中 = active（即使没有事件时间）', () => {
    assert.equal(deriveSessionState({ exists: true, running: true }, NOW), 'active')
  })
  await check('state: 活跃窗口内 = active', () => {
    assert.equal(
      deriveSessionState({ exists: true, lastEventAt: NOW - 60_000 }, NOW),
      'active',
    )
  })
  await check('state: 超过活跃窗口 + 干净终态 = done', () => {
    assert.equal(
      deriveSessionState({ exists: true, lastEventAt: NOW - 11 * 60_000, endedCleanly: true }, NOW),
      'done',
    )
  })
  await check('state: 超过活跃窗口 + 非干净终态 = idle', () => {
    assert.equal(
      deriveSessionState({ exists: true, lastEventAt: NOW - 11 * 60_000, endedCleanly: false }, NOW),
      'idle',
    )
  })
  await check('digest: 超长消息截断并标记，原文不改写', () => {
    const digest = buildSessionDigest(
      {
        toolId: 'pi',
        sessionId: newCliSessionId('s-long'),
        exists: true,
        lastUserMessage: 'x'.repeat(SESSION_DIGEST_TEXT_MAX + 10),
        lastUserMessageAt: NOW - 1000,
        lastEventAt: NOW - 1000,
        endedCleanly: true,
      },
      NOW,
    )
    assert.equal(digest.lastUserMessage?.length, SESSION_DIGEST_TEXT_MAX + 1)
    assert.equal(digest.lastUserMessageTruncated, true)
    assert.equal(digest.state, 'active')
  })
  await check('digest: 只有 lastMessage 时标 approximate 且不给消息时间', () => {
    const digest = buildSessionDigest(
      {
        toolId: 'pi',
        sessionId: newCliSessionId('s-old'),
        exists: true,
        lastUserMessage: '压缩标题',
        lastEventAt: NOW - 11 * 60_000,
        endedCleanly: true,
        approximate: true,
      },
      NOW,
    )
    assert.equal(digest.approximate, true)
    assert.equal(digest.lastUserMessageAt, undefined)
    assert.equal(digest.state, 'done')
  })

  // ---------- 2. 适配器证据解析 ----------
  await check('pi: 末条 assistant stop = 干净终态 + 消息时间', async () => {
    const file = jsonl(path.join(dir, 'pi-clean.jsonl'), [
      { type: 'session', version: 3, id: 'p1', timestamp: '2026-10-20T00:00:00.000Z', cwd: '/tmp' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: 1_700_000_000_000 } },
      { type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop', timestamp: 1_700_000_005_000 } },
    ])
    const meta = await readPiMeta(file)
    assert.equal(meta.firstUserText, 'first')
    assert.equal(meta.lastUserText, 'first')
    assert.equal(meta.lastUserAt, 1_700_000_000_000)
    assert.equal(meta.lastEventAt, 1_700_000_005_000)
    assert.equal(meta.endedCleanly, true)
  })
  await check('pi: toolUse / toolResult 结尾不是干净终态', async () => {
    const file = jsonl(path.join(dir, 'pi-tool.jsonl'), [
      { type: 'session', version: 3, id: 'p2', timestamp: '2026-10-20T00:00:00.000Z', cwd: '/tmp' },
      { type: 'message', message: { role: 'user', content: 'go', timestamp: 1_700_000_000_000 } },
      { type: 'message', message: { role: 'assistant', content: [], stopReason: 'toolUse', timestamp: 1_700_000_001_000 } },
      { type: 'message', message: { role: 'toolResult', content: [], timestamp: 1_700_000_002_000 } },
    ])
    const meta = await readPiMeta(file)
    assert.equal(meta.lastEventAt, 1_700_000_002_000)
    assert.equal(meta.endedCleanly, false)
  })
  await check('claude: user / assistant 时间与 stop_reason', async () => {
    const file = jsonl(path.join(dir, 'claude.jsonl'), [
      { type: 'custom-title', customTitle: 'T', sessionId: 'c1' },
      {
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-10-20T00:00:00.000Z',
        cwd: '/tmp',
        sessionId: 'c1',
        isSidechain: false,
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
        timestamp: '2026-10-20T00:00:05.000Z',
        sessionId: 'c1',
      },
    ])
    const meta = await readClaudeMeta(file)
    assert.equal(meta.lastUserText, 'hello')
    assert.equal(meta.lastUserAt, Date.parse('2026-10-20T00:00:00.000Z'))
    assert.equal(meta.lastEventKind, 'assistant')
    assert.equal(meta.lastAssistantStopReason, 'end_turn')
    assert.equal(meta.lastEventAt, Date.parse('2026-10-20T00:00:05.000Z'))
  })
  await check('workbuddy: 末条 assistant status + <user_query> 抽取', async () => {
    const file = jsonl(path.join(dir, 'wb.jsonl'), [
      {
        type: 'message',
        role: 'user',
        timestamp: 1_700_000_000_000,
        providerData: { startsNewUserRequest: true },
        content: [{ type: 'input_text', text: '<system-reminder><user_query>do it</user_query></system-reminder>' }],
      },
      {
        type: 'message',
        role: 'assistant',
        timestamp: 1_700_000_005_000,
        status: 'completed',
        content: [{ type: 'text', text: 'ok' }],
      },
      { type: 'custom-title', customTitle: 'WB' },
    ])
    const meta = await readTranscriptMeta(file)
    assert.equal(meta.lastUserText, 'do it')
    assert.equal(meta.lastUserAt, 1_700_000_000_000)
    assert.equal(meta.lastEventAt, 1_700_000_005_000)
    assert.equal(meta.lastEventKind, 'assistant')
    assert.equal(meta.lastAssistantStatus, 'completed')
  })

  // ---------- 3. SessionService：排序 / missing / 缓存 / P0-6 ----------
  const home = path.join(dir, 'home')
  const cacheDir = path.join(home, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const store = new TodoStore(path.join(home, 'todos.json'))
  store.ensureFile()
  const todo = store.create({ title: '时间线用例' })
  const s1File = path.join(dir, 's1.jsonl')
  const s2File = path.join(dir, 's2.jsonl')
  writeFileSync(s1File, 'a')
  writeFileSync(s2File, 'b')

  const p1 = newCliSessionId('s1')
  const p2 = newCliSessionId('s2')
  const p3 = newCliSessionId('s3')
  store.update(todo.id, {
    addBinding: { toolId: 'pi', sessionId: p1, boundAt: new Date(NOW).toISOString(), state: 'verified', filePath: s1File },
    primarySessionId: p1,
  })
  store.update(todo.id, {
    addBinding: { toolId: 'claude', sessionId: p2, boundAt: new Date(NOW).toISOString(), state: 'verified', filePath: s2File },
  })
  store.update(todo.id, {
    addBinding: { toolId: 'pi', sessionId: p3, boundAt: new Date(NOW).toISOString(), state: 'verified' },
  })

  let s1Message = 'recent question'
  const infos = new Map<string, SessionInfo>()
  const base = (toolId: string, sessionId: string, filePath: string, at: number): SessionInfo => ({
    toolId,
    sessionId: newCliSessionId(sessionId),
    cwd: '/tmp',
    createdAt: new Date(at).toISOString(),
    lastUsedAt: at,
    exists: true,
    filePath,
    resumable: true,
    hasLocalFiles: true,
    lastEventAt: at,
    endedCleanly: true,
    lastUserMessage: `msg-${sessionId}`,
    lastUserMessageAt: at,
  })
  infos.set('s1', base('pi', 's1', s1File, NOW - 60_000))
  infos.set('s2', base('claude', 's2', s2File, NOW - 3 * 3600_000))
  const fake = {
    id: 'pi',
    capabilities: {},
    describeSession: async (id: string): Promise<SessionInfo | undefined> => {
      const info = infos.get(id)
      if (!info) return undefined
      return id === 's1' ? { ...info, lastUserMessage: s1Message } : info
    },
  } as unknown as AiToolAdapter

  const service = new SessionService([fake], store, {
    digestCacheFile: path.join(cacheDir, 'session-digests.json'),
    now: () => NOW,
  })
  const views = await service.forTodo(todo.id)
  await check('SessionService: 按会话内事件时间倒序，missing 排最后', () => {
    assert.deepEqual(
      views.map((v) => v.sessionId),
      [p1, p2, p3],
    )
    assert.deepEqual(
      views.map((v) => v.digest?.state),
      ['active', 'done', 'missing'],
    )
    assert.equal(views[0]?.digest?.lastUserMessage, 'recent question')
    assert.equal(views[2]?.missing, true)
  })
  await check('SessionService: 文件指纹不变时复用派生证据（不重算消息）', async () => {
    s1Message = 'CHANGED without file change'
    const again = await service.forTodo(todo.id)
    assert.equal(again[0]?.digest?.lastUserMessage, 'recent question')
  })
  await check('SessionService: 文件变化后指纹失效并重读证据', async () => {
    appendFileSync(s1File, 'x')
    const changed = await service.forTodo(todo.id)
    assert.equal(changed[0]?.digest?.lastUserMessage, 'CHANGED without file change')
  })
  await check('SessionService: recentForTodos 取 primary 会话（P0-6）', async () => {
    const recent = await service.recentForTodos([todo.id, 'missing-todo'])
    assert.equal(recent.length, 1)
    assert.equal(recent[0]?.todoId, todo.id)
    assert.equal(recent[0]?.toolId, 'pi')
    assert.equal(recent[0]?.lastUserMessage, 'CHANGED without file change')
  })
  await check('SessionService: 派生缓存落盘到 cache/session-digests.json', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1400))
    const file = path.join(cacheDir, 'session-digests.json')
    assert.equal(existsSync(file), true, '缓存文件没有落盘')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; entries?: Record<string, unknown> }
    assert.equal(raw.version, 1)
    assert.ok(raw.entries && Object.keys(raw.entries).length >= 2, '缓存里没有两条会话证据')
  })

  console.log(`\nRESULT passed=${passed} failed=${failed}`)
  rmSync(dir, { recursive: true, force: true })
  if (failed > 0) process.exitCode = 1
}

await main()
