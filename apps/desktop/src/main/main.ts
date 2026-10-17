/**
 * main — 应用入口。
 *
 * 启动顺序：resolveDirs → ensureDirs（0700）→ TodoStore → 装配 adapter/索引/拉起/面板对话
 *          → 窗口（记忆位）→ IPC → 载入 UI。
 * 常驻语义：关窗 = 隐藏（app 不退）；Cmd+Q 退出。
 */

import { app, BrowserWindow, clipboard, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ChatIpc, ProjectsIpc, TodosIpc } from '@tick/shared'
import { AiToolRegistry } from '@tick/ai-core'
import { PiAdapter } from '@tick/ai-pi'
import { ensureDirs, resolveDirs } from './services/storage'
import { ProjectIndexService } from './services/project-index'
import { ChatAgentHost } from './services/chat-host'
import { LaunchService } from './services/launch'
import { TodoStore } from './store'
import { createPanelWindow, installAppMenu, saveWindowState } from './window'
import { registerIpc } from './ipc'

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

app.on('second-instance', () => {
  if (panel) {
    if (panel.isMinimized()) panel.restore()
    panel.show()
    panel.focus()
  }
})

app.whenReady().then(() => {
  const dirs = resolveDirs()
  ensureDirs(dirs)

  const store = new TodoStore(path.join(dirs.data, 'todos.json'))
  store.ensureFile()

  // ---------- adapter 注册表（M1） ----------
  const registry = new AiToolRegistry()
  const pi = new PiAdapter({
    clipboardWrite: (text) => clipboard.writeText(text), // 剪贴板投递出口（ai 包不依赖 Electron）
  })
  registry.register(pi)

  // 跨工具时钟：todos.lastLaunch{projectPath} → 路径 → 最近拉起时间
  const launchClock = (): Map<string, number> => {
    const map = new Map<string, number>()
    for (const t of store.list()) {
      if (!t.lastLaunch) continue
      const ms = Date.parse(t.updatedAt)
      const prev = map.get(t.lastLaunch.projectPath)
      if (prev === undefined || ms > prev) map.set(t.lastLaunch.projectPath, ms)
    }
    return map
  }
  const projectIndex = new ProjectIndexService(pi, path.join(dirs.cache, 'projects.json'), {
    launchClock,
  })
  const launchService = new LaunchService(pi, store)

  panel = createPanelWindow(dirs)
  installAppMenu(panel)
  registerIpc(store, { panel: () => panel }, { projectIndex, launch: launchService, chat: () => chat }, registry.list())

  // ---------- M2：pi extension 安装 + 面板 Chat ----------
  installTickExtension()
  watchTodosFile(store, dirs.data)

  chat = new ChatAgentHost({
    storageDir: dirs.panelChat,
    onState: (state) => panel?.webContents.send(ChatIpc.updated, state),
  })
  void chat.init()

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
    // 打包后：dist/renderer/index.html
    panel.loadFile(path.join(__dirname, '../renderer/index.html'))
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
        panel?.webContents.send(TodosIpc.changed, store.list())
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

app.on('before-quit', () => {
  if (panel) (panel as unknown as { __willClose?: boolean }).__willClose = true
  void chat?.close()
})

// durable 稳定运行哨位：不让单次异常拖垮常驻面板
process.on('uncaughtException', (err) => {
  console.error('[tick] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[tick] unhandledRejection:', reason)
})
