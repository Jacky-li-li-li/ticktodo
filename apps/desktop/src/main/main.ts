/**
 * main — 应用入口（M0）。
 *
 * 启动顺序：resolveDirs → ensureDirs（0700）→ TodoStore 就绪 → 窗口（记忆位）→ IPC → 载入 UI。
 * 常驻语义：关窗 = 隐藏（app 不退）；Cmd+Q 退出。DPI/多屏修正随 M3 的\"位置记忆\"细化。
 */

import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import { ensureDirs, resolveDirs } from './services/storage'
import { TodoStore } from './store'
import { createPanelWindow, installAppMenu, saveWindowState } from './window'
import { registerIpc } from './ipc'

// 单实例：面板是常驻窗，二次拉起（install.sh/dock 双击）应聚焦已有实例
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let panel: BrowserWindow | null = null

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

  panel = createPanelWindow(dirs)
  installAppMenu(panel)
  registerIpc(store, { panel: () => panel })

  panel.on('close', (e) => {
    // 常驻：点关窗只是隐藏；真正退出走 Cmd+Q（before-quit 时 willClose 允许）
    if (!(panel as unknown as { __willClose?: boolean }).__willClose) {
      e.preventDefault()
      panel?.hide()
    }
  })

  // 消灭 devtools 打开的外链窗口逃逸（防 sys-link 劫持；M0 只允许 shell.openExternal 白名单）
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

// 常驻 ≠ 崩溃后僵尸：窗口全关（Cmd+Q 已触发 willClose）且无任务 → 退出
app.on('window-all-closed', () => {
  // 保存最终窗口几何（主进程侧兜底，Renderer 侧的 moved/resized 已实时存过）
  try {
    const dirs = resolveDirs()
    if (panel) saveWindowState(dirs, panel)
  } catch {
    /* ignore */
  }
  // macOS 习惯是保留 dock 活性；常驻面板本就常驻，直接退出即可（用户可再启动）
  app.quit()
})

app.on('before-quit', () => {
  if (panel) (panel as unknown as { __willClose?: boolean }).__willClose = true
})

// fs.watch 域外的兜底：捕获 uncaught，为 M2 的 durable 稳定运行留哨位
process.on('uncaughtException', (err) => {
  console.error('[tick] uncaughtException:', err)
})
