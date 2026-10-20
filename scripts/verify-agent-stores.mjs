#!/usr/bin/env node
/**
 * verify-agent-stores — 逐个工具核对「会话检索逻辑」在本机的真实情况
 * （探针入口：`scripts/verify-agent-stores.ts`；esbuild 引导见 `run-ts.mjs`）。
 *
 * 证据分级（互不冒充）：
 *   • IMPL         ：有适配器 → 直接调 adapter，跑列表/详情/用量并断言不变量
 *   • STORE        ：尚无适配器 → 只探测存储布局（存在性/数量），核对 magpie 的路径结论
 *   • NOT-INSTALLED：本机没装该工具 → 明确跳过
 *   • NO-SESSIONS  ：已安装但本机确实没有会话（若存储里明明有内容却列出 0 条 → FAIL）
 *
 * 只读：不写任何工具目录。用法：`node scripts/verify-agent-stores.mjs`
 */
import { runTs } from './run-ts.mjs'

await runTs('scripts/verify-agent-stores.ts', 'tick-verify-')
