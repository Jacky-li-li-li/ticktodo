import type { HTMLAttributes } from 'react'

export type GlassRowProps = HTMLAttributes<HTMLDivElement> & {
  active?: boolean
}

export function GlassRow({ className, active, ...props }: GlassRowProps) {
  return (
    <div
      className={['tick-glass-row', active ? 'tick-glass-row-active' : null, className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  )
}
