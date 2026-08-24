/**
 * context 窗口用量环（M30，composer 里的小圆环）：
 * hover 显示「使用 201k / 1M tokens (20%)」。>80% 转警示色，>90% 转红。
 */
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { t, useLang } from '../lib/i18n'

export interface ContextInfo {
  total: number
  max: number
  percentage: number
  /** 引擎不在时的 jsonl 末轮估算（M31） */
  estimated: boolean
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

const R = 6
const CIRC = 2 * Math.PI * R

export function ContextRing({ info }: { info: ContextInfo }) {
  useLang()
  const pct = Math.max(0, Math.min(100, info.percentage))
  const dash = (pct / 100) * CIRC
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('ctxAria')}
            className="inline-flex size-7 cursor-default items-center justify-center rounded-full outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90">
              <circle cx="8" cy="8" r={R} fill="none" strokeWidth="2" className="stroke-border" />
              <circle
                cx="8"
                cy="8"
                r={R}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${CIRC - dash}`}
                className={cn(
                  'stroke-muted-foreground',
                  pct > 80 && 'stroke-warning',
                  pct > 90 && 'stroke-destructive',
                )}
              />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {t('ctxTooltip', { a: fmtTokens(info.total), b: fmtTokens(info.max), p: Math.round(pct) })}
          {info.estimated && t('estimated')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
