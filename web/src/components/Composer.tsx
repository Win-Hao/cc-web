/**
 * Composer：上方输入区，底部一行 = 权限模式（左）+
 * 模型胶囊 + 圆形发送键（右）；运行中发送键变红色停止键。
 */
import { useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ModelPicker } from './ModelPicker'
import type { ModelOption } from '../types'

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

interface Props {
  disabled: boolean
  running: boolean
  onSend: (text: string) => void
  onInterrupt: () => void
  permMode: string
  onPermMode: (mode: string) => void
  models: ModelOption[]
  modelValue: string | null
  modelResolved: string | null
  effort: string | null
  onModel: (value: string) => void
  onEffort: (level: string) => void
}

export function Composer({
  disabled, running, onSend, onInterrupt,
  permMode, onPermMode, models, modelValue, modelResolved, effort, onModel, onEffort,
}: Props) {
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
      <div className="mx-auto max-w-[760px] rounded-[24px] border bg-background shadow-md transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring">
        <Textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? '先选择一个会话' : '发消息… (Enter 发送，Shift+Enter 换行)'}
          className="max-h-40 px-4 pt-3 pb-1"
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
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <Select value={permMode} onValueChange={onPermMode}>
            <SelectTrigger
              className={cn(
                'h-7 rounded-full border-0 bg-transparent px-2.5 hover:bg-sidebar-accent',
                permMode === 'bypassPermissions' && 'text-destructive',
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODES.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex-1" />
          <ModelPicker
            models={models}
            modelValue={modelValue}
            modelResolved={modelResolved}
            effort={effort}
            onModel={onModel}
            onEffort={onEffort}
          />
          {running ? (
            <Button size="icon" variant="destructive" title="中断" onClick={onInterrupt}>
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button size="icon" title="发送" disabled={disabled || text.trim() === ''} onClick={send}>
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
