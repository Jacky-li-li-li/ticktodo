/**
 * Toast — 顶部吞噬式反馈（§3.5）：
 * 绝对定位覆盖捕获行（top 43 / left 14 / 最小高 46 / 圆角 16），短提示 3s、长文案 5s
 * （时长由 App.showToast 按文案长度决定），不占布局空间。
 * 文案最多两行（`.toast-text` 的 line-clamp）：adapter 的 notice 可能较长且尾部是关键指引
 * （「请在会话列表里选择…」/「⌘V 再回车」），单行省略号会把它吃掉。
 * R2 归档反馈：语义色 Success 底 + 右侧「撤销」；纯提示（拉起结果）不带按钮。
 */

import React from 'react'

export function Toast({ text, onUndo }: { text: string; onUndo?: () => void }): React.JSX.Element {
  return (
    <div className="toast" role="status">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <circle cx="6.5" cy="6.5" r="6.5" fill="#34C759" />
        <path d="M4 6.7L5.8 8.5L9 4.6" stroke="white" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="toast-text">{text}</span>
      {onUndo && (
        <button className="undo" onClick={onUndo}>
          撤销
        </button>
      )}
    </div>
  )
}
