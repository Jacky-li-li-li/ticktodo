/**
 * preload — contextBridge 白名单（TECH-ARCH §3：Renderer 无 Node 的唯一通道）。
 * CJS 产物；sandbox:true 下只允许 electron 接口（不碰 fs/net）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import { ProjectsIpc, TodosIpc, ToolsIpc, WindowIpc } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'

export interface ToolStatus {
  toolId: string
  name: string
  installed: boolean
  version?: string
  reason?: string
}

const api = {
  todos: {
    list: (): Promise<Todo[]> => ipcRenderer.invoke(TodosIpc.list),
    create: (input: TodoCreateInput): Promise<Todo> => ipcRenderer.invoke(TodosIpc.create, input),
    update: (id: string, patch: TodoPatch): Promise<Todo> =>
      ipcRenderer.invoke(TodosIpc.update, { id, patch }),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(TodosIpc.remove, id),
  },
  projects: {
    /** 首帧：读缓存（main 冷启动纪律，UI 不等扫描） */
    list: (): Promise<ProjectEntry[]> => ipcRenderer.invoke(ProjectsIpc.list),
    refresh: (): Promise<ProjectEntry[]> => ipcRenderer.invoke(ProjectsIpc.refresh),
    /** 后台首扫完成推送 */
    onUpdate: (cb: (projects: ProjectEntry[]) => void): (() => void) => {
      const listener = (_e: unknown, projects: ProjectEntry[]): void => cb(projects)
      ipcRenderer.on(ProjectsIpc.updated, listener)
      return () => ipcRenderer.removeListener(ProjectsIpc.updated, listener)
    },
  },
  tools: {
    /** 每项含 detect() 结果（installed/version/reason）——adapter 能力字段从合同取 */
    status: (): Promise<ToolStatus[]> => ipcRenderer.invoke(ToolsIpc.status),
  },
  window: {
    hide: (): void => ipcRenderer.send(WindowIpc.hide),
  },
} as const

// 类型面：status 结果附 detect 输出（与 main 的 ToolsIpc handler 对齐）
export type TickApi = Omit<typeof api, 'tools'> & {
  tools: { status: () => Promise<ToolStatus[]> }
}

contextBridge.exposeInMainWorld('tick', api)
