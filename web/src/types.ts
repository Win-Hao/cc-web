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
}

export type SessionState = 'idle' | 'running' | 'waiting-approval'

export interface HubEvent {
  seq: number
  event: string
  data: unknown
}

export interface ChatMsg {
  key: string
  role: 'user' | 'assistant' | 'error'
  text: string
  meta: string | null
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
