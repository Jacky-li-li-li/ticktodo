/**
 * WorkBuddy locator（国内版 / 国际版共用逻辑，身份由 WorkbuddyIdentity 注入）。
 *
 * 扫描根：`<root>/projects`（每个编码 cwd 一个目录）。
 * 会话文件：`<root>/projects/<编码 cwd>/<sessionId>.jsonl`；
 * 大工具结果：`<root>/projects/<编码 cwd>/<sessionId>/tool-results/**`（句柄可能只出现在这里）。
 *
 * 只读：cwd 先看 `.meta.json`，再退化到 DB（readSessionRows 带 WAL 复制兜底）。
 * 不读 settings/keyblob 等敏感文件；不写任何文件。
 */

import path from 'node:path'
import { statSync } from 'node:fs'
import {
  isPlainSessionId,
  projectsDir,
  readMetaCwd,
  readSessionRows,
  resolveRootDir,
} from '@tick/ai-workbuddy'
import type { WorkbuddyIdentity } from '@tick/ai-workbuddy'
import type { SessionLocator } from './types'

export interface WorkbuddyLocatorDeps {
  /** 测试/隔离用根目录覆盖；产品运行时由 identity.defaultRootName / env 解析 */
  rootDir?: string
}

function sizeOf(file: string): number | undefined {
  try {
    const st = statSync(file)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

export function createWorkbuddyLocator(
  identity: WorkbuddyIdentity,
  deps: WorkbuddyLocatorDeps = {},
): SessionLocator {
  const root = (): string => resolveRootDir(identity, { rootDir: deps.rootDir })

  return {
    toolId: identity.toolId,
    displayName: identity.displayName,

    matches(client) {
      const name = (client.name ?? '').toLowerCase()
      if (!name) return false
      if (identity.toolId === 'workbuddy-ai') return /workbuddy[\s_-]*ai/.test(name)
      return /workbuddy/.test(name) && !/workbuddy[\s_-]*ai/.test(name)
    },

    roots() {
      return [projectsDir(root())]
    },

    async readSession(filePath) {
      if (!sizeOf(filePath)) return undefined
      const projects = projectsDir(root())
      const rel = path.relative(projects, filePath)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
      const parts = rel.split(path.sep)
      if (parts.length < 2) return undefined

      // <id>.jsonl 或 <id>/tool-results/<file>：第一段是编码 cwd，第二段是会话目录/文件名
      const second = parts[1] as string
      const sessionId = second.endsWith('.jsonl') ? path.basename(second, '.jsonl') : second
      if (!isPlainSessionId(sessionId)) return undefined

      let cwd = readMetaCwd(root(), sessionId)
      let resumable = true
      try {
        const [row] = await readSessionRows(root(), { log: () => {}, id: sessionId })
        if (row) {
          if (row.cwd && path.isAbsolute(row.cwd)) cwd = row.cwd
          // 国际版 playground：深链接冷启动回落归因未证伪 → 保守置灰
          if (identity.playgroundUnresumable && row.isPlayground) resumable = false
        }
      } catch {
        /* DB 读失败不影响身份（文件名即 id）；只是少一个 cwd/playground 判断 */
      }

      return { sessionId, ...(cwd ? { cwd } : {}), filePath, resumable }
    },

    resumeSpec(sessionId) {
      const url = `${identity.scheme}://chat/${sessionId}`
      return { kind: 'deeplink', target: url, url }
    },
  }
}
