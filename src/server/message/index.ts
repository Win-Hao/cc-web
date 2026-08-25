/**
 * D7：message —— 历史和实时的唯一 normalizer。对外三样：
 *   normalizeHistory(entries, ctx) → Message[]（再 paginate 切页）
 *   LiveTurn：ingest(frame) / prompt() / snapshot() / abort() / openToolUseIds()
 * 块归一化是内部 seam，不导出。
 */
export { normalizeHistory, paginate } from './history.js'
export type { HistoryContext } from './history.js'
export { LiveTurn } from './live.js'
export type { Block, Delta, ImageBlock, ImageRef, Message, MessageEvent, Page, Role, TextBlock, ThinkingBlock, ToolStatus, ToolUseBlock, TurnEnd } from './types.js'
