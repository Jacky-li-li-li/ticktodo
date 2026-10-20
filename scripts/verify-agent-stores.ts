/**
 * 逐个工具核对「会话检索逻辑」——可执行版（由 scripts/verify-agent-stores.mjs 打包运行）。
 *
 * 设计原则：
 *  1. **只读**：不写任何工具目录；不注入任何副作用出口（不需要终端/剪贴板/深链接）。
 *  2. **证据分级**：IMPL（有适配器，跑真实数据）/ STORE（只核对存储布局）/
 *     NOT-INSTALLED（本机没装）/ NO-SESSIONS（装了但本机确实没会话）。
 *  3. **不吞错**：`detect()` / `listSessionInfos()` / `describeSession()` / `computeUsage()` 抛错一律
 *     记 FAIL 并 exit 1 —— 这个脚本存在的意义就是发现「读不到」，而不是把它降级成「没数据」。
 *  4. 任何一项失败只影响该项，不中断整轮（工具之间互不牵连）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeAdapter, collectSessionFiles, resolveSessionRoots } from '../packages/ai/claude/src/index.ts'
import {
  ClaudeDesktopAdapter,
  collectDesktopSessions,
  findTranscriptInHome,
} from '../packages/ai/claude-desktop/src/index.ts'
import { CodexAdapter } from '../packages/ai/codex/src/index.ts'
import { ClineAdapter } from '../packages/ai/cline/src/index.ts'
import { GrokAdapter, collectGrokSessions } from '../packages/ai/grok/src/index.ts'
import { OmpAdapter, collectOmpSessions, resolveOmpAgentDir } from '../packages/ai/omp/src/index.ts'
import { KimiAdapter } from '../packages/ai/kimi/src/index.ts'
import {
  OpenCodeAdapter,
  listSessionRows,
  openStore,
  resolveOpenCodeDbPath,
  type OpenCodeIdentity,
} from '../packages/ai/opencode/src/index.ts'
import { ZCodeAdapter, zcodeIdentity } from '../packages/ai/zcode/src/index.ts'
import { DshAdapter, collectDshSessions } from '../packages/ai/dsh/src/index.ts'
import { QoderAdapter, QODER_CN_DISTRO, QODER_DISTRO } from '../packages/ai/qoder/src/index.ts'
import { PiAdapter, collectJsonlFiles, resolveSessionRoots as resolvePiSessionRoots } from '../packages/ai/pi/src/index.ts'

type Evidence = 'IMPL' | 'STORE' | 'NOT-INSTALLED' | 'NO-SESSIONS'

const home = os.homedir()
const rows: { tool: string; kind: Evidence; ok: boolean; detail: string }[] = []

function record(tool: string, kind: Evidence, ok: boolean, detail: string): void {
  rows.push({ tool, kind, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${kind}] ${tool.padEnd(14)} ${detail}`)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function count(dir: string, filter: (name: string) => boolean): number {
  try {
    return readdirSync(dir).filter(filter).length
  } catch {
    return 0
  }
}

function exists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/** 目录有内容 / 文件非空（用来判断「存储里有数据但列表为 0 条」这种解析回归） */
function hasContent(p: string): boolean {
  try {
    const st = statSync(p)
    if (st.isFile()) return st.size > 0
    if (!st.isDirectory()) return false
    return readdirSync(p).length > 0
  } catch {
    return false
  }
}

/** 目录里有非空文件（`<uuid>.jsonl` 的 0 字节僵尸不算会话，见 CLAUDE.md 不变量 3） */
function hasNonEmptyFile(dir: string, collect: (dir: string) => string[]): boolean {
  return collect(dir).some((file) => {
    try {
      return statSync(file).size > 0
    } catch {
      return false
    }
  })
}

/** OpenCode 身份（main 与「是否有会话」探针共用一份，避免两处配置漂移） */
const opencodeIdentity: OpenCodeIdentity = {
  toolId: 'opencode',
  displayName: 'OpenCode',
  dbPath: resolveOpenCodeDbPath(),
  usageSource: 'session-row',
  exeName: 'opencode',
  resumeArgs: (id) => ['--session', id],
}

