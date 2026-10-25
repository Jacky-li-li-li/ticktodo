/**
 * paths — Claude Code CLI 的会话目录解析与轻量读取（只读 header / 元数据，不缓存正文）。
 *
 * 官方事实（code.claude.com/docs/en/claude-directory、/sessions）：
 *   - 会话正文：`~/.claude/projects/<编码 cwd>/<sessionId>.jsonl`
 *     `<编码 cwd>` = 工作目录路径里**非字母数字字符全部换成 `-`**（实测
 *     `/Users/jacky/Desktop/tick` → `-Users-jacky-Desktop-tick`；`/private/tmp/x` →
 *     `-private-tmp-x`）。超过 200 字符时截断并追加路径哈希，所以**目录名不反解**，
 *     cwd 一律取 jsonl 里的 `cwd` 字段。
 *   - 配置根可被 `CLAUDE_CONFIG_DIR` 覆盖（官方文档「Move storage off ~/.claude」）；
 *     `CLAUDE_CODE_PROJECT_DIR_NAME` 只改子目录名，不影响根。
 *   - 与 pi 不同：**没有首行 header**。第一行可能是 `queue-operation` / `mode` /
 *     `custom-title` 等元数据，`cwd` 出现在第一条带 `cwd` 的 user/assistant 行里
 *     （实测 2.1.302）。所以「只读首行」在这里不够，必须流式扫到第一个可用 cwd。
 *   - 子代理正文在 `projects/<project>/<sessionId>/subagents/**`、工具大输出在
 *     `tool-results/`；`*.jsonl.orphaned-*` / `*.jsonl.superseded-*` 是被挪走的旧稿，
 *     都不算主会话（不变量：子代理会话不并入主会话）。
 *   - 会话正文有 30 天保留期（`cleanupPeriodDays` 默认 30）——文件消失是正常事实，
 *     一律按 exists=false 表达，不做「猜它还在」。
 *
 * ⚠️ 绝不写 `~/.claude`：不创建目录、不改 settings.json、不碰 `.credentials.json` /
 * `~/.claude.json`（含 OAuth 与项目信任状态）。
 */

import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { realUserText } from '@tick/ai-core'

/** 一个会话根（目前只有一种来源；保留结构以便将来多根） */
export interface ClaudeSessionRoot {
  dir: string
  source: 'env' | 'default'
}

/**
 * 配置根：`CLAUDE_CONFIG_DIR` > `~/.claude`。
 * 只读：目录不存在时由调用方跳过，绝不 mkdir。
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? path.resolve(override) : path.join(home, '.claude')
}

/** 会话根列表（`<config>/projects`）；目录不存在返回空数组 */
export function resolveSessionRoots(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ClaudeSessionRoot[] {
  const configDir = resolveClaudeConfigDir(env, home)
  const dir = path.join(configDir, 'projects')
  if (!existsSync(dir)) return []
  return [{ dir, source: env.CLAUDE_CONFIG_DIR?.trim() ? 'env' : 'default' }]
}

/** 主会话文件命名：`<uuid>.jsonl`（subagents / tool-results 在子目录里，不在此列） */
const MAIN_SESSION_FILE_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

/**
 * 收集主会话 jsonl：只扫 `projects/<project>/` 一层，只认 `<uuid>.jsonl`。
 * 子目录（subagents / tool-results）、`.orphaned-*`、`.superseded-*` 一律不收。
 */
export function collectSessionFiles(root: string): string[] {
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return []
  }
  const files: string[] = []
  for (const project of projects) {
    const dir = path.join(root, project)
    let entries: string[]
    try {
      if (!statSync(dir).isDirectory()) continue
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!MAIN_SESSION_FILE_RE.test(name)) continue
      files.push(path.join(dir, name))
    }
  }
  return files
}

/** 文件名里的会话 id（不读文件；`<uuid>.jsonl` 之外返回 undefined） */
export function sessionIdOfFile(file: string): string | undefined {
  return MAIN_SESSION_FILE_RE.exec(path.basename(file))?.[1]
}

