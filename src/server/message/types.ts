/**
 * D7：给浏览器的一套形状。历史（jsonl）和实时（引擎 stdout）归一化成同一个
 * Message；浏览器只有两个原语：upsert(message) 和 append_delta(key, kind, chunk)。
 * 词表见 CONTEXT.md。
 */
export type Role = 'user' | 'assistant'

export interface ImageRef {
  media_type: string
  data: string
}

export type ToolStatus = 'pending' | 'ok' | 'error' | 'canceled'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  /** 服务器在块开始 / 最终帧之间计的秒数；历史消息没有 */
  seconds?: number
}

export interface ImageBlock {
  type: 'image'
  media_type: string
  data: string
}

/** tool_use 自带执行状态和结果：tool_result 在服务器配对进来，浏览器不再见到它 */
export interface ToolUseBlock {
  type: 'tool_use'
  id: string | null
  name: string
  input: unknown
  status: ToolStatus
  result: string | null
  images: ImageRef[]
  /** 实时归属到这个工具的 subagent 消息数 */
  sub_count: number
  /** 新格式 subagent（meta.toolUseId 锚到本工具） */
  agent: { id: string; label: string } | null
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock

export interface Message {
  /** upsert 身份：历史行 = uuid；流式占位 = `<message.id>:<index>`；提示词占位 = `prompt:<n>` */
  key: string
  uuid: string | null
  /** 分页游标 = jsonl 行号，只有历史消息带 */
  cursor?: number
  role: Role
  /** 第一个 text 块（user 已剥 meta 标签），给侧栏 / 锚点轨这类只要一行字的地方 */
  text: string | null
  model: string | null
  timestamp: string | null
  /** 引擎还在生成：之后会被带 replaces 的最终消息替换 */
  partial: boolean
  /** 最终消息替换掉的占位 key */
  replaces?: string
  content: Block[]
  /** 旧格式 sidechain 的锚点：这条消息下挂着 N 条 subagent 消息 */
  sidechain_count?: number
}

export interface Delta {
  key: string
  kind: 'text' | 'thinking'
  chunk: string
}

export interface TurnEnd {
  duration_ms: number | null
  output_tokens: number | null
  cost_usd: number | null
}

export type MessageEvent =
  | { event: 'message'; data: Message }
  | { event: 'delta'; data: Delta }
  | { event: 'turn_end'; data: TurnEnd }
  | { event: 'init'; data: { model: string | null; permission_mode: string | null } }
  | { event: 'rate_limit'; data: unknown }

export interface Page {
  messages: Message[]
  has_more: boolean
}
