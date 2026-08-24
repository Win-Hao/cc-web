/**
 * subagent 消息组（M17）：「子代理 · …」chip，点开懒加载嵌套时间线
 * （同一套段模型，工具行照常配对）。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../lib/api'
import { segmentsFromContent, textOfSegments, toolResultsFromContent } from '../lib/segments'
import type { HistoryMessage, Segment, ToolSeg } from '../types'
import { Markdown } from './Markdown'
import { cn } from '@/lib/utils'

interface SideMsg {
  role: 'user' | 'assistant'
  segments: Segment[]
}

function buildSideMsgs(messages: HistoryMessage[]): SideMsg[] {
  const out: SideMsg[] = []
  const toolLoc = new Map<string, { m: number; s: number }>()
  for (const m of messages) {
    const content = m.content ?? m.text
    if (m.role === 'assistant') {
      const segments = segmentsFromContent(content)
      if (segments.length === 0) continue
      const idx = out.push({ role: 'assistant', segments }) - 1
      segments.forEach((seg, si) => {
        if (seg.kind === 'tool' && seg.id !== null) toolLoc.set(seg.id, { m: idx, s: si })
      })
    } else if (m.role === 'user') {
      for (const r of toolResultsFromContent(content)) {
        const loc = r.id !== null ? toolLoc.get(r.id) : undefined
        const seg = loc !== undefined ? out[loc.m]?.segments[loc.s] : undefined
        if (seg !== undefined && seg.kind === 'tool') {
          const t = seg as ToolSeg
          t.status = r.isError ? 'error' : 'ok'
          if (r.text !== '') t.result = r.text
        }
      }
      const text = textOfSegments(segmentsFromContent(content))
      if (text !== '') out.push({ role: 'user', segments: [{ kind: 'text', text }] })
    }
  }
  return out
}

interface Props {
  fetchPath: string
  label: string
}

export function SidechainBlock({ fetchPath, label }: Props) {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<SideMsg[] | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && msgs === null && !failed) {
      api<{ messages: HistoryMessage[] }>(fetchPath)
        .then((d) => setMsgs(buildSideMsgs(d.messages)))
        .catch(() => setFailed(true))
    }
  }

  return (
    <div className="mt-2">
      <button
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-accent-bd bg-accent px-2.5 py-[3px] text-xs text-accent-foreground hover:bg-accent-bd"
        onClick={toggle}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {label}
      </button>
      {open && (
        <div className="mt-2 border-l-2 border-accent-bd py-1 pl-3">
          {failed && <div className="py-1 text-xs text-faint">加载失败</div>}
          {!failed && msgs === null && <div className="py-1 text-xs text-faint">加载中…</div>}
          {msgs?.map((m, i) => (
            <div className="mt-2 first:mt-0" key={i}>
              {m.segments.map((seg, si) =>
                seg.kind === 'text' ? (
                  m.role === 'user' ? (
                    <div
                      className="inline-block rounded-lg border bg-sunken px-2.5 py-1 text-xs break-words whitespace-pre-wrap text-muted-foreground"
                      key={si}
                    >
                      {seg.text}
                    </div>
                  ) : (
                    <div className="text-[13px]" key={si}><Markdown text={seg.text} /></div>
                  )
                ) : (
                  <details className="group mt-2 overflow-hidden rounded-lg border bg-secondary/60" key={si}>
                    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 select-none hover:bg-sidebar-accent [&::-webkit-details-marker]:hidden">
                      <span
                        className={cn(
                          'size-[7px] shrink-0 rounded-full',
                          seg.status === 'ok' && 'bg-success',
                          seg.status === 'error' && 'bg-destructive',
                          seg.status === 'pending' && 'animate-pulse bg-faint',
                        )}
                      />
                      <span className="shrink-0 font-mono text-xs font-medium">{seg.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{seg.summary}</span>
                    </summary>
                    <div className="border-t">
                      {seg.detail !== '' && seg.detail !== '{}' && (
                        <pre className="max-h-60 overflow-auto bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{seg.detail}</pre>
                      )}
                      {seg.result !== null && seg.result !== '' && (
                        <pre
                          className={cn(
                            'max-h-60 overflow-auto border-t bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap first:border-t-0',
                            seg.status === 'error' && 'text-destructive',
                          )}
                        >{seg.result}</pre>
                      )}
                    </div>
                  </details>
                ),
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
