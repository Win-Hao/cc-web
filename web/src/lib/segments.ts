/**
 * content 块 → 渲染段。历史（server 净化过）和实时帧（原始 block）
 * 形状一致，这里是唯一一份提取逻辑。
 */
import type { ImageRef, Segment, TextSeg } from '../types'

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 每个工具挑一个最能代表这次调用的字段当摘要 */
export function toolSummary(name: string, input: unknown): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  for (const k of ['command', 'file_path', 'pattern', 'description', 'url', 'query', 'prompt', 'path', 'skill']) {
    const v = i[k]
    if (typeof v === 'string' && v !== '') return cap(v.replace(/\s+/g, ' '), 88)
  }
  try {
    const j = JSON.stringify(input)
    return j === undefined || j === '{}' || j === 'null' ? '' : cap(j, 88)
  } catch {
    return ''
  }
}

function toolDetail(input: unknown): string {
  try {
    return cap(JSON.stringify(input, null, 2) ?? '', 4000)
  } catch {
    return ''
  }
}

/** tool_result 不在这里出段 —— 由调用方按 tool_use_id 回填到工具段上 */
export function segmentsFromContent(content: unknown): Segment[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ kind: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  const out: Segment[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type === 'text' && typeof blk.text === 'string' && blk.text !== '') {
      out.push({ kind: 'text', text: blk.text })
    } else if (blk.type === 'tool_use' && typeof blk.name === 'string') {
      out.push({
        kind: 'tool',
        id: typeof blk.id === 'string' ? blk.id : null,
        name: blk.name,
        summary: toolSummary(blk.name, blk.input),
        detail: toolDetail(blk.input),
        input: blk.input,
        status: 'pending',
        result: null,
        images: [],
        subCount: 0,
        agent: null,
      })
    } else if (blk.type === 'thinking' && typeof blk.thinking === 'string' && blk.thinking !== '') {
      out.push({ kind: 'thinking', text: blk.thinking })
    } else if (blk.type === 'image') {
      const ref = imageRef(blk)
      if (ref !== null) out.push({ kind: 'image', image: ref })
      else out.push({ kind: 'text', text: '[图片]' })
    }
  }
  return out
}

/** image 块的 source（历史和实时帧同形）→ ImageRef；形状不对 → null */
function imageRef(blk: Record<string, unknown>): ImageRef | null {
  const src = blk.source
  if (typeof src !== 'object' || src === null) return null
  const s = src as Record<string, unknown>
  if (s.type !== 'base64' || typeof s.data !== 'string' || s.data === '') return null
  return { mediaType: typeof s.media_type === 'string' ? s.media_type : 'image/png', data: s.data }
}

export interface ToolResultInfo {
  id: string | null
  text: string
  isError: boolean
  images: ImageRef[]
}

export function toolResultsFromContent(content: unknown): ToolResultInfo[] {
  if (!Array.isArray(content)) return []
  const out: ToolResultInfo[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type !== 'tool_result') continue
    const flat = flattenResult(blk.content)
    // 历史（server 已抽好 images 字段）和实时帧（原始 image 块）两个来源
    if (Array.isArray(blk.images)) {
      for (const img of blk.images) {
        if (typeof img !== 'object' || img === null) continue
        const i = img as Record<string, unknown>
        if (typeof i.data === 'string' && i.data !== '') {
          flat.images.push({ mediaType: typeof i.media_type === 'string' ? i.media_type : 'image/png', data: i.data })
        }
      }
    }
    out.push({
      id: typeof blk.tool_use_id === 'string' ? blk.tool_use_id : null,
      text: cap(flat.text, 4000),
      isError: blk.is_error === true,
      images: flat.images,
    })
  }
  return out
}

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

export const textOfSegments = (segs: Segment[]): string =>
  segs.filter((s): s is TextSeg => s.kind === 'text').map((s) => s.text).join('')

/**
 * 剥掉打头的成对元信息块（<local-command-stdout> / <command-name> /
 * <local-command-caveat> …，CC 的 bookkeeping 回显），返回剩余人话；
 * 剥不干净或剥完为空 → ''（调用方跳过整条气泡）。与 server 端
 * list.ts 的 stripMetaBlocks 同一逻辑。
 */
export function humanText(text: string): string {
  let t = text.trimStart()
  while (t.startsWith('<')) {
    const m = /^<([a-zA-Z][\w-]*)[^>]*>/.exec(t)
    if (m === null) return ''
    const close = `</${m[1]}>`
    const end = t.indexOf(close)
    if (end === -1) return ''
    t = t.slice(end + close.length).trimStart()
  }
  return t
}
