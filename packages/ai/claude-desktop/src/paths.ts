/**
 * paths — Claude Desktop（Claude.app）的安装探测与会话可见性判定。
 *
 * 官方事实（code.claude.com/docs/en/desktop、/deep-links）：
 *   - App bundle id `com.anthropic.claudefordesktop`；`claude://` scheme。
 *   - Desktop 与 CLI 跑同一引擎。**被 Desktop adopt 的 CLI 会话**正文仍在 `~/.claude/projects`
 *     （文档「Desktop continues the same session rather than a copy」）；**Desktop 自己的会话**
 *     另有每会话 home，见 `desktop-store.ts`。
 *   - 深链接（2026-10-19 在 1.46388.4 的 app.asar 里逐条核对）：
 *       claude://code/new?folder=<绝对路径>&q=<URL 编码文案>[&source=…]
 *           → Code tab 新建会话页，folder 选项目、q 预填输入框（**不发送**）
 *       claude://resume?session=<CLI 会话 UUID>
 *           → 把一条 CLI 会话导入并打开（失败 toast 分 auth/network/transcript_missing）
 *       claude://code/continue?session=last|local_<id>、claude://code/needs-input?session=<id>
 *           → 继续最近一条 / 打开某条 Desktop 本地会话（只认 Desktop 自己的 `local_` id）
 *   - 深链接的 q 参数在 Desktop 侧按 **14336 字符**截断（`OA=14336`，按码元 slice）。
 *
 * ⚠️ 只读边界：本模块只碰 `Claude.app/Contents/Info.plist` 与
 * `~/Library/Application Support/Claude` 的**存在性**（判断有没有登录过）。
 * 不读 IndexedDB / Local Storage / cookies / config.json 内容 / OAuth 缓存。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { desktopDataDirs } from './desktop-store'

/** Claude Desktop 的固定身份（与 CLI 适配器完全独立：两个 toolId、两份缓存） */
export const CLAUDE_DESKTOP_IDENTITY = {
  toolId: 'claude-desktop',
  bundleId: 'com.anthropic.claudefordesktop',
  appBundleName: 'Claude.app',
  scheme: 'claude',
} as const

/**
 * App bundle 搜索根：系统级 + 用户级（`open -Ra Claude` 会同时看这两处）。
 * `home` 可注入（测试隔离），不能只吃进程的 `homedir()`。
 */
export function appSearchDirs(home = homedir()): string[] {
  return ['/Applications', path.join(home, 'Applications')]
}

export function appBundleCandidates(appDirs?: string[], home = homedir()): string[] {
  return (appDirs && appDirs.length > 0 ? appDirs : appSearchDirs(home)).map((dir) =>
    path.join(dir, CLAUDE_DESKTOP_IDENTITY.appBundleName),
  )
}

export function infoPlistPath(appBundle: string): string {
  return path.join(appBundle, 'Contents', 'Info.plist')
}

/**
 * LaunchServices 兜底：用 `mdfind` 按 bundle id 找 `.app` 的真实位置。
 *
 * 为什么需要：App 不一定装在 `/Applications` 正下方（本机就在 `/Applications/APP/Claude.app`）。
 * 静态目录列表只能覆盖「常见位置」，找一个装到子目录/别的盘的用户就永远「未检测到」。
 * Claude Code 自己探测终端时也是用 `mdfind kMDItemCFBundleIdentifier == …` 的做法。
 *
 * 约束：带 1.5s 超时、只取第一条、**仍然校验 Info.plist 的 bundle id**（不信任索引）；
 * 任何失败一律返回 undefined（宁可报未安装，不猜）。
 */
export async function findAppBundleByBundleId(bundleId: string): Promise<string | undefined> {
  const { execFile } = await import('node:child_process')
  const query = `kMDItemCFBundleIdentifier == '${bundleId}'`
  return new Promise<string | undefined>((resolve) => {
    execFile(
      '/usr/bin/mdfind',
      [query],
      { timeout: 1500, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined)
          return
        }
        const first = stdout
          .split('\n')
          .map((line) => line.trim())
          .find((line) => line.endsWith('.app') && existsSync(line))
        resolve(first)
      },
    )
  })
}

/** Desktop 的 userData 根（`~/Library/Application Support/Claude`） */
export function desktopUserDataDir(home = homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude')
}

/**
 * 读 Info.plist 顶层字符串值。
 *
 * 与 WorkBuddy 适配器同一套做法：XML 直接正则取，二进制 plist 交给系统 `plutil`
 * （只读、不落盘）。读不到一律 undefined，由 detect() 决定文案。
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
    const re = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`)
    const hit = re.exec(xml)
    return hit?.[1]?.trim() || undefined
  }
  const { execFile } = await import('node:child_process')
  return new Promise<string | undefined>((resolve) => {
    execFile(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', plistPath],
      { timeout: 1500, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        try {
          const parsed: unknown = JSON.parse(stdout)
          if (parsed && typeof parsed === 'object') {
            const value = (parsed as Record<string, unknown>)[key]
            resolve(typeof value === 'string' ? value : undefined)
          } else resolve(undefined)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}

/**
 * Desktop 是否**登录过**（决定 `claude://resume` 能不能用）。
 *
 * 只看两个目录/文件是否存在，不读内容：
 *   - `<userData>/local-agent-mode-sessions`：Desktop 自己的本地会话存储根；
 *   - `<userData>/config.json`：登录态缓存（存在即说明启动过并写过配置）。
 * 两者都没有 = 刚装上还没登录 → resume 会失败（官方 toast: sign in），所以提前拦。
 */
