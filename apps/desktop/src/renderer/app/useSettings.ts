/**
 * useSettings — 设置读取/更新（F4-b）。main 是唯一持久化方，renderer 只订阅。
 */

import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@tick/shared'
import { DEFAULT_SETTINGS } from '@tick/shared'
import type { TickApi } from '../../preload/index'

declare global {
  interface Window {
    tick: TickApi
  }
}

export function useSettings(): {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<void>
} {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    let alive = true
    void window.tick.settings.get().then((s) => {
      if (alive) setSettings(s)
    })
    const off = window.tick.settings.onChanged((s) => {
      if (alive) setSettings(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const next = await window.tick.settings.update(patch)
    setSettings(next)
  }, [])

  return { settings, update }
}
