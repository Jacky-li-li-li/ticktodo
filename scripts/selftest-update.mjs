#!/usr/bin/env node
/**
 * 应用内更新 selftest 的 runner（断言入口：`scripts/selftest-update.ts`）。
 *
 * 不启动 Electron、不碰真实 app-update.yml / codesign / electron-updater；
 * esbuild 引导与其它脚本共用 `run-ts.mjs`。
 */
import { runTs } from './run-ts.mjs'

await runTs('scripts/selftest-update.ts', 'tick-selftest-update-')