/**
 * DB 类工具「真的有会话吗」：只读打开 store 后按**行数**判断，不能用「DB 文件非空」——
 * 刚初始化的 SQLite 文件有 header/表但 0 条会话，用文件大小会把「合法空库」误报成解析回归。
 */
async function hasOpenCodeSessions(identity: OpenCodeIdentity): Promise<boolean> {
  const opened = await openStore(identity, () => undefined)
  if (!opened) return false
  try {
    return listSessionRows(opened.db, identity, () => undefined).length > 0
  } catch {
    return false
  } finally {
    opened.cleanup()
  }
}

/**
 * Claude Desktop「真的有可读会话吗」：记录存在 ≠ 可读——Desktop 30 天清理 / `/clear` 会留下
 * 记录而正文已消失，此时 adapter 正确地返回 0 条，不应报解析回归。只有「记录能解析出正文」
 * （每会话 home 或全局 store 按 `cliSessionId` 命中）才算有数据。
 */
function hasReadableDesktopSessions(): boolean {
  const records = collectDesktopSessions(home)
  if (records.length === 0) return false
  const roots = resolveSessionRoots()
  return records.some((record) => {
    if (findTranscriptInHome(record.homeDir, record)) return true
    const ids = [record.cliSessionId, ...record.priorCliSessionIds].filter((id): id is string => Boolean(id))
    return ids.some((id) =>
      roots.some((root) =>
        collectSessionFiles(root.dir).some((file) => path.basename(file).toLowerCase() === `${id.toLowerCase()}.jsonl`),
      ),
    )
  })
}

/**
 * 各工具「数据根是否已有内容」的探针；只用于把「列表 0 条」区分成 NO-SESSIONS 与 FAIL。
 * 注意：必须用**工具自己的 collector / store 行数**（它包含「什么算一条会话」的过滤规则），不能只看
 * 目录/文件非空——否则 0 字节僵尸（pi/claude）、子代理 transcript（omp）、空会话（grok）、
 * 刚初始化的空 DB（opencode/zcode）、记录还在但正文被清理（claude-desktop）都会被误报成 FAIL。
 */
const storeHasData: Record<string, () => boolean | Promise<boolean>> = {
  pi: () => resolvePiSessionRoots().some((root) => hasNonEmptyFile(root.dir, collectJsonlFiles)),
  claude: () => resolveSessionRoots().some((root) => hasNonEmptyFile(root.dir, collectSessionFiles)),
  'claude-desktop': () => hasReadableDesktopSessions(),
  codex: () => hasContent(path.join(process.env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'sessions')),
  cline: () => hasContent(path.join(home, '.cline', 'data', 'sessions')),
  // grok 会过滤 `num_messages=0` 的空会话 → 只把「有 updates.jsonl 的会话」算作真实数据
  grok: () => collectGrokSessions().some((session) => Boolean(session.updatesPath)),
  // omp 会过滤会话目录里的子代理 transcript → 用 collector 判断是否还有主会话
  omp: () => collectOmpSessions().length > 0,
  kimi: () => hasContent(path.join(process.env.KIMI_HOME?.trim() || path.join(home, '.kimi-code'), 'sessions')),
  opencode: () => hasOpenCodeSessions(opencodeIdentity),
  zcode: () => hasOpenCodeSessions(zcodeIdentity()),
  // dsh 会过滤子代理会话 → 只算 delegationDepth === 0 的主会话
  dsh: () => collectDshSessions().some((session) => (session.header.delegationDepth ?? 0) === 0),
  qoder: () =>
    hasContent(path.join(process.env.QODER_CONFIG_DIR?.trim() || path.join(home, '.qoder'), 'projects')),
  'qoder-cn': () =>
    hasContent(path.join(process.env.QODERCN_CONFIG_DIR?.trim() || path.join(home, '.qoder-cn'), 'projects')),
}

