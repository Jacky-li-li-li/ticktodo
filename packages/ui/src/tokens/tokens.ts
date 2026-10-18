/**
 * CSS 令牌的 TypeScript 镜像（字符串值与 tokens/glass.css 保持一致）。
 * 供 JS 读数；改材质优先改 glass.css，再同步本文件。
 */
export const glassTokens = {
  glassBg: 'rgba(255, 255, 255, 0.09)',
  glassBgLight: 'rgba(255, 255, 255, 0.09)',
  glassBlur: '72px',
  glassSaturate: '2',
  glassBorder: 'rgba(255, 255, 255, 0.22)',
  glassHighlight: 'inset 0 1px 1px rgba(255, 255, 255, 0.22)',
  glassShadow: '0 24px 64px rgba(3, 5, 13, 0.16)',
  glassOverlay: 'rgba(255, 255, 255, 0.08)',
  glassPillBg: 'rgba(255, 255, 255, 0.22)',
  panelBase: 'rgba(18, 20, 31, 0.2)',
  accent: '#2a2d33',
  accentText: '#0b1a2a',
  metalHi: '#3f434c',
  metalMid: '#1c1f25',
  metalLo: '#0a0b0e',
  metalLine: 'rgba(255, 255, 255, 0.22)',
  metalText: '#f3f5f9',
  metalTextDim: 'rgba(243, 245, 249, 0.6)',
  metalSheen: 'rgba(255, 255, 255, 0.36)',
  metalShadow: 'rgba(0, 0, 0, 0.34)',
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
