/**
 * main — 应用入口。
 *
 * 启动顺序：resolveDirs → ensureDirs（0700）→ TodoStore → 装配 adapter/索引/拉起/面板对话
 *          → 窗口（记忆位）→ IPC → 载入 UI。
 * 常驻语义：关窗 = 隐藏（app 不退）；Cmd+Q 退出。
 */

import { app, BrowserWindow, clipboard, globalShortcut, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { autoUpdater } from 'electron-updater'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { ChatIpc, ProjectsIpc, TodosIpc, WindowIpc, UpdateIpc, toolDisplayName } from '@tick/shared'
import type { UpdateState } from '@tick/shared'
import { AiToolRegistry, canonicalPath, gitRootOf } from '@tick/ai-core'
import { cleanStaleTmp } from '@tick/todo-core'
import { PiAdapter } from '@tick/ai-pi'
import { ClaudeAdapter } from '@tick/ai-claude'
import { ClaudeDesktopAdapter } from '@tick/ai-claude-desktop'
import { QoderAdapter, QODER_CN_DISTRO, QODER_DISTRO } from '@tick/ai-qoder'
import { CodexAdapter } from '@tick/ai-codex'
import { ClineAdapter } from '@tick/ai-cline'
import { GrokAdapter } from '@tick/ai-grok'
import { OmpAdapter } from '@tick/ai-omp'
import { KimiAdapter } from '@tick/ai-kimi'
import { OpenCodeAdapter, resolveOpenCodeDbPath } from '@tick/ai-opencode'
import { ZCodeAdapter } from '@tick/ai-zcode'
import { DshAdapter } from '@tick/ai-dsh'
import { WorkbuddyAdapter } from '@tick/ai-workbuddy'
import { WorkbuddyAiAdapter } from '@tick/ai-workbuddy-ai'
import { ensureDirs, resolveDirs } from './services/storage'
import { ProjectIndexService } from './services/project-index'
import { ChatAgentHost } from './services/chat-host'
import { LaunchService } from './services/launch'
import { SettingsStore } from './services/settings-store'
import { CredentialVault } from './services/credential-vault'
import { ProviderConfigService } from './services/provider-config'
import { SessionService } from './services/sessions'
import { ExportService } from './services/export'
import { McpConnectionService } from './services/mcp-connection'
import { cleanupLaunchCache, createTerminalLauncher } from './services/terminal-launch'
import { probeDeveloperIdSignature, UpdateService } from './services/update'
import type { UpdaterLike } from './services/update'
import { TodoStore } from './store'
import {
  createPanelWindow,
  getPanelPinned,
  installAppMenu,
  MIN_W,
  saveWindowState,
  setBlurHideSuppressed,
  setPanelPinned,
} from './window'
import { registerIpc } from './ipc'

// userData 稳定化：自配 provider 的 key 密文在 userData（系统钥匙串支撑），
// 不用默认的 Electron 目录名（dev 下 app name 是 @tick/desktop，会漂）。
// 必须在任何 Electron API 之前生效（requestSingleInstanceLock 也用 userData 建锁）。
app.setName('Tick')

// 单实例：面板是常驻窗，二次拉起（install.sh/dock 双击）应聚焦已有实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// dev：开 CDP 端口，便于本仓自检（生产不启用）
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223')
}

let panel: BrowserWindow | null = null
let chat: ChatAgentHost | undefined
let tray: Tray | null = null
// before-quit 与 UpdateService 的 prepareQuit 共用同一个标志（安装更新时要让退出直接放行）
let quitting = false

app.on('second-instance', () => {
  if (panel) {
    if (panel.isMinimized()) panel.restore()
    panel.show()
    panel.focus()
  }
})

/**
 * 面板内容尺寸口径（与 renderer/styles.css 对应，改动布局时要同步）：
 * - 顶部 chrome：panel padding 14*2 + topbar 26 + gap 12*2 + capture 46 = 126
 * - 每条线索行 56（标题 + 上次说到哪两行），content 子元素 gap 2；默认最多展示 5 条
 */
