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

import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ProjectEntry, ProjectSource } from '@tick/ai-core'
import { canonicalPath, mergeProjects, sortEntries } from '@tick/ai-core'
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
  /** 失效目录的重新定位映射：old canonical → new canonical（只做映射，不动 pi 的文件） */
  aliases?: Record<string, string>
}

const EMPTY_CACHE: CacheFile = {
  version: 1,
  updatedAt: '',
  files: {},
  projects: [],
  pinned: [],
  aliases: {},
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
      this.cache = { ...cached, aliases: cached.aliases ?? {} }
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
        // Q8 硬约束：文件级增量按 (size,mtime)，消失的条目必须从缓存删除。
        // 旧实现只增不删，cache/projects.json 的 files 会无限增长。
        const seen = new Set<string>()

        for (const root of this.sessionRoots()) {
          for (const file of collectJsonlFiles(root.dir)) {
            seen.add(file)
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

        for (const known of files.keys()) {
          if (!seen.has(known)) files.delete(known)
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
          aliases: this.cache.aliases ?? {},
        }
        this.saveCache()
        const clock = this.opts.launchClock?.() ?? new Map()
        return this.overlay(sortEntries(structuredClone(merged)), clock)
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  /**
   * 用户手动加项目（F3）：canonical 化后 pin 进缓存并立即落盘，
   * 这样即使 pi 不可用/没有会话，项目也能一直出现在选择器里（不参与 stale 清理）。
   */
  pin(projectPath: string): void {
    const p = canonicalPath(projectPath)
    if (!this.cache.pinned.includes(p)) {
      this.cache.pinned.push(p)
      this.saveCache()
    }
  }

  unpin(projectPath: string): void {
    const p = canonicalPath(projectPath)
    const next = this.cache.pinned.filter((x) => x !== p)
    if (next.length === this.cache.pinned.length) return
    this.cache.pinned = next
    this.saveCache()
  }

  /** 失效目录重新定位（F3）：记录 old→new 映射并 pin 新目录，返回新路径 */
  relocate(oldPath: string, newPath: string): string {
    const oldCanonical = canonicalPath(oldPath)
    const newCanonical = canonicalPath(newPath)
    this.cache.aliases = { ...(this.cache.aliases ?? {}), [oldCanonical]: newCanonical }
    if (!this.cache.pinned.includes(newCanonical)) this.cache.pinned.push(newCanonical)
    this.saveCache()
    return newCanonical
  }

  /** 给 CwdResolver 用：记住的旧目录失效时，查是否有重新定位映射 */
  aliasOf(projectPath: string): string | undefined {
    return (this.cache.aliases ?? {})[canonicalPath(projectPath)]
  }

  private saveCache(): void {
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 })
      atomicWriteJson(this.cacheFile, this.cache)
    } catch {
      /* cache 可再生产：写失败下次重扫/重启再说 */
    }
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

  /** 叠加 Tick 侧状态：lastLaunchedAt（时钟）+ pinned 用户条目 + 失效目录别名 */
  private overlay(entries: ProjectEntry[], clock: Map<string, number>): ProjectEntry[] {
    const aliases = this.cache.aliases ?? {}
    for (const e of entries) {
      if (aliases[e.path]) {
        // 目录改名的替代：列表按新路径展示（不移动任何 pi 文件）
        e.path = aliases[e.path] as string
        e.exists = existsSync(e.path)
      }
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
