/**
 * AskUserQuestion 交互卡：CC 通过 can_use_tool 反问用户。
 * 单选/多选选项 + 自由文本兜底；提交走 allow + updatedInput
 * （{questions, answers: {问题: 选项label}, response?}，sdk-tools.d.ts）。
 */
import { useMemo, useState } from 'react'
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
    <div className="backdrop">
      <div className="dialog q-dialog">
        {questions.map((q, qi) => (
          <div className="q-block" key={qi}>
            {q.header !== '' && <span className="q-chip">{q.header}</span>}
            <div className="q-text">{q.question}</div>
            <div className="q-opts">
              {q.options.map((o) => {
                const on = picked.get(qi)?.has(o.label) === true
                return (
                  <div
                    key={o.label}
                    className={on ? 'q-opt on' : 'q-opt'}
                    onClick={() => toggle(qi, o.label, q.multiSelect)}
                  >
                    <span className={q.multiSelect ? 'q-mark multi' : 'q-mark'}>
                      {on ? '✓' : ''}
                    </span>
                    <span className="q-opt-main">
                      <span className="q-opt-label">{o.label}</span>
                      {o.description !== '' && <span className="q-opt-desc">{o.description}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        <input
          className="proj-input"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          placeholder="其他（自由输入）…"
          spellCheck={false}
        />
        <div className="dialog-row">
          <button className="btn" onClick={onDeny}>取消</button>
          <button className="btn primary" disabled={!canSubmit} onClick={submit}>回答</button>
        </div>
      </div>
    </div>
  )
}