const PANEL_CHROME_H = 126
const ROW_H = 56
const ROW_GAP = 2
const MAX_VISIBLE_ROWS = 5

function minPanelHeight(openCount: number): number {
  const rows = Math.min(Math.max(openCount, 0), MAX_VISIBLE_ROWS)
  const listH = rows === 0 ? 120 : rows * ROW_H + Math.max(0, rows - 1) * ROW_GAP
  return PANEL_CHROME_H + listH
}

/** Tray 悬停提示：Ticktodo-<open 线索数>个 */
function updateTrayTooltip(openCount: number): void {
  tray?.setToolTip(`Ticktodo-${openCount}个`)
}

/** 动态最小尺寸：只收紧最小高度，不设最大；新增 todo 时只向上长、不自动缩 */
function applyTodoWindowMetrics(win: BrowserWindow | null, openCount: number): void {
  if (!win || win.isDestroyed()) return
  const minH = minPanelHeight(openCount)
  win.setMinimumSize(MIN_W, minH)
  const [w, h] = win.getSize()
  if (h < minH) win.setSize(w, minH)
}

app.whenReady().then(() => {
  // 单一浅色玻璃主题（黑字令牌，无深色适配）：把外观钉在 light，
  // 避免系统深色模式下 fullscreen-ui vibrancy 把面板压暗、黑字失效。
  nativeTheme.themeSource = 'light'

  // 纯菜单栏模式：不在 Dock 显示，只保留菜单栏 Tray 与全局快捷键。
  // 打包版另外在 electron-builder 的 mac.extendInfo 里写了 LSUIElement=true，
  // 避免启动瞬间先闪一下 Dock 图标；dev 下用 app.dock.hide() 等价处理。
  if (process.platform === 'darwin') {
    app.dock?.hide()
    console.log('[tick] macOS 纯菜单栏模式：Dock 图标已隐藏')
  }

  const dirs = resolveDirs()
  ensureDirs(dirs)
  // 兜底清理：上一次 pi 没启动/扩展没消费时，prefill 正文可能留在 cache/launch
  cleanupLaunchCache(path.join(dirs.cache, 'launch'))
  // data/ 是「建议同步」层：崩溃残留的写盘 tmp 不清理会被一起同步走
  cleanStaleTmp(dirs.data)

  const store = new TodoStore(path.join(dirs.data, 'todos.json'))
  store.ensureFile()
  const settingsStore = new SettingsStore(path.join(dirs.data, 'settings.json'))
  const credentialVault = new CredentialVault(app.getPath('userData'))
  const providerConfig = new ProviderConfigService(settingsStore, credentialVault)

  // ---------- adapter 注册表（M1；M5 起多工具） ----------
  const registry = new AiToolRegistry()
  const openTerminal = createTerminalLauncher(path.join(dirs.cache, 'launch'))
  // Electron 44 的 clipboard.writeText 返回 Promise；ai 包的注入面是同步 void，所以这里不 await。
  // 但失败必须留日志：terminal-copy 的 notice 会宣称「文案已复制」，静默失败会让用户粘到旧内容。
  const clipboardWrite = (text: string): void => {
    void clipboard.writeText(text).catch((e) => {
      console.warn('[tick] 剪贴板写入失败:', (e as Error).message)
    })
  }
  const pi = new PiAdapter({
    clipboardWrite, // 剪贴板投递出口（ai 包不依赖 Electron）
    // 交互式 pi 必须开在终端里（非 TTY 会降级成 headless print 模式）
    openTerminal,
    // 预填投递：一次性 prompt 文件交给 pi 扩展（session_start 读取后删除）
    prefillDir: path.join(dirs.cache, 'launch'),
  })
  registry.register(pi)

  // Claude Code CLI：与 pi 同类（终端拉起 + resume + 用量），但预填用原生 `--prefill=`，
  // 不需要一次性文件/扩展回执。会话正文与 Claude Desktop 共用同一份 jsonl，靠 entrypoint 分开。
  const claude = new ClaudeAdapter({ clipboardWrite, openTerminal })
  registry.register(claude)

  // Qoder（`qoder` / 国内版 `qoder-cn`）：会话格式与 Claude Code 逐字段相同 → 复用同一套解析，
  // 只换身份/数据根/resume argv。没有预生成 id 的能力，所以只能「倒入历史会话 + 回到会话」。
  registry.register(new QoderAdapter(QODER_DISTRO, { clipboardWrite, openTerminal }))
  registry.register(new QoderAdapter(QODER_CN_DISTRO, { clipboardWrite, openTerminal }))

  // 桌面/数据库类适配器的日志出口按 (key, message) 约定收口，文案不含会话正文/标题
  const logDesktopTool = (key: string, message: string): void => console.warn(`[tick] ${key}:`, message)
  // 桌面工具的深链接出口：用 shell.openExternal，并把异常原样向上抛给 adapter → LaunchService 转成
  // 可读的 reason（`open` 恒 exit 0，不能靠返回值判断成败，所以只能靠 Promise 拒绝表达失败）。
  const openUrl = (url: string): Promise<void> => shell.openExternal(url)
  /**
   * 把桌面 App 带到前台：`open -a <bundle 路径>`。
   * 不用深链接：OpenCode 1.19.3 的新布局不处理 `opencode://`（见 adapter 头注释），
   * 而 `open -a` 能在 App 已隐藏 / 在别的 Space 时把窗口叫回来。
   *
   * 两个纪律：
   *  - 绝对路径 `/usr/bin/open`：GUI 进程只继承 launchd 的最小 PATH，不依赖 PATH 更稳（不变量 15）；
   *  - 必须带超时：这条 Promise 会被 IPC（新建页按钮的 busy 状态）await，LaunchServices 卡住
   *    不返回时会让按钮永远停在「打开中…」。
   */
  const ACTIVATE_TIMEOUT_MS = 5_000
  const activateApp = (appPath: string): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-a', appPath], { timeout: ACTIVATE_TIMEOUT_MS }, (err) => {
        if (!err) {
          resolve()
          return
        }
        // execFile 超时会 SIGTERM 子进程并把 killed 置 true；换成人能读的原因交给 adapter
        reject(
          err.killed
            ? new Error(`激活 App 超时（${ACTIVATE_TIMEOUT_MS / 1000}s 未返回）：${appPath}`)
            : err,
        )
      })
    })

  // 只能「倒入历史会话 + 回到会话」的 CLI 工具（都没有预生成会话 id 的能力）：
  //   codex  ：一个 thread 可能跨多个 rollout 文件 → SessionSummary.files 保留全部
  //   cline  ：manifest + 整份重写的 messages.json
  //   grok   ：一目录一会话（summary.json + updates.jsonl）
  //   omp    ：pi 的目录/格式，但首行是 title 行（不是 header）
  // 这些 CLI 没有草稿 API（启动参数会立刻发送）→ prefill 形态是「打开终端 + 文案进剪贴板」
  registry.register(new CodexAdapter({ openTerminal, clipboardWrite }))
  registry.register(new ClineAdapter({ openTerminal, clipboardWrite }))
  registry.register(new GrokAdapter({ openTerminal, clipboardWrite }))
  registry.register(new OmpAdapter({ openTerminal, clipboardWrite }))
  // kimi：cwd 只在 session_index.jsonl 的 workDir（state.json 没有），子代理 wire 归主会话
  // log：kimi 的 wire 读取失败要按 key 记一次原因（rules「读失败记录一次、不含正文/标题」）；
  // 不接的话读失败会静默，会话/标题/用量只是「看起来变少」，无法诊断。
  registry.register(new KimiAdapter({ openTerminal, clipboardWrite, log: logDesktopTool }))
  // opencode / zcode：会话在 SQLite 里（filePath 指向数据库）；zcode 是桌面应用，没有 resume 通道
  registry.register(
    new OpenCodeAdapter(
      {
        toolId: 'opencode',
        displayName: toolDisplayName('opencode'),
        // 身份里的 dbPath 只是兜底快照（string 必填）；真正的读取走下面 deps 的 lazy getter
        dbPath: resolveOpenCodeDbPath(),
        usageSource: 'session-row',
        exeName: 'opencode',
        resumeArgs: (id) => ['--session', id],
        // 桌面版（ai.opencode.desktop）与 CLI 共用同一份 DB：只用于「装没装」判断，不拆适配器。
        // 本机实测它可能装在 /Applications/APP/OpenCode.app（findDesktopApp 会兜底 mdfind）。
        desktopBundleId: 'ai.opencode.desktop',
        desktopBundleName: 'OpenCode.app',
      },
      {
        openTerminal,
        clipboardWrite,
        activateApp,
        log: logDesktopTool,
        // lazy getter：每次读取重新解析数据根（XDG_DATA_HOME / 运行中首次安装后不必重启 Tick）
        dbPath: () => resolveOpenCodeDbPath(),
      },
    ),
  )
  registry.register(new ZCodeAdapter({ openTerminal, log: logDesktopTool }))
  // dsh（DeepSeek Harness）：会话是多帧 zstd，标题/用量走 dsh 自己的投影缓存；
  // 只有 dsh://open（聚焦窗口），没有按会话打开的通道 → 不能回到会话
  registry.register(new DshAdapter({ log: logDesktopTool }))

  // 国内版 / 国际版是**两个独立工具**（各自数据根、App bundle、scheme、toolId），不通过切换根目录复用
  const workbuddy = new WorkbuddyAdapter({ openUrl, log: logDesktopTool })
  const workbuddyAi = new WorkbuddyAiAdapter({ openUrl, log: logDesktopTool })
  registry.register(workbuddy)
  registry.register(workbuddyAi)
  // Claude Desktop（Code tab）：与 `claude` CLI 共用会话正文，但身份/新建/回到会话都独立
  const claudeDesktop = new ClaudeDesktopAdapter({ openUrl, log: logDesktopTool })
  registry.register(claudeDesktop)

  // 服务的适配器视图：一次性快照。装配期后不再注册新工具，所以不必每次问 registry。
  const adapters = registry.list()

  // 跨工具时钟：todos.lastLaunch{projectPath, launchedAt} → canonical/git 根 → 最近拉起时间
  // 不能用 Todo.updatedAt（任何编辑都会刷新它，排序会乱），也不能用原始子目录路径（overlay 匹配的是 git 根）。
  const launchClock = (): Map<string, number> => {
    const map = new Map<string, number>()
    for (const t of store.list()) {
      if (!t.lastLaunch) continue
      const ms = Date.parse(t.lastLaunch.launchedAt ?? t.updatedAt)
      if (Number.isNaN(ms)) continue
      const canonical = canonicalPath(t.lastLaunch.projectPath)
      const root = gitRootOf(canonical) ?? canonical
      for (const key of new Set([canonical, root])) {
        const prev = map.get(key)
        if (prev === undefined || ms > prev) map.set(key, ms)
      }
    }
    return map
  }
  const projectIndex = new ProjectIndexService(adapters, path.join(dirs.cache, 'projects.json'), {
    launchClock,
  })
  // 时间线派生缓存放 cache/（可再生；不进 data/，避免被同步/当成致命数据）
  const sessionService = new SessionService(adapters, store, {
    digestCacheFile: path.join(dirs.cache, 'session-digests.json'),
  })
  const exportService = new ExportService(adapters, store, () => settingsStore.get(), dirs.exports)
  const mcpConnection = new McpConnectionService({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: path.resolve(__dirname, '../../..'),
  })
  const launchService = new LaunchService(adapters, store, {
    settings: () => settingsStore.get(),
    resolveAlias: (p) => projectIndex.aliasOf(p),
    recentProject: () => {
      const home = os.homedir()
      return projectIndex
        .getCachedProjects()
        .find((p) => p.exists && p.path !== home && p.sessionCount > 0)?.path
    },
  })

  panel = createPanelWindow(dirs)
  applyTodoWindowMetrics(panel, store.list().filter((t) => t.status === 'open').length)
  installAppMenu(panel)

  // ---------- 面板 Chat：凭据来源可切换（pi 本体 / 自配 provider），切换 = 重建 host ----------
  const createChat = (): ChatAgentHost =>
    new ChatAgentHost({
      storageDir: dirs.panelChat,
      onState: (state) => panel?.webContents.send(ChatIpc.updated, state),
      credentialSource: providerConfig.chatCredentialSource(),
    })
  chat = createChat()
  void chat.init()

  // 串行化重建：并发触发（快速保存+清除 provider、更新取消后重建）时后来者排队，
  // 不会把上一个 host 的 close 与下一个的 init 交错出「无人持有的双活 host」。
  let chatRebuild: Promise<void> = Promise.resolve()
  const reloadChat = (): Promise<void> => {
    const next = chatRebuild.then(async () => {
      const old = chat
      chat = undefined
      await old?.close()
      chat = createChat()
      await chat.init()
    })
    chatRebuild = next.catch(() => {})
    return next
  }

  // ---------- 应用内更新（M6）：创建时机必须在 reloadChat 之后、registerIpc 之前 ----------
  // 生产入口在这里拿 electron-updater 的运行时单例；update.ts 只 import type，selftest 才能不依赖它。
  // electron-updater 是 CJS，autoUpdater 的声明类型与 UpdaterLike 窄接口不重合，用 unknown 转一次。
  const appBundlePath = path.resolve(process.execPath, '../../..')
  const updateService = new UpdateService({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    updater: autoUpdater as unknown as UpdaterLike,
    probeSignature: () => probeDeveloperIdSignature(appBundlePath),
    hasUpdateConfig: () => fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    autoCheckEnabled: () => settingsStore.get().autoUpdateCheck !== false,
    onState: (state) => panel?.webContents.send(UpdateIpc.changed, state),
    prepareQuit: async () => {
      // Squirrel 的安装退出不能被 chat flush 拦下：先关 chat，再让 before-quit 直接放行。
      // 顺序反过来时 before-quit 的 preventDefault 会把安装退出改成异步 app.quit()。
      quitting = true
      if (panel) (panel as unknown as { __willClose?: boolean }).__willClose = true
      try {
        await Promise.race([
          chat ? chat.close() : Promise.resolve(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
        ])
      } catch (e) {
        // 关 chat 失败不能挡住安装；原始异常只进 main 日志
        console.warn('[tick] 安装前关闭面板对话失败:', e)
      }
      // 安装没启动时由 service 调用：恢复退出标志并重建面板对话，用户不用重启应用
      return () => {
        quitting = false
        if (panel) (panel as unknown as { __willClose?: boolean }).__willClose = false
        void reloadChat().catch((e) => console.error('[tick] 安装取消后重建面板对话失败:', e))
      }
    },
  })

  registerIpc(
    store,
    {
      panel: () => panel,
      getPinned: () => getPanelPinned(),
      setPinned: (pinned) => (panel ? setPanelPinned(dirs, panel, pinned) : false),
      setBlurHideSuppressed,
    },
    {
      projectIndex,
      launch: launchService,
      chat: () => chat,
      settings: settingsStore,
      sessions: sessionService,
      exportService,
      dataDir: dirs.root,
      providerConfig,
      reloadChat,
      mcp: mcpConnection,
      update: updateService,
    },
    adapters,
  )

  // 启动定时器放在 registerIpc 之后：首帧 IPC 已经能拿到状态，自动检查不抢启动资源
  updateService.start()

  // ---------- 全局快捷键（M3 / PRD F1） ----------
  const showPanel = (): void => {
    if (!panel) return
    panel.show()
    panel.focus()
  }
  const togglePanel = (): void => {
    if (!panel) return
    if (panel.isVisible()) panel.hide()
    else showPanel()
  }
  const newTodo = (): void => {
    showPanel()
    panel?.webContents.send(WindowIpc.newTodo)
  }

  // ---------- Tray 的更新入口：动作执行前先让面板打开设置页，否则点完看不到任何结果 ----------
  const revealUpdateInSettings = (): void => {
    showPanel()
    panel?.webContents.send(WindowIpc.openSettings)
  }
  const updateTrayCheck = (): void => {
    revealUpdateInSettings()
    void updateService.check('manual').catch((e) => console.error('[tick-update] 检查失败:', e))
  }
  const updateTrayDownload = (): void => {
    revealUpdateInSettings()
    void updateService.download().catch((e) => console.error('[tick-update] 下载失败:', e))
  }
  const updateTrayInstall = (): void => {
    // 安装不先 showPanel：面板闪一下又退出没有意义
    void updateService.install().catch((e) => console.error('[tick-update] 安装失败:', e))
  }
  /** A §5.4 表：菜单是原生静态菜单，打开期间进度不刷新，下次打开时状态是准的 */
  const describeTrayUpdate = (
    state: UpdateState,
  ): { label: string; enabled: boolean; action?: () => void } => {
    switch (state.phase) {
      case 'idle':
        return { label: '检查更新…', enabled: true, action: updateTrayCheck }
      case 'checking':
        return { label: '正在检查更新…', enabled: false }
      case 'available':
        return { label: `下载 v${state.version}`, enabled: true, action: updateTrayDownload }
      case 'downloading':
        return { label: `正在下载 v${state.version} · ${state.percent}%`, enabled: false }
      case 'ready':
        return { label: `重启并更新到 v${state.version}`, enabled: true, action: updateTrayInstall }
      case 'up-to-date':
        return { label: `已是最新版本（v${state.currentVersion}）`, enabled: false }
      case 'unsupported':
        return { label: '自动更新不可用', enabled: false }
      case 'error':
        // 下载完成但交给 Squirrel 失败：已下载版本还在，直接给「重新下载」而不是重新检查
        if (state.scope === 'download' && state.version !== undefined) {
          return { label: `重新下载 v${state.version}`, enabled: true, action: updateTrayDownload }
        }
        // 可重试的错误走一次新检查；不可重试（签名/feed）不给动作，避免无意义循环
        return state.retryable
          ? { label: '检查更新失败，重试', enabled: true, action: updateTrayCheck }
          : { label: '自动更新失败，请手动下载', enabled: false }
    }
  }
  // 每次右键按最新状态重建：模块加载时构建一次会让「下载完成」永远看不到
  const buildTrayMenu = (): Menu => {
    const updateItem = describeTrayUpdate(updateService.getState())
    return Menu.buildFromTemplate([
      { label: '显示 / 隐藏面板', click: () => togglePanel() },
      { label: '新建线索', click: () => newTodo() },
      { type: 'separator' },
      { label: updateItem.label, enabled: updateItem.enabled, click: updateItem.action },
      { type: 'separator' },
      { label: '退出 Ticktodo', click: () => app.quit() },
    ])
  }

  // ---------- macOS 菜单栏常驻（Tray） ----------
  // 模板图标（trayTemplate.png/@2x）只保留 alpha，系统会自动适配浅色/深色菜单栏。
  const trayIconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'trayTemplate.png')
    : path.join(__dirname, '../build/trayTemplate.png')
  const trayImage = nativeImage.createFromPath(trayIconPath)
  const trayImage2x = nativeImage.createFromPath(trayIconPath.replace(/\.png$/, '@2x.png'))
  if (!trayImage2x.isEmpty()) {
    trayImage.addRepresentation({ scaleFactor: 2, buffer: trayImage2x.toPNG() })
  }
  if (!trayImage.isEmpty()) {
    if (process.platform === 'darwin') trayImage.setTemplateImage(true)
    tray = new Tray(trayImage)
    updateTrayTooltip(store.list().filter((t) => t.status === 'open').length)
    // 左键切换面板；右键弹菜单（不把左键变成菜单，保持“点一下显隐”的直觉）。
    // 鼠标在 Tray 上时抑制「失焦自动隐藏」：否则点菜单栏会先 blur 隐藏、再被 click 显示。
    tray.on('mouse-enter', () => setBlurHideSuppressed(true))
    tray.on('mouse-leave', () => setBlurHideSuppressed(false))
    tray.on('click', () => togglePanel())
    tray.on('right-click', () => {
      setBlurHideSuppressed(true)
      const menu = buildTrayMenu()
      menu.once('menu-will-close', () => setBlurHideSuppressed(false))
      tray?.popUpContextMenu(menu)
    })
    console.log('[tick] 菜单栏图标已创建')
  } else {
    console.warn('[tick] 菜单栏图标缺失:', trayIconPath)
  }

  const shortcuts: [string, () => void][] = [
    ['CommandOrControl+Alt+T', togglePanel],
    ['CommandOrControl+Alt+N', newTodo],
  ]
  for (const [accelerator, handler] of shortcuts) {
    try {
      if (!globalShortcut.register(accelerator, handler)) {
        console.warn(`[tick] 全局快捷键注册失败（可能被占用）：${accelerator}`)
      }
    } catch (e) {
      console.error(`[tick] 全局快捷键异常：${accelerator}`, e)
    }
  }
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    updateService.stop()
    tray?.destroy()
    tray = null
  })

  // ---------- M2：pi extension 安装 + 面板 Chat ----------
  // 没装 pi 时不往 ~/.pi 写东西（Q14：功能随工具降级）
  void (async () => {
    try {
      const detected = await pi.detect()
      if (detected.installed) installTickExtension()
    } catch (e) {
      console.error('[tick] pi 检测失败，跳过 extension 安装:', e)
    }
  })()
  watchTodosFile(store, dirs.data)

  // pending 绑定对账：终端里的 pi 产生会话文件后，把绑定从 pending → verified。
  // 没有 pending 时几乎零成本（只读一次 todos.json）；重叠的 tick 直接跳过。
  let reconciling = false
  const reconcile = (): void => {
    if (reconciling) return
    reconciling = true
    void launchService
      .reconcilePending()
      .then((n) => {
        if (n > 0) console.log(`[tick] pending 绑定已转 verified：${n}`)
      })
      .catch((e) => console.error('[tick] pending 绑定对账失败:', e))
      .finally(() => {
        reconciling = false
      })
  }
  const reconcileTimer = setInterval(reconcile, 5_000)
  reconcileTimer.unref()
  reconcile()
  app.on('before-quit', () => clearInterval(reconcileTimer))

  // 冷启动纪律：UI 先拿缓存；后台扫完推送给 renderer
  void (async () => {
    try {
      await projectIndex.ready()
      const fresh = await projectIndex.refresh()
      panel?.webContents.send(ProjectsIpc.updated, fresh)
    } catch (e) {
      console.error('[tick] 项目索引首扫失败:', e)
    }
  })()

  panel.on('close', (e) => {
    // 常驻：点关窗只是隐藏；真正退出走 Cmd+Q（before-quit 时 willClose 允许）
    if (!(panel as unknown as { __willClose?: boolean }).__willClose) {
      e.preventDefault()
      panel?.hide()
    }
  })

  // dev 期把 renderer 的 console 转发到终端（否则 UI 报错完全看不见）
  if (!app.isPackaged) {
    panel.webContents.on('console-message', (...args: unknown[]) => {
      console.log('[renderer]', args.slice(1).join(' '))
    })
  }

  // 消灭 devtools 打开的外链窗口逃逸（防 sys-link 劫持；只允许 shell.openExternal 白名单）
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
  // 同窗口导航不受 setWindowOpenHandler 管：location.href 到外站会让 preload API 落进外部页面。
  // 一律拦下；https 交给系统浏览器，其余静默丢弃。
  panel.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
  // renderer 不需要任何 web 权限（通知/摄像头/剪贴板读…）：默认拒绝，收窄 Electron 默认策略
  panel.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  if (app.isPackaged) {
    // 打包后：dist/renderer/index.html（__dirname = app.asar/dist-electron）
    panel.loadFile(path.join(__dirname, '../dist/renderer/index.html'))
  } else {
    // dev：vite dev server（vite-plugin-electron 注入）
    const envPort = process.env.VITE_DEV_SERVER_URL
    if (envPort) {
      panel.loadURL(envPort)
    } else {
      console.error('VITE_DEV_SERVER_URL 不存在；请用 `pnpm dev` 启动')
    }
  }
})

