/**
 * 历史：jsonl 行（SessionEntry）→ Message[]。interface 是 mainline 级的：
 * tool_result 要跨行配对、sidechain / subagent 要挂到对应消息上，
 * 逐行是做不到的。分页在配对之后做，所以 tool_use 在旧页、结果在新页也没事。
 */
import type { SessionEntry } from '#/sessions/parse.js'
import type { SubagentInfo } from '#/sessions/subagents.js'
import { applyResult, splitContent, textOf } from './blocks.js'
import type { Message, Page, ToolUseBlock } from './types.js'

export interface HistoryContext {
  /** 旧格式 subagent：按锚点 uuid 分组（parse.ts） */
  sidechains?: Record<string, SessionEntry[]>
  /** 新格式 subagent：tool_use_id 锚到工具块 */
  subagents?: SubagentInfo[]
  /** 当前回合还没有结果的 tool_use（registry 的 LiveTurn 给）：这些标 pending，其余没结果的标 canceled */
  openToolUseIds?: Set<string>
}

const AGENT_LABEL_MAX = 60

export function normalizeHistory(entries: SessionEntry[], ctx: HistoryContext = {}): Message[] {
  const agents = new Map<string, { id: string; label: string }>()
  for (const a of ctx.subagents ?? []) {
    if (a.tool_use_id === null) continue
    const label = (a.description ?? a.agent_type ?? a.agent_id).slice(0, AGENT_LABEL_MAX)
    agents.set(a.tool_use_id, { id: a.agent_id, label })
  }

  const out: Message[] = []
  const open = new Map<string, ToolUseBlock>()
  for (const e of entries) {
    if (typeof e.message !== 'object' || e.message === null) continue
    const msg = e.message as Record<string, unknown>
    const role = msg.role
    if (role !== 'user' && role !== 'assistant') continue
    const { blocks, results } = splitContent(msg.content, { stripMeta: role === 'user' })
    for (const r of results) {
      const target = r.tool_use_id !== null ? open.get(r.tool_use_id) : undefined
      if (target === undefined) continue
      applyResult(target, r)
      open.delete(r.tool_use_id!)
    }
    if (blocks.length === 0) continue
    for (const b of blocks) {
      if (b.type !== 'tool_use' || b.id === null) continue
      open.set(b.id, b)
      b.agent = agents.get(b.id) ?? null
    }
    const m: Message = {
      key: e.uuid ?? `line:${e.line}`,
      uuid: e.uuid,
      cursor: e.line,
      role,
      text: textOf(blocks),
      model: e.model,
      timestamp: e.timestamp,
      partial: false,
      content: blocks,
    }
    const count = e.uuid !== null ? (ctx.sidechains?.[e.uuid]?.length ?? 0) : 0
    if (count > 0) m.sidechain_count = count
    out.push(m)
  }
  for (const [id, b] of open) b.status = ctx.openToolUseIds?.has(id) === true ? 'pending' : 'canceled'
  return out
}

/**
 * 取「最新 limit 条」；给 before 则取「cursor 小于 before 的最新 limit 条」。
 * cursor 是 jsonl 行号，append-only（R9）所以永远稳定。
 */
export function paginate(messages: Message[], opts: { limit: number; before?: number }): Page {
  const candidates = opts.before === undefined ? messages : messages.filter((m) => (m.cursor ?? 0) < opts.before!)
  const page = candidates.slice(-opts.limit)
  return { messages: page, has_more: candidates.length > page.length }
}
