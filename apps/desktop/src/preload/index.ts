/**
 * preload — contextBridge 白名单（TECH-ARCH §3：Renderer 无 Node 的唯一通道）。
 * CJS 产物；sandbox:true 下只允许 electron 接口（不碰 fs/net）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ChatState,
  LaunchOutcome,
  LaunchRequest,
  ResumeRequest,
  Todo,
  TodoCreateInput,
  TodoPatch,
} from '@tick/shared'
import { ChatIpc, LaunchIpc, ProjectsIpc, TodosIpc, ToolsIpc, WindowIpc } from '@tick/shared'
import type { ProjectEntry } from '@tick/ai-core'

export interface ToolStatus {
  toolId: string
  name: string
  installed: boolean
  version?: string
  reason?: string
}

export interface ResolvedCwdView {
  projectPath: string
  projectName: string
  source: 'bound-session' | 'last-launch' | 'home'
}

const api = {
  todos: {
    list: (): Promise<Todo[]> => ipcRenderer.invoke(TodosIpc.list),
    create: (input: TodoCreateInput): Promise<Todo> => ipcRenderer.invoke(TodosIpc.create, input),
    update: (id: string, patch: TodoPatch): Promise<Todo> =>
      ipcRenderer.invoke(TodosIpc.update, { id, patch }),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(TodosIpc.remove, id),
    /** pi extension 直接写 todos.json → main 的 fs.watch 推这里 */
    onChange: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(TodosIpc.changed, listener)
      return () => ipcRenderer.removeListener(TodosIpc.changed, listener)
    },
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
  chat: {
    state: (): Promise<ChatState> => ipcRenderer.invoke(ChatIpc.state),
    send: (text: string): Promise<void> => ipcRenderer.invoke(ChatIpc.send, text),
    abort: (): Promise<void> => ipcRenderer.invoke(ChatIpc.abort),
    reset: (): Promise<void> => ipcRenderer.invoke(ChatIpc.reset),
    onUpdate: (cb: (state: ChatState) => void): (() => void) => {
      const listener = (_e: unknown, state: ChatState): void => cb(state)
      ipcRenderer.on(ChatIpc.updated, listener)
      return () => ipcRenderer.removeListener(ChatIpc.updated, listener)
    },
  },
  launch: {
    resolveCwd: (todoId?: string): Promise<ResolvedCwdView> =>
      ipcRenderer.invoke(LaunchIpc.resolveCwd, todoId),
    launch: (req: LaunchRequest): Promise<LaunchOutcome> => ipcRenderer.invoke(LaunchIpc.launch, req),
    resume: (req: ResumeRequest): Promise<LaunchOutcome> => ipcRenderer.invoke(LaunchIpc.resume, req),
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
