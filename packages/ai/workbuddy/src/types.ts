/**
 * types — WorkBuddy 适配器的共享类型。
 *
 * 两个发行版（国内版 `workbuddy` / 国际版 `workbuddy-ai`）共用同一套存储内核
 * （`workbuddy.db` 的 sessions 表 + `projects/<编码 cwd>/<id>.jsonl`），但**身份各自独立**：
 * App bundle、bundle id、数据根、URL scheme、playground 策略都由 `WorkbuddyIdentity` 给出，
 * 绝不靠环境变量猜版本（rules §1 / PRD §9.8、§9B.1）。2026-10-19 起不再探测/校验版本。
 */

/**
 * 一个 WorkBuddy 发行版的固定身份。
 *
 * 注意：这里不读任何 WorkBuddy 的配置文件（settings.json / keyblob / security/ 等），
 * 身份全部来自 App bundle 与我们自己的常量（只读边界见 PRD §9.7 / §9B.5）。
 */
export interface WorkbuddyIdentity {
  /** 适配器 id：`workbuddy` | `workbuddy-ai`（rules §1） */
  toolId: string
  /** 展示名（错误文案/日志用）：`WorkBuddy` | `WorkBuddy AI` */
  displayName: string
  /** App bundle 的 CFBundleIdentifier（install 判定的唯一硬判据） */
  bundleId: string
  /** App bundle 目录名：`WorkBuddy.app` | `WorkBuddy AI.app` */
  appBundleName: string
  /** 深链接 scheme：`workbuddy` | `workbuddy-ai` */
  scheme: string
  /** 默认数据根目录名（`~` 下）：`.workbuddy` | `.workbuddy-ai` */
  defaultRootName: string
  /**
   * 数据根覆盖用的环境变量。**仅国内版有** `WORKBUDDY_CONFIG_DIR`；
   * 国际版不吃国内版的 env（两个 build 各管各的目录，PRD §9.8 / §9B.1）。
   */
  envRootVar?: string
  /**
   * `is_playground=1` 的会话是否保守置灰（不可 resume）。
   * 国际版为 true：playground 深链接冷启动回落归因未证伪（PRD §9B.6 保守决定）；
   * 国内版没有该结论，不启用。
   */
  playgroundUnresumable: boolean
  /** launch() 的固定文案：桌面工具没有任何「从 Tick 新建会话」的入口 */
  launchErrorText: string
}

/**
 * 外部副作用注入（rules §2：ai 包不依赖 Electron）。
 * 全部可选：缺省时读取能力照常工作，只有 resume 需要 openUrl。
 */
export interface WorkbuddyAdapterDeps {
  /** 打开深链接的出口（main 进程注入 shell.openExternal） */
  openUrl?: (url: string) => Promise<void> | void
  /** 数据根覆盖（用户配置优先；测试隔离用） */
  rootDir?: string
  /** App bundle 搜索目录覆盖（默认 `/Applications` + `~/Applications`） */
  appDirs?: string[]
  /** 读取失败的一次性日志出口（文案不含会话 id/标题/正文） */
  log?: (key: string, message: string) => void
  /** 时钟注入（detect 缓存 TTL；测试用） */
  now?: () => number
}

/** sqlite / transcript 层共用的「按 key 去重」日志出口 */
export type WorkbuddyLog = (key: string, message: string) => void

/** DB 里一行**有效**会话（已按 deleted_at / transport / 后台自动化过滤并归一） */
export interface WorkbuddySessionRow {
  /** 工具侧原始 UUID：既是 jsonl 文件名，也是深链接参数（不加任何前缀） */
  id: string
  /** 绑定工作目录（DB 权威值；可能为 NULL/相对路径，用前要判绝对路径） */
  cwd: string
  /** DB `title`（模型生成标题） */
  title?: string
  /** DB `custom_title`（用户改名，优先级高于 title） */
  customTitle?: string
  /** DB `status`：completed / active / error / Pending（语义无第三方佐证） */
  status: string
  /** ms 时间戳；缺失时由 updated_at 兜底 */
  createdAt: number
  /** ms 时间戳 */
  updatedAt: number
  /** ms 时间戳；缺失表示这一行没有该列或为 NULL */
  lastActivityAt?: number
  /** ms 时间戳；非删除值实测有 NULL / -1 / 0，归一后 <= 0 表示未删除 */
  deletedAt: number
  /** 归一后恒为 `local`（cloud 会话不参与本地时间线） */
  transport: string
  /** 国际版 playground 会话：深链接定位未验证 → 保守置灰 */
  isPlayground: boolean
  /** 后台自动化会话：不参与列表/时间线 */
  isBackgroundAutomation: boolean
}

/** detect() 的返回（对齐 AiToolAdapter 合同：只判装没装） */
export interface WorkbuddyDetectResult {
  installed: boolean
  reason?: string
}

/**
 * jsonl 流式扫描的产出：只保留必要文本，不留正文（rules §4）。
 * 首条/最后一条 user 消息用同一套过滤规则（rules §5）。
 */
export interface WorkbuddyTranscriptMeta {
  firstUserText?: string
  lastUserText?: string
  /** 首条 user 事件时间（ms） */
  firstUserAt?: number
  /** 最后一条 user 事件时间（ms） */
  lastUserAt?: number
  /** 会话内最后一条 message 事件时间（ms） */
  lastEventAt?: number
  /** 末条 user/assistant 消息类型（判断「末条是不是 assistant 终态」） */
  lastEventKind?: 'user' | 'assistant'
  /** 末条 assistant 消息自带的 status（实测 completed；未知值原样保留） */
  lastAssistantStatus?: string
  /** 标题兜底：jsonl `custom-title` > `ai-title` */
  title?: string
}
