export interface SessionSummary {
  session_id: string
  project_slug: string
  cwd: string | null
  first_message: string | null
  mtime_ms: number
}

export interface HistoryMessage {
  cursor: number
  type: string | null
  role: string | null
  text: string | null
  model: string | null
  timestamp: string | null
  /** 净化后的 content 块，形状对齐实时帧（server history.ts） */
  content: unknown
  uuid?: string | null
  /** 这条消息锚定的 subagent 消息数（M17，只在 >0 时出现） */
  sidechain_count?: number
}

export type SessionState = 'idle' | 'running' | 'waiting-approval'

export interface HubEvent {
  seq: number
  event: string
  data: unknown
}

export interface TextSeg {
  kind: 'text'
  text: string
}

export interface ToolSeg {
  kind: 'tool'
  id: string | null
  name: string
  /** 一行摘要：Bash 的 command、Edit 的 file_path…（lib/segments.ts） */
  summary: string
  /** 展开看的完整入参（JSON pretty，已截断） */
  detail: string
  status: 'pending' | 'ok' | 'error'
  result: string | null
  /** 实时归属到这个工具（Task 等）的 subagent 消息数（M17） */
  subCount: number
  /** 新格式 subagent：meta.toolUseId 锚到本工具（M17） */
  agent: { id: string; label: string } | null
}

export type Segment = TextSeg | ToolSeg

export interface ChatMsg {
  key: string
  role: 'user' | 'assistant' | 'error'
  segments: Segment[]
  meta: string | null
  /** 这条消息是 subagent 的锚点：uuid 用来拉 /sidechains/:uuid（M17） */
  sidechain: { uuid: string; count: number } | null
}

export interface Approval {
  requestId: string
  tool_name: string | null
  input: unknown
}

export interface ModelOption {
  value: string
  label: string
}
