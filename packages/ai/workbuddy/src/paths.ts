/**
 * paths — WorkBuddy 的 App / 数据根 / 会话路径解析（两个发行版共用规则）。
 *
 * 只读边界（PRD §9.7 / §9B.5）：本模块只碰两类东西——
 *   1) `/Applications|~/Applications/<bundle>.app/Contents/Info.plist`（安装与版本探测）；
 *   2) `<root>/workbuddy.db*` 与 `<root>/projects/<编码 cwd>/<id>.jsonl`（会话数据）。
 * 绝不读 settings.json / keyblob / device-id / security/ / models.json 等认证或配置文件。
 *
 * 实测事实（docs/workbuddy-adapter-notes.md §2 / §10.8）：
 *   - projects 目录名 = cwd 去掉首个 `/`，其余 `/` `\` `:` 换成 `-`；**空格原样保留**
 *     （所以 `.../WorkBuddy AI` 的目录名里带空格，不能用「把空白换成 -」之类的猜法）；
 *   - 会话文件名 `<id>.jsonl`（id 即 DB 里的 UUID，也是深链接参数）；
 *   - `*.ndjson`（file-rollback）、`<id>/tool-results/**`、`<id>/subagents/**` 都不是主会话消息流。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { WorkbuddyAdapterDeps, WorkbuddyIdentity } from './types'

/** App bundle 搜索根：默认系统级 + 用户级，可被 deps.appDirs 整体覆盖 */
export function appSearchDirs(deps: Pick<WorkbuddyAdapterDeps, 'appDirs'> = {}): string[] {
  if (deps.appDirs && deps.appDirs.length > 0) return deps.appDirs
  return ['/Applications', path.join(homedir(), 'Applications')]
}

/** 该发行版的 App bundle 绝对路径候选（存在性另判） */
export function appBundleCandidates(
  identity: WorkbuddyIdentity,
  deps: Pick<WorkbuddyAdapterDeps, 'appDirs'> = {},
): string[] {
  return appSearchDirs(deps).map((dir) => path.join(dir, identity.appBundleName))
}

/** App bundle 内 Info.plist 路径 */
export function infoPlistPath(appBundle: string): string {
  return path.join(appBundle, 'Contents', 'Info.plist')
}

/**
 * 数据根解析：用户配置（deps.rootDir）> 该发行版自己的环境变量 > 默认 `~/<name>`。
 *
 * 只读：不创建任何目录（数据根不存在时后续读取自然降级为空）。
 * 国际版没有 envRootVar → 不吃国内版的 `WORKBUDDY_CONFIG_DIR`（两个 build 各管各的）。
 */
export function resolveRootDir(
  identity: WorkbuddyIdentity,
  deps: Pick<WorkbuddyAdapterDeps, 'rootDir'> = {},
): string {
  if (deps.rootDir && deps.rootDir.trim()) return path.resolve(deps.rootDir)
  const envValue = identity.envRootVar ? process.env[identity.envRootVar] : undefined
  if (envValue && envValue.trim()) return path.resolve(envValue.trim())
  return path.join(homedir(), identity.defaultRootName)
}

/** `<root>/workbuddy.db`（WAL 库本体；另有 -wal / -shm） */
export function dbFilePath(rootDir: string): string {
  return path.join(rootDir, 'workbuddy.db')
}

/** `<root>/projects`（每个编码 cwd 一个子目录） */
export function projectsDir(rootDir: string): string {
  return path.join(rootDir, 'projects')
}

/**
 * cwd 编码：去掉开头的 `/`（或 `\`），其余 `/` `\` `:` 一律换成 `-`。
 * 实测样本：`/Users/x/Desktop/tick` → `Users-x-Desktop-tick`；
 * `.../WorkBuddy AI-2026-10-18` 里的空格保留。
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/^[/\\]/, '')
    .replace(/[/\\]+$/, '') // DB 里的 cwd 可能带尾随分隔符，编码前先去掉，否则会多出末尾 '-'
    .replace(/[/\\:]/g, '-')
}

/** 会话 id 是否是可以安全拼进文件名的普通字符串（DB 里恒为 UUID；防御路径穿越） */
export function isPlainSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')
}

/** 由 DB 的 cwd 推算会话 jsonl 期望路径（文件可能不存在；导出/定位仍需要它） */
export function expectedTranscriptPath(rootDir: string, cwd: string, id: string): string {
  return path.join(projectsDir(rootDir), encodeCwd(cwd), `${id}.jsonl`)
}

/** 单会话消息流的解析结果（exists 是 stat 事实，不是猜的） */
export interface ResolvedTranscript {
  /** 实际找到的路径；找不到时为「推算路径」（供导出/定位展示）；id 不安全时为 '' */
  filePath: string
  exists: boolean
  size?: number
  mtimeMs?: number
  /**
   * 实际采用的 cwd：DB cwd 可用时就是它；为空/不绝对时可能来自 `<id>.meta.json` 兜底
   * （旧历史导入会话，PRD §9.1）。
   */
  cwd?: string
}

