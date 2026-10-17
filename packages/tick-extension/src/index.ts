/**
 * tick-extension（pi CLI 侧）— 把 create_todo / list_todos 交给 pi 的模型。
 *
 * 安装：`~/.pi/agent/extensions/tick/index.js`（pi 自动发现目录，默认启用，不改 settings）
 * 构建：`pnpm --filter @tick/tick-extension build`（esbuild 打成单文件，避免 pi 侧解析 workspace 依赖）
 *
 * 领域规则全在 ./todos-file.ts —— 与面板 Chat 的实现共用一份。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
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
