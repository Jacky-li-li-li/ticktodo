/**
 * todos-file — 兼容壳。
 *
 * 领域实现已迁到 `@tick/todo-core`（唯一写实现）；保留这个文件名是为了让
 * `index.ts` / `durable.ts` 的 import 路径保持稳定。**不要再往这里加逻辑**。
 */

export {
  createTodo,
  describeTodo,
  listTodos,
  resolveTickHome,
  todosFilePath,
  normalizeTitle,
  openTodoStore,
  TodoDataError,
  TodoStoreCore,
  TodoInputError,
} from '@tick/todo-core'
export type { CreateTodoInput, CreateTodoResult } from '@tick/todo-core'
