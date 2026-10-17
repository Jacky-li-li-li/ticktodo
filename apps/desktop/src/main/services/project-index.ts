/**
 * ProjectIndexService — main 进程的项目索引聚合（TECH-ARCH §5）。
 *
 * 取数纪律（照 magpie 实证，RESEARCH-magpie §7）：
 *   - 冷启动首帧走 cache/projects.json（renderer 不等扫描）
 *   - 后台重扫 + (size,mtime) 文件级增量（未变的文件复用缓存的 header 结论）
 *   - verify 类判定绕缓存直读（本项目：resolve 项目路径存在性每次现算）
 *   - Warm/Ask 两级调度 M1 简化为「启动后台扫 + 手动 refresh」；2s racy 窗口由 (size,mtime)
 *     缓存 + 存在性现算自然覆盖，checkpoint 接口留待 M3 需要时再开
 *
 * lastLaunchedAt / pinned 是 Tick 侧状态：lastLaunch 由 TodoStore 提供（跨工具时钟），
 * pinned（用户手动加项目）持久在 cache 文件里，重扫时保留。
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ProjectEntry, ProjectSource } from '@tick/ai-core'
import { mergeProjects, sortEntries } from '@tick/ai-core'
import type { PiAdapter } from '@tick/ai-pi'
import { collectJsonlFiles, readFirstLineHeader, type SessionRoot } from '@tick/ai-pi'
import { atomicWriteJson, readJson } from './storage'

interface CachedFileMeta {
  size: number
  mtimeMs: number
  cwd: string
  id?: string
}

interface CacheFile {
  version: 1
  updatedAt: string
  files: Record<string, CachedFileMeta>
  projects: ProjectEntry[]
  pinned: string[]
}

const EMPTY_CACHE: CacheFile = {
  version: 1,
  updatedAt: '',
  files: {},
  projects: [],
  pinned: [],
}

export interface ProjectIndexOptions {
  /** 跨工具时钟：路径 → 该项目最近一次被 Tick 拉起的时间（来自 TodoStore.lastLaunch） */
  launchClock?: () => Map<string, number>
  /** 根注入（测试隔离；默认 adapter 自行解析） */
  sessionRoots?: () => SessionRoot[]
}

export class ProjectIndexService {
  private adapter: PiAdapter
  private cacheFile: string
  private opts: ProjectIndexOptions

  private cache: CacheFile = { ...EMPTY_CACHE, files: {}, projects: [], pinned: [] }
  private loaded = false
  private scanning: Promise<ProjectEntry[]> | null = null

  constructor(adapter: PiAdapter, cacheFile: string, opts: ProjectIndexOptions = {}) {
    this.adapter = adapter
    this.cacheFile = cacheFile
    this.opts = opts
  }

  /** 启动时读缓存（丢了/坏了 = 从零重扫，可再生层语义） */
  async init(): Promise<void> {
    const cached = readJson<CacheFile>(this.cacheFile)
    if (cached?.version === 1) {
      this.cache = cached
    }
    this.loaded = true
  }

  /** 首帧取数：只给缓存，不等扫描（冷启动纪律） */
  getCachedProjects(): ProjectEntry[] {
    const clock = this.opts.launchClock?.() ?? new Map()
    return this.overlay(sortEntries(structuredClone(this.cache.projects)), clock)
  }

  /** 手动/后台重扫。并发触发只跑一次，共享同一结果（Warm 简化）。 */
  refresh(): Promise<ProjectEntry[]> {
    if (this.scanning) return this.scanning
    this.scanning = (async () => {
      try {
        const files = new Map<string, CachedFileMeta>(Object.entries(this.cache.files))
        const byCwd = new Map<string, { sessionCount: number; lastUsedAt?: number }>()

        for (const root of this.sessionRoots()) {
          for (const file of collectJsonlFiles(root.dir)) {
            let st
            try {
              st = statSync(file)
            } catch {
              files.delete(file)
              continue
            }
            if (st.size === 0) {
              files.delete(file) // 僵尸：永远不索引（D16）
              continue
            }
            const cached = files.get(file)
            if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
              // (size,mtime) 未变 → 复用上次 header 结论，不重读首行
              this.bump(byCwd, cached.cwd, st.mtimeMs)
              continue
            }
            const header = readFirstLineHeader(file)
            if (!header?.cwd || !path.isAbsolute(header.cwd)) {
              files.delete(file)
              continue
            }
            files.set(file, { size: st.size, mtimeMs: st.mtimeMs, cwd: header.cwd, id: header.id })
            this.bump(byCwd, header.cwd, st.mtimeMs)
          }
        }

        const source: ProjectSource = {
          toolId: this.adapter.id,
          projects: [...byCwd.entries()].map(([p, e]) => ({
            path: p,
            sessionCount: e.sessionCount,
            lastUsedAt: e.lastUsedAt,
            exists: existsSync(p),
          })),
        }
        const merged = mergeProjects([source])
        this.cache = {
          version: 1,
          updatedAt: new Date().toISOString(),
          files: Object.fromEntries(files),
          projects: merged,
          pinned: this.cache.pinned,
        }
        try {
          atomicWriteJson(this.cacheFile, this.cache)
        } catch {
          /* 缓存写失败不致命：下次重扫 */
        }
        const clock = this.opts.launchClock?.() ?? new Map()
        return this.overlay(sortEntries(structuredClone(merged)), clock)
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  /** 用户手动加项目（M3+ 使用；现在先持久链路就绪） */
  pin(projectPath: string): void {
    if (!this.cache.pinned.includes(projectPath)) this.cache.pinned.push(projectPath)
  }

  unpin(projectPath: string): void {
    this.cache.pinned = this.cache.pinned.filter((p) => p !== projectPath)
  }

  /** evidence-only merge 结果晚于缓存：调用方把 Tick 时钟/pinned 叠到最新结果上 */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.init()
  }

  private sessionRoots(): SessionRoot[] {
    if (this.opts.sessionRoots) return this.opts.sessionRoots()
    return this.adapter.sessionRoots()
  }

  private bump(
    byCwd: Map<string, { sessionCount: number; lastUsedAt?: number }>,
    cwd: string,
    mtimeMs: number,
  ): void {
    let e = byCwd.get(cwd)
    if (!e) {
      e = { sessionCount: 0 }
      byCwd.set(cwd, e)
    }
    e.sessionCount += 1
    if (e.lastUsedAt === undefined || mtimeMs > e.lastUsedAt) e.lastUsedAt = mtimeMs
  }

  /** 叠加 Tick 侧状态：lastLaunchedAt（时钟）+ pinned 用户条目 */
  private overlay(entries: ProjectEntry[], clock: Map<string, number>): ProjectEntry[] {
    for (const e of entries) {
      const t = clock.get(e.path)
      if (t !== undefined) e.lastLaunchedAt = t
      if (this.cache.pinned.includes(e.path)) e.pinned = true
    }
    // pinned 且证据里没有的：手动添加的孤条（sessionCount 0）也展示
    for (const p of this.cache.pinned) {
      if (!entries.some((e) => e.path === p)) {
        entries.push({
          path: p,
          tools: [],
          sessionCount: 0,
          pinned: true,
          exists: existsSync(p),
        })
      }
    }
    return sortEntries(entries)
  }

  /** 保障 init 已跑（refresh 前调用）——显式 async 入口 */
  ready(): Promise<void> {
    return this.ensureLoaded()
  }
}
