/**
 * 侧栏：按项目（cwd）分组的会话列表（shadcn/Tailwind 实现）。
 * 对齐契约：容器 px-3 + 行内 px-2 → 内容起点 20px；行首 16px 图标槽 + 8px
 * 间距 → 会话标题正对组名。
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Folder, LoaderCircle, MessageSquareText, Plus, Search } from 'lucide-react'
import type { SearchHit, SessionSummary } from '../types'
import { api } from '../lib/api'
import { groupKey, groupName, relTime, sessionTitle } from '../lib/format'
import { SidebarFooter } from './SidebarFooter'
import { t, useLang } from '../lib/i18n'
import { cn } from '@/lib/utils'

const GROUP_LIMIT = 5

interface Group {
  key: string
  name: string
  sessions: SessionSummary[]
}

interface Props {
  sessions: SessionSummary[]
  loading: boolean
  activeId: string | null
  onSelect: (id: string) => void
  onNewSession: () => void
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

const rowBase =
  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] leading-tight cursor-pointer hover:bg-sidebar-accent'

export function Sidebar({ sessions, loading, activeId, onSelect, onNewSession }: Props) {
  useLang()
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)

  /* 全文搜索（M44）：防抖 350ms，≥2 字符才发；本地标题过滤仍即时 */
  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    let stale = false
    const timer = setTimeout(() => {
      api<{ hits: SearchHit[] }>(`/api/v1/sessions/search?q=${encodeURIComponent(needle)}`)
        .then((d) => {
          if (!stale) setHits(d.hits)
        })
        .catch(() => {
          if (!stale) setHits([])
        })
        .finally(() => {
          if (!stale) setSearching(false)
        })
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [q])

  const groups = useMemo<Group[]>(() => {
    const needle = q.trim().toLowerCase()
    const list = needle === ''
      ? sessions
      : sessions.filter(
          (s) =>
            (s.first_message ?? '').toLowerCase().includes(needle) ||
            groupName(s).toLowerCase().includes(needle),
        )
    const byKey = new Map<string, Group>()
    for (const s of list) {
      const key = groupKey(s)
      let g = byKey.get(key)
      if (g === undefined) {
        g = { key, name: groupName(s), sessions: [] }
        byKey.set(key, g)
      }
      g.sessions.push(s)
    }
    return [...byKey.values()]
  }, [sessions, q])

  const filtering = q.trim() !== ''
  const titleById = useMemo(() => new Map(sessions.map((s) => [s.session_id, s])), [sessions])
  const shownIds = new Set(groups.flatMap((g) => g.sessions.map((s) => s.session_id)))
  const extraHits = hits.filter((h) => !shownIds.has(h.session_id))

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex min-h-[50px] items-center gap-2 p-3">
        <span className="text-sm leading-[22px] font-medium">cc-web</span>
      </div>
      <div className="px-3">
        <button className={rowBase} onClick={onNewSession}>
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t('newSession')}</span>
        </button>
        <label className={cn(rowBase, 'focus-within:bg-sidebar-accent')}>
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('searchSessions')}
            spellCheck={false}
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [&::-webkit-scrollbar]:w-1">
        {loading && groups.length === 0 && (
          <div className="px-2 py-4 text-[13px] text-faint">{t('loading')}</div>
        )}
        {!loading && groups.length === 0 && !searching && extraHits.length === 0 && (
          <div className="px-2 py-4 text-[13px] text-faint">
            {filtering ? t('noMatch') : t('noSessions')}
          </div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const activeIdx = g.sessions.findIndex((s) => s.session_id === activeId)
          const showAll = filtering || expanded.has(g.key) || activeIdx >= GROUP_LIMIT
          const shown = showAll ? g.sessions : g.sessions.slice(0, GROUP_LIMIT)
          return (
            <div key={g.key}>
              <div
                className={cn(rowBase, 'mt-1.5 select-none text-muted-foreground')}
                title={g.key}
                onClick={() => setCollapsed((c) => toggled(c, g.key))}
              >
                <span className="flex w-4 shrink-0 justify-center">
                  <Folder className="size-[15px]" />
                </span>
                <span className="min-w-0 flex-1 truncate">{g.name}</span>
                <span className="text-xs text-faint tabular-nums">{g.sessions.length}</span>
              </div>
              {!isCollapsed &&
                shown.map((s) => (
                  <div
                    key={s.session_id}
                    className={cn(rowBase, s.session_id === activeId && 'bg-selected hover:bg-selected')}
                    title={s.first_message ?? s.session_id}
                    onClick={() => onSelect(s.session_id)}
                  >
                    <span className="w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-[450]">{sessionTitle(s)}</span>
                    {s.state === 'running' && (
                      <LoaderCircle className="cc-icon-spin size-3 shrink-0 text-primary" />
                    )}
                    {s.state === 'waiting-approval' && (
                      <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" title="waiting approval" />
                    )}
                    <span className="shrink-0 text-right text-xs text-faint tabular-nums">
                      {relTime(s.mtime_ms)}
                    </span>
                  </div>
                ))}
              {!isCollapsed && !filtering && g.sessions.length > GROUP_LIMIT && (
                showAll ? (
                  activeIdx < GROUP_LIMIT && (
                    <button
                      className={cn(rowBase, 'text-xs text-muted-foreground')}
                      onClick={() => setExpanded((x) => toggled(x, g.key))}
                    >
                      <span className="flex w-4 shrink-0 justify-center"><ChevronUp className="size-3.5" /></span>
                      {t('collapse')}
                    </button>
                  )
                ) : (
                  <button
                    className={cn(rowBase, 'text-xs text-muted-foreground')}
                    onClick={() => setExpanded((x) => toggled(x, g.key))}
                  >
                    <span className="flex w-4 shrink-0 justify-center"><ChevronDown className="size-3.5" /></span>
                    {t('showMore', { n: g.sessions.length - GROUP_LIMIT })}
                  </button>
                )
              )}
            </div>
          )
        })}
        {filtering && (searching || extraHits.length > 0) && (
          <div>
            <div className={cn(rowBase, 'mt-1.5 cursor-default select-none text-muted-foreground hover:bg-transparent')}>
              <span className="flex w-4 shrink-0 justify-center">
                <MessageSquareText className="size-[15px]" />
              </span>
              <span className="min-w-0 flex-1 truncate">{t('contentMatches')}</span>
              {!searching && <span className="text-xs text-faint tabular-nums">{extraHits.length}</span>}
            </div>
            {searching && <div className="px-2 py-1 text-xs text-faint">{t('searchingFullText')}</div>}
            {!searching &&
              extraHits.map((h) => {
                const known = titleById.get(h.session_id)
                return (
                  <div
                    key={h.session_id}
                    className={cn(rowBase, 'flex-col items-stretch gap-0.5', h.session_id === activeId && 'bg-selected hover:bg-selected')}
                    title={h.snippet}
                    onClick={() => onSelect(h.session_id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-[450]">
                        {known !== undefined ? sessionTitle(known) : h.session_id.slice(0, 8)}
                      </span>
                      <span className="shrink-0 text-right text-xs text-faint tabular-nums">
                        {relTime(h.mtime_ms)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-xs text-faint">{h.snippet}</span>
                    </span>
                  </div>
                )
              })}
          </div>
        )}
      </div>
      <SidebarFooter />
    </aside>
  )
}
