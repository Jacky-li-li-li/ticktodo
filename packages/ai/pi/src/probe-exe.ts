/**
 * probe-exe — 在 GUI（Finder / launchd）环境里定位 CLI 可执行文件。
 *
 * 为什么需要它（2026-10-19 实测）：从 Finder 启动的 .app 只继承 launchd 的最小 PATH
 * `/usr/bin:/bin:/usr/sbin:/sbin`，不含 Homebrew / npm 全局 / nvm / fnm / volta / bun。
 * pi 本体是 `#!/usr/bin/env node` 的 JS bundle；老实现靠 `pi --version` 判定安装，
 * 最小 PATH 下连 node 都找不到，execFile 直接 exit 127 → 明明装了也报「未检测到」，
 * 重新检测还是同一条路，所以永远不生效（dev 从终端跑有全 PATH，看不出这个问题）。
 *
 * 现在的判定只要求「文件在 + 可执行」，但仍必须能从 GUI 环境里定位到它，顺序：
 *  1) `TICK_<TOOL>_PATH` 覆盖（绝对路径优先，运维/排障用）；
 *  2) 常见安装前缀（零进程开销，覆盖绝大多数机器）；
 *  3) 进程自己的 PATH（dev / 从终端启动时有效）；
 *  4) 以上都没命中，才用一次登录 shell 取用户真实 PATH（macOS GUI 应用拿用户 PATH 的通用做法），
 *     带超时 + TTL 缓存；只读 PATH 字符串，不执行 PATH 里的任何命令。
 *
 * 不跑 `pi --version` 是刻意的：探测阶段不该依赖 node 一定可执行（GUI 环境下正是它不可用），
 * 版本差异交给真实调用去暴露。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** 登录 shell 取 PATH 的硬超时：用户 .zshrc 可能有网络/重活，不能把探测挂住 */
const LOGIN_SHELL_TIMEOUT_MS = 1_500
/** 子进程 stdout 上限：rc 可能打印噪声，超限直接放弃（只关心 PATH） */
const LOGIN_SHELL_MAX_OUTPUT = 64 * 1024
/** PATH 缓存 TTL：用户改完 .zshrc 后重开面板页（重新检测）最多等这么久就能生效 */
const LOGIN_SHELL_PATH_TTL_MS = 60_000
/** 用标记夹住 PATH，忽略 rc 打印到 stdout 的噪声（p10k / 欢迎语等） */
const PATH_START = '__TICK_LOGIN_PATH__'
const PATH_END = '__TICK_LOGIN_PATH_END__'
/** 只认这些 shell 的 `-ilc` 语义；fish 的 $PATH 是 list，这里不做特判 */
const SUPPORTED_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh'])

export interface FindCliOptions {
  /** 注入环境（默认 process.env；测试用） */
  env?: NodeJS.ProcessEnv
  /** 注入 home（默认 os.homedir()；测试用） */
  home?: string
  /** 判定「这个路径是可执行的普通文件」（默认 stat；测试注入可避碰真实文件系统） */
  isExecutable?: (file: string) => boolean
  /** 取登录 shell 的 PATH（默认带缓存的 spawn；测试注入可让结果确定） */
  loginShellPath?: (env: NodeJS.ProcessEnv) => Promise<string | null>
}

