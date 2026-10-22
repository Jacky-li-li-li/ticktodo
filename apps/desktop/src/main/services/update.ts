/**
 * update：应用内更新的 main 侧服务（唯一状态源）。
 *
 * 分工：
 *  - 本文件只做「能力判定 + 事件编排 + 定时器」，状态迁移全部在 update-state.ts 的纯函数里；
 *  - electron-updater 的运行时实例由 main.ts 注入（这里只 `import type`），
 *    所以 scripts/selftest-update.ts 用 run-ts 打包时不需要 electron-updater 运行时；
 *  - 原始异常只进 main 日志，状态里只放白名单文案（renderer 永远拿不到 URL/路径/堆栈）。
 *
 * 已知限制（v1 不藏）：ready 不持久化；下载没有取消 API；自动检查失败不弹通知；
 * Tray 菜单打开期间进度不刷新；非 /Applications 安装位置可能安装失败，不预检。
 */

import { execFile } from 'node:child_process'
import type {
  UpdateErrorCode,
  UpdateState,
  UpdateTrigger,
  UpdateUnsupportedReason,
} from '@tick/shared'
import {
  INITIAL_UPDATE_STATE,
  classifyUpdateError,
  reduceUpdateState,
  type UpdateEvent,
} from './update-state'

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  logger: {
    info(message: unknown): void
    warn(message: unknown): void
    error(message: unknown): void
    debug(message: unknown): void
  }
  // 库的事件签名是 any[]（内部 emitter），这里只用来注册回调，真正的参数在下面逐个做形状校验
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export interface UpdateServiceDeps {
  currentVersion: string
  isPackaged: boolean
  /** 判 translocated */
  execPath: string
  /** 注入点：生产传 electron-updater 的 autoUpdater；selftest 传 fake */
  updater: UpdaterLike
  /** 注入点：返回 signed/unsigned/probe-failed；生产用 codesign，selftest 直接给结果 */
  probeSignature: () => Promise<'signed' | 'unsigned' | 'probe-failed'>
  /** 注入点：app-update.yml 是否存在 */
  hasUpdateConfig: () => boolean
  /** 每次现读 settings */
  autoCheckEnabled: () => boolean
  onState: (state: UpdateState) => void
  /**
   * 安装前：关 chat、放行 before-quit。返回 cancel()：安装没启动时恢复 quitting 并重建 chat。
   * 生产实现由 main.ts 提供，selftest 用记录型 fake。
   */
  prepareQuit: () => Promise<() => void>
  now?: () => string
  log?: (message: string, error?: unknown) => void
  /** 测试注入：安装后等进程退出的上限；生产默认 15s */
  installStartTimeoutMs?: number
  /** 测试注入：检查请求的超时上限；生产默认 45s */
  checkTimeoutMs?: number
  /** 测试注入：下载无进度多久后判超时；生产默认 90s */
  downloadStallMs?: number
  /** 测试注入：启动后首次自动检查的延迟；生产默认 10s */
  startupDelayMs?: number
}

const STARTUP_DELAY_MS = 10_000
const AUTO_CHECK_AFTER_ENABLE_MS = 1_000
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1_000
const CHECK_TIMEOUT_MS = 45_000
const DOWNLOAD_STALL_MS = 90_000
const CODESIGN_TIMEOUT_MS = 3_000
const DEFAULT_INSTALL_START_TIMEOUT_MS = 15_000

type UpdateSupport = { ok: true } | { ok: false; reason: UpdateUnsupportedReason }

/** 库给的事件载荷都是 unknown：这里只取版本号，取不到就当事件无效 */
function readVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const version = (value as { version?: unknown }).version
  return typeof version === 'string' && version.length > 0 ? version : undefined
}

function readProgress(value: unknown): { percent: number; bytesPerSecond?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const p = value as { percent?: unknown; bytesPerSecond?: unknown }
  if (typeof p.percent !== 'number' || !Number.isFinite(p.percent)) return undefined
  return {
    percent: p.percent,
    ...(typeof p.bytesPerSecond === 'number' && p.bytesPerSecond > 0
      ? { bytesPerSecond: p.bytesPerSecond }
      : {}),
  }
}

export class UpdateService {
  private state: UpdateState
  private supportPromise?: Promise<UpdateSupport>
  private configured = false
  private checking = false
  private downloading = false
  private installing = false
  private startupTimer?: NodeJS.Timeout
  private intervalTimer?: NodeJS.Timeout
  private stallTimer?: NodeJS.Timeout
  private installTimer?: NodeJS.Timeout
  private autoCheckScheduled = false
  private readonly now: () => string
  private readonly log: (message: string, error?: unknown) => void
  private readonly installStartTimeoutMs: number
  private readonly checkTimeoutMs: number
  private readonly downloadStallMs: number
  private readonly startupDelayMs: number

