/**
 * 运行期配置：数据根、只读、扫描开关。
 *
 * 开关来源与优先级（`docs/mcp-tools-spec.md` §1.8）：
 *   - 只读：`TICK_MCP_READONLY=1` > settings.json 的 `mcpReadOnly:true`
 *   - 扫描：`TICK_MCP_SCAN=0` / `=1` > settings.json 的 `mcpScan:false`
 * 每次工具调用都重新读 settings：用户可能在 Tick 里刚改过开关，不缓存。
 * settings.json 损坏时按「没有设置」处理（不要为了 MCP 去动用户配置）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { openTodoStore, resolveTickHome, todosFilePath, type TodoStoreCore } from '@tick/todo-core'

export interface RuntimeFlags {
  readonly: boolean
  scanEnabled: boolean
}

export interface McpRuntime {
  home: string
  store: TodoStoreCore
  flags(): RuntimeFlags
}

export function settingsPath(home: string): string {
  return path.join(home, 'data', 'settings.json')
}

function readSettings(home: string): Record<string, unknown> {
  const file = settingsPath(home)
  try {
    if (!fs.existsSync(file)) return {}
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Tick 的 SettingsStore 写的是 {version, settings:{...}}；也兼容直接把开关写在顶层
    // 的旧/手工文件（spec §1.8）。绝不把坏配置回写。
    const record = parsed as Record<string, unknown>
    const nested = record.settings
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested as Record<string, unknown>
    }
    return record
  } catch {
    // 配置坏掉是 Tick 自己的问题；MCP 不回写、不备份，按默认值继续
    return {}
  }
}

export function resolveFlags(home: string): RuntimeFlags {
  const settings = readSettings(home)

  const envReadonly = (process.env.TICK_MCP_READONLY ?? '').trim()
  const readonly =
    envReadonly === '1' ? true : envReadonly === '0' ? false : settings.mcpReadOnly === true

  const envScan = (process.env.TICK_MCP_SCAN ?? '').trim()
  const scanEnabled = envScan === '0' ? false : envScan === '1' ? true : settings.mcpScan !== false

  return { readonly, scanEnabled }
}

/**
 * 打开运行时。写路径必须 `onCorrupt:'throw'`：agent 会重试，空表覆盖等于数据事故。
 * 读路径（list）用同一个 store：spec 要求「只读也不覆盖」，throw 正好不落盘。
 */
export function openRuntime(): McpRuntime {
  const home = resolveTickHome()
  const store = openTodoStore({ file: todosFilePath(home), onCorrupt: 'throw' })
  return {
    home,
    store,
    flags: () => resolveFlags(home),
  }
}
