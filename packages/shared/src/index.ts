/**
 * @tick/shared — 跨进程共享类型 + IPC 通道
 *
 * 原则（TECH-ARCH §6）：session 元数据的权威源在工具侧（ai/<tool> adapter），
 * Tick 侧只持久化「绑定关系」。此处先落 Todo 模型（M0 需要），
 * adapter 相关类型（SessionInfo / ProjectSource 等）随 M1 的 ai/core 落地。
 */

// ---------- 状态 ----------

export type TodoStatus = 'open' | 'done'

// ---------- 会话绑定（M0 只建模型，不产生绑定逻辑） ----------

/**
 * CLI 会话 id 的品牌类型。
 * 单工具时期就是 pi 的 session uuid；字符串只能由 newCliSessionId/parseCliSessionId 产出。
 * （从 ai/core 前移到这里，避免 UI 层反向依赖 ai 包。）
 */
declare const CliSessionIdBrand: unique symbol
export type CliSessionId = string & { readonly [CliSessionIdBrand]: true }

export function newCliSessionId(raw: string): CliSessionId {
  return raw as CliSessionId
}

export interface SessionBinding {
  toolId: string
  sessionId: CliSessionId
  boundAt: string // ISO
  /**
   * 会话在工具侧的状态：
   *  - pending  = 已在终端打开 pi，但用户还没发送第一条消息（剪贴板投递时正常）→ 还没有 session 文件
   *  - verified = 会话文件已真实产生（verify 通过）
   *  - 缺省     = 旧数据，按 verified 处理
   *
   * 为什么需要 pending：默认投递是剪贴板，pi 启动后不会立刻落盘；若坚持「verify 通过才绑定」，
   * 默认路径会永远不绑定。所以先写 pending，再由后台对账改成 verified。
   */
  state?: 'pending' | 'verified'
  /**
   * 绑定时记下的会话文件路径（仅作为导出/诊断的**提示**，权威值仍向 adapter 现问）。
   * 会话被删掉后仍能用它告诉用户"原始会话原来在哪"。
   */
  filePath?: string
}

/** 上次用哪个工具 + 哪个目录 —— 用户意图，一体记忆（拆开会在切工具时选错） */
export interface LastLaunch {
  toolId: string
  projectPath: string
  /** Tick 侧成功拉起的时间（ISO）。跨工具统一排序时钟；不要用 Todo.updatedAt 代替。 */
  launchedAt?: string
}

// ---------- Todo ----------

export interface Todo {
  id: string
  title: string
  body?: string
  status: TodoStatus
  createdAt: string
  updatedAt: string
  bindings: SessionBinding[]
  /** 默认 resume 的那个（指向 bindings 中的一项） */
  primarySessionId?: CliSessionId
  lastLaunch?: LastLaunch
  /** 来源（M2 create_todo）：panel=面板聊天里做的 / pi=CLI 会话里做的 / 缺省=手写 */
  source?: 'panel' | 'pi'
  /** 幂等键：同 key 重复提交返回既有 todo（配合 pi-durable requestId / 重复 tool call） */
  requestId?: string
}

export interface TodoCreateInput {
  title: string
  body?: string
}

/** 部分更新：人体工学上禁止直接 patch 全对象，走白名单字段 */
export interface TodoPatch {
  title?: string
  body?: string
  status?: TodoStatus
  addBinding?: SessionBinding
  primarySessionId?: CliSessionId
  lastLaunch?: LastLaunch
}

// ---------- 边界解析（外部数据 → 领域类型的唯一入口） ----------

/**
 * todos.json 是外部数据（手编/网盘合并/旧版本都可能写坏）：逐条校验后再进内存。
 * 核心字段坏的条目丢弃；条目里个别坏 binding 丢弃、todo 本身保留（标题是最值钱的数据）。
 * 返回 undefined = 整体结构坏（非对象/缺数组/version 不支持）→ 调用方走 corrupt 备份路径。
 */
