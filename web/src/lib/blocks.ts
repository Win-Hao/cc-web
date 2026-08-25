/**
 * Block 的展示辅助（纯标签派生，不重建数据）：用户气泡 / 锚点轨要一行字，
 * 工具卡要一个摘要和展开看的入参。
 */
import type { Block, TextBlock } from '../types'

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 所有 text 块拼接 */
export const textOf = (m: { content: Block[] }): string =>
  m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('')

/** 每个工具挑一个最能代表这次调用的入参字段当摘要 */
export function toolSummary(input: unknown): string {
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

/** 展开看的完整入参（JSON pretty，截断） */
export function toolDetail(input: unknown): string {
  try {
    const j = JSON.stringify(input, null, 2) ?? ''
    return j === '{}' || j === 'null' ? '' : cap(j, 4000)
  } catch {
    return ''
  }
}
