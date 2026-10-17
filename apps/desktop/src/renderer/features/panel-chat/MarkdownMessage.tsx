/**
 * MarkdownMessage — 面板 Chat 的 assistant 消息渲染（GFM）。
 *
 * 安全口径（模型输出属于不可信内容）：
 *  - 不启用 rehype-raw；skipHtml 兜底，原始 HTML 不会被当作 DOM 注入；
 *  - 链接只放行 https，统一 target=_blank，交给 main 的 setWindowOpenHandler 用系统浏览器打开；
 *  - 远程图片受 CSP（default-src 'self'）限制不会加载，这里直接降级为 alt 文本。
 *
 * 视觉口径：排版/代码块/表格样式都在 styles.css 的 .md 段，沿用面板令牌。
 */

import React, { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a({ href, children }) {
    const url = typeof href === 'string' ? href : ''
    if (!/^https:\/\//i.test(url)) {
      return <span className="md-link-blocked">{children}</span>
    }
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
        {children}
      </a>
    )
  },
  img({ alt }) {
    return <span className="md-image">[图片{alt ? `：${alt}` : ''}]</span>
  },
  table({ children }) {
    return (
      <div className="md-table">
        <table>{children}</table>
      </div>
    )
  },
}

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
})
