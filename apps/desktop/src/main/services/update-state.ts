/**
 * update-state：应用内更新的纯状态机（不 import electron / electron-updater）。
 *
 * 为什么单独一层：electron-updater 是事件源，迟到、重复、（检查与下载阶段交错）的事件一定会出现。
 * 全部迁移收敛到这里后，selftest 能在纯 Node 下跑；service 只需要把库事件翻译成下面这组有限事件。
 *
 * 约定：reducer 返回**同一个对象**表示「当前阶段不接受这个事件」，service 据此跳过广播。
 * 因此 renderer 永远看不到「downloading + ready」这类自相矛盾的组合。
 */

import type {
  UpdateErrorCode,
  UpdateState,
  UpdateTrigger,
  UpdateUnsupportedReason,
} from '@tick/shared'

/** 安装动作没启动时的固定文案：状态仍是 ready，用户可原地重试 */
export const INSTALL_FAILED_MESSAGE = '安装没有启动，请重试。'

/** 库事件先收敛成这个有限集合，再交给 reducer；service 不直接拼状态对象 */
export type UpdateEvent =
  | { type: 'check-started'; trigger: UpdateTrigger }
  | { type: 'check-available'; version: string }
  | { type: 'check-none' }
  | { type: 'check-failed'; code: UpdateErrorCode; httpStatus?: number }
  | { type: 'download-started'; version: string }
  | { type: 'download-progress'; percent: number; bytesPerSecond?: number }
  | { type: 'download-done'; version: string }
  | { type: 'download-failed'; code: UpdateErrorCode; httpStatus?: number }
  | { type: 'install-started' }
  | { type: 'install-failed' }
  | { type: 'unsupported'; reason: UpdateUnsupportedReason }

export function INITIAL_UPDATE_STATE(currentVersion: string): UpdateState {
  return { phase: 'idle', currentVersion }
}

/** 原始 message 只进 main 日志；这里只生产白名单文案 */
export function updateErrorMessage(code: UpdateErrorCode, httpStatus?: number): string {
  switch (code) {
    case 'offline':
      return '网络不可用，请检查连接后重试。'
    case 'http': {
      const status =
        Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
          ? httpStatus
          : undefined
      return status
        ? `更新服务器返回 HTTP ${status}，请稍后重试。`
        : '更新服务器返回错误，请稍后重试。'
    }
    case 'feed':
      return '更新源配置不可用，请重新安装或手动下载新版本。'
    case 'signature':
      return '更新包签名校验失败，请手动下载新版本。'
    case 'timeout':
      return '更新请求超时，请稍后重试。'
    case 'install':
      return '安装更新失败，请手动下载新版本。'
    case 'unknown':
      return '检查更新失败，请稍后重试。'
  }
}

export function unsupportedMessage(reason: UpdateUnsupportedReason): string {
  switch (reason) {
    case 'dev':
      return '开发模式（未打包）不检查更新。'
    case 'unsigned':
      return '当前应用未使用 Developer ID 签名，自动更新不可用。请手动下载新版本安装。'
    case 'no-feed':
      return '当前安装包缺少更新源配置（app-update.yml），自动更新不可用。'
    case 'translocated':
      return '应用正从安装镜像运行，自动更新不可用。请把 Tick 移到「应用程序」后再更新。'
    case 'probe-failed':
      return '无法确认应用签名状态，自动更新已停用。'
  }
}

export function isRetryable(code: UpdateErrorCode): boolean {
  return code === 'offline' || code === 'http' || code === 'timeout' || code === 'unknown'
}

/**
 * 纯迁移。now 可注入，selftest 不依赖真实时间。
 *
 * 阶段守卫是这张表的核心：available / ready 是稳定停留态，不能被一次新检查打回；
 * error 可以由手动或下一次自动检查恢复；unsupported 一旦确定就不再参与任何动作。
 */