  constructor(private readonly deps: UpdateServiceDeps) {
    this.state = INITIAL_UPDATE_STATE(deps.currentVersion)
    this.now = deps.now ?? (() => new Date().toISOString())
    this.log =
      deps.log ??
      ((message, error) => {
        if (error === undefined) console.warn('[tick-update]', message)
        else console.warn('[tick-update]', message, error)
      })
    this.installStartTimeoutMs = deps.installStartTimeoutMs ?? DEFAULT_INSTALL_START_TIMEOUT_MS
    // 三个超时都有生产默认值；注入只服务 selftest（不传时行为与常量一致）
    this.checkTimeoutMs = deps.checkTimeoutMs ?? CHECK_TIMEOUT_MS
    this.downloadStallMs = deps.downloadStallMs ?? DOWNLOAD_STALL_MS
    this.startupDelayMs = deps.startupDelayMs ?? STARTUP_DELAY_MS
  }

  /** 同步读当前状态，不触发任何 IO */
  getState(): UpdateState {
    return this.state
  }

  /** 等签名/feed 探测完成再返回；renderer 首帧就能显示 unsupported */
  async ready(): Promise<UpdateState> {
    const support = await this.detectSupport()
    if (!support.ok) this.apply({ type: 'unsupported', reason: support.reason })
    return this.state
  }

  /** 启动定时器：10s 后首次自动检查，之后每 6h 一次。registerIpc 之后调用。 */
  start(): void {
    void this.ready()
      .then((state) => {
        if (state.phase === 'unsupported') return
        this.refreshAutoCheck(this.startupDelayMs)
      })
      // ready() 设计上不 reject；这里兜底，避免探测的意外异常变成 unhandledRejection
      .catch((e) => this.log('支持探测失败', e))
  }

  /** 清定时器，will-quit 调用 */
  stop(): void {
    this.clearAutoCheckTimers()
    this.clearStallTimer()
    if (this.installTimer) clearTimeout(this.installTimer)
    this.installTimer = undefined
    this.installing = false
  }

  /** 设置页开关变化时调用；关闭只清定时器，不影响当前下载 */
  setAutoCheck(enabled: boolean): void {
    if (!enabled) {
      // 只停自动检查，不碰 stallTimer：用户关掉自动检查时，进行中的下载不能失去超时保护
      this.clearAutoCheckTimers()
      return
    }
    // 用户刚打开开关时给一次快速检查，不必等满 6h；先等能力判定，unsupported 不排任何定时器
    void this.ready()
      .then((state) => {
        if (state.phase === 'unsupported') return
        this.refreshAutoCheck(AUTO_CHECK_AFTER_ENABLE_MS)
      })
      .catch((e) => this.log('自动检查开关处理失败', e))
  }

  /** 手动/自动检查。单飞，重复调用返回当前状态，不抛错 */
  async check(trigger: UpdateTrigger = 'manual'): Promise<UpdateState> {
    await this.ready()
    if (this.state.phase === 'unsupported') return this.state
    if (this.checking || this.downloading) return this.state
    // available / ready 是稳定停留态：自动检查不会每 6h 把它们重置
    if (this.state.phase === 'available' || this.state.phase === 'ready') return this.state
    if (trigger === 'auto' && !this.deps.autoCheckEnabled()) return this.state

    this.checking = true
    this.apply({ type: 'check-started', trigger })

    try {
      // 放进 try：库初始化/打包问题也要收口成 error 状态，不能把 reject 漏给 renderer
      this.ensureConfigured()
      // 超时只 reject 我们的 race；底层 promise 仍挂着，由 withTimeout 的 then 吞掉它的迟到拒绝
      await this.withTimeout(this.deps.updater.checkForUpdates(), this.checkTimeoutMs)
      // 正常情况下结果已经由事件推进状态。仍停在 checking 说明库没发事件，按失败收口
      if (this.checking) this.fail('check', { code: 'unknown' })
    } catch (err) {
      if (this.checking) {
        this.log('检查更新失败', err)
        this.fail('check', classifyUpdateError(err))
      }
    }
    return this.state
  }

