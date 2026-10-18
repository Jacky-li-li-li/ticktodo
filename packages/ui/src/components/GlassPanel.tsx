import type { HTMLAttributes } from 'react'

export function GlassPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={['tick-glass-panel', className].filter(Boolean).join(' ')} {...props} />
}
