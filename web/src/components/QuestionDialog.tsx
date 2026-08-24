/**
 * AskUserQuestion 交互卡（shadcn Dialog）：单选/多选选项 + 自由文本兜底；
 * 提交走 allow + updatedInput（sdk-tools.d.ts 的形状）。
 */
import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Approval } from '../types'

interface QOption {
  label: string
  description: string
}

interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: QOption[]
}

function parseQuestions(input: unknown): Question[] {
  if (typeof input !== 'object' || input === null) return []
  const qs = (input as Record<string, unknown>).questions
  if (!Array.isArray(qs)) return []
  const out: Question[] = []
  for (const q of qs) {
    if (typeof q !== 'object' || q === null) continue
    const qq = q as Record<string, unknown>
    if (typeof qq.question !== 'string' || !Array.isArray(qq.options)) continue
    out.push({
      question: qq.question,
      header: typeof qq.header === 'string' ? qq.header : '',
      multiSelect: qq.multiSelect === true,
      options: qq.options
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => ({
          label: typeof o.label === 'string' ? o.label : '',
          description: typeof o.description === 'string' ? o.description : '',
        }))
        .filter((o) => o.label !== ''),
    })
  }
  return out
}

interface Props {
  approval: Approval
  onAnswer: (updatedInput: Record<string, unknown>) => void
  onDeny: () => void
}

export function QuestionDialog({ approval, onAnswer, onDeny }: Props) {
  const questions = useMemo(() => parseQuestions(approval.input), [approval.input])
  const [picked, setPicked] = useState<ReadonlyMap<number, ReadonlySet<string>>>(new Map())
  const [custom, setCustom] = useState('')

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const next = new Map(prev)
      const cur = new Set(next.get(qi) ?? [])
      if (multi) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        cur.clear()
        cur.add(label)
      }
      next.set(qi, cur)
      return next
    })
  }

  const allAnswered = questions.every((_, qi) => (picked.get(qi)?.size ?? 0) > 0)
  const canSubmit = custom.trim() !== '' || (questions.length > 0 && allAnswered)

  const submit = () => {
    if (!canSubmit) return
    const answers: Record<string, string> = {}
    questions.forEach((q, qi) => {
      const sel = [...(picked.get(qi) ?? [])]
      if (sel.length > 0) answers[q.question] = sel.join(', ') // 多选逗号连接（sdk-tools.d.ts）
    })
    const base = typeof approval.input === 'object' && approval.input !== null ? approval.input : {}
    onAnswer({
      ...(base as Record<string, unknown>),
      answers,
      ...(custom.trim() !== '' ? { response: custom.trim() } : {}),
    })
  }

  return (
    <Dialog open>
      <DialogContent
        className="max-h-[82vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        {questions.map((q, qi) => (
          <div className="mb-4" key={qi}>
            {q.header !== '' && <Badge variant="outline" className="mb-2">{q.header}</Badge>}
            <div className="mb-3 text-[15px] font-medium">{q.question}</div>
            <div className="flex flex-col gap-2">
              {q.options.map((o) => {
                const on = picked.get(qi)?.has(o.label) === true
                return (
                  <div
                    key={o.label}
                    className={cn(
                      'flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition-colors hover:bg-sidebar-accent',
                      on && 'border-primary bg-accent hover:bg-accent',
                    )}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input text-accent-foreground',
                        q.multiSelect ? 'rounded-sm' : 'rounded-full',
                        on && 'border-primary',
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium">{o.label}</span>
                      {o.description !== '' && (
                        <span className="text-xs text-muted-foreground">{o.description}</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          placeholder="其他（自由输入）…"
          spellCheck={false}
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onDeny}>取消</Button>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>回答</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