/** 按 sessionId 找主会话文件：先按目录名编码猜，再扫一层兜底（cwd 可能已改名/搬迁） */
export function findSessionFile(sessionId: string, roots: ClaudeSessionRoot[]): string | undefined {
  const fileName = `${sessionId}.jsonl`
  for (const root of roots) {
    let projects: string[]
    try {
      projects = readdirSync(root.dir)
    } catch {
      continue
    }
    for (const project of projects) {
      const candidate = path.join(root.dir, project, fileName)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 一条会话的轻量元数据（流式扫描产出；不含正文） */
export interface ClaudeSessionMeta {
  sessionId?: string
  /** 第一条带 cwd 的记录里的工作目录（官方口径：目录名不反解） */
  cwd?: string
  /** 首条 / 最后一条**真实** user 文本（合成消息已过滤） */
  firstUserText?: string
  lastUserText?: string
  /** 首条 user 记录时间（ms） */
  firstUserAt?: number
  /** 最后一条 user 记录时间（ms） */
  lastUserAt?: number
  /** 最后一条记录时间（ms），用于 lastUsedAt */
  lastEventAt?: number
  /** 最后一条 user/assistant 记录的类型（判断「末条是不是 assistant 终态」） */
  lastEventKind?: 'user' | 'assistant'
  /** 最后一条 assistant 记录的 `message.stop_reason`（end_turn / tool_use / …） */
  lastAssistantStopReason?: string
  /** 标题：`custom-title`（/rename 或 -n）> `ai-title`（自动生成）> `summary`（压缩摘要） */
  title?: string
  /** `type:"summary"` 的压缩摘要文本（只在没有前两种标题时用） */
  summaryTitle?: string
  /** `entrypoint`：cli / sdk-cli / claude-desktop / claude-desktop-3p …（未知一律原样保留） */
  entrypoint?: string
  /** `--session-id` / `-n` 之外，fork 出来的会话在首条 user 上带 parentUuid 链；这里只记来源会话 id */
  version?: string
  /**
   * 文件名的 id 与记录里的 `sessionId` 不一致（手拷 / 迁移 / `--fork-session` 残留）。
   * 两条通道（adapter 列表、MCP locator）要用**同一个**判据：不一致时一律不当成这条会话。
   */
  idMismatch?: boolean
}

/**
 * 头部扫描上限：单文件超过这个字节数只读头部 + 尾部（防 4MB+ 会话拖慢首帧）。
 * 头部足够拿到 cwd / 首条 user / 早期标题。
 */
const META_SCAN_MAX_BYTES = 8 * 1024 * 1024

/**
 * 头部读完之后再补读的尾部窗口。
 *
 * 为什么必须补：Claude Code 只往文件尾追加，`/rename`（`custom-title`）与最后一条 user
 * 消息都可能落在 8MB 之后。只读头会让大会话的标题停在自动标题、`lastMessage` 停在文件中段
 * （审查用 8.4MB 夹具复现：末尾额外的 `custom-title:"renamed late"` 与
 * `LAST QUESTION AFTER 8MB` 都读不到；`lastMessage` 正是时间线「上次停在哪」的数据源）。
 * 尾部结果按「物理上更靠后 = 更新」覆盖头读结果；2MB 只覆盖文件末尾的最新事实，
 * 不会把整份会话读进内存。
 */
const META_TAIL_BYTES = 2 * 1024 * 1024

/**
 * 头/尾窗口切点对齐时最多额外补读的字节数。
 *
 * 窗口切点若落在一条记录中间，那条记录两头都读不到（头窗口拿到半行、尾窗口从半行开始
 * 又被丢弃）——复核用 12.6MB 夹具复现过 `lastMessage` 退化成上一条。所以头窗口终点向后
 * 对齐到下一个换行、尾窗口起点向前对齐到上一个换行。实测 Claude Code 的单行长度
 * （`api-request-blob`）约 0.5MB 量级，4MB 已足够覆盖；超过这个上限的异常超长行仍按
 * 旧行为丢弃（不能让一条坏行把整份文件读进内存）。
 */
const META_ALIGN_MAX_BYTES = 4 * 1024 * 1024

/** `readSessionMeta` 的扫描选项 */
export interface ReadSessionMetaOptions {
  /**
   * 拿到 `cwd` 就停（`withName:false` 的 describeSession、resume 只需要 cwd）。
   * 不再扫到 8MB、也不补读尾部——这正是「withName:false 不得全量扫 jsonl」的落地。
   */
  stopAfterCwd?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只有这几类行参与元数据（其余行是 api-request / file-history / tool_result 等纯噪声） */
function lineMayCarryMeta(line: string): boolean {
  return (
    line.includes('"cwd"') ||
    line.includes('"custom-title"') ||
    line.includes('"ai-title"') ||
    line.includes('"summary"') ||
    // 兼容带空格的 JSON（Claude Code 自己写的是紧凑格式，但夹具/第三方包装可能带空格）
    line.includes('"role":"user"') ||
    line.includes('"role": "user"') ||
    line.includes('"role":"assistant"') ||
    line.includes('"role": "assistant"')
  )
}

/**
 * 流式读会话元数据（头部 + 尾部；不含正文）。
 *
 * 只解析必要字段：`type` / `cwd` / `sessionId` / `entrypoint` / `version` /
 * `timestamp` / `message.role` / `message.content` / `customTitle` / `aiTitle`。
 * `message.content` 只取 text 块拼出来的字符串，tool_result / thinking / 图片块全部丢弃
 * （正文不落 Tick 存储）。
 */
export async function readSessionMeta(
  file: string,
  opts: ReadSessionMetaOptions = {},
): Promise<ClaudeSessionMeta> {
  const meta: ClaudeSessionMeta = {}
  const size = statSync(file).size
  if (size === 0) return meta

  const scanLimit = Math.min(size, META_SCAN_MAX_BYTES)
  // 头窗口终点对齐到行尾：否则切点所在的那条记录被头窗口截成半行、又落在尾窗口之外，
  // 两端都读不到（12.6MB 夹具：最后一条 user 消息跨 8MB 切点时 lastMessage 退化成上一条）
  const headEnd = scanLimit >= size ? size : alignEndToLineEnd(file, scanLimit, size)
  let stopped = false
  await scanMetaRange(file, 0, headEnd, meta, () => {
    if (opts.stopAfterCwd && meta.cwd !== undefined) {
      stopped = true
      return 'stop'
    }
    return undefined
  })
  // 头读之后还有内容才补尾部；withName:false 的调用方不需要标题/末条消息
  if (!opts.stopAfterCwd && headEnd < size) {
    // 尾窗口起点向前对齐到行首：跨 2MB 切点的最后一条 user 消息必须整行读到
    const tailStart = Math.max(headEnd, alignStartToLineStart(file, size - META_TAIL_BYTES))
    await scanMetaRange(file, tailStart, size, meta, () => undefined)
  }

  const fileId = sessionIdOfFile(file)
  if (meta.sessionId && fileId && meta.sessionId.toLowerCase() !== fileId.toLowerCase()) {
    meta.idMismatch = true
  }
  return meta
}

/**
 * 头窗口终点向后对齐到下一个换行之后（`offset` 本身落在行首时原样返回）。
 * 找不到换行（异常超长行）或读失败时退回 `offset`：宁可丢一条坏行，也不整文件读入内存。
 */
function alignEndToLineEnd(file: string, offset: number, size: number): number {
  if (offset <= 0 || offset >= size) return offset
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    const limit = Math.min(size, offset + META_ALIGN_MAX_BYTES)
    for (let pos = offset; pos < limit; ) {
      const want = Math.min(chunk.length, limit - pos)
      const read = readSync(fd, chunk, 0, want, pos)
      if (read <= 0) break
      const newline = chunk.subarray(0, read).indexOf(0x0a)
      if (newline !== -1) return pos + newline + 1
      pos += read
    }
    return offset
  } catch {
    return offset
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 读失败已降级，关不掉不掩盖 */
      }
    }
  }
}

/**
 * 尾窗口起点向前对齐到最近一个换行之后（保证起点落在行首）。
 * 找不到换行（整个窗口里没有换行）时退回 0：从头读，最坏退化成多读一点。
 */
function alignStartToLineStart(file: string, offset: number): number {
  if (offset <= 0) return 0
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    for (let end = offset; end > 0; ) {
      const start = Math.max(0, end - chunk.length)
      const read = readSync(fd, chunk, 0, end - start, start)
      if (read <= 0) break
      const newline = chunk.subarray(0, read).lastIndexOf(0x0a)
      if (newline !== -1) return start + newline + 1
      end = start
    }
    return 0
  } catch {
    return offset
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 读失败已降级，关不掉不掩盖 */
      }
    }
  }
}

