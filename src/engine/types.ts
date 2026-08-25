/**
 * D8：引擎对外的一套形状。协议本身（信封、request_id、initialize 握手、
 * 审批往返、fork 的新 id）关在 src/engine 里，服务器只见到这里的类型。
 *
 * 类型从 SDK 的 .d.ts 派生（PROTOCOL §0）：手写的一定会漏，派生的在
 * `pnpm typecheck` 时先红 —— 升级 CC 之后最早的预警。
 */
import type { EventEmitter } from 'node:events'
import type {
  PermissionMode,
  PermissionResult,
  SDKControlRequest,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

/**
 * 引擎 stdout 上除控制帧以外的一切（system / stream_event / assistant /
 * user / result / rate_limit_event …）。运行时形状仍由归一化层防御性解析
 * （R3：二进制可能比类型新），这里的类型是「我们按 SDK 的说法对待它」。
 */
export type TurnEvent = SDKMessage
/** 回合结束帧（result） */
export type TurnResult = SDKResultMessage

export type ControlRequest = SDKControlRequest['request']
export type ControlSubtype = ControlRequest['subtype']
/** 某个 subtype 的请求体（去掉 subtype 字段） */
export type ControlPayload<S extends ControlSubtype> = Omit<Extract<ControlRequest, { subtype: S }>, 'subtype'>
/** 请求体没有必填字段的 subtype（list_models / get_usage …）可以不传 payload */
export type ControlArgs<S extends ControlSubtype> = {} extends ControlPayload<S>
  ? [payload?: ControlPayload<S>]
  : [payload: ControlPayload<S>]

export type { PermissionMode }

/** 引擎反向发起的工具审批（协议名 can_use_tool）。字段与 WS 的 approval 事件同名 */
export interface ApprovalRequest {
  requestId: string
  tool_name: string | null
  input: unknown
}

/**
 * 审批的答复：SDK 的 PermissionResult。allow 可带 updatedInput
 * （AskUserQuestion 等交互工具把用户的选择塞回入参），deny 必带 message。
 */
export type ApprovalDecision = PermissionResult

/** prompt 附带的图片（M43）：base64 + 媒体类型，校验在 app 层 */
export interface PromptImage {
  media_type: string
  data: string
}

export interface EngineEvents {
  /** stdout 的一帧（控制帧除外），已按 SDK 类型分型 */
  'turn-event': [event: TurnEvent]
  /** result 帧：回合结束（紧跟在同一帧的 turn-event 之后） */
  'turn-end': [result: TurnResult]
  /** CC 要审批。同一 requestId 只发一次（pending_permission_requests + 实时帧已去重） */
  approval: [request: ApprovalRequest]
  /** CC 撤回还在飞的审批：停止等待，之后不再答复 */
  'approval-cancel': [requestId: string]
  /** spawn 失败 / 意外退出 / 坏帧。引擎内置兜底 listener，没人听也不崩 */
  error: [err: Error]
  /** 进程 close（code, signal），正常死亡和被杀都会发 */
  exit: [code: number | null, signal: NodeJS.Signals | null]
}

/** 引擎的契约。生产是 Engine（真 claude 进程），测试是 test/fixtures/fake-engine.ts */
export interface EngineLike extends EventEmitter<EngineEvents> {
  start(): Promise<void>
  stop(): Promise<void>
  /** 发一句提示词（图在前文在后）。引擎没在跑时抛错 */
  prompt(text: string, images?: PromptImage[]): void
  /** 中断当前回合，不等应答 */
  interrupt(): void
  /**
   * 发控制请求并等应答。第一个非 initialize 的请求会先自动握手；
   * 对端 error / 超时 / 引擎死 → reject ControlRequestError，绝不永久挂起。
   */
  control<S extends ControlSubtype>(subtype: S, ...args: ControlArgs<S>): Promise<unknown>
  /** 答复一个审批 */
  answerApproval(requestId: string, decision: ApprovalDecision): void
  /** CC 分配的 session id（--fork-session 时是新 id），从首个带 session_id 的帧读回 */
  awaitSessionId(timeoutMs?: number): Promise<string>
}

export interface EngineFactoryOptions {
  /** 只在「新建会话」时出现：新会话的工作目录，工厂据此走 --session-id 分支 */
  newSessionCwd?: string
  /** 分叉（M55）：--resume <此 id> --fork-session，新 id 由 CC 发、从首帧读回 */
  forkFrom?: string
}

export type EngineFactory = (
  sessionId: string,
  opts?: EngineFactoryOptions,
) => EngineLike | Promise<EngineLike>

/** 控制请求失败：对端回了 error 帧 / 超时 / 引擎中途死了 */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControlRequestError'
  }
}
