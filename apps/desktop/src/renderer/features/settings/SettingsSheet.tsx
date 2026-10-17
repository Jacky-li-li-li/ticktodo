/**
 * SettingsSheet — 设置（PRD F4-b：投递方式 / 默认项目；F6-b：用量开关；M3 尾巴：自配 provider）。
 *
 * 保持当前面板的 sheet 形态；点击即保存（main 落 data/settings.json）。
 * 自配 provider 是唯一带表单的区域（key 不进 settings，见 ProviderSettings）。
 */

import React from 'react'
import type { AppSettings } from '@tick/shared'
import { ProviderSettings } from './ProviderSettings'

export function SettingsSheet({
  settings,
  onChange,
  onClose,
  onToast,
}: {
  settings: AppSettings
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
  onToast: (text: string) => void
}): React.JSX.Element {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">设置</span>
          <button className="sheet-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="sheet-section-title">拉起时的投递方式</div>
        <div className="sheet-row deliver">
          <div className="segmented">
            <button
              className={settings.deliver === 'clipboard' ? 'on' : ''}
              onClick={() => onChange({ deliver: 'clipboard' })}
            >
              复制文案
            </button>
            <button
              className={settings.deliver === 'argv' ? 'on' : ''}
              onClick={() => onChange({ deliver: 'argv' })}
            >
              直接发送
            </button>
          </div>
        </div>
        <div className="sheet-note">默认复制到剪贴板，由你审阅后再发；「直接发送」= 启动即发。</div>

        <div className="sheet-section-title">默认项目</div>
        <div className="sheet-row deliver">
          <div className="segmented">
            <button
              className={settings.defaultProject === 'home' ? 'on' : ''}
              onClick={() => onChange({ defaultProject: 'home' })}
            >
              主目录 ~
            </button>
            <button
              className={settings.defaultProject === 'recent' ? 'on' : ''}
              onClick={() => onChange({ defaultProject: 'recent' })}
            >
              最近使用
            </button>
            <button
              className={settings.defaultProject === 'ask' ? 'on' : ''}
              onClick={() => onChange({ defaultProject: 'ask' })}
            >
              每次必问
            </button>
          </div>
        </div>
        <div className="sheet-note">
          默认「主目录 ~」是确定兜底，不猜；想跟随最近使用的项目就切「最近使用」；不信任默认值就「每次必问」。
        </div>

        <div className="sheet-section-title">用量统计</div>
        <div className="sheet-row deliver">
          <div className="segmented">
            <button
              className={!settings.usageEnabled ? 'on' : ''}
              onClick={() => onChange({ usageEnabled: false })}
            >
              关
            </button>
            <button
              className={settings.usageEnabled ? 'on' : ''}
              onClick={() => onChange({ usageEnabled: true })}
            >
              开
            </button>
          </div>
        </div>
        <div className="sheet-note">
          只统计 pi CLI 会话（默认关）。面板 Chat 不计入；成本以 provider 上报为准，未上报时标注「≥」。
        </div>

        <div className="sheet-section-title">面板对话 Provider</div>
        <ProviderSettings config={settings.customProvider ?? null} onToast={onToast} />

        <div className="sheet-section-title">数据与快捷键</div>
        <button
          className="sheet-row"
          onClick={() => {
            void window.tick.settings.openDataDir()
            onToast('已打开数据目录（只同步 data/ 即可）')
          }}
        >
          <span className="label">数据目录</span>
          <span className="value">打开 ~/.ticktodo</span>
        </button>
        <div className="sheet-note">
          显隐面板：⌘⌥T · 新建线索：⌘⌥N · 关闭窗口只是隐藏，⌘Q 退出
        </div>
      </div>
    </div>
  )
}