export function desktopLooksSignedIn(home = homedir()): boolean {
  // 两个 profile 都要看：实测本机的 Code tab 会话记在 **Claude-3p**（第三方网关部署模式）下，
  // 只查 `Application Support/Claude` 会把「明明登录过」误判成没登录。
  // 数据根列表复用 desktop-store 的一份实现（新增第三种 profile 时不会只改一处）。
  for (const root of desktopDataDirs(home)) {
    try {
      if (existsSync(path.join(root, 'local-agent-mode-sessions'))) return true
      if (existsSync(path.join(root, 'claude-code-sessions'))) return true
      if (existsSync(path.join(root, 'config.json'))) return true
    } catch {
      /* 读不到就当没有 */
    }
  }
  return false
}

/**
 * Desktop 的 Code tab 写进 jsonl 的 `entrypoint` 过滤在 `@tick/ai-claude` 的 paths.ts 里
 * （与读取内核放在一起，避免两边各写一份常量）。
 */
export { DESKTOP_ENTRYPOINTS, isDesktopEntrypoint } from '@tick/ai-claude'

/** 判断一个路径是否是可用的绝对目录（深链接 folder 参数要求） */
export function isUsableDirectory(cwd: string): boolean {
  if (!cwd || !path.isAbsolute(cwd)) return false
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/**
 * Desktop 侧对 q 的硬截断（app.asar 里 `OA=14336`，按 UTF-16 码元 slice）。
 * 这里按**码点**截断并留出 URL 编码膨胀的余量，避免把 emoji 劈成半个代理对。
 */
export const DESKTOP_Q_MAX = 14336
/** 整条 URL 的安全上限：LaunchServices 对超长 URL 会静默失败，宁可在 Tick 侧先截断并如实返回 */
export const DESKTOP_URL_MAX = 12000

export interface NewSessionLinkResult {
  url: string
  truncated: boolean
  /**
   * true = 连 `folder` 本体都塞不进安全长度（cwd 超长），q 已裁到 0 仍超限。
   * 调用方必须如实报错：这条 URL 会被 LaunchServices 静默丢弃，不能发出去假装成功。
   */
  overLimit?: boolean
}

/**
 * 构造 `claude://code/new?folder=…&q=…`。
 * 手工 encodeURIComponent（空格 → %20，比 URLSearchParams 的 `+` 对第三方解析更稳）。
 *
 * 隐私边界：prompt 全文与 cwd 会进入深链接 URL，交给 LaunchServices / Claude.app 处理，
 * 可能出现在系统或 App 日志里；Tick 自身不记录这些内容（与 WorkBuddy task 深链接同口径）。
 */
export function buildNewSessionUrl(promptText: string, cwd: string): NewSessionLinkResult {
  const build = (text: string): string =>
    `${CLAUDE_DESKTOP_IDENTITY.scheme}://code/new?folder=${encodeURIComponent(cwd)}&q=${encodeURIComponent(text)}`
  const chars = Array.from(promptText)
  // Desktop 自己会在 14336 处截断；这里先按同一上限裁，避免「看起来传全了其实被砍」
  let take = Math.min(chars.length, DESKTOP_Q_MAX)
  let truncated = take < chars.length
  let url = build(chars.slice(0, take).join(''))
  if (url.length > DESKTOP_URL_MAX) {
    truncated = true
    take = Math.max(1, Math.floor(take * (DESKTOP_URL_MAX / url.length)) - 2)
    url = build(`${chars.slice(0, take).join('')}…`)
    while (url.length > DESKTOP_URL_MAX && take > 0) {
      take = Math.max(0, take - 10)
      url = build(`${chars.slice(0, take).join('')}…`)
    }
  }
  // q 已经裁到 0 仍超限 = folder 本身太长（folder 不能截断，截断会指向不存在的目录）：
  // 如实标记给上层报错，不发一条注定被丢弃的深链接
  if (url.length > DESKTOP_URL_MAX) return { url, truncated: true, overLimit: true }
  return { url, truncated }
}

/** 构造 `claude://resume?session=<cliSessionId>`（把一条 CLI 会话导入 Desktop 并打开） */
export function buildResumeUrl(cliSessionId: string): string {
  return `${CLAUDE_DESKTOP_IDENTITY.scheme}://resume?session=${encodeURIComponent(cliSessionId)}`
}

/**
 * 构造 `claude://code/continue?session=local_<id>`（打开 Desktop 自己的会话）。
 *
 * asar 侧约束（1.46388.4，`claudeURLHandler` 的 `Wc.Code` 分支）：
 *  - `session` 必须是 `local_[A-Za-z0-9-]{1,64}` 或字面量 `last`，否则整条链接被丢弃；
 *  - 解析时只在**非归档**会话里找 `sessionId === session`，归档的会静默失败
 *    （所以调用前要把 `isArchived` 当 `resumable=false`）。
 */
export function buildContinueUrl(localSessionId: string): string {
  return `${CLAUDE_DESKTOP_IDENTITY.scheme}://code/continue?session=${encodeURIComponent(localSessionId)}`
}