/**
 * 把 create_todo 扩展装进 pi 的自动发现目录（TECH-ARCH §7）。
 * 幂等：内容 hash 没变就完全不动用户的 ~/.pi；变了才写。
 */
function installTickExtension(): void {
  const sources = [
    path.resolve(__dirname, '../../../packages/tick-extension/dist/index.js'), // dev / 同仓
    path.resolve(process.resourcesPath ?? '', 'tick-extension/index.js'), // 打包（M4 extraResources）
  ]
  const src = sources.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (!src) {
    console.warn('[tick] 未找到 tick-extension 产物；create_todo 在 CLI 里不可用（先 pnpm -r build）')
    return
  }

  try {
    const bundle = fs.readFileSync(src)
    const hash = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 16)
    const targetDir = process.env.PI_CODING_AGENT_DIR?.trim()
      ? path.join(process.env.PI_CODING_AGENT_DIR.trim(), 'extensions', 'tick')
      : path.join(os.homedir(), '.pi', 'agent', 'extensions', 'tick')
    const target = path.join(targetDir, 'index.js')
    const stamp = path.join(targetDir, '.installed.json')

    const current = fs.existsSync(stamp)
      ? (JSON.parse(fs.readFileSync(stamp, 'utf8')) as { hash?: string }).hash
      : undefined
    if (current === hash && fs.existsSync(target)) return

    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(target, bundle)
    fs.writeFileSync(stamp, JSON.stringify({ hash, installedAt: new Date().toISOString() }, null, 2))
    console.log(`[tick] tick-extension 已安装到 ${target}`)
  } catch (e) {
    console.error('[tick] tick-extension 安装失败:', e)
  }
}