/** 可执行的普通文件才算「装了」：目录、0644、断链软链都不算（断链在 stat 处直接抛） */
export function isExecutableFile(file: string): boolean {
  try {
    const st = statSync(file)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * GUI 环境里 CLI 的常见安装前缀（顺序即优先级，不存在的目录只是白查一次 stat）。
 * 只放「确定是用户可写/包管理器默认前缀」的目录，不放 PATH 猜测出来的随机位置。
 */
export function commonBinDirs(home: string): string[] {
  return [
    path.join(home, '.npm-global', 'bin'), // npm prefix（本机 pi 就在这里）
    path.join(home, '.local', 'bin'), // pnpm / pipx / hermes / 手放脚本
    path.join(home, 'Library', 'pnpm'), // pnpm 全局 bin 默认位置（macOS）
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.nodenv', 'shims'),
    path.join(home, '.nvm', 'current', 'bin'),
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Homebrew / 手动安装
    '/usr/bin',
  ]
}

let loginPathCache: { at: number; value: string | null } | null = null

/** 测试/排障用：丢掉 PATH 缓存，下一次探测重新问登录 shell */
export function clearLoginShellPathCache(): void {
  loginPathCache = null
}

/**
 * 登录 shell 的 PATH（带 TTL 缓存）。跑的是用户自己的 .zprofile/.zshrc，
 * 这是 macOS GUI 进程拿到「用户在终端里那份 PATH」的标准做法；失败一律降级为 null。
 */
export async function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const now = Date.now()
  if (loginPathCache && now - loginPathCache.at < LOGIN_SHELL_PATH_TTL_MS) return loginPathCache.value
  const value = await readLoginShellPath(env).catch(() => null)
  loginPathCache = { at: now, value }
  return value
}

async function readLoginShellPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const shell = env.SHELL?.trim() || '/bin/zsh'
  if (!SUPPORTED_SHELLS.has(path.basename(shell))) return null
  if (!existsSync(shell)) return null

  // 自己管超时并 SIGKILL：execFile 的 timeout 只发 SIGTERM，交互 shell 在等前台命令时
  // 往往先把信号憋住（实测 .zshrc 里 `sleep 5` 时 1.5s 超时仍要等满 5s），会把 tools:status 挂住。
  // 用 detached 让 shell 独占一个进程组：超时杀整组，否则 rc 里起的前台命令会攥着 stdout 管道，
  // Node 要等它退出才收得到 close（又是 5s）。
  return new Promise<string | null>((resolve) => {
    let settled = false
    let stdout = ''
    const child = spawn(shell, ['-ilc', `printf '${PATH_START}%s${PATH_END}' "$PATH"`], {
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    child.unref() // 探测不该拖住应用退出
    const timer = setTimeout(() => finish(null, true), LOGIN_SHELL_TIMEOUT_MS)
    function finish(value: string | null, killGroup: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.destroy() // 释放读端，别等孤儿子进程关管道
      if (killGroup) {
        try {
          // 负 pid = 整个进程组（含 rc 里正在跑的前台命令）
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* 组已经退出 */
        }
      }
      resolve(value)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > LOGIN_SHELL_MAX_OUTPUT) finish(null, true)
    })
    child.on('error', () => finish(null, true))
    child.on('close', () => finish(parseLoginShellPath(stdout), false))
  })
}

/** 从 login shell 的 stdout 里抠出 PATH：rc 打印的噪声用标记夹住后丢弃 */
function parseLoginShellPath(stdout: string): string | null {
  const start = stdout.indexOf(PATH_START)
  const end = start >= 0 ? stdout.indexOf(PATH_END, start + PATH_START.length) : -1
  if (start < 0 || end < 0) return null
  const value = stdout.slice(start + PATH_START.length, end).trim()
  // 至少要像一份 PATH（含分隔符）才采用，避免把 rc 的杂散输出当 PATH
  return value && value.includes(path.delimiter) ? value : null
}

function splitPath(value: string | undefined): string[] {
  return (value ?? '').split(path.delimiter).filter(Boolean)
}

/**
 * 定位 CLI 可执行文件；找不到返回 null（宁可报未安装，也不把不存在的路径当成已安装）。
 * 注意这里**不执行**目标文件，所以不需要 node/解释器可用。
 */
export async function findCliExecutable(
  name: string,
  opts: FindCliOptions = {},
): Promise<string | null> {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const isExecutable = opts.isExecutable ?? isExecutableFile

  // 1) 显式覆盖：TICK_PI_PATH（pi）/ TICK_<NAME>_PATH
  const overrideVar = `TICK_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PATH`
  const override = env[overrideVar]
  if (override && isExecutable(override)) return override

  // 2) 常见安装前缀（GUI 环境下真正救命的这一步）
  for (const dir of commonBinDirs(home)) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }

  // 3) 进程自身 PATH（dev / 从终端启动）
  for (const dir of splitPath(env.PATH)) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }

  // 4) 登录 shell PATH 兜底（nvm / fnm / 自定义 prefix 只有这里能覆盖到）
  const shellPath = await (opts.loginShellPath ?? loginShellPath)(env)
  for (const dir of splitPath(shellPath ?? undefined)) {
    const candidate = path.join(dir, name)
    if (isExecutable(candidate)) return candidate
  }

  return null
}
