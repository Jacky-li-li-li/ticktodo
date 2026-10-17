/**
 * @tick/ai-core — 工具无关的合同与纯函数。
 *
 * 分层（TECH-ARCH §6.1）：
 *   ai/<tool> adapter → 只吐原始证据（ProjectSource），不做归并
 *   ai/core           → mergeProjects 纯函数：归一化 → git 根上卷 → 合并 → 排序
 *   main              → ProjectIndexService：调度 + 缓存 + 失效 + IPC
 *
 * M0 状态：落合同类型。实装顺序 M1（canonicalPath / mergeProjects / registry）。
 */

import type { CliSessionId } from '@tick/shared'
import { newCliSessionId as mkId } from '@tick/shared'

/** 便捷出口：从任意字符串安全产出 CliSessionId（品牌类型由 shared 保证） */
export const newCliSessionId = mkId

// ---------- 会话元数据（权威源在工具侧） ----------

export interface SessionInfo {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  name?: string
  /** name 缺失时的回退：首条 user 消息（压成一行）。S5 建 todo 的标题用 */
  firstMessage?: string
  createdAt: string
  lastUsedAt?: number
  exists: boolean
  /** 会话文件绝对路径（F8 导出必须给，让用户能定位原始会话） */
  filePath?: string
  /** false = 只读会话，不能 resume */
  resumable: boolean
  /** false = 本机看不到它的文件（远端/网关侧），只能看不能跳 */
  hasLocalFiles: boolean
  /**
   * fork 血缘：对齐 pi header 的 `parentSession`——只在 /fork、/clone、
   * newSession({parentSession}) 时出现，值是源会话文件路径。读首行即得。
   * 用途：标注血缘 + 用量求和时跳过继承段（TECH-ARCH §6.2 陷阱 3）。
   */
  parentSessionPath?: string
}

export interface SessionRef {
  toolId: string
  sessionId: CliSessionId
}

/** 会话列表的轻量元数据（S5 反向建索引 / 多会话绑定 UI） */
export interface SessionSummary {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  name?: string
  firstMessage?: string
  createdAt: string
  lastUsedAt?: number
  filePath: string
  exists: boolean
  /** fork 血缘（前缀条目继承自源文件，用量求和要跳过） */
  parentSessionPath?: string
  /** 文件大小（字节，用于 UI 详情/诊断） */
  size?: number
}

// ---------- 用量（F6-b：只统计工具侧会话，面板不参与） ----------

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
}

export interface CostUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface SessionUsage {
  tokens: TokenUsage
  /** cost 可能缺失/不可信（provider 未上报）→ UI 只能当下限 */
  cost: CostUsage
  byModel: { provider: string; model: string; tokens: TokenUsage; cost: CostUsage }[]
  messageCount: number
  computedAt: number
  /** false = 至少一个 provider 有 token 却报 0 成本 → UI 标注「未上报 / ≥」 */
  costReported: boolean
}

// ---------- 项目证据与归并 ----------

/** adapter 输出：只贡献证据，不做任何归并 */
export interface ProjectSource {
  toolId: string
  projects: {
    path: string
    sessionCount: number
    lastUsedAt?: number
    exists: boolean
  }[]
}

/** core 归并后的唯一形态（主键 = canonical 路径，绝不写成 (toolId, path)） */
export interface ProjectEntry {
  path: string
  /** 上卷前的真实 cwd，需要时可细选 */
  children?: string[]
  /** 多值证据标签，不是单值 */
  tools: string[]
  sessionCount: number
  lastUsedAt?: number
  /** Tick 拉起时自写（跨工具唯一可对齐的时钟） */
  lastLaunchedAt?: number
  /** 用户手动添加 → 不参与 stale 清理 */
  pinned: boolean
  exists: boolean
}

// ---------- 投递方式 ----------

/**
 * pi 的 argv = 立即发送（源码确认无「仅预填」模式）；
 * 想要「等我确认后再发」只能走 clipboard。
 */
export type DeliverMode = 'argv' | 'clipboard' | 'flag' | 'stdin' | 'none'

// ---------- Adapter 合同 ----------

export interface LaunchContext {
  promptText: string
  cwd: string
  sessionId: CliSessionId
  name?: string
  deliver: DeliverMode
}

export interface LaunchResult {
  toolId: string
  sessionId: CliSessionId
  cwd: string
  pid?: number
  delivered: 'argv' | 'clipboard' | 'none'
  /** spawn 成功但 verify 判定 session 未真正产生（size===0 或不存在） */
  verified: boolean
}

/**
 * 跨工具接手是有向、非对称的（F6-a）：
 * pi→pi 换目录 ✅ / omp 读 pi ✅ / pi 读 omp ❌（forkFrom 要求源首行 type:"session"）。
 * UI 只列可行方向，不可行灰掉并说明原因；任何方向都有「摘要作首条投递」保底。
 */
export interface CarryCapability {
  acceptFrom: { format: string; via: 'fork' | 'import' | 'none' }[]
  exposes: { format: string }[]
}

export interface AiToolAdapter {
  id: string
  /** 就绪探测：pi 用可执行文件 + `pi auth check`；失败=引导空态双出口（Q14） */
  detect(): Promise<{
    installed: boolean
    /** 例：pi 1.2.0 < 1.3.0 → 提示升级 */
    version?: string
    reason?: string
  }>
  capabilities: {
    needsCwd: boolean
    resumeSession: boolean
    deliverPrompt: DeliverMode[]
    setSessionName: boolean
    discoverProjects: boolean
    describeSessions: boolean
    /** 会话是否自带 usage（pi ✅；面板 Chat 永不参与统计） */
    usage: boolean
  }
  discoverProjects?(): Promise<ProjectSource['projects']>
  listSessions?(cwd?: string): Promise<SessionRef[]>
  /** 会话列表（含 name/firstMessage/filePath；S5 与多会话 UI 用） */
  listSessionInfos?(): Promise<SessionSummary[]>
  /** 单会话用量（F6-b；口径由各 adapter 自己算） */
  computeUsage?(sessionId: CliSessionId): Promise<SessionUsage | undefined>
  /** withName=false 时只读 header（cwd 推导等场景不需要全量扫 name，避免读整份会话正文） */
  describeSession?(id: CliSessionId, opts?: { withName?: boolean }): Promise<SessionInfo | undefined>
  /** launch 后校验 session 真的产生：必须绕缓存直读，且 size===0 视为未产生 */
  verify?(sessionId: CliSessionId): Promise<boolean>
  launch(ctx: LaunchContext): Promise<LaunchResult>
  resume(sessionId: CliSessionId, ctx: LaunchContext): Promise<LaunchResult>
  carry?: CarryCapability
}

// ---------- Registry ----------

export class AiToolRegistry {
  private adapters = new Map<string, AiToolAdapter>()

  register(adapter: AiToolAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): AiToolAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): AiToolAdapter[] {
    return [...this.adapters.values()]
  }
}

export * from './canonical-path'
export * from './project-merge'
export * from './session-ns'
