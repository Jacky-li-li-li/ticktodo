/**
 * useProjects — 项目索引的 renderer 侧（首帧走缓存，后台扫完再换）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ProjectEntry } from '@tick/ai-core'
import type { TickApi } from '../../preload/index'

declare global {
  interface Window {
    tick: TickApi
  }
}

export function useProjects(): {
  projects: ProjectEntry[]
  refresh: () => Promise<void>
} {
  const [projects, setProjects] = useState<ProjectEntry[]>([])

  const refresh = useCallback(async () => {
    setProjects(await window.tick.projects.list())
  }, [])

  useEffect(() => {
    let alive = true
    void window.tick.projects.list().then((p) => {
      if (alive) setProjects(p)
    })
    const off = window.tick.projects.onUpdate((p) => {
      if (alive) setProjects(p)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return { projects, refresh }
}
