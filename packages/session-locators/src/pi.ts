/**
 * pi locator — 会话文件：`<root>/--<cwd>--/<timestamp>_<uuid>.jsonl`
 *
 * 路径解析复用 `@tick/ai-pi` 的 resolveSessionRoots（尊重 PI_CODING_AGENT_DIR /
 * PI_CODING_AGENT_SESSION_DIR / settings.sessionDir），不硬扫默认目录。
 */

import { statSync } from 'node:fs'
import { readFirstLineHeader, resolveSessionRoots } from '@tick/ai-pi'
import type { SessionLocator } from './types'

function sizeOf(file: string): number | undefined {
  try {
    const st = statSync(file)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

export const piLocator: SessionLocator = {
  toolId: 'pi',
  displayName: 'pi',

  matches(client, env) {
    if (/^pi$/i.test(client.name ?? '')) return true
    // 自建 wrapper 可能没设 clientInfo.name，但有 pi 的会话目录环境变量
    return !client.name && Boolean(env.PI_CODING_AGENT_DIR || env.PI_CODING_AGENT_SESSION_DIR)
  },

  roots() {
    return resolveSessionRoots().map((r) => r.dir)
  },

  async readSession(filePath) {
    const size = sizeOf(filePath)
    if (!size) return undefined // 0 字节 = 僵尸会话（不变量 3）
    const header = readFirstLineHeader(filePath)
    if (!header?.id) return undefined
    return {
      sessionId: header.id,
      cwd: typeof header.cwd === 'string' && header.cwd ? header.cwd : undefined,
      filePath,
      resumable: true,
    }
  },

  resumeSpec(sessionId, cwd) {
    // 真正的 resume 走 @tick/ai-pi adapter（--session <path> + header cwd）；
    // 这里只给调用方一个提示，不直接执行。
    return {
      kind: 'terminal',
      target: sessionId,
      executable: 'pi',
      args: ['--session', sessionId],
      ...(cwd ? { cwd } : {}),
    }
  },
}
