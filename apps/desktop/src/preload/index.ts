/**
 * preload — contextBridge 白名单（TECH-ARCH §3：Renderer 无 Node 的唯一通道）。
 * CJS 产物；sandbox:true 下只允许 electron 接口（不碰 fs/net）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import { TodosIpc, WindowIpc } from '@tick/shared'

const api = {
  todos: {
    list: (): Promise<Todo[]> => ipcRenderer.invoke(TodosIpc.list),
    create: (input: TodoCreateInput): Promise<Todo> => ipcRenderer.invoke(TodosIpc.create, input),
    update: (id: string, patch: TodoPatch): Promise<Todo> =>
      ipcRenderer.invoke(TodosIpc.update, { id, patch }),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(TodosIpc.remove, id),
  },
  window: {
    hide: (): void => ipcRenderer.send(WindowIpc.hide),
  },
} as const

export type TickApi = typeof api

contextBridge.exposeInMainWorld('tick', api)
