/**
 * ipc — Main 侧 handler 装配（TECH-ARCH §3 信任边界：Renderer 无 Node，全走显式通道）。
 * 通道常量来自 @tick/shared（main/preload/renderer 引用同一份，防漂移）。
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import type { Todo, TodoCreateInput, TodoPatch } from '@tick/shared'
import { TodosIpc, WindowIpc } from '@tick/shared'
import type { TodoStore } from './store'

export interface IpcWindows {
  panel: () => BrowserWindow | null
}

export function registerIpc(store: TodoStore, windows: IpcWindows): void {
  ipcMain.handle(TodosIpc.list, (): Todo[] => store.list())

  ipcMain.handle(TodosIpc.create, (_e, input: TodoCreateInput): Todo => {
    return store.create(input)
  })

  ipcMain.handle(TodosIpc.update, (_e, args: { id: string; patch: TodoPatch }): Todo => {
    return store.update(args.id, args.patch)
  })

  ipcMain.handle(TodosIpc.remove, (_e, id: string): void => {
    store.remove(id)
  })

  // 常驻语义：隐藏 ≠ 销毁；退出走 Cmd+Q / dock quit
  ipcMain.on(WindowIpc.hide, () => windows.panel()?.hide())
  ipcMain.on(WindowIpc.quit, () => app.quit())
}
