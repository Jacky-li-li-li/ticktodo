/**
 * relTime — 相对时间（首页显示「昨天 22:14」样式，§4.2）。
 */

export function relTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const hm = () => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (sameDay(d, now)) return hm()
  if (sameDay(d, yest)) return `昨天 ${hm()}`

  // 更早：仅月日（跨年带年）
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}年 ${md}`
  return md
}
