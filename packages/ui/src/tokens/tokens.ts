/**
 * CSS 令牌的 TypeScript 镜像（字符串值与 tokens/glass.css 保持一致）。
 * 供 JS 读数；改材质优先改 glass.css，再同步本文件。
 */
export const glassTokens = {
  glassBg: 'rgba(255, 255, 255, 0.42)',
  glassBgLight: 'rgba(255, 255, 255, 0.42)',
  glassBlur: '40px',
  glassSaturate: '1.4',
  glassBorder: 'rgba(255, 255, 255, 0.22)',
  glassHighlight: 'inset 0 1px 2px rgba(255, 255, 255, 0.28)',
  glassShadow: '0 30px 80px rgba(3, 5, 13, 0.45)',
  glassOverlay: 'rgba(0, 0, 0, 0.06)',
  glassPillBg: 'rgba(255, 255, 255, 0.55)',
  panelBase: 'rgba(18, 20, 31, 0.2)',
  accent: '#0a84ff',
  accentText: '#0a5fbf',
  tTitle: 'rgba(0, 0, 0, 0.9)',
  tRow: 'rgba(0, 0, 0, 0.85)',
  tBody: 'rgba(0, 0, 0, 0.75)',
  tSecondary: 'rgba(0, 0, 0, 0.58)',
  tLabel: 'rgba(0, 0, 0, 0.5)',
  tWeak: 'rgba(0, 0, 0, 0.38)',
  tFaint: 'rgba(0, 0, 0, 0.32)',
  tTime: 'rgba(0, 0, 0, 0.42)',
  tDone: 'rgba(0, 0, 0, 0.45)',
  rWindow: '10px',
  rPanel: '20px',
  rCard: '16px',
  rRow: '12px',
  rPill: '15px',
  padPanel: '14px',
  gapStd: '12px',
} as const

export type GlassTokenKey = keyof typeof glassTokens
