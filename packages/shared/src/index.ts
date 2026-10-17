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
} as const

export const WindowIpc = {
  hide: 'window:hide',
  quit: 'window:quit',
} as const
