/**
 * 草稿态主视图（M21，按通用做法 的新建会话页）：
 * 居中品牌 + 提示 + 居中 composer + 卡片下方的项目选择条。
 * 会话在发出首条消息时才创建（选中目录 → POST /sessions → prompt）。
 */
import { useEffect, useRef, useState } from 'react'
import type { ProjectChoice } from '../types'
import { FolderIcon, SendIcon } from './icons'

interface Props {
  projects: ProjectChoice[]
  defaultCwd: string | null
  onSend: (cwd: string, text: string) => void
}

export function DraftView({ projects, defaultCwd, onSend }: Props) {
  const [cwd, setCwd] = useState<string | null>(defaultCwd ?? projects[0]?.cwd ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [custom, setCustom] = useState('')
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  // 项目列表异步到位后补默认值（首屏 projects 可能还是空的）
  useEffect(() => {
    setCwd((cur) => cur ?? defaultCwd ?? projects[0]?.cwd ?? null)
  }, [projects, defaultCwd])

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (pickerRef.current !== null && !pickerRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setCustomMode(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

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
              setCustomMode(false)
            }}
          >
            <FolderIcon size={14} />
            <span className="picker-name">{cwdName ?? '选择项目目录…'}</span>
            <span className="picker-chev">⌄</span>
          </button>
          {menuOpen && (
            <div className="picker-menu">
              {!customMode && (
                <>
                  {projects.map((p) => (
                    <div
                      key={p.cwd}
                      className={p.cwd === cwd ? 'proj-row on' : 'proj-row'}
                      title={p.cwd}
                      onClick={() => {
                        setCwd(p.cwd)
                        setMenuOpen(false)
                        taRef.current?.focus()
                      }}
                    >
                      <span className="proj-folder"><FolderIcon /></span>
                      <span className="proj-name">{p.name}</span>
                      <span className="proj-cwd">{p.cwd}</span>
                    </div>
                  ))}
                  <div className="proj-row" onClick={() => setCustomMode(true)}>
                    <span className="proj-folder">…</span>
                    <span className="proj-name">输入目录路径</span>
                  </div>
                </>
              )}
              {customMode && (
                <input
                  className="proj-input picker-input"
                  autoFocus
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && custom.trim() !== '') {
                      setCwd(custom.trim())
                      setMenuOpen(false)
                      setCustomMode(false)
                      taRef.current?.focus()
                    }
                  }}
                  placeholder="目录路径（支持 ~/），Enter 确认"
                  spellCheck={false}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
