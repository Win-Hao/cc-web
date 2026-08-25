/**
 * 实时：引擎 stdout 帧 → Message 事件。服务器为「当前回合」持有的有界状态：
 *   - 正在流的占位消息（key = `<message.id>:<index>`），delta 累积在里面，
 *     新标签页订阅时靠 snapshot() 拿到半截内容
 *   - 还没有结果的 tool_use → tool_result 到了配对回去；回合结束 / 引擎退出判 canceled
 *   - 提示词占位（key = `prompt:<n>`）→ 引擎回显的 user 帧（isReplay）替换它
 * 回合结束（result 帧 / abort）状态即清空；历史仍从 jsonl 出。
 *
 * 帧的事实来源：test/fixtures/recorded/*.ndjson（D4）。已知顺序：
 * 每个块的最终 assistant 帧先于它的 content_block_stop 到达；一帧一块。
 */
import type { PromptImage } from '../registry.js'
import { applyResult, num, rec, sanitizeValue, splitContent, str, textOf, toolUseBlock } from './blocks.js'
import type { Block, Message, MessageEvent, ToolUseBlock, TurnEnd } from './types.js'

interface Placeholder {
  key: string
  msgId: string | null
  index: number
  blockType: string
  toolId: string | null
  startedAt: number
  json: string
}

const NULL_END: TurnEnd = { duration_ms: null, output_tokens: null, cost_usd: null }

export class LiveTurn {
  /** 当前回合的消息，按到达顺序；占位被替换时删旧插新 */
  private readonly messages = new Map<string, Message>()
  private placeholders: Placeholder[] = []
  /** tool_use id → 持有它的消息 key */
  private readonly open = new Map<string, string>()
  private readonly pendingPrompts: string[] = []
  private currentMsgId: string | null = null
  private currentModel: string | null = null
  private promptSeq = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** 提示词被接受：立刻给所有标签页一条占位，等引擎回显替换 */
  prompt(text: string, images: PromptImage[]): Message {
    const content: Block[] = images.map((i) => ({ type: 'image', media_type: i.media_type, data: i.data }))
    if (text !== '') content.push({ type: 'text', text })
    const key = `prompt:${++this.promptSeq}`
    const m: Message = {
      key, uuid: null, role: 'user', text: text === '' ? null : text, model: null,
      timestamp: this.iso(), partial: true, content,
    }
    this.messages.set(key, m)
    this.pendingPrompts.push(key)
    return clone(m)
  }

  snapshot(): Message[] {
    return [...this.messages.values()].map(clone)
  }

  openToolUseIds(): Set<string> {
    return new Set(this.open.keys())
  }

  ingest(frame: unknown): MessageEvent[] {
    const f = rec(frame)
    if (f === null) return []
    if (typeof f.parent_tool_use_id === 'string') return this.ingestSubagent(f)
    switch (f.type) {
      case 'system':
        return f.subtype === 'init'
          ? [{ event: 'init', data: { model: str(f.model), permission_mode: str(f.permissionMode) } }]
          : []
      case 'rate_limit_event':
        return [{ event: 'rate_limit', data: frame }]
      case 'stream_event':
        return this.ingestStream(rec(f.event))
      case 'assistant':
        return this.ingestAssistant(f)
      case 'user':
        return this.ingestUser(f)
      case 'result':
        return this.finish({
          duration_ms: num(f.duration_ms),
          output_tokens: num(rec(f.usage)?.output_tokens),
          cost_usd: num(f.total_cost_usd),
        })
      default:
        return []
    }
  }

  /** 引擎没给 result 就没了（退出 / 被杀）：按回合结束处理，统计为空 */
  abort(): MessageEvent[] {
    return this.finish(NULL_END)
  }

  /* ── 帧处理 ─────────────────────────────────────────── */

