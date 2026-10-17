/**
 * canonicalPath — 路径同一性（集中 ai/core，所有 adapter 输出先过它）。
 *
 * 项目主键 = canonical 路径（PRD F3 / TECH-ARCH §6.1），规则：
 *  1. 折叠重复斜杠 / 去尾斜杠（根 "/" 保留）
 *  2. 非 FS 根的路径 → realpath 深层的"已存在祖先"：
 *     - 解析 symlink（macOS /tmp → /private/tmp、~ 内软链家目录等，统一成同一形态）
 *     - 不存在的末段（即将被创建的 cwd）原样拼到真实前缀之后
 *  3. 绝对路径输入是合同；相对/空串按"不可归一"原样返回（由上层容错）
 *
 * 注意：不建议对"文件"以外强行容错——cwd 永远是目录语义。
 */

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export function canonicalPath(inputPath: string): string {
  const collapsed = inputPath.replace(/\/{2,}/g, '/')
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
  if (!trimmed || !path.isAbsolute(trimmed)) return trimmed

  // 找最深已存在祖先（存在性判断不跟随 symlink 目标，realpath 才解链）
  let existing = trimmed
  const suffix: string[] = []
  for (;;) {
    if (existsSync(existing)) break
    const parent = path.dirname(existing)
    if (parent === existing) break // 到 FS 根仍不存在？
    suffix.unshift(path.basename(existing))
    existing = parent
  }
  try {
    const real = realpathSync(existing)
    return suffix.length ? path.join(real, ...suffix) : real
  } catch {
    // realpath 失败（权限等）：保持折叠后的字面形态，保证主键稳定
    return trimmed
  }
}

/** 两个 canonical 路径是否同一条目（区分大小写前先按 FS 语义试探一次） */
export function sameCanonicalPath(a: string, b: string): boolean {
  if (a === b) return true
  // 大小写不敏感文件系统（macOS 默认）：比较两次 realpath 形态
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase()
  } catch {
    // 不存在/不可 realpath 的路径：大小写不敏感 FS 上按小写比较（a===b 已在上面提前返回）
    return a.toLowerCase() === b.toLowerCase()
  }
}
