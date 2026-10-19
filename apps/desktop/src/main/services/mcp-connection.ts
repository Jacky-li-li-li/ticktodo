/**
 * McpConnectionService — 给「Agent 连接」设置页算 MCP 入口与配置片段。
 *
 * 为什么在主进程算：普通用户不应被要求知道仓库路径/Node 路径；打包版直接指向
 * `Resources/mcp/tick-mcp.sh`，开发版才退化为 `node dist/tick-mcp.mjs`。
 *
 * 只读计算，不写任何客户端配置（spec §9.3：先给复制片段，自动写配置留到后续）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { McpConnectionInfo } from '@tick/shared'

export interface McpConnectionDeps {
  isPackaged: boolean
  /** Electron `process.resourcesPath` */
  resourcesPath: string
  /** 仓库根（仅开发模式用） */
  repoRoot: string
  /** 开发模式可覆盖 node 路径；缺省 `node` */
  nodePath?: string
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** POSIX shell 单引号转义（路径可能含空格/引号） */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function build(
  mode: 'app' | 'dev',
  command: string,
  args: string[],
): McpConnectionInfo {
  const shell = [command, ...args].map(shellQuote).join(' ')
  const jsonConfig = JSON.stringify(
    { mcpServers: { tick: { command, args } } },
    null,
    2,
  )
  return {
    available: true,
    mode,
    command,
    args,
    displayCommand: shell,
    piCommand: `pi mcp add tick --exposure direct -- ${shell}`,
    claudeCommand: `claude mcp add --scope user tick -- ${shell}`,
    jsonConfig,
    note:
      mode === 'app'
        ? 'Tick 安装包内置入口；配置一次即可，不需要 Tick 常驻运行。'
        : '开发模式：使用仓库里的 server 构建产物（需要 Node 22+）；普通用户请安装 Tick。',
  }
}

export class McpConnectionService {
  constructor(private readonly deps: McpConnectionDeps) {}

  get(): McpConnectionInfo {
    if (this.deps.isPackaged) {
      const shim = path.join(this.deps.resourcesPath, 'mcp', 'tick-mcp.sh')
      if (exists(shim)) return build('app', shim, [])
      return {
        available: false,
        mode: 'missing',
        note: '安装包缺少 Resources/mcp/tick-mcp.sh；请重新安装 Tick。',
      }
    }

    const dist = path.join(this.deps.repoRoot, 'packages', 'mcp-server', 'dist', 'tick-mcp.mjs')
    if (exists(dist)) {
      return build('dev', this.deps.nodePath ?? process.env.TICK_MCP_NODE ?? 'node', [dist])
    }
    return {
      available: false,
      mode: 'missing',
      note: '开发模式还没构建 MCP server：先运行 pnpm mcp:build。',
    }
  }
}
