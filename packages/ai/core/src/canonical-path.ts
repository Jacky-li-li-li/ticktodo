/**
 * canonicalPath — 路径同一性（集中 ai/core，所有 adapter 输出先过它）。
 * M1 实装：realpath（symlink）/ `/private/var` ↔ `/var` / 大小写不敏感 FS /
 * trailing slash / git worktree（`.git` 是文件时不再向上归并）。
 */

export function canonicalPath(path: string): string {
  // TODO(M1): fs.realpathSync + /private/var 归一 + trailing slash 处理
  return path.replace(/\/+$/, '')
}
