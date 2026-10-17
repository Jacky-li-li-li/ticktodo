/**
 * preload — contextBridge 白名单（TECH-ARCH §3：Renderer 无 Node 的唯一通道）。
 * CJS 产物；sandbox:true 下只允许 electron 接口（不碰 fs/net）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ChatState,
  CliSessionId,
  CustomProviderConfig,
  ExportRequest,
  ExportResult,
  LaunchOutcome,
  LaunchRequest,
  ProviderSaveInput,
  ProviderTestResult,
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
import type { ProjectEntry, SessionUsage } from '@tick/ai-core'

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
  source: 'bound-session' | 'last-launch' | 'home' | 'explicit' | 'recent'
  /** 目录已失效、退回主目录时的原因；UI 必须提示 */
  degraded?: 'bound-session-missing' | 'last-launch-missing' | 'explicit-missing'
  /** true = 设置「每次必问」，UI 需要先选项目才能拉起 */
  mustAsk?: boolean
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
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(SettingsIpc.get),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(SettingsIpc.update, patch),
    openDataDir: (): Promise<void> => ipcRenderer.invoke(SettingsIpc.openDataDir),
    onChanged: (cb: (settings: AppSettings) => void): (() => void) => {
      const listener = (_e: unknown, settings: AppSettings): void => cb(settings)
      ipcRenderer.on(SettingsIpc.changed, listener)
      return () => ipcRenderer.removeListener(SettingsIpc.changed, listener)
    },
  },
  provider: {
    /** 当前自配配置（不含 key）；null = 跟随 pi 凭据 */
    get: (): Promise<CustomProviderConfig | null> => ipcRenderer.invoke(ProviderIpc.get),
    /** 保存并重建面板对话（key 进钥匙串，不落 data/） */
    save: (input: ProviderSaveInput): Promise<CustomProviderConfig> =>
      ipcRenderer.invoke(ProviderIpc.save, input),
    clear: (): Promise<void> => ipcRenderer.invoke(ProviderIpc.clear),
    /** 连接测试（不落盘）；成功时带回 /models 列表 */
    test: (input: { baseUrl: string; apiKey?: string; model?: string }): Promise<ProviderTestResult> =>
      ipcRenderer.invoke(ProviderIpc.test, input),
  },
  projects: {
    /** 首帧：读缓存（main 冷启动纪律，UI 不等扫描） */
    list: (): Promise<ProjectEntry[]> => ipcRenderer.invoke(ProjectsIpc.list),
    refresh: (): Promise<ProjectEntry[]> => ipcRenderer.invoke(ProjectsIpc.refresh),
    /** 打开系统目录选择器并 pin；返回 pin 后的完整项目列表 */
    add: (): Promise<ProjectEntry[]> => ipcRenderer.invoke(ProjectsIpc.add),
    /** 失效项目重新定位（只映射，不移动文件） */
    relocate: (oldPath: string): Promise<{ projects: ProjectEntry[]; relocated?: string }> =>
      ipcRenderer.invoke(ProjectsIpc.relocate, oldPath),
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
  export: {
    /** F8：导出 todo + 会话索引（JSON + Markdown） */
    run: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke(ExportIpc.run, req),
    reveal: (filePath: string): Promise<void> => ipcRenderer.invoke(ExportIpc.reveal, filePath),
  },
  usage: {
    /** 单会话用量；设置里关闭时 main 直接返回 undefined */
    get: (toolId: string, sessionId: CliSessionId): Promise<SessionUsage | undefined> =>
      ipcRenderer.invoke(UsageIpc.get, { toolId, sessionId }),
  },
  sessions: {
    /** 会话列表（S5：unboundOnly；详情/多会话：不传） */
    list: (opts: SessionsListOptions = {}): Promise<SessionView[]> =>
      ipcRenderer.invoke(SessionsIpc.list, opts),
    forTodo: (todoId: string): Promise<TodoSessionView[]> =>
      ipcRenderer.invoke(SessionsIpc.forTodo, todoId),
    /** S5：建 todo 并绑定 */
    claim: (sessionId: CliSessionId): Promise<{ ok: boolean; todo?: Todo; reason?: string }> =>
      ipcRenderer.invoke(SessionsIpc.claim, sessionId),
    bind: (todoId: string, sessionId: CliSessionId): Promise<{ ok: boolean; todo?: Todo; reason?: string }> =>
      ipcRenderer.invoke(SessionsIpc.bind, { todoId, sessionId }),
    setPrimary: (todoId: string, sessionId: CliSessionId): Promise<Todo | undefined> =>
      ipcRenderer.invoke(SessionsIpc.setPrimary, { todoId, sessionId }),
    unbind: (todoId: string, sessionId: CliSessionId): Promise<boolean> =>
      ipcRenderer.invoke(SessionsIpc.unbind, { todoId, sessionId }),
  },
  chat: {
    state: (): Promise<ChatState> => ipcRenderer.invoke(ChatIpc.state),
    send: (text: string): Promise<void> => ipcRenderer.invoke(ChatIpc.send, text),
    abort: (): Promise<void> => ipcRenderer.invoke(ChatIpc.abort),
    reset: (): Promise<void> => ipcRenderer.invoke(ChatIpc.reset),
    setCwd: (cwd: string): Promise<void> => ipcRenderer.invoke(ChatIpc.setCwd, cwd),
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
    /** 全局快捷键「新建线索」：main 推给 renderer 聚焦捕获行 */
    onNewTodo: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(WindowIpc.newTodo, listener)
      return () => ipcRenderer.removeListener(WindowIpc.newTodo, listener)
    },
  },
} as const

// 类型面：status 结果附 detect 输出（与 main 的 ToolsIpc handler 对齐）
export type TickApi = Omit<typeof api, 'tools'> & {
  tools: { status: () => Promise<ToolStatus[]> }
}

contextBridge.exposeInMainWorld('tick', api)