/** 窗口起点是否恰好落在行首（起点在行中间时会读到半行，必须先丢掉） */
function startsAtLineBoundary(file: string, offset: number): boolean {
  if (offset <= 0) return true
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(1)
    return readSync(fd, buf, 0, 1, offset - 1) === 1 && buf[0] === 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉就算了，读失败已经降级 */
      }
    }
  }
}

/**
 * 扫文件的一个字节窗口，逐行解析后交给 `applyMetaEvent`。
 * 尾读从窗口起点开始时可能落在行中间：丢掉首个半行（`for await` 的那半行 JSON.parse 必失败）。
 */
async function scanMetaRange(
  file: string,
  start: number,
  endExclusive: number,
  meta: ClaudeSessionMeta,
  afterLine: () => 'stop' | undefined,
): Promise<void> {
  if (endExclusive <= start) return
  const skipFirstLine = !startsAtLineBoundary(file, start)
  const stream = createReadStream(file, { encoding: 'utf8', start, end: endExclusive - 1 })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let first = true
  try {
    for await (const line of lines) {
      if (first) {
        first = false
        if (skipFirstLine) continue
      }
      if (!lineMayCarryMeta(line)) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue // 坏行/半行忽略（写入中的会话末行可能不完整）
      }
      if (!isRecord(event)) continue
      applyMetaEvent(meta, event)
      if (afterLine() === 'stop') return
    }
  } finally {
    stream.destroy()
  }
}