  /** 只从 available / 可重试的下载错误进入；用户确认后才下载（autoDownload 恒为 false） */
  async download(): Promise<UpdateState> {
    const version =
      this.state.phase === 'available'
        ? this.state.version
        : this.state.phase === 'error' && this.state.scope === 'download'
          ? this.state.version
          : undefined
    if (version === undefined) return this.state
    if (this.downloading || this.checking) return this.state

    this.downloading = true
    this.apply({ type: 'download-started', version })
    this.armStallTimer()

    try {
      this.ensureConfigured()
      await this.deps.updater.downloadUpdate()
      // 库正常会先发 update-downloaded。没发就按完成兜底，但只在仍处于 downloading 时
      if (this.downloading) this.onDownloaded(version)
    } catch (err) {
      if (this.downloading) {
        this.log('下载更新失败', err)
        this.fail('download', classifyUpdateError(err))
      } else if (this.state.phase === 'ready') {
        // MacUpdater 先 dispatch update-downloaded（状态已 ready），再把 zip 交给 Squirrel.Mac；
        // 拉取/验签失败只会让 downloadUpdate() reject，这里不能因为 downloading=false 就丢掉。
        this.failHandoff(err)
      }
    }
    return this.state
  }

  /**
   * 只从 ready 进入。顺序不能反：先 prepareQuit（关 chat + 放行 before-quit），再交给 Squirrel；
   * 反过来会被 before-quit 的 preventDefault 拦掉安装退出。
   * macOS 上 quitAndInstall 的第二个参数不适用，重启由默认的 autoRunAppAfterInstall 决定。
   */
  async install(): Promise<void> {
    if (this.state.phase !== 'ready') return
    if (this.installing) return
    this.installing = true
    this.apply({ type: 'install-started' })

    let cancel: (() => void) | undefined
    try {
      cancel = await this.deps.prepareQuit()
      this.deps.updater.quitAndInstall()
    } catch (err) {
      this.log('安装更新失败', err)
      cancel?.()
      this.installing = false
      this.apply({ type: 'install-failed' })
      return
    }

    // 同步 throw 之外还有「调用成功但进程没退」：15s 后恢复应用并允许原地重试，不把用户困在假安装里
    this.installTimer = setTimeout(() => {
      this.installTimer = undefined
      this.installing = false
      this.log('安装未在时限内退出，恢复应用')
      cancel?.()
      this.apply({ type: 'install-failed' })
    }, this.installStartTimeoutMs)
    this.installTimer.unref?.()
  }

  private detectSupport(): Promise<UpdateSupport> {
    if (!this.supportPromise) this.supportPromise = this.detectSupportOnce()
    return this.supportPromise
  }

  private async detectSupportOnce(): Promise<UpdateSupport> {
    // dev 先判：不触碰 autoUpdater，也不去 codesign Electron.app
    if (!this.deps.isPackaged) return { ok: false, reason: 'dev' }
    // 从 DMG 直接运行时 macOS 把 App 挂到随机路径，Squirrel 无法替换，提前如实说明
    if (this.deps.execPath.includes('/AppTranslocation/')) {
      return { ok: false, reason: 'translocated' }
    }

    let signature: 'signed' | 'unsigned' | 'probe-failed'
    try {
      signature = await this.deps.probeSignature()
    } catch {
      // 连探测都没跑完：不猜签名，保守停用
      return { ok: false, reason: 'probe-failed' }
    }
    if (signature !== 'signed') {
      return { ok: false, reason: signature === 'unsigned' ? 'unsigned' : 'probe-failed' }
    }

    // --dir 产物没有 app-update.yml。不要用 dev-app-update.yml 掩盖这个事实
    let hasConfig = false
    try {
      hasConfig = this.deps.hasUpdateConfig()
    } catch {
      hasConfig = false
    }
    if (!hasConfig) return { ok: false, reason: 'no-feed' }
    return { ok: true }
  }

  private clearAutoCheckTimers(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.startupTimer = undefined
    this.intervalTimer = undefined
    this.autoCheckScheduled = false
  }

