/**
 * detect 的超时包装（tools:status 用）。
 *
 * 为什么单独成文件：`ipc.ts` 直接 import 'electron'，selftest（node 里跑 esbuild 产物）
 * 无法 import 它；这个包装是纯函数，独立出来才能被真实单测覆盖。
 *
 * 语义：探测失败/超时都降级成「未安装 + 原因」，不把整块 status 打成 IPC 异常 ——
 * 一个工具挂掉时其他工具的状态仍要能显示（失败降级）；同时不能让最慢的一个
 * 拖住新建会话页的首帧（15 个 adapter 一次 fan-out）。
 */

import type { AiToolAdapter } from '@tick/ai-core'

/**
 * 单 adapter 探测上限。
 * 取 5s 而不是 3s：各 adapter 的 detect 内部是「多个 1.5s execFile 上限」串联
 * （login-shell 定位 / plutil / mdfind），最坏链路可达 ~4.5s；上限太紧会把「慢但确实装了」
 * 的工具降级成 installed:false（新建页里直接消失，且 reason 没有 UI 消费）。
 * 5s 仍能把「挂死」的探测挡在首帧之外（15 路并行，整块最坏 5s）。
 */
export const DETECT_TIMEOUT_MS = 5_000

export function detectWithTimeout(
  adapter: AiToolAdapter,
  timeoutMs: number = DETECT_TIMEOUT_MS,
): Promise<{ installed: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ installed: false, reason: `就绪探测超时（>${timeoutMs / 1000}s）` })
    }, timeoutMs)
    timer.unref?.()
    void adapter.detect().then(
      (detected) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(detected)
      },
      (e: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ installed: false, reason: `就绪探测失败：${(e as Error).message}` })
      },
    )
  })
}
