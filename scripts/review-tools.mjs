#!/usr/bin/env node
/** 打包执行 `scripts/review-tools.ts`（只读探针；esbuild 引导见 `run-ts.mjs`） */
import { runTs } from './run-ts.mjs'

await runTs('scripts/review-tools.ts', 'tick-review-')
