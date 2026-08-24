/**
 * content 块 → 渲染段。历史（server 净化过）和实时帧（原始 block）
 * 形状一致，这里是唯一一份提取逻辑。
 */
import type { Segment, TextSeg } from '../types'

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
        status: 'pending',
        result: null,
      })
    } else if (blk.type === 'image') {
      out.push({ kind: 'text', text: '[图片]' })
    }
  }
  return out
}

export interface ToolResultInfo {
  id: string | null
  text: string
  isError: boolean
}

export function toolResultsFromContent(content: unknown): ToolResultInfo[] {
  if (!Array.isArray(content)) return []
  const out: ToolResultInfo[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type !== 'tool_result') continue
    out.push({
      id: typeof blk.tool_use_id === 'string' ? blk.tool_use_id : null,
      text: cap(flattenResult(blk.content), 4000),
      isError: blk.is_error === true,
    })
  }
  return out
}

function flattenResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) continue
    const blk = b as Record<string, unknown>
    if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text)
    else if (blk.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n')
}

export const textOfSegments = (segs: Segment[]): string =>
  segs.filter((s): s is TextSeg => s.kind === 'text').map((s) => s.text).join('')