/** 一条会话的通用不变量：id 非空、cwd 绝对（或明确为空）、filePath / files 存在（若给了） */
function checkInvariants(
  label: string,
  session: { sessionId: string; cwd?: string; filePath?: string; files?: string[] },
): string[] {
  const problems: string[] = []
  if (!session.sessionId) problems.push('sessionId 为空')
  if (session.cwd !== undefined && session.cwd !== '' && !path.isAbsolute(session.cwd)) {
    problems.push(`cwd 不是绝对路径: ${session.cwd}`)
  }
  if (session.filePath && !exists(session.filePath)) problems.push(`filePath 不存在: ${session.filePath}`)
  for (const file of session.files ?? []) {
    if (!exists(file)) problems.push(`files 里的路径不存在: ${file}`)
  }
  return problems.map((p) => `${label}: ${p}`)
}

// ---------------------------------------------------------------- 适配器（真实数据）
interface VerifiableAdapter {
  detect(): Promise<{ installed: boolean; reason?: string }>
  listSessionInfos?(): Promise<
    { toolId: string; sessionId: string; cwd: string; filePath: string; files?: string[]; resumable?: boolean }[]
  >
  describeSession?(
    id: never,
    opts?: { withName?: boolean },
  ): Promise<{ cwd?: string; filePath?: string; lastMessage?: string } | undefined>
  computeUsage?(id: never): Promise<{ tokens: { totalTokens: number } } | undefined>
}

/** 返回「真正验证到数据的会话条数」（0 = 本机没有可用数据） */
async function verifyAdapter(
  tool: string,
  adapter: VerifiableAdapter,
  opts: { storeHasData?: () => boolean | Promise<boolean> } = {},
): Promise<number> {
  let detected: { installed: boolean; reason?: string }
  try {
    detected = await adapter.detect()
  } catch (e) {
    // detect 崩溃是适配器 bug，不能被降级成「本机没装」
    record(tool, 'IMPL', false, `detect 抛错: ${errText(e)}`)
    return 0
  }
  if (!detected.installed) {
    record(tool, 'NOT-INSTALLED', true, `未检测到（${detected.reason ?? '—'}）→ 跳过真实数据核对`)
    return 0
  }
  if (!adapter.listSessionInfos) {
    record(tool, 'IMPL', false, '适配器未实现 listSessionInfos')
    return 0
  }
  let list: Awaited<ReturnType<NonNullable<VerifiableAdapter['listSessionInfos']>>>
  try {
    list = await adapter.listSessionInfos()
  } catch (e) {
    record(tool, 'IMPL', false, `列表抛错: ${errText(e)}`)
    return 0
  }
  if (list.length === 0) {
    const hintFn = opts.storeHasData ?? storeHasData[tool]
    const storeHint = hintFn ? await hintFn() : false
    record(
      tool,
      'NO-SESSIONS',
      !storeHint,
      storeHint
        ? '已安装且存储里有内容，但列表 0 条 → 疑似解析回归（不是「本机没数据」）'
        : '已安装但本机没有会话 → 仅按 magpie 设计',
    )
    return 0
  }

  const problems: string[] = []
  for (const session of list) problems.push(...checkInvariants(tool, session))

  // 详情 + 用量：抽第一条会话验证「能读且不崩」；抛错一律记 FAIL
  const sample = list[0]!
  let info: Awaited<ReturnType<NonNullable<VerifiableAdapter['describeSession']>>> = undefined
  if (adapter.describeSession) {
    try {
      info = await adapter.describeSession(sample.sessionId as never)
      if (!info) problems.push(`${tool}: describeSession 对列表里的会话返回 undefined`)
    } catch (e) {
      problems.push(`${tool}: describeSession 抛错: ${errText(e)}`)
    }
  }
  let usage: Awaited<ReturnType<NonNullable<VerifiableAdapter['computeUsage']>>> = undefined
  if (adapter.computeUsage) {
    try {
      usage = await adapter.computeUsage(sample.sessionId as never)
      // 空会话没有用量是正常的；返回 undefined 但没抛错 → 不记问题
    } catch (e) {
      problems.push(`${tool}: computeUsage 抛错: ${errText(e)}`)
    }
  }
  const head = `${list.length} 条会话；样本 ${sample.sessionId.slice(0, 13)} · ${sample.cwd || '(cwd 空)'} · last=${(info?.lastMessage ?? '—').slice(0, 24)} · usage=${usage ? usage.tokens.totalTokens : '—'}`
  record(
    tool,
    'IMPL',
    problems.length === 0,
    problems.length ? `${head} · ${problems.length} 个问题: ${problems.slice(0, 3).join('; ')}` : head,
  )
  return list.length
}

