export interface SessionSummary {
  session_id: string
  project_slug: string
  cwd: string | null
  first_message: string | null
  mtime_ms: number
  /** 运行状态（M54 侧栏指示）；老服务器没有该字段 → undefined 当 idle */
  state?: SessionState
  /** 自定义名（M55 重命名，server sidecar）；null/缺省 → 用首条消息 */
  name?: string | null
}

/* ── D7：服务器归一化后的消息（src/server/message/types.ts 的镜像）──
 * 历史和实时是同一个形状；客户端只做 upsert(message) 和 append_delta。 */

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
  /** 服务器计的思考秒数；历史消息没有 */
  seconds?: number
}

export interface ImageBlock {
  type: 'image'
  media_type: string
  data: string
}

/** tool_use 自带执行状态和结果（tool_result 在服务器配对进来） */
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
  /** 新格式 subagent：meta.toolUseId 锚到本工具 */
  agent: { id: string; label: string } | null
}

export type Block = TextBlock | ThinkingBlock | ImageBlock | ToolUseBlock

export interface Message {
  /** upsert 身份：历史行 = uuid；流式占位 = `<message.id>:<index>`；提示词占位 = `prompt:<n>` */
  key: string
  uuid: string | null
  /** 分页游标（只有历史消息带） */
  cursor?: number
  role: Role
  text: string | null
  model: string | null
  timestamp: string | null
  /** 引擎还在生成：之后会被带 replaces 的最终消息替换 */
  partial: boolean
  replaces?: string
  content: Block[]
  /** 旧格式 sidechain 锚点：这条消息下挂着 N 条 subagent 消息 */
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

/** 客户端本地的错误条目（信封错误 / 引擎 error 事件），不来自服务器消息流 */
export interface ChatError {
  key: string
  role: 'error'
  text: string
  timestamp: string
}

export type ChatItem = Message | ChatError

/** 全文搜索命中（M44，server sessions/search.ts） */
export interface SearchHit {
  session_id: string
  project_slug: string
  cwd: string | null
  snippet: string
  match_count: number
  mtime_ms: number
}

/** 当前回合的运行状态（M47 footer）：跑 → 准备中/执行中 + 计时；完 → 已完成 + 统计 */
export interface TurnStatus {
  running: boolean
  /** running 且还没有任何可见内容（首帧前）→ 准备中 shimmer */
  preparing: boolean
  startedAt: number | null
  stats: { durationMs: number; outputTokens: number | null; costUsd: number | null } | null
}

export type SessionState = 'idle' | 'running' | 'waiting-approval'

export interface HubEvent {
  seq: number
  event: string
  data: unknown
}

export interface Approval {
  requestId: string
  tool_name: string | null
  input: unknown
}

export interface ModelOption {
  value: string
  label: string
  description: string | null
  /** list_models 的 resolvedModel（和 init 帧的 model 对得上） */
  resolved: string | null
  supportsEffort: boolean
  effortLevels: string[]
}

export interface ProjectChoice {
  cwd: string
  name: string
}
