/**
 * ipc — Main 侧 handler 装配（TECH-ARCH §3 信任边界：Renderer 无 Node，全走显式通道）。
 * 通道常量来自 @tick/shared（main/preload/renderer 引用同一份，防漂移）。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
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
import type { AiToolAdapter } from '@tick/ai-core'
import type { TodoStore } from './store'
import type { ProjectIndexService } from './services/project-index'
import type { ChatAgentHost } from './services/chat-host'
import type { LaunchService } from './services/launch'

export interface IpcWindows {
  panel: () => BrowserWindow | null
}

export interface IpcServices {
  projectIndex: ProjectIndexService
  chat: () => ChatAgentHost | undefined
  launch: LaunchService
}

export function registerIpc(
  store: TodoStore,
  windows: IpcWindows,
  services: IpcServices,
  adapters: AiToolAdapter[],
): void {
  ipcMain.handle(TodosIpc.list, (): Todo[] => store.list())

  ipcMain.handle(TodosIpc.create, (_e, input: TodoCreateInput): Todo => {
    return store.create(input)
  })

  ipcMain.handle(TodosIpc.update, (_e, args: { id: string; patch: TodoPatch }): Todo => {
    return store.update(args.id, args.patch)
  })

  ipcMain.handle(TodosIpc.remove, (_e, id: string): void => {
    store.remove(id)
  })

  // ---------- 项目索引（M1） ----------
  ipcMain.handle(ProjectsIpc.list, async () => {
    await services.projectIndex.ready()
    return services.projectIndex.getCachedProjects()
  })
  ipcMain.handle(ProjectsIpc.refresh, async () => {
    await services.projectIndex.ready()
    return services.projectIndex.refresh()
  })

  // ---------- 工具就绪（Q14 双出口空态判据） ----------
  ipcMain.handle(ToolsIpc.status, async () => {
    const results = await Promise.all(
      adapters.map(async (a) => ({
        toolId: a.id,
        name: a.id,
        ...(await a.detect()),
      })),
    )
    return results
  })

  // ---------- 面板 Chat（M2 / pi-durable） ----------
  ipcMain.handle(ChatIpc.state, (): ChatState => {
    return services.chat()?.getState() ?? { status: 'unavailable', messages: [], reason: '面板对话未启动' }
  })

  ipcMain.handle(ChatIpc.send, async (_e, text: string): Promise<void> => {
    const chat = services.chat()
    if (!chat) throw new Error('面板对话未启动')
    await chat.send(text)
  })

  ipcMain.handle(ChatIpc.abort, async (): Promise<void> => {
    await services.chat()?.abort()
  })

  ipcMain.handle(ChatIpc.reset, async (): Promise<void> => {
    await services.chat()?.reset()
  })

  // ---------- 拉起 / 恢复（M2 / ai-picker） ----------
  ipcMain.handle(LaunchIpc.resolveCwd, async (_e, todoId?: string) => {
    return services.launch.resolveCwd(todoId)
  })

  ipcMain.handle(LaunchIpc.launch, async (_e, req: LaunchRequest): Promise<LaunchOutcome> => {
    return services.launch.launch(req)
  })

  ipcMain.handle(LaunchIpc.resume, async (_e, req: ResumeRequest): Promise<LaunchOutcome> => {
    return services.launch.resume(req)
  })

  // 常驻语义：隐藏 ≠ 销毁；退出走 Cmd+Q / dock quit
  ipcMain.on(WindowIpc.hide, () => windows.panel()?.hide())
  ipcMain.on(WindowIpc.quit, () => app.quit())
}
