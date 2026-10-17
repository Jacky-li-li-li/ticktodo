/**
 * WindowManager — 置顶悬浮面板（M0）。
 *
 * UI-SPEC / PRD 落点：
 *  - 无边框置顶窗，默认 360×520，min 320×420 / max 480×720，用户拖右下角可改，记住尺寸；
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

const DEFAULT_W = 360
const DEFAULT_H = 520
const MIN_W = 320
const MIN_H = 420
const MAX_W = 480
const MAX_H = 720
const EDGE = 16

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
}

function stateFile(dirs: TickDirs): string {
  return path.join(dirs.cache, 'window-state.json')
}

export function loadWindowState(dirs: TickDirs): WindowState {
  const s = readJson<WindowState>(stateFile(dirs))
  return {
    width: clamp(s?.width ?? DEFAULT_W, MIN_W, MAX_W),
    height: clamp(s?.height ?? DEFAULT_H, MIN_H, MAX_H),
    x: s?.x,
    y: s?.y,
  }
}

export function saveWindowState(dirs: TickDirs, win: BrowserWindow): void {
  const b = win.getBounds()
  const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height }
  try {
    fs.mkdirSync(dirs.cache, { recursive: true, mode: 0o700 })
    fs.writeFileSync(stateFile(dirs), JSON.stringify(state))
  } catch {
    /* 位置记忆失败不致命 */
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function createPanelWindow(dirs: TickDirs): BrowserWindow {
  const state = loadWindowState(dirs)
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
    maxWidth: MAX_W,
    maxHeight: MAX_H,
    useContentSize: true,
    frame: false,
    titleBarStyle: 'hidden',
    // macOS 暗色玻璃底（Engineer 注：配套 CSS 半透明底，见 Renderer styles.css）
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: false,
    hasShadow: true,
    resizable: true,
    fullscreenable: false,
    alwaysOnTop: true,
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

  // 置顶不抢其它 app 的 key 窗口地位（\"不夺焦\"原则：唤起不改变前台激活状态）。
  // level 选 floating；面板要接收输入，不能 nonactivatable，但不要抢成 main。
  win.setAlwaysOnTop(true, 'floating')

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
