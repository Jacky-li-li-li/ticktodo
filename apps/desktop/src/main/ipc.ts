/**
 * ipc — Main 侧 handler 装配（TECH-ARCH §3 信任边界：Renderer 无 Node，全走显式通道）。
 * 通道常量来自 @tick/shared（main/preload/renderer 引用同一份，防漂移）。
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  AppSettings,
  ChatState,
  CliSessionId,
  ExportRequest,
  ExportResult,
  LaunchOutcome,
  LaunchRequest,
  PrefillNewSessionOutcome,
  PrefillNewSessionRequest,
  ResumeRequest,
  SessionsListOptions,
  SessionView,
  Todo,
  TodoCreateInput,
  TodoPatch,
  TodoSessionView,
  ToolStatus,
  UpdateState,
} from '@tick/shared'
import {
  ChatIpc,
  ExportIpc,
  LaunchIpc,
  McpIpc,
  ProjectsIpc,
  ProviderIpc,
  SessionsIpc,
  SettingsIpc,
  TodosIpc,
  ToolsIpc,
  sanitizeTodoPatch,
  toolDisplayName,
  UpdateIpc,
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
import type { McpConnectionService } from './services/mcp-connection'
import type { UpdateService } from './services/update'
import { detectWithTimeout } from './services/detect'

export interface IpcWindows {
  panel: () => BrowserWindow | null
  getPinned: () => boolean
  setPinned: (pinned: boolean) => boolean
  setBlurHideSuppressed: (value: boolean) => void
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
  mcp: McpConnectionService
  update: UpdateService
}

export function registerIpc(
  store: TodoStore,
  windows: IpcWindows,
  services: IpcServices,
  adapters: AiToolAdapter[],
): void {
  ipcMain.handle(TodosIpc.list, (): Todo[] => store.list())

  ipcMain.handle(TodosIpc.create, (_e, input: TodoCreateInput): Todo => {
    if (typeof input?.title !== 'string') throw new Error('标题必须是字符串')
    return store.create(input)
  })

  // patch 在边界白名单归一化：非法形状（未知 status/任意 addBinding）不进 store、不落盘
  ipcMain.handle(TodosIpc.update, (_e, args: { id: string; patch: TodoPatch }): Todo => {
    const patch = sanitizeTodoPatch(args?.patch)
    if (!patch) throw new Error('没有可应用的合法更新字段')
    return store.update(args.id, patch)
  })

  ipcMain.handle(TodosIpc.remove, (_e, id: string): void => {
    store.remove(id)
  })

  // ---------- 设置（F4-b） ----------
  ipcMain.handle(SettingsIpc.get, (): AppSettings => services.settings.get())
  ipcMain.handle(SettingsIpc.update, (_e, patch: Partial<AppSettings>): AppSettings => {
    const next = services.settings.update(patch)
    // 只判字段是否存在（不比较值）：patch 里带了 autoUpdateCheck 就按最终值重排定时器
    if (patch.autoUpdateCheck !== undefined) {
      services.update.setAutoCheck(next.autoUpdateCheck !== false)
    }
    windows.panel()?.webContents.send(SettingsIpc.changed, next)
    return next
  })
  ipcMain.handle(SettingsIpc.openDataDir, async (): Promise<void> => {
    await shell.openPath(services.dataDir)
  })

  // ---------- 应用内更新 ----------
  // 四个命令都没有业务参数：feed 只能来自 app-update.yml，renderer 传不了 URL/channel。
  // sender 不是当前面板时只回状态（install 直接 return），避免别的 webContents 触发退出。
  const fromPanel = (e: IpcMainInvokeEvent): boolean => e.sender === windows.panel()?.webContents

  ipcMain.handle(UpdateIpc.getState, (): Promise<UpdateState> => services.update.ready())

  ipcMain.handle(UpdateIpc.check, async (e): Promise<UpdateState> => {
    return fromPanel(e) ? services.update.check('manual') : services.update.getState()
  })

  ipcMain.handle(UpdateIpc.download, async (e): Promise<UpdateState> => {
    return fromPanel(e) ? services.update.download() : services.update.getState()
  })

  ipcMain.handle(UpdateIpc.install, async (e): Promise<void> => {
    if (!fromPanel(e)) return
    await services.update.install()
  })

  // ---------- MCP「Agent 连接」 ----------
  ipcMain.handle(McpIpc.info, () => services.mcp.get())
  ipcMain.handle(McpIpc.copy, (_e, text: string): void => {
    clipboard.writeText(String(text))
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
    windows.setBlurHideSuppressed(true)
    let result
    try {
      result = parent
        ? await dialog.showOpenDialog(parent, {
            title: '选择项目的新位置（只做映射，不移动 pi 的会话文件）',
            properties: ['openDirectory'],
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    } finally {
      windows.setBlurHideSuppressed(false)
    }
    if (result.canceled || result.filePaths.length === 0) {
      return { projects: services.projectIndex.getCachedProjects(), relocated: undefined }
    }
    const relocated = services.projectIndex.relocate(oldPath, result.filePaths[0] as string)
    return { projects: services.projectIndex.getCachedProjects(), relocated }
  })
  ipcMain.handle(ProjectsIpc.add, async () => {
    await services.projectIndex.ready()
    const parent = windows.panel()
    windows.setBlurHideSuppressed(true)
    let result
    try {
      result = parent
        ? await dialog.showOpenDialog(parent, {
            title: '添加本地项目目录',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    } finally {
      windows.setBlurHideSuppressed(false)
    }
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
  ipcMain.handle(
    SessionsIpc.claim,
    async (_e, args: CliSessionId | { sessionId: CliSessionId; toolId?: string }) => {
      const sessionId = typeof args === 'string' ? args : args.sessionId
      return services.sessions.claim(sessionId, typeof args === 'string' ? undefined : args.toolId)
    },
  )
  ipcMain.handle(
    SessionsIpc.bind,
    async (_e, args: { todoId: string; sessionId: CliSessionId; toolId?: string }) => {
      return services.sessions.bind(args.todoId, args.sessionId, args.toolId)
    },
  )
  ipcMain.handle(
    SessionsIpc.unbind,
    async (_e, args: { todoId: string; sessionId: CliSessionId; toolId?: string }) => {
      return services.sessions.unbind(args.todoId, args.sessionId, args.toolId)
    },
  )

  // ---------- 导出（F8） ----------
  ipcMain.handle(ExportIpc.run, async (_e, req: ExportRequest): Promise<ExportResult> => {
    return services.exportService.run(req)
  })
  ipcMain.handle(ExportIpc.reveal, async (_e, filePath: string): Promise<void> => {
    // 只允许定位导出产物：renderer 被攻破时也不能拿它当任意文件的 Finder 探针
    if (!services.exportService.isInsideExports(filePath)) {
      throw new Error('只能定位 exports/ 里的导出产物')
    }
    shell.showItemInFolder(path.resolve(filePath))
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
  // 只判「装没装」；不再探测/校验版本（2026-10-19 移除），版本差异交给真实调用失败暴露。
  ipcMain.handle(ToolsIpc.status, async (): Promise<ToolStatus[]> => {
    return Promise.all(
      adapters.map(async (a): Promise<ToolStatus> => {
        const detected = await detectWithTimeout(a)
        return {
          toolId: a.id,
          // 展示名统一映射（shared 单一来源），不把 id 当名字用
          name: toolDisplayName(a.id),
          ...detected,
          newSessionMode: a.capabilities.newSessionMode,
          ...(a.capabilities.prefillDelivery ? { prefillDelivery: a.capabilities.prefillDelivery } : {}),
          ...(a.capabilities.clients ? { clients: a.capabilities.clients } : {}),
          resumeSession: a.capabilities.resumeSession,
        }
      }),
    )
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

  // 桌面工具：只打开 GUI 新建页并预填；不写 binding，发送后由用户倒入
  ipcMain.handle(
    LaunchIpc.prefillNewSession,
    async (_e, req: PrefillNewSessionRequest): Promise<PrefillNewSessionOutcome> => {
      return services.launch.prefillNewSession(req)
    },
  )

  ipcMain.handle(LaunchIpc.resume, async (_e, req: ResumeRequest): Promise<LaunchOutcome> => {
    return services.launch.resume(req)
  })

  // 常驻语义：隐藏 ≠ 销毁；退出走 Cmd+Q / dock quit
  ipcMain.on(WindowIpc.hide, () => windows.panel()?.hide())
  ipcMain.on(WindowIpc.quit, () => app.quit())
  ipcMain.handle(WindowIpc.getPinned, () => windows.getPinned())
  ipcMain.handle(WindowIpc.setPinned, (_e, pinned: boolean) => windows.setPinned(Boolean(pinned)))
}
