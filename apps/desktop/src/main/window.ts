/**
 * WindowManager — 置顶悬浮面板（M0）。
 *
 * UI-SPEC / PRD 落点：
 *  - 无边框置顶窗，默认 360×520；只保留最小宽度 320，最小高度由 main 按 open todo 数
 *    （最多默认展示 5 条）动态设置；无最大尺寸，用户拖拽后记住尺寸；
 *  - 贴屏幕右上角常驻，避菜单栏，距边 16px；位置记忆（首帧不等扫描，无状态则落在默认位）；
 *  - 暗色玻璃：vibrancy under-window + 半透明底（材质层由 Renderer CSS 落 UI-SPEC §3.1）；
 *  - 位置/尺寸属机器本地的「偏好」，放 cache/window-state.json（可再生层，丢了只是回默认位），
 *    之所以不放 data/：data 是「可同步」层，跨机器不该漫游窗口几何。
 */

import { app, BrowserWindow, Menu, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { TickDirs } from './services/storage'
import { readJson } from './services/storage'

export const DEFAULT_W = 360
export const DEFAULT_H = 520
/** 只保留最小宽度；高度由 main 按「最多 5 条 open todo」动态设置 minimumSize */
export const MIN_W = 320
const MIN_H = 220
const EDGE = 16

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  /** 置顶开关：true = alwaysOnTop；false = 失焦自动隐藏 */
  pinned?: boolean
}

/** 当前窗口的置顶状态（单面板应用） */
let pinnedState = true
/** 打开系统目录选择器 / 鼠标在 Tray 上时临时禁止失焦隐藏 */
let blurHideSuppressed = false

function stateFile(dirs: TickDirs): string {
  return path.join(dirs.cache, 'window-state.json')
}

export function loadWindowState(dirs: TickDirs): WindowState {
  const s = readJson<WindowState>(stateFile(dirs))
  return {
    width: Math.max(MIN_W, s?.width ?? DEFAULT_W),
    height: Math.max(MIN_H, s?.height ?? DEFAULT_H),
    x: s?.x,
    y: s?.y,
    pinned: s?.pinned ?? true,
  }
}

export function saveWindowState(dirs: TickDirs, win: BrowserWindow): void {
  const b = win.getBounds()
  const state: WindowState = {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    pinned: pinnedState,
  }
  try {
    fs.mkdirSync(dirs.cache, { recursive: true, mode: 0o700 })
    fs.writeFileSync(stateFile(dirs), JSON.stringify(state))
  } catch {
    /* 位置记忆失败不致命 */
  }
}

export function getPanelPinned(): boolean {
  return pinnedState
}

/** 切换置顶：开 = floating 置顶；关 = 普通层级，且失焦自动隐藏 */
export function setPanelPinned(dirs: TickDirs, win: BrowserWindow, pinned: boolean): boolean {
  pinnedState = Boolean(pinned)
  if (pinnedState) win.setAlwaysOnTop(true, 'floating')
  else win.setAlwaysOnTop(false)
  saveWindowState(dirs, win)
  return pinnedState
}

export function setBlurHideSuppressed(value: boolean): void {
  blurHideSuppressed = value
}

export function createPanelWindow(dirs: TickDirs): BrowserWindow {
  const state = loadWindowState(dirs)
  pinnedState = state.pinned ?? true
  const primary = screen.getPrimaryDisplay()
  const wa = primary.workArea

  // 无记忆时的默认位：右上角，避菜单栏 + 距边 16
  const defaultX = wa.x + wa.width - state.width - EDGE
  const defaultY = wa.y + EDGE
  const x = state.x === undefined ? defaultX : state.x
  const y = state.y === undefined ? defaultY : state.y

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x,
    y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    useContentSize: true,
    // 圆角与毛玻璃的取舍（macOS）：
    // Electron 44 的 UpdateVibrancyRadii() 只在窗口保留 NSWindowStyleMaskTitled 时才给
    // NSVisualEffectView 应用 9px 圆角 mask；frame:false 会丢 titled style，vibrancy 层
    // 保持方形，从面板圆角外露出浅色方角。这里改成 frame:true + 隐藏标题栏，
    // 保留 titled style 让原生 vibrant mask 生效，再用 setWindowButtonVisibility(false)
    // 隐藏红绿灯，外观仍是无边框面板。CSS 外圆角同步为 --r-window: 10px（styles.css）。
    frame: true,
    titleBarStyle: 'hidden',
    // macOS 暗色玻璃底（Engineer 注：配套 CSS 半透明底，见 Renderer styles.css）
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: state.pinned,
    skipTaskbar: true,
    show: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: app.isPackaged ? false : true,
    },
  })

  // 隐藏原生红绿灯：frame:true 只为保留 titled style（vibrancy 圆角 mask 的前提），
  // 视觉上仍然是一个无边框面板。
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)

  // 置顶不抢其它 app 的 key 窗口地位（\"不夺焦\"原则：唤起不改变前台激活状态）。
  // level 选 floating；面板要接收输入，不能 nonactivatable，但不要抢成 main。
  win.setAlwaysOnTop(state.pinned ?? true, 'floating')

  // 取消置顶后：点到其它 app / 桌面（失焦）立即收起。
  // Tray 的 mouse-enter/mouse-leave 会临时 suppress，避免「点菜单栏先被 blur 隐藏、
  // 又被 click 重新显示」的竞态；不再用延迟 hide，避免窗口先掉到底层再消失的顿挫。
  win.on('blur', () => {
    if (pinnedState || blurHideSuppressed || win.isDestroyed()) return
    if (!app.isPackaged && win.webContents.isDevToolsFocused()) return
    if (win.isVisible()) win.hide()
  })

  // 위치/尺寸记忆：moved 与 resized 都落盘（debounce 不做，M0 简化）
  win.on('moved', () => saveWindowState(dirs, win))
  win.on('resized', () => saveWindowState(dirs, win))

  return win
}

export function installAppMenu(win: BrowserWindow): void {
  // M0 最小菜单（暂不引外部菜单模块，保持单文件可读性）：Cmd+Q 退、Cmd+W 只隐藏不销毁（常驻语义）
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '隐藏面板', accelerator: 'CmdOrCtrl+W', click: () => win.hide() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
