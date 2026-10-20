/**
 * Claude Code locator — 会话文件：`~/.claude/projects/<编码 cwd>/<uuid>.jsonl`
 *
 * 为什么只读文件头部的「首条带 cwd 的记录」而不扫全文：MCP 回扫只做「句柄字面量命中」，
 * 命中后要给出 sessionId 与 cwd；正文由 probe-scan 自己读，locator 只负责身份。
 *
 * 与 pi locator 的差异（实测 2.1.302）：
 *  - **没有首行 header**：第一行可能是 `queue-operation` / `mode` / `custom-title`；
 *  - 会话 id 来自文件名（`<uuid>.jsonl`）与记录里的 `sessionId`（两者一致，实测）。
 *
 * 覆盖链：`CLAUDE_CONFIG_DIR` > `~/.claude`（官方文档「Move storage off ~/.claude」）。
 * 只读：不创建目录、不写任何文件、不读 `.credentials.json` / `~/.claude.json`。
 */

import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  findSessionFile,
  isDesktopEntrypoint,
  readSessionMeta,
  resolveSessionRoots,
  sessionIdOfFile,
  type ClaudeSessionRoot,
} from '@tick/ai-claude'
import { collectDesktopSessions, findTranscriptInHome, isLocalSessionId } from '@tick/ai-claude-desktop'
import type { SessionLocator } from './types'

function sizeOf(file: string): number | undefined {
  try {
    const st = statSync(file)
    return st.isFile() ? st.size : undefined
  } catch {
    return undefined
  }
}

/**
 * @param opts.includeDesktop 是否把 Claude Desktop 的 Code tab 会话也算进 `claude`。
 *   MCP 绑定按 toolId 路由，Desktop 会话属于 `claude-desktop`，默认排除（避免同一个会话
 *   在两个 toolId 下都能命中）。测试可以打开它来验证过滤逻辑。
 */
export function createClaudeLocator(
  opts: { includeDesktop?: boolean; env?: NodeJS.ProcessEnv; home?: string } = {},
): SessionLocator {
  const env = opts.env ?? process.env
  const sessionRoots = (): ClaudeSessionRoot[] => resolveSessionRoots(env, opts.home)
  const roots = () => sessionRoots().map((r) => r.dir)

  return {
    toolId: 'claude',
    displayName: 'Claude Code',

    matches(client) {
      // clientInfo.name：Claude Code 的 MCP 客户端自报 `claude-code`（实测 2.1.302）
      const name = (client.name ?? '').toLowerCase()
      return name === 'claude' || name === 'claude-code' || name === 'claude_code'
    },

    roots,

    async readSession(filePath) {
      const size = sizeOf(filePath)
      if (!size) return undefined // 0 字节 = 还没产生（不变量 3）
      const fileId = sessionIdOfFile(filePath)
      if (!fileId) return undefined // subagents/、tool-results/、.orphaned-* 一律不是主会话
      const meta = await readSessionMeta(filePath).catch(() => undefined)
      if (!meta) return undefined
      if (!opts.includeDesktop && isDesktopEntrypoint(meta.entrypoint)) return undefined
      // 文件名的 id 与记录里的 sessionId 必须一致才敢用（手拷副本会不一致）
      if (meta.sessionId && meta.sessionId.toLowerCase() !== fileId.toLowerCase()) return undefined
      return {
        sessionId: fileId,
        cwd: meta.cwd && path.isAbsolute(meta.cwd) ? meta.cwd : undefined,
        filePath,
        resumable: true,
      }
    },

    resumeSpec(sessionId, cwd) {
      // 真正的 resume 走 @tick/ai-claude adapter（--resume <会话文件绝对路径> + 会话自己的 cwd）；
      // 这里只给调用方一个**提示**：executable 是裸命令名，GUI 最小 PATH 下定位不到，
      // 调用方必须自己经 probe-exe 解析后再执行（CLAUDE.md 不变量 15）。
      // target 给绝对路径而不是裸 id：与 adapter 的 resume 纪律一致，找不到正文时不编一条。
      const file = findSessionFile(sessionId, sessionRoots())
      if (!file) return undefined
      return {
        kind: 'terminal',
        target: file,
        executable: 'claude',
        args: ['--resume', file],
        ...(cwd ? { cwd } : {}),
      }
    },
  }
}

