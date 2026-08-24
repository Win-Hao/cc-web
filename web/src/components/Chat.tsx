/**
 * 对话流：白底阅读面，内容列居中 max-w-[760px]。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 文本段 + 工具行交错。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChatMsg, ImageRef, ToolSeg } from '../types'
import { textOfSegments } from '../lib/segments'
import { Markdown } from './Markdown'
import { SidechainBlock } from './SidechainBlock'
import { cn } from '@/lib/utils'
import { t, useLang } from '../lib/i18n'

function Thumb({ image }: { image: ImageRef }) {
  return (
    <img
      alt=""
      className="max-h-72 max-w-full rounded-lg border object-contain"
      src={`data:${image.mediaType};base64,${image.data}`}
    />
  )
}

/** 折叠的思考过程：默认收起，muted 弱化，不抢正文视线 */
function ThinkingBlock({ text, seconds }: { text: string; seconds?: number | undefined }) {
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-xs text-faint select-none hover:text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
        {t('thoughtProcess')}
        {seconds !== undefined && <span className="text-faint"> · {seconds}s</span>}
      </summary>
      <div className="mt-1 border-l-2 border-border pl-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground italic">
        {text}
      </div>
    </details>
  )
}

function ToolRow({ seg }: { seg: ToolSeg }) {
  const expandable =
    (seg.detail !== '' && seg.detail !== '{}') || (seg.result !== null && seg.result !== '') || seg.images.length > 0
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
            {t('subagentBadge', { n: seg.subCount })}
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
          {seg.images.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t bg-sunken px-2.5 py-2 first:border-t-0">
              {seg.images.map((img, i) => (
                <Thumb image={img} key={i} />
              ))}
            </div>
          )}
        </div>
      )}
    </details>
  )
}

/** 实时思考行（M46）：折叠 + 每秒跳的计时，点开看流式思考文本 */
function LiveThinking({ text, startTs }: { text: string; startTs: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const secs = startTs !== null ? Math.max(1, Math.round((now - startTs) / 1000)) : null
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
        <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-faint" />
        {t('thinkingLive')}
        {secs !== null && <span className="text-faint">· {secs}s</span>}
        <span className="inline-block text-faint transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="mt-1.5 border-l-2 border-border pl-3 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground italic">
        {text}
      </div>
    </details>
  )
}

interface Props {
  messages: ChatMsg[]
  streamText: string
  streamThinking: string
  thinkingStart: number | null
  /** 引擎在跑但没有任何可见流（工具执行间隙等）→ 底部「工作中…」 */
  working: boolean
  sessionId: string
}

export function Chat({ messages, streamText, streamThinking, thinkingStart, working, sessionId }: Props) {
  useLang()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamThinking, working])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
      <div className="mx-auto flex max-w-[760px] flex-col px-4 pt-4 pb-5">
        {messages.length === 0 && streamText === '' && streamThinking === '' && (
          <div className="m-auto py-12 text-center text-[13px] text-faint">
            {t('draftHint')}
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="mt-4 flex flex-col items-end gap-2 first:mt-0" key={m.key}>
              {textOfSegments(m.segments) !== '' && (
                <div className="max-w-[78%] rounded-2xl rounded-br-md border border-accent-bd bg-accent px-[15px] py-[11px] text-[15px] leading-normal break-words whitespace-pre-wrap shadow-xs">
                  {textOfSegments(m.segments)}
                </div>
              )}
              {m.segments.filter((s) => s.kind === 'image').map((s, i) => (
                <Thumb image={s.image} key={i} />
              ))}
            </div>
          ) : (
            <div className="mt-2.5 max-w-[94%] self-start" key={m.key}>
              {m.segments.map((seg, i) =>
                seg.kind === 'thinking' ? (
                  <ThinkingBlock key={i} seconds={seg.seconds} text={seg.text} />
                ) : seg.kind === 'image' ? (
                  <div className="mt-2" key={i}>
                    <Thumb image={seg.image} />
                  </div>
                ) : seg.kind === 'text' ? (
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
                  label={t('subagentMsgs', { n: m.sidechain.count })}
                />
              )}
              {m.meta !== null && <div className="mt-1 text-xs text-faint">{m.meta}</div>}
            </div>
          ),
        )}
        {(streamText !== '' || streamThinking !== '') && (
          <div className="mt-2.5 max-w-[94%] self-start">
            {streamThinking !== '' && (
              <div className="mb-2">
                <LiveThinking startTs={thinkingStart} text={streamThinking} />
              </div>
            )}
            {streamText !== '' && (
              <div className="text-[15px] leading-relaxed break-words">
                <Markdown text={streamText} />
              </div>
            )}
          </div>
        )}
        {working && (
          <div className="mt-3 flex items-center gap-2 self-start text-[13px] text-muted-foreground">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-40" />
              <span className="relative inline-flex size-2.5 rounded-full bg-primary/70" />
            </span>
            {t('working')}
          </div>
        )}
      </div>
    </div>
  )
}
