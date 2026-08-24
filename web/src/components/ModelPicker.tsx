/**
 * 模型选择（M24，composer 里的模型胶囊）：上弹面板 = 模型列表 ✓
 * + 「思考」程度分段（支持 effort 的模型）+ 缓存失效提示。
 */
import { useState } from 'react'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { ModelOption } from '../types'
import { t, useLang } from '../lib/i18n'

interface Props {
  models: ModelOption[]
  /** 用户在本会话里选过的 option value；没选过为 null */
  modelValue: string | null
  /** init/assistant 帧带回的实际模型名（claude-opus-5[1m] 这种） */
  modelResolved: string | null
  effort: string | null
  onModel: (value: string) => void
  onEffort: (level: string) => void
  /** 面板打开时触发：模型列表为空可借此重拉 */
  onOpen?: (() => void) | undefined
}

export function ModelPicker({ models, modelValue, modelResolved, effort, onModel, onEffort, onOpen }: Props) {
  useLang()
  const [open, setOpen] = useState(false)

  const current =
    (modelValue !== null ? models.find((m) => m.value === modelValue) : undefined) ??
    (modelResolved !== null ? models.find((m) => m.resolved === modelResolved) : undefined) ??
    // 都没有（首轮 init 帧还没来）：会话默认就是 default 项
    models.find((m) => m.value === 'default')

  const pillLabel = current?.label ?? modelResolved ?? t('model')
  const effortLevels =
    current?.supportsEffort === true
      ? current.effortLevels.length > 0
        ? current.effortLevels
        : ['low', 'medium', 'high']
      : []

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) onOpen?.()
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className="rounded-full font-normal text-muted-foreground hover:text-foreground">
          <span className="max-w-[180px] truncate">
            {pillLabel}
            {effort !== null && <span className="text-accent-foreground"> · {effort}</span>}
          </span>
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[320px]">
        <div className="px-2.5 pt-1.5 pb-0.5 text-xs text-faint select-none">{t('model')}</div>
        <div className="max-h-64 overflow-y-auto">
          {models.length === 0 && <div className="px-2.5 py-2 text-xs text-faint">{t('modelsLoading')}</div>}
          {models.map((m) => {
            const on = current?.value === m.value
            return (
              <button
                key={m.value}
                type="button"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-sidebar-accent focus-visible:bg-sidebar-accent',
                  on && 'bg-selected hover:bg-selected',
                )}
                onClick={() => {
                  onModel(m.value)
                  setOpen(false)
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-[450]">{m.label}</span>
                  {m.description !== null && (
                    <span className="truncate text-xs text-faint">{m.description}</span>
                  )}
                </span>
                {on && <Check className="size-3.5 shrink-0" />}
              </button>
            )
          })}
        </div>
        {effortLevels.length > 0 && (
          <>
            <Separator className="my-1" />
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <span className="text-xs text-muted-foreground">{t('thinking')}</span>
              <div className="flex flex-1 justify-end">
                <div className="flex rounded-md bg-secondary p-0.5">
                  {effortLevels.map((lv) => (
                    <button
                      key={lv}
                      className={cn(
                        'cursor-pointer rounded-[5px] px-2 py-0.5 text-xs text-muted-foreground transition-colors',
                        effort === lv && 'bg-background text-foreground shadow-xs',
                      )}
                      onClick={() => onEffort(lv)}
                    >
                      {lv}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
        <div className="px-2.5 py-1.5 text-xs leading-relaxed text-faint">
          {t('cacheHint')}
        </div>
      </PopoverContent>
    </Popover>
  )
}
