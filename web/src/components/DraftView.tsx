/**
 * 草稿态主视图（M21/M22）：居中品牌 + composer + 项目选择条。
 * 选择条 Popover：「最近的文件夹」两行行 + ✓，底部「选择文件夹…」进入
 * 服务端目录浏览器。会话在发出首条消息时才创建。
 */
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, ChevronLeft, ChevronUp, Folder, FolderSearch } from 'lucide-react'
import { api } from '../lib/api'
import type { ProjectChoice } from '../types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

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

const menuRow =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent'

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

  useEffect(() => {
    void fetchHome().then(setHome)
  }, [])

  // 项目列表异步到位后补默认值（首屏 projects 可能还是空的）
  useEffect(() => {
    setCwd((cur) => cur ?? defaultCwd ?? projects[0]?.cwd ?? null)
  }, [projects, defaultCwd])

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
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-4">
      <div className="mb-5 text-center select-none">
        <div className="font-mono text-[34px] leading-tight font-bold tracking-tight">cc-web</div>
        <div className="mt-2 text-[13px] text-muted-foreground">还没有消息 —— 在下方输入开始对话</div>
      </div>
      <div className="w-[min(720px,94%)]">
        <div className="relative rounded-[28px] border bg-background shadow-md transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring">
          <Textarea
            ref={taRef}
            rows={2}
            autoFocus
            value={text}
            placeholder="输入消息…"
            className="max-h-64 min-h-[110px] py-3.5 pr-[56px] pl-4"
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
          <Button
            size="icon"
            title="发送"
            className="absolute right-2 bottom-2"
            disabled={text.trim() === '' || cwd === null}
            onClick={send}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
        <div className="mt-2 flex">
          <Popover
            open={menuOpen}
            onOpenChange={(o) => {
              setMenuOpen(o)
              if (!o) setBrowse(false)
            }}
          >
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
                <Folder className="size-3.5" />
                <span className="max-w-[260px] truncate">{cwdName ?? '选择项目目录…'}</span>
                {menuOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </Button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-[380px]">
              {!browse && (
                <>
                  <div className="px-2.5 pt-1.5 pb-0.5 text-xs text-faint select-none">最近的文件夹</div>
                  <div className="max-h-72 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.cwd}
                        type="button"
                        className={cn(menuRow, p.cwd === cwd && 'bg-selected hover:bg-selected')}
                        onClick={() => pick(p.cwd)}
                      >
                        <Folder className="size-[15px] shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[13px] font-[450]">{p.name}</span>
                          <span className="truncate text-xs text-faint">{abbrev(p.cwd)}</span>
                        </span>
                        {p.cwd === cwd && <Check className="size-3.5 shrink-0" />}
                      </button>
                    ))}
                  </div>
                  <Separator className="my-1" />
                  <button
                    type="button"
                    className={menuRow}
                    onClick={() => {
                      setBrowse(true)
                      loadDirs(cwd ?? '~')
                    }}
                  >
                    <FolderSearch className="size-[15px] shrink-0 text-muted-foreground" />
                    <span className="text-[13px]">选择文件夹…</span>
                  </button>
                </>
              )}
              {browse && (
                <>
                  <Input
                    value={browsePath}
                    onChange={(e) => setBrowsePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) loadDirs(browsePath)
                    }}
                    spellCheck={false}
                    className="m-1 w-[calc(100%-8px)] font-mono text-xs"
                  />
                  {browseErr !== null && (
                    <div className="px-2.5 py-1 text-xs text-destructive">{browseErr}</div>
                  )}
                  <div className="max-h-56 overflow-y-auto">
                    <button
                      type="button"
                      className={menuRow}
                      onClick={() => loadDirs(browsePath.replace(/\/[^/]+\/?$/, '') || '/')}
                    >
                      <ChevronLeft className="size-[15px] shrink-0 text-muted-foreground" />
                      <span className="text-[13px]">上一级</span>
                    </button>
                    {browseDirs.map((d) => (
                      <button
                        key={d}
                        type="button"
                        className={menuRow}
                        onClick={() => loadDirs(`${browsePath.replace(/\/$/, '')}/${d}`)}
                      >
                        <Folder className="size-[15px] shrink-0 text-muted-foreground" />
                        <span className="truncate text-[13px]">{d}</span>
                      </button>
                    ))}
                    {browseDirs.length === 0 && browseErr === null && (
                      <div className="px-2.5 py-2 text-xs text-faint">没有子目录</div>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 border-t p-1.5">
                    <Button variant="outline" size="sm" onClick={() => setBrowse(false)}>返回</Button>
                    <Button size="sm" className="max-w-[240px]" onClick={() => pick(browsePath)}>
                      <span className="truncate">选用 {abbrev(browsePath)}</span>
                    </Button>
                  </div>
                </>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
