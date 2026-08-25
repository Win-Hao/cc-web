/**
 * 块归一化（模块内部 seam）：引擎 / jsonl 的 content → Block[]。
 * history 和 live 共用；tool_result 在这里被剥出来交给调用方配对。
 */
import { stripMetaBlocks } from '#/sessions/text.js'
import type { Block, ImageRef, ToolUseBlock } from './types.js'

/** 字符串截断上限：tool 输入/输出可能巨大（整文件写入），给浏览器的只是预览 */
const MAX_STR = 2000
/** 图片 base64 上限（≈2MB 原始数据）：超过降级占位，防止单条响应几十 MB */
const MAX_IMAGE_B64 = 2_800_000
const IMAGE_PLACEHOLDER = '[图片]'

type Rec = Record<string, unknown>

export function rec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null ? (v as Rec) : null
}
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function capStr(s: string): string {
  return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s
}

/** 深度受限的净化：长字符串截断，太深的结构折叠 */
export function sanitizeValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return capStr(v)
  if (Array.isArray(v)) return depth > 3 ? '[…]' : v.map((x) => sanitizeValue(x, depth + 1))
  const r = rec(v)
  if (r !== null) {
    if (depth > 3) return '[…]'
    const out: Rec = {}
    for (const [k, val] of Object.entries(r)) out[k] = sanitizeValue(val, depth + 1)
    return out
  }
  return v
}

function imageRef(blk: Rec): ImageRef | null {
  const s = rec(blk.source)
  if (s === null || s.type !== 'base64' || typeof s.data !== 'string' || s.data.length > MAX_IMAGE_B64) return null
  return { media_type: str(s.media_type) ?? 'image/png', data: s.data }
}

export interface ToolResult {
  tool_use_id: string | null
  content: string
  is_error: boolean
  images: ImageRef[]
}

/** tool_result 的 content（string 或 block 数组）→ 文本 + 图片 */
function flattenResult(content: unknown): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const parts: string[] = []
  const images: ImageRef[] = []
  for (const b of content) {
    const blk = rec(b)
    if (blk === null) continue
    if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    else if (blk.type === 'image') {
      const ref = imageRef(blk)
      if (ref !== null) images.push(ref)
      else parts.push(IMAGE_PLACEHOLDER)
    }
  }
  return { text: parts.join('\n'), images }
}

export function toolUseBlock(id: string | null, name: string, input: unknown): ToolUseBlock {
  return { type: 'tool_use', id, name, input, status: 'pending', result: null, images: [], sub_count: 0, agent: null }
}

/**
 * message.content → 渲染块 + 剥出来的 tool_result。
 * stripMeta：user 消息剥掉打头的 <local-command-caveat> 之类的注入标签；
 * 剥空的 text 块丢掉（这条消息可能因此没有块 → 调用方不出消息）。
 */
export function splitContent(content: unknown, opts: { stripMeta: boolean }): { blocks: Block[]; results: ToolResult[] } {
  const blocks: Block[] = []
  const results: ToolResult[] = []
  const pushText = (text: string): void => {
    const t = opts.stripMeta ? stripMetaBlocks(text) : text
    if (t !== '') blocks.push({ type: 'text', text: capStr(t) })
  }
  if (typeof content === 'string') {
    pushText(content)
    return { blocks, results }
  }
  if (!Array.isArray(content)) return { blocks, results }
  for (const b of content) {
    const blk = rec(b)
    if (blk === null) continue
    if (blk.type === 'text' && typeof blk.text === 'string') {
      pushText(blk.text)
    } else if (blk.type === 'tool_use' && typeof blk.name === 'string') {
      blocks.push(toolUseBlock(str(blk.id), blk.name, sanitizeValue(blk.input)))
    } else if (blk.type === 'tool_result') {
      const flat = flattenResult(blk.content)
      results.push({ tool_use_id: str(blk.tool_use_id), content: capStr(flat.text), is_error: blk.is_error === true, images: flat.images })
    } else if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
      blocks.push({ type: 'thinking', thinking: capStr(blk.thinking) })
    } else if (blk.type === 'image') {
      const ref = imageRef(blk)
      if (ref !== null) blocks.push({ type: 'image', ...ref })
      else blocks.push({ type: 'text', text: IMAGE_PLACEHOLDER })
    }
  }
  return { blocks, results }
}

export function textOf(blocks: Block[]): string | null {
  for (const b of blocks) if (b.type === 'text') return b.text
  return null
}

/** 把 tool_result 配进 tool_use 块 */
export function applyResult(block: ToolUseBlock, r: ToolResult): void {
  block.status = r.is_error ? 'error' : 'ok'
  block.result = r.content
  block.images = r.images
}
