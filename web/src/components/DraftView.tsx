/**
 * 草稿态主视图（M21/M22，按通用做法 的新建会话页）：
 * 居中品牌 + 提示 + 居中 composer + 卡片下方的项目选择条。
 * 选择条弹出「最近的文件夹」（两行行 + 选中 ✓），底部「选择文件夹…」
 * 进入服务端支持的目录浏览器逐级下钻。会话在发出首条消息时才创建。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ProjectChoice } from '../types'
import { FolderIcon, SendIcon } from './icons'

/** meta.home 只拉一次：把绝对路径缩写成 ~/… */
let homeCache: string | null = null
async function fetchHome(): Promise<string | null> {
  if (homeCache !== null) return homeCache
  try {
    const meta = await api<{ home?: string }>('/api/v1/meta')
    homeCache = typeof meta.home === 'string' ? meta.home : null
  } catch {
    homeCache = null
  }
  return homeCache
}

interface Props {
  projects: ProjectChoice[]
  defaultCwd: string | null
  onSend: (cwd: string, text: string) => void
}

export function DraftView({ projects, defaultCwd, onSend }: Props) {
  const [cwd, setCwd] = useState<string | null>(defaultCwd ?? projects[0]?.cwd ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [browse, setBrowse] = useState(false)
  const [browsePath, setBrowsePath] = useState('~')
  const [browseDirs, setBrowseDirs] = useState<string[]>([])
  const [browseErr, setBrowseErr] = useState<string | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchHome().then(setHome)
  }, [])

  // 项目列表异步到位后补默认值（首屏 projects 可能还是空的）
  useEffect(() => {
    setCwd((cur) => cur ?? defaultCwd ?? projects[0]?.cwd ?? null)
  }, [projects, defaultCwd])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (pickerRef.current !== null && !pickerRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setBrowse(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const abbrev = (p: string): string =>
    home !== null && p.startsWith(home) ? `~${p.slice(home.length)}` : p

  const loadDirs = (path: string) => {
    setBrowseErr(null)
    api<{ path: string; dirs: string[] }>(`/api/v1/fs/dirs?path=${encodeURIComponent(path)}`)
      .then((d) => {
        setBrowsePath(d.path)
        setBrowseDirs(d.dirs)
      })
      .catch((e: Error) => setBrowseErr(e.message))
  }

  const pick = (path: string) => {
    setCwd(path)
    setMenuOpen(false)
    setBrowse(false)
    taRef.current?.focus()
  }

  const cwdName = cwd?.split('/').filter(Boolean).pop() ?? null

  const send = () => {
    const t = text.trim()
    if (t === '' || cwd === null) return
    setText('')
    onSend(cwd, t)
  }

  return (
    <div className="draft">
      <div className="draft-hero">
        <div className="draft-mark">cc-web</div>
        <div className="draft-hint">还没有消息 —— 在下方输入开始对话</div>
      </div>
      <div className="draft-box">
        <div className="composer-card">
          <textarea
            ref={taRef}
            rows={2}
            autoFocus
            value={text}
            placeholder="输入消息…"
            onChange={(e) => {
              setText(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="send-btn" title="发送" disabled={text.trim() === '' || cwd === null} onClick={send}>
            <SendIcon />
          </button>
        </div>
        <div className="draft-picker" ref={pickerRef}>
          <button
            className="picker-btn"
            onClick={() => {
              setMenuOpen((v) => !v)
              setBrowse(false)
            }}
          >
            <FolderIcon size={14} />
            <span className="picker-name">{cwdName ?? '选择项目目录…'}</span>
            <span className="picker-chev">{menuOpen ? '⌃' : '⌄'}</span>
          </button>
          {menuOpen && !browse && (
            <div className="picker-menu">
              <div className="menu-label">最近的文件夹</div>
              {projects.map((p) => (
                <div
                  key={p.cwd}
                  className={p.cwd === cwd ? 'proj-row two on' : 'proj-row two'}
                  onClick={() => pick(p.cwd)}
                >
                  <span className="proj-folder"><FolderIcon /></span>
                  <span className="proj-main">
                    <span className="proj-name">{p.name}</span>
                    <span className="proj-path">{abbrev(p.cwd)}</span>
                  </span>
                  {p.cwd === cwd && <span className="proj-check">✓</span>}
                </div>
              ))}
              <div className="menu-divider" />
              <div
                className="proj-row two"
                onClick={() => {
                  setBrowse(true)
                  loadDirs(cwd ?? '~')
                }}
              >
                <span className="proj-folder"><FolderIcon /></span>
                <span className="proj-main"><span className="proj-name">选择文件夹…</span></span>
              </div>
            </div>
          )}
          {menuOpen && browse && (
            <div className="picker-menu">
              <input
                className="proj-input browse-input"
                value={browsePath}
                onChange={(e) => setBrowsePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) loadDirs(browsePath)
                }}
                spellCheck={false}
              />
              {browseErr !== null && <div className="browse-err">{browseErr}</div>}
              <div className="browse-list">
                <div
                  className="proj-row two"
                  onClick={() => loadDirs(browsePath.replace(/\/[^/]+\/?$/, '') || '/')}
                >
                  <span className="proj-folder">‹</span>
                  <span className="proj-main"><span className="proj-name">上一级</span></span>
                </div>
                {browseDirs.map((d) => (
                  <div
                    key={d}
                    className="proj-row two"
                    onClick={() => loadDirs(`${browsePath.replace(/\/$/, '')}/${d}`)}
                  >
                    <span className="proj-folder"><FolderIcon /></span>
                    <span className="proj-main"><span className="proj-name">{d}</span></span>
                  </div>
                ))}
                {browseDirs.length === 0 && browseErr === null && (
                  <div className="browse-empty">没有子目录</div>
                )}
              </div>
              <div className="browse-foot">
                <button className="btn" onClick={() => setBrowse(false)}>返回</button>
                <button className="btn primary" onClick={() => pick(browsePath)}>
                  选用 {abbrev(browsePath)}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
