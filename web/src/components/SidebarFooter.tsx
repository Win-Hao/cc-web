/**
 * 侧栏底部菜单（M32）：套餐用量 / 外观 / 语言 / 设置。
 * 自包含：菜单 + 两个 Dialog + 数据拉取都在这里，不打扰 App 状态。
 */
import { useEffect, useState } from 'react'
import {
  BarChart3, ChevronRight, Globe, Settings, SunMoon,
} from 'lucide-react'
import { api } from '../lib/api'
import { getLang, setLang, t, useLang } from '../lib/i18n'
import type { Lang } from '../lib/i18n'
import { getTheme, setTheme } from '../lib/theme'
import type { Theme } from '../lib/theme'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'

const THEME_KEY = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
} as const
const THEME_ORDER: Theme[] = ['system', 'light', 'dark']
const LANG_LABEL: Record<Lang, string> = { zh: '简体中文', en: 'English' }

const menuRow =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent'

/* ── 套餐用量面板 ── */
interface RateWindow {
  utilization?: number
  resets_at?: string
}
interface PlanUsage {
  rate_limits_available: boolean
  rate_limits: Record<string, RateWindow> | null
  subscription_type: string | null
}

const WINDOW_KEY: Record<string, 'win_five_hour' | 'win_seven_day' | 'win_seven_day_sonnet' | 'win_seven_day_opus'> = {
  five_hour: 'win_five_hour',
  seven_day: 'win_seven_day',
  seven_day_sonnet: 'win_seven_day_sonnet',
  seven_day_opus: 'win_seven_day_opus',
}

function fmtReset(iso: string | undefined): string | null {
  if (iso === undefined) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return t('resetsAt', {
    t: d.toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  })
}

function UsageBar({ label, win }: { label: string; win: RateWindow }) {
  const pct = Math.max(0, Math.min(100, win.utilization ?? 0))
  const reset = fmtReset(win.resets_at)
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between text-[13px]">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className={
            pct > 90 ? 'h-full bg-destructive' : pct > 80 ? 'h-full bg-warning' : 'h-full bg-primary'
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      {reset !== null && <div className="mt-1 text-xs text-faint">{reset}</div>}
    </div>
  )
}

function PlanUsageDialog({ onClose }: { onClose: () => void }) {
  useLang()
  const [data, setData] = useState<PlanUsage | null | 'loading' | 'error'>('loading')

  useEffect(() => {
    api<PlanUsage | null>('/api/v1/plan-usage')
      .then(setData)
      .catch(() => setData('error'))
  }, [])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton className="w-[min(420px,92vw)]">
        <DialogHeader>
          <DialogTitle>{t('planUsage')}</DialogTitle>
        </DialogHeader>
        {data === 'loading' && <div className="py-4 text-[13px] text-faint">{t('usageLoadHint')}</div>}
        {data === 'error' && <div className="py-4 text-[13px] text-destructive">{t('loadFailed')}</div>}
        {data !== 'loading' && data !== 'error' && (
          data === null || !data.rate_limits_available || data.rate_limits === null ? (
            <div className="py-4 text-[13px] text-muted-foreground">
              {t('noRateInfo')}
            </div>
          ) : (
            <div className="py-1">
              {data.subscription_type !== null && (
                <div className="mb-3 text-xs text-muted-foreground">
                  {t('subscription')}<span className="text-foreground">{data.subscription_type}</span>
                </div>
              )}
              {Object.entries(data.rate_limits)
                .filter(([, w]) => typeof w === 'object' && w !== null && typeof w.utilization === 'number')
                .map(([key, w]) => (
                  <UsageBar key={key} label={WINDOW_KEY[key] !== undefined ? t(WINDOW_KEY[key]!) : key} win={w} />
                ))}
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ── 设置面板 ── */
function SettingsDialog({ onClose }: { onClose: () => void }) {
  useLang()
  const [meta, setMeta] = useState<{ version?: string; home?: string } | null>(null)

  useEffect(() => {
    api<{ version?: string; home?: string }>('/api/v1/meta').then(setMeta).catch(() => setMeta(null))
  }, [])

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-[13px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-xs">{value}</span>
    </div>
  )

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton className="w-[min(420px,92vw)]">
        <DialogHeader>
          <DialogTitle>{t('settings')}</DialogTitle>
        </DialogHeader>
        <div className="py-1">
          <Row label={t('version')} value={`cc-web ${meta?.version ?? '…'}`} />
          <Row label={t('dataDir')} value="~/.claude/projects" />
          <Row label={t('cliBaseline')} value="2.1.241" />
          <Separator className="my-2" />
          <div className="text-xs leading-relaxed text-faint">
            {t('aboutText')}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── 底部菜单 ── */
export function SidebarFooter() {
  const lang = useLang()
  const [open, setOpen] = useState(false)
  const [theme, setThemeState] = useState<Theme>(() => getTheme())
  const [showUsage, setShowUsage] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]!
    setTheme(next)
    setThemeState(next)
  }

  return (
    <>
      <div className="border-t border-sidebar-border p-1.5">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className={menuRow}>
              <Settings className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t('settings')}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-[232px]">
            <button
              className={menuRow}
              onClick={() => {
                setOpen(false)
                setShowUsage(true)
              }}
            >
              <BarChart3 className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t('planUsage')}</span>
              <ChevronRight className="size-3.5 text-faint" />
            </button>
            <Separator className="my-1" />
            <button className={menuRow} onClick={cycleTheme}>
              <SunMoon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t('appearance')}</span>
              <span className="text-xs text-muted-foreground">{t(THEME_KEY[theme])}</span>
            </button>
            <button className={menuRow} onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}>
              <Globe className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t('language')}</span>
              <span className="text-xs text-muted-foreground">{LANG_LABEL[lang]}</span>
            </button>
            <button
              className={menuRow}
              onClick={() => {
                setOpen(false)
                setShowSettings(true)
              }}
            >
              <Settings className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{t('settings')}</span>
              <ChevronRight className="size-3.5 text-faint" />
            </button>
          </PopoverContent>
        </Popover>
      </div>
      {showUsage && <PlanUsageDialog onClose={() => setShowUsage(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </>
  )
}
