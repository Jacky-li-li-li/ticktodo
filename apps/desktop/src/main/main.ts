/**
 * main — 应用入口。
 *
 * 启动顺序：resolveDirs → ensureDirs（0700）→ TodoStore → 装配 adapter/索引/拉起/面板对话
 *          → 窗口（记忆位）→ IPC → 载入 UI。
 * 常驻语义：关窗 = 隐藏（app 不退）；Cmd+Q 退出。
 */

import { app, BrowserWindow, clipboard, globalShortcut, Menu, nativeImage, shell, Tray } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ChatIpc, ProjectsIpc, TodosIpc, WindowIpc } from '@tick/shared'
import { AiToolRegistry, canonicalPath, gitRootOf } from '@tick/ai-core'
import { PiAdapter } from '@tick/ai-pi'
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
import { cleanupLaunchCache, createTerminalLauncher } from './services/terminal-launch'
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
 * - 每条线索行 44，content 子元素 gap 2；默认最多展示 5 条
 */
const PANEL_CHROME_H = 126
const ROW_H = 44
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

  const store = new TodoStore(path.join(dirs.data, 'todos.json'))
  store.ensureFile()
  const settingsStore = new SettingsStore(path.join(dirs.data, 'settings.json'))
  const credentialVault = new CredentialVault(app.getPath('userData'))
  const providerConfig = new ProviderConfigService(settingsStore, credentialVault)

  // ---------- adapter 注册表（M1；M5 起多工具） ----------
  const registry = new AiToolRegistry()
  const pi = new PiAdapter({
    clipboardWrite: (text) => clipboard.writeText(text), // 剪贴板投递出口（ai 包不依赖 Electron）
    // 交互式 pi 必须开在终端里（非 TTY 会降级成 headless print 模式）
    openTerminal: createTerminalLauncher(path.join(dirs.cache, 'launch')),
    // 预填投递：一次性 prompt 文件交给 pi 扩展（session_start 读取后删除）
    prefillDir: path.join(dirs.cache, 'launch'),
  })
  registry.register(pi)

  // 桌面工具的深链接出口：用 shell.openExternal，并把异常原样向上抛给 adapter → LaunchService 转成
  // 可读的 reason（`open` 恒 exit 0，不能靠返回值判断成败，所以只能靠 Promise 拒绝表达失败）。
  const openUrl = (url: string): Promise<void> => shell.openExternal(url)
  // 桌面适配器的日志出口按 (key, message) 约定收口，文案不含会话正文/标题
  const logDesktopTool = (key: string, message: string): void => console.warn(`[tick] ${key}:`, message)
  // 国内版 / 国际版是**两个独立工具**（各自数据根、App bundle、scheme、toolId），不通过切换根目录复用
  const workbuddy = new WorkbuddyAdapter({ openUrl, log: logDesktopTool })
  const workbuddyAi = new WorkbuddyAiAdapter({ openUrl, log: logDesktopTool })
  registry.register(workbuddy)
  registry.register(workbuddyAi)

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
  const sessionService = new SessionService(adapters, store)
  const exportService = new ExportService(adapters, store, () => settingsStore.get(), dirs.exports)
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

  const reloadChat = async (): Promise<void> => {
    const old = chat
    chat = undefined
    await old?.close()
    chat = createChat()
    await chat.init()
  }

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
    },
    adapters,
  )

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
    const trayMenu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏面板', click: () => togglePanel() },
      { label: '新建线索', click: () => newTodo() },
      { type: 'separator' },
      { label: '退出 Ticktodo', click: () => app.quit() },
    ])
    // 左键切换面板；右键弹菜单（不把左键变成菜单，保持“点一下显隐”的直觉）。
    // 鼠标在 Tray 上时抑制「失焦自动隐藏」：否则点菜单栏会先 blur 隐藏、再被 click 显示。
    tray.on('mouse-enter', () => setBlurHideSuppressed(true))
    tray.on('mouse-leave', () => setBlurHideSuppressed(false))
    tray.on('click', () => togglePanel())
    tray.on('right-click', () => {
      setBlurHideSuppressed(true)
      trayMenu.once('menu-will-close', () => setBlurHideSuppressed(false))
      tray?.popUpContextMenu(trayMenu)
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
      if (filename !== 'todos.json') return
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

let quitting = false
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
