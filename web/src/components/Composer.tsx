/**
 * Composer：上方输入区，底部一行 = 权限模式（左）+
 * 模型胶囊 + 圆形发送键（右）；运行中发送键变红色停止键。
 */
import { useRef, useState } from 'react'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ContextRing } from './ContextRing'
import type { ContextInfo } from './ContextRing'
import { ModelPicker } from './ModelPicker'
import { t, useLang } from '../lib/i18n'
import type { ImageRef, ModelOption } from '../types'

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** 与 server 校验对齐（app.ts M43）：四种位图、单张 ≤5MB、最多 8 张 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 8

function fileToImageRef(f: File): Promise<ImageRef | null> {
  if (!IMAGE_TYPES.has(f.type) || f.size > MAX_IMAGE_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => {
      const url = r.result as string // data:image/png;base64,....
      const comma = url.indexOf(',')
      resolve(comma === -1 ? null : { mediaType: f.type, data: url.slice(comma + 1) })
    }
    r.onerror = () => resolve(null)
    r.readAsDataURL(f)
  })
}

interface Props {
  disabled: boolean
  running: boolean
  onSend: (text: string, images: ImageRef[]) => void
  onInterrupt: () => void
  permMode: string
  onPermMode: (mode: string) => void
  models: ModelOption[]
  modelValue: string | null
  modelResolved: string | null
  effort: string | null
  onModel: (value: string) => void
  onEffort: (level: string) => void
  onModelMenuOpen?: (() => void) | undefined
  context: ContextInfo | null
}

export function Composer({
  disabled, running, onSend, onInterrupt,
  permMode, onPermMode, models, modelValue, modelResolved, effort, onModel, onEffort, onModelMenuOpen,
  context,
}: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  const [rejected, setRejected] = useState(false)
  useLang()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = async (files: Iterable<File>) => {
    const refs = await Promise.all([...files].map(fileToImageRef))
    const good = refs.filter((r): r is ImageRef => r !== null)
    let clipped = refs.length > good.length
    setImages((prev) => {
      const next = [...prev, ...good]
      if (next.length > MAX_IMAGES) clipped = true
      return next.slice(0, MAX_IMAGES)
    })
    setRejected(clipped)
  }

  const send = () => {
    const t = text.trim()
    if ((t === '' && images.length === 0) || disabled || running) return
    setText('')
    setImages([])
    setRejected(false)
    const ta = taRef.current
    if (ta !== null) ta.style.height = 'auto'
    onSend(t, images)
  }

  return (
    <div className="px-4 pt-2 pb-3">
      <div
        className="mx-auto max-w-[760px] rounded-[24px] border bg-background shadow-md transition-shadow focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          if (disabled || e.dataTransfer.files.length === 0) return
          e.preventDefault()
          void addFiles(e.dataTransfer.files)
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {images.map((img, i) => (
              <div className="group relative" key={i}>
                <img
                  alt=""
                  className="size-14 rounded-lg border object-cover"
                  src={`data:${img.mediaType};base64,${img.data}`}
                />
                <button
                  className="absolute -top-1.5 -right-1.5 hidden size-4 cursor-pointer items-center justify-center rounded-full bg-foreground text-background group-hover:flex"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {rejected && <div className="px-4 pt-2 text-xs text-destructive">{t('imageRejected')}</div>}
        <Textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? t('selectSessionFirst') : t('composerPlaceholder')}
          className="max-h-40 min-h-[52px] px-4 pt-3 pb-1"
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
          onPaste={(e) => {
            const files = [...e.clipboardData.items]
              .filter((it) => it.kind === 'file')
              .map((it) => it.getAsFile())
              .filter((f): f is File => f !== null)
            if (files.length > 0) {
              e.preventDefault()
              void addFiles(files)
            }
          }}
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          <input
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            multiple
            onChange={(e) => {
              if (e.target.files !== null) void addFiles(e.target.files)
              e.target.value = ''
            }}
            ref={fileRef}
            type="file"
          />
          <Button
            className="size-7 rounded-full text-muted-foreground"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
            size="icon"
            title={t('attachImage')}
            variant="ghost"
          >
            <ImagePlus className="size-4" />
          </Button>
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
          {context !== null && context.max > 0 && <ContextRing info={context} />}
          <ModelPicker
            models={models}
            modelValue={modelValue}
            modelResolved={modelResolved}
            effort={effort}
            onModel={onModel}
            onEffort={onEffort}
            onOpen={onModelMenuOpen}
          />
          {running ? (
            <Button size="icon" variant="destructive" title={t('interrupt')} onClick={onInterrupt}>
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button size="icon" title={t('send')} disabled={disabled || (text.trim() === '' && images.length === 0)} onClick={send}>
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
