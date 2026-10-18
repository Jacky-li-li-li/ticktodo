/**
 * ProjectIndexService — main 进程的项目索引聚合（TECH-ARCH §5）。
 *
 * 取数纪律（照 magpie 实证，RESEARCH-magpie §7）：
 *   - 冷启动首帧走 cache/projects.json（renderer 不等扫描）
 *   - 后台重扫：向每个 adapter 要**原始证据**（discoverProjects），归并交给 core 的 mergeProjects
 *   - 单工具读取失败必须隔离（规则 §7）：只丢它的证据，不拖垮整个项目列表
 *   - Warm/Ask 两级调度 M1 简化为「启动后台扫 + 手动 refresh」；存在性每次现算
 *
 * 历史包袱（M1 单工具期的 files 增量缓存）已删除：它是 pi 专属实现（要扫 pi 的会话根），
 * 第二/第三个工具的会话存储格式各不相同，文件级增量只能在各自 adapter 内部做。
 * 老 cache/projects.json 里多余的 `files` 字段读取时忽略，下次重扫写回即消失。
 *
 * lastLaunchedAt / pinned 是 Tick 侧状态：lastLaunch 由 TodoStore 提供（跨工具时钟），
 * pinned（用户手动加项目）持久在 cache 文件里，重扫时保留。
 */

import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AiToolAdapter, ProjectEntry, ProjectSource } from '@tick/ai-core'
import { canonicalPath, mergeProjects, sortEntries } from '@tick/ai-core'
import { atomicWriteJson, readJson } from './storage'

interface CacheFile {
  version: 1
  updatedAt: string
  projects: ProjectEntry[]
  pinned: string[]
  /** 失效目录的重新定位映射：old canonical → new canonical（只做映射，不动工具自己的文件） */
  aliases?: Record<string, string>
}

/** 旧版本（单工具期）的缓存可能多带 `files`；读取时显式挑字段，避免把多余数据带进新缓存 */
type CachedFileMaybeLegacy = Partial<CacheFile> & { files?: unknown }

function emptyCache(): CacheFile {
  return { version: 1, updatedAt: '', projects: [], pinned: [], aliases: {} }
}

export interface ProjectIndexOptions {
  /** 跨工具时钟：路径 → 该项目最近一次被 Tick 拉起的时间（来自 TodoStore.lastLaunch） */
  launchClock?: () => Map<string, number>
}

export class ProjectIndexService {
  private adapters: AiToolAdapter[]
  private cacheFile: string
  private opts: ProjectIndexOptions

  private cache: CacheFile = emptyCache()
  private loaded = false
  private scanning: Promise<ProjectEntry[]> | null = null

  constructor(adapters: AiToolAdapter[], cacheFile: string, opts: ProjectIndexOptions = {}) {
    this.adapters = adapters
    this.cacheFile = cacheFile
    this.opts = opts
  }

  /** 启动时读缓存（丢了/坏了 = 从零重扫，可再生层语义） */
  async init(): Promise<void> {
    const cached = readJson<CachedFileMaybeLegacy>(this.cacheFile)
    if (cached?.version === 1) {
      this.cache = {
        version: 1,
        updatedAt: cached.updatedAt ?? '',
        projects: cached.projects ?? [],
        pinned: cached.pinned ?? [],
        aliases: cached.aliases ?? {},
      }
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
        const sources = (await Promise.all(this.adapters.map((a) => this.sourceOf(a)))).filter(
          (s): s is ProjectSource => s !== undefined,
        )
        const merged = mergeProjects(sources)
        this.cache = {
          version: 1,
          updatedAt: new Date().toISOString(),
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
   * 单个工具的证据；没实现 discoverProjects 的工具跳过，实现抛错也只丢自己（失败降级）。
   * 日志只记工具 id 与错误消息，不含项目/会话内容。
   */
  private async sourceOf(adapter: AiToolAdapter): Promise<ProjectSource | undefined> {
    if (!adapter.discoverProjects) return undefined
    try {
      return { toolId: adapter.id, projects: await adapter.discoverProjects() }
    } catch (e) {
      console.warn(`[tick] ${adapter.id} 项目发现失败:`, (e as Error).message)
      return undefined
    }
  }

  /**
   * 用户手动加项目（F3）：canonical 化后 pin 进缓存并立即落盘，
   * 这样即使工具不可用/没有会话，项目也能一直出现在选择器里（不参与 stale 清理）。
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

  /** 叠加 Tick 侧状态：lastLaunchedAt（时钟）+ pinned 用户条目 + 失效目录别名 */
  private overlay(entries: ProjectEntry[], clock: Map<string, number>): ProjectEntry[] {
    const aliases = this.cache.aliases ?? {}
    for (const e of entries) {
      if (aliases[e.path]) {
        // 目录改名的替代：列表按新路径展示（不移动任何工具文件）
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

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.init()
  }
}
