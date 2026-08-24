/**
 * 选择文件夹 Modal（M28）：
 * 面包屑路径导航（段可点、↑ 上一级）+ 目录内过滤 + 隐藏目录可见 +
 * 「直接输入绝对路径」+ 底部「打开此文件夹 / 取消」。
 * 数据源 GET /api/v1/fs/dirs（服务端列目录）。
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowUp, Folder, Search } from 'lucide-react'
import { api } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface Props {
  /** 初始目录（通常是当前选中的项目） */
  initialPath: string
  onCancel: () => void
  onPick: (path: string) => void
}

export function FolderDialog({ initialPath, onCancel, onPick }: Props) {
  const [path, setPath] = useState(initialPath)
  const [dirs, setDirs] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [manual, setManual] = useState(false)
  const [manualPath, setManualPath] = useState('')

  const load = (p: string) => {
    setErr(null)
    setQ('')
    api<{ path: string; dirs: string[] }>(`/api/v1/fs/dirs?path=${encodeURIComponent(p)}`)
      .then((d) => {
        setPath(d.path)
        setDirs(d.dirs)
      })
      .catch((e: Error) => setErr(e.message))
  }

  useEffect(() => {
    load(initialPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const segments = useMemo(() => path.split('/').filter(Boolean), [path])
  const parent = path.replace(/\/[^/]+\/?$/, '') || '/'

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return dirs
    return dirs.filter((d) => d.toLowerCase().includes(needle))
  }, [dirs, q])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent showCloseButton className="flex max-h-[80vh] w-[min(640px,94vw)] flex-col gap-0 p-0">
        <DialogHeader className="border-b px-5 pt-4 pb-3">
          <DialogTitle>选择文件夹</DialogTitle>
        </DialogHeader>

        {/* 面包屑：↑ 上一级 + 可点击的路径段 */}
        <div className="flex min-w-0 items-center gap-1 border-b px-4 py-2 text-[13px]">
          <Button variant="ghost" size="icon" className="size-6 rounded-md" title="上一级" onClick={() => load(parent)}>
            <ArrowUp className="size-3.5" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap">
            <button className="cursor-pointer rounded px-1 text-muted-foreground hover:bg-sidebar-accent" onClick={() => load('/')}>/</button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-faint">/</span>}
                <button
                  className={cn(
                    'cursor-pointer rounded px-1 hover:bg-sidebar-accent',
                    i === segments.length - 1 ? 'font-medium' : 'text-muted-foreground',
                  )}
                  onClick={() => load('/' + segments.slice(0, i + 1).join('/'))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* 目录内过滤 */}
        <label className="flex items-center gap-2 border-b px-4 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="在此目录下搜索…"
            spellCheck={false}
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-faint"
          />
        </label>

        {/* 目录列表 */}
        <div className="min-h-[200px] flex-1 overflow-y-auto p-1.5">
          {err !== null && <div className="px-3 py-2 text-xs text-destructive">{err}</div>}
          {err === null && shown.length === 0 && (
            <div className="px-3 py-2 text-xs text-faint">{q !== '' ? '没有匹配的目录' : '没有子目录'}</div>
          )}
          {shown.map((d) => (
            <button
              key={d}
              type="button"
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
                d.startsWith('.') && 'text-muted-foreground',
              )}
              onClick={() => load(`${path.replace(/\/$/, '')}/${d}`)}
            >
              <Folder className="size-[15px] shrink-0 text-muted-foreground" />
              <span className="truncate">{d}</span>
            </button>
          ))}
        </div>

        {/* 直接输入绝对路径 */}
        <div className="border-t px-4 py-2">
          {!manual ? (
            <button className="cursor-pointer text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setManual(true)}>
              直接输入绝对路径
            </button>
          ) : (
            <Input
              autoFocus
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && manualPath.trim() !== '') {
                  load(manualPath.trim())
                  setManual(false)
                  setManualPath('')
                }
              }}
              placeholder="/absolute/path 或 ~/path，Enter 跳转"
              spellCheck={false}
              className="font-mono text-xs"
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button size="sm" onClick={() => onPick(path)}>打开此文件夹</Button>
          <Button variant="outline" size="sm" onClick={onCancel}>取消</Button>
        </div>
        <div className="px-4 pb-3 text-xs text-faint">
          点击文件夹进入，再点「打开此文件夹」将其设为新会话的工作目录。
        </div>
      </DialogContent>
    </Dialog>
  )
}
