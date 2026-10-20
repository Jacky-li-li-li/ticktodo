/**
 * review-tools —— 交叉评审用的只读探针：`node scripts/review-tools.mjs <toolId>`
 *
 * 只做四件事：detect / list / describe+usage（最多 3 条）/ resume（注入假终端，不真开窗口）。
 * 输出**恒为 JSON**（便于 jq / 独立方法交叉核对）；`--json` 仅为兼容保留，等价于默认行为。
 * 供多个 subagent 用**独立方法**（find/jq/sqlite3/python）核对适配器输出是否与工具侧原始数据一致。
 */

import { ClaudeAdapter, resolveSessionRoots } from '../packages/ai/claude/src/index.ts'
import { ClaudeDesktopAdapter } from '../packages/ai/claude-desktop/src/index.ts'
import { CodexAdapter } from '../packages/ai/codex/src/index.ts'
import { ClineAdapter } from '../packages/ai/cline/src/index.ts'
import { GrokAdapter } from '../packages/ai/grok/src/index.ts'
import { OmpAdapter } from '../packages/ai/omp/src/index.ts'
import { KimiAdapter } from '../packages/ai/kimi/src/index.ts'
import { OpenCodeAdapter, resolveOpenCodeDbPath } from '../packages/ai/opencode/src/index.ts'
import { ZCodeAdapter } from '../packages/ai/zcode/src/index.ts'
import { DshAdapter } from '../packages/ai/dsh/src/index.ts'
import { PiAdapter } from '../packages/ai/pi/src/index.ts'
import { WorkbuddyAdapter } from '../packages/ai/workbuddy/src/index.ts'
import { WorkbuddyAiAdapter } from '../packages/ai/workbuddy-ai/src/index.ts'
import { QoderAdapter, QODER_CN_DISTRO, QODER_DISTRO } from '../packages/ai/qoder/src/index.ts'
import type { AiToolAdapter } from '../packages/ai/core/src/index.ts'

/** 与下方 build() 的 switch 一一对应；新增工具时两处同步 */
const KNOWN_TOOL_IDS = [
  'pi',
  'claude',
  'claude-desktop',
  'qoder',
  'qoder-cn',
  'codex',
  'cline',
  'grok',
  'omp',
  'kimi',
  'opencode',
  'zcode',
  'dsh',
  'workbuddy',
  'workbuddy-ai',
] as const

const usage = (): never => {
  console.error(
    `usage: node scripts/review-tools.mjs <toolId> [--json]\n  toolId: ${KNOWN_TOOL_IDS.join(' | ')}`,
  )
  process.exit(2)
}

// --json 只是兼容别名（输出本来就是 JSON）；其余未知参数直接报 usage，避免静默忽略拼写错误
const args = process.argv.slice(2).filter((a) => a !== '--json')
const tool = args[0]
if (!tool || args.length > 1) usage()
if (!(KNOWN_TOOL_IDS as readonly string[]).includes(tool)) {
  console.error(`unknown toolId: ${tool}`)
  usage()
}

let terminal: unknown
const deps = {
  openTerminal: (spec: unknown) => {
    terminal = spec
  },
  clipboardWrite: () => undefined,
}

function build(id: string): AiToolAdapter {
  switch (id) {
    case 'pi': return new PiAdapter(deps)
    case 'claude': return new ClaudeAdapter({ ...deps, sessionRoots: () => resolveSessionRoots() })
    case 'claude-desktop': return new ClaudeDesktopAdapter({ ...deps, openUrl: () => undefined })
    case 'qoder': return new QoderAdapter(QODER_DISTRO, deps)
    case 'qoder-cn': return new QoderAdapter(QODER_CN_DISTRO, deps)
    case 'codex': return new CodexAdapter(deps)
    case 'cline': return new ClineAdapter(deps)
    case 'grok': return new GrokAdapter(deps)
    case 'omp': return new OmpAdapter(deps)
    case 'kimi': return new KimiAdapter(deps)
    case 'opencode':
      return new OpenCodeAdapter(
        {
          toolId: 'opencode', displayName: 'OpenCode', dbPath: resolveOpenCodeDbPath(),
          usageSource: 'session-row', exeName: 'opencode', resumeArgs: (sid) => ['--session', sid],
          desktopBundleId: 'ai.opencode.desktop', desktopBundleName: 'OpenCode.app',
        },
        deps,
      )
    case 'zcode': return new ZCodeAdapter(deps)
    case 'dsh': return new DshAdapter()
    case 'workbuddy': return new WorkbuddyAdapter({ openUrl: () => undefined })
    case 'workbuddy-ai': return new WorkbuddyAiAdapter({ openUrl: () => undefined })
    default: throw new Error(`unknown tool ${id}`)
  }
}

const adapter = build(tool)
const detected = await adapter.detect()
const list = (await adapter.listSessionInfos?.().catch((e: Error) => ({ error: e.message }))) as
  | Awaited<ReturnType<NonNullable<AiToolAdapter['listSessionInfos']>>>
  | { error: string }
const items = Array.isArray(list) ? list : []
const samples = []
for (const s of items.slice(0, 3)) {
  const info = await adapter.describeSession?.(s.sessionId, { withName: true }).catch(() => undefined)
  const usage = await adapter.computeUsage?.(s.sessionId).catch(() => undefined)
  samples.push({
    id: s.sessionId,
    cwd: s.cwd,
    name: s.name ?? null,
    firstMessage: s.firstMessage ?? null,
    lastMessage: info?.lastMessage ?? null,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt ?? null,
    resumable: s.resumable ?? null,
    filePath: s.filePath,
    tokens: usage ? usage.tokens : null,
    costReported: usage ? usage.costReported : null,
  })
}
let resume: unknown
if (items[0]) {
  resume = await adapter
    .resume(items[0].sessionId, { promptText: '', cwd: '/tmp', sessionId: items[0].sessionId, deliver: 'none' })
    .then(() => ({ ok: true, spec: terminal }))
    .catch((e: Error) => ({ ok: false, reason: e.message }))
}
const projects = await adapter.discoverProjects?.().catch(() => [])
console.log(
  JSON.stringify(
    {
      tool,
      detect: detected,
      capabilities: adapter.capabilities,
      listCount: items.length,
      listError: Array.isArray(list) ? null : list.error,
      firstSessionIds: items.slice(0, 8).map((s) => s.sessionId),
      samples,
      resume,
      projectCount: Array.isArray(projects) ? projects.length : null,
      projectSample: Array.isArray(projects) ? projects.slice(0, 5) : null,
    },
    null,
    2,
  ),
)
