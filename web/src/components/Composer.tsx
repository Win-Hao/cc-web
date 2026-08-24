/**
 * Composer：大圆角卡片 + 焦点环（同类项目 Composer.vue .composer-card），
 * 右下圆形发送键；运行中变成红色停止键（发 interrupt）。
 */
import { useRef, useState } from 'react'
import { SendIcon, StopIcon } from './icons'

interface Props {
  disabled: boolean
  running: boolean
  onSend: (text: string) => void
  onInterrupt: () => void
}

export function Composer({ disabled, running, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    const t = text.trim()
    if (t === '' || disabled || running) return
    setText('')
    const ta = taRef.current
    if (ta !== null) ta.style.height = 'auto'
    onSend(t)
  }

  return (
    <div className="dock">
      <div className="composer-card">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? '先选择一个会话' : '发消息… (Enter 发送，Shift+Enter 换行)'}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        {running ? (
          <button className="send-btn stop" title="中断" onClick={onInterrupt}>
            <StopIcon />
          </button>
        ) : (
          <button className="send-btn" title="发送" disabled={disabled || text.trim() === ''} onClick={send}>
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}
