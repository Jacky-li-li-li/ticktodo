/**
 * v1 只读资源（spec §5）：`tick://todos` 与 `tick://todos/{todoId}`。
 *
 * 两者都走同一个 todo-core 读路径，不返回会话正文；单条资源才显式出 body。
 * `tick://sessions/{toolId}/{sessionId}` 需要 Tick 在跑的 bridge（Tier 1），
 * P0 不注册它 —— 没有 bridge 时不能返回伪造的会话元数据，也不该让客户端以为能读。
 */

import { McpServer, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server'
import { listProbes } from '@tick/probe-scan'
import type { Todo } from '@tick/shared'
import type { McpRuntime } from './config'

const CACHE_HINT = { ttlMs: 5_000, cacheScope: 'private' as const }

function openTodos(todos: Todo[]): Todo[] {
  return todos
    .filter((todo) => todo.status === 'open')
    .sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}

function indexProjection(todo: Todo, pendingTodoIds: ReadonlySet<string>): Record<string, unknown> {
  const states = todo.bindings.map((b) => b.state ?? 'verified')
  return {
    todoId: todo.id,
    title: todo.title,
    status: todo.status,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    origin: todo.source === 'mcp' ? 'mcp' : 'local',
    sessionCount: todo.bindings.length,
    bindingState: states.includes('verified')
      ? 'verified'
      : states.includes('pending') || pendingTodoIds.has(todo.id)
        ? 'pending'
        : 'none',
    ...(todo.primarySessionId ? { primarySessionId: todo.primarySessionId } : {}),
    ...(todo.mcpOrigin?.toolId ? { toolId: todo.mcpOrigin.toolId } : {}),
  }
}

function detailProjection(todo: Todo): Record<string, unknown> {
  return {
    todoId: todo.id,
    title: todo.title,
    body: todo.body ?? '',
    status: todo.status,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    origin: todo.source === 'mcp' ? 'mcp' : 'local',
    ...(todo.mcpOrigin ? { mcpOrigin: todo.mcpOrigin } : {}),
    // 资源不暴露本地文件路径（spec §5：只有会话索引，不含正文/路径）
    sessions: todo.bindings.map((binding) => ({
      toolId: binding.toolId,
      sessionId: binding.sessionId,
      state: binding.state ?? 'verified',
    })),
  }
}

export function registerResources(server: McpServer, runtime: McpRuntime): void {
  server.registerResource(
    'todos',
    'tick://todos',
    {
      title: 'Tick 线索列表',
      description: '未完成线索（同 list_todos 的投影，不含正文）。',
      mimeType: 'application/json',
      cacheHint: CACHE_HINT,
    },
    async (uri) => {
      const pending = new Set(
        listProbes(runtime.home)
          .filter((probe) => Date.parse(probe.expiresAt) > Date.now())
          .map((probe) => probe.todoId),
      )
      const todos = openTodos(runtime.store.list()).map((todo) => indexProjection(todo, pending))
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ schemaVersion: 1, count: todos.length, todos }, null, 2),
          },
        ],
      }
    },
  )

  server.registerResource(
    'todo',
    new ResourceTemplate('tick://todos/{todoId}', { list: undefined }),
    {
      title: 'Tick 单条线索',
      description: '按 id 读取一条线索（含正文与已绑定的会话索引）。',
      mimeType: 'application/json',
      cacheHint: CACHE_HINT,
    },
    async (uri, variables) => {
      const todoId = typeof variables.todoId === 'string' ? variables.todoId : ''
      const todo = runtime.store.list().find((item) => item.id === todoId)
      if (!todo) throw new ResourceNotFoundError(uri.href, `TICK_E_TODO_NOT_FOUND: ${todoId}`)
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ schemaVersion: 1, ...detailProjection(todo) }, null, 2),
          },
        ],
      }
    },
  )
}
