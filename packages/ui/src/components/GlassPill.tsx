import type { ButtonHTMLAttributes } from 'react'

export function GlassPill({ className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={['tick-glass-pill', className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