/**
 * 定位会话 jsonl：
 *   1) 先用 DB 的 cwd 编码直读（主路径，不扫目录）；
 *   2) 找不到再扫 `projects/<一层>/<id>.jsonl` 兜底（旧历史导入会话的 DB cwd 可能为空/不匹配）；
 *   3) DB cwd 不可用时用同目录 `<id>.meta.json` 的 cwd 兜底（本机样本 0 个，PRD §9.1）；
 *   4) 都不命中时仍返回推算路径（exists=false），让 UI 能显示「文件不在了」的原始位置。
 *
 * 只扫一层：`<id>/subagents/*.jsonl` 是子代理会话，不并入主会话（PRD §9.1）。
 */
export function resolveTranscript(rootDir: string, cwd: string, id: string): ResolvedTranscript {
  if (!isPlainSessionId(id)) return { filePath: '', exists: false }
  const projects = projectsDir(rootDir)
  // DB 里的相对路径/空值不能当绝对路径用，先判绝对；不可用才去读 meta.json（别为每行多读文件）
  const usableCwd = cwd && path.isAbsolute(cwd) ? cwd : undefined
  const recoveredCwd = usableCwd ?? readMetaCwd(rootDir, id)
  const guess = recoveredCwd ? expectedTranscriptPath(rootDir, recoveredCwd, id) : undefined

  if (guess) {
    const stat = statOrUndefined(guess)
    if (stat) {
      return { filePath: guess, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, cwd: recoveredCwd }
    }
  }

  const found = scanProjectsForSession(projects, id)
  if (found) {
    const stat = statOrUndefined(found)
    if (stat) {
      return { filePath: found, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, cwd: recoveredCwd }
    }
  }

  if (guess) return { filePath: guess, exists: false, cwd: recoveredCwd }
  // cwd 不可用又没扫到：给一个「扁平」位置占位，仅用于展示，不据此读写
  return { filePath: path.join(projects, `${id}.jsonl`), exists: false }
}

/**
 * `<id>.meta.json` 的 cwd 兜底：旧历史导入会话的 DB cwd 可能为空，但项目目录里留了这一份元数据。
 * 只扫 `projects/<一层>/<id>.meta.json`，读失败/值不绝对一律当没有（不抛）。
 */
export function readMetaCwd(rootDir: string, id: string): string | undefined {
  if (!isPlainSessionId(id)) return undefined
  const projects = projectsDir(rootDir)
  let entries: string[]
  try {
    entries = readdirSync(projects)
  } catch {
    return undefined
  }
  const fileName = `${id}.meta.json`
  for (const name of entries) {
    const file = path.join(projects, name, fileName)
    if (!existsSync(file)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (isRecord(parsed)) {
        const cwd = parsed.cwd
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) return cwd
      }
    } catch {
      /* 坏文件/半行：忽略，继续找 */
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scanProjectsForSession(projectsRoot: string, id: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(projectsRoot)
  } catch {
    return undefined
  }
  const fileName = `${id}.jsonl`
  for (const name of entries) {
    const dir = path.join(projectsRoot, name)
    const candidate = path.join(dir, fileName)
    if (existsSync(candidate)) {
      try {
        if (statSync(dir).isDirectory()) return candidate
      } catch {
        /* 目录刚消失：继续 */
      }
    }
  }
  return undefined
}

function statOrUndefined(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const st = statSync(file)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * 读 Info.plist 顶层字符串值（只用于探测安装/版本）。
 *
 * `.app` 的 Info.plist 可能是 XML 也可能是二进制 plist：
 *   - XML：直接正则取 `<key>K</key><string>V</string>`（无依赖）；
 *   - 二进制：交给 macOS 自带的 `/usr/bin/plutil -convert json -o -`（只读，不落盘）。
 * 读不到/解析失败一律返回 undefined，由 detect() 决定文案。
 */
export async function readPlistString(plistPath: string, key: string): Promise<string | undefined> {
  let buf: Buffer
  try {
    buf = readFileSync(plistPath)
  } catch {
    return undefined
  }
  if (buf.subarray(0, 6).toString('latin1') !== 'bplist') {
    const xml = buf.toString('utf8')
    const re = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<(?:string|integer)>([^<]*)</(?:string|integer)>`)
    const hit = re.exec(xml)
    const value = hit?.[1]?.trim()
    if (value) return value
  }

  // 二进制 plist，或 XML 里没匹配到（键缺失/值不是字符串）→ 交给 macOS 自带 plutil 再试一次
  return readPlistViaPlutil(plistPath, key)
}

async function readPlistViaPlutil(plistPath: string, key: string): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      plistPath,
    ])
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    const value = parsed[key]
    if (typeof value === 'string') return value
    if (typeof value === 'number') return String(value)
    return undefined
  } catch {
    return undefined
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
