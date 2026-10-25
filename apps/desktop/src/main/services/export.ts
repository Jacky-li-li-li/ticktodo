/**
 * export — F8：把 todo + 关联会话的**索引记录**导出（JSON + Markdown）。
 *
 * 纪律（PRD F8）：
 *  - 导出的是索引，不是对话内容；不复制 pi 的文件；
 *  - `filePath` 必须给（拿到记录就能定位原始会话），`exists` 实时判定；
 *  - 多文件会话（Codex 一个 thread 跨多个 rollout）另给 `files` 全部正文文件，`filePath` 仍是主文件；
 *  - `usage` 仅在设置开用量统计时有值，否则 null；
 *  - 产物落 `~/.ticktodo/exports/tick-export-<ts>.{json,md}`。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings, ExportRequest, ExportResult, ExportScope, Todo } from '@tick/shared'
import type { AiToolAdapter, SessionUsage } from '@tick/ai-core'
import { atomicWriteJson, writeFileAtomic } from './storage'
import type { TodoStore } from '../store'

interface ExportedSession {
  toolId: string
  sessionId: string
  cwd: string
  name?: string
  /** 主文件（多文件会话取最新那个；导出/定位默认打开它） */
  filePath: string | null
  /** 多文件会话（as-built：Codex 一个 thread 跨多个 rollout）的全部正文文件 */
  files?: string[]
  exists: boolean
  usage: SessionUsage | null
}

interface ExportedTodo {
  id: string
  title: string
  body?: string
  status: Todo['status']
  createdAt: string
  updatedAt: string
  lastLaunch?: Todo['lastLaunch']
  sessions: ExportedSession[]
}

export class ExportService {
  constructor(
    private adapters: AiToolAdapter[],
    private store: TodoStore,
    private settings: () => AppSettings,
    private exportsDir: string,
  ) {}

  async run(req: ExportRequest): Promise<ExportResult> {
    const todos = this.pick(req)
    const exported: ExportedTodo[] = []
    let sessionCount = 0

    for (const todo of todos) {
      const sessions: ExportedSession[] = []
      for (const binding of todo.bindings) {
        const adapter = this.adapters.find((a) => a.id === binding.toolId)
        const info =
          adapter?.describeSession
            ? await adapter.describeSession(binding.sessionId).catch(() => undefined)
            : undefined
        const usage =
          this.settings().usageEnabled && adapter?.computeUsage
            ? ((await adapter.computeUsage(binding.sessionId).catch(() => undefined)) ?? null)
            : null
        sessions.push({
          toolId: binding.toolId,
          sessionId: binding.sessionId,
          cwd: info?.cwd ?? '',
          name: info?.name ?? info?.firstMessage,
          filePath: info?.filePath ?? binding.filePath ?? null,
          // 多文件会话不能只给主文件，否则导出侧会漏掉其余 rollout 的定位线索
          ...(info?.files?.length ? { files: info.files } : {}),
          exists: Boolean(info),
          usage,
        })
        sessionCount++
      }
      exported.push({
        id: todo.id,
        title: todo.title,
        body: todo.body,
        status: todo.status,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        lastLaunch: todo.lastLaunch,
        sessions,
      })
    }

    const exportedAt = new Date().toISOString()
    // 精确到毫秒：同秒内连续导出不再互相覆盖
    const stamp = exportedAt.replace(/[:.]/g, '-').replace('Z', '')
    fs.mkdirSync(this.exportsDir, { recursive: true, mode: 0o700 })
    const jsonPath = path.join(this.exportsDir, `tick-export-${stamp}.json`)
    const markdownPath = path.join(this.exportsDir, `tick-export-${stamp}.md`)

    atomicWriteJson(jsonPath, {
      version: 1,
      exportedAt,
      tool: 'tick',
      todos: exported,
    })
    writeFileAtomic(markdownPath, renderMarkdown(exportedAt, exported))

    return { jsonPath, markdownPath, todoCount: exported.length, sessionCount }
  }

  /** reveal 前的边界校验：只允许定位本服务产物目录里的文件 */
  isInsideExports(filePath: string): boolean {
    const resolved = path.resolve(filePath)
    const exportsDir = path.resolve(this.exportsDir)
    return resolved.startsWith(exportsDir + path.sep)
  }

  private pick(req: ExportRequest): Todo[] {
    const todos = this.store.list()
    if (req.scope === 'open') return todos.filter((t) => t.status === 'open')
    if (req.scope === 'todo') return todos.filter((t) => t.id === req.todoId)
    return todos
  }
}

function renderMarkdown(exportedAt: string, todos: ExportedTodo[]): string {
  const lines: string[] = [
    `# Tick 导出 · ${exportedAt}`,
    '',
    '> 这里只有索引记录，不含对话正文；filePath 指向各工具自己的会话文件。',
    '',
  ]
  for (const todo of todos) {
    lines.push(`## ${todo.status === 'done' ? '[已完成] ' : ''}${todo.title}`, '')
    if (todo.body) lines.push(todo.body, '')
    lines.push(`- 创建：${todo.createdAt} · 更新：${todo.updatedAt}`)
    if (todo.lastLaunch?.projectPath) {
      lines.push(`- 上次项目：${todo.lastLaunch.projectPath}`)
    }
    if (todo.sessions.length === 0) {
      lines.push('- 会话：（无）')
    } else {
      for (const s of todo.sessions) {
        const exists = s.exists ? '' : '（已不在本机）'
        const usage =
          s.usage && s.usage.tokens.totalTokens > 0
            ? ` · ${s.usage.tokens.totalTokens} tokens · ${s.usage.costReported ? '' : '≥'}$${s.usage.cost.total.toFixed(4)}`
            : ''
        const extraFiles =
          s.files && s.files.length > 1 ? `（共 ${s.files.length} 个正文文件，见 JSON 的 files）` : ''
        lines.push(
          `- ${s.toolId} · ${s.cwd || '—'} · ${s.name || '未命名'} · ${s.filePath ?? '路径未知'}${extraFiles}${exists}${usage}`,
        )
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}
