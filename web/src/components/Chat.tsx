/**
 * 对话流：白底阅读面，内容列居中 max-w-[760px]。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 文本段 + 工具行交错。
 */
import { useEffect, useRef } from 'react'
import type { ChatMsg, ToolSeg } from '../types'
import { textOfSegments } from '../lib/segments'
import { Markdown } from './Markdown'
import { SidechainBlock } from './SidechainBlock'
import { cn } from '@/lib/utils'

function ToolRow({ seg }: { seg: ToolSeg }) {
  const expandable = (seg.detail !== '' && seg.detail !== '{}') || (seg.result !== null && seg.result !== '')
  return (
    <details className="group mt-2 overflow-hidden rounded-lg border bg-secondary/60">
      <summary
        className={cn(
          'flex min-w-0 list-none items-center gap-2 px-2.5 py-1.5 select-none [&::-webkit-details-marker]:hidden',
          expandable ? 'cursor-pointer hover:bg-sidebar-accent' : 'cursor-default',
        )}
      >
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
        {seg.subCount > 0 && (
          <span className="shrink-0 rounded-full bg-accent px-2 text-xs text-accent-foreground">
            子代理 {seg.subCount} 条
          </span>
        )}
      </summary>
      {expandable && (
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
      )}
    </details>
  )
}

interface Props {
  messages: ChatMsg[]
  streamText: string
  sessionId: string
}

export function Chat({ messages, streamText, sessionId }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
      <div className="mx-auto flex max-w-[760px] flex-col px-4 pt-4 pb-5">
        {messages.length === 0 && streamText === '' && (
          <div className="m-auto py-12 text-center text-[13px] text-faint">
            还没有消息 —— 在下方输入开始对话
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="mt-4 flex flex-col items-end first:mt-0" key={m.key}>
              <div className="max-w-[78%] rounded-2xl rounded-br-md border border-accent-bd bg-accent px-[15px] py-[11px] text-[15px] leading-normal break-words whitespace-pre-wrap shadow-xs">
                {textOfSegments(m.segments)}
              </div>
            </div>
          ) : (
            <div className="mt-2.5 max-w-[94%] self-start" key={m.key}>
              {m.segments.map((seg, i) =>
                seg.kind === 'text' ? (
                  m.role === 'error' ? (
                    <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-destructive" key={i}>
                      {seg.text}
                    </div>
                  ) : (
                    <div className="text-[15px] leading-relaxed break-words" key={i}>
                      <Markdown text={seg.text} />
                    </div>
                  )
                ) : (
                  <div key={i}>
                    <ToolRow seg={seg} />
                    {seg.agent !== null && (
                      <SidechainBlock
                        fetchPath={`/api/v1/sessions/${sessionId}/subagents/${seg.agent.id}`}
                        label={seg.agent.label}
                      />
                    )}
                  </div>
                ),
              )}
              {m.sidechain !== null && (
                <SidechainBlock
                  fetchPath={`/api/v1/sessions/${sessionId}/sidechains/${m.sidechain.uuid}`}
                  label={`子代理 · ${m.sidechain.count} 条`}
                />
              )}
              {m.meta !== null && <div className="mt-1 text-xs text-faint">{m.meta}</div>}
            </div>
          ),
        )}
        {streamText !== '' && (
          <div className="mt-2.5 max-w-[94%] self-start">
            <div className="text-[15px] leading-relaxed break-words">
              <Markdown text={streamText} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