// ---------------------------------------------------------------- 主流程
async function main(): Promise<void> {
  console.log(`# verify-agent-stores  home=${home}\n`)

  // ===== 已有适配器：跑真实数据 =====
  let verified = 0
  verified += await verifyAdapter('pi', new PiAdapter())
  verified += await verifyAdapter('claude', new ClaudeAdapter({ sessionRoots: () => resolveSessionRoots() }))
  verified += await verifyAdapter(
    'claude-desktop',
    new ClaudeDesktopAdapter({ sessionRoots: () => resolveSessionRoots() }),
  )
  verified += await verifyAdapter('codex', new CodexAdapter())
  verified += await verifyAdapter('cline', new ClineAdapter())
  verified += await verifyAdapter('grok', new GrokAdapter())
  verified += await verifyAdapter('omp', new OmpAdapter())
  verified += await verifyAdapter('kimi', new KimiAdapter())
  verified += await verifyAdapter(
    'opencode',
    new OpenCodeAdapter(opencodeIdentity),
  )
  verified += await verifyAdapter('zcode', new ZCodeAdapter())
  verified += await verifyAdapter('dsh', new DshAdapter())
  // 两个发行版各自独立：装了就同样跑完整核对，不再只 detect 一下记 IMPL
  verified += await verifyAdapter('qoder', new QoderAdapter(QODER_DISTRO))
  verified += await verifyAdapter('qoder-cn', new QoderAdapter(QODER_CN_DISTRO))

  // ===== 尚无适配器：核对存储布局（magpie 的结论） =====
  const stores: { tool: string; dir: string; expect: string; probe: () => number }[] = [
    {
      tool: 'factory(droid)',
      dir: path.join(home, '.factory', 'sessions'),
      expect: 'sessions/<enc cwd>/<id>.jsonl（首行 session_start）',
      probe: () => count(path.join(home, '.factory', 'sessions'), () => true),
    },
    {
      tool: 'codebuddy',
      dir: path.join(home, '.codebuddy', 'projects'),
      expect: 'projects/<enc cwd>/<id>.jsonl（WorkBuddy 同格式）',
      probe: () => (exists(path.join(home, '.codebuddy', 'projects')) ? count(path.join(home, '.codebuddy', 'projects'), () => true) : 0),
    },
    {
      tool: 'cursor',
      dir: path.join(home, '.cursor', 'chats'),
      expect: 'chats/<md5(cwd)>/<chat id>/store.db（SQLite blob）',
      probe: () => (exists(path.join(home, '.cursor', 'chats')) ? count(path.join(home, '.cursor', 'chats'), () => true) : 0),
    },
    {
      tool: 'alma',
      dir: path.join(home, 'Library', 'Application Support', 'alma', 'chat_threads.db'),
      expect: 'SQLite：chat_threads / chat_messages',
      probe: () => (exists(path.join(home, 'Library', 'Application Support', 'alma', 'chat_threads.db')) ? 1 : 0),
    },
  ]
  for (const store of stores) {
    const n = store.probe()
    record(
      store.tool,
      n > 0 ? 'STORE' : 'NO-SESSIONS',
      true,
      `${n > 0 ? `${n} 个条目` : '无数据'} · ${store.expect} · 路径存在=${exists(store.dir)}`,
    )
  }

  // ===== 交叉核对：几个「magpie 说会这样」的具体事实 =====
  // 1) Codex：thread id 在文件名里（不需要读文件）
  const codexAdapter = new CodexAdapter()
  let codexList: Awaited<ReturnType<NonNullable<CodexAdapter['listSessionInfos']>>> = []
  try {
    codexList = (await codexAdapter.listSessionInfos()) ?? []
  } catch (e) {
    record('codex:文件名即 id', 'IMPL', false, `列表抛错: ${errText(e)}`)
  }
  if (codexList.length > 0) {
    const codexFileMatch = codexList.filter((s) => s.filePath.includes(s.sessionId)).length
    record(
      'codex:文件名即 id',
      'IMPL',
      codexFileMatch > 0,
      `${codexFileMatch}/${codexList.length} 条会话的文件名里带自己的 thread id`,
    )
  } else if (!rows.some((r) => r.tool === 'codex:文件名即 id')) {
    record('codex:文件名即 id', 'NO-SESSIONS', true, '本机没有 codex 会话样本')
  }

  // 2) omp：header 不是第一行（首行是 title）——直接验证我们为什么要特殊处理
  const ompDir = resolveOmpAgentDir()
  let ompFirstLineIsTitle = false
  try {
    const { readFileSync } = await import('node:fs')
    const walk = (dir: string, depth: number): string | undefined => {
      if (depth > 3) return undefined
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name)
        let isDir = false
        try {
          isDir = statSync(p).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          const hit = walk(p, depth + 1)
          if (hit) return hit
        } else if (name.endsWith('.jsonl') && statSync(p).size > 0) {
          return p
        }
      }
      return undefined
    }
    const sample = walk(path.join(ompDir, 'sessions'), 0)
    if (sample) ompFirstLineIsTitle = readFileSync(sample, 'utf8').slice(0, 200).includes('"type":"title"')
  } catch {
    /* 忽略：无样本时按 NO-SESSIONS 报 */
  }
  record(
    'omp:首行非 header',
    ompFirstLineIsTitle ? 'IMPL' : 'NO-SESSIONS',
    true,
    ompFirstLineIsTitle
      ? '首行是 {"type":"title"}（pi 的「只读首行」在这里会失败 → 已单独处理）'
      : '无样本',
  )

  // 3) Claude Desktop：本机的 local_<id> 记录 → 正文解析（adopt 的 CLI 会话正文在全局 store）
  const desktopRecords = collectDesktopSessions()
  record(
    'claude-desktop:own-store',
    desktopRecords.length > 0 ? 'IMPL' : 'NO-SESSIONS',
    true,
    `${desktopRecords.length} 条 local_<id> 记录` +
      (desktopRecords.length
        ? `；样本 ${desktopRecords[0]!.localId.slice(0, 20)} cli=${(desktopRecords[0]!.cliSessionId ?? '—').slice(0, 8)} archived=${desktopRecords[0]!.archived}`
        : '（0 = 本机没用过 Code tab，按 asar + magpie 设计）'),
  )

  // 4) Grok：本机会话有没有 updates.jsonl（没有 → 只能验 summary）
  const grokSessions = collectGrokSessions()
  const grokWithUpdates = grokSessions.filter((s) => s.updatesPath).length
  record(
    'grok:updates 样本',
    grokSessions.length > 0 ? 'IMPL' : 'NO-SESSIONS',
    true,
    `${grokSessions.length} 个会话，其中 ${grokWithUpdates} 个有 updates.jsonl（0 = 消息/用量只能按 magpie 设计）`,
  )

  // ===== 汇总 =====
  const fail = rows.filter((r) => !r.ok).length
  const impl = rows.filter((r) => r.kind === 'IMPL').length
  const store = rows.filter((r) => r.kind === 'STORE').length
  const noSessions = rows.filter((r) => r.kind === 'NO-SESSIONS').length
  const notInstalled = rows.filter((r) => r.kind === 'NOT-INSTALLED').length
  console.log(
    `\nRESULT impl=${impl} store=${store} no-sessions=${noSessions} not-installed=${notInstalled} verified=${verified} fail=${fail}`,
  )
  if (fail > 0) process.exitCode = 1
}

await main()
