/**
 * 对话流：白底阅读面，内容列居中 max-w-[760px]。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 文本段 + 工具行交错。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Ban, Check, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react'
import type { ChatMsg, ImageRef, StreamTool, ToolSeg, TurnStatus } from '../types'
import { formatElapsedMs } from '../lib/format'
import { textOfSegments } from '../lib/segments'
import { Markdown } from './Markdown'
import { SidechainBlock } from './SidechainBlock'
import { cn } from '@/lib/utils'
import { t, useLang } from '../lib/i18n'

/** 点击缩略图 → 灯箱放大（M53）。Provider 挂在 Chat 根上。 */
const LightboxCtx = createContext<(img: ImageRef) => void>(() => {})

function Thumb({ image }: { image: ImageRef }) {
  const open = useContext(LightboxCtx)
  return (
    <img
      alt=""
      className="max-h-72 max-w-full cursor-zoom-in rounded-lg border object-contain transition-opacity hover:opacity-90"
      src={`data:${image.mediaType};base64,${image.data}`}
      onClick={(e) => {
        e.stopPropagation()
        open(image)
      }}
    />
  )
}

/** 全屏灯箱：点任意处 / Esc 关闭 */
function Lightbox({ image, onClose }: { image: ImageRef; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <img
        alt=""
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        src={`data:${image.mediaType};base64,${image.data}`}
      />
    </div>
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

/* ── 工具卡片（M48，参考实现移植）────────────────────────────
 * 每个工具族一个动词标题 + 关键元信息；24px 状态块 spinner/✓/✕；
 * 运行中标题 shimmer；连续同族调用折叠成组卡「搜索 ×3, 完成」。 */

type ToolFamily = 'run' | 'read' | 'edit' | 'write' | 'search' | 'fetch' | 'todo' | 'other'

function toolFamily(name: string): ToolFamily {
  if (name === 'Bash') return 'run'
  if (name === 'Read') return 'read'
  if (name === 'Edit') return 'edit'
  if (name === 'Write' || name === 'NotebookEdit') return 'write'
  if (name === 'Grep' || name === 'Glob' || name === 'WebSearch') return 'search'
  if (name === 'WebFetch') return 'fetch'
  if (name === 'TodoWrite') return 'todo'
  return 'other'
}

const FAMILY_KEY: Record<Exclude<ToolFamily, 'other'>, 'toolRun' | 'toolRead' | 'toolEdit' | 'toolWrite' | 'toolSearch' | 'toolFetch' | 'toolTodos'> = {
  run: 'toolRun', read: 'toolRead', edit: 'toolEdit', write: 'toolWrite',
  search: 'toolSearch', fetch: 'toolFetch', todo: 'toolTodos',
}

function familyTitle(seg: ToolSeg): string {
  const fam = toolFamily(seg.name)
  if (fam !== 'other') return t(FAMILY_KEY[fam])
  // MCP 工具名去前缀、下划线转空格:mcp__media__generate → media generate
  return seg.name.startsWith('mcp__') ? seg.name.slice(5).replace(/__/g, ' ').replace(/_/g, ' ') : seg.name
}

/** family 相关的元信息：文件名 / pattern / url / 命令…；带结果统计 */
function toolMeta(seg: ToolSeg): { main: string; stat: string; italic: boolean } {
  const fam = toolFamily(seg.name)
  const i = (typeof seg.input === 'object' && seg.input !== null ? seg.input : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const base = (path: string): string => path.split('/').pop() ?? path
  const lines = seg.result === null || seg.result === '' ? 0 : seg.result.split('\n').length
  if (fam === 'read') {
    return { main: base(str('file_path') || str('path')), stat: seg.status === 'ok' && lines > 0 ? t('toolLines', { n: lines }) : '', italic: false }
  }
  if (fam === 'edit' || fam === 'write') return { main: base(str('file_path') || str('path')), stat: '', italic: false }
  if (fam === 'search') {
    const main = str('pattern') || str('query')
    const path = str('path')
    return { main: path !== '' ? `${main}  ${base(path)}` : main, stat: seg.status === 'ok' && lines > 0 ? t('toolResults', { n: lines }) : '', italic: false }
  }
  if (fam === 'fetch') return { main: str('url'), stat: '', italic: false }
  if (fam === 'run') {
    const desc = str('description')
    if (desc !== '') return { main: desc, stat: '', italic: true }
    return { main: str('command').replace(/\s+/g, ' '), stat: '', italic: false }
  }
  const desc = str('description')
  if (desc !== '') return { main: desc, stat: '', italic: true }
  return { main: seg.summary, stat: '', italic: false }
}

/** 流式工具占位（M50）：入参 JSON 还没停,能解析多少解析多少 */
function partialToolInput(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    /* 还没闭合,退回逐字段抽取 */
  }
  const out: Record<string, unknown> = {}
  for (const k of ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'path', 'skill', 'prompt']) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json)
    if (m !== null) out[k] = m[1]!.replace(/\\n/g, ' ').replace(/\\"/g, '"')
  }
  return out
}

