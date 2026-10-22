/**
 * useUpdate：设置页的更新状态（main 是唯一状态源）。
 *
 * 挂载时拉一次完整状态，再订阅 main 推来的完整快照；卸载时取消订阅。
 * 不做事件重放、不在 renderer 里做状态迁移：窗口 reload / 设置页反复开关都不会让状态分叉。
 */

import { useEffect, useState } from 'react'
import type { UpdateState } from '@tick/shared'

export function useUpdate(): {
  state: UpdateState | null
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
} {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    // dev 下 preload 未重建时 window.tick.update 可能不存在：不要炸整个设置页
    if (!window.tick.update) return
    let alive = true
    void window.tick.update
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      // preload/main 版本错配（旧 preload 没有这个 handler）时 IPC 会 reject：保持 null 不炸页面
      .catch(() => {})
    const off = window.tick.update.onState((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return {
    state,
    // 命令都返回最新状态；IPC 断开时保留旧状态，不把 UI 清空
    check: async () => {
      setState(await window.tick.update.check())
    },
    download: async () => {
      setState(await window.tick.update.download())
    },
    install: async () => {
      await window.tick.update.install()
    },
  }
}
