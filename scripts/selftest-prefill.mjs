#!/usr/bin/env node
/**
 * 预填/多工具边界 selftest 的 runner。
 *
 * 仓库没有测试框架；这里用 esbuild 把 TS 断言入口打成临时 ESM 再执行，
 * 不启动 Electron、不碰真实 pi/WorkBuddy 数据；临时目录用完即删。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tick-selftest-'))
const outfile = path.join(tmp, 'selftest.mjs')
try {
  await build({
    entryPoints: [path.join(root, 'scripts/selftest-prefill.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: ['node:*', 'electron'],
    absWorkingDir: root,
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
