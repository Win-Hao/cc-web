/**
 * M3：历史消息的归一化 + cursor 分页（纯函数，ARCHITECTURE「归一化好测」）。
 *
 * jsonl 是 append-only（R9），所以 cursor 就是 entry 的 0-based 行号：
 * `before=<cursor>` 拿「比它更早」的一页，永远稳定，不受新追加行影响。
 */
import { extractText } from '#/sessions/text.js'
import type { SessionEntry } from '#/sessions/parse.js'

/** 给前端的历史消息形状（引擎实时事件在 server 层归一化成同一套） */
export interface HistoryMessage {
  /** 分页游标 = 行号 */
  cursor: number
  uuid: string | null
  parentUuid: string | null
  type: string | null
  role: string | null
  text: string | null
  model: string | null
  timestamp: string | null
  /**
   * 净化后的 content 块（M13 工具渲染）：text / tool_use / tool_result 三种，
   * 形状对齐实时帧里的原始 block —— 前端一套代码同时吃历史和实时。
   * 提不出块（bookkeeping 行等）为 null。
   */
  content: HistoryBlock[] | null
}

export type HistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | {
      type: 'tool_result'
      tool_use_id: string | null
      content: string
      is_error: boolean
      /** 截图类工具的返回图（M42）。只在非空时出现 */
      images?: ImageRef[]
    }
  | { type: 'tool_use'; id: string | null; name: string; input: unknown }

export interface ImageRef {
  media_type: string
  data: string
}

/** 字符串截断上限：tool 输入/输出可能巨大（整文件写入），历史接口只给预览 */
const MAX_STR = 2000

/**
 * 图片 base64 上限（字符数，≈2MB 原始数据）。本地服务器，几百 KB 的
 * 截图直接透传没问题；超过就降级占位，防止单条历史响应几十 MB。
 */
const MAX_IMAGE_B64 = 2_800_000

/** image 块 → {media_type, data}；太大或形状不对 → null（调用方置占位） */
function imageRef(blk: Record<string, unknown>): ImageRef | null {
  const src = blk.source
  if (typeof src !== 'object' || src === null) return null
  const s = src as Record<string, unknown>
  if (s.type !== 'base64' || typeof s.data !== 'string' || s.data.length > MAX_IMAGE_B64) return null
  return { media_type: typeof s.media_type === 'string' ? s.media_type : 'image/png', data: s.data }
}

function capStr(s: string): string {
  return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…` : s
}

/** 深度受限的净化：长字符串截断，图片等二进制不透传 */
function sanitizeValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return capStr(v)
  if (Array.isArray(v)) return depth > 3 ? '[…]' : v.map((x) => sanitizeValue(x, depth + 1))
  if (typeof v === 'object' && v !== null) {
    if (depth > 3) return '[…]'
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) out[k] = sanitizeValue(val, depth + 1)
    return out
  }
  return v
}

/**
 * tool_result 的 content（string 或 block 数组）→ 文本 + 图片（M42）。
 * 抽出的图真实渲染，抽不出（超大/形状不对）的图置占位文本。
 */
function flattenResult(content: unknown): { text: string; images: ImageRef[] } {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const parts: string[] = []
  const images: ImageRef[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    else if (blk.type === 'image') {
      const ref = imageRef(blk)
      if (ref !== null) images.push(ref)
      else parts.push('[图片]')
    }
  }
  return { text: parts.join('\n'), images }
}

function sanitizeContent(message: unknown): HistoryBlock[] | null {
  if (typeof message !== 'object' || message === null) return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: capStr(content) }]
  }
  if (!Array.isArray(content)) return null
  const out: HistoryBlock[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type === 'text' && typeof blk.text === 'string') {
      out.push({ type: 'text', text: capStr(blk.text) })
    } else if (blk.type === 'tool_use' && typeof blk.name === 'string') {
      out.push({
        type: 'tool_use',
        id: typeof blk.id === 'string' ? blk.id : null,
        name: blk.name,
        input: sanitizeValue(blk.input, 0),
      })
    } else if (blk.type === 'tool_result') {
      const flat = flattenResult(blk.content)
      out.push({
        type: 'tool_result',
        tool_use_id: typeof blk.tool_use_id === 'string' ? blk.tool_use_id : null,
        content: capStr(flat.text),
        is_error: blk.is_error === true,
        ...(flat.images.length > 0 ? { images: flat.images } : {}),
      })
    } else if (blk.type === 'thinking' && typeof blk.thinking === 'string') {
      out.push({ type: 'thinking', thinking: capStr(blk.thinking) })
    } else if (blk.type === 'image') {
      const ref = imageRef(blk)
      if (ref !== null) out.push({ type: 'image', source: { type: 'base64', ...ref } })
      else out.push({ type: 'text', text: '[图片]' })
    }
  }
  return out
}

export function normalizeMessage(e: SessionEntry): HistoryMessage {
  const role =
    typeof e.message === 'object' && e.message !== null
      ? ((e.message as Record<string, unknown>).role ?? null)
      : null
  return {
    cursor: e.line,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    type: e.type,
    role: typeof role === 'string' ? role : null,
    text: extractText(e.message),
    model: e.model,
    timestamp: e.timestamp,
    content: sanitizeContent(e.message),
  }
}

export interface Page {
  messages: HistoryMessage[]
  has_more: boolean
}

/**
 * 取「最新 limit 条」；给 before 则取「cursor 小于 before 的最新 limit 条」。
 * has_more = 前面还有更早的。
 */
export function paginate(
  mainline: SessionEntry[],
  opts: { limit: number; before?: number },
): Page {
  const candidates =
    opts.before === undefined ? mainline : mainline.filter((e) => e.line < opts.before!)
  const page = candidates.slice(-opts.limit)
  return {
    messages: page.map(normalizeMessage),
    has_more: candidates.length > page.length,
  }
}
