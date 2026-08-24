/**
 * 侧栏：按项目（cwd）分组的会话列表（shadcn/Tailwind 实现）。
 * 对齐契约：容器 px-3 + 行内 px-2 → 内容起点 20px；行首 16px 图标槽 + 8px
 * 间距 → 会话标题正对组名。
 */
import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Folder, Plus, Search } from 'lucide-react'
import type { SessionSummary } from '../types'
import { groupKey, groupName, relTime, sessionTitle } from '../lib/format'
import { SidebarFooter } from './SidebarFooter'
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
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

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

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex min-h-[50px] items-center gap-2 p-3">
        <span className="text-sm leading-[22px] font-medium">cc-web</span>
      </div>
      <div className="px-3">
        <button className={rowBase} onClick={onNewSession}>
          <Plus className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">新建会话</span>
        </button>
        <label className={cn(rowBase, 'focus-within:bg-sidebar-accent')}>
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话…"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 [&::-webkit-scrollbar]:w-1">
        {loading && groups.length === 0 && (
          <div className="px-2 py-4 text-[13px] text-faint">加载中…</div>
        )}
        {!loading && groups.length === 0 && (
          <div className="px-2 py-4 text-[13px] text-faint">
            {filtering ? '没有匹配的会话' : '没有会话'}
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
                      收起
                    </button>
                  )
                ) : (
                  <button
                    className={cn(rowBase, 'text-xs text-muted-foreground')}
                    onClick={() => setExpanded((x) => toggled(x, g.key))}
                  >
                    <span className="flex w-4 shrink-0 justify-center"><ChevronDown className="size-3.5" /></span>
                    展开更多 ({g.sessions.length - GROUP_LIMIT})
                  </button>
                )
              )}
            </div>
          )
        })}
      </div>
      <SidebarFooter />
    </aside>
  )
}
