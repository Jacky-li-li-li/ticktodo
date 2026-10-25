/**
 * 终端脚本生成行为测试：转义、env 透传。
 * TICK_HOME 注入的回归点：Tick 用自定义数据根时，终端里的 extension 必须看到同一个根
 * （Terminal 的环境来自用户 shell，不是 Tick 进程）。
 * .mts 后缀：apps/desktop 不是 ESM 包，显式按模块跑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createTerminalLauncher, renderTerminalScript, shellQuote } from '../src/main/services/terminal-launch.ts'

test('shellQuote: 单引号/空格/中文都安全', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`)
  assert.equal(shellQuote('a b/c 你好'), `'a b/c 你好'`)
  const script = renderTerminalScript({
    cwd: '/tmp/a b',
    executable: '/bin/echo',
    args: ["it's", '--flag'],
  })
  assert.ok(script.includes(`cd '/tmp/a b' || exit 1`))
  assert.ok(script.includes(`exec '/bin/echo' 'it'\\''s' '--flag'`))
})

test('renderTerminalScript: env 按 export 行输出；adapter 传入的 env 优先', () => {
  const script = renderTerminalScript({
    cwd: '/x',
    executable: 'pi',
    args: [],
    env: { TICK_HOME: '/from-adapter' },
  })
  assert.ok(script.includes(`export TICK_HOME='/from-adapter'`))
})

test('createTerminalLauncher: TICK_HOME 设置时写进脚本', async () => {
  const prev = process.env.TICK_HOME
  process.env.TICK_HOME = '/tmp/tick-custom-home'
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-launch-'))
    const captured: string[] = []
    const launch = createTerminalLauncher(dir, async (file) => {
      captured.push(fs.readFileSync(file, 'utf8'))
    })
    await launch({ cwd: os.homedir(), executable: 'pi', args: [] })
    assert.equal(captured.length, 1)
    assert.ok(captured[0]?.includes(`export TICK_HOME='/tmp/tick-custom-home'`))
  } finally {
    if (prev === undefined) delete process.env.TICK_HOME
    else process.env.TICK_HOME = prev
  }
})

test('createTerminalLauncher: open 失败时清理脚本并抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-launch-fail-'))
  const launch = createTerminalLauncher(dir, async () => {
    throw new Error('open 失败')
  })
  await assert.rejects(() => launch({ cwd: os.homedir(), executable: 'pi', args: [] }), /打开终端失败/)
  assert.deepEqual(fs.readdirSync(dir), [], '失败脚本要删掉')
})
