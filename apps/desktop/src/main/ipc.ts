/**
 * ipc — Main 侧 handler 装配（TECH-ARCH §3 信任边界：Renderer 无 Node，全走显式通道）。
 * 通道常量来自 @tick/shared（main/preload/renderer 引用同一份，防漂移）。
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  ChatState,
  CliSessionId,
  ExportRequest,
  ExportResult,
  LaunchOutcome,
  LaunchRequest,
  ResumeRequest,
  SessionsListOptions,
  SessionView,
  Todo,
  TodoCreateInput,
  TodoPatch,
  TodoSessionView,
} from '@tick/shared'
import {
  ChatIpc,
  ExportIpc,
  LaunchIpc,
  ProjectsIpc,
  ProviderIpc,
  SessionsIpc,
  SettingsIpc,
  TodosIpc,
  ToolsIpc,
  UsageIpc,
  WindowIpc,
} from '@tick/shared'
import type {
  CustomProviderConfig,
  ProviderSaveInput,
  ProviderTestResult,
} from '@tick/shared'
import type { AiToolAdapter, SessionUsage } from '@tick/ai-core'
import type { TodoStore } from './store'
import type { ProjectIndexService } from './services/project-index'
import type { ChatAgentHost } from './services/chat-host'
import type { LaunchService } from './services/launch'
import type { SettingsStore } from './services/settings-store'
import type { ProviderConfigService } from './services/provider-config'
import type { SessionService } from './services/sessions'
import type { ExportService } from './services/export'

export interface IpcWindows {
  panel: () => BrowserWindow | null
}

export interface IpcServices {
  projectIndex: ProjectIndexService
  chat: () => ChatAgentHost | undefined
  launch: LaunchService
  settings: SettingsStore
  sessions: SessionService
  exportService: ExportService
  dataDir: string
  providerConfig: ProviderConfigService
  /** 凭据来源切换后重建面板对话（durable 历史不受影响） */
  reloadChat: () => Promise<void>
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

  // ---------- 设置（F4-b） ----------
  ipcMain.handle(SettingsIpc.get, (): AppSettings => services.settings.get())
  ipcMain.handle(SettingsIpc.update, (_e, patch: Partial<AppSettings>): AppSettings => {
    const next = services.settings.update(patch)
    windows.panel()?.webContents.send(SettingsIpc.changed, next)
    return next
  })
  ipcMain.handle(SettingsIpc.openDataDir, async (): Promise<void> => {
    await shell.openPath(services.dataDir)
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
  ipcMain.handle(ProjectsIpc.relocate, async (_e, oldPath: string) => {
    await services.projectIndex.ready()
    const parent = windows.panel()
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: '选择项目的新位置（只做映射，不移动 pi 的会话文件）',
          properties: ['openDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return { projects: services.projectIndex.getCachedProjects(), relocated: undefined }
    }
    const relocated = services.projectIndex.relocate(oldPath, result.filePaths[0] as string)
    return { projects: services.projectIndex.getCachedProjects(), relocated }
  })
  ipcMain.handle(ProjectsIpc.add, async () => {
    await services.projectIndex.ready()
    const parent = windows.panel()
    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: '添加本地项目目录',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return services.projectIndex.getCachedProjects()
    }
    services.projectIndex.pin(result.filePaths[0] as string)
    return services.projectIndex.getCachedProjects()
  })

  // ---------- 会话（S5 / 多会话绑定 UI） ----------
  ipcMain.handle(SessionsIpc.list, async (_e, opts: SessionsListOptions = {}): Promise<SessionView[]> => {
    return services.sessions.list(opts)
  })
  ipcMain.handle(SessionsIpc.forTodo, async (_e, todoId: string): Promise<TodoSessionView[]> => {
    return services.sessions.forTodo(todoId)
  })
  ipcMain.handle(SessionsIpc.claim, async (_e, sessionId: CliSessionId) => {
    return services.sessions.claim(sessionId)
  })
  ipcMain.handle(SessionsIpc.bind, async (_e, args: { todoId: string; sessionId: CliSessionId }) => {
    return services.sessions.bind(args.todoId, args.sessionId)
  })
  ipcMain.handle(SessionsIpc.setPrimary, async (_e, args: { todoId: string; sessionId: CliSessionId }) => {
    return services.sessions.setPrimary(args.todoId, args.sessionId)
  })
  ipcMain.handle(SessionsIpc.unbind, async (_e, args: { todoId: string; sessionId: CliSessionId }) => {
    return services.sessions.unbind(args.todoId, args.sessionId)
  })

  // ---------- 导出（F8） ----------
  ipcMain.handle(ExportIpc.run, async (_e, req: ExportRequest): Promise<ExportResult> => {
    return services.exportService.run(req)
  })
  ipcMain.handle(ExportIpc.reveal, async (_e, filePath: string): Promise<void> => {
    shell.showItemInFolder(filePath)
  })

  // ---------- 用量（F6-b；默认关） ----------
  ipcMain.handle(
    UsageIpc.get,
    async (_e, args: { toolId: string; sessionId: CliSessionId }): Promise<SessionUsage | undefined> => {
      if (!services.settings.get().usageEnabled) return undefined
      const adapter = adapters.find((a) => a.id === args.toolId)
      return adapter?.computeUsage?.(args.sessionId)
    },
  )

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

  // ---------- 自配 provider（M3 尾巴 / PRD F5 来源 2） ----------
  ipcMain.handle(ProviderIpc.get, (): CustomProviderConfig | null => services.providerConfig.get())
  ipcMain.handle(ProviderIpc.save, async (_e, input: ProviderSaveInput): Promise<CustomProviderConfig> => {
    const config = services.providerConfig.save(input)
    await services.reloadChat()
    windows.panel()?.webContents.send(SettingsIpc.changed, services.settings.get())
    return config
  })
  ipcMain.handle(ProviderIpc.clear, async (): Promise<void> => {
    services.providerConfig.clear()
    await services.reloadChat()
    windows.panel()?.webContents.send(SettingsIpc.changed, services.settings.get())
  })
  ipcMain.handle(
    ProviderIpc.test,
    async (_e, input: { baseUrl: string; apiKey?: string; model?: string }): Promise<ProviderTestResult> => {
      return services.providerConfig.test(input)
    },
  )

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

  ipcMain.handle(ChatIpc.setCwd, async (_e, cwd: string): Promise<void> => {
    const chat = services.chat()
    if (!chat) throw new Error('面板对话未启动')
    await chat.setCwd(cwd)
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
