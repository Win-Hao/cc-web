/**
 * Composer：大圆角卡片 + 焦点环（同类项目），右下圆形发送键；
 * 运行中变红色停止键（发 interrupt）。
 */
import { useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
    <div className="px-4 pt-2 pb-3">
      <div className="relative mx-auto max-w-[760px] rounded-[28px] border bg-background shadow-md transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring">
        <Textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? '先选择一个会话' : '发消息… (Enter 发送，Shift+Enter 换行)'}
          className="max-h-40 py-3 pr-[56px] pl-4"
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
          <Button
            size="icon"
            variant="destructive"
            title="中断"
            className="absolute right-2 bottom-2"
            onClick={onInterrupt}
          >
            <Square className="size-3 fill-current" />
          </Button>
        ) : (
          <Button
            size="icon"
            title="发送"
            className="absolute right-2 bottom-2"
            disabled={disabled || text.trim() === ''}
            onClick={send}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