  private ingestStream(ev: Record<string, unknown> | null): MessageEvent[] {
    if (ev === null) return []
    switch (ev.type) {
      case 'message_start': {
        const msg = rec(ev.message)
        this.currentMsgId = str(msg?.id)
        this.currentModel = str(msg?.model) ?? this.currentModel
        return []
      }
      case 'content_block_start': {
        const cb = rec(ev.content_block)
        const index = num(ev.index)
        if (cb === null || index === null) return []
        const block = this.placeholderBlock(cb)
        if (block === null) return []
        const key = `${this.currentMsgId ?? 'msg'}:${index}`
        const startedAt = this.now()
        const m: Message = {
          key, uuid: null, role: 'assistant', text: null, model: this.currentModel,
          timestamp: new Date(startedAt).toISOString(), partial: true, content: [block],
        }
        this.messages.set(key, m)
        this.placeholders.push({
          key, msgId: this.currentMsgId, index, blockType: block.type,
          toolId: block.type === 'tool_use' ? block.id : null, startedAt, json: '',
        })
        return [msgEvent(m)]
      }
      case 'content_block_delta': {
        const index = num(ev.index)
        const delta = rec(ev.delta)
        if (index === null || delta === null) return []
        const p = this.placeholders.find((x) => x.msgId === this.currentMsgId && x.index === index)
        const m = p !== undefined ? this.messages.get(p.key) : undefined
        const block = m?.content[0]
        if (p === undefined || m === undefined || block === undefined) return []
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && block.type === 'text') {
          block.text += delta.text
          return [{ event: 'delta', data: { key: p.key, kind: 'text', chunk: delta.text } }]
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && block.type === 'thinking') {
          block.thinking += delta.thinking
          return [{ event: 'delta', data: { key: p.key, kind: 'thinking', chunk: delta.thinking } }]
        }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && block.type === 'tool_use') {
          p.json += delta.partial_json
          const parsed = parsePartialJson(p.json)
          if (parsed === undefined) return []
          block.input = sanitizeValue(parsed)
          return [msgEvent(m)]
        }
        return []
      }
      default:
        return [] // content_block_stop / message_delta / message_stop / signature：最终帧已经到过
    }
  }

  private placeholderBlock(cb: Record<string, unknown>): Block | null {
    switch (cb.type) {
      case 'text':
        return { type: 'text', text: str(cb.text) ?? '' }
      case 'thinking':
        return { type: 'thinking', thinking: '' }
      case 'tool_use':
        return typeof cb.name === 'string' ? toolUseBlock(str(cb.id), cb.name, sanitizeValue(cb.input ?? {})) : null
      default:
        return null
    }
  }

  /** 某个块的最终帧：替换它的占位；tool_use 登记为「等结果」 */
  private ingestAssistant(f: Record<string, unknown>): MessageEvent[] {
    const msg = rec(f.message)
    if (msg === null) return []
    const { blocks } = splitContent(msg.content, { stripMeta: false })
    if (blocks.length === 0) return []
    const msgId = str(msg.id)
    let replaced: Placeholder | undefined
    for (const b of blocks) {
      const i = this.placeholders.findIndex(
        (p) => p.msgId === msgId && p.blockType === b.type && (b.type !== 'tool_use' || p.toolId === b.id),
      )
      if (i === -1) continue
      const p = this.placeholders[i]!
      this.placeholders.splice(i, 1)
      this.messages.delete(p.key)
      if (b.type === 'thinking') b.seconds = Math.max(0, Math.round((this.now() - p.startedAt) / 1000))
      replaced ??= p
    }
    const uuid = str(f.uuid)
    const key = uuid ?? replaced?.key ?? `assistant:${this.now()}`
    const m: Message = {
      key, uuid, role: 'assistant', text: textOf(blocks), model: str(msg.model) ?? this.currentModel,
      timestamp: str(f.timestamp) ?? this.iso(), partial: false, content: blocks,
    }
    if (replaced !== undefined && replaced.key !== key) m.replaces = replaced.key
    for (const b of blocks) if (b.type === 'tool_use' && b.id !== null) this.open.set(b.id, key)
    this.messages.set(key, m)
    return [msgEvent(m)]
  }

  /** user 帧：tool_result 配回 tool_use；剩下的文本 / 图片是用户消息（回显替换 prompt 占位） */
  private ingestUser(f: Record<string, unknown>): MessageEvent[] {
    const msg = rec(f.message)
    if (msg === null) return []
    const { blocks, results } = splitContent(msg.content, { stripMeta: true })
    const out: MessageEvent[] = []
    const touched = new Set<string>()
    for (const r of results) {
      if (r.tool_use_id === null) continue
      const key = this.open.get(r.tool_use_id)
      this.open.delete(r.tool_use_id)
      const m = key !== undefined ? this.messages.get(key) : undefined
      const block = m?.content.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.id === r.tool_use_id)
      if (m === undefined || block === undefined) continue
      applyResult(block, r)
      if (!touched.has(m.key)) {
        touched.add(m.key)
        out.push(msgEvent(m))
      }
    }
    if (blocks.length === 0) return out
    const uuid = str(f.uuid)
    const key = uuid ?? `user:${this.now()}`
    const m: Message = {
      key, uuid, role: 'user', text: textOf(blocks), model: null,
      timestamp: str(f.timestamp) ?? this.iso(), partial: false, content: blocks,
    }
    if (f.isReplay === true) {
      const ph = this.pendingPrompts.shift()
      if (ph !== undefined && ph !== key) {
        this.messages.delete(ph)
        m.replaces = ph
      }
    }
    this.messages.set(key, m)
    out.push(msgEvent(m))
    return out
  }

  /** subagent 的帧不进主流：给它归属的 tool_use 计 sub_count（只数 assistant / user 帧） */
  private ingestSubagent(f: Record<string, unknown>): MessageEvent[] {
    if (f.type !== 'assistant' && f.type !== 'user') return []
    const key = this.open.get(f.parent_tool_use_id as string)
    const m = key !== undefined ? this.messages.get(key) : undefined
    const block = m?.content.find((b): b is ToolUseBlock => b.type === 'tool_use' && b.id === f.parent_tool_use_id)
    if (m === undefined || block === undefined) return []
    block.sub_count += 1
    return [msgEvent(m)]
  }

  /** 回合结束：没结果的 tool_use → canceled，占位转终态，清空状态 */
  private finish(stats: TurnEnd): MessageEvent[] {
    const out: MessageEvent[] = []
    const touched = new Set<string>()
    const emit = (m: Message): void => {
      if (touched.has(m.key)) return
      touched.add(m.key)
      out.push(msgEvent(m))
    }
    for (const key of this.open.values()) {
      const m = this.messages.get(key)
      if (m === undefined) continue
      for (const b of m.content) if (b.type === 'tool_use' && b.status === 'pending') b.status = 'canceled'
      emit(m)
    }
    for (const p of this.placeholders) {
      const m = this.messages.get(p.key)
      if (m === undefined) continue
      m.partial = false
      for (const b of m.content) if (b.type === 'tool_use' && b.status === 'pending') b.status = 'canceled'
      emit(m)
    }
    for (const key of this.pendingPrompts) {
      const m = this.messages.get(key)
      if (m === undefined) continue
      m.partial = false
      emit(m)
    }
    out.push({ event: 'turn_end', data: stats })
    this.open.clear()
    this.placeholders = []
    this.pendingPrompts.length = 0
    this.messages.clear()
    this.currentMsgId = null
    return out
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }
}

/** 发出去的是快照：hub 留存 / 黄金文件不该被之后的状态变化改写 */
function clone<T>(v: T): T {
  return structuredClone(v)
}

function msgEvent(m: Message): MessageEvent {
  return { event: 'message', data: clone(m) }
}

/**
 * 半截 JSON 尽量解析（流式 tool 入参）：闭合未完的字符串 / 容器，
 * 补上悬空的 value；还是解析不了就返回 undefined（调用方保留上一次的结果）。
 */
export function parsePartialJson(src: string): unknown {
  const s = src.trim()
  if (s === '') return undefined
  try {
    return JSON.parse(s)
  } catch {
    // fallthrough
  }
  let inStr = false
  let esc = false
  const closers: string[] = []
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') closers.push('}')
    else if (ch === '[') closers.push(']')
    else if (ch === '}' || ch === ']') closers.pop()
  }
  const head = inStr ? `${s}"` : s.replace(/,\s*$/, '')
  const tail = closers.reverse().join('')
  for (const candidate of [head + tail, `${head}: null${tail}`, `${head} null${tail}`]) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try next
    }
  }
  return undefined
}
