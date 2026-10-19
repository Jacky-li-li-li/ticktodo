/**
 * McpSettings — 普通用户的「Agent 连接」区。
 *
 * 只做两件事：告诉用户本机 MCP 入口是否就绪，并给出可直接粘贴的客户端配置。
 * 不自动写 agent 配置（避免抢用户全局配置）；不把路径/命令写进 settings。
 */

import React, { useEffect, useState } from 'react'
import type { AppSettings, McpConnectionInfo } from '@tick/shared'

function CommandRow({
  label,
  value,
  multiline = false,
  onCopy,
}: {
  label: string
  value: string
  multiline?: boolean
  onCopy: (label: string, text: string) => void
}): React.JSX.Element {
  return (
    <div className="mcp-command">
      <div className="mcp-command-head">
        <span className="mcp-command-label">{label}</span>
        <button className="mcp-copy" onClick={() => onCopy(label, value)}>
          复制
        </button>
      </div>
      <pre className={`mcp-code${multiline ? ' multiline' : ''}`}>{value}</pre>
    </div>
  )
}

export function McpSettings({
  settings,
  onChange,
  onToast,
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onToast: (text: string) => void
}): React.JSX.Element {
  const [info, setInfo] = useState<McpConnectionInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.tick.mcp
      .info()
      .then((next) => {
        if (alive) setInfo(next)
      })
      .catch((e: unknown) => {
        if (alive) {
          setInfo({
            available: false,
            mode: 'missing',
            note: `读取 MCP 入口失败：${e instanceof Error ? e.message : String(e)}`,
          })
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await window.tick.mcp.copy(text)
      onToast(`已复制${label}`)
    } catch (e) {
      onToast(`复制失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const readOnly = settings.mcpReadOnly === true
  const scan = settings.mcpScan !== false

  return (
    <>
      <div className="sheet-section-title">Agent 连接（MCP）</div>
      <div className={`mcp-status ${info?.available ? 'ok' : 'bad'}`}>
        {info === null
          ? '正在读取本机 MCP 入口…'
          : info.available
            ? info.mode === 'app'
              ? '已就绪：使用 Tick 安装包内的本地入口'
              : '已就绪：使用仓库内构建的 MCP server（开发模式）'
            : info.note ?? 'MCP 入口不可用'}
      </div>
      {info?.available && info.note && <div className="sheet-note">{info.note}</div>}

      {info?.available && (
        <>
          <div className="sheet-note">
            复制其中一条到对应的 agent 里执行；配置一次即可，Tick 不需要常驻运行。pi 必须加
            <code> --exposure direct</code>，否则工具会藏在 codemode 里。
          </div>
          <CommandRow
            label="pi"
            value={info.piCommand ?? ''}
            onCopy={(label, text) => void copy(label, text)}
          />
          <CommandRow
            label="Claude Code"
            value={info.claudeCommand ?? ''}
            onCopy={(label, text) => void copy(label, text)}
          />
          <CommandRow
            label="通用 JSON（Cursor / Claude Desktop 等）"
            value={info.jsonConfig ?? ''}
            multiline
            onCopy={(label, text) => void copy(label, text)}
          />
          <div className="sheet-note">
            其他客户端把上面的 JSON 放进各自的 mcpServers 配置即可。WorkBuddy 的 MCP 入口仍需真机确认。
          </div>
        </>
      )}

      <div className="sheet-section-title">MCP 行为</div>
      <div className="sheet-row deliver">
        <div className="segmented">
          <button className={!readOnly ? 'on' : ''} onClick={() => onChange({ mcpReadOnly: false })}>
            可写
          </button>
          <button className={readOnly ? 'on' : ''} onClick={() => onChange({ mcpReadOnly: true })}>
            只读
          </button>
        </div>
      </div>
      <div className="sheet-note">
        只读时 agent 只能查线索，不能创建/关联；适合先观察。修改后下一次工具调用生效。
      </div>

      <div className="sheet-row deliver">
        <div className="segmented">
          <button className={scan ? 'on' : ''} onClick={() => onChange({ mcpScan: true })}>
            自动关联会话
          </button>
          <button className={!scan ? 'on' : ''} onClick={() => onChange({ mcpScan: false })}>
            关闭扫描
          </button>
        </div>
      </div>
      <div className="sheet-note">
        开启时 server 只在本机会话文件里做句柄字面量匹配，用于把线索关联到当前对话；关闭后新线索只记录、不关联。
      </div>
    </>
  )
}