export function parseTodosFile(raw: unknown): { version: 1; todos: Todo[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return undefined // 未来版本按「结构非法」处理，上层备份原件
  if (!Array.isArray(r.todos)) return undefined
  const todos: Todo[] = []
  for (const item of r.todos) {
    const todo = coerceTodo(item)
    if (todo) todos.push(todo)
  }
  return { version: 1, todos }
}

function coerceTodo(v: unknown): Todo | undefined {
  if (!v || typeof v !== 'object') return undefined
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return undefined
  if (typeof t.title !== 'string') return undefined
  if (t.status !== 'open' && t.status !== 'done') return undefined
  if (typeof t.createdAt !== 'string' || typeof t.updatedAt !== 'string') return undefined
  const bindings = Array.isArray(t.bindings) ? t.bindings.map(coerceBinding).filter((b) => b) : []
  const todo: Todo = {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    bindings: bindings as SessionBinding[],
  }
  if (typeof t.body === 'string') todo.body = t.body
  if (typeof t.primarySessionId === 'string' && t.primarySessionId) {
    todo.primarySessionId = newCliSessionId(t.primarySessionId)
  }
  if (isLastLaunch(t.lastLaunch)) todo.lastLaunch = t.lastLaunch
  if (t.source === 'panel' || t.source === 'pi') todo.source = t.source
  if (typeof t.requestId === 'string') todo.requestId = t.requestId
  return todo
}

function coerceBinding(v: unknown): SessionBinding | undefined {
  if (!isBindingShape(v)) return undefined
  return v
}

function isBindingShape(v: unknown): v is SessionBinding {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  if (typeof b.toolId !== 'string' || !b.toolId) return false
  if (typeof b.sessionId !== 'string' || !b.sessionId) return false
  if (typeof b.boundAt !== 'string') return false
  if (b.state !== undefined && b.state !== 'pending' && b.state !== 'verified') return false
  if (b.filePath !== undefined && typeof b.filePath !== 'string') return false
  return true
}

function isLastLaunch(v: unknown): v is LastLaunch {
  if (!v || typeof v !== 'object') return false
  const l = v as Record<string, unknown>
  if (typeof l.toolId !== 'string' || !l.toolId) return false
  if (typeof l.projectPath !== 'string' || !l.projectPath) return false
  if (l.launchedAt !== undefined && typeof l.launchedAt !== 'string') return false
  return true
}

/**
 * IPC 边界的 TodoPatch 白名单归一化：renderer 传来的对象只保留合法字段。
 * body 传空串合法（= 清空正文）；全部字段不合法时返回 undefined（调用方报错）。
 */
export function sanitizeTodoPatch(raw: unknown): TodoPatch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const patch: TodoPatch = {}
  if (typeof r.title === 'string') patch.title = r.title
  if (typeof r.body === 'string') patch.body = r.body
  if (r.status === 'open' || r.status === 'done') patch.status = r.status
  if (isBindingShape(r.addBinding)) patch.addBinding = r.addBinding
  if (typeof r.primarySessionId === 'string' && r.primarySessionId) {
    patch.primarySessionId = newCliSessionId(r.primarySessionId)
  }
  if (isLastLaunch(r.lastLaunch)) patch.lastLaunch = r.lastLaunch
  return Object.keys(patch).length > 0 ? patch : undefined
}

// ---------- 会话（S5 / 多会话绑定 UI） ----------

/** 会话列表项（adapter 元数据 + Tick 侧绑定关系） */
export interface SessionView {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  name?: string
  firstMessage?: string
  /** 最后一条 user 消息（展开卡片「上次停在哪」） */
  lastMessage?: string
  createdAt: string
  lastUsedAt?: number
  filePath: string
  exists: boolean
  boundTodoId?: string
  boundTodoTitle?: string
}

/** 某条 todo 下的会话（绑定详情；会话文件可能已被删 → exists=false） */
export interface TodoSessionView extends SessionView {
  boundAt: string
  state?: 'pending' | 'verified'
  primary: boolean
  /** false = 会话文件已不在本机（只能看/解绑，不能 resume） */
  missing: boolean
}

