#!/usr/bin/env node
/**
 * 时间线 P0-1..P0-6 selftest 的 runner（断言入口：`scripts/selftest-timeline.ts`）。
 * 不启动 Electron、不碰真实数据；esbuild 引导复用 `run-ts.mjs`。
 */
import { runTs } from './run-ts.mjs'

await runTs('scripts/selftest-timeline.ts', 'tick-selftest-timeline-')
