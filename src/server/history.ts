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
