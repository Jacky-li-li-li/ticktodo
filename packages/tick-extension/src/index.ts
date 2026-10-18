/**
 * tick-extension（pi CLI 侧）— 把 create_todo / list_todos 交给 pi 的模型。
 *
 * 安装：`~/.pi/agent/extensions/tick/index.js`（pi 自动发现目录，默认启用，不改 settings）
 * 构建：`pnpm --filter @tick/tick-extension build`（esbuild 打成单文件，避免 pi 侧解析 workspace 依赖）
 *
 * 领域规则全在 ./todos-file.ts —— 与面板 Chat 的实现共用一份。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Type } from 'typebox'
import { createTodo, describeTodo, listTodos } from './todos-file.ts'

const CreateTodoParams = Type.Object({
  title: Type.String({ description: '一句话线索标题（必填，动词开头更好）' }),
  body: Type.Optional(Type.String({ description: '补充说明 / 下一步（选填）' })),
})

const ListTodosParams = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('all')], {
      description: '默认 open',
    }),
  ),
})

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId()
  } catch {
    return undefined
  }
}

export default function tickExtension(pi: ExtensionAPI): void {
  /**
   * Tick「预填文案」一次性文件：launch 时由 PiAdapter 写到 cache/launch，
   * 路径经 TICK_LAUNCH_FILE 传入终端。这里只做「填进输入框」，绝不自动发送。
   *
   * 失败一律静默降级（不阻塞 pi 启动）：文件不存在/格式坏/会话 id 对不上都直接忽略；
   * 读完立刻删除，避免正文留在磁盘，也避免被 pi 的 bash 子进程继承环境变量后再次读到。
   */
  pi.on('session_start', (_event, ctx) => {
    const file = process.env.TICK_LAUNCH_FILE
    if (!file) return
    const ackFile = process.env.TICK_LAUNCH_ACK
    // 从环境里摘掉：后续 bash/tool 子进程不应看到这些一次性路径
    delete process.env.TICK_LAUNCH_FILE
    delete process.env.TICK_LAUNCH_ACK
    let ack: { ok: boolean; reason?: string } = { ok: false, reason: 'unknown' }
    try {
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > 200_000) {
        ack = { ok: false, reason: 'too-large' }
        return
      }
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: number
        mode?: string
        sessionId?: string
        promptText?: string
      }
      if (raw.mode !== 'prefill' || typeof raw.promptText !== 'string') {
        ack = { ok: false, reason: 'invalid-payload' }
        return
      }
      if (!raw.promptText.trim()) {
        ack = { ok: false, reason: 'empty-prompt' }
        return
      }
      // 防止把 A 会话的文案填到 B 会话（id 由 Tick 预生成，理应一致）
      const currentSessionId = sessionIdOf(ctx)
      if (raw.sessionId && currentSessionId && raw.sessionId !== currentSessionId) {
        ack = { ok: false, reason: 'session-mismatch' }
        return
      }
      if (typeof ctx.ui.setEditorText !== 'function') {
        ack = { ok: false, reason: 'editor-unavailable' }
        return
      }
      try {
        ctx.ui.setEditorText(raw.promptText)
        ack = { ok: true }
      } catch {
        ack = { ok: false, reason: 'set-editor-failed' }
      }
    } catch {
      // 读不到/解析失败：静默忽略；TUI 正常启动，用户可手动输入
      ack = { ok: false, reason: 'read-failed' }
    } finally {
      // 先写回执，再删正文；主进程只有看到 ok:true 才会对 UI 说「已预填」
      if (ackFile) {
        try {
          writeFileSync(ackFile, JSON.stringify(ack), { encoding: 'utf8', mode: 0o600 })
        } catch {
          /* 回执写不了就让它超时降级，不阻塞 pi */
        }
      }
      try {
        rmSync(file, { force: true })
      } catch {
        /* 忽略：文件可能已被清理 */
      }
    }
  })

  pi.registerTool({
    name: 'create_todo',
    label: '创建 Tick 线索',
    description:
      '在 Tick（置顶 Todo 工作台）里新建一条线索，并自动绑定当前 pi 会话。' +
      '当你识别出用户要跟进的事、或用户明确说“记一下 / 加个 todo”时使用。标题必填且要具体。',
    promptSnippet: 'create_todo — 在 Tick 里记一条线索（自动绑定当前会话）',
    parameters: CreateTodoParams,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    executionMode: 'sequential',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = sessionIdOf(ctx)
      const { todo, created } = createTodo({
        title: params.title,
        body: params.body ?? (ctx.cwd ? `工作目录：${ctx.cwd}` : undefined),
        sessionId,
        cwd: ctx.cwd,
        source: 'pi',
      })
      return {
        content: [
          {
            type: 'text' as const,
            text: created
              ? `已在 Tick 建好线索：${describeTodo(todo)}`
              : `这条会话已有对应线索，未重复创建：${describeTodo(todo)}`,
          },
        ],
        details: { todoId: todo.id, title: todo.title, created },
      }
    },
  })

  pi.registerTool({
    name: 'list_todos',
    label: '列出 Tick 线索',
    description: '列出 Tick 里的线索（默认未完成）。用于回答“我还有什么没做 / 有哪些跟这个项目相关”。',
    promptSnippet: 'list_todos — 读 Tick 的线索列表',
    parameters: ListTodosParams,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async execute(_toolCallId, params) {
      const todos = listTodos({ status: params.status ?? 'open' })
      const text =
        todos.length === 0
          ? '（当前没有符合条件的线索）'
          : todos.map((t, i) => `${i + 1}. ${describeTodo(t)}`).join('\n')
      return { content: [{ type: 'text' as const, text }], details: { count: todos.length } }
    },
  })
}
