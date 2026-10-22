/**
 * UpdateSettings：设置页的「应用更新」区块。
 *
 * 口径：
 *  - main 是唯一状态源；这里只把 UpdateState 映射成文案 + 一个动作，不做状态迁移；
 *  - 能力判定（dev/未签名/缺 feed/从 DMG 运行）全部在 main 完成，UI 只如实显示原因；
 *  - 「自动检查」只是偏好，关掉后手动检查仍可用；下载完成后的普通退出也会安装。
 */

import React, { useEffect, useState } from 'react'
import type { AppSettings, UpdateState } from '@tick/shared'
import { useUpdate } from '../../app/useUpdate'

type UpdateAction = {
  kind: 'check' | 'download' | 'install'
  label: string
  disabled?: boolean
  variant: 'primary' | 'secondary'
}

function describeUpdate(
  state: UpdateState | null,
  installing: boolean,
): { text: string; tone: '' | 'ok' | 'bad'; action?: UpdateAction } {
  if (!state) return { text: '正在读取版本…', tone: '' }

  switch (state.phase) {
    case 'idle':
      return {
        text: `当前 v${state.currentVersion}`,
        tone: '',
        action: { kind: 'check', label: '检查更新', variant: 'primary' },
      }
    case 'checking':
      return {
        text: state.trigger === 'auto' ? '正在自动检查更新…' : '正在检查更新…',
        tone: '',
        action: { kind: 'check', label: '检查中…', disabled: true, variant: 'primary' },
      }
    case 'available':
      return {
        text: `发现新版本 v${state.version}（当前 v${state.currentVersion}）`,
        tone: '',
        action: { kind: 'download', label: `下载 v${state.version}`, variant: 'primary' },
      }
    case 'downloading':
      return {
        text: `正在下载 v${state.version} · ${state.percent}%`,
        tone: '',
        action: {
          kind: 'download',
          label: `下载中 ${state.percent}%`,
          disabled: true,
          variant: 'primary',
        },
      }
    case 'ready':
      // 安装失败时包已经下好了：保留 ready，原地重试安装，不要退回「检查更新」
      if (state.installError) {
        return {
          text: `v${state.version} 已下载，但${state.installError}`,
          tone: 'bad',
          action: {
            kind: 'install',
            label: installing ? '正在重启…' : '重试安装',
            disabled: installing,
            variant: 'primary',
          },
        }
      }
      return {
        text: `v${state.version} 已下载，重启后完成安装`,
        tone: 'ok',
        action: {
          kind: 'install',
          label: installing ? '正在重启…' : '重启并更新',
          disabled: installing,
          variant: 'primary',
        },
      }
    case 'up-to-date':
      return {
        text: `已是最新版本 v${state.currentVersion}`,
        tone: 'ok',
        action: { kind: 'check', label: '重新检查', variant: 'secondary' },
      }
    case 'unsupported':
      // dev / 未签名 / 缺 feed / 从 DMG 运行：只说明原因，不给无效按钮
      return { text: state.message, tone: '' }
    case 'error':
      if (state.scope === 'download' && state.version !== undefined) {
        return {
          text: state.message,
          tone: 'bad',
          action: { kind: 'download', label: '重试下载', variant: 'primary' },
        }
      }
      return {
        text: state.message,
        tone: 'bad',
        action: state.retryable
          ? { kind: 'check', label: '重试检查', variant: 'primary' }
          : undefined,
      }
  }
}

export function UpdateSettings({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
}): React.JSX.Element {
  const { state, check, download, install } = useUpdate()
  const [installing, setInstalling] = useState(false)

  // 安装失败时 main 会推回 ready + installError；这里解除本地 busy，允许重试。
  // 安装进行中收到 install-started（清掉旧 installError）不能把按钮重新点亮。
  useEffect(() => {
    if (state?.phase !== 'ready' || state.installError) setInstalling(false)
  }, [state])

  const described = describeUpdate(state, installing)
  const action = described.action

  const run = (next: UpdateAction): void => {
    if (next.disabled) return
    if (next.kind === 'check') {
      // IPC 断开时保留旧状态，不把 UI 清空；main 仍是错误状态的权威源
      void check().catch(() => {})
      return
    }
    if (next.kind === 'download') {
      void download().catch(() => {})
      return
    }
    setInstalling(true)
    void install().catch(() => setInstalling(false))
  }

  return (
    <>
      <div className="sheet-section-title">应用更新</div>
      <div className="provider-form">
        <div className={`provider-status${described.tone ? ` ${described.tone}` : ''}`}>
          {described.text}
        </div>

        {action && (
          <div className="provider-actions">
            <button
              className={`pill ${action.variant}`}
              disabled={action.disabled}
              onClick={() => run(action)}
            >
              {action.label}
            </button>
          </div>
        )}

        <div className="sheet-row deliver">
          <span className="label">自动检查</span>
          <div className="segmented">
            <button
              className={settings.autoUpdateCheck === false ? 'on' : ''}
              onClick={() => onChange({ autoUpdateCheck: false })}
            >
              关
            </button>
            <button
              className={settings.autoUpdateCheck !== false ? 'on' : ''}
              onClick={() => onChange({ autoUpdateCheck: true })}
            >
              开
            </button>
          </div>
        </div>

        <div className="sheet-note">
          下载完成后，直接退出 Tick 也会安装；下次启动即为新版本。关闭自动检查只停止后台检查，手动检查仍可用。
        </div>
      </div>
    </>
  )
}
