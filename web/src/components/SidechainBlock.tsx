/**
 * subagent 消息组（M17）：锚点消息下的「子代理 · N 条」，点开懒加载
 * /sidechains/:uuid，嵌套渲染同一套段模型（工具行也照常配对）。
 */
import { useState } from 'react'
import { api } from '../lib/api'
import { segmentsFromContent, textOfSegments, toolResultsFromContent } from '../lib/segments'
import type { HistoryMessage, Segment, ToolSeg } from '../types'
import { Markdown } from './Markdown'

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
  /** 懒加载的接口路径：旧格式 /sidechains/:uuid，新格式 /subagents/:agentId */
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
    <div className="side-block">
      <button className="side-toggle" onClick={toggle}>
        <span className="side-arrow">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && (
        <div className="side-msgs">
          {failed && <div className="side-note">加载失败</div>}
          {!failed && msgs === null && <div className="side-note">加载中…</div>}
          {msgs?.map((m, i) => (
            <div className={m.role === 'user' ? 'side-msg user' : 'side-msg'} key={i}>
              {m.segments.map((seg, si) =>
                seg.kind === 'text' ? (
                  m.role === 'user' ? (
                    <div className="side-user" key={si}>{seg.text}</div>
                  ) : (
                    <div className="msg" key={si}><Markdown text={seg.text} /></div>
                  )
                ) : (
                  <details className={`tool-row ${seg.status}`} key={si}>
                    <summary>
                      <span className="tool-status" />
                      <span className="tool-name">{seg.name}</span>
                      <span className="tool-sum">{seg.summary}</span>
                    </summary>
                    <div className="tool-detail">
                      {seg.detail !== '' && seg.detail !== '{}' && <pre>{seg.detail}</pre>}
                      {seg.result !== null && seg.result !== '' && (
                        <pre className={seg.status === 'error' ? 'tool-out err' : 'tool-out'}>{seg.result}</pre>
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
