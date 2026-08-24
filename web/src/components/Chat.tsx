/**
 * 对话流：白底阅读面，内容列居中 max-w-[760px]。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 文本段 + 工具行交错。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronRight, LoaderCircle, Sparkles } from 'lucide-react'
import type { ChatMsg, ImageRef, ToolSeg, TurnStatus } from '../types'
import { formatElapsedMs } from '../lib/format'
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

/**
 * 思考块（M47，参考实现移植）：实时和历史同一个组件。
 * 实时 = spinner 图块 + shimmer「思考中」；结束带时长 =「已深度思考（用时 N 秒）」；
 * 历史（无时长）=「思考过程」。正文用 grid-rows 折叠动画 + 上下渐隐遮罩。
 */
function ThinkingBlock({
  text, streaming = false, seconds,
}: { text: string; streaming?: boolean; seconds?: number | undefined }) {
  const [open, setOpen] = useState(false)
  const label = streaming
    ? t('thinkingLive')
    : seconds !== undefined
      ? t('thoughtFor', { s: seconds })
      : t('thoughtProcess')
  return (
    <div className="mt-2">
      <button
        className="flex cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 pl-0.5 text-[13px] select-none hover:bg-secondary/60"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-md border',
            streaming ? 'border-primary text-primary' : 'bg-background text-muted-foreground',
          )}
        >
          {streaming ? <LoaderCircle className="cc-icon-spin size-3.5" /> : <Sparkles className="size-3.5" />}
        </span>
        <span className={cn('font-medium text-muted-foreground', streaming && 'shimmer-text')}>{label}</span>
        <ChevronRight className={cn('size-3 text-faint transition-transform duration-150', open && 'rotate-90')} />
      </button>
      <div className={cn('cc-collapsible', open && 'open')}>
        <div>
          <div className="cc-thinking-body pt-1 pb-2 pl-8 text-[13px] leading-[1.7] break-words whitespace-pre-wrap text-muted-foreground">
            {text}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 回合状态 footer（M47，参考实现移植）：绿点脉冲 + 状态词 + 实时计时；
 * 结束后落成「已完成 · 12.3s · 843 输出 · $0.0123」。只挂在当前回合下。
 */
function TurnFooter({ turn }: { turn: TurnStatus }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!turn.running) return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [turn.running])
  if (!turn.running && turn.stats === null) return null
  const elapsed = turn.running
    ? turn.startedAt !== null ? formatElapsedMs(Math.max(0, now - turn.startedAt)) : ''
    : turn.stats !== null ? formatElapsedMs(turn.stats.durationMs) : ''
  const label = turn.running
    ? turn.preparing ? t('statusPreparing') : t('workingLabel')
    : t('doneLabel')
  const cost =
    turn.stats?.costUsd != null && turn.stats.costUsd > 0 ? ` · $${turn.stats.costUsd.toFixed(4)}` : ''
  const out = turn.stats?.outputTokens != null ? ` · ${t('outTokens', { n: turn.stats.outputTokens })}` : ''
  return (
    <div className="mt-2 flex items-center gap-1.5 self-start text-[11px] text-faint">
      <span className={cn('size-[5px] shrink-0 rounded-full', turn.running ? 'cc-dot-active bg-success' : 'bg-faint')} />
      <span className={cn(turn.running && turn.preparing && 'shimmer-text')}>{label}</span>
      <span className="tabular-nums">{elapsed}{out}{cost}</span>
    </div>
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


interface Props {
  messages: ChatMsg[]
  streamText: string
  streamThinking: string
  turn: TurnStatus
  sessionId: string
}

export function Chat({ messages, streamText, streamThinking, turn, sessionId }: Props) {
  useLang()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamThinking, turn.running])

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
            {streamThinking !== '' && <ThinkingBlock streaming text={streamThinking} />}
            {streamText !== '' && (
              <div className="text-[15px] leading-relaxed break-words">
                <Markdown text={streamText} />
              </div>
            )}
          </div>
        )}
        <TurnFooter turn={turn} />
      </div>
    </div>
  )
}