/**
 * 把一行记录里需要的字段并入 meta。
 *
 * 合并纪律：身份类字段（sessionId/cwd/entrypoint/version、首条 user）取**最早**的；
 * 覆盖类字段（标题、`lastUserText`、`lastEventAt`）取**最新**的——尾读天然比头读更新，
 * 所以后处理直接覆盖即可（Claude Code 只在文件尾追加，物理顺序就是时间顺序）。
 */
function applyMetaEvent(meta: ClaudeSessionMeta, event: Record<string, unknown>): void {
  if (meta.sessionId === undefined && typeof event.sessionId === 'string') {
    meta.sessionId = event.sessionId
  }
  if (meta.entrypoint === undefined && typeof event.entrypoint === 'string') {
    meta.entrypoint = event.entrypoint
  }
  if (meta.version === undefined && typeof event.version === 'string') {
    meta.version = event.version
  }
  if (meta.cwd === undefined && typeof event.cwd === 'string' && event.cwd) {
    meta.cwd = event.cwd
  }
  const at = parseTimestamp(event.timestamp)
  if (at !== undefined) meta.lastEventAt = at

  const type = event.type
  if (type === 'custom-title') {
    const title = event.customTitle
    // 用户可能多次 /rename：后出现的覆盖先出现的（尾读覆盖头读）
    if (typeof title === 'string' && title.trim()) meta.title = title.trim()
    return
  }
  if (type === 'ai-title') {
    // custom-title 优先：只有在还没有用户改名时才采用自动标题
    const title = event.aiTitle
    if (meta.title === undefined && typeof title === 'string' && title.trim()) {
      meta.title = title.trim()
    }
    return
  }
  if (type === 'summary') {
    // 压缩摘要（`/compact` 或自动 compact）也带一句 summary，可作标题兜底。
    // 优先级低于 ai-title：它是「这段话的摘要」，不是「这个会话的名字」。
    const summary = event.summary
    if (meta.summaryTitle === undefined && typeof summary === 'string' && summary.trim()) {
      meta.summaryTitle = summary.trim()
    }
    return
  }
  if (type === 'assistant') {
    // 时间线：记录末条 assistant 的终态（end_turn / stop_sequence = 干净结束；tool_use = 还在跑）
    meta.lastEventKind = 'assistant'
    const message = event.message
    if (isRecord(message) && typeof message.stop_reason === 'string') {
      meta.lastAssistantStopReason = message.stop_reason
    }
    return
  }
  if (type !== 'user') return // 用量单独算，这里只要 user 文本
  if (event.isSidechain === true) return // 子代理消息不并入主会话

  const message = event.message
  if (!isRecord(message) || message.role !== 'user') return
  // 合成消息：`isMeta`（本地命令输出/注入上下文）、`isCompactSummary`（压缩摘要）
  if (event.isMeta === true || event.isCompactSummary === true) return
  const text = userTextOf(message.content)
  if (!text) return
  if (meta.firstUserText === undefined) {
    meta.firstUserText = text
    meta.firstUserAt = at
  }
  meta.lastUserText = text
  meta.lastEventKind = 'user'
  if (at !== undefined) meta.lastUserAt = at
}

/**
 * Claude Code 特有、而 core 注入白名单（`@tick/ai-core` 的 `isInjectedUserText`）没覆盖的
 * 标签形态：IDE 集成会把「打开的文件 / 选中的片段」写成 `role=user` 的上下文。
 *
 * 依据等级：`<ide_opened_file>` 在 `scripts/selftest-prefill.ts` 里按注入处理；本机 7 份真实
 * 会话（2026-10-21）没有这类样本。除这些标签外一律**不再**「以 `<` 开头就丢」——用户真的会
 * 粘贴 `<div>…` / JSX / 代码片段，误杀用户内容比漏滤一条上下文严重得多（cross-team 统一口径）。
 */
