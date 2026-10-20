#!/usr/bin/env node
/**
 * 预填/多工具边界 selftest 的 runner（断言入口：`scripts/selftest-prefill.ts`）。
 *
 * 不启动 Electron、不碰真实 pi/WorkBuddy 数据；esbuild 引导与其它脚本共用 `run-ts.mjs`。
 */
import { runTs } from './run-ts.mjs'

await runTs('scripts/selftest-prefill.ts', 'tick-selftest-')