  private refreshAutoCheck(delayMs: number): void {
    if (this.autoCheckScheduled) return
    if (!this.deps.autoCheckEnabled()) return
    this.autoCheckScheduled = true
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined
      void this.check('auto').catch((e) => this.log('自动检查失败', e))
      this.intervalTimer = setInterval(() => {
        void this.check('auto').catch((e) => this.log('自动检查失败', e))
      }, AUTO_INTERVAL_MS)
      this.intervalTimer.unref?.()
    }, delayMs)
    this.startupTimer.unref?.()
  }

  private ensureConfigured(): void {
    if (this.configured) return
    this.configured = true
    const updater = this.deps.updater

    // autoDownload=false：发现新版本只进入 available，必须用户点下载
    updater.autoDownload = false
    // 硬要求。关掉后 MacUpdater 不会把 zip 交给 Squirrel，ready 是假状态
    updater.autoInstallOnAppQuit = true
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.logger = {
      info: (message: unknown) => console.log('[tick-update]', message),
      warn: (message: unknown) => console.warn('[tick-update]', message),
      error: (message: unknown) => console.error('[tick-update]', message),
      debug: () => {},
    }

    updater.on('update-available', (info: unknown) => {
      // 只有 check 阶段的事件才有效，迟到事件不能把 download/ready 打回 available
      if (!this.checking) return
      const version = readVersion(info)
      if (version === undefined) {
        this.fail('check', { code: 'unknown' })
        return
      }
      this.checking = false
      this.apply({ type: 'check-available', version })
    })

    updater.on('update-not-available', () => {
      if (!this.checking) return
      this.checking = false
      this.apply({ type: 'check-none' })
    })

    updater.on('download-progress', (progress: unknown) => {
      if (!this.downloading) return
      const parsed = readProgress(progress)
      if (!parsed) return
      this.armStallTimer()
      this.apply({ type: 'download-progress', ...parsed })
    })

    updater.on('update-downloaded', (info: unknown) => {
      if (!this.downloading) return
      const version =
        readVersion(info) ?? (this.state.phase === 'downloading' ? this.state.version : undefined)
      if (version === undefined) return
      this.onDownloaded(version)
    })

    updater.on('error', (err: unknown) => {
      // 下载完成后还有一个不在 checking/downloading 里的阶段：包已 ready，MacUpdater 正在交给
      // Squirrel.Mac。这一步失败只发 error 事件，漏掉会永远显示「已下载」且连日志都没有。
      if (!this.checking && !this.downloading) {
        if (this.state.phase === 'ready') this.failHandoff(err)
        return
      }
      // 同一个 error 事件可能在 check 或 download 阶段到达，按当前进行中的阶段归档
      this.log('更新库错误', err)
      this.fail(this.downloading ? 'download' : 'check', classifyUpdateError(err))
    })
  }

  private apply(event: UpdateEvent): void {
    const next = reduceUpdateState(this.state, event, this.now())
    if (next === this.state) return // 无效迁移不广播
    this.state = next
    this.deps.onState(next)
  }

  private fail(
    kind: 'check' | 'download',
    input: { code: UpdateErrorCode; httpStatus?: number },
  ): void {
    // 先清进行中标记，迟到事件会被阶段守卫丢掉
    this.checking = false
    this.downloading = false
    this.clearStallTimer()
    this.apply(
      kind === 'download'
        ? { type: 'download-failed', ...input }
        : { type: 'check-failed', ...input },
    )
  }

  private onDownloaded(version: string): void {
    this.downloading = false
    this.clearStallTimer()
    this.apply({ type: 'download-done', version })
  }

  /**
   * 包已下好、交给系统安装器失败。原生 Squirrel.Mac 的失败与网络/HTTP 无关，
   * 所以不复用 classifyUpdateError（否则会被归成 unknown，文案也误导）。
   * 不清空 version：状态里的已下载版本让「重试下载」不必先重新检查。
   * error 事件与 promise reject 会先后调用这里，重复收口由 reducer 的 ready 守卫丢掉。
   */
  private failHandoff(err: unknown): void {
    this.log('更新包交给系统安装器失败', err)
    this.apply({ type: 'handoff-failed' })
  }

  private armStallTimer(): void {
    this.clearStallTimer()
    this.stallTimer = setTimeout(() => {
      if (!this.downloading) return
      // 没有取消 API。这里只把 UI 收口成可重试，底层请求可能仍在，属于已知限制
      this.fail('download', { code: 'timeout' })
    }, this.downloadStallMs)
    this.stallTimer.unref?.()
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = undefined
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Object.assign(new Error('update timeout'), { name: 'UpdateTimeoutError' })),
        ms,
      )
      timer.unref?.()
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        },
      )
    })
  }
}

/**
 * 生产签名探测：codesign 只接受 .app bundle，不接受可执行文件。
 * 只有 Developer ID Application 才算「可自动更新」；ad-hoc/别的证书在 macOS 上 Squirrel 不会替换。
 */
export function probeDeveloperIdSignature(
  appBundlePath: string,
): Promise<'signed' | 'unsigned' | 'probe-failed'> {
  return new Promise((resolve) => {
    try {
      execFile(
        '/usr/bin/codesign',
        ['-dv', '--verbose=4', appBundlePath],
        { timeout: CODESIGN_TIMEOUT_MS },
        (err, stdout, stderr) => {
          // codesign -dv 把详情写到 stderr，stdout 基本为空；两边都拼上再匹配
          const output = `${stdout}\n${stderr}`
          if (!err && /Authority=Developer ID Application/i.test(output)) return resolve('signed')
          if (err && /code object is not signed at all|not signed/i.test(output)) {
            return resolve('unsigned')
          }
          if (err) return resolve('probe-failed')
          // codesign 成功但没有 Developer ID Authority，说明是 ad-hoc 或别的证书
          return resolve('unsigned')
        },
      )
    } catch {
      // 连子进程都没起来：不猜签名，保守停用
      resolve('probe-failed')
    }
  })
}