export const SessionsIpc = {
  /** 全部会话（含已绑定；S5 只看未绑定） */
  list: 'sessions:list',
  /** 某条 todo 的绑定会话详情 */
  forTodo: 'sessions:for-todo',
  /** S5：用历史会话建 todo 并绑定 */
  claim: 'sessions:claim',
  /** 把历史会话绑到已有 todo */
  bind: 'sessions:bind',
  setPrimary: 'sessions:set-primary',
  unbind: 'sessions:unbind',
} as const

/** 单会话用量（F6-b）：只统计工具侧会话，面板 Chat 永不参与 */
export const UsageIpc = {
  get: 'usage:get',
} as const

// ---------- 导出（F8） ----------

export type ExportScope = 'all' | 'open' | 'todo'

export interface ExportRequest {
  scope: ExportScope
  todoId?: string
}

export interface ExportResult {
  jsonPath: string
  markdownPath: string
  todoCount: number
  sessionCount: number
}

export const ExportIpc = {
  run: 'export:run',
  /** 在 Finder 里定位产物 */
  reveal: 'export:reveal',
} as const

export interface SessionsListOptions {
  /** 只看未绑定（S5） */
  unboundOnly?: boolean
  /** 按项目预筛（S5 从 todo 展开时带入） */
  projectPath?: string
}

// ---------- 设置（F4-b） ----------

export type LaunchDeliverSetting = 'clipboard' | 'argv'
export type DefaultProjectSetting = 'home' | 'recent' | 'ask'

// ---------- 面板 Chat 自配 Provider（PRD F5 来源 2，M3 尾巴） ----------

/**
 * 自配 provider 的**非敏感**配置。apiKey 本身不进这里、也不进 data/：
 * 它经 Electron safeStorage（系统钥匙串支撑）加密后存 userData 目录，
 * settings.json 只记 `keyStored` 标记（TECH-ARCH §7/§9 凭据纪律）。
 */
export interface CustomProviderConfig {
  /** OpenAI 兼容 endpoint，如 https://api.openai.com/v1 或任意网关/代理地址 */
  baseUrl: string
  /** 模型 id（手填，或从「测试连接」拉回的列表里选） */
  model: string
  /** 展示名（选填；面板顶栏模型名处展示） */
  name?: string
  /** true = apiKey 已存入系统钥匙串（data/ 里永远不出现 key 本身） */
  keyStored: boolean
}

/** provider:test 的返回：ok + 一句话说明 +（成功时）可选的模型 id 列表 */
export interface ProviderTestResult {
  ok: boolean
  message: string
  models?: string[]
}

/** provider:save 的入参（apiKey 走 safeStorage，不进 settings.json） */
export interface ProviderSaveInput {
  name?: string
  baseUrl: string
  model: string
  /** 留空 = 保持已存的 key 不变；有值 = 覆盖 */
  apiKey?: string
}

/** 首版设置项（PRD F4-b + F6-b 用量开关 + M3 自配 provider） */
export interface AppSettings {
  /** 拉起时的投递方式：默认剪贴板（可审阅） */
  deliver: LaunchDeliverSetting
  /** 默认项目：home（确定兜底）/ recent（最近使用，猜）/ ask（每次必问） */
  defaultProject: DefaultProjectSetting
  /** 单会话用量统计（默认关；M3） */
  usageEnabled: boolean
  /** 面板 Chat 自配 provider（null = 跟随 pi 凭据）。含 keyStored 标记但不含 key */
  customProvider?: CustomProviderConfig | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  deliver: 'clipboard',
  defaultProject: 'home',
  usageEnabled: false,
  customProvider: null,
}

export const SettingsIpc = {
  get: 'settings:get',
  update: 'settings:update',
  changed: 'settings:changed',
  /** 打开 ~/.ticktodo（设置里标注备份哪一层） */
  openDataDir: 'settings:open-data-dir',
} as const

/** 自配 provider（M3 尾巴）：非敏感配置走 settings，key 走 safeStorage，不混 */
export const ProviderIpc = {
  /** 当前自配配置（不含 key） */
  get: 'provider:get',
  /** 保存自配配置（key 进钥匙串）并重建面板对话 */
  save: 'provider:save',
  /** 清除自配（key 一并删除）→ 回到 pi 凭据 */
  clear: 'provider:clear',
  /** 连接测试（用输入框里的值测，不落盘） */
  test: 'provider:test',
} as const