/**
 * 正文属于哪个 Desktop 会话（`local_<id>`）？
 *
 * 两条判据（本机两条都实测存在）：
 *  1. `record → 会话 home → 正文`，路径相同即命中（Desktop 原生会话）；
 *  2. `record.cliSessionId / priorCliSessionIds === 文件名里的 CLI uuid`：正文可能落在**全局**
 *     `~/.claude/projects`（`entrypoint=claude-desktop-3p`、没有 per-session home；
 *     2026-10-20 复核推翻「Desktop 自己的会话不在全局 store」的旧结论）。
 *
 * 为什么要覆盖第 2 条：否则同一工具、同一对话在 UI 侧（adapter 列表给 `local_`）与
 * MCP 回扫侧（locator 给 CLI uuid）会得到两个 id，同一条对话可能被绑定两次。
 */
function ownerRecordOf(
  filePath: string,
  opts: { home?: string },
): { localId: string; cwd?: string; archived: boolean } | undefined {
  let target: string
  try {
    target = path.resolve(filePath)
  } catch {
    return undefined
  }
  const fileId = sessionIdOfFile(filePath)?.toLowerCase()
  for (const record of collectDesktopSessions(opts.home)) {
    const hit = findTranscriptInHome(record.homeDir, record)
    if (hit) {
      let resolved: string | undefined
      try {
        resolved = path.resolve(hit.filePath)
      } catch {
        resolved = undefined
      }
      if (resolved === target) {
        return { localId: record.localId, cwd: record.cwd, archived: record.archived }
      }
    }
    if (!fileId) continue
    const ids = [record.cliSessionId, ...record.priorCliSessionIds]
    if (ids.some((id) => id?.toLowerCase() === fileId)) {
      return { localId: record.localId, cwd: record.cwd, archived: record.archived }
    }
  }
  return undefined
}

/**
 * Claude Desktop locator：**两套存储**都要扫。
 *  - Desktop 自己的会话：`<userData>/<kind>/<acct>/<org>/local_<id>/.claude/projects/…`；
 *  - 被 adopt 的 CLI 会话：全局 `~/.claude/projects`（靠 entrypoint 认领）。
 */
export function createClaudeDesktopLocator(
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): SessionLocator {
  const env = opts.env ?? process.env
  const roots = () => {
    const dirs = new Set(resolveSessionRoots(env, opts.home).map((r) => r.dir))
    for (const record of collectDesktopSessions(opts.home)) {
      const projects = path.join(record.homeDir, '.claude', 'projects')
      if (existsSync(projects)) dirs.add(projects)
    }
    return [...dirs]
  }

  return {
    toolId: 'claude-desktop',
    displayName: 'Claude Desktop',

    matches(client) {
      const name = (client.name ?? '').toLowerCase()
      // Desktop 内置 agent 的 MCP 客户端名未公开；只认明确自报的形态，不猜
      return name === 'claude-desktop' || name === 'claude_desktop'
    },

    roots,

    async readSession(filePath) {
      const size = sizeOf(filePath)
      if (!size) return undefined
      const fileId = sessionIdOfFile(filePath)
      if (!fileId) return undefined
      const meta = await readSessionMeta(filePath).catch(() => undefined)
      if (!meta) return undefined
      if (meta.sessionId && meta.sessionId.toLowerCase() !== fileId.toLowerCase()) return undefined

      // ① Desktop 自己的会话：正文在 `<userData>/…/local_<id>/.claude/projects/…`，
      //    绑定 id 必须是 `local_<id>`（否则深链接打不开它）。
      const owner = ownerRecordOf(filePath, opts)
      if (owner) {
        if (owner.archived) return undefined
        return {
          sessionId: owner.localId,
          cwd: meta.cwd && path.isAbsolute(meta.cwd) ? meta.cwd : owner.cwd,
          filePath,
          resumable: true,
        }
      }
      // ② 全局 store 里被 Desktop adopt 的 CLI 会话：靠 entrypoint 认领
      if (!isDesktopEntrypoint(meta.entrypoint)) return undefined
      return {
        sessionId: fileId,
        cwd: meta.cwd && path.isAbsolute(meta.cwd) ? meta.cwd : undefined,
        filePath,
        resumable: true,
      }
    },

    resumeSpec(sessionId) {
      // Desktop 只能经深链接回到会话；真正的调用走 @tick/ai-claude-desktop adapter。
      // 两套 id 的链接不同（见 docs/claude-code-adapter-notes.md §3）。
      return isLocalSessionId(sessionId)
        ? { kind: 'deeplink', target: sessionId, url: `claude://code/continue?session=${encodeURIComponent(sessionId)}` }
        : { kind: 'deeplink', target: sessionId, url: `claude://resume?session=${encodeURIComponent(sessionId)}` }
    },
  }
}
