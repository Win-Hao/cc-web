/**
 * 侧栏：按项目（cwd）分组的会话列表（shadcn/Tailwind 实现）。
 * 对齐契约：容器 px-3 + 行内 px-2 → 内容起点 20px；行首 16px 图标槽 + 8px
 * 间距 → 会话标题正对组名。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, ChevronDown, ChevronUp, Copy, Download, FileText, Folder, GitFork,
  LoaderCircle, MessageSquareText, Pencil, Pin, PinOff, Plus, Search,
} from 'lucide-react'
import type { SearchHit, SessionSummary } from '../types'
import { api, post, token } from '../lib/api'
import { fmtDateTime, groupKey, groupName, relTime, sessionTitle } from '../lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  /** 分叉（M55）：POST fork + 乐观条目 + 选中新会话，逻辑在 App */
  onFork: (s: SessionSummary) => void
  /** 重命名等改动后立即刷列表（M55） */
  onRefresh: () => void
}

/* ── 置顶/归档（M55）：本地偏好，localStorage 持久 ── */
function loadIdSet(key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function saveIdSet(key: string, set: ReadonlySet<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]))
}
const PINS_KEY = 'cc-web.pinned'
const ARCHIVE_KEY = 'cc-web.archived'

interface MenuState {
  x: number
  y: number
  s: SessionSummary
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

const rowBase =
  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] leading-tight cursor-pointer hover:bg-sidebar-accent'

export function Sidebar({ sessions, loading, activeId, onSelect, onNewSession, onFork, onRefresh }: Props) {
  useLang()
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => loadIdSet(PINS_KEY))
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => loadIdSet(ARCHIVE_KEY))
  const [showArchived, setShowArchived] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<{ s: SessionSummary; value: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  /* 右键菜单：点外面 / Esc / 窗口尺寸变化 → 关 */
  useEffect(() => {
    if (menu === null) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onKey as unknown as () => void)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onKey as unknown as () => void)
    }
  }, [menu])

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveIdSet(PINS_KEY, next)
      return next
    })
  }
  const toggleArchive = (id: string) => {
    setArchived((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveIdSet(ARCHIVE_KEY, next)
      return next
    })
  }

  const download = async (path: string, filename: string) => {
    const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) return
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
    URL.revokeObjectURL(a.href)
  }

  /** 完整数据（M57）：主 jsonl + subagents 目录的 tar.gz */
  const exportSession = (s: SessionSummary) =>
    download(`/api/v1/sessions/${s.session_id}/archive`, `${s.session_id}.tar.gz`)
  const exportMarkdown = (s: SessionSummary) =>
    download(`/api/v1/sessions/${s.session_id}/export`, `${sessionTitle(s).slice(0, 40) || s.session_id}.md`)

  const submitRename = async () => {
    if (renaming === null) return
    const { s, value } = renaming
    setRenaming(null)
    try {
      await post(`/api/v1/sessions/${s.session_id}/name`, { name: value.trim() })
      onRefresh()
    } catch {
      /* 列表轮询会兜底 */
    }
  }

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
    const visible = showArchived ? sessions : sessions.filter((s) => !archived.has(s.session_id))
    const list = needle === ''
      ? visible
      : visible.filter(
          (s) =>
            (s.name ?? '').toLowerCase().includes(needle) ||
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
    for (const g of byKey.values()) {
      // 置顶的浮到组内最前（组内原本按 mtime 倒序，稳定排序保持相对次序）
      g.sessions.sort((a, b) => Number(pinned.has(b.session_id)) - Number(pinned.has(a.session_id)))
    }
    return [...byKey.values()]
  }, [sessions, q, archived, showArchived, pinned])

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
                    className={cn(
                      rowBase,
                      s.session_id === activeId && 'bg-selected hover:bg-selected',
                      archived.has(s.session_id) && 'opacity-55',
                    )}
                    title={s.name ?? s.first_message ?? s.session_id}
                    onClick={() => onSelect(s.session_id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 320), s })
                    }}
                  >
                    <span className="w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-[450]">{sessionTitle(s)}</span>
                    {pinned.has(s.session_id) && <Pin className="size-3 shrink-0 text-faint" />}
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
        {!filtering && archived.size > 0 && (
          <button
            className={cn(rowBase, 'mt-1.5 text-xs text-muted-foreground')}
            onClick={() => setShowArchived((v) => !v)}
          >
            <span className="flex w-4 shrink-0 justify-center"><Archive className="size-3.5" /></span>
            {t('archivedCount', { n: archived.size })}
            {showArchived ? <ChevronUp className="ml-auto size-3.5" /> : <ChevronDown className="ml-auto size-3.5" />}
          </button>
        )}
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
      {menu !== null && (
        <div
          className="fixed z-50 min-w-[184px] rounded-lg border bg-background py-1 text-[13px] shadow-lg"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
        >
          {(
            [
              {
                icon: <Copy className="size-3.5" />, label: t('ctxCopyId'),
                run: () => void navigator.clipboard.writeText(menu.s.session_id),
              },
              {
                icon: <Pencil className="size-3.5" />, label: t('ctxRename'),
                run: () => setRenaming({ s: menu.s, value: menu.s.name ?? '' }),
              },
              {
                icon: <GitFork className="size-3.5" />, label: t('ctxFork'),
                run: () => onFork(menu.s),
              },
              {
                icon: <Download className="size-3.5" />, label: t('ctxExport'),
                run: () => void exportSession(menu.s),
              },
              {
                icon: <FileText className="size-3.5" />, label: t('ctxExportMd'),
                run: () => void exportMarkdown(menu.s),
              },
              pinned.has(menu.s.session_id)
                ? { icon: <PinOff className="size-3.5" />, label: t('ctxUnpin'), run: () => togglePin(menu.s.session_id) }
                : { icon: <Pin className="size-3.5" />, label: t('ctxPin'), run: () => togglePin(menu.s.session_id) },
              archived.has(menu.s.session_id)
                ? { icon: <ArchiveRestore className="size-3.5" />, label: t('ctxUnarchive'), run: () => toggleArchive(menu.s.session_id) }
                : { icon: <Archive className="size-3.5" />, label: t('ctxArchive'), run: () => toggleArchive(menu.s.session_id) },
            ] as { icon: React.ReactNode; label: string; run: () => void }[]
          ).map((item) => (
            <button
              className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left hover:bg-sidebar-accent"
              key={item.label}
              onClick={() => {
                setMenu(null)
                item.run()
              }}
            >
              <span className="text-muted-foreground">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <div className="mt-1 border-t px-3 pt-1.5 pb-0.5 text-xs text-faint">
            {t('lastUpdatedAt', { t: fmtDateTime(menu.s.mtime_ms) })}
          </div>
        </div>
      )}
      {renaming !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRenaming(null)}>
          <div className="w-[320px] rounded-xl border bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-sm font-medium">{t('renameTitle')}</div>
            <Input
              autoFocus
              value={renaming.value}
              placeholder={renaming.s.first_message ?? renaming.s.session_id.slice(0, 8)}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitRename()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>{t('cancelBtn')}</Button>
              <Button size="sm" onClick={() => void submitRename()}>{t('ok')}</Button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