// ---------- IPC 通道 ----------

export const TodosIpc = {
  list: 'todos:list',
  create: 'todos:create',
  update: 'todos:update',
  remove: 'todos:remove',
  /** main 的 fs.watch 发现 todos.json 被外部（pi extension）改动 → 推给 UI 重读 */
  changed: 'todos:changed',
} as const

export const WindowIpc = {
  hide: 'window:hide',
  quit: 'window:quit',
  /** 全局快捷键新建线索：main → renderer，让捕获行聚焦 */
  newTodo: 'window:new-todo',
  /** 置顶开关：开启时 alwaysOnTop；关闭时失焦自动隐藏 */
  getPinned: 'window:get-pinned',
  setPinned: 'window:set-pinned',
} as const

/** 项目索引（M1）：list=首帧取缓存；refresh=手动重扫；updated=main 后台扫完推送 */
export const ProjectsIpc = {
  list: 'projects:list',
  refresh: 'projects:refresh',
  updated: 'projects:updated',
  /** 打开系统目录选择器并 pin 为项目（F3：pi 不可用时也能手动添加） */
  add: 'projects:add',
  /** 失效项目重新定位：只做 old→new 映射，不移动 agent 自己的会话文件（F3） */
  relocate: 'projects:relocate',
} as const

/** 工具就绪探测（Q14 双出口空态的判据） */
export const ToolsIpc = {
  status: 'tools:status',
} as const

// ---------- 面板 Chat（M2，pi-durable） ----------

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  /** 流式中（最后一条 assistant 未定稿） */
  streaming?: boolean
}

/** 面板 Chat 的状态：就绪度决定 UI 是给输入框还是给一行说明 */
export type ChatStatus = 'idle' | 'busy' | 'unavailable'

export interface ChatState {
  status: ChatStatus
  messages: ChatMessage[]
  /** status='unavailable' 时的原因（凭据缺失 / pi 未安装 / 初始化失败） */
  reason?: string
  /** 当前使用的模型（provider/modelId），便于用户确认走的是哪条凭据 */
  model?: string
  /** 面板对话的工作目录（默认 home，可切换；PRD F5） */
  cwd?: string
  /** 凭据来源：pi 本体（默认） / 自配 provider（M3 尾巴） */
  source?: 'pi' | 'custom'
}

export const ChatIpc = {
  state: 'chat:state',
  send: 'chat:send',
  abort: 'chat:abort',
  updated: 'chat:updated',
  reset: 'chat:reset',
  setCwd: 'chat:set-cwd',
} as const

// ---------- 拉起 / 恢复（M2，ai-picker） ----------

export type LaunchDeliver = 'clipboard' | 'argv'
/** adapter 内部对 resume 的投递是 none；UI 永远只选前两个 */
export type DeliveredMode = LaunchDeliver | 'none'

export interface LaunchRequest {
  todoId: string
  /** 不传则用 CwdResolver（绑定 session 的 cwd → lastLaunch → home） */
  projectPath?: string
  deliver: LaunchDeliver
  /** 投递文案（缺省用 todo.title） */
  promptText?: string
}

export interface LaunchOutcome {
  ok: boolean
  sessionId?: CliSessionId
  projectPath?: string
  /** verify 未通过 / spawn 失败时的原因 */
  reason?: string
  delivered: DeliveredMode
  /**
   * true = 会话尚未产生内容（绑定已写为 pending）。
   * 剪贴板投递的正常结果：pi 已在终端打开，用户发送第一条消息后由后台对账转 verified。
   */
  pending?: boolean
}

export interface ResumeRequest {
  todoId?: string
  sessionId: CliSessionId
  projectPath?: string
}

export const LaunchIpc = {
  launch: 'launch:launch',
  resume: 'launch:resume',
  /** 解析默认项目（主按钮上显示它） */
  resolveCwd: 'launch:resolve-cwd',
} as const