/**
 * pi extension 直接写 todos.json（PRD §6 规则 3：与 Main 共写同一份）。
 * Main 侧用 fs.watch 感知外部改动并推给 UI，避免面板显示过期列表。
 */
function watchTodosFile(store: TodoStore, dataDir: string): void {
  let timer: NodeJS.Timeout | undefined
  try {
    const watcher = fs.watch(dataDir, (_event, filename) => {
      // macOS 上 filename 可能为 null（目录级事件）：当 todos.json 变化处理，下个事件自愈
      if (filename !== null && filename !== 'todos.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const todos = store.list()
        const openCount = todos.filter((t) => t.status === 'open').length
        applyTodoWindowMetrics(panel, openCount)
        updateTrayTooltip(openCount)
        panel?.webContents.send(TodosIpc.changed, todos)
      }, 150)
    })
    watcher.on('error', (e) => console.error('[tick] todos.json watch 失败:', e))
    app.on('before-quit', () => watcher.close())
  } catch (e) {
    console.error('[tick] 无法监听 data 目录:', e)
  }
}

// 常驻 ≠ 崩溃后僵尸：窗口全关（Cmd+Q 已触发 willClose）且无任务 → 退出
app.on('window-all-closed', () => {
  try {
    const dirs = resolveDirs()
    if (panel) saveWindowState(dirs, panel)
  } catch {
    /* ignore */
  }
  app.quit()
})

app.on('before-quit', (event) => {
  if (panel) (panel as unknown as { __willClose?: boolean }).__willClose = true
  if (quitting || !chat) return
  // durable 的 close 需要 await（否则最后的写入可能没刷完）；带超时兜底，避免退出被卡住
  event.preventDefault()
  quitting = true
  void Promise.race([chat.close(), new Promise((r) => setTimeout(r, 1500))])
    .catch((e) => console.error('[tick] chat 关闭失败:', e))
    .finally(() => app.quit())
})

// durable 稳定运行哨位：不让单次异常拖垮常驻面板
process.on('uncaughtException', (err) => {
  console.error('[tick] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[tick] unhandledRejection:', reason)
})
