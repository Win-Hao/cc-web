/**
 * 对话流：白底阅读面，内容列居中。
 * 用户消息 = 右对齐软 accent 气泡；助手消息 = 左对齐纯文本，无角色标签。
 */
import { useEffect, useRef } from 'react'
import type { ChatMsg } from '../types'

interface Props {
  messages: ChatMsg[]
  streamText: string
  hasSession: boolean
}

export function Chat({ messages, streamText, hasSession }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [messages, streamText])

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat">
        {!hasSession && <div className="chat-empty">从左侧选择一个会话开始</div>}
        {hasSession && messages.length === 0 && streamText === '' && (
          <div className="chat-empty">没有历史消息</div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div className="u-turn" key={m.key}>
              <div className="u-bub">{m.text}</div>
            </div>
          ) : (
            <div className={m.role === 'error' ? 'a-msg err' : 'a-msg'} key={m.key}>
              <div className="msg">{m.text}</div>
              {m.meta !== null && <div className="a-meta">{m.meta}</div>}
            </div>
          ),
        )}
        {streamText !== '' && (
          <div className="a-msg">
            <div className="msg">{streamText}</div>
          </div>
        )}
      </div>
    </div>
  )
}
