/**
 * mergeProjects — 工具无关的归并纯函数（可单测，不依赖任何 adapter）。
 * 规则（PRD F3 / TECH-ARCH §6.1）：
 *   1. 归一化（canonicalPath）
 *   2. git 根上卷（默认开；home `~` 不参与——它不是项目，不向上找 .git）
 *   3. 按路径合并证据（tools 多值、sessionCount 求和、lastUsedAt 取 max）
 *   4. 排序：lastLaunchedAt（Tick 时钟）> lastUsedAt（adapter）> 目录 mtime
 * M1 实装。
 */

import type { ProjectEntry, ProjectSource } from './index'

export function mergeProjects(sources: ProjectSource[]): ProjectEntry[] {
  // TODO(M1)
  return []
}
