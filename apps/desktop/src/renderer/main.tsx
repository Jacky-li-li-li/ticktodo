import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import '@tick/ui/styles.css'
import './styles.css'

// UI-SPEC §2.2：唯一字族 Inter，字重只用 400/500/600/700 四档（本地打包，无网络依赖）
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

/**
 * 启动兜底：
 *  - preload 还没加载好（dev 下 vite-plugin-electron 重建 preload 的瞬时窗口）→ 不挂载 App，
 *    短暂等待后自动 reload 一次，避免 `window.tick` undefined 把整个面板打白。
 *  - 任何渲染异常由 ErrorBoundary 接住，给一个可点重试的壳，而不是空白。
 */
const RELOAD_KEY = 'tick:preload-reload-at'

function Fallback({ text, retry }: { text: string; retry?: boolean }): React.JSX.Element {
  return (
    <div className="boot-fallback">
      <div className="boot-title">{text}</div>
      {retry && (
        <button className="boot-retry" onClick={() => window.location.reload()}>
          重新加载
        </button>
      )}
    </div>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[tick] renderer 渲染失败:', error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <Fallback text={`面板渲染失败：${this.state.error.message}`} retry />
    }
    return this.props.children
  }
}

function Boot(): React.JSX.Element {
  if (typeof window.tick === 'undefined') {
    const last = Number(window.sessionStorage?.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last > 3000) {
      window.sessionStorage?.setItem(RELOAD_KEY, String(Date.now()))
      window.setTimeout(() => window.location.reload(), 700)
      return <Fallback text="面板初始化中…" />
    }
    return <Fallback text="面板初始化失败：preload 未加载" retry />
  }
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
)