function streamToolSeg(st: StreamTool): ToolSeg {
  return {
    kind: 'tool', id: null, name: st.name, summary: '', detail: '',
    input: partialToolInput(st.json), status: 'pending', result: null,
    images: [], subCount: 0, agent: null,
  }
}

function StatusTile({ status, pending }: { status: ToolSeg['status']; pending: boolean }) {
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md border bg-background',
        pending
          ? 'border-primary text-primary'
          : status === 'error'
            ? 'text-destructive'
            : status === 'canceled'
              ? 'text-faint'
              : 'text-success',
      )}
    >
      {pending ? (
        <LoaderCircle className="cc-icon-spin size-3.5" />
      ) : status === 'error' ? (
        <X className="size-3.5" />
      ) : status === 'canceled' ? (
        <Ban className="size-3.5" />
      ) : (
        <Check className="size-3.5" />
      )}
    </span>
  )
}

/** TodoWrite 专属清单卡（M48）：进行中高亮，收起时显示当前项 */
function TodoCard({ seg }: { seg: ToolSeg }) {
  const todos = (() => {
    const i = (typeof seg.input === 'object' && seg.input !== null ? seg.input : {}) as Record<string, unknown>
    if (!Array.isArray(i.todos)) return []
    return i.todos.filter((x): x is { content?: string; status?: string; activeForm?: string } =>
      typeof x === 'object' && x !== null,
    )
  })()
  const hasActive = todos.some((td) => td.status === 'in_progress' || td.status === 'pending')
  const [override, setOverride] = useState<boolean | null>(null)
  const open = override ?? hasActive
  if (todos.length === 0) return <PlainToolCard seg={seg} />
  const current = todos.find((td) => td.status === 'in_progress')
  const done = todos.filter((td) => td.status === 'completed' || td.status === 'in_progress').length
  return (
    <div className="mt-2 overflow-hidden rounded-lg border bg-secondary/40">
      <button
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[13px] select-none hover:bg-sidebar-accent"
        onClick={() => setOverride(!open)}
      >
        <StatusTile pending={seg.status === 'pending'} status={seg.status} />
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-foreground uppercase">{t('toolTodos')}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{done}/{todos.length}</span>
        {!open && current !== undefined && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{current.activeForm ?? current.content}</span>
        )}
        <ChevronRight className={cn('ml-auto size-3 shrink-0 text-faint transition-transform duration-150', open && 'rotate-90')} />
      </button>
      <div className={cn('cc-collapsible', open && 'open')}>
        <div>
          <ul className="flex flex-col gap-px px-2 pt-1 pb-2 text-xs">
            {todos.map((td, i) => (
              <li
                className={cn(
                  'flex items-start gap-2 rounded-md border border-transparent px-2 py-1 leading-relaxed',
                  td.status === 'in_progress' && 'border-accent-bd bg-accent',
                )}
                key={i}
              >
                <span
                  className={cn(
                    'w-4 shrink-0 text-center font-mono',
                    td.status === 'completed' ? 'text-success' : td.status === 'in_progress' ? 'text-primary' : 'text-faint',
                  )}
                >
                  {td.status === 'completed' ? '✓' : td.status === 'in_progress' ? '◐' : '○'}
                </span>
                <span
                  className={cn(
                    td.status === 'completed' && 'text-muted-foreground line-through decoration-border',
                    td.status === 'in_progress' && 'font-medium',
                  )}
                >
                  {td.status === 'in_progress' && td.activeForm != null ? td.activeForm : td.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/** 单个工具卡：动词标题 + 元信息 + 统计；展开看入参/输出/截图 */
function PlainToolCard({ seg }: { seg: ToolSeg }) {
  const [open, setOpen] = useState(false)
  const pending = seg.status === 'pending'
  const meta = toolMeta(seg)
  const expandable =
    (seg.detail !== '' && seg.detail !== '{}') || (seg.result !== null && seg.result !== '') || seg.images.length > 0
  return (
    <div className="cc-tool-row mt-2">
      <button
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-0.5 pr-2 pl-0.5 text-left select-none',
          expandable ? 'cursor-pointer hover:bg-secondary/60' : 'cursor-default',
        )}
        onClick={() => expandable && setOpen((o) => !o)}
      >
        <StatusTile pending={pending} status={seg.status} />
        <span
          className={cn(
            'shrink-0 text-[11px] font-medium tracking-wide text-foreground',
            !seg.name.startsWith('mcp__') && 'uppercase',
            pending && 'shimmer-text',
          )}
        >
          {familyTitle(seg)}
        </span>
        {meta.main !== '' && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs text-muted-foreground',
              meta.italic ? 'italic' : toolFamily(seg.name) === 'run' && 'font-mono',
            )}
          >
            {meta.main}
          </span>
        )}
        {seg.subCount > 0 && (
          <span className="shrink-0 rounded-full bg-accent px-2 text-xs text-accent-foreground">
            {t('subagentBadge', { n: seg.subCount })}
          </span>
        )}
        {meta.stat !== '' && <span className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">{meta.stat}</span>}
        {expandable && (
          <ChevronRight className={cn('shrink-0 size-3 text-faint transition-transform duration-150', open && 'rotate-90', meta.stat === '' && 'ml-auto')} />
        )}
      </button>
      <div className={cn('cc-collapsible', open && 'open')}>
        <div>
          <div className="mt-1 ml-8 flex flex-col gap-1.5 overflow-hidden rounded-lg border">
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
        </div>
      </div>
    </div>
  )
}

function ToolRow({ seg }: { seg: ToolSeg }) {
  if (toolFamily(seg.name) === 'todo') return <TodoCard seg={seg} />
  return <PlainToolCard seg={seg} />
}

/** 同族分组卡（M48）：「搜索 ×3, 完成」，运行中 shimmer，展开看每个调用 */
function ToolGroupCard({ segs, children }: { segs: ToolSeg[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const running = segs.some((sg) => sg.status === 'pending')
  const hasError = segs.some((sg) => sg.status === 'error')
  const hasCanceled = segs.some((sg) => sg.status === 'canceled')
  const verb = familyTitle(segs[0]!)
  const tail = hasError
    ? t('toolError')
    : running
      ? t('toolRunning')
      : hasCanceled
        ? t('toolCanceled')
        : t('toolDone')
  return (
    <div className="mt-2">
      <button
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 pr-2 pl-0.5 text-left text-[13px] select-none hover:bg-secondary/60"
        onClick={() => setOpen((o) => !o)}
      >
        <StatusTile pending={running} status={hasError ? 'error' : hasCanceled ? 'canceled' : 'ok'} />
        <span className={cn('min-w-0 flex-1 truncate font-medium text-muted-foreground', running && 'shimmer-text')}>
          {`${verb} ×${segs.length}, ${tail}`}
        </span>
        <ChevronRight className={cn('size-3 shrink-0 text-faint transition-transform duration-150', open && 'rotate-90')} />
      </button>
      <div className={cn('cc-collapsible', open && 'open')}>
        <div>
          <div className="ml-8">{children}</div>
        </div>
      </div>
    </div>
  )
}


interface Props {
  messages: ChatMsg[]
  streamText: string
  streamThinking: string
  streamTools: StreamTool[]
  turn: TurnStatus
  sessionId: string
  /** 还有更早的历史页（M51） */
  hasEarlier: boolean
  onLoadEarlier: () => void
}

type RenderItem =
  | { kind: 'msg'; m: ChatMsg }
  | { kind: 'toolgroup'; key: string; family: ToolFamily; msgs: ChatMsg[] }

/** 连续的「纯工具、同族、无 sidechain 锚」assistant 消息 → 一组（M48） */
function buildRenderItems(messages: ChatMsg[]): RenderItem[] {
  const out: RenderItem[] = []
  for (const m of messages) {
    const toolOnly =
      m.role === 'assistant' &&
      m.sidechain === null &&
      m.segments.length > 0 &&
      m.segments.every((sg) => sg.kind === 'tool')
    const fam = toolOnly ? toolFamily((m.segments[0] as ToolSeg).name) : null
    const uniform = toolOnly && m.segments.every((sg) => toolFamily((sg as ToolSeg).name) === fam)
    // TodoWrite 有专属卡，不进组
    if (uniform && fam !== null && fam !== 'todo') {
      const last = out[out.length - 1]
      if (last !== undefined && last.kind === 'toolgroup' && last.family === fam) {
        last.msgs.push(m)
        continue
      }
      out.push({ kind: 'toolgroup', key: m.key, family: fam, msgs: [m] })
      continue
    }
    out.push({ kind: 'msg', m })
  }
  // 只有一条消息且只有一个调用的「组」还原成普通消息
  return out.map((it) =>
    it.kind === 'toolgroup' && it.msgs.length === 1 && it.msgs[0]!.segments.length === 1
      ? { kind: 'msg' as const, m: it.msgs[0]! }
      : it,
  )
}

/**
 * 已工作折叠（M49）：一轮里的思考+工具收进「已工作 Ns」头部，只留最终
 * 回答在外面。正在跑的那一轮不收（过程实时可见），跑完自动收起。
 */
interface TurnNode {
  kind: 'turn'
  key: string
  work: RenderItem[]
  finals: RenderItem[]
  seconds: number | null
  /** 有工具停在 pending（中断/取消的轮）→ 头部显示「已取消」 */
  canceled: boolean
}
type Node = RenderItem | TurnNode

function buildNodes(items: RenderItem[], liveTailOpen: boolean): Node[] {
  const nodes: Node[] = []
  let userTs: number | null = null
  let buf: RenderItem[] = []

  const flush = (open: boolean) => {
    if (buf.length === 0) return
    const acc = buf
    buf = []
    // 最终回答 = 最后一个带 text/image 段的普通 assistant 消息；
    // 它里面的 thinking 段仍归入「已工作」
    let finalIdx = -1
    for (let i = acc.length - 1; i >= 0; i--) {
      const it = acc[i]!
      if (it.kind === 'msg' && it.m.segments.some((sg) => sg.kind === 'text' || sg.kind === 'image')) {
        finalIdx = i
        break
      }
    }
    const work: RenderItem[] = []
    const finals: RenderItem[] = []
    acc.forEach((it, i) => {
      if (i !== finalIdx) {
        work.push(it)
        return
      }
      const m = (it as { m: ChatMsg }).m
      const thinkSegs = m.segments.filter((sg) => sg.kind === 'thinking')
      if (thinkSegs.length > 0) {
        work.push({ kind: 'msg', m: { ...m, key: `${m.key}-think`, segments: thinkSegs, meta: null, sidechain: null } })
      }
      finals.push({ kind: 'msg', m: { ...m, segments: m.segments.filter((sg) => sg.kind !== 'thinking') } })
    })
    if (work.length === 0 || open) {
      // 没有过程,或这一轮还在跑 → 平铺
      nodes.push(...work, ...finals)
      return
    }
    let endTs: number | null = null
    for (let i = acc.length - 1; i >= 0 && endTs === null; i--) {
      const it = acc[i]!
      const ms = it.kind === 'msg' ? [it.m] : it.msgs
      for (let j = ms.length - 1; j >= 0 && endTs === null; j--) endTs = ms[j]!.ts
    }
    const seconds =
      userTs !== null && endTs !== null && endTs > userTs ? Math.max(1, Math.round((endTs - userTs) / 1000)) : null
    const canceled = work.some((it) => {
      const msgs = it.kind === 'msg' ? [it.m] : it.msgs
      return msgs.some((wm) =>
        wm.segments.some((sg) => sg.kind === 'tool' && (sg.status === 'pending' || sg.status === 'canceled')),
      )
    })
    nodes.push({ kind: 'turn', key: `turn-${acc[0]!.kind === 'msg' ? acc[0]!.m.key : acc[0]!.key}`, work, finals, seconds, canceled })
  }

  items.forEach((it, i) => {
    const isUser = it.kind === 'msg' && it.m.role === 'user'
    const isError = it.kind === 'msg' && it.m.role === 'error'
    if (isUser || isError) {
      flush(false)
      nodes.push(it)
      if (isUser) userTs = (it as { m: ChatMsg }).m.ts
      return
    }
    buf.push(it)
    if (i === items.length - 1) flush(liveTailOpen)
  })
  flush(false)
  return nodes
}

function WorkedTurn({ node, children }: { node: TurnNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2.5 max-w-[94%] self-start">
      <button
        className="flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground select-none hover:bg-secondary/60 hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {node.canceled
          ? node.seconds !== null ? t('canceledFor', { s: formatElapsedMs(node.seconds * 1000) }) : t('canceledPlain')
          : node.seconds !== null ? t('workedFor', { s: formatElapsedMs(node.seconds * 1000) }) : t('workedPlain')}
        <ChevronRight className={cn('size-3 text-faint transition-transform duration-150', open && 'rotate-90')} />
      </button>
      <div className={cn('cc-collapsible', open && 'open')}>
        <div>
          <div className="border-l-2 border-border pl-3">{children}</div>
        </div>
      </div>
    </div>
  )
}

export function Chat({
  messages, streamText, streamThinking, streamTools, turn, sessionId, hasEarlier, onLoadEarlier,
}: Props) {
  useLang()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState<ImageRef | null>(null)
  /** 是否贴底（M56）：只有贴底才自动跟随新消息；上翻时出「最新消息」按钮 */
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  /** 当前视口对应的用户消息锚点（M59 右侧锚点轨） */
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null)
  /** 前插锚点（M51）：点「加载更早」时记录滚动位置，插完还原，不跳底 */
  const prependRef = useRef<{ h: number; top: number } | null>(null)
  const nodes = useMemo(
    () => buildNodes(buildRenderItems(messages), turn.running),
    [messages, turn.running],
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    if (prependRef.current !== null) {
      el.scrollTop = el.scrollHeight - prependRef.current.h + prependRef.current.top
      prependRef.current = null
      return
    }
    // 用户上翻阅读时不抢滚动位置（M56）；贴底才跟随
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamThinking, streamTools.length, turn.running])

  const onScroll = () => {
    const el = scrollRef.current
    if (el === null) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    atBottomRef.current = near
    setAtBottom(near)
    // 锚点轨（M59）：视口上沿附近的最后一条用户消息 = 当前所在段落
    const top = el.getBoundingClientRect().top
    let current: string | null = null
    for (const node of el.querySelectorAll('[data-umsg]')) {
      if (node.getBoundingClientRect().top - top <= 120) current = node.getAttribute('data-umsg')
      else break
    }
    setActiveAnchor(current)
  }

  // 消息变化后重算一次锚点(初次加载/翻页)
  useEffect(() => {
    onScroll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  const jumpToAnchor = (key: string) => {
    const el = scrollRef.current?.querySelector(`[data-umsg="${key}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (el === null) return
    atBottomRef.current = true
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const renderItem = (it: RenderItem): React.ReactNode => {
    if (it.kind === 'toolgroup') {
      const segs = it.msgs.flatMap((gm) => gm.segments.filter((sg): sg is ToolSeg => sg.kind === 'tool'))
      return (
        <div className="mt-0.5 max-w-[94%] self-start" key={it.key}>
          <ToolGroupCard segs={segs}>
            {it.msgs.map((gm) =>
              gm.segments.map((seg, i) =>
                seg.kind === 'tool' ? (
                  <div key={`${gm.key}-${i}`}>
                    <ToolRow seg={seg} />
                    {seg.agent !== null && (
                      <SidechainBlock
                        fetchPath={`/api/v1/sessions/${sessionId}/subagents/${seg.agent.id}`}
                        label={seg.agent.label}
                      />
                    )}
                  </div>
                ) : null,
              ),
            )}
          </ToolGroupCard>
        </div>
      )
    }
    const m = it.m
    return m.role === 'user' ? (
      <div className="mt-4 flex scroll-mt-2 flex-col items-end gap-2 first:mt-0" data-umsg={m.key} key={m.key}>
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
        {m.meta !== null && !m.segments.every((sg) => sg.kind === 'tool') && (
          <div className="mt-1 text-xs text-faint">{m.meta}</div>
        )}
      </div>
    )
  }

  return (
    <LightboxCtx.Provider value={setLightbox}>
    <div className="relative min-h-0 flex-1">
    <div className="h-full overflow-y-auto" onScroll={onScroll} ref={scrollRef}>
      <div className="mx-auto flex max-w-[760px] flex-col px-4 pt-4 pb-5">
        {hasEarlier && (
          <button
            className="mx-auto mb-2 cursor-pointer rounded-full border px-4 py-1 text-xs text-muted-foreground select-none hover:bg-secondary/60 hover:text-foreground"
            onClick={() => {
              const el = scrollRef.current
              if (el !== null) prependRef.current = { h: el.scrollHeight, top: el.scrollTop }
              onLoadEarlier()
            }}
          >
            {t('loadEarlier')}
          </button>
        )}
        {messages.length === 0 && streamText === '' && streamThinking === '' && streamTools.length === 0 && (
          <div className="m-auto py-12 text-center text-[13px] text-faint">
            {t('draftHint')}
          </div>
        )}
        {nodes.map((node) =>
          node.kind === 'turn' ? (
            <div key={node.key}>
              <WorkedTurn node={node}>{node.work.map(renderItem)}</WorkedTurn>
              {node.finals.map(renderItem)}
            </div>
          ) : (
            renderItem(node)
          ),
        )}
        {(streamText !== '' || streamThinking !== '' || streamTools.length > 0) && (
          <div className="mt-2.5 max-w-[94%] self-start">
            {streamThinking !== '' && <ThinkingBlock streaming text={streamThinking} />}
            {streamText !== '' && (
              <div className="cc-stream-cursor text-[15px] leading-relaxed break-words">
                <Markdown text={streamText} />
              </div>
            )}
            {streamTools.map((st) => (
              <PlainToolCard key={st.index} seg={streamToolSeg(st)} />
            ))}
          </div>
        )}
        <TurnFooter turn={turn} />
      </div>
    </div>
    {(() => {
      const anchors = messages.filter((m) => m.role === 'user')
      if (anchors.length < 2) return null
      return (
        <div className="absolute top-1/2 left-[min(calc(50%+396px),calc(100%-20px))] z-10 flex max-h-[70%] -translate-y-1/2 flex-col items-center gap-[5px] overflow-hidden">
          {anchors.map((m) => (
            <button
              className={cn(
                'h-[3px] shrink-0 cursor-pointer rounded-full transition-all',
                m.key === activeAnchor ? 'w-4 bg-primary' : 'w-3 bg-border hover:bg-muted-foreground',
              )}
              key={m.key}
              title={textOfSegments(m.segments).slice(0, 48)}
              onClick={() => jumpToAnchor(m.key)}
            />
          ))}
        </div>
      )
    })()}
    {!atBottom && (
      <button
        className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border bg-background/90 px-3.5 py-1.5 text-xs text-muted-foreground shadow-md backdrop-blur select-none hover:bg-secondary hover:text-foreground"
        onClick={jumpToBottom}
      >
        <ArrowDown className="size-3.5" />
        {t('backToLatest')}
      </button>
    )}
    </div>
    {lightbox !== null && <Lightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </LightboxCtx.Provider>
  )
}
