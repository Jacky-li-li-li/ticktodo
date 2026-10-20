#!/usr/bin/env node
/**
 * 把 `scripts/*.ts` 用 esbuild 临时打包成单文件 ESM 再执行（仓库没有测试框架）。
 *
 * 为什么抽出来：selftest / verify / review 三个入口原本各自复制了一份 esbuild 引导，
 * 参数一改就要同步三四份。这里只保留一份，其余 `.mjs` 只负责「选入口 + temp 前缀」。
 *
 * 用法（CLI）：`node scripts/run-ts.mjs <entry.ts> [tmpPrefix]` —— 之后的参数会被转发给入口脚本
 * （例如 `node scripts/run-ts.mjs scripts/review-tools.ts tick-review- pi`）。
 * 用法（import）：`await runTs('scripts/review-tools.ts', 'tick-review-')` —— 此时不消费 argv。
 *
 * 临时目录用完即删（包括入口脚本自己 `process.exit()` 的情况：注册一次 exit 兜底清理）；
 * 被执行的 TS 自身负责「不碰真实数据」——本工具不做任何数据隔离。
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

/**
 * @param {string} entry 相对仓库根的入口（如 'scripts/review-tools.ts'）
 * @param {string} [tmpPrefix] 临时目录前缀，便于排查残留
 */
export async function runTs(entry, tmpPrefix = 'tick-run-ts-') {
  const tmp = mkdtempSync(path.join(os.tmpdir(), tmpPrefix))
  const outfile = path.join(tmp, 'bundle.mjs')
  // 入口脚本可能自己 process.exit()（usage / 断言失败），finally 不保证执行 → 用 exit 钩子兜底清理
  const cleanup = () => rmSync(tmp, { recursive: true, force: true })
  process.once('exit', cleanup)
  try {
    await build({
      entryPoints: [path.resolve(root, entry)],
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
    process.removeListener('exit', cleanup)
    cleanup()
  }
}

// 作为脚本直接运行时：`node scripts/run-ts.mjs <entry.ts> [tmpPrefix] [entry args...]`
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [, , entry, tmpPrefix, ...entryArgs] = process.argv
  if (!entry) {
    console.error('usage: node scripts/run-ts.mjs <entry.ts> [tmpPrefix] [entry args...]')
    process.exit(2)
  }
  // 入口脚本按「自己的 args」读 process.argv[2]，所以先把 runner 自己的参数摘掉
  process.argv = [process.argv[0], process.argv[1], ...entryArgs]
  await runTs(entry, tmpPrefix)
}