export function reduceUpdateState(
  state: UpdateState,
  event: UpdateEvent,
  now = new Date().toISOString(),
): UpdateState {
  switch (event.type) {
    case 'check-started':
      // available / ready / downloading / checking / unsupported 都不会被一次新检查打回
      if (state.phase !== 'idle' && state.phase !== 'up-to-date' && state.phase !== 'error') {
        return state
      }
      return { phase: 'checking', currentVersion: state.currentVersion, trigger: event.trigger }

    case 'check-available':
      if (state.phase !== 'checking') return state
      return {
        phase: 'available',
        currentVersion: state.currentVersion,
        version: event.version,
        checkedAt: now,
      }

    case 'check-none':
      if (state.phase !== 'checking') return state
      return { phase: 'up-to-date', currentVersion: state.currentVersion, checkedAt: now }

    case 'check-failed':
      if (state.phase !== 'checking') return state
      return {
        phase: 'error',
        currentVersion: state.currentVersion,
        scope: 'check',
        code: event.code,
        ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
        message: updateErrorMessage(event.code, event.httpStatus),
        retryable: isRetryable(event.code),
        checkedAt: now,
      }

    case 'download-started': {
      // available 直接下载；error(scope=download) 且保留了 version 时允许原地重试
      const canStart =
        state.phase === 'available' ||
        (state.phase === 'error' && state.scope === 'download' && state.version !== undefined)
      if (!canStart) return state
      return {
        phase: 'downloading',
        currentVersion: state.currentVersion,
        version: event.version,
        percent: 0,
      }
    }

    case 'download-progress': {
      if (state.phase !== 'downloading') return state
      const raw = Number.isFinite(event.percent) ? event.percent : 0
      const percent = Math.min(100, Math.max(0, Math.round(raw)))
      // 整数百分比没变就不造新对象，避免每秒多次 IPC 和 React 重渲染。
      // bytesPerSecond 只在百分比变化时一起更新，不单独触发广播。
      if (percent === state.percent) return state
      const bytesPerSecond =
        event.bytesPerSecond && event.bytesPerSecond > 0 ? Math.round(event.bytesPerSecond) : undefined
      return {
        ...state,
        percent,
        ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
      }
    }

    case 'download-done':
      if (state.phase !== 'downloading') return state
      return {
        phase: 'ready',
        currentVersion: state.currentVersion,
        version: event.version,
        checkedAt: now,
      }

    case 'download-failed':
      if (state.phase !== 'downloading') return state
      return {
        phase: 'error',
        currentVersion: state.currentVersion,
        scope: 'download',
        code: event.code,
        ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
        message: updateErrorMessage(event.code, event.httpStatus),
        retryable: isRetryable(event.code),
        checkedAt: now,
        // 保留已发现版本：error(scope=download) 的「重试下载」不需要再检查一遍
        version: state.version,
      }

    case 'install-started':
      if (state.phase !== 'ready' || state.installError === undefined) return state
      return { ...state, installError: undefined }

    case 'install-failed':
      // 只有 ready 能安装；失败时保留 ready（包已下载），只写白名单文案
      if (state.phase !== 'ready') return state
      if (state.installError === INSTALL_FAILED_MESSAGE) return state
      return { ...state, installError: INSTALL_FAILED_MESSAGE }

    case 'unsupported':
      // downloading / ready 已经越过能力判定，不允许被迟到的探测结果改写
      if (
        state.phase === 'downloading' ||
        state.phase === 'ready' ||
        state.phase === 'unsupported'
      ) {
        return state
      }
      return {
        phase: 'unsupported',
        currentVersion: state.currentVersion,
        reason: event.reason,
        message: unsupportedMessage(event.reason),
      }
  }
}

/**
 * 错误分类是可测的纯函数。只读 statusCode 与固定模式，绝不把原始 message 回传给状态。
 * 顺序有意义：feed / signature 的判定必须在兜底 unknown 之前。
 */
export function classifyUpdateError(err: unknown): {
  code: UpdateErrorCode
  httpStatus?: number
} {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'UpdateTimeoutError') {
    return { code: 'timeout' }
  }
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode
  if (typeof statusCode === 'number' && statusCode >= 100 && statusCode <= 599) {
    return { code: 'http', httpStatus: statusCode }
  }
  const message = err instanceof Error ? err.message : String(err)
  const found = /\b(?:HTTP|HttpError|status(?:Code)?)\D{0,4}(\d{3})\b/i.exec(message)?.[1]
  if (found) return { code: 'http', httpStatus: Number(found) }
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|net::/i.test(
      message,
    )
  ) {
    return { code: 'offline' }
  }
  if (/latest-mac\.yml|app-update\.yml|Cannot find .*ya?ml/i.test(message)) {
    return { code: 'feed' }
  }
  if (/sha512|checksum|code signature|signature/i.test(message)) {
    return { code: 'signature' }
  }
  return { code: 'unknown' }
}
