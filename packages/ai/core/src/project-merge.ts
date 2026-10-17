/**
 * mergeProjects — 工具无关的归并纯函数（不依赖任何 adapter，fs 仅注入或兜底）。
 *
 * 规则（PRD F3 / TECH-ARCH §6.1）：
 *   1. 归一化（canonicalPath）——相对路径/空直接丢弃（cwd 语义必须是绝对路径）
 *   2. git 根上卷（默认开）：含 .git 的最近祖先为项目根；home `~` 不是项目，不参与上卷
 *      （git worktree 的 .git 是文件，同样算根，但不再继续向上合并）
 *   3. 按 canonical 根合并：tools 多值标签、sessionCount 求和、lastUsedAt 取 max、
 *      children 收集上卷前的真实 cwd、exists 取或
 *   4. 排序：lastLaunchedAt（Tick 自己的跨工具时钟，最高优先）> lastUsedAt（adapter）
 *      > 字典序（稳定兜底）
 *
 * lastLaunchedAt / pinned 不在此生成：它们是 Tick 侧持久状态，由调用方（ProjectIndexService）
 * 在合并结果上覆盖注入——纯函数只负责"证据 → 归并形态"。
 */

import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalPath } from './canonical-path'
import type { ProjectEntry, ProjectSource } from './index'

export interface MergeOptions {
  /** 归一化/git 判断的 home 界（默认 os.homedir()；测试可注入） */
  homedir?: string
  /** 目录存在性注入（测试） */
  pathExists?: (p: string) => boolean
}

const sep = path.sep

/** dir 是否严格位于 home 内部（home 自己与外部都算"不在 home 之下"） */
function strictlyUnderHome(dir: string, home: string): boolean {
  return dir.startsWith(home.endsWith(sep) ? home : home + sep)
}

/**
 * git 根上卷判断：沿目录向上找包含 `.git`（目录=普通仓库 / 文件=worktree、submodule）的祖先。
 * 上界：home 本身与 home 之上都不算（home 不是项目）；离开 home 后在外部 FS 继续允许（如 /tmp 下项目），上界 = FS 根。
 */
export function gitRootOf(
  projectPath: string,
  opts: MergeOptions = {},
): string | null {
  const exists = opts.pathExists ?? ((p: string) => existsSync(p))
  const home = opts.homedir ?? os.homedir()
  let dir = projectPath
  for (;;) {
    if (strictlyUnderHome(dir, home) || dir !== home) {
      if (exists(path.join(dir, '.git'))) return dir
    }
    // home 不是项目：走到 home 或 home 之上即停止向上（home 及其祖先永不成为项目根）
    if (dir === home || !path.isAbsolute(dir) && dir === sep) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null // FS 根
    if (!strictlyUnderHome(parent, home) && strictlyUnderHome(dir, home)) {
      // 本来在 home 之下，下一步跨出 home（home 的祖先）：上卷终行
      return null
    }
    dir = parent
  }
}

export function sortEntries(entries: ProjectEntry[]): ProjectEntry[] {
  const clockOf = (e: ProjectEntry): number | undefined => e.lastLaunchedAt
  const usedOf = (e: ProjectEntry): number => e.lastUsedAt ?? 0
  return [...entries].sort((a, b) => {
    const ca = clockOf(a)
    const cb = clockOf(b)
    if (ca !== undefined || cb !== undefined) {
      if (ca === undefined) return 1 // 有时钟的排前
      if (cb === undefined) return -1
      if (ca !== cb) return cb - ca
    }
    const ua = usedOf(a)
    const ub = usedOf(b)
    if (ua !== ub) return ub - ua
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

export function mergeProjects(
  sources: ProjectSource[],
  opts: MergeOptions = {},
): ProjectEntry[] {
  const map = new Map<string, ProjectEntry>()
  for (const source of sources) {
    for (const raw of source.projects ?? []) {
      const p = canonicalPath(raw.path)
      if (!path.isAbsolute(p)) continue
      const root = gitRootOf(p, opts) ?? p
      let entry = map.get(root)
      if (!entry) {
        entry = {
          path: root,
          children: [],
          tools: [],
          sessionCount: 0,
          pinned: false,
          exists: false,
        }
        map.set(root, entry)
      }
      if (!entry.tools.includes(source.toolId)) entry.tools.push(source.toolId)
      entry.sessionCount += raw.sessionCount ?? 0
      if (raw.lastUsedAt && (entry.lastUsedAt === undefined || raw.lastUsedAt > entry.lastUsedAt)) {
        entry.lastUsedAt = raw.lastUsedAt
      }
      entry.exists = entry.exists || !!raw.exists
      if (root !== p && entry.children && !entry.children.includes(p)) {
        entry.children.push(p)
      }
    }
  }
  for (const entry of map.values()) entry.children?.sort()
  return sortEntries([...map.values()])
}
