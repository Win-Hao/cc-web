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

export interface TextSeg {
  kind: 'text'
  text: string
}

export interface ThinkingSeg {
  kind: 'thinking'
  text: string
  /** 本轮实时流计到的思考秒数（M46）；历史消息没有 → 不显示时长 */
  seconds?: number
}

export interface ImageRef {
  mediaType: string
  data: string
}

export interface ImageSeg {
  kind: 'image'
  image: ImageRef
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
  /** 原始入参（M48 工具卡片按 family 取字段：file_path/pattern/url…） */
  input: unknown
  result: string | null
  /** 工具返回的图片（截图类工具，M42） */
  images: ImageRef[]
  /** 实时归属到这个工具（Task 等）的 subagent 消息数（M17） */
  subCount: number
  /** 新格式 subagent：meta.toolUseId 锚到本工具（M17） */
  agent: { id: string; label: string } | null
}

export type Segment = TextSeg | ThinkingSeg | ImageSeg | ToolSeg

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
