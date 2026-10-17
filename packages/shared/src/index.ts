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
}

/** 上次用哪个工具 + 哪个目录 —— 用户意图，一体记忆（拆开会在切工具时选错） */
export interface LastLaunch {
  toolId: string
  projectPath: string
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
} as const

/** 项目索引（M1）：list=首帧取缓存；refresh=手动重扫；updated=main 后台扫完推送 */
export const ProjectsIpc = {
  list: 'projects:list',
  refresh: 'projects:refresh',
  updated: 'projects:updated',
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
}

export const ChatIpc = {
  state: 'chat:state',
  send: 'chat:send',
  abort: 'chat:abort',
  updated: 'chat:updated',
  reset: 'chat:reset',
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
