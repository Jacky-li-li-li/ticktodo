/**
 * SessionLocator — 从「客户端 + 本机会话文件」反解会话身份的**只读**小合同。
 *
 * 为什么不是 AiToolAdapter：MCP 绑定只需要两件事——扫哪个目录、从命中文件里读 sessionId；
 * 完整 adapter 的 launch/verify/usage 在这里都是负担。locator 不 import Electron、不写文件。
 */

export interface ClientIdentity {
  name?: string
  version?: string
}

export interface LocatedSession {
  /** 工具侧原始 id（写进 binding.sessionId） */
  sessionId: string
  /** 会话 header/meta 里的 cwd（可缺失；不用于路由） */
  cwd?: string
  /** 命中的会话文件（写进 binding.filePath 提示） */
  filePath: string
  /** false = 该会话不能「回到会话」（如 WorkBuddy AI playground） */
  resumable: boolean
}

export type ResumeSpec =
  | { kind: 'terminal'; executable: string; args: string[]; cwd?: string }
  | { kind: 'deeplink'; url: string }

export interface SessionLocator {
  /** 写进 binding.toolId / mcpOrigin.toolId；必须是稳定 kebab-case */
  toolId: string
  displayName: string
  /** 判断一条 MCP 连接是不是这个客户端（clientInfo.name 优先，env 兜底） */
  matches(client: ClientIdentity, env: NodeJS.ProcessEnv): boolean
  /** 候选会话根（目录）。不存在的根由扫描器跳过；实现不应 mkdir */
  roots(): string[]
  /**
   * 从命中的文件反解 sessionId。
   * 不是本工具格式 / 0 字节 / 读不了 → undefined（不猜）。
   * 只允许读 header/meta，禁止扫全文缓存正文。
   */
  readSession(filePath: string): Promise<LocatedSession | undefined>
  /** 回到会话的方式（UI 用；缺省 = 只记录不跳转） */
  resumeSpec?(sessionId: string, cwd?: string): ResumeSpec | undefined
}
