/**
 * tick-extension（面板 Chat 侧）— 同一份领域实现，接 pi-durable 的工具注册面。
 *
 * 两个系统的扩展 API 不同（pi coding-agent: registerTool；pi-durable: defineTool），
 * 所以这里是一层薄适配：注册时只转发到 ./todos-file.ts。
 *
 * 面板会话不是 CLI 会话（不参与用量、不可被 resume），因此面板里建的线索**不绑 session**。
 */

import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import { createTodo, describeTodo, listTodos } from './todos-file.ts'

const createTodoTool = defineTool({
  name: 'create_todo',
  description:
    '在 Tick（置顶 Todo 工作台）里新建一条线索。当用户说“记一下 / 加个 todo”，或你识别出需要跟进的事时使用。标题必填且具体。',
  parameters: Type.Object({
    title: Type.String({ description: '一句话线索标题（必填）' }),
    body: Type.Optional(Type.String({ description: '补充说明 / 下一步（选填）' })),
  }),
  replay: 'safe',
  async execute(args) {
    const { todo, created } = createTodo({
      title: args.title,
      body: args.body,
      source: 'panel',
    })
    return {
      output: [
        {
          type: 'text' as const,
          text: created
            ? `已在 Tick 建好线索：${describeTodo(todo)}`
            : `已存在同样的线索，未重复创建：${describeTodo(todo)}`,
        },
      ],
      details: { todoId: todo.id, title: todo.title, created },
    }
  },
})

const listTodosTool = defineTool({
  name: 'list_todos',
  description: '列出 Tick 里的线索（默认未完成）。',
  parameters: Type.Object({
    status: Type.Optional(
      Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('all')], {
        description: '默认 open',
      }),
    ),
  }),
  async execute(args) {
    const todos = listTodos({ status: args.status ?? 'open' })
    return {
      output: [
        {
          type: 'text' as const,
          text:
            todos.length === 0
              ? '（当前没有符合条件的线索）'
              : todos.map((t, i) => `${i + 1}. ${describeTodo(t)}`).join('\n'),
        },
      ],
      details: { count: todos.length },
    }
  },
})

export const TickDurableExtension = defineExtension({
  name: 'tick',
  tools: [createTodoTool, listTodosTool],
})
