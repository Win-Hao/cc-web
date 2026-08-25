/**
 * subagent 消息组（M17）：「子代理 · …」chip，点开懒加载嵌套时间线。
 * 服务器给的就是归一化好的 Message（D7），这里只渲染。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../lib/api'
import { toolDetail, toolSummary } from '../lib/blocks'
import type { Message } from '../types'
import { Markdown } from './Markdown'
import { cn } from '@/lib/utils'
import { t, useLang } from '../lib/i18n'

interface Props {
  fetchPath: string
  label: string
}

export function SidechainBlock({ fetchPath, label }: Props) {
  useLang()
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState<Message[] | null>(null)
  const [failed, setFailed] = useState(false)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && msgs === null && !failed) {
      api<{ messages: Message[] }>(fetchPath)
        .then((d) => setMsgs(d.messages))
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
          {failed && <div className="py-1 text-xs text-faint">{t('loadFailed')}</div>}
          {!failed && msgs === null && <div className="py-1 text-xs text-faint">{t('loading')}</div>}
          {msgs?.map((m) => (
            <div className="mt-2 first:mt-0" key={m.key}>
              {m.content.map((b, bi) =>
                b.type === 'thinking' || b.type === 'image' ? null : b.type === 'text' ? (
                  m.role === 'user' ? (
                    <div
                      className="inline-block rounded-lg border bg-sunken px-2.5 py-1 text-xs break-words whitespace-pre-wrap text-muted-foreground"
                      key={bi}
                    >
                      {b.text}
                    </div>
                  ) : (
                    <div className="text-[13px]" key={bi}><Markdown text={b.text} /></div>
                  )
                ) : (
                  <details className="group mt-2 overflow-hidden rounded-lg border bg-secondary/60" key={bi}>
                    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 select-none hover:bg-sidebar-accent [&::-webkit-details-marker]:hidden">
                      <span
                        className={cn(
                          'size-[7px] shrink-0 rounded-full',
                          b.status === 'ok' && 'bg-success',
                          b.status === 'error' && 'bg-destructive',
                          b.status === 'pending' && 'animate-pulse bg-faint',
                          b.status === 'canceled' && 'bg-faint',
                        )}
                      />
                      <span className="shrink-0 font-mono text-xs font-medium">{b.name}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{toolSummary(b.input)}</span>
                    </summary>
                    <div className="border-t">
                      {toolDetail(b.input) !== '' && (
                        <pre className="max-h-60 overflow-auto bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{toolDetail(b.input)}</pre>
                      )}
                      {b.result !== null && b.result !== '' && (
                        <pre
                          className={cn(
                            'max-h-60 overflow-auto border-t bg-sunken px-2.5 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap first:border-t-0',
                            b.status === 'error' && 'text-destructive',
                          )}
                        >{b.result}</pre>
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