const CLAUDE_INJECTED_TAG_PREFIXES = ['<ide_opened_file', '<ide_selection', '<ide_diagnostics']

/** 与 core 的 `startsWithTag` 同判据：标签名后必须是边界，避免 `<ide_selection` 吞掉 `<ide_selectionx` */
function isClaudeInjectedTag(text: string): boolean {
  const lower = text.toLowerCase()
  return CLAUDE_INJECTED_TAG_PREFIXES.some((tag) => {
    if (!lower.startsWith(tag)) return false
    const next = lower.charAt(tag.length)
    return next === '' || !/[a-z0-9_]/.test(next)
  })
}

/**
 * 从 user 消息的 content 里取**真实用户输入**：
 *  - 字符串形式直接用；
 *  - 数组形式只取 `type:"text"` 块（tool_result 是工具结果，不是用户说的话）；
 *  - 先剥掉 Claude Code 的本地命令/系统提醒包装（这是 claude 特有形制，core 只做前缀白名单，
 *    不负责剥包装）；剥完剩下的交给 core 的 `realUserText` 判注入。
 *
 * 为什么不再本地判「以 `<` 开头」：core 已把各工具已知注入形态收成白名单（`<command-*>`、
 * `<local-command-*>`、`<system…>`、`[Request interrupted by user…]`、
 * `Caveat: The messages below were generated` 等），复用同一份判据避免两套过滤漂移；
 * claude 特有但 core 没有的标签（`<ide_*>`）在本文件补充，**不反向改 core**。
 */
export function userTextOf(content: unknown): string | undefined {
  let raw: string
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    raw = content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('')
  } else return undefined
  if (!raw) return undefined

  const stripped = raw
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/gi, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/gi, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, '')
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .trim()
  if (!stripped) return undefined
  // claude 特有注入标签（core 白名单之外）先拦；其余交给 core 的统一判据
  if (isClaudeInjectedTag(stripped)) return undefined
  return realUserText(stripped)
}

/**
 * ISO 字符串 / epoch 数字 → ms；无效返回 undefined（时间戳单位写死在这里，不靠猜）。
 *
 * 数字只来自夹具/迁移数据（实测 Claude 写 ISO 字符串）。按数量级判断单位，避免旧实现
 * 「`value * 1000 > 1e12` 就把 <1e12 的 ms 值也乘 1000」把 1973–2001 年的数据推到 5xxx 年：
 *  - ≥ 1e11：ms（1973 年以后）；
 *  - 1e9..1e11：秒（2001 年以后）；
 *  - 更小：判无效（不是合理的时间戳）。
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e11) return value
    if (value >= 1e9) return value * 1000
    return undefined
  }
  if (typeof value !== 'string' || !value) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Claude Desktop 的 Code tab 写进 jsonl 的 `entrypoint`（2026-10-19 从 1.46388.4 的 app.asar
 * 核实：`["claude-desktop", "claude-desktop-3p"]`，由发行渠道决定）。
 *
 * 为什么放在这里：Desktop 与 CLI **共用同一份 jsonl**，只靠文件系统分不开，区分依据只有
 * 记录上的 entrypoint。CLI 适配器默认排除 Desktop 会话、Desktop 适配器只收 Desktop 会话，
 * 否则同一个会话会在「倒入历史会话」里出现两次。缺 entrypoint 的老记录一律算 CLI
 * （宁可少列也不重复：Desktop 的会话一定由 Desktop 写过，必然带 entrypoint）。
 */
export const DESKTOP_ENTRYPOINTS = ['claude-desktop', 'claude-desktop-3p'] as const

export function isDesktopEntrypoint(entrypoint: string | undefined): boolean {
  return entrypoint !== undefined && (DESKTOP_ENTRYPOINTS as readonly string[]).includes(entrypoint)
}

/**
 * 会话标题的最终取值：`custom-title`/`ai-title` > `summary`（压缩摘要）。
 * 单独一个函数，是因为列表（Summary）和详情（Info）都要用同一口径。
 */
export function sessionTitleOf(meta: Pick<ClaudeSessionMeta, 'title' | 'summaryTitle'>): string | undefined {
  return meta.title ?? meta.summaryTitle
}

/** 首条消息压成一行标题（去掉 markdown 标题/引用/代码围栏，超长截断） */
export function toSessionTitle(text: string | undefined, max = 80): string | undefined {
  if (!text) return undefined
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !line.startsWith('#') && !line.startsWith('>') && !line.startsWith('```'))
  if (!first) return undefined
  return first.length > max ? `${first.slice(0, max)}…` : first
}
