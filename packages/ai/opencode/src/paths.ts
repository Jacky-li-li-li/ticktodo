/**
 * paths — OpenCode 系的数据库位置（只读；不 mkdir）。
 *
 * OpenCode：`$XDG_DATA_HOME/opencode/opencode.db` > `~/.local/share/opencode/opencode.db`，
 *  `$OPENCODE_DB` 可指定（相对路径相对数据目录，绝对路径原样用）。
 * ZCode   ：`~/.zcode/cli/db/db.sqlite`（magpie `ZCodeDir`）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function resolveOpenCodeDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  // XDG 规范：相对路径的 XDG_DATA_HOME 应被**忽略**（`path.resolve` 会相对 cwd，静默指到错误位置）
  const xdg = env.XDG_DATA_HOME?.trim()
  const dataBase = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share')
  const dataDir = path.join(dataBase, 'opencode')
  const override = env.OPENCODE_DB?.trim()
  if (override && override !== ':memory:') {
    return path.isAbsolute(override) ? override : path.join(dataDir, override)
  }
  return path.join(dataDir, 'opencode.db')
}

export function resolveZCodeDbPath(home = homedir()): string {
  return path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
}

/** 读 Info.plist 的 CFBundleIdentifier（XML 直接正则；二进制 plist 交给系统 plutil，只读） */
async function bundleIdOf(appBundle: string): Promise<string | undefined> {
  const plist = path.join(appBundle, 'Contents', 'Info.plist')
  let buf: Buffer
  try {
    buf = readFileSync(plist)
  } catch {
    return undefined
  }
  if (buf.subarray(0, 6).toString('latin1') !== 'bplist') {
    const hit = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(buf.toString('utf8'))
    return hit?.[1]?.trim() || undefined
  }
  const { execFile } = await import('node:child_process')
  return new Promise<string | undefined>((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 1500, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) return resolve(undefined)
      try {
        const parsed: unknown = JSON.parse(stdout)
        const value = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).CFBundleIdentifier : undefined
        resolve(typeof value === 'string' ? value : undefined)
      } catch {
        resolve(undefined)
      }
    })
  })
}

/**
 * 找桌面 App（`/Applications` 与 `~/Applications`，最后 mdfind 兜底）。
 *
 * 嵌套目录（本机 OpenCode 在 `/Applications/APP/OpenCode.app`）交给 mdfind —— 不为某一台机器的
 * 特殊布局留魔数路径；索引没命中就如实报未安装。命中后仍校验 `CFBundleIdentifier`，不信任索引。
 */
export async function findDesktopApp(
  bundleId: string,
  bundleName: string,
  opts: { home?: string; appDirs?: string[]; useMdfind?: boolean } = {},
): Promise<string | undefined> {
  const home = opts.home ?? homedir()
  const dirs = opts.appDirs ?? ['/Applications', path.join(home, 'Applications')]
  for (const dir of dirs) {
    const app = path.join(dir, bundleName)
    if (!existsSync(app)) continue
    if ((await bundleIdOf(app)) === bundleId) return app
  }
  if (opts.useMdfind === false || opts.appDirs) return undefined
  const { execFile } = await import('node:child_process')
  const found = await new Promise<string | undefined>((resolve) => {
    execFile(
      '/usr/bin/mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      { timeout: 1500, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error || !stdout) return resolve(undefined)
        resolve(stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('.app') && existsSync(l)))
      },
    )
  })
  return found && (await bundleIdOf(found)) === bundleId ? found : undefined
}
