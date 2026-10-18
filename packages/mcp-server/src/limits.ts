/**
 * 进程内限流（`docs/mcp-tools-spec.md` §1.7）。
 *
 * 写工具 30/分钟 + 突发 5/10s；读工具 120/分钟。状态只在内存里，server 重启即重置
 * —— 单客户端进程场景下够用，落盘反而引入新的并发面。
 */

export interface RateLimitOk {
  ok: true
}

export interface RateLimitDenied {
  ok: false
  retryAfterSeconds: number
}

export type RateLimitResult = RateLimitOk | RateLimitDenied

interface Burst {
  limit: number
  windowMs: number
}

export class SlidingWindowLimiter {
  private hits: number[] = []

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly burst?: Burst,
  ) {}

  /** 取一个配额；被拒时不消耗配额 */
  take(now = Date.now()): RateLimitResult {
    const maxWindow = Math.max(this.windowMs, this.burst?.windowMs ?? 0)
    this.hits = this.hits.filter((at) => now - at < maxWindow)

    const waits: number[] = []
    const inWindow = this.hits.filter((at) => now - at < this.windowMs)
    if (inWindow.length >= this.limit) {
      const oldest = inWindow[0] as number
      waits.push(oldest + this.windowMs - now)
    }
    if (this.burst) {
      const inBurst = this.hits.filter((at) => now - at < (this.burst as Burst).windowMs)
      if (inBurst.length >= this.burst.limit) {
        const oldest = inBurst[0] as number
        waits.push(oldest + this.burst.windowMs - now)
      }
    }

    if (waits.length > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(Math.max(...waits) / 1000))
      return { ok: false, retryAfterSeconds }
    }

    this.hits.push(now)
    return { ok: true }
  }
}

/** 写工具（create_todo / link_session）共用一份配额 */
export const writeLimiter = new SlidingWindowLimiter(30, 60_000, { limit: 5, windowMs: 10_000 })
/** 读工具（list_todos） */
export const readLimiter = new SlidingWindowLimiter(120, 60_000)
