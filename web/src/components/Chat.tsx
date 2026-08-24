/**
 * 对话流：白底阅读面，内容列居中。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 文本段 + 工具行交错，
 * 工具行可展开看入参和结果（同类项目 ToolRow 的形状）。
 */
import { useEffect, useRef } from 'react'
import type { ChatMsg, ToolSeg } from '../types'
import { textOfSegments } from '../lib/segments'
import { Markdown } from './Markdown'
import { SidechainBlock } from './SidechainBlock'

function ToolRow({ seg }: { seg: ToolSeg }) {
  const expandable = seg.detail !== '' || (seg.result !== null && seg.result !== '')
  return (
    <details className={`tool-row ${seg.status}`}>
      <summary className={expandable ? '' : 'no-expand'}>
        <span className="tool-status" />
        <span className="tool-name">{seg.name}</span>
        <span className="tool-sum">{seg.summary}</span>
        {seg.subCount > 0 && <span className="tool-sub">子代理 {seg.subCount} 条</span>}
      </summary>
      {expandable && (
        <div className="tool-detail">
          {seg.detail !== '' && seg.detail !== '{}' && <pre>{seg.detail}</pre>}
          {seg.result !== null && seg.result !== '' && (
            <pre className={seg.status === 'error' ? 'tool-out err' : 'tool-out'}>{seg.result}</pre>
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
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat">
        {messages.length === 0 && streamText === '' && (
          <div className="chat-empty">还没有消息 —— 在下方输入开始对话</div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="u-turn" key={m.key}>
              <div className="u-bub">{textOfSegments(m.segments)}</div>
            </div>
          ) : (
            <div className={m.role === 'error' ? 'a-msg err' : 'a-msg'} key={m.key}>
              {m.segments.map((seg, i) =>
                seg.kind === 'text' ? (
                  m.role === 'error' ? (
                    <div className="msg" key={i}>{seg.text}</div>
                  ) : (
                    <div className="msg" key={i}><Markdown text={seg.text} /></div>
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
              {m.meta !== null && <div className="a-meta">{m.meta}</div>}
            </div>
          ),
        )}
        {streamText !== '' && (
          <div className="a-msg">
            <div className="msg"><Markdown text={streamText} /></div>
          </div>
        )}
      </div>
    </div>
  )
}
