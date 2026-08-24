import type { SessionSummary } from '../types'

/** 相对时间：刚刚 / 5m / 3h / 2d，30 天以上给日期 */
export function relTime(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  const dt = new Date(ms)
  return `${dt.getMonth() + 1}/${dt.getDate()}`
}

/** slug 不可逆（server 端注释）：项目名取 cwd 末段，无 cwd 退回 slug */
export const groupKey = (s: SessionSummary): string => s.cwd ?? s.project_slug

export function groupName(s: SessionSummary): string {
  if (s.cwd === null) return s.project_slug
  const last = s.cwd.split('/').filter(Boolean).pop()
  return last ?? s.cwd
}

export const sessionTitle = (s: SessionSummary): string =>
  s.first_message ?? s.session_id.slice(0, 8)

/** 运行耗时：<60s 一位小数（<10s）或整数；≥60s → "1m 04s"（M47） */
export function formatElapsedMs(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.floor(s - m * 60)
  return `${m}m ${String(rem).padStart(2, '0')}s`
}
