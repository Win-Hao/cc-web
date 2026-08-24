/**
 * 侧栏：按项目（cwd）分组的会话列表，交互对齐 参考实现 的
 * Sidebar/WorkspaceGroup/SessionRow —— 组可收起、组内默认 5 条 +
 * 展开更多、搜索过滤、含当前会话的组自动展开。
 */
import { useMemo, useState } from 'react'
import type { SessionSummary } from '../types'
import { groupKey, groupName, relTime, sessionTitle } from '../lib/format'
import { ChevronDownIcon, ChevronUpIcon, FolderIcon, PlusIcon, SearchIcon } from './icons'

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
    // 列表已按 mtime 倒序 → 组按各自最新会话自然有序，组内新的在上
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
    <aside className="side">
      <div className="ch">
        <span className="ch-name">cc-web</span>
      </div>
      <div className="btn-wrap">
        <button className="btn-new-chat" onClick={onNewSession}>
          <PlusIcon />
          <span>新建会话</span>
        </button>
      </div>
      <div className="search-wrap">
        <div className="search">
          <span className="search-icon"><SearchIcon /></span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索会话…"
            spellCheck={false}
          />
        </div>
      </div>
      <div className="sessions">
        {loading && groups.length === 0 && <div className="side-empty">加载中…</div>}
        {!loading && groups.length === 0 && (
          <div className="side-empty">{filtering ? '没有匹配的会话' : '没有会话'}</div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const activeIdx = g.sessions.findIndex((s) => s.session_id === activeId)
          const showAll = filtering || expanded.has(g.key) || activeIdx >= GROUP_LIMIT
          const shown = showAll ? g.sessions : g.sessions.slice(0, GROUP_LIMIT)
          return (
            <div key={g.key}>
              <div
                className="gh"
                title={g.key}
                onClick={() => setCollapsed((c) => toggled(c, g.key))}
              >
                <span className="gh-folder"><FolderIcon /></span>
                <span className="gh-name">{g.name}</span>
                <span className="gh-n">{g.sessions.length}</span>
              </div>
              {!isCollapsed &&
                shown.map((s) => (
                  <div
                    key={s.session_id}
                    className={s.session_id === activeId ? 'se on' : 'se'}
                    title={s.first_message ?? s.session_id}
                    onClick={() => onSelect(s.session_id)}
                  >
                    <span className="se-lead" />
                    <span className="se-t">{sessionTitle(s)}</span>
                    <span className="se-ts">{relTime(s.mtime_ms)}</span>
                  </div>
                ))}
              {!isCollapsed && !filtering && g.sessions.length > GROUP_LIMIT && (
                showAll ? (
                  activeIdx < GROUP_LIMIT && (
                    <button className="show-more" onClick={() => setExpanded((x) => toggled(x, g.key))}>
                      <span className="show-more-lead"><ChevronUpIcon /></span>
                      收起
                    </button>
                  )
                ) : (
                  <button className="show-more" onClick={() => setExpanded((x) => toggled(x, g.key))}>
                    <span className="show-more-lead"><ChevronDownIcon /></span>
                    展开更多 ({g.sessions.length - GROUP_LIMIT})
                  </button>
                )
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
